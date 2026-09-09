-- =============================================================================
-- 0010 · Funciones de dominio
-- =============================================================================
-- La logica que tiene que ser atomica vive en la base, no en el worker: si el
-- proceso muere entre dos pasos, la base queda consistente igual.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Resolucion de tenant desde un evento entrante
-- -----------------------------------------------------------------------------

create or replace function public.resolve_channel_account(
  p_channel             public.channel_type,
  p_external_account_id text
)
returns public.channel_accounts
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ca.*
  from public.channel_accounts ca
  where ca.channel = p_channel
    and ca.external_account_id = p_external_account_id
    and ca.is_active
  limit 1;
$$;

revoke all on function public.resolve_channel_account(public.channel_type, text) from public, anon, authenticated;
grant execute on function public.resolve_channel_account(public.channel_type, text) to service_role;

-- -----------------------------------------------------------------------------
-- Encolado idempotente del evento crudo
-- -----------------------------------------------------------------------------
-- Devuelve el id del evento y si ya existia. Meta reintenta el mismo webhook
-- hasta que recibe 200; sin este ON CONFLICT cada reintento generaria una
-- respuesta duplicada del bot al cliente.
-- -----------------------------------------------------------------------------

create or replace function public.enqueue_inbound_event(
  p_dedupe_key         text,
  p_payload            jsonb,
  p_channel            public.channel_type default null,
  p_channel_account_id uuid default null,
  p_tenant_id          uuid default null,
  p_signature_verified boolean default false
)
returns table (event_id uuid, was_duplicate boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.inbound_events (
    dedupe_key, payload, channel, channel_account_id, tenant_id, signature_verified
  )
  values (
    p_dedupe_key, p_payload, p_channel, p_channel_account_id, p_tenant_id, p_signature_verified
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, false;
  else
    return query select ie.id, true from public.inbound_events ie where ie.dedupe_key = p_dedupe_key;
  end if;
end;
$$;

revoke all on function public.enqueue_inbound_event(text, jsonb, public.channel_type, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.enqueue_inbound_event(text, jsonb, public.channel_type, uuid, uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- Toma de trabajo por el worker
-- -----------------------------------------------------------------------------
-- FOR UPDATE SKIP LOCKED permite que varios workers lean la misma cola sin
-- pisarse: cada uno se lleva filas distintas y ninguno espera al otro.
-- -----------------------------------------------------------------------------

create or replace function public.claim_inbound_events(
  p_worker_id text,
  p_limit     integer default 10
)
returns setof public.inbound_events
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select ie.id
    from public.inbound_events ie
    where ie.status in ('queued','failed')
      and ie.available_at <= now()
      and ie.attempts < ie.max_attempts
    order by ie.available_at, ie.id
    limit greatest(p_limit, 1)
    for update skip locked
  )
  update public.inbound_events e
  set status    = 'processing',
      attempts  = e.attempts + 1,
      locked_at = now(),
      locked_by = p_worker_id
  from picked
  where e.id = picked.id
  returning e.*;
end;
$$;

create or replace function public.complete_inbound_event(p_event_id uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.inbound_events
  set status = 'done', processed_at = now(), locked_at = null, locked_by = null, last_error = null
  where id = p_event_id;
$$;

-- Backoff exponencial: 2s, 8s, 32s, 128s... y a 'dead' al agotar los intentos.
create or replace function public.fail_inbound_event(p_event_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.inbound_events e
  set status       = case when e.attempts >= e.max_attempts then 'dead'::public.job_status
                          else 'failed'::public.job_status end,
      last_error   = p_error,
      locked_at    = null,
      locked_by    = null,
      available_at = now() + (interval '2 seconds' * power(4, least(e.attempts, 5)))
  where e.id = p_event_id;
$$;

revoke all on function public.claim_inbound_events(text, integer) from public, anon, authenticated;
revoke all on function public.complete_inbound_event(uuid) from public, anon, authenticated;
revoke all on function public.fail_inbound_event(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_inbound_events(text, integer),
                          public.complete_inbound_event(uuid),
                          public.fail_inbound_event(uuid, text) to service_role;

-- Las mismas tres operaciones para la cola de salida.
create or replace function public.claim_outbound_jobs(p_worker_id text, p_limit integer default 10)
returns setof public.outbound_jobs
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select j.id from public.outbound_jobs j
    where j.status in ('queued','failed')
      and j.available_at <= now()
      and j.attempts < j.max_attempts
    order by j.available_at, j.id
    limit greatest(p_limit, 1)
    for update skip locked
  )
  update public.outbound_jobs o
  set status = 'processing', attempts = o.attempts + 1, locked_at = now(), locked_by = p_worker_id
  from picked where o.id = picked.id
  returning o.*;
end;
$$;

create or replace function public.complete_outbound_job(p_job_id uuid, p_channel_message_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update public.outbound_jobs
  set status = 'done', processed_at = now(), locked_at = null, locked_by = null, last_error = null
  where id = p_job_id;

  update public.messages m
  set delivery_status    = 'sent',
      sent_at            = now(),
      channel_message_id = coalesce(p_channel_message_id, m.channel_message_id)
  from public.outbound_jobs j
  where j.id = p_job_id and m.id = j.message_id;
end;
$$;

create or replace function public.fail_outbound_job(p_job_id uuid, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_dead boolean;
begin
  update public.outbound_jobs j
  set status       = case when j.attempts >= j.max_attempts then 'dead'::public.job_status
                          else 'failed'::public.job_status end,
      last_error   = p_error,
      locked_at    = null,
      locked_by    = null,
      available_at = now() + (interval '2 seconds' * power(4, least(j.attempts, 5)))
  where j.id = p_job_id
  returning (j.status = 'dead') into v_dead;

  -- Solo cuando ya no habra mas reintentos el mensaje se marca fallido en la
  -- bandeja; antes de eso sigue en camino y el operador no debe ver un error.
  if v_dead then
    update public.messages m
    set delivery_status = 'failed', error_text = p_error
    from public.outbound_jobs j
    where j.id = p_job_id and m.id = j.message_id;
  end if;
end;
$$;

revoke all on function public.claim_outbound_jobs(text, integer) from public, anon, authenticated;
revoke all on function public.complete_outbound_job(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_outbound_job(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_outbound_jobs(text, integer),
                          public.complete_outbound_job(uuid, text),
                          public.fail_outbound_job(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- Ingesta de un mensaje entrante
-- -----------------------------------------------------------------------------
-- Resuelve o crea contacto, identidad y conversacion, y guarda el mensaje, todo
-- en una transaccion. Si el mensaje ya existia (reintento de Meta) devuelve la
-- fila existente marcada como duplicada y el worker se detiene ahi.
-- -----------------------------------------------------------------------------

create or replace function public.ingest_inbound_message(
  p_channel_account_id uuid,
  p_channel_user_id    text,
  p_channel_message_id text,
  p_content            text,
  p_media_type         public.media_type default 'text',
  p_media_url          text default null,
  p_media_external_id  text default null,
  p_display_name       text default null,
  p_payload            jsonb default '{}'::jsonb,
  p_sent_at            timestamptz default now()
)
returns table (
  contact_id      uuid,
  conversation_id uuid,
  message_id      uuid,
  handling_mode   public.handling_mode,
  is_duplicate    boolean,
  is_new_contact  boolean
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_account       public.channel_accounts;
  v_identity      public.channel_identities;
  v_contact_id    uuid;
  v_conversation  public.conversations;
  v_conv_id       uuid;
  v_message_id    uuid;
  v_new_contact   boolean := false;
  v_group_id      uuid;
begin
  select * into v_account from public.channel_accounts where id = p_channel_account_id;
  if not found then
    raise exception 'Cuenta de canal % inexistente', p_channel_account_id
      using errcode = 'foreign_key_violation';
  end if;

  -- 1. Corte temprano por duplicado, antes de crear nada.
  if p_channel_message_id is not null then
    select m.id, m.contact_id, m.conversation_id
      into v_message_id, v_contact_id, v_conv_id
    from public.messages m
    where m.channel_account_id = p_channel_account_id
      and m.channel_message_id = p_channel_message_id;

    if found then
      return query
        select v_contact_id, v_conv_id, v_message_id,
               c.handling_mode, true, false
        from public.conversations c where c.id = v_conv_id;
      return;
    end if;
  end if;

  -- 2. Identidad del canal
  select * into v_identity
  from public.channel_identities
  where channel_account_id = p_channel_account_id
    and channel_user_id    = p_channel_user_id;

  if not found then
    insert into public.contacts (tenant_id, first_name)
    values (v_account.tenant_id, nullif(p_display_name, ''))
    returning id into v_contact_id;
    v_new_contact := true;

    insert into public.channel_identities (
      tenant_id, contact_id, channel_account_id, channel, channel_user_id, display_name, profile
    )
    values (
      v_account.tenant_id, v_contact_id, p_channel_account_id, v_account.channel,
      p_channel_user_id, nullif(p_display_name, ''), coalesce(p_payload -> 'profile', '{}'::jsonb)
    )
    returning * into v_identity;

    -- Alta automatica en el grupo de leads nuevos del tenant.
    select id into v_group_id
    from public.groups
    where tenant_id = v_account.tenant_id and system_key = 'new_leads';

    if v_group_id is not null then
      insert into public.contact_groups (contact_id, group_id, tenant_id)
      values (v_contact_id, v_group_id, v_account.tenant_id)
      on conflict do nothing;
    end if;
  else
    v_contact_id := v_identity.contact_id;
    -- El nombre de perfil puede aparecer recien en el segundo mensaje.
    if p_display_name is not null and v_identity.display_name is distinct from p_display_name then
      update public.channel_identities set display_name = p_display_name where id = v_identity.id;
      update public.contacts set first_name = coalesce(first_name, p_display_name) where id = v_contact_id;
    end if;
  end if;

  -- 3. Conversacion abierta
  select * into v_conversation
  from public.conversations
  where channel_identity_id = v_identity.id and status <> 'resolved'
  limit 1;

  if not found then
    insert into public.conversations (
      tenant_id, contact_id, channel_identity_id, channel_account_id, channel
    )
    values (
      v_account.tenant_id, v_contact_id, v_identity.id, p_channel_account_id, v_account.channel
    )
    returning * into v_conversation;
  end if;

  -- 4. Mensaje
  insert into public.messages (
    tenant_id, conversation_id, contact_id, channel_account_id, channel,
    direction, sender_type, content, media_type, media_url, media_external_id,
    payload, channel_message_id, delivery_status, sent_at
  )
  values (
    v_account.tenant_id, v_conversation.id, v_contact_id, p_channel_account_id, v_account.channel,
    'inbound', 'contact', p_content, p_media_type, p_media_url, p_media_external_id,
    p_payload, p_channel_message_id, 'delivered', p_sent_at
  )
  returning id into v_message_id;

  update public.channel_accounts set last_event_at = now() where id = p_channel_account_id;

  return query
    select v_contact_id, v_conversation.id, v_message_id,
           c.handling_mode, false, v_new_contact
    from public.conversations c where c.id = v_conversation.id;
end;
$$;

revoke all on function public.ingest_inbound_message(uuid, text, text, text, public.media_type, text, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_inbound_message(uuid, text, text, text, public.media_type, text, text, text, jsonb, timestamptz)
  to service_role;

-- -----------------------------------------------------------------------------
-- Salida: crear mensaje y encolarlo en una sola operacion
-- -----------------------------------------------------------------------------

create or replace function public.enqueue_outbound_message(
  p_conversation_id uuid,
  p_content         text,
  p_sender_type     public.sender_role default 'bot',
  p_sender_user_id  uuid default null,
  p_media_type      public.media_type default 'text',
  p_media_url       text default null,
  p_payload         jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv    public.conversations;
  v_message uuid;
begin
  select * into v_conv from public.conversations where id = p_conversation_id;
  if not found then
    raise exception 'Conversacion % inexistente', p_conversation_id;
  end if;

  insert into public.messages (
    tenant_id, conversation_id, contact_id, channel_account_id, channel,
    direction, sender_type, sender_user_id, content, media_type, media_url, payload, delivery_status
  )
  values (
    v_conv.tenant_id, v_conv.id, v_conv.contact_id, v_conv.channel_account_id, v_conv.channel,
    'outbound', p_sender_type, p_sender_user_id, p_content, p_media_type, p_media_url, p_payload, 'pending'
  )
  returning id into v_message;

  insert into public.outbound_jobs (tenant_id, message_id, conversation_id)
  values (v_conv.tenant_id, v_message, v_conv.id);

  return v_message;
end;
$$;

revoke all on function public.enqueue_outbound_message(uuid, text, public.sender_role, uuid, public.media_type, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_outbound_message(uuid, text, public.sender_role, uuid, public.media_type, text, jsonb)
  to service_role;

-- -----------------------------------------------------------------------------
-- Acciones del operador desde la bandeja
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER porque tienen que escribir en outbound_jobs, tabla sin
-- politicas de escritura. La pertenencia al tenant se comprueba explicitamente
-- en la primera linea de cada funcion.
-- -----------------------------------------------------------------------------

create or replace function public.send_operator_message(
  p_conversation_id uuid,
  p_content         text,
  p_media_type      public.media_type default 'text',
  p_media_url       text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv public.conversations;
begin
  select * into v_conv from public.conversations where id = p_conversation_id;
  if not found or not app.is_member(v_conv.tenant_id) then
    raise exception 'Conversacion no encontrada' using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_content), '') = '' and p_media_url is null then
    raise exception 'El mensaje esta vacio';
  end if;

  return public.enqueue_outbound_message(
    p_conversation_id, p_content, 'operator', auth.uid(), p_media_type, p_media_url
  );
end;
$$;

create or replace function public.set_handling_mode(
  p_conversation_id uuid,
  p_mode            public.handling_mode
)
returns public.conversations
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row public.conversations;
begin
  update public.conversations c
  set handling_mode        = p_mode,
      assigned_operator_id = case when p_mode = 'human' then auth.uid() else null end,
      taken_over_at        = case when p_mode = 'human' then now() else null end
  where c.id = p_conversation_id
  returning * into v_row;

  if not found then
    raise exception 'Conversacion no encontrada' using errcode = 'insufficient_privilege';
  end if;

  return v_row;
end;
$$;

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  update public.conversations set unread_count = 0 where id = p_conversation_id;
$$;

grant execute on function public.send_operator_message(uuid, text, public.media_type, text),
                          public.set_handling_mode(uuid, public.handling_mode),
                          public.mark_conversation_read(uuid)
  to authenticated;
