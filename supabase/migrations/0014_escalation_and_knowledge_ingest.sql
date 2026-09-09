-- =============================================================================
-- 0014 · Escalado a operador e ingesta de conocimiento
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Escalado
-- -----------------------------------------------------------------------------
-- Pasar una conversacion a una persona son tres cosas a la vez: apagar el bot,
-- meter al contacto en el grupo de atencion humana y dejar constancia. Si se
-- hicieran por separado y el proceso muriera en medio, quedaria una
-- conversacion que el bot ya no atiende y que nadie sabe que tiene que atender.
-- -----------------------------------------------------------------------------

create or replace function public.escalate_conversation(
  p_conversation_id uuid,
  p_reason          varchar default null
)
returns public.conversations
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv  public.conversations;
  v_group uuid;
begin
  update public.conversations c
  set handling_mode = 'human',
      status        = case when c.status = 'resolved' then 'open'::public.conversation_status
                           else c.status end
  where c.id = p_conversation_id
  returning * into v_conv;

  if not found then
    raise exception 'Conversacion % inexistente', p_conversation_id;
  end if;

  select id into v_group
  from public.groups
  where tenant_id = v_conv.tenant_id and system_key = 'human_support';

  if v_group is not null then
    insert into public.contact_groups (contact_id, group_id, tenant_id)
    values (v_conv.contact_id, v_group, v_conv.tenant_id)
    on conflict do nothing;
  end if;

  -- actor_id queda nulo a proposito: escalo el sistema, no una persona.
  insert into public.audit_log (tenant_id, actor_label, action, entity_type, entity_id, after_state)
  values (
    v_conv.tenant_id, 'agente de IA', 'conversation.escalate',
    'conversation', v_conv.id::text,
    jsonb_build_object('reason', p_reason)
  );

  return v_conv;
end;
$$;

revoke all on function public.escalate_conversation(uuid, varchar) from public, anon, authenticated;
grant execute on function public.escalate_conversation(uuid, varchar) to service_role;

-- -----------------------------------------------------------------------------
-- Reindexado de un documento
-- -----------------------------------------------------------------------------
-- Reindexar un manual editado tiene que ser atomico. Si se borraran los
-- fragmentos viejos y la insercion de los nuevos fallara a medias, el agente se
-- quedaria contestando con medio manual, que es peor que con el manual viejo
-- completo. Aqui el borrado y la insercion ocurren en la misma transaccion.
-- -----------------------------------------------------------------------------

create or replace function public.replace_document_chunks(
  p_document_id uuid,
  p_chunks      jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_doc    public.knowledge_documents;
  v_count  integer;
begin
  select * into v_doc from public.knowledge_documents where id = p_document_id;
  if not found then
    raise exception 'Documento % inexistente', p_document_id;
  end if;

  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) = 0 then
    raise exception 'No se recibio ningun fragmento para indexar';
  end if;

  delete from public.knowledge_chunks where document_id = p_document_id;

  insert into public.knowledge_chunks (
    tenant_id, document_id, section_name, chunk_index, content, token_count, embedding, metadata
  )
  select
    v_doc.tenant_id,
    p_document_id,
    nullif(chunk->>'section_name', ''),
    (chunk->>'chunk_index')::integer,
    chunk->>'content',
    nullif(chunk->>'token_count', '')::integer,
    (chunk->>'embedding')::extensions.vector,
    coalesce(chunk->'metadata', '{}'::jsonb)
  from jsonb_array_elements(p_chunks) as chunk;

  select count(*) into v_count from public.knowledge_chunks where document_id = p_document_id;

  update public.knowledge_documents
  set status = 'indexed', chunk_count = v_count, error_text = null, updated_at = now()
  where id = p_document_id;

  return v_count;
end;
$$;

revoke all on function public.replace_document_chunks(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_document_chunks(uuid, jsonb) to service_role;

comment on function public.replace_document_chunks(uuid, jsonb) is
  'Sustituye todos los fragmentos de un documento en una sola transaccion. El agente nunca ve un manual a medio indexar.';
