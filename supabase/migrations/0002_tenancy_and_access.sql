-- =============================================================================
-- 0002 · Tenancy, membresias y cuentas de canal
-- =============================================================================
-- La unidad de aislamiento es el tenant. Toda tabla del sistema lleva tenant_id
-- y ninguna consulta de la aplicacion puede cruzar ese limite: lo impide la RLS,
-- no el codigo de la aplicacion.
--
-- `channel_accounts` es la pieza que faltaba en la especificacion original: sin
-- ella un webhook entrante no tiene forma de saber a que empresa pertenece.
-- =============================================================================

create table public.tenants (
  id              uuid primary key default gen_random_uuid(),
  business_name   varchar(150) not null,
  slug            varchar(63)  not null unique
                  check (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  plan_tier       varchar(50)  not null default 'trial',
  is_active       boolean      not null default true,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now()
);

create trigger tenants_touch
  before update on public.tenants
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Membresias: quien puede ver que tenant, y con que rol
-- -----------------------------------------------------------------------------

create table public.tenant_members (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         public.tenant_role   not null default 'operator',
  status       public.member_status not null default 'active',
  display_name varchar(120),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index tenant_members_user_idx on public.tenant_members (user_id) where status = 'active';

create trigger tenant_members_touch
  before update on public.tenant_members
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Funciones de autorizacion
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER a proposito: si estas funciones leyeran tenant_members bajo
-- RLS, la politica de tenant_members se llamaria a si misma y Postgres abortaria
-- por recursion infinita.
-- -----------------------------------------------------------------------------

create or replace function app.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tm.tenant_id
  from public.tenant_members tm
  where tm.user_id = auth.uid()
    and tm.status  = 'active';
$$;

create or replace function app.is_member(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = p_tenant
      and tm.user_id   = auth.uid()
      and tm.status    = 'active'
  );
$$;

create or replace function app.has_role(p_tenant uuid, p_roles public.tenant_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = p_tenant
      and tm.user_id   = auth.uid()
      and tm.status    = 'active'
      and tm.role      = any(p_roles)
  );
$$;

-- Atajo legible para las politicas de escritura administrativa.
create or replace function app.is_admin(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.has_role(p_tenant, array['owner','admin']::public.tenant_role[]);
$$;

grant execute on function app.current_tenant_ids(), app.is_member(uuid),
                          app.has_role(uuid, public.tenant_role[]), app.is_admin(uuid)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Cuentas de canal: la llave que traduce un webhook entrante a un tenant
-- -----------------------------------------------------------------------------
-- external_account_id es lo que Meta o TikTok envian dentro del payload:
--   whatsapp  -> metadata.phone_number_id
--   facebook  -> entry[].id (page id)
--   instagram -> entry[].id (instagram business account id)
--   tiktok    -> el business/app id que acompania el evento
--
-- Los secretos NO viven en esta tabla. Se guardan en Supabase Vault y aqui solo
-- queda el nombre con el que recuperarlos, para que ni un error de RLS ni un
-- volcado de la tabla expongan un token de produccion.
-- -----------------------------------------------------------------------------

create table public.channel_accounts (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  channel                  public.channel_type not null,
  external_account_id      varchar(255) not null,
  display_name             varchar(150) not null,

  -- Identificadores publicos, no secretos
  business_account_id      varchar(255),
  phone_number             varchar(30),
  page_id                  varchar(255),

  -- Host y version de la API. Instagram tiene dos rutas de integracion y no son
  -- intercambiables: con Instagram Login se llama a graph.instagram.com con un
  -- token de usuario de Instagram, y con Facebook Login a graph.facebook.com
  -- con un token de pagina. Se guarda por cuenta porque en un SaaS convivan
  -- clientes conectados de las dos formas.
  api_base_url             varchar(120) not null default 'https://graph.facebook.com',
  api_version              varchar(10)  not null default 'v25.0',

  -- Referencias a Supabase Vault (nunca el valor en claro)
  access_token_secret_name  text,
  app_secret_secret_name    text,
  verify_token_secret_name  text,

  is_active                boolean not null default true,
  connected_at             timestamptz,
  last_event_at            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Esta es la restriccion que hace posible la resolucion de tenant y garantiza
  -- que un mismo numero o pagina no pueda pertenecer a dos empresas a la vez.
  unique (channel, external_account_id)
);

create index channel_accounts_tenant_idx on public.channel_accounts (tenant_id, channel) where is_active;

create trigger channel_accounts_touch
  before update on public.channel_accounts
  for each row execute function app.touch_updated_at();
