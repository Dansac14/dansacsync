-- =============================================================================
-- 0004 · Colas de entrada y salida
-- =============================================================================
-- El webhook no procesa nada: escribe el evento crudo y responde 200 en
-- milisegundos, que es lo que Meta exige para no reintentar ni degradar la
-- suscripcion. El trabajo real lo hace el worker leyendo estas tablas.
--
-- La cola vive en Postgres, no en Redis. Motivos concretos:
--   · el encolado ocurre en la misma transaccion que la deduplicacion, asi que
--     no existe la ventana en la que el evento se acepta pero se pierde;
--   · sobrevive a un reinicio sin configuracion extra ni una segunda infra;
--   · FOR UPDATE SKIP LOCKED da concurrencia real entre varios workers.
-- =============================================================================

create table public.inbound_events (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid references public.tenants(id) on delete cascade,
  channel_account_id uuid references public.channel_accounts(id) on delete cascade,
  channel            public.channel_type,

  -- Clave de deduplicacion. Para Meta es el id de mensaje; cuando el evento no
  -- trae id (estados de entrega, por ejemplo) se compone con el hash del cuerpo.
  dedupe_key         text not null,

  payload            jsonb not null,
  signature_verified boolean not null default false,
  received_at        timestamptz not null default now(),

  status             public.job_status not null default 'queued',
  attempts           integer not null default 0,
  max_attempts       integer not null default 5,
  available_at       timestamptz not null default now(),
  locked_at          timestamptz,
  locked_by          text,
  last_error         text,
  processed_at       timestamptz,

  unique (dedupe_key)
);

-- El indice que usa el worker para tomar trabajo: solo filas pendientes.
create index inbound_events_claim_idx
  on public.inbound_events (available_at, id)
  where status in ('queued', 'failed');

create index inbound_events_tenant_idx on public.inbound_events (tenant_id, received_at desc);

-- Eventos que llegaron con firma valida pero cuya cuenta de canal no esta dada
-- de alta: se conservan para poder diagnosticar una conexion mal configurada en
-- lugar de descartarlos en silencio.
create index inbound_events_unresolved_idx
  on public.inbound_events (received_at desc) where tenant_id is null;

-- -----------------------------------------------------------------------------
-- Cola de salida
-- -----------------------------------------------------------------------------
-- Todo envio pasa por aqui. Asi un fallo de la API de Meta se reintenta con
-- backoff en vez de perderse, y el operador ve en la bandeja que su mensaje
-- quedo pendiente en lugar de creer que se entrego.
-- -----------------------------------------------------------------------------

create table public.outbound_jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  message_id      uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,

  status          public.job_status not null default 'queued',
  attempts        integer not null default 0,
  max_attempts    integer not null default 5,
  available_at    timestamptz not null default now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),

  unique (message_id)
);

create index outbound_jobs_claim_idx
  on public.outbound_jobs (available_at, id)
  where status in ('queued', 'failed');

-- -----------------------------------------------------------------------------
-- Registro de ejecuciones de IA
-- -----------------------------------------------------------------------------
-- Sin esto no hay forma de responder por que el bot contesto lo que contesto,
-- ni de medir cuanto cuesta cada tenant.
-- -----------------------------------------------------------------------------

create table public.ai_runs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  conversation_id    uuid not null references public.conversations(id) on delete cascade,
  inbound_message_id uuid references public.messages(id) on delete set null,
  outbound_message_id uuid references public.messages(id) on delete set null,

  user_text          text not null,
  model              varchar(80) not null,
  embedding_model    varchar(80),
  retrieved_chunks   jsonb not null default '[]'::jsonb,  -- ids y similitud de cada fragmento usado
  top_similarity     numeric(5,4),
  answer_text        text,
  escalated          boolean not null default false,
  escalation_reason  varchar(60),
  prompt_tokens      integer,
  completion_tokens  integer,
  latency_ms         integer,
  error_text         text,
  created_at         timestamptz not null default now()
);

create index ai_runs_tenant_idx       on public.ai_runs (tenant_id, created_at desc);
create index ai_runs_conversation_idx on public.ai_runs (conversation_id, created_at desc);
