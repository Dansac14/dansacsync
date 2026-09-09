-- =============================================================================
-- 0007 · Comprobantes de venta, compras y gastos
-- =============================================================================
-- Modelado para el regimen peruano: boleta y factura con serie y correlativo
-- independientes, IGV desglosado, RUC o DNI del receptor, y estado frente a la
-- administracion tributaria. La emision electronica real la hace un OSE o PSE
-- externo; aqui se guarda el documento, su numeracion y la respuesta recibida.
-- =============================================================================

create table public.sales_invoices (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  order_id           uuid references public.orders(id) on delete set null,
  contact_id         uuid references public.contacts(id) on delete set null,

  kind               public.invoice_kind not null,
  series             varchar(10) not null,
  correlative        bigint      not null,
  -- Numero completo tal como se muestra e imprime: F001-00000123
  full_number        text generated always as (series || '-' || lpad(correlative::text, 8, '0')) stored,

  -- Receptor
  receiver_tax_id    varchar(20) not null,
  receiver_name      varchar(200) not null,
  receiver_address   text,

  currency           char(3) not null default 'PEN',
  subtotal           numeric(12,2) not null check (subtotal >= 0),
  tax_amount         numeric(12,2) not null check (tax_amount >= 0),
  total              numeric(12,2) not null check (total >= 0),
  exchange_rate      numeric(10,6),

  state              public.invoice_state not null default 'draft',
  is_manual_entry    boolean not null default false,
  -- Respuesta del OSE/PSE: CDR, hash, codigo de error
  provider_name      varchar(60),
  provider_ticket    varchar(120),
  provider_response  jsonb,
  xml_url            text,
  pdf_url            text,
  cdr_url            text,

  -- Solo para notas de credito y debito
  references_invoice_id uuid references public.sales_invoices(id) on delete set null,
  reference_reason      varchar(200),

  issued_at          timestamptz not null default now(),
  voided_at          timestamptz,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- No pueden existir dos comprobantes con el mismo numero en la misma empresa.
  unique (tenant_id, kind, series, correlative),

  -- Una factura exige RUC de 11 digitos; la boleta admite DNI u otro documento.
  constraint invoices_factura_requires_ruc check (
    kind <> 'factura' or receiver_tax_id ~ '^[0-9]{11}$'
  ),
  -- Una nota siempre modifica a un comprobante previo.
  constraint invoices_note_requires_reference check (
    kind not in ('nota_credito','nota_debito') or references_invoice_id is not null
  ),
  constraint invoices_total_matches check (
    round(subtotal + tax_amount, 2) = round(total, 2)
  )
);

create index sales_invoices_tenant_idx   on public.sales_invoices (tenant_id, issued_at desc);
create index sales_invoices_contact_idx  on public.sales_invoices (contact_id, issued_at desc);
create index sales_invoices_state_idx    on public.sales_invoices (tenant_id, state) where state <> 'accepted';

create trigger sales_invoices_touch
  before update on public.sales_invoices
  for each row execute function app.touch_updated_at();

create table public.sales_invoice_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  invoice_id  uuid not null references public.sales_invoices(id) on delete cascade,
  product_id  uuid references public.products(id) on delete set null,
  description varchar(250) not null,
  unit_code   varchar(10) not null default 'NIU',   -- NIU unidad, ZZ servicio
  quantity    numeric(12,3) not null check (quantity > 0),
  unit_price  numeric(12,2) not null check (unit_price >= 0),
  tax_rate    numeric(5,4)  not null default 0.1800,
  line_total  numeric(12,2) generated always as (round(unit_price * quantity, 2)) stored,
  created_at  timestamptz not null default now()
);

create index sales_invoice_items_invoice_idx on public.sales_invoice_items (invoice_id);

-- -----------------------------------------------------------------------------
-- Emision: reserva el correlativo y crea la cabecera en una sola transaccion
-- -----------------------------------------------------------------------------

create or replace function public.issue_invoice(
  p_tenant_id       uuid,
  p_kind            public.invoice_kind,
  p_series          varchar,
  p_receiver_tax_id varchar,
  p_receiver_name   varchar,
  p_subtotal        numeric,
  p_tax_amount      numeric,
  p_currency        char default 'PEN',
  p_order_id        uuid default null,
  p_contact_id      uuid default null
)
returns public.sales_invoices
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_correlative bigint;
  v_row public.sales_invoices;
begin
  v_correlative := public.next_correlative(p_tenant_id, p_kind::text, p_series);

  insert into public.sales_invoices (
    tenant_id, order_id, contact_id, kind, series, correlative,
    receiver_tax_id, receiver_name, currency, subtotal, tax_amount, total,
    state, created_by
  )
  values (
    p_tenant_id, p_order_id, p_contact_id, p_kind, p_series, v_correlative,
    p_receiver_tax_id, p_receiver_name, p_currency,
    round(p_subtotal, 2), round(p_tax_amount, 2), round(p_subtotal + p_tax_amount, 2),
    'issued', auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.issue_invoice(uuid, public.invoice_kind, varchar, varchar, varchar, numeric, numeric, char, uuid, uuid)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Compras y gastos operativos
-- -----------------------------------------------------------------------------

create table public.purchases_and_expenses (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  supplier_name     varchar(200) not null,
  supplier_tax_id   varchar(20),
  document_kind     varchar(30) not null default 'factura',
  document_number   varchar(60),
  category          varchar(100) not null,
  description       text,
  currency          char(3) not null default 'PEN',
  subtotal          numeric(12,2) not null check (subtotal >= 0),
  tax_amount        numeric(12,2) not null default 0 check (tax_amount >= 0),
  total             numeric(12,2) not null check (total >= 0),
  is_deductible     boolean not null default true,
  receipt_file_url  text,
  expense_date      date not null default current_date,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint expenses_total_matches check (round(subtotal + tax_amount, 2) = round(total, 2))
);

create index expenses_tenant_date_idx     on public.purchases_and_expenses (tenant_id, expense_date desc);
create index expenses_tenant_category_idx on public.purchases_and_expenses (tenant_id, category);

create trigger expenses_touch
  before update on public.purchases_and_expenses
  for each row execute function app.touch_updated_at();
