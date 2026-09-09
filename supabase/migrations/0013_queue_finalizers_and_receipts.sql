-- =============================================================================
-- 0013 · Fallos definitivos y acuses de entrega
-- =============================================================================
-- Complementa las funciones de cola de 0010 con dos cosas que el worker
-- necesita para no desperdiciar reintentos ni mentir en la bandeja.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Fallo definitivo
-- -----------------------------------------------------------------------------
-- fail_* aplica espera creciente porque asume que el problema puede pasar. Hay
-- errores que no pasan: un token revocado, un destinatario que bloqueo la
-- cuenta, un mensaje fuera de la ventana de 24 horas. Reintentarlos cinco veces
-- retrasa la cola y no cambia el resultado, asi que se cierran de una vez.
-- -----------------------------------------------------------------------------

create or replace function public.kill_inbound_event(p_event_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.inbound_events
  set status = 'dead', last_error = p_error, locked_at = null, locked_by = null,
      processed_at = now()
  where id = p_event_id;
$$;

create or replace function public.kill_outbound_job(p_job_id uuid, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update public.outbound_jobs
  set status = 'dead', last_error = p_error, locked_at = null, locked_by = null,
      processed_at = now()
  where id = p_job_id;

  -- El operador tiene que ver que su mensaje no salio. Un mensaje que se queda
  -- en "pendiente" para siempre es peor que uno marcado como fallido: nadie
  -- vuelve a intentarlo porque nadie sabe que no llego.
  update public.messages m
  set delivery_status = 'failed', error_text = p_error
  from public.outbound_jobs j
  where j.id = p_job_id and m.id = j.message_id;
end;
$$;

revoke all on function public.kill_inbound_event(uuid, text) from public, anon, authenticated;
revoke all on function public.kill_outbound_job(uuid, text) from public, anon, authenticated;
grant execute on function public.kill_inbound_event(uuid, text),
                          public.kill_outbound_job(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- Acuses de entrega
-- -----------------------------------------------------------------------------
-- El estado solo avanza: pending -> sent -> delivered -> read. Los acuses de
-- Meta llegan desordenados con frecuencia, y sin esta regla un "sent" que llega
-- tarde retrocederia un mensaje ya leido.
-- -----------------------------------------------------------------------------

create or replace function public.apply_delivery_status(
  p_channel_account_id uuid,
  p_channel_message_id text,
  p_status             public.delivery_status,
  p_error              text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_rank_new int;
  v_updated  int;
begin
  v_rank_new := case p_status
                  when 'pending' then 0 when 'sent' then 1
                  when 'delivered' then 2 when 'read' then 3
                  when 'failed' then 4 end;

  update public.messages m
  set delivery_status = p_status,
      error_text      = coalesce(p_error, m.error_text)
  where m.channel_account_id = p_channel_account_id
    and m.channel_message_id = p_channel_message_id
    and (
      -- 'failed' siempre se aplica: es informacion nueva y accionable.
      p_status = 'failed'
      or case m.delivery_status
           when 'pending' then 0 when 'sent' then 1
           when 'delivered' then 2 when 'read' then 3
           when 'failed' then 4 end < v_rank_new
    );

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Messenger e Instagram no dicen que mensaje se leyo: mandan una marca de
-- tiempo y todo lo anterior a ella cuenta como leido.
create or replace function public.apply_read_watermark(
  p_channel_account_id uuid,
  p_channel_user_id    text,
  p_watermark          timestamptz
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated int;
begin
  update public.messages m
  set delivery_status = 'read'
  where m.channel_account_id = p_channel_account_id
    and m.direction = 'outbound'
    and m.delivery_status in ('sent', 'delivered')
    and m.created_at <= p_watermark
    and m.conversation_id in (
      select c.id
      from public.conversations c
      join public.channel_identities ci on ci.id = c.channel_identity_id
      where ci.channel_account_id = p_channel_account_id
        and ci.channel_user_id    = p_channel_user_id
    );

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.apply_delivery_status(uuid, text, public.delivery_status, text) from public, anon, authenticated;
revoke all on function public.apply_read_watermark(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_delivery_status(uuid, text, public.delivery_status, text),
                          public.apply_read_watermark(uuid, text, timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- Datos que el worker necesita para despachar un mensaje
-- -----------------------------------------------------------------------------
-- Reune en una consulta el destinatario, el contenido y el estado de la ventana
-- de servicio. Sin esto, cada envio serian cuatro viajes a la base.
-- -----------------------------------------------------------------------------

create or replace function public.outbound_dispatch_context(p_job_id uuid)
returns table (
  message_id            uuid,
  tenant_id             uuid,
  conversation_id       uuid,
  channel_account_id    uuid,
  channel               public.channel_type,
  recipient_id          text,
  content               text,
  media_type            public.media_type,
  media_url             text,
  service_window_expires_at timestamptz,
  handling_mode         public.handling_mode
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    m.id, m.tenant_id, m.conversation_id, m.channel_account_id, m.channel,
    ci.channel_user_id::text, m.content, m.media_type, m.media_url,
    c.service_window_expires_at, c.handling_mode
  from public.outbound_jobs j
  join public.messages m       on m.id = j.message_id
  join public.conversations c  on c.id = m.conversation_id
  join public.channel_identities ci on ci.id = c.channel_identity_id
  where j.id = p_job_id;
$$;

revoke all on function public.outbound_dispatch_context(uuid) from public, anon, authenticated;
grant execute on function public.outbound_dispatch_context(uuid) to service_role;
