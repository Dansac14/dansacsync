-- =============================================================================
-- 0011 · Aprovisionamiento de un tenant y publicacion en tiempo real
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Alta de una empresa
-- -----------------------------------------------------------------------------
-- Crear un tenant a mano en cinco tablas distintas es como se generan las
-- empresas a medio configurar. Esta funcion deja todo listo o no deja nada:
-- tenant, propietario, configuracion, grupos del sistema y series de numeracion.
-- -----------------------------------------------------------------------------

create or replace function public.provision_tenant(
  p_business_name  varchar,
  p_slug           varchar,
  p_owner_user_id  uuid,
  p_tax_id_number  varchar,
  p_legal_address  text,
  p_currency       char default 'PEN',
  p_language       varchar default 'es',
  p_timezone       varchar default 'America/Lima'
)
returns public.tenants
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant public.tenants;
begin
  insert into public.tenants (business_name, slug)
  values (p_business_name, lower(p_slug))
  returning * into v_tenant;

  insert into public.tenant_members (tenant_id, user_id, role, status)
  values (v_tenant.id, p_owner_user_id, 'owner', 'active');

  insert into public.company_settings (
    tenant_id, company_name, tax_id_number, legal_address,
    default_currency, default_language, timezone
  )
  values (
    v_tenant.id, p_business_name, p_tax_id_number, p_legal_address,
    p_currency, p_language, p_timezone
  );

  -- Grupos que el motor busca por system_key. El nombre visible se puede
  -- renombrar o traducir; la clave no cambia.
  insert into public.groups (tenant_id, name, system_key, description, color, is_system)
  values
    (v_tenant.id, 'Leads nuevos',   'new_leads',     'Contactos recien llegados sin calificar', '#3B82F6', true),
    (v_tenant.id, 'Atencion humana','human_support', 'Conversaciones tomadas por un operador',  '#F59E0B', true),
    (v_tenant.id, 'Lead calificado','qualified',     'Interesados con intencion de compra',     '#10B981', true),
    (v_tenant.id, 'Cliente',        'customer',      'Ya realizaron al menos una compra',       '#8B5CF6', true);

  -- Series de numeracion iniciales.
  insert into public.numbering_sequences (tenant_id, scope, series, next_value)
  values
    (v_tenant.id, 'order',    '-',    1),
    (v_tenant.id, 'boleta',   'B001', 1),
    (v_tenant.id, 'factura',  'F001', 1);

  return v_tenant;
end;
$$;

revoke all on function public.provision_tenant(varchar, varchar, uuid, varchar, text, char, varchar, varchar)
  from public, anon, authenticated;
grant execute on function public.provision_tenant(varchar, varchar, uuid, varchar, text, char, varchar, varchar)
  to service_role;

-- -----------------------------------------------------------------------------
-- Numero de orden automatico
-- -----------------------------------------------------------------------------

create or replace function app.assign_order_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.order_number is null then
    new.order_number := public.next_correlative(new.tenant_id, 'order', '-');
  end if;
  return new;
end;
$$;

-- El trigger BEFORE INSERT corre antes de que se verifique el NOT NULL, asi que
-- la columna puede seguir siendo obligatoria: nunca llega nula a la validacion.
create trigger orders_assign_number
  before insert on public.orders
  for each row execute function app.assign_order_number();

-- -----------------------------------------------------------------------------
-- Tiempo real para la bandeja
-- -----------------------------------------------------------------------------
-- El Inbox se suscribe a estas tablas. Realtime respeta la RLS, asi que un
-- operador solo recibe eventos de su propio tenant.
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.messages';
    execute 'alter publication supabase_realtime add table public.conversations';
  end if;
exception
  when duplicate_object then null;
end $$;

-- REPLICA IDENTITY FULL para que los eventos de UPDATE lleguen con la fila
-- anterior completa y el cliente pueda reconciliar sin volver a consultar.
alter table public.conversations replica identity full;
