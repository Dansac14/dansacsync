-- =============================================================================
-- 0003 · Contactos, identidad unificada, conversaciones y mensajes
-- =============================================================================
-- Una persona es UN contacto aunque escriba por WhatsApp hoy y por Instagram
-- manana: cada canal aporta una fila en channel_identities que apunta al mismo
-- contacto. La conversacion es el hilo por identidad, y es lo que ve el operador
-- en la bandeja.
-- =============================================================================

create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  first_name    varchar(100),
  last_name     varchar(100),
  email         varchar(190),
  phone         varchar(30),
  locale        varchar(10),
  timezone      varchar(64),
  tax_id_number varchar(50),          -- RUC o DNI, para emitir comprobante
  tax_name      varchar(200),
  notes         text,
  attributes    jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index contacts_tenant_idx       on public.contacts (tenant_id, created_at desc);
create index contacts_tenant_phone_idx on public.contacts (tenant_id, phone) where phone is not null;
create index contacts_tenant_email_idx on public.contacts (tenant_id, lower(email)) where email is not null;
create index contacts_name_trgm_idx    on public.contacts
  using gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'')) extensions.gin_trgm_ops);

create trigger contacts_touch
  before update on public.contacts
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Identidades por canal
-- -----------------------------------------------------------------------------
-- La unicidad es (cuenta de canal, usuario del canal), no (canal, usuario): el
-- mismo numero de WhatsApp puede escribir a dos empresas distintas del SaaS y
-- cada una debe tener su propio contacto. La restriccion global de la
-- especificacion original habria fusionado contactos de tenants distintos.
-- -----------------------------------------------------------------------------

create table public.channel_identities (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  contact_id         uuid not null references public.contacts(id) on delete cascade,
  channel_account_id uuid not null references public.channel_accounts(id) on delete cascade,
  channel            public.channel_type not null,
  channel_user_id    varchar(255) not null,
  display_name       varchar(150),
  profile            jsonb not null default '{}'::jsonb,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  unique (channel_account_id, channel_user_id)
);

create index channel_identities_contact_idx on public.channel_identities (contact_id);
create index channel_identities_tenant_idx  on public.channel_identities (tenant_id, channel);

-- -----------------------------------------------------------------------------
-- Grupos y segmentos
-- -----------------------------------------------------------------------------
-- system_key identifica los grupos que el motor necesita encontrar por codigo
-- (leads nuevos, atencion humana). El nombre visible se puede traducir o cambiar
-- sin romper la logica.
-- -----------------------------------------------------------------------------

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        varchar(100) not null,
  system_key  varchar(50),
  description text,
  color       varchar(7) not null default '#6366F1'
              check (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

create unique index groups_tenant_system_key_idx
  on public.groups (tenant_id, system_key) where system_key is not null;

create table public.contact_groups (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  group_id   uuid not null references public.groups(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  entered_at timestamptz not null default now(),
  entered_by uuid references auth.users(id) on delete set null,
  primary key (contact_id, group_id)
);

create index contact_groups_group_idx on public.contact_groups (group_id);

-- -----------------------------------------------------------------------------
-- Conversaciones
-- -----------------------------------------------------------------------------
-- handling_mode reemplaza al booleano bot_enabled del contacto: el control
-- humano se toma sobre un hilo concreto, no sobre la persona en todos sus
-- canales a la vez.
--
-- service_window_expires_at existe porque WhatsApp solo permite mensajes libres
-- durante 24 horas desde el ultimo mensaje del cliente; pasada esa ventana hay
-- que usar plantilla. Sin este dato el envio falla en produccion sin explicacion.
-- -----------------------------------------------------------------------------

create table public.conversations (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  contact_id                uuid not null references public.contacts(id) on delete cascade,
  channel_identity_id       uuid not null references public.channel_identities(id) on delete cascade,
  channel_account_id        uuid not null references public.channel_accounts(id) on delete cascade,
  channel                   public.channel_type not null,
  status                    public.conversation_status not null default 'open',
  handling_mode             public.handling_mode not null default 'bot',
  assigned_operator_id      uuid references auth.users(id) on delete set null,
  taken_over_at             timestamptz,
  subject                   varchar(200),
  unread_count              integer not null default 0 check (unread_count >= 0),
  last_message_at           timestamptz,
  last_message_preview      text,
  last_inbound_at           timestamptz,
  service_window_expires_at timestamptz,
  resolved_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Un solo hilo abierto por identidad de canal.
create unique index conversations_open_identity_idx
  on public.conversations (channel_identity_id) where status <> 'resolved';

create index conversations_inbox_idx
  on public.conversations (tenant_id, status, last_message_at desc);
create index conversations_assigned_idx
  on public.conversations (tenant_id, assigned_operator_id, status)
  where assigned_operator_id is not null;
create index conversations_contact_idx on public.conversations (contact_id);

create trigger conversations_touch
  before update on public.conversations
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Mensajes
-- -----------------------------------------------------------------------------

create table public.messages (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  conversation_id    uuid not null references public.conversations(id) on delete cascade,
  contact_id         uuid not null references public.contacts(id) on delete cascade,
  channel_account_id uuid not null references public.channel_accounts(id) on delete cascade,
  channel            public.channel_type not null,
  direction          public.message_direction not null,
  sender_type        public.sender_role not null,
  sender_user_id     uuid references auth.users(id) on delete set null,
  content            text,
  media_type         public.media_type not null default 'text',
  media_url          text,
  media_mime_type    varchar(100),
  media_external_id  varchar(255),
  payload            jsonb not null default '{}'::jsonb,
  channel_message_id varchar(255),
  reply_to_id        uuid references public.messages(id) on delete set null,
  delivery_status    public.delivery_status not null default 'pending',
  error_text         text,
  sent_at            timestamptz,
  created_at         timestamptz not null default now(),

  -- Un mensaje sin texto tiene que traer contenido de otro tipo.
  constraint messages_has_content check (
    content is not null or media_url is not null or media_external_id is not null
      or media_type in ('location','contact_card','sticker','template','interactive','unsupported')
  ),
  -- Solo un operador humano tiene usuario asociado.
  constraint messages_operator_has_user check (
    (sender_type = 'operator') = (sender_user_id is not null)
  )
);

-- Idempotencia real: Meta reintenta el mismo webhook varias veces. Sin este
-- indice, cada reintento duplicaba el mensaje y volvia a disparar al bot.
create unique index messages_channel_dedupe_idx
  on public.messages (channel_account_id, channel_message_id)
  where channel_message_id is not null;

create index messages_thread_idx on public.messages (conversation_id, created_at desc);
create index messages_tenant_idx on public.messages (tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Mantener el estado de la conversacion desde la base, no desde el cliente
-- -----------------------------------------------------------------------------

create or replace function app.sync_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.conversations c
  set
    last_message_at      = greatest(coalesce(c.last_message_at, new.created_at), new.created_at),
    last_message_preview = left(coalesce(new.content, '[' || new.media_type::text || ']'), 200),
    last_inbound_at      = case when new.direction = 'inbound'
                                then greatest(coalesce(c.last_inbound_at, new.created_at), new.created_at)
                                else c.last_inbound_at end,
    -- La ventana de servicio de 24 h se reinicia con cada mensaje del cliente.
    service_window_expires_at = case when new.direction = 'inbound'
                                     then new.created_at + interval '24 hours'
                                     else c.service_window_expires_at end,
    unread_count         = case when new.direction = 'inbound'
                                then c.unread_count + 1
                                else c.unread_count end,
    -- Un mensaje nuevo reabre un hilo que se habia dado por resuelto.
    status               = case when c.status = 'resolved' and new.direction = 'inbound'
                                then 'open'::public.conversation_status
                                else c.status end,
    resolved_at          = case when c.status = 'resolved' and new.direction = 'inbound'
                                then null else c.resolved_at end
  where c.id = new.conversation_id;

  update public.channel_identities ci
  set last_seen_at = new.created_at
  where ci.id = (select channel_identity_id from public.conversations where id = new.conversation_id)
    and ci.last_seen_at < new.created_at;

  return new;
end;
$$;

create trigger messages_sync_conversation
  after insert on public.messages
  for each row execute function app.sync_conversation_on_message();
