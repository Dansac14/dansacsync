-- =============================================================================
-- Verificacion de la capa de canales: acuses, escalado y reindexado
-- =============================================================================
-- Se ejecuta despues de 01_verify_core.sql, sobre los datos que ese deja.
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- PRUEBA 15 · El estado de entrega solo avanza
-- -----------------------------------------------------------------------------
-- Meta manda los acuses desordenados con frecuencia. Sin la regla de avance, un
-- "sent" que llega tarde haria retroceder un mensaje ya leido y la bandeja
-- mostraria que el cliente no lo ha visto.
-- -----------------------------------------------------------------------------
do $$
declare
  v_acc   uuid;
  v_msg   uuid;
  v_conv  uuid;
  v_state public.delivery_status;
  v_applied boolean;
begin
  select id into v_acc from public.channel_accounts where external_account_id = '100000000000001';
  select c.id into v_conv from public.conversations c
   where c.channel_account_id = v_acc limit 1;

  -- Un mensaje saliente del bot, ya enviado al canal.
  insert into public.messages (
    tenant_id, conversation_id, contact_id, channel_account_id, channel,
    direction, sender_type, content, channel_message_id, delivery_status
  )
  select c.tenant_id, c.id, c.contact_id, c.channel_account_id, c.channel,
         'outbound', 'bot', 'Claro, el taller cuesta 118 soles.', 'wamid.out.1', 'sent'
  from public.conversations c where c.id = v_conv
  returning id into v_msg;

  -- Avanza: sent -> delivered
  v_applied := public.apply_delivery_status(v_acc, 'wamid.out.1', 'delivered');
  select delivery_status into v_state from public.messages where id = v_msg;
  if not v_applied or v_state <> 'delivered' then
    raise exception 'FALLO 15a: no avanzo a delivered (quedo en %)', v_state;
  end if;

  -- Avanza: delivered -> read
  perform public.apply_delivery_status(v_acc, 'wamid.out.1', 'read');
  select delivery_status into v_state from public.messages where id = v_msg;
  if v_state <> 'read' then
    raise exception 'FALLO 15b: no avanzo a read (quedo en %)', v_state;
  end if;

  -- No retrocede: llega un "sent" atrasado.
  v_applied := public.apply_delivery_status(v_acc, 'wamid.out.1', 'sent');
  select delivery_status into v_state from public.messages where id = v_msg;
  if v_state <> 'read' then
    raise exception 'FALLO 15c: un acuse atrasado hizo retroceder el estado a %', v_state;
  end if;
  if v_applied then
    raise exception 'FALLO 15d: la funcion dijo que aplico un acuse atrasado';
  end if;

  -- 'failed' si se aplica siempre: es informacion nueva y accionable.
  perform public.apply_delivery_status(v_acc, 'wamid.out.1', 'failed', 'Numero inexistente');
  select delivery_status into v_state from public.messages where id = v_msg;
  if v_state <> 'failed' then
    raise exception 'FALLO 15e: un fallo posterior no se registro (quedo en %)', v_state;
  end if;

  raise notice 'OK 15 · El acuse avanza sent->delivered->read, no retrocede, y failed siempre entra';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 16 · Marca de lectura de Messenger e Instagram
-- -----------------------------------------------------------------------------
do $$
declare
  v_acc  uuid;
  v_conv public.conversations;
  v_user text;
  v_count int;
  v_viejo uuid;
  v_nuevo uuid;
begin
  select id into v_acc from public.channel_accounts where external_account_id = '100000000000001';
  select c.* into v_conv from public.conversations c where c.channel_account_id = v_acc limit 1;
  select ci.channel_user_id into v_user
    from public.channel_identities ci where ci.id = v_conv.channel_identity_id;

  -- Dos mensajes salientes: uno anterior a la marca y otro posterior.
  insert into public.messages (
    tenant_id, conversation_id, contact_id, channel_account_id, channel,
    direction, sender_type, content, channel_message_id, delivery_status, created_at
  ) values
    (v_conv.tenant_id, v_conv.id, v_conv.contact_id, v_acc, v_conv.channel,
     'outbound', 'bot', 'Mensaje anterior a la marca', 'mid.viejo', 'sent', now() - interval '10 minutes')
  returning id into v_viejo;

  insert into public.messages (
    tenant_id, conversation_id, contact_id, channel_account_id, channel,
    direction, sender_type, content, channel_message_id, delivery_status, created_at
  ) values
    (v_conv.tenant_id, v_conv.id, v_conv.contact_id, v_acc, v_conv.channel,
     'outbound', 'bot', 'Mensaje posterior a la marca', 'mid.nuevo', 'sent', now() + interval '10 minutes')
  returning id into v_nuevo;

  v_count := public.apply_read_watermark(v_acc, v_user, now());

  if (select delivery_status from public.messages where id = v_viejo) <> 'read' then
    raise exception 'FALLO 16a: el mensaje anterior a la marca no quedo como leido';
  end if;
  if (select delivery_status from public.messages where id = v_nuevo) <> 'sent' then
    raise exception 'FALLO 16b: un mensaje posterior a la marca se marco como leido';
  end if;

  raise notice 'OK 16 · La marca de lectura afecta solo a los mensajes anteriores a ella (% mensajes)', v_count;
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 17 · Escalado a operador: las tres cosas a la vez
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv public.conversations;
  v_t    uuid;
  v_en_grupo int;
  v_auditado int;
begin
  select id into v_t from public.tenants where slug = 'empresa-dos';
  select c.* into v_conv from public.conversations c where c.tenant_id = v_t limit 1;

  -- Punto de partida: el bot atiende.
  update public.conversations set handling_mode = 'bot' where id = v_conv.id;

  perform public.escalate_conversation(v_conv.id, 'sin_contexto');

  select handling_mode into v_conv.handling_mode
    from public.conversations where id = v_conv.id;

  select count(*) into v_en_grupo
  from public.contact_groups cg
  join public.groups g on g.id = cg.group_id
  where cg.contact_id = v_conv.contact_id and g.system_key = 'human_support';

  select count(*) into v_auditado
  from public.audit_log
  where entity_id = v_conv.id::text and action = 'conversation.escalate';

  if v_conv.handling_mode <> 'human' then
    raise exception 'FALLO 17a: la conversacion sigue en modo bot';
  end if;
  if v_en_grupo <> 1 then
    raise exception 'FALLO 17b: el contacto no entro al grupo de atencion humana';
  end if;
  if v_auditado <> 1 then
    raise exception 'FALLO 17c: el escalado no quedo en la bitacora';
  end if;

  -- Idempotente: escalar dos veces no duplica la pertenencia al grupo.
  perform public.escalate_conversation(v_conv.id, 'sin_contexto');
  select count(*) into v_en_grupo
  from public.contact_groups cg
  join public.groups g on g.id = cg.group_id
  where cg.contact_id = v_conv.contact_id and g.system_key = 'human_support';

  if v_en_grupo <> 1 then
    raise exception 'FALLO 17d: escalar dos veces duplico la pertenencia al grupo';
  end if;

  raise notice 'OK 17 · Escalado: apaga el bot, agrupa al contacto y deja bitacora, sin duplicar';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 18 · Reindexado atomico de un manual
-- -----------------------------------------------------------------------------
-- Un manual a medio indexar es peor que el manual viejo completo: el agente
-- contestaria con la mitad del documento sin que nadie lo note.
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid;
  v_doc  uuid;
  v_vec  text;
  v_count int;
  v_falló boolean := false;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select id into v_doc from public.knowledge_documents where tenant_id = v_t limit 1;

  v_vec := '[' || array_to_string(array_fill(0.03::float8, array[1536]), ',') || ']';

  -- Reindexado con tres fragmentos nuevos.
  v_count := public.replace_document_chunks(v_doc, jsonb_build_array(
    jsonb_build_object('chunk_index', 0, 'section_name', 'Horarios',
      'content', 'Atendemos de lunes a viernes de 8:00 a 18:00.', 'embedding', v_vec),
    jsonb_build_object('chunk_index', 1, 'section_name', 'Precios',
      'content', 'El taller de finanzas cuesta 118 soles.', 'embedding', v_vec),
    jsonb_build_object('chunk_index', 2, 'section_name', 'Pagos',
      'content', 'Aceptamos transferencia, Yape y Plin.', 'embedding', v_vec)
  ));

  if v_count <> 3 then
    raise exception 'FALLO 18a: se indexaron % fragmentos en lugar de 3', v_count;
  end if;
  if (select chunk_count from public.knowledge_documents where id = v_doc) <> 3 then
    raise exception 'FALLO 18b: chunk_count del documento no se actualizo';
  end if;
  if (select status from public.knowledge_documents where id = v_doc) <> 'indexed' then
    raise exception 'FALLO 18c: el documento no quedo marcado como indexado';
  end if;

  -- Un reindexado con un fragmento invalido no debe dejar el documento vacio.
  begin
    perform public.replace_document_chunks(v_doc, jsonb_build_array(
      jsonb_build_object('chunk_index', 0, 'section_name', 'Valido',
        'content', 'Contenido correcto', 'embedding', v_vec),
      jsonb_build_object('chunk_index', 1, 'section_name', 'Roto',
        'content', 'Contenido con vector de dimension equivocada',
        'embedding', '[0.1,0.2,0.3]')
    ));
  exception when others then
    v_falló := true;
  end;

  if not v_falló then
    raise exception 'FALLO 18d: se acepto un fragmento con vector de dimension invalida';
  end if;

  -- Lo importante: el documento conserva sus 3 fragmentos anteriores.
  select count(*) into v_count from public.knowledge_chunks where document_id = v_doc;
  if v_count <> 3 then
    raise exception 'FALLO 18e: el reindexado fallido dejo % fragmentos en lugar de los 3 originales', v_count;
  end if;

  raise notice 'OK 18 · Reindexado atomico: un fragmento invalido deja el manual anterior intacto';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 19 · Cierre definitivo de un envio
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  v_msg  uuid;
  v_job  uuid;
  v_estado public.delivery_status;
  v_job_estado public.job_status;
begin
  select c.id into v_conv from public.conversations c
   where c.tenant_id = (select id from public.tenants where slug = 'empresa-uno') limit 1;

  v_msg := public.enqueue_outbound_message(v_conv, 'Mensaje que no va a poder salir', 'bot');
  select id into v_job from public.outbound_jobs where message_id = v_msg;

  perform public.kill_outbound_job(v_job, 'Ventana de servicio de 24 h cerrada');

  select status into v_job_estado from public.outbound_jobs where id = v_job;
  select delivery_status into v_estado from public.messages where id = v_msg;

  if v_job_estado <> 'dead' then
    raise exception 'FALLO 19a: el trabajo quedo en % y seguiria reintentando', v_job_estado;
  end if;
  if v_estado <> 'failed' then
    raise exception 'FALLO 19b: el mensaje quedo en % y el operador creeria que sigue en camino', v_estado;
  end if;
  if (select error_text from public.messages where id = v_msg) is null then
    raise exception 'FALLO 19c: el mensaje fallido no explica por que';
  end if;

  raise notice 'OK 19 · Un error permanente cierra el trabajo y marca el mensaje como fallido con motivo';
end $$;

\echo ''
\echo '======================================================================'
\echo ' VERIFICACIONES DE CANALES: TODAS PASARON'
\echo '======================================================================'
