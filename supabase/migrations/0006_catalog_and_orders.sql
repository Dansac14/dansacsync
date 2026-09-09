-- =============================================================================
-- 0006 · Numeracion, catalogo y ordenes
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Numeracion correlativa por tenant
-- -----------------------------------------------------------------------------
-- Un comprobante fiscal no admite huecos ni repeticiones en su correlativo. Con
-- un `select max(numero)+1` dos ventas simultaneas obtienen el mismo numero. Con
-- una secuencia de Postgres no se puede reiniciar por serie ni por empresa.
-- La solucion correcta es una fila por (tenant, ambito, serie) y un UPDATE
-- atomico que devuelve el valor: el segundo proceso espera al primero.
-- -----------------------------------------------------------------------------

create table public.numbering_sequences (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  scope      varchar(30) not null,          -- 'order' | 'boleta' | 'factura' | 'nota_credito' ...
  series     varchar(10) not null,          -- 'F001', 'B001', o '-' cuando no aplica
  next_value bigint not null default 1 check (next_value >= 1),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, scope, series)
);

create or replace function public.next_correlative(
  p_tenant_id uuid,
  p_scope     varchar,
  p_series    varchar default '-'
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_value bigint;
begin
  -- El INSERT ... ON CONFLICT DO UPDATE bloquea la fila y devuelve el valor
  -- asignado en un solo viaje. Dos transacciones concurrentes se serializan aqui:
  -- la segunda espera a que la primera confirme y recibe el numero siguiente.
  -- next_value guarda "el proximo a asignar", por eso se devuelve menos uno.
  insert into public.numbering_sequences as ns (tenant_id, scope, series, next_value)
  values (p_tenant_id, p_scope, p_series, 2)
  on conflict (tenant_id, scope, series) do update
    set next_value = ns.next_value + 1,
        updated_at = now()
  returning ns.next_value - 1
  into v_value;

  return v_value;
end;
$$;

comment on function public.next_correlative(uuid, varchar, varchar) is
  'Devuelve el siguiente correlativo para (tenant, ambito, serie) de forma atomica. Nunca repite ni salta numeros.';

-- -----------------------------------------------------------------------------
-- Catalogo
-- -----------------------------------------------------------------------------

create table public.catalog_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        varchar(100) not null,
  description text,
  position    integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

create table public.products (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  category_id              uuid references public.catalog_categories(id) on delete set null,
  sku                      varchar(64),
  name                     varchar(150) not null,
  description              text,
  price                    numeric(12,2) not null check (price >= 0),
  currency                 char(3) not null default 'PEN',
  tax_rate                 numeric(5,4) not null default 0.1800 check (tax_rate >= 0 and tax_rate < 1),
  price_includes_tax       boolean not null default true,
  images                   text[] not null default '{}',
  track_stock              boolean not null default false,
  stock_quantity           integer not null default 0,
  is_active                boolean not null default true,
  meta_catalog_retailer_id varchar(100),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Si se controla stock, no puede quedar negativo.
  constraint products_stock_non_negative check (not track_stock or stock_quantity >= 0)
);

create unique index products_tenant_sku_idx on public.products (tenant_id, sku) where sku is not null;
create index products_tenant_active_idx on public.products (tenant_id, is_active, name);

create trigger products_touch
  before update on public.products
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Ordenes
-- -----------------------------------------------------------------------------
-- Los items van en su propia tabla y no en un JSONB: el precio de un producto
-- cambia, y una orden emitida tiene que conservar para siempre lo que se cobro.
-- -----------------------------------------------------------------------------

create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  contact_id         uuid not null references public.contacts(id) on delete restrict,
  conversation_id    uuid references public.conversations(id) on delete set null,
  order_number       bigint not null,
  channel            public.channel_type,
  status             public.order_status not null default 'draft',
  currency           char(3) not null default 'PEN',
  subtotal           numeric(12,2) not null default 0,
  tax_amount         numeric(12,2) not null default 0,
  discount_amount    numeric(12,2) not null default 0 check (discount_amount >= 0),
  total              numeric(12,2) not null default 0,
  payment_link       text,
  payment_provider   varchar(40),
  payment_reference  varchar(120),
  paid_at            timestamptz,
  notes              text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, order_number),
  constraint orders_paid_has_timestamp check (status <> 'paid' or paid_at is not null)
);

create index orders_tenant_status_idx on public.orders (tenant_id, status, created_at desc);
create index orders_contact_idx       on public.orders (contact_id, created_at desc);

create trigger orders_touch
  before update on public.orders
  for each row execute function app.touch_updated_at();

create table public.order_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  order_id     uuid not null references public.orders(id) on delete cascade,
  product_id   uuid references public.products(id) on delete set null,
  -- Copia congelada del producto en el momento de la venta.
  sku          varchar(64),
  name         varchar(150) not null,
  unit_price   numeric(12,2) not null check (unit_price >= 0),
  quantity     numeric(12,3) not null check (quantity > 0),
  tax_rate     numeric(5,4)  not null default 0.1800,
  line_total   numeric(12,2) generated always as (round(unit_price * quantity, 2)) stored,
  created_at   timestamptz not null default now()
);

create index order_items_order_idx on public.order_items (order_id);

-- -----------------------------------------------------------------------------
-- Totales calculados en la base
-- -----------------------------------------------------------------------------
-- Los importes de una orden se derivan de sus lineas. Calcularlos en el cliente
-- garantiza que tarde o temprano una orden muestre un total que no corresponde a
-- lo que contiene.
-- -----------------------------------------------------------------------------

-- El IGV va incluido en el precio de lista (practica habitual en Peru), asi que
-- el impuesto se extrae del importe bruto: tax = bruto - bruto/(1+tasa).
create or replace function app.recalculate_order_totals_for(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gross numeric(12,2);
  v_tax   numeric(12,2);
  v_disc  numeric(12,2);
begin
  if p_order_id is null then
    return;
  end if;

  select
    coalesce(sum(oi.line_total), 0),
    coalesce(sum(round(oi.line_total - (oi.line_total / (1 + oi.tax_rate)), 2)), 0)
  into v_gross, v_tax
  from public.order_items oi
  where oi.order_id = p_order_id;

  select o.discount_amount into v_disc from public.orders o where o.id = p_order_id;

  update public.orders o
  set subtotal   = v_gross - v_tax,
      tax_amount = v_tax,
      total      = greatest(v_gross - coalesce(v_disc, 0), 0)
  where o.id = p_order_id;
end;
$$;

create or replace function app.recalculate_order_totals()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- En un trigger de DELETE la variable NEW no existe: referenciarla aborta.
  if tg_op = 'DELETE' then
    perform app.recalculate_order_totals_for(old.order_id);
  else
    perform app.recalculate_order_totals_for(new.order_id);
    -- Si una linea se movio de orden, la orden anterior tambien debe recalcularse.
    if tg_op = 'UPDATE' and old.order_id is distinct from new.order_id then
      perform app.recalculate_order_totals_for(old.order_id);
    end if;
  end if;

  return null;
end;
$$;

create trigger order_items_recalculate
  after insert or update or delete on public.order_items
  for each row execute function app.recalculate_order_totals();
