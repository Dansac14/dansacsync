-- =============================================================================
-- Verificacion del nucleo: aislamiento, idempotencia, numeracion y totales
-- =============================================================================
-- Cada bloque falla ruidosamente si la garantia no se cumple. No hay datos de
-- adorno: todo lo que se inserta aqui existe para probar una invariante.
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- Preparacion: dos empresas distintas del SaaS, con un usuario cada una
-- -----------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ana@empresa-uno.pe'),
  ('22222222-2222-2222-2222-222222222222', 'luis@empresa-dos.pe');

-- A partir de aqui, el guion actua como el backend, no como el propietario de
-- la base. Es como corre de verdad: el worker y las Edge Functions usan
-- service_role. Los bloques que prueban la RLS cambian a `authenticated` o a
-- `anon` por su cuenta y vuelven aqui al terminar.
set role service_role;

select public.provision_tenant(
  'Empresa Uno', 'empresa-uno', '11111111-1111-1111-1111-111111111111',
  '20481234567', 'Av. Larco 1234, Trujillo'
) \gset t1_

select public.provision_tenant(
  'Empresa Dos', 'empresa-dos', '22222222-2222-2222-2222-222222222222',
  '20487654321', 'Av. Arequipa 500, Lima'
) \gset t2_

-- Cada empresa conecta su propio numero de WhatsApp.
insert into public.channel_accounts (tenant_id, channel, external_account_id, display_name, phone_number)
select id, 'whatsapp', '100000000000001', 'WhatsApp Empresa Uno', '+51987654321'
from public.tenants where slug = 'empresa-uno';

insert into public.channel_accounts (tenant_id, channel, external_account_id, display_name, phone_number)
select id, 'whatsapp', '100000000000002', 'WhatsApp Empresa Dos', '+51912345678'
from public.tenants where slug = 'empresa-dos';

-- -----------------------------------------------------------------------------
-- PRUEBA 1 · Aprovisionamiento completo
-- -----------------------------------------------------------------------------
do $$
declare v_t uuid;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';

  if (select count(*) from public.groups where tenant_id = v_t and is_system) <> 4 then
    raise exception 'FALLO 1a: la empresa no quedo con sus 4 grupos de sistema';
  end if;
  if not exists (select 1 from public.company_settings where tenant_id = v_t) then
    raise exception 'FALLO 1b: la empresa quedo sin configuracion';
  end if;
  if not exists (select 1 from public.tenant_members where tenant_id = v_t and role = 'owner') then
    raise exception 'FALLO 1c: la empresa quedo sin propietario';
  end if;
  raise notice 'OK 1 · Aprovisionamiento deja tenant, propietario, ajustes, grupos y series';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 2 · Idempotencia: el mismo webhook reintentado no duplica nada
-- -----------------------------------------------------------------------------
do $$
declare
  v_acc  uuid;
  v_r1   record;
  v_r2   record;
begin
  select id into v_acc from public.channel_accounts where external_account_id = '100000000000001';

  select * into v_r1 from public.ingest_inbound_message(
    v_acc, '51999111222', 'wamid.AAAA1', 'Hola, quiero informacion del taller',
    'text', null, null, 'Rosa Quispe'
  );

  -- Meta reintenta el mismo evento.
  select * into v_r2 from public.ingest_inbound_message(
    v_acc, '51999111222', 'wamid.AAAA1', 'Hola, quiero informacion del taller',
    'text', null, null, 'Rosa Quispe'
  );

  if v_r1.is_duplicate then
    raise exception 'FALLO 2a: el primer mensaje se marco como duplicado';
  end if;
  if not v_r2.is_duplicate then
    raise exception 'FALLO 2b: el reintento NO se detecto como duplicado';
  end if;
  if v_r1.message_id <> v_r2.message_id then
    raise exception 'FALLO 2c: el reintento creo un mensaje nuevo';
  end if;
  if (select count(*) from public.messages where channel_message_id = 'wamid.AAAA1') <> 1 then
    raise exception 'FALLO 2d: hay mas de un mensaje con el mismo id de canal';
  end if;
  if not v_r1.is_new_contact then
    raise exception 'FALLO 2e: no se registro el contacto nuevo';
  end if;
  raise notice 'OK 2 · Reintento de webhook: 1 contacto, 1 conversacion, 1 mensaje';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 3 · El mismo numero escribiendo a dos empresas son dos contactos
-- -----------------------------------------------------------------------------
do $$
declare
  v_acc2 uuid;
  v_r    record;
begin
  select id into v_acc2 from public.channel_accounts where external_account_id = '100000000000002';

  select * into v_r from public.ingest_inbound_message(
    v_acc2, '51999111222', 'wamid.BBBB1', 'Buenos dias, precios por favor',
    'text', null, null, 'Rosa Quispe'
  );

  if not v_r.is_new_contact then
    raise exception 'FALLO 3: el contacto se fusiono entre dos empresas distintas';
  end if;
  if (select count(distinct tenant_id) from public.contacts) <> 2 then
    raise exception 'FALLO 3b: los contactos no quedaron separados por empresa';
  end if;
  raise notice 'OK 3 · Un mismo numero en dos empresas produce dos contactos separados';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 4 · Estado de la conversacion mantenido por la base
-- -----------------------------------------------------------------------------
do $$
declare v_conv public.conversations;
begin
  select c.* into v_conv
  from public.conversations c
  join public.channel_identities ci on ci.id = c.channel_identity_id
  where ci.channel_user_id = '51999111222'
    and c.tenant_id = (select id from public.tenants where slug = 'empresa-uno');

  if v_conv.unread_count <> 1 then
    raise exception 'FALLO 4a: unread_count = %, se esperaba 1', v_conv.unread_count;
  end if;
  if v_conv.service_window_expires_at is null then
    raise exception 'FALLO 4b: no se abrio la ventana de servicio de 24 h';
  end if;
  if v_conv.last_message_preview is null then
    raise exception 'FALLO 4c: la bandeja no tiene vista previa del ultimo mensaje';
  end if;
  raise notice 'OK 4 · Ventana de 24 h, no leidos y vista previa se mantienen solos';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 5 · Aislamiento por RLS con un usuario real
-- -----------------------------------------------------------------------------
do $$
declare
  v_visible_tenants int;
  v_visible_contacts int;
  v_leak int;
begin
  -- Nos convertimos en Ana, de Empresa Uno.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;

  select count(*) into v_visible_tenants  from public.tenants;
  select count(*) into v_visible_contacts from public.contacts;
  select count(*) into v_leak from public.contacts
   where tenant_id = (select id from public.tenants where slug = 'empresa-dos');

  set role service_role;

  if v_visible_tenants <> 1 then
    raise exception 'FALLO 5a: Ana ve % empresas, deberia ver 1', v_visible_tenants;
  end if;
  if v_visible_contacts <> 1 then
    raise exception 'FALLO 5b: Ana ve % contactos, deberia ver solo el suyo', v_visible_contacts;
  end if;
  if v_leak <> 0 then
    raise exception 'FALLO 5c: fuga de datos entre empresas';
  end if;
  raise notice 'OK 5 · Un operador solo ve su empresa; la fuga la bloquea Postgres';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 6 · Un operador no puede suplantar al bot ni a otro usuario
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  v_blocked boolean := false;
begin
  select c.id into v_conv from public.conversations c
  where c.tenant_id = (select id from public.tenants where slug = 'empresa-uno') limit 1;

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;

  begin
    insert into public.messages (
      tenant_id, conversation_id, contact_id, channel_account_id, channel,
      direction, sender_type, content
    )
    select c.tenant_id, c.id, c.contact_id, c.channel_account_id, c.channel,
           'outbound', 'bot', 'Mensaje falsificado como si lo hubiera escrito el bot'
    from public.conversations c where c.id = v_conv;
  exception when insufficient_privilege or check_violation then
    v_blocked := true;
  end;

  set role service_role;

  if not v_blocked then
    raise exception 'FALLO 6: un operador pudo insertar un mensaje firmado por el bot';
  end if;
  raise notice 'OK 6 · Un operador no puede escribir mensajes a nombre del bot';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 7 · Correlativo fiscal sin huecos ni repeticiones
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_vals bigint[];
  i int;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';

  for i in 1..50 loop
    v_vals := array_append(v_vals, public.next_correlative(v_t, 'factura', 'F001'));
  end loop;

  if v_vals[1] <> 1 then
    raise exception 'FALLO 7a: la serie no empezo en 1 (empezo en %)', v_vals[1];
  end if;
  if v_vals[50] <> 50 then
    raise exception 'FALLO 7b: se perdieron numeros, el ultimo fue %', v_vals[50];
  end if;
  if (select count(distinct v) from unnest(v_vals) v) <> 50 then
    raise exception 'FALLO 7c: hay correlativos repetidos';
  end if;
  raise notice 'OK 7 · 50 correlativos consecutivos, sin huecos ni repetidos';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 8 · Totales de la orden calculados por la base
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_contact uuid;
  v_order uuid;
  v_o public.orders;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select id into v_contact from public.contacts where tenant_id = v_t limit 1;

  insert into public.products (tenant_id, name, price, currency, sku)
  values (v_t, 'Taller de Finanzas para Emprendedores', 118.00, 'PEN', 'TAL-FIN');

  insert into public.orders (tenant_id, contact_id, currency, channel)
  values (v_t, v_contact, 'PEN', 'whatsapp')
  returning id into v_order;

  insert into public.order_items (tenant_id, order_id, product_id, name, unit_price, quantity)
  select v_t, v_order, p.id, p.name, p.price, 2
  from public.products p where p.tenant_id = v_t and p.sku = 'TAL-FIN';

  select * into v_o from public.orders where id = v_order;

  -- 2 x 118.00 = 236.00 con IGV incluido -> base 200.00, IGV 36.00
  if v_o.total <> 236.00 then
    raise exception 'FALLO 8a: total = %, se esperaba 236.00', v_o.total;
  end if;
  if v_o.tax_amount <> 36.00 then
    raise exception 'FALLO 8b: IGV = %, se esperaba 36.00', v_o.tax_amount;
  end if;
  if v_o.subtotal <> 200.00 then
    raise exception 'FALLO 8c: base imponible = %, se esperaba 200.00', v_o.subtotal;
  end if;
  if v_o.order_number is null then
    raise exception 'FALLO 8d: la orden no recibio numero correlativo';
  end if;
  raise notice 'OK 8 · Orden 2 x 118.00 -> base 200.00 + IGV 36.00 = 236.00, numero %', v_o.order_number;
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 9 · Reglas del comprobante fiscal
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_contact uuid;
  v_inv public.sales_invoices;
  v_rejected boolean := false;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select id into v_contact from public.contacts where tenant_id = v_t limit 1;

  select * into v_inv from public.issue_invoice(
    v_t, 'factura', 'F001', '20481234567', 'Constructora Andina S.A.C.',
    200.00, 36.00, 'PEN', null, v_contact
  );

  if v_inv.full_number <> 'F001-00000051' then
    raise exception 'FALLO 9a: numero emitido % (se esperaba F001-00000051 tras los 50 de la prueba 7)', v_inv.full_number;
  end if;

  -- Una factura con un documento que no es RUC debe ser rechazada.
  begin
    perform public.issue_invoice(
      v_t, 'factura', 'F001', '12345678', 'Cliente sin RUC',
      100.00, 18.00, 'PEN', null, v_contact
    );
  exception when check_violation then
    v_rejected := true;
  end;

  if not v_rejected then
    raise exception 'FALLO 9b: se emitio una factura sin RUC valido';
  end if;
  raise notice 'OK 9 · Comprobante % emitido; factura sin RUC rechazada', v_inv.full_number;
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 10 · La busqueda vectorial no cruza empresas
-- -----------------------------------------------------------------------------
do $$
declare
  v_t1 uuid; v_t2 uuid;
  v_d1 uuid; v_d2 uuid;
  v_vec extensions.vector(1536);
  v_hits int;
  v_foreign int;
begin
  select id into v_t1 from public.tenants where slug = 'empresa-uno';
  select id into v_t2 from public.tenants where slug = 'empresa-dos';

  v_vec := ('[' || array_to_string(array_fill(0.02::float8, array[1536]), ',') || ']')::extensions.vector;

  insert into public.knowledge_documents (tenant_id, title, status)
  values (v_t1, 'Manual Operativo Empresa Uno', 'indexed') returning id into v_d1;
  insert into public.knowledge_documents (tenant_id, title, status)
  values (v_t2, 'Manual Operativo Empresa Dos', 'indexed') returning id into v_d2;

  insert into public.knowledge_chunks (tenant_id, document_id, section_name, chunk_index, content, embedding)
  values (v_t1, v_d1, 'Precios', 0, 'El taller de finanzas cuesta 118 soles.', v_vec),
         (v_t2, v_d2, 'Precios', 0, 'Nuestra consultoria cuesta 900 soles.',  v_vec);

  select count(*) into v_hits from public.search_knowledge(v_t1, v_vec, 10, 0.1);
  select count(*) into v_foreign
  from public.search_knowledge(v_t1, v_vec, 10, 0.1) s
  where s.content like '%consultoria%';

  if v_hits <> 1 then
    raise exception 'FALLO 10a: la busqueda devolvio % fragmentos, se esperaba 1', v_hits;
  end if;
  if v_foreign <> 0 then
    raise exception 'FALLO 10b: la busqueda devolvio conocimiento de otra empresa';
  end if;
  raise notice 'OK 10 · Con vectores identicos, cada empresa recupera solo su manual';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 11 · Toma de control humano, auditada
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  v_mode public.handling_mode;
  v_audits int;
begin
  select c.id into v_conv from public.conversations c
  where c.tenant_id = (select id from public.tenants where slug = 'empresa-uno') limit 1;

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  perform public.set_handling_mode(v_conv, 'human');
  set role service_role;

  select handling_mode into v_mode from public.conversations where id = v_conv;
  select count(*) into v_audits from public.audit_log
   where entity_id = v_conv::text and action = 'conversation.takeover';

  if v_mode <> 'human' then
    raise exception 'FALLO 11a: la conversacion no quedo en modo humano';
  end if;
  if v_audits <> 1 then
    raise exception 'FALLO 11b: la toma de control no quedo auditada';
  end if;
  raise notice 'OK 11 · Toma de control aplicada y registrada en la bitacora';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 12 · Envio del operador: mensaje encolado, no enviado a ciegas
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  v_msg  uuid;
  v_job  public.outbound_jobs;
  v_m    public.messages;
begin
  select c.id into v_conv from public.conversations c
  where c.tenant_id = (select id from public.tenants where slug = 'empresa-uno') limit 1;

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  v_msg := public.send_operator_message(v_conv, 'Hola Rosa, te atiendo yo desde ahora.');
  set role service_role;

  select * into v_m   from public.messages where id = v_msg;
  select * into v_job from public.outbound_jobs where message_id = v_msg;

  if v_m.sender_type <> 'operator' or v_m.sender_user_id <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'FALLO 12a: el mensaje no quedo atribuido al operador';
  end if;
  if v_m.delivery_status <> 'pending' then
    raise exception 'FALLO 12b: el mensaje se dio por enviado sin pasar por la cola';
  end if;
  if v_job.status <> 'queued' then
    raise exception 'FALLO 12c: no se encolo el envio';
  end if;
  raise notice 'OK 12 · El mensaje del operador queda encolado y atribuido a el';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 13 · La cola entrega cada trabajo a un solo worker
-- -----------------------------------------------------------------------------
do $$
declare
  v_a int; v_b int;
begin
  insert into public.inbound_events (dedupe_key, payload)
  select 'evt-' || g, '{"prueba":true}'::jsonb from generate_series(1, 20) g;

  select count(*) into v_a from public.claim_inbound_events('worker-a', 12);
  select count(*) into v_b from public.claim_inbound_events('worker-b', 12);

  if v_a <> 12 then
    raise exception 'FALLO 13a: worker-a tomo % trabajos, se esperaban 12', v_a;
  end if;
  if v_b <> 8 then
    raise exception 'FALLO 13b: worker-b tomo % trabajos, se esperaban 8 (los restantes)', v_b;
  end if;
  if (select count(*) from public.inbound_events where status = 'queued') <> 0 then
    raise exception 'FALLO 13c: quedaron trabajos sin repartir';
  end if;
  raise notice 'OK 13 · 20 eventos repartidos 12/8 entre dos workers, ninguno duplicado';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 14 · Reintento con espera creciente y muerte del trabajo
-- -----------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_e  public.inbound_events;
  i int;
begin
  select id into v_id from public.inbound_events where dedupe_key = 'evt-1';

  perform public.fail_inbound_event(v_id, 'Timeout contra la API del canal');
  select * into v_e from public.inbound_events where id = v_id;

  if v_e.status <> 'failed' then
    raise exception 'FALLO 14a: el estado quedo en % tras el primer fallo', v_e.status;
  end if;
  if v_e.available_at <= now() then
    raise exception 'FALLO 14b: el reintento quedo disponible de inmediato, sin espera';
  end if;

  -- Agotamos los intentos.
  for i in 1..5 loop
    update public.inbound_events set attempts = attempts + 1 where id = v_id;
    perform public.fail_inbound_event(v_id, 'Fallo persistente');
  end loop;

  select * into v_e from public.inbound_events where id = v_id;
  if v_e.status <> 'dead' then
    raise exception 'FALLO 14c: el trabajo sigue reintentando tras agotar los intentos (estado %)', v_e.status;
  end if;
  raise notice 'OK 14 · Backoff creciente y paso a "dead" al agotar los reintentos';
end $$;

\echo ''
\echo '======================================================================'
\echo ' TODAS LAS VERIFICACIONES PASARON'
\echo '======================================================================'
