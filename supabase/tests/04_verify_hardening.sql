-- =============================================================================
-- Verificacion del endurecimiento
-- =============================================================================
-- Cada bloque reproduce un ataque que SI funcionaba antes de la migracion 0016
-- y comprueba que ahora se rechaza. Si alguna de estas pruebas vuelve a pasar
-- en verde por el motivo contrario —porque el ataque funciona— la prueba falla.
--
-- Se ejecuta despues de 01, 02 y 03.
-- =============================================================================

\set ON_ERROR_STOP on

set role service_role;

-- Un tercer usuario, con rol de solo lectura en Empresa Uno.
set role postgres;
insert into auth.users (id, email)
values ('33333333-3333-3333-3333-333333333333', 'viewer@empresa-uno.pe')
on conflict do nothing;
set role service_role;

insert into public.tenant_members (tenant_id, user_id, role, status)
select id, '33333333-3333-3333-3333-333333333333', 'viewer', 'active'
from public.tenants where slug = 'empresa-uno'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- PRUEBA 29 · Sin sesion no se puede ejecutar ninguna funcion de escritura
-- -----------------------------------------------------------------------------
-- Antes: `anon` podia emitir facturas en empresas ajenas, marcar ordenes como
-- pagadas y escribir por WhatsApp a los clientes de otra empresa como si fuera
-- su bot. La causa era doble: Postgres concede EXECUTE a PUBLIC por defecto, y
-- la comprobacion de pertenencia se saltaba cuando auth.uid() era NULL.
-- -----------------------------------------------------------------------------
do $$
declare
  v_orden   uuid;
  v_conv    uuid;
  v_prod    uuid;
  v_bloqueadas int := 0;
  v_total      int := 0;
begin
  select id into v_orden from public.orders where status = 'paid' limit 1;
  select c.id into v_conv from public.conversations c limit 1;
  select id into v_prod from public.products limit 1;

  -- 1. Emitir un comprobante
  v_total := v_total + 1;
  begin
    set local role anon;
    perform public.issue_invoice_for_order(v_orden, 'factura', 'F001', '20999999999', 'ATACANTE SA');
    set role service_role;
  exception when others then
    set role service_role;
    v_bloqueadas := v_bloqueadas + 1;
  end;

  -- 2. Cobrar una orden
  v_total := v_total + 1;
  begin
    set local role anon;
    perform public.mark_order_paid(v_orden, 'atacante', 'REF-FALSA');
    set role service_role;
  exception when others then
    set role service_role;
    v_bloqueadas := v_bloqueadas + 1;
  end;

  -- 3. Enviar un mensaje al cliente haciendose pasar por el bot
  v_total := v_total + 1;
  begin
    set local role anon;
    perform public.enqueue_product_message(v_conv, v_prod);
    set role service_role;
  exception when others then
    set role service_role;
    v_bloqueadas := v_bloqueadas + 1;
  end;

  -- 4. Quemar correlativos fiscales
  v_total := v_total + 1;
  begin
    set local role anon;
    perform public.next_correlative(
      (select id from public.tenants where slug = 'empresa-uno'), 'factura', 'F001');
    set role service_role;
  exception when others then
    set role service_role;
    v_bloqueadas := v_bloqueadas + 1;
  end;

  -- 5. Enviar un mensaje como operador
  v_total := v_total + 1;
  begin
    set local role anon;
    perform public.send_operator_message(v_conv, 'mensaje de un desconocido');
    set role service_role;
  exception when others then
    set role service_role;
    v_bloqueadas := v_bloqueadas + 1;
  end;

  if v_bloqueadas <> v_total then
    raise exception 'FALLO 29: solo % de % operaciones sin sesion fueron rechazadas',
      v_bloqueadas, v_total;
  end if;

  raise notice 'OK 29 · Las % operaciones de escritura sin sesion se rechazan', v_total;
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 30 · Escritura entre empresas por la fila hija
-- -----------------------------------------------------------------------------
-- Antes: la RLS comprueba tenant_id, pero tenant_id lo escribe quien inserta.
-- Con MI tenant_id y el id de una orden AJENA, la politica aceptaba la fila y
-- el trigger de totales reescribia el total de la orden de la otra empresa.
-- -----------------------------------------------------------------------------
do $$
declare
  v_orden_uno uuid;
  v_conv_uno  public.conversations;
  v_t_dos     uuid;
  v_contacto_dos uuid;
  v_total_antes numeric;
  v_total_despues numeric;
  v_bloqueado boolean := false;
begin
  select id into v_t_dos from public.tenants where slug = 'empresa-dos';
  select id into v_contacto_dos from public.contacts where tenant_id = v_t_dos limit 1;

  select o.id, o.total into v_orden_uno, v_total_antes
  from public.orders o
  join public.tenants t on t.id = o.tenant_id
  where t.slug = 'empresa-uno' limit 1;

  select c.* into v_conv_uno
  from public.conversations c join public.tenants t on t.id = c.tenant_id
  where t.slug = 'empresa-uno' limit 1;

  -- Luis, propietario de Empresa Dos, intenta inyectar una linea de 999999
  -- en una orden de Empresa Uno.
  begin
    perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
    set local role authenticated;
    insert into public.order_items (tenant_id, order_id, name, unit_price, quantity)
    values (v_t_dos, v_orden_uno, 'LINEA INYECTADA', 999999.00, 1);
    set role service_role;
  exception when others then
    set role service_role;
    v_bloqueado := true;
  end;

  select total into v_total_despues from public.orders where id = v_orden_uno;

  if not v_bloqueado then
    raise exception 'FALLO 30a: se inserto una linea en la orden de otra empresa';
  end if;
  if v_total_despues <> v_total_antes then
    raise exception 'FALLO 30b: el total de la orden ajena cambio de % a %',
      v_total_antes, v_total_despues;
  end if;

  -- El mismo ataque sobre la bandeja de entrada.
  v_bloqueado := false;
  begin
    perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
    set local role authenticated;
    insert into public.messages (
      tenant_id, conversation_id, contact_id, channel_account_id, channel,
      direction, sender_type, sender_user_id, content
    )
    values (v_t_dos, v_conv_uno.id, v_contacto_dos, v_conv_uno.channel_account_id,
            v_conv_uno.channel, 'outbound', 'operator',
            '22222222-2222-2222-2222-222222222222', 'MENSAJE DE OTRA EMPRESA');
    set role service_role;
  exception when others then
    set role service_role;
    v_bloqueado := true;
  end;

  if not v_bloqueado then
    raise exception 'FALLO 30c: se escribio un mensaje en la conversacion de otra empresa';
  end if;

  raise notice 'OK 30 · La clave ajena compuesta impide escribir en filas hijas de otra empresa';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 31 · El rol de solo lectura no escribe
-- -----------------------------------------------------------------------------
-- Antes: todas las politicas de escritura usaban app.is_member(), cierto para
-- los cuatro roles. El `viewer` que se ofrece en la interfaz podia escribir
-- contactos, ordenes y mensajes.
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_contacto uuid;
  v_bloqueadas int := 0;
  v_lee int;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select id into v_contacto from public.contacts where tenant_id = v_t limit 1;

  -- Lectura: sí puede.
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  select count(*) into v_lee from public.contacts;
  set role service_role;

  if v_lee < 1 then
    raise exception 'FALLO 31a: el viewer no puede leer, y deberia';
  end if;

  -- Escritura: no.
  begin
    perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
    set local role authenticated;
    insert into public.contacts (tenant_id, first_name) values (v_t, 'Contacto del viewer');
    set role service_role;
  exception when others then
    set role service_role; v_bloqueadas := v_bloqueadas + 1;
  end;

  begin
    perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
    set local role authenticated;
    insert into public.orders (tenant_id, contact_id, currency) values (v_t, v_contacto, 'PEN');
    set role service_role;
  exception when others then
    set role service_role; v_bloqueadas := v_bloqueadas + 1;
  end;

  if v_bloqueadas <> 2 then
    raise exception 'FALLO 31b: el viewer pudo escribir (% de 2 bloqueadas)', v_bloqueadas;
  end if;

  raise notice 'OK 31 · El rol viewer lee pero no escribe';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 32 · Un comprobante no se inserta a mano ni se reescribe
-- -----------------------------------------------------------------------------
-- Antes: cualquier miembro podia insertar un comprobante con el correlativo que
-- la secuencia iba a asignar despues. La emision oficial chocaba con la clave
-- unica, la transaccion abortaba, el correlativo revertia, y CADA reintento
-- volvia a chocar con el mismo numero: facturacion bloqueada, y sin politica de
-- DELETE nadie podia quitar la fila.
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_inv public.sales_invoices;
  v_bloqueado boolean := false;
  v_total_original numeric;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';

  -- Insercion directa: rechazada.
  begin
    perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
    set local role authenticated;
    insert into public.sales_invoices (
      tenant_id, kind, series, correlative, receiver_tax_id, receiver_name,
      subtotal, tax_amount, total, state
    )
    values (v_t, 'factura', 'F001', 999, '20123456789', 'FACTURA A MANO', 100, 18, 118, 'issued');
    set role service_role;
  exception when others then
    set role service_role; v_bloqueado := true;
  end;

  if not v_bloqueado then
    raise exception 'FALLO 32a: se inserto un comprobante sin pasar por la funcion de emision';
  end if;

  -- Reescritura de uno ya emitido: rechazada, incluso para el propietario.
  select * into v_inv from public.sales_invoices
   where tenant_id = v_t and state = 'issued' limit 1;
  v_total_original := v_inv.total;

  v_bloqueado := false;
  begin
    perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
    set local role authenticated;
    update public.sales_invoices
    set total = 1.00, subtotal = 1.00, tax_amount = 0.00, receiver_name = 'OTRO CLIENTE'
    where id = v_inv.id;
    set role service_role;
  exception when others then
    set role service_role; v_bloqueado := true;
  end;

  if not v_bloqueado then
    raise exception 'FALLO 32b: se reescribio un comprobante ya emitido';
  end if;
  if (select total from public.sales_invoices where id = v_inv.id) <> v_total_original then
    raise exception 'FALLO 32c: el importe del comprobante cambio';
  end if;

  -- Lo que si se permite: registrar la respuesta del OSE y anularlo.
  update public.sales_invoices
  set state = 'accepted', provider_name = 'OSE Demo', xml_url = 'https://ose/x.xml'
  where id = v_inv.id;

  if (select state from public.sales_invoices where id = v_inv.id) <> 'accepted' then
    raise exception 'FALLO 32d: no se pudo registrar la aceptacion del comprobante';
  end if;

  raise notice 'OK 32 · Comprobantes: solo por funcion, e inmutables en importes y receptor';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 33 · Los importes y el estado de una orden no se cambian a mano
-- -----------------------------------------------------------------------------
-- Antes: un UPDATE directo dejaba total = 0.01 en una orden de 1750, o la
-- pasaba a 'paid' sin descontar stock ni dejar rastro. El enlace publico
-- muestra `total`, asi que cobrar un centimo era un UPDATE.
-- -----------------------------------------------------------------------------
do $$
declare
  v_orden public.orders;
  v_bloqueadas int := 0;
begin
  select o.* into v_orden from public.orders o
  join public.tenants t on t.id = o.tenant_id
  where t.slug = 'empresa-uno' and o.status = 'paid' limit 1;

  begin
    perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
    set local role authenticated;
    update public.orders set total = 0.01 where id = v_orden.id;
    set role service_role;
  exception when others then
    set role service_role; v_bloqueadas := v_bloqueadas + 1;
  end;

  begin
    perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
    set local role authenticated;
    update public.orders set status = 'paid', paid_at = now() where id = v_orden.id;
    set role service_role;
  exception when others then
    set role service_role; v_bloqueadas := v_bloqueadas + 1;
  end;

  if v_bloqueadas <> 2 then
    raise exception 'FALLO 33a: se pudo cambiar importe o estado a mano (% de 2 bloqueadas)', v_bloqueadas;
  end if;
  if (select total from public.orders where id = v_orden.id) <> v_orden.total then
    raise exception 'FALLO 33b: el total de la orden cambio';
  end if;

  -- Lo que si puede el operador: anotar y guardar el enlace de pago.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  update public.orders set notes = 'Cliente pidio factura' where id = v_orden.id;
  set role service_role;

  if (select notes from public.orders where id = v_orden.id) is null then
    raise exception 'FALLO 33c: el operador no pudo anotar la orden, y deberia';
  end if;

  -- Y la base ya no admite importes que no cuadren, ni desde el backend.
  declare v_incoherente boolean := false;
  begin
    begin
      update public.orders set subtotal = 1000, tax_amount = 180, total = 0
      where id = v_orden.id;
    exception when check_violation then
      v_incoherente := true;
    end;
    if not v_incoherente then
      raise exception 'FALLO 33d: se acepto una orden cuyo total no es base + IGV - descuento';
    end if;
  end;

  raise notice 'OK 33 · Importes y estado de la orden solo cambian por funcion, y siempre cuadran';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 34 · La autoria no se falsifica
-- -----------------------------------------------------------------------------
-- Antes: un operador podia cargar gastos y comprobantes a nombre del
-- propietario. En una disputa interna, la base no distinguia quien hizo qué.
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_gasto uuid;
  v_autor uuid;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';

  -- Ana (propietaria) intenta cargar un gasto a nombre de Luis.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  insert into public.purchases_and_expenses (
    tenant_id, supplier_name, category, subtotal, tax_amount, total, created_by
  )
  values (v_t, 'Proveedor X', 'Servicios', 100, 18, 118,
          '22222222-2222-2222-2222-222222222222')
  returning id into v_gasto;
  set role service_role;

  select created_by into v_autor from public.purchases_and_expenses where id = v_gasto;

  if v_autor <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'FALLO 34: el gasto quedo atribuido a % en lugar de a quien lo creo', v_autor;
  end if;

  raise notice 'OK 34 · created_by se fuerza al usuario de la sesion, no al que diga el cliente';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 35 · Un grupo propio no se puede volver del sistema
-- -----------------------------------------------------------------------------
-- Antes: el `using` de la politica excluia is_system pero el `with check` no,
-- asi que cualquier miembro podia marcar sus grupos como del sistema y quedaban
-- indestructibles para todos, incluido el propietario.
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_grupo uuid;
  v_bloqueado boolean := false;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  insert into public.groups (tenant_id, name) values (v_t, 'Grupo de prueba 35')
  returning id into v_grupo;

  begin
    update public.groups set is_system = true where id = v_grupo;
  exception when others then
    v_bloqueado := true;
  end;
  set role service_role;

  if not v_bloqueado and (select is_system from public.groups where id = v_grupo) then
    raise exception 'FALLO 35a: un miembro convirtio su grupo en grupo del sistema';
  end if;

  -- Y sigue siendo borrable, que es lo que se rompia antes.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  delete from public.groups where id = v_grupo;
  set role service_role;

  if exists (select 1 from public.groups where id = v_grupo) then
    raise exception 'FALLO 35b: el grupo quedo imborrable';
  end if;

  raise notice 'OK 35 · Un grupo propio no se vuelve del sistema y sigue siendo borrable';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 36 · Los trabajos abandonados vuelven a la cola
-- -----------------------------------------------------------------------------
-- Antes: si el worker moria, los eventos que ya habia tomado quedaban en
-- 'processing' y ninguna consulta los recogia de nuevo. Mensajes de clientes
-- sin respuesta y sin reintento, sin ninguna alerta.
-- -----------------------------------------------------------------------------
do $$
declare
  v_evento uuid;
  v_r record;
  v_recogidos int;
begin
  insert into public.inbound_events (dedupe_key, payload)
  values ('evt-abandonado-36', '{"prueba":true}'::jsonb)
  returning id into v_evento;

  -- Un worker lo toma y muere: queda tomado y con fecha antigua.
  update public.inbound_events
  set status = 'processing', locked_at = now() - interval '30 minutes', locked_by = 'worker-muerto'
  where id = v_evento;

  select count(*) into v_recogidos from public.claim_inbound_events('worker-vivo', 10)
   where id = v_evento;
  if v_recogidos <> 0 then
    raise exception 'FALLO 36a: un trabajo en processing se tomo por segunda vez (duplicaria el envio)';
  end if;

  select * into v_r from public.requeue_stale_jobs('5 minutes');
  if v_r.entrada < 1 then
    raise exception 'FALLO 36b: el trabajo abandonado no se devolvio a la cola';
  end if;

  select count(*) into v_recogidos from public.claim_inbound_events('worker-vivo', 10)
   where id = v_evento;
  if v_recogidos <> 1 then
    raise exception 'FALLO 36c: tras recuperarlo, el trabajo sigue sin poder tomarse';
  end if;

  raise notice 'OK 36 · Un trabajo abandonado no se duplica y se recupera tras el plazo';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 37 · Un miembro no puede numerar comprobantes de otra empresa
-- -----------------------------------------------------------------------------
do $$
declare
  v_t_uno uuid;
  v_bloqueado boolean := false;
  v_siguiente bigint;
begin
  select id into v_t_uno from public.tenants where slug = 'empresa-uno';
  select next_value into v_siguiente from public.numbering_sequences
   where tenant_id = v_t_uno and scope = 'factura' and series = 'F001';

  begin
    perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
    set local role authenticated;
    perform public.next_correlative(v_t_uno, 'factura', 'F001');
    set role service_role;
  exception when others then
    set role service_role; v_bloqueado := true;
  end;

  if not v_bloqueado then
    raise exception 'FALLO 37a: un miembro de otra empresa consumio un correlativo ajeno';
  end if;
  if (select next_value from public.numbering_sequences
       where tenant_id = v_t_uno and scope = 'factura' and series = 'F001') <> v_siguiente then
    raise exception 'FALLO 37b: el correlativo avanzo a pesar del rechazo';
  end if;

  raise notice 'OK 37 · La numeracion fiscal solo avanza para la propia empresa';
end $$;

\echo ''
\echo '======================================================================'
\echo ' VERIFICACIONES DE ENDURECIMIENTO: TODAS PASARON'
\echo '======================================================================'
