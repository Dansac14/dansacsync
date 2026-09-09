-- =============================================================================
-- 0001 · Extensiones, esquemas auxiliares y tipos enumerados
-- =============================================================================
-- Este archivo no crea tablas. Establece el vocabulario del dominio (los tipos)
-- y las extensiones de las que depende todo lo demas.
-- =============================================================================

-- En Supabase el esquema `extensions` ya existe; se crea aqui para que estas
-- mismas migraciones corran tal cual en un Postgres limpio.
create schema if not exists extensions;

-- Y con USAGE para los roles. En Supabase viene concedido; en un Postgres
-- limpio no, y sin esto el tipo `vector` y el operador `<=>` quedan
-- inaccesibles para el worker: la busqueda semantica falla con "permission
-- denied for schema extensions" solo en produccion, no al aplicar migraciones.
grant usage on schema extensions to anon, authenticated, service_role;

create extension if not exists "pgcrypto"  with schema extensions;
create extension if not exists "vector"    with schema extensions;
create extension if not exists "pg_trgm"   with schema extensions;
create extension if not exists "btree_gin" with schema extensions;

-- Esquema para funciones internas de autorizacion. Se mantiene fuera de `public`
-- para que no quede expuesto por PostgREST.
create schema if not exists app;
revoke all on schema app from public, anon, authenticated;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tipos del dominio
-- -----------------------------------------------------------------------------

do $$ begin
  create type public.channel_type as enum ('whatsapp', 'instagram', 'facebook', 'tiktok');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.tenant_role as enum ('owner', 'admin', 'operator', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.member_status as enum ('invited', 'active', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sender_role as enum ('contact', 'bot', 'operator', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.message_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.media_type as enum ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact_card', 'template', 'interactive', 'unsupported');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.delivery_status as enum ('pending', 'sent', 'delivered', 'read', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.conversation_status as enum ('open', 'pending', 'resolved');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.handling_mode as enum ('bot', 'human');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.job_status as enum ('queued', 'processing', 'done', 'failed', 'dead');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.document_status as enum ('pending', 'processing', 'indexed', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum ('draft', 'pending_payment', 'paid', 'fulfilled', 'cancelled', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.invoice_kind as enum ('boleta', 'factura', 'nota_credito', 'nota_debito', 'recibo_honorarios');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.invoice_state as enum ('draft', 'issued', 'accepted', 'rejected', 'voided');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Utilidad compartida: mantener updated_at sin depender del cliente
-- -----------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
