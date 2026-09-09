-- =============================================================================
-- 0016 · Endurecimiento
-- =============================================================================
-- Esta migracion corrige fallos encontrados en una revision de seguridad del
-- esquema. Cada bloque dice qué se podia hacer antes y por qué ya no.
--
-- Se aplica sobre las 15 anteriores en lugar de editarlas para que quede el
-- rastro: el dia que alguien se pregunte por qué existe una clave ajena
-- compuesta, la respuesta está aquí.
-- =============================================================================

-- =============================================================================
-- 1. EXECUTE por defecto para PUBLIC
-- =============================================================================
-- Postgres concede EXECUTE a PUBLIC en toda funcion nueva. Escribir
-- "grant execute ... to authenticated" no quita ese permiso: lo añade. Once
-- funciones quedaron ejecutables por `anon`, y `anon` es la clave que viaja en
-- el JavaScript del navegador, publica por diseño.
--
-- Consecuencia real, comprobada: sin sesion se podia emitir una factura en una
-- empresa ajena, marcar ordenes como pagadas y escribir por WhatsApp a los
-- clientes de otra empresa haciendose pasar por su bot.
-- =============================================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as firma
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
  loop
    execute format('revoke all on function %s from public', r.firma);
  end loop;
end $$;

-- Y ahora, explicitamente, solo lo que cada rol necesita.

-- Lectura y utilidades para la interfaz del operador.
grant execute on function
  public.search_knowledge(uuid, extensions.vector, integer, double precision),
  public.financial_summary(uuid, date, date),
  public.mark_conversation_read(uuid),
  public.set_handling_mode(uuid, public.handling_mode),
  public.send_operator_message(uuid, text, public.media_type, text),
  public.enqueue_product_message(uuid, uuid),
  public.mark_order_paid(uuid, varchar, varchar),
  public.issue_invoice_for_order(uuid, public.invoice_kind, varchar, varchar, varchar, text),
  public.issue_invoice(uuid, public.invoice_kind, varchar, varchar, varchar, numeric, numeric, char, uuid, uuid)
  to authenticated;

grant execute on function app.current_tenant_ids(), app.is_member(uuid),
                          app.has_role(uuid, public.tenant_role[]), app.is_admin(uuid)
  to authenticated;

-- La pagina publica de la orden. Es la unica funcion que `anon` puede ejecutar,
-- y su autorizacion es el token del enlace.
grant execute on function public.order_public_view(text) to anon;

-- El backend puede ejecutar todo: corre en un servidor con la clave de servicio.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as firma
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
  loop
    execute format('grant execute on function %s to service_role', r.firma);
  end loop;
end $$;

-- Que las funciones futuras no repitan el fallo.
alter default privileges in schema public  revoke execute on functions from public;
alter default privileges in schema app     revoke execute on functions from public;

-- =============================================================================
-- 2. La comprobacion de pertenencia que se desactivaba a si misma
-- =============================================================================
-- El patron era:
--     if auth.uid() is not null and not app.is_member(...) then raise ...
-- Con `anon` o con la clave de servicio, auth.uid() es NULL, la condicion es
-- falsa y no se comprobaba nada. La comprobacion tiene que ser al contrario:
-- se exige pertenencia SALVO que quien llama sea el backend.
-- =============================================================================

create or replace function app.assert_tenant_access(p_tenant uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- El worker y las Edge Functions actuan con service_role. Dentro de una
  -- funcion SECURITY DEFINER, current_user es el propietario, asi que el rol
  -- efectivo se lee del GUC que PostgREST fija con SET LOCAL ROLE.
  if coalesce(current_setting('role', true), '') = 'service_role' then
    return;
  end if;

  -- Sesion de persona: se exige usuario y pertenencia activa.
  if auth.uid() is null then
    raise exception 'Operacion no permitida sin sesion'
      using errcode = 'insufficient_privilege';
  end if;

  if not app.is_member(p_tenant) then
    raise exception 'Sin acceso a los datos de esta empresa'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke all on function app.assert_tenant_access(uuid) from public;
grant execute on function app.assert_tenant_access(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- next_correlative: no comprobaba nada y recibia el tenant como parametro.
-- Cualquiera podia quemar correlativos de comprobantes de cualquier empresa, y
-- en Peru una serie con huecos es una contingencia que hay que justificar
-- documento por documento.
-- -----------------------------------------------------------------------------

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
  perform app.assert_tenant_access(p_tenant_id);

  if p_scope not in ('order','boleta','factura','nota_credito','nota_debito','recibo_honorarios') then
    raise exception 'Ambito de numeracion no reconocido: %', p_scope;
  end if;

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

revoke all on function public.next_correlative(uuid, varchar, varchar) from public, anon;
grant execute on function public.next_correlative(uuid, varchar, varchar) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Las tres funciones de comercio, con la comprobacion correcta.
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

  perform app.assert_tenant_access(v_conv.tenant_id);

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

  if v_settings.public_store_url is not null and v_settings.public_store_url <> '' then
    v_enlace := rtrim(v_settings.public_store_url, '/') || '/p/' || v_product.id::text;
  end if;

  v_caption := format('*%s*', v_product.name)
    || case when coalesce(v_product.description, '') <> ''
            then E'\n\n' || v_product.description else '' end
    || format(E'\n\n%s %s', v_product.currency, v_precio)
    || case when v_enlace is not null then E'\n\n' || v_enlace else '' end;

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

revoke all on function public.enqueue_product_message(uuid, uuid) from public, anon;
grant execute on function public.enqueue_product_message(uuid, uuid) to authenticated, service_role;

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
  v_resta int;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Orden inexistente' using errcode = 'no_data_found';
  end if;

  perform app.assert_tenant_access(v_order.tenant_id);

  if v_order.status = 'paid' then
    return v_order;
  end if;

  if v_order.status in ('cancelled', 'refunded') then
    raise exception 'La orden esta % y no se puede cobrar', v_order.status;
  end if;

  if not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'No se puede cobrar una orden sin lineas';
  end if;

  for v_item in
    select oi.product_id, p.name, p.stock_quantity, ceil(sum(oi.quantity))::int as pedidas
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id and p.track_stock
    group by oi.product_id, p.name, p.stock_quantity
  loop
    -- Se comprueba ANTES de restar, para poder decir el nombre del producto y
    -- las unidades que faltan. La restriccion de la tabla es la ultima red.
    if v_item.stock_quantity < v_item.pedidas then
      raise exception 'Stock insuficiente de "%": quedan % y se piden %',
        v_item.name, v_item.stock_quantity, v_item.pedidas;
    end if;

    update public.products
    set stock_quantity = stock_quantity - v_item.pedidas
    where id = v_item.product_id;
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

revoke all on function public.mark_order_paid(uuid, varchar, varchar) from public, anon;
grant execute on function public.mark_order_paid(uuid, varchar, varchar) to authenticated, service_role;

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

  perform app.assert_tenant_access(v_order.tenant_id);

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

revoke all on function public.issue_invoice_for_order(uuid, public.invoice_kind, varchar, varchar, varchar, text) from public, anon;
grant execute on function public.issue_invoice_for_order(uuid, public.invoice_kind, varchar, varchar, varchar, text)
  to authenticated, service_role;

-- issue_invoice era SECURITY INVOKER y dependia de una politica de INSERT en
-- sales_invoices. Esa politica se elimina en el bloque 5, asi que la funcion
-- pasa a DEFINER con su propia comprobacion.
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
security definer
set search_path = public, pg_temp
as $$
declare
  v_correlative bigint;
  v_row public.sales_invoices;
begin
  perform app.assert_tenant_access(p_tenant_id);

  if round(p_subtotal, 2) < 0 or round(p_tax_amount, 2) < 0 then
    raise exception 'Los importes de un comprobante no pueden ser negativos';
  end if;

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

revoke all on function public.issue_invoice(uuid, public.invoice_kind, varchar, varchar, varchar, numeric, numeric, char, uuid, uuid) from public, anon;
grant execute on function public.issue_invoice(uuid, public.invoice_kind, varchar, varchar, varchar, numeric, numeric, char, uuid, uuid)
  to authenticated, service_role;

-- app.recalculate_order_totals_for tambien estaba abierta a PUBLIC. Solo la
-- usa el trigger, asi que no la necesita nadie mas.
revoke all on function app.recalculate_order_totals_for(uuid) from public, anon, authenticated;

-- =============================================================================
-- 3. Escritura entre empresas por la fila hija
-- =============================================================================
-- Este era el fallo mas grave. La RLS comprueba `tenant_id`, pero `tenant_id`
-- lo escribe quien inserta. Como las claves ajenas apuntaban solo al id del
-- padre, se podia insertar una linea con MI tenant_id en una orden AJENA:
--
--   insert into order_items (tenant_id, order_id, ...)
--   values ('<mi empresa>', '<orden de otra empresa>', 'LINEA', 999999, 1);
--
-- La politica lo aceptaba (el tenant_id es mio) y el trigger de totales
-- reescribia el total de la orden ajena. Lo mismo servia para escribir en la
-- bandeja de entrada de otra empresa.
--
-- La solucion es estructural: la clave ajena incluye el tenant, contra un
-- unique (tenant_id, id) en el padre. Postgres deja de permitir que una fila
-- apunte a un padre de otra empresa, sin importar qué diga la politica.
-- =============================================================================

-- Unicidad que hace referenciable el par (tenant, id) en cada padre.
alter table public.contacts            add constraint contacts_tenant_id_key            unique (tenant_id, id);
alter table public.channel_accounts    add constraint channel_accounts_tenant_id_key    unique (tenant_id, id);
alter table public.channel_identities  add constraint channel_identities_tenant_id_key  unique (tenant_id, id);
alter table public.conversations       add constraint conversations_tenant_id_key       unique (tenant_id, id);
alter table public.messages            add constraint messages_tenant_id_key            unique (tenant_id, id);
alter table public.groups              add constraint groups_tenant_id_key              unique (tenant_id, id);
alter table public.catalog_categories  add constraint catalog_categories_tenant_id_key  unique (tenant_id, id);
alter table public.products            add constraint products_tenant_id_key            unique (tenant_id, id);
alter table public.orders              add constraint orders_tenant_id_key              unique (tenant_id, id);
alter table public.sales_invoices      add constraint sales_invoices_tenant_id_key      unique (tenant_id, id);
alter table public.knowledge_documents add constraint knowledge_documents_tenant_id_key unique (tenant_id, id);

-- Sustitucion de cada clave ajena hija por su version compuesta.
do $$
declare
  r record;
  hijas text[][] := array[
    -- tabla,                columna,               padre,                 accion
    array['channel_identities','contact_id',        'contacts',            'cascade'],
    array['channel_identities','channel_account_id','channel_accounts',    'cascade'],
    array['conversations',     'contact_id',        'contacts',            'cascade'],
    array['conversations',     'channel_identity_id','channel_identities', 'cascade'],
    array['conversations',     'channel_account_id','channel_accounts',    'cascade'],
    array['messages',          'conversation_id',   'conversations',       'cascade'],
    array['messages',          'contact_id',        'contacts',            'cascade'],
    array['messages',          'channel_account_id','channel_accounts',    'cascade'],
    array['contact_groups',    'contact_id',        'contacts',            'cascade'],
    array['contact_groups',    'group_id',          'groups',              'cascade'],
    array['products',          'category_id',       'catalog_categories',  'set null'],
    array['orders',            'contact_id',        'contacts',            'restrict'],
    array['orders',            'conversation_id',   'conversations',       'set null'],
    array['order_items',       'order_id',          'orders',              'cascade'],
    array['order_items',       'product_id',        'products',            'set null'],
    array['sales_invoices',    'order_id',          'orders',              'set null'],
    array['sales_invoices',    'contact_id',        'contacts',            'set null'],
    array['sales_invoice_items','invoice_id',       'sales_invoices',      'cascade'],
    array['sales_invoice_items','product_id',       'products',            'set null'],
    array['knowledge_chunks',  'document_id',       'knowledge_documents', 'cascade'],
    array['ai_runs',           'conversation_id',   'conversations',       'cascade'],
    array['outbound_jobs',     'message_id',        'messages',            'cascade'],
    array['outbound_jobs',     'conversation_id',   'conversations',       'cascade']
  ];
  i int;
begin
  for i in 1 .. array_length(hijas, 1) loop
    -- Se localiza la clave ajena existente por su columna, sin depender del
    -- nombre que Postgres le haya puesto.
    for r in
      select c.conname
      from pg_constraint c
      where c.contype = 'f'
        and c.conrelid = format('public.%I', hijas[i][1])::regclass
        and cardinality(c.conkey) = 1
        and (select attname from pg_attribute
             where attrelid = c.conrelid and attnum = c.conkey[1]) = hijas[i][2]
    loop
      execute format('alter table public.%I drop constraint %I', hijas[i][1], r.conname);
    end loop;

    execute format(
      'alter table public.%I add constraint %I foreign key (tenant_id, %I) '
      || 'references public.%I (tenant_id, id) on delete %s',
      hijas[i][1],
      hijas[i][1] || '_tenant_' || hijas[i][2] || '_fkey',
      hijas[i][2],
      hijas[i][3],
      hijas[i][4]
    );
  end loop;
end $$;

-- =============================================================================
-- 4. El rol `viewer` tenia escritura completa
-- =============================================================================
-- Todas las politicas de escritura usaban app.is_member(), que es cierto para
-- los cuatro roles. El rol de solo lectura que se ofrece en la interfaz no
-- existia en la base: un `viewer` podia escribir contactos, ordenes y mensajes.
-- =============================================================================

create or replace function app.can_write(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.has_role(p_tenant, array['owner','admin','operator']::public.tenant_role[]);
$$;

revoke all on function app.can_write(uuid) from public;
grant execute on function app.can_write(uuid) to authenticated, service_role;

-- Politicas de escritura del trabajo diario, ahora sin `viewer`.
drop policy if exists contacts_insert on public.contacts;
drop policy if exists contacts_update on public.contacts;
create policy contacts_insert on public.contacts
  for insert to authenticated with check (app.can_write(tenant_id));
create policy contacts_update on public.contacts
  for update to authenticated
  using (app.can_write(tenant_id)) with check (app.can_write(tenant_id));

drop policy if exists channel_identities_insert on public.channel_identities;
drop policy if exists channel_identities_update on public.channel_identities;
create policy channel_identities_insert on public.channel_identities
  for insert to authenticated with check (app.can_write(tenant_id));
create policy channel_identities_update on public.channel_identities
  for update to authenticated
  using (app.can_write(tenant_id)) with check (app.can_write(tenant_id));

drop policy if exists conversations_insert on public.conversations;
drop policy if exists conversations_update on public.conversations;
create policy conversations_insert on public.conversations
  for insert to authenticated with check (app.can_write(tenant_id));
create policy conversations_update on public.conversations
  for update to authenticated
  using (app.can_write(tenant_id)) with check (app.can_write(tenant_id));

drop policy if exists messages_insert_as_operator on public.messages;
create policy messages_insert_as_operator on public.messages
  for insert to authenticated
  with check (
    app.can_write(tenant_id)
    and direction      = 'outbound'
    and sender_type    = 'operator'
    and sender_user_id = auth.uid()
  );

drop policy if exists groups_insert on public.groups;
drop policy if exists groups_update on public.groups;
create policy groups_insert on public.groups
  for insert to authenticated with check (app.can_write(tenant_id) and not is_system);
-- El `with check` tambien excluye is_system: antes se podia marcar un grupo
-- propio como del sistema y quedaba inmutable e imborrable para todos,
-- incluido el propietario.
create policy groups_update on public.groups
  for update to authenticated
  using (app.can_write(tenant_id) and not is_system)
  with check (app.can_write(tenant_id) and not is_system);

drop policy if exists contact_groups_insert on public.contact_groups;
drop policy if exists contact_groups_delete on public.contact_groups;
create policy contact_groups_insert on public.contact_groups
  for insert to authenticated with check (app.can_write(tenant_id));
create policy contact_groups_delete on public.contact_groups
  for delete to authenticated using (app.can_write(tenant_id));

drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;
create policy orders_insert on public.orders
  for insert to authenticated with check (app.can_write(tenant_id));
create policy orders_update on public.orders
  for update to authenticated
  using (app.can_write(tenant_id)) with check (app.can_write(tenant_id));

drop policy if exists order_items_write on public.order_items;
create policy order_items_write on public.order_items
  for all to authenticated
  using (app.can_write(tenant_id)) with check (app.can_write(tenant_id));

drop policy if exists quick_replies_write on public.quick_replies;
create policy quick_replies_write on public.quick_replies
  for all to authenticated
  using (app.can_write(tenant_id)) with check (app.can_write(tenant_id));

-- =============================================================================
-- 5. Comprobantes fiscales: emision solo por funcion, e inmutables una vez emitidos
-- =============================================================================
-- Antes, cualquier miembro podia insertar un comprobante a mano con el
-- correlativo que quisiera. Insertando el numero que la secuencia iba a asignar
-- despues, la emision oficial choca con la clave unica, la transaccion aborta,
-- el correlativo revierte y CADA reintento vuelve a chocar con el mismo numero:
-- la facturacion de la empresa queda bloqueada y nadie puede borrar la fila
-- porque no hay politica de DELETE.
--
-- Ahora la unica via de emision son issue_invoice / issue_invoice_for_order,
-- que reservan el correlativo con next_correlative en la misma transaccion.
-- =============================================================================

drop policy if exists sales_invoices_insert on public.sales_invoices;
drop policy if exists sales_invoice_items_insert on public.sales_invoice_items;

-- Un comprobante emitido no se reescribe. Se puede registrar la respuesta del
-- OSE, adjuntar el XML o el PDF, y anularlo; nada mas.
create or replace function app.protect_issued_invoice()
returns trigger
language plpgsql
as $$
begin
  if old.state in ('issued', 'accepted') then
    if new.kind            is distinct from old.kind
    or new.series          is distinct from old.series
    or new.correlative     is distinct from old.correlative
    or new.subtotal        is distinct from old.subtotal
    or new.tax_amount      is distinct from old.tax_amount
    or new.total           is distinct from old.total
    or new.currency        is distinct from old.currency
    or new.receiver_tax_id is distinct from old.receiver_tax_id
    or new.receiver_name   is distinct from old.receiver_name
    or new.order_id        is distinct from old.order_id
    or new.tenant_id       is distinct from old.tenant_id
    then
      raise exception
        'El comprobante % ya fue emitido: sus importes, numeracion y receptor no se pueden modificar. Emite una nota de credito.',
        old.series || '-' || lpad(old.correlative::text, 8, '0')
        using errcode = 'restrict_violation';
    end if;

    -- Los estados solo avanzan hacia una resolucion.
    if new.state not in ('issued', 'accepted', 'rejected', 'voided') then
      raise exception 'Transicion de estado no permitida: % -> %', old.state, new.state;
    end if;
  end if;

  return new;
end;
$$;

create trigger sales_invoices_protect
  before update on public.sales_invoices
  for each row execute function app.protect_issued_invoice();

-- =============================================================================
-- 6. Ordenes: importes que no cuadraban y estados cambiados a mano
-- =============================================================================
-- orders_update permitia a cualquier miembro escribir cualquier columna. Con un
-- UPDATE directo se podia dejar total = 0 en una orden de 1750, o pasarla a
-- 'paid' sin descontar stock y sin dejar rastro en la bitacora. El enlace
-- publico muestra `total`, asi que cobrar un centimo era un UPDATE.
-- =============================================================================

-- La coherencia de los importes deja de ser una convencion.
alter table public.orders
  add constraint orders_totals_match
  check (round(total, 2) = round(subtotal + tax_amount - discount_amount, 2));

alter table public.orders
  add constraint orders_total_non_negative check (total >= 0);

-- Los importes y el estado solo los cambian los triggers y las funciones, que
-- corren como propietario y no pasan por estos permisos de columna.
revoke update on public.orders from authenticated;
grant update (notes, payment_link, payment_provider, payment_reference, conversation_id)
  on public.orders to authenticated;

-- =============================================================================
-- 7. Atribucion falsificable
-- =============================================================================
-- Ninguna politica forzaba created_by = auth.uid(), asi que un operador podia
-- cargar gastos y documentos a nombre del propietario. En una disputa interna,
-- la base no distinguia quien hizo qué.
-- =============================================================================

create or replace function app.force_author()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- El backend inserta sin sesion de persona: ahi se respeta lo que venga.
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger orders_force_author
  before insert on public.orders
  for each row execute function app.force_author();

create trigger expenses_force_author
  before insert on public.purchases_and_expenses
  for each row execute function app.force_author();

create trigger quick_replies_force_author
  before insert on public.quick_replies
  for each row execute function app.force_author();

create trigger knowledge_documents_force_author
  before insert on public.knowledge_documents
  for each row execute function app.force_author();

create or replace function app.force_entered_by()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null then
    new.entered_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger contact_groups_force_author
  before insert on public.contact_groups
  for each row execute function app.force_entered_by();

-- actor_label era texto libre: la etiqueta que muestra la pantalla de auditoria
-- se podia falsificar aunque actor_id fuera correcto.
create or replace function app.force_audit_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null then
    new.actor_id    := auth.uid();
    new.actor_label := null;   -- lo resuelve quien lee, desde tenant_members
  end if;
  return new;
end;
$$;

create trigger audit_log_force_actor
  before insert on public.audit_log
  for each row execute function app.force_audit_actor();

-- =============================================================================
-- 8. Claves ajenas sin indice
-- =============================================================================
-- Los triggers de integridad referencial son POR FILA. Sin indice, borrar un
-- contacto con 300.000 mensajes son cientos de miles de escaneos secuenciales
-- y mas de una hora con la tabla bloqueada: la bandeja caida para todas las
-- empresas, no solo para la que borro.
-- =============================================================================

create index if not exists messages_contact_idx            on public.messages (contact_id);
create index if not exists messages_channel_account_idx     on public.messages (channel_account_id);
create index if not exists messages_reply_to_idx            on public.messages (reply_to_id) where reply_to_id is not null;
create index if not exists messages_sender_user_idx         on public.messages (sender_user_id) where sender_user_id is not null;
create index if not exists ai_runs_inbound_message_idx      on public.ai_runs (inbound_message_id) where inbound_message_id is not null;
create index if not exists ai_runs_outbound_message_idx     on public.ai_runs (outbound_message_id) where outbound_message_id is not null;
create index if not exists outbound_jobs_conversation_idx   on public.outbound_jobs (conversation_id);
create index if not exists inbound_events_account_idx       on public.inbound_events (channel_account_id) where channel_account_id is not null;
create index if not exists orders_conversation_idx          on public.orders (conversation_id) where conversation_id is not null;
create index if not exists order_items_product_idx          on public.order_items (product_id) where product_id is not null;
create index if not exists order_items_tenant_idx           on public.order_items (tenant_id);
create index if not exists sales_invoices_order_idx         on public.sales_invoices (order_id) where order_id is not null;
create index if not exists sales_invoice_items_product_idx  on public.sales_invoice_items (product_id) where product_id is not null;
create index if not exists sales_invoices_reference_idx     on public.sales_invoices (references_invoice_id) where references_invoice_id is not null;
create index if not exists conversations_identity_idx       on public.conversations (channel_identity_id);
create index if not exists conversations_account_idx        on public.conversations (channel_account_id);
create index if not exists channel_identities_account_idx   on public.channel_identities (channel_account_id);
create index if not exists products_category_idx            on public.products (category_id) where category_id is not null;
create index if not exists knowledge_chunks_document_idx    on public.knowledge_chunks (document_id);
create index if not exists ai_runs_tenant_conversation_idx  on public.ai_runs (conversation_id);
create index if not exists contact_groups_tenant_idx        on public.contact_groups (tenant_id);
create index if not exists audit_log_actor_idx              on public.audit_log (actor_id) where actor_id is not null;

-- =============================================================================
-- 9. Trabajos abandonados en 'processing'
-- =============================================================================
-- Si el worker muere —OOM, SIGKILL, excepcion no capturada— los eventos que ya
-- habia tomado quedan en 'processing' y ninguna consulta los vuelve a recoger:
-- mensajes de clientes que nunca reciben respuesta y que nadie reintenta.
-- =============================================================================

create or replace function public.requeue_stale_jobs(p_older_than interval default '5 minutes')
returns table (entrada integer, salida integer)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_in  int;
  v_out int;
begin
  update public.inbound_events
  set status = 'failed', locked_at = null, locked_by = null,
      last_error = coalesce(last_error, 'Recuperado: el worker que lo tomo no lo termino'),
      available_at = now()
  where status = 'processing' and locked_at < now() - p_older_than;
  get diagnostics v_in = row_count;

  update public.outbound_jobs
  set status = 'failed', locked_at = null, locked_by = null,
      last_error = coalesce(last_error, 'Recuperado: el worker que lo tomo no lo termino'),
      available_at = now()
  where status = 'processing' and locked_at < now() - p_older_than;
  get diagnostics v_out = row_count;

  return query select v_in, v_out;
end;
$$;

revoke all on function public.requeue_stale_jobs(interval) from public, anon, authenticated;
grant execute on function public.requeue_stale_jobs(interval) to service_role;

comment on function public.requeue_stale_jobs(interval) is
  'Devuelve a la cola los trabajos que quedaron tomados por un worker que murio. Lo llama el propio worker de forma periodica.';

-- Las funciones de trigger creadas mas arriba nacieron con EXECUTE para PUBLIC,
-- igual que las demas. No son alcanzables (anon no tiene USAGE sobre el esquema
-- `app`), pero se cierran de todas formas.
revoke all on function app.protect_issued_invoice()   from public, anon, authenticated;
revoke all on function app.force_author()             from public, anon, authenticated;
revoke all on function app.force_entered_by()         from public, anon, authenticated;
revoke all on function app.force_audit_actor()        from public, anon, authenticated;
revoke all on function app.assert_tenant_access(uuid) from public, anon;
