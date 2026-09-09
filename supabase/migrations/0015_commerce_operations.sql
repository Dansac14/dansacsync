-- =============================================================================
-- 0015 · Operaciones de comercio: catalogo, pago, comprobante y resumen
-- =============================================================================
-- Todo lo que aqui se calcula sale de la base. Ningun importe se recibe desde el
-- navegador: el cliente indica QUE se cobra, nunca CUANTO. Si la interfaz
-- pudiera mandar el total, un error de redondeo o una peticion manipulada
-- acabarian en un comprobante fiscal con cifras que no cuadran.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enlace publico de la orden
-- -----------------------------------------------------------------------------
-- El cliente recibe un enlace por WhatsApp para ver y pagar su orden. Ese enlace
-- no puede llevar el id interno: los UUID aparecen en registros, capturas y
-- reenvios, y un id filtrado es una orden filtrada para siempre.
-- Con un token propio se puede revocar sin tocar la orden.
-- -----------------------------------------------------------------------------

alter table public.orders
  add column if not exists public_token text
    not null default encode(extensions.gen_random_bytes(16), 'hex');

create unique index if not exists orders_public_token_idx on public.orders (public_token);

alter table public.company_settings
  add column if not exists public_store_url text,
  add column if not exists payment_instructions text;

comment on column public.company_settings.payment_instructions is
  'Instrucciones de pago que ve el cliente: cuentas bancarias, Yape, Plin. Texto libre por empresa.';

-- -----------------------------------------------------------------------------
-- Envio de una ficha de producto por el canal
-- -----------------------------------------------------------------------------
-- La ficha se arma con los datos vigentes del producto en el momento del envio.
-- La alternativa —que la interfaz mande el texto ya compuesto— permitiria enviar
-- al cliente un precio que ya no existe porque la pantalla estaba abierta desde
-- ayer.
-- -----------------------------------------------------------------------------

create or replace function public.enqueue_product_message(
  p_conversation_id uuid,
  p_product_id      uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv     public.conversations;
  v_product  public.products;
  v_settings public.company_settings;
  v_caption  text;
  v_image    text;
  v_precio   text;
  v_enlace   text;
begin
  select * into v_conv from public.conversations where id = p_conversation_id;
  if not found then
    raise exception 'Conversacion inexistente' using errcode = 'no_data_found';
  end if;

  -- La comprobacion es explicita porque esta funcion es SECURITY DEFINER: sin
  -- ella, cualquier usuario autenticado podria enviar productos por una
  -- conversacion de otra empresa.
  if auth.uid() is not null and not app.is_member(v_conv.tenant_id) then
    raise exception 'Sin acceso a esta conversacion' using errcode = 'insufficient_privilege';
  end if;

  select * into v_product
  from public.products
  where id = p_product_id and tenant_id = v_conv.tenant_id and is_active;

  if not found then
    raise exception 'Producto inexistente, inactivo o de otra empresa'
      using errcode = 'no_data_found';
  end if;

  select * into v_settings from public.company_settings where tenant_id = v_conv.tenant_id;

  v_precio := trim(to_char(v_product.price, 'FM999G999G999D00'));
  v_image  := case when array_length(v_product.images, 1) > 0 then v_product.images[1] end;

  -- El enlace solo se incluye si la empresa tiene tienda publica configurada.
  -- Antes de eso, un enlace compuesto a medias seria un enlace roto enviado a
  -- un cliente real.
  if v_settings.public_store_url is not null and v_settings.public_store_url <> '' then
    v_enlace := rtrim(v_settings.public_store_url, '/') || '/p/' || v_product.id::text;
  end if;

  v_caption := format('*%s*', v_product.name)
    || case when coalesce(v_product.description, '') <> ''
            then E'\n\n' || v_product.description else '' end
    || format(E'\n\n%s %s', v_product.currency, v_precio)
    || case when v_enlace is not null
            then E'\n\n' || v_enlace else '' end;

  return public.enqueue_outbound_message(
    p_conversation_id,
    v_caption,
    case when auth.uid() is null then 'bot' else 'operator' end::public.sender_role,
    auth.uid(),
    case when v_image is not null then 'image' else 'text' end::public.media_type,
    v_image,
    jsonb_build_object('origen', 'catalogo', 'product_id', v_product.id)
  );
end;
$$;

grant execute on function public.enqueue_product_message(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Pago de una orden
-- -----------------------------------------------------------------------------
-- Marcar pagado y descontar stock tienen que ocurrir juntos. Si se hicieran por
-- separado desde la interfaz, dos ventas simultaneas del ultimo articulo se
-- cobrarian las dos y el stock quedaria en negativo.
-- -----------------------------------------------------------------------------

create or replace function public.mark_order_paid(
  p_order_id  uuid,
  p_provider  varchar default null,
  p_reference varchar default null
)
returns public.orders
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_item  record;
begin
  -- FOR UPDATE serializa dos intentos de pago de la misma orden.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Orden inexistente' using errcode = 'no_data_found';
  end if;

  if auth.uid() is not null and not app.is_member(v_order.tenant_id) then
    raise exception 'Sin acceso a esta orden' using errcode = 'insufficient_privilege';
  end if;

  if v_order.status = 'paid' then
    -- Idempotente: un reintento del proveedor de pago no debe descontar el
    -- stock dos veces.
    return v_order;
  end if;

  if v_order.status in ('cancelled', 'refunded') then
    raise exception 'La orden esta % y no se puede cobrar', v_order.status;
  end if;

  if not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'No se puede cobrar una orden sin lineas';
  end if;

  -- Stock, solo de los productos que lo controlan.
  for v_item in
    select oi.product_id, sum(oi.quantity) as cantidad
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id and p.track_stock
    group by oi.product_id
  loop
    update public.products
    set stock_quantity = stock_quantity - ceil(v_item.cantidad)::int
    where id = v_item.product_id;

    -- La restriccion de la tabla ya impide el negativo, pero el mensaje que
    -- lanza no dice de que producto se trata.
    if (select stock_quantity from public.products where id = v_item.product_id) < 0 then
      raise exception 'Stock insuficiente de "%": quedan % y se piden %',
        (select name from public.products where id = v_item.product_id),
        (select stock_quantity + ceil(v_item.cantidad)::int from public.products where id = v_item.product_id),
        ceil(v_item.cantidad)::int;
    end if;
  end loop;

  update public.orders
  set status            = 'paid',
      paid_at           = now(),
      payment_provider  = coalesce(p_provider, payment_provider),
      payment_reference = coalesce(p_reference, payment_reference)
  where id = p_order_id
  returning * into v_order;

  insert into public.audit_log (tenant_id, actor_id, action, entity_type, entity_id, after_state)
  values (v_order.tenant_id, auth.uid(), 'order.paid', 'order', v_order.id::text,
          jsonb_build_object('total', v_order.total, 'provider', v_order.payment_provider));

  return v_order;
end;
$$;

grant execute on function public.mark_order_paid(uuid, varchar, varchar) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Comprobante a partir de una orden
-- -----------------------------------------------------------------------------
-- Los importes se copian de las lineas de la orden. La interfaz no los envia:
-- solo dice a nombre de quien se emite y con que serie.
-- -----------------------------------------------------------------------------

create or replace function public.issue_invoice_for_order(
  p_order_id         uuid,
  p_kind             public.invoice_kind,
  p_series           varchar,
  p_receiver_tax_id  varchar,
  p_receiver_name    varchar,
  p_receiver_address text default null
)
returns public.sales_invoices
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_order       public.orders;
  v_invoice     public.sales_invoices;
  v_correlative bigint;
  v_base        numeric(12,2);
  v_tax         numeric(12,2);
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Orden inexistente' using errcode = 'no_data_found';
  end if;

  if auth.uid() is not null and not app.is_member(v_order.tenant_id) then
    raise exception 'Sin acceso a esta orden' using errcode = 'insufficient_privilege';
  end if;

  if v_order.status in ('draft', 'cancelled') then
    raise exception 'No se emite comprobante de una orden en estado %', v_order.status;
  end if;

  if exists (
    select 1 from public.sales_invoices
    where order_id = p_order_id and state <> 'voided' and kind in ('boleta','factura')
  ) then
    raise exception 'Esta orden ya tiene un comprobante emitido';
  end if;

  select coalesce(sum(round(oi.line_total / (1 + oi.tax_rate), 2)), 0),
         coalesce(sum(oi.line_total - round(oi.line_total / (1 + oi.tax_rate), 2)), 0)
  into v_base, v_tax
  from public.order_items oi
  where oi.order_id = p_order_id;

  if v_base + v_tax <= 0 then
    raise exception 'La orden no tiene importe que facturar';
  end if;

  v_correlative := public.next_correlative(v_order.tenant_id, p_kind::text, p_series);

  insert into public.sales_invoices (
    tenant_id, order_id, contact_id, kind, series, correlative,
    receiver_tax_id, receiver_name, receiver_address,
    currency, subtotal, tax_amount, total, state, created_by
  )
  values (
    v_order.tenant_id, v_order.id, v_order.contact_id, p_kind, p_series, v_correlative,
    p_receiver_tax_id, p_receiver_name, p_receiver_address,
    v_order.currency, v_base, v_tax, v_base + v_tax, 'issued', auth.uid()
  )
  returning * into v_invoice;

  -- Las lineas del comprobante son copia de las de la orden: el comprobante
  -- tiene que seguir siendo legible aunque el producto cambie o se elimine.
  insert into public.sales_invoice_items (
    tenant_id, invoice_id, product_id, description, unit_code,
    quantity, unit_price, tax_rate
  )
  select v_order.tenant_id, v_invoice.id, oi.product_id, oi.name,
         case when p.id is null or p.track_stock then 'NIU' else 'ZZ' end,
         oi.quantity, round(oi.unit_price / (1 + oi.tax_rate), 2), oi.tax_rate
  from public.order_items oi
  left join public.products p on p.id = oi.product_id
  where oi.order_id = p_order_id;

  insert into public.audit_log (tenant_id, actor_id, action, entity_type, entity_id, after_state)
  values (v_order.tenant_id, auth.uid(), 'invoice.issued', 'sales_invoice', v_invoice.id::text,
          jsonb_build_object('numero', v_invoice.full_number, 'total', v_invoice.total));

  return v_invoice;
end;
$$;

grant execute on function public.issue_invoice_for_order(uuid, public.invoice_kind, varchar, varchar, varchar, text)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Resumen financiero
-- -----------------------------------------------------------------------------
-- Se calcula en la base y no en el navegador: sumar decimales en JavaScript
-- produce diferencias de centimos, y un resumen que no cuadra con la suma de
-- los comprobantes no sirve para nada.
--
-- SECURITY INVOKER a proposito: la RLS filtra por empresa sola.
-- -----------------------------------------------------------------------------

create or replace function public.financial_summary(
  p_tenant_id uuid,
  p_from      date,
  p_to        date
)
returns table (
  ventas_base      numeric(14,2),
  ventas_igv       numeric(14,2),
  ventas_total     numeric(14,2),
  comprobantes     bigint,
  gastos_base      numeric(14,2),
  gastos_igv       numeric(14,2),
  gastos_total     numeric(14,2),
  documentos_gasto bigint,
  resultado        numeric(14,2),
  igv_por_pagar    numeric(14,2)
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with ventas as (
    select coalesce(sum(subtotal), 0)   as base,
           coalesce(sum(tax_amount), 0) as igv,
           coalesce(sum(total), 0)      as total,
           count(*)                     as cantidad
    from public.sales_invoices
    where tenant_id = p_tenant_id
      and state in ('issued', 'accepted')
      -- Las notas de credito restan, asi que se excluyen de la suma bruta y se
      -- tratan aparte para no inflar las ventas.
      and kind in ('boleta', 'factura', 'recibo_honorarios')
      and issued_at::date between p_from and p_to
  ),
  notas as (
    select coalesce(sum(subtotal), 0) as base,
           coalesce(sum(tax_amount), 0) as igv,
           coalesce(sum(total), 0) as total
    from public.sales_invoices
    where tenant_id = p_tenant_id
      and state in ('issued', 'accepted')
      and kind = 'nota_credito'
      and issued_at::date between p_from and p_to
  ),
  gastos as (
    select coalesce(sum(subtotal), 0)   as base,
           coalesce(sum(tax_amount), 0) as igv,
           coalesce(sum(total), 0)      as total,
           count(*)                     as cantidad
    from public.purchases_and_expenses
    where tenant_id = p_tenant_id
      and expense_date between p_from and p_to
  )
  select
    (v.base - n.base)::numeric(14,2),
    (v.igv - n.igv)::numeric(14,2),
    (v.total - n.total)::numeric(14,2),
    v.cantidad,
    g.base::numeric(14,2),
    g.igv::numeric(14,2),
    g.total::numeric(14,2),
    g.cantidad,
    ((v.base - n.base) - g.base)::numeric(14,2),
    -- IGV de ventas menos IGV de compras: lo que se declara.
    ((v.igv - n.igv) - g.igv)::numeric(14,2)
  from ventas v, notas n, gastos g;
$$;

grant execute on function public.financial_summary(uuid, date, date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Vista publica de una orden
-- -----------------------------------------------------------------------------
-- Es el unico punto del sistema al que llega alguien sin sesion. Por eso:
--   · se busca por token, no por id;
--   · devuelve solo lo que el comprador necesita ver;
--   · no expone el contacto, ni el RUC de la empresa, ni notas internas.
-- -----------------------------------------------------------------------------

create or replace function public.order_public_view(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders;
  v_config public.company_settings;
  v_items  jsonb;
begin
  if p_token is null or length(p_token) < 16 then
    return null;
  end if;

  select * into v_order from public.orders where public_token = p_token;
  if not found then
    return null;
  end if;

  select * into v_config from public.company_settings where tenant_id = v_order.tenant_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'nombre',   oi.name,
           'cantidad', oi.quantity,
           'precio',   oi.unit_price,
           'importe',  oi.line_total
         ) order by oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  where oi.order_id = v_order.id;

  return jsonb_build_object(
    'numero',       v_order.order_number,
    'estado',       v_order.status,
    'moneda',       v_order.currency,
    'subtotal',     v_order.subtotal,
    'igv',          v_order.tax_amount,
    'descuento',    v_order.discount_amount,
    'total',        v_order.total,
    'creada',       v_order.created_at,
    'pagada',       v_order.paid_at,
    'items',        v_items,
    'empresa', jsonb_build_object(
      'nombre',        coalesce(v_config.trade_name, v_config.company_name),
      'logo',          v_config.logo_url,
      'color',         v_config.primary_color,
      'telefono',      v_config.support_phone,
      'correo',        v_config.support_email,
      'instrucciones', v_config.payment_instructions
    )
  );
end;
$$;

revoke all on function public.order_public_view(text) from public;
-- anon a proposito: es la pagina que abre el cliente desde WhatsApp.
grant execute on function public.order_public_view(text) to anon, authenticated, service_role;

comment on function public.order_public_view(text) is
  'Vista de una orden para el comprador, buscada por token. Unico punto accesible sin sesion.';
