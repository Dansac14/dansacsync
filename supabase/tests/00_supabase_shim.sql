-- =============================================================================
-- Compatibilidad con Supabase para probar en un Postgres limpio
-- =============================================================================
-- Este archivo NO forma parte de las migraciones y no debe aplicarse en
-- Supabase: alli estos roles, el esquema auth y auth.uid() ya existen.
-- Sirve para poder ejecutar y verificar todo el esquema localmente.
-- =============================================================================

-- Los roles son globales al cluster, no de la base: se crean solo si faltan
-- para poder recrear la base de pruebas cuantas veces haga falta.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- En Supabase, auth.uid() lee el claim `sub` del JWT que PostgREST inyecta en
-- request.jwt.claims. La reproducimos con la misma semantica para poder simular
-- distintos usuarios en las pruebas de RLS.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
