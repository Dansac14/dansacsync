-- =============================================================================
-- 0008 · Configuracion de la empresa, comportamiento del agente y auditoria
-- =============================================================================
-- Todo lo que en la especificacion original estaba fijo en el codigo del prompt
-- (nombre del bot, tono, palabras que disparan el escalado, umbral de similitud)
-- vive aqui, por tenant y editable desde la interfaz.
-- =============================================================================

create table public.company_settings (
  tenant_id                uuid primary key references public.tenants(id) on delete cascade,

  -- Identidad de la empresa
  company_name             varchar(150) not null,
  trade_name               varchar(150),
  logo_url                 text,
  primary_color            varchar(7) not null default '#4F46E5'
                           check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  default_language         varchar(5)  not null default 'es',
  default_currency         char(3)     not null default 'PEN',
  timezone                 varchar(64) not null default 'America/Lima',
  support_phone            varchar(30),
  support_email            varchar(190),

  -- Datos tributarios
  tax_id_number            varchar(20) not null,
  legal_address            text not null,
  invoice_series_default   varchar(10) not null default 'F001',
  receipt_series_default   varchar(10) not null default 'B001',
  tax_rate_default         numeric(5,4) not null default 0.1800,

  -- Comportamiento del agente
  ai_enabled               boolean not null default true,
  ai_bot_name              varchar(60)  not null default 'Asistente Virtual',
  ai_tone                  varchar(30)  not null default 'friendly',
  ai_model                 varchar(80)  not null default 'gpt-4o-mini',
  ai_embedding_model       varchar(80)  not null default 'text-embedding-3-small',
  ai_temperature           numeric(3,2) not null default 0.20
                           check (ai_temperature >= 0 and ai_temperature <= 2),
  ai_max_output_tokens     integer      not null default 500,
  ai_persona_instructions  text,
  ai_min_similarity        double precision not null default 0.35
                           check (ai_min_similarity > 0 and ai_min_similarity < 1),
  ai_match_count           integer not null default 5 check (ai_match_count between 1 and 20),

  -- Escalado a humano. Se guarda como lista para poder ajustarla por idioma y
  -- por negocio sin volver a desplegar.
  escalation_keywords      text[] not null default array[
                             'humano','operador','asesor','persona real',
                             'hablar con alguien','atencion personalizada',
                             'reclamo','queja','descuento','cuotas','financiamiento'
                           ],
  escalation_on_no_context boolean not null default true,

  -- Texto que ve el cliente cuando la conversacion pasa a un humano. Esta en la
  -- base y no en el codigo porque es mensaje de marca: cada empresa lo escribe
  -- a su manera y en su idioma, y lo cambia sin esperar un despliegue.
  escalation_message       text not null default
    'Con gusto te paso con una persona del equipo para que continue contigo por aqui.',
  no_context_message       text not null default
    'Para darte el dato exacto voy a pasarte con una persona del equipo.',
  ai_unavailable_message   text not null default
    'En un momento te responde una persona del equipo.',

  business_hours           jsonb not null default '{}'::jsonb,
  out_of_hours_message     text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger company_settings_touch
  before update on public.company_settings
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Respuestas rapidas del operador
-- -----------------------------------------------------------------------------

create table public.quick_replies (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  shortcut   varchar(40) not null,
  title      varchar(120) not null,
  body       text not null,
  language   varchar(5) not null default 'es',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, shortcut)
);

-- -----------------------------------------------------------------------------
-- Auditoria
-- -----------------------------------------------------------------------------
-- Bitacora de acciones sensibles: toma de control, cambio de configuracion,
-- emision o anulacion de comprobantes, conexion de un canal.
-- -----------------------------------------------------------------------------

create table public.audit_log (
  id           bigserial primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  actor_label  varchar(150),
  action       varchar(80) not null,
  entity_type  varchar(60) not null,
  entity_id    text,
  before_state jsonb,
  after_state  jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_tenant_idx on public.audit_log (tenant_id, created_at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);

-- -----------------------------------------------------------------------------
-- La toma de control humano se audita sola
-- -----------------------------------------------------------------------------

create or replace function app.log_conversation_takeover()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.handling_mode is distinct from old.handling_mode then
    insert into public.audit_log (tenant_id, actor_id, action, entity_type, entity_id, before_state, after_state)
    values (
      new.tenant_id,
      auth.uid(),
      case when new.handling_mode = 'human' then 'conversation.takeover' else 'conversation.release' end,
      'conversation',
      new.id::text,
      jsonb_build_object('handling_mode', old.handling_mode, 'assigned_operator_id', old.assigned_operator_id),
      jsonb_build_object('handling_mode', new.handling_mode, 'assigned_operator_id', new.assigned_operator_id)
    );
  end if;
  return new;
end;
$$;

create trigger conversations_log_takeover
  after update of handling_mode on public.conversations
  for each row execute function app.log_conversation_takeover();
