-- =============================================================================
-- 0009 · Row Level Security
-- =============================================================================
-- Aqui es donde el multi-tenant deja de ser una convencion y pasa a ser una
-- garantia. Un error en una consulta del frontend, un filtro olvidado o una
-- clave anon filtrada no alcanzan para leer datos de otra empresa: Postgres
-- rechaza la fila antes de devolverla.
--
-- El worker y las Edge Functions usan la clave service_role, que tiene BYPASSRLS
-- por diseno; por eso ninguna tabla de cola necesita politicas de escritura.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Activar RLS en todas las tablas del esquema public, sin excepcion
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Privilegios base
-- -----------------------------------------------------------------------------
-- Sin GRANT no hay acceso ni con politica permisiva. `anon` no recibe nada: un
-- visitante sin sesion no tiene por que ver ninguna tabla de este sistema.
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;

-- -----------------------------------------------------------------------------
-- 3. Tenancy
-- -----------------------------------------------------------------------------

create policy tenants_select on public.tenants
  for select to authenticated
  using (app.is_member(id));

create policy tenants_update on public.tenants
  for update to authenticated
  using (app.is_admin(id)) with check (app.is_admin(id));

-- La creacion de tenants es un acto de aprovisionamiento del SaaS: pasa por el
-- backend con service_role, nunca desde el navegador.

create policy tenant_members_select on public.tenant_members
  for select to authenticated
  using (app.is_member(tenant_id));

create policy tenant_members_insert on public.tenant_members
  for insert to authenticated
  with check (app.is_admin(tenant_id));

create policy tenant_members_update on public.tenant_members
  for update to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

create policy tenant_members_delete on public.tenant_members
  for delete to authenticated
  using (app.is_admin(tenant_id));

-- -----------------------------------------------------------------------------
-- 4. Cuentas de canal · solo administradores
-- -----------------------------------------------------------------------------

create policy channel_accounts_select on public.channel_accounts
  for select to authenticated using (app.is_member(tenant_id));
create policy channel_accounts_insert on public.channel_accounts
  for insert to authenticated with check (app.is_admin(tenant_id));
create policy channel_accounts_update on public.channel_accounts
  for update to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));
create policy channel_accounts_delete on public.channel_accounts
  for delete to authenticated using (app.is_admin(tenant_id));

-- -----------------------------------------------------------------------------
-- 5. Contactos, identidades y conversaciones · trabajo diario del operador
-- -----------------------------------------------------------------------------

create policy contacts_select on public.contacts
  for select to authenticated using (app.is_member(tenant_id));
create policy contacts_insert on public.contacts
  for insert to authenticated with check (app.is_member(tenant_id));
create policy contacts_update on public.contacts
  for update to authenticated
  using (app.is_member(tenant_id)) with check (app.is_member(tenant_id));
create policy contacts_delete on public.contacts
  for delete to authenticated using (app.is_admin(tenant_id));

create policy channel_identities_select on public.channel_identities
  for select to authenticated using (app.is_member(tenant_id));
create policy channel_identities_insert on public.channel_identities
  for insert to authenticated with check (app.is_member(tenant_id));
create policy channel_identities_update on public.channel_identities
  for update to authenticated
  using (app.is_member(tenant_id)) with check (app.is_member(tenant_id));

create policy groups_select on public.groups
  for select to authenticated using (app.is_member(tenant_id));
create policy groups_insert on public.groups
  for insert to authenticated with check (app.is_member(tenant_id));
create policy groups_update on public.groups
  for update to authenticated
  using (app.is_member(tenant_id) and not is_system)
  with check (app.is_member(tenant_id));
create policy groups_delete on public.groups
  for delete to authenticated using (app.is_admin(tenant_id) and not is_system);

create policy contact_groups_select on public.contact_groups
  for select to authenticated using (app.is_member(tenant_id));
create policy contact_groups_insert on public.contact_groups
  for insert to authenticated with check (app.is_member(tenant_id));
create policy contact_groups_delete on public.contact_groups
  for delete to authenticated using (app.is_member(tenant_id));

create policy conversations_select on public.conversations
  for select to authenticated using (app.is_member(tenant_id));
create policy conversations_insert on public.conversations
  for insert to authenticated with check (app.is_member(tenant_id));
create policy conversations_update on public.conversations
  for update to authenticated
  using (app.is_member(tenant_id)) with check (app.is_member(tenant_id));

-- -----------------------------------------------------------------------------
-- 6. Mensajes
-- -----------------------------------------------------------------------------
-- El operador puede escribir, pero solo como el mismo: no puede insertar un
-- mensaje firmado por el bot ni por otro usuario. Los mensajes entrantes y las
-- respuestas del bot los escribe el worker con service_role.
-- Un mensaje enviado no se edita ni se borra: es el registro de lo que ocurrio.
-- -----------------------------------------------------------------------------

create policy messages_select on public.messages
  for select to authenticated using (app.is_member(tenant_id));

create policy messages_insert_as_operator on public.messages
  for insert to authenticated
  with check (
    app.is_member(tenant_id)
    and direction      = 'outbound'
    and sender_type    = 'operator'
    and sender_user_id = auth.uid()
  );

-- -----------------------------------------------------------------------------
-- 7. Colas y trazas · lectura para diagnostico, escritura solo del backend
-- -----------------------------------------------------------------------------

create policy inbound_events_select on public.inbound_events
  for select to authenticated
  using (tenant_id is not null and app.is_admin(tenant_id));

create policy outbound_jobs_select on public.outbound_jobs
  for select to authenticated using (app.is_member(tenant_id));

create policy ai_runs_select on public.ai_runs
  for select to authenticated using (app.is_member(tenant_id));

-- -----------------------------------------------------------------------------
-- 8. Base de conocimiento
-- -----------------------------------------------------------------------------

create policy knowledge_documents_select on public.knowledge_documents
  for select to authenticated using (app.is_member(tenant_id));
create policy knowledge_documents_insert on public.knowledge_documents
  for insert to authenticated with check (app.is_admin(tenant_id));
create policy knowledge_documents_update on public.knowledge_documents
  for update to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));
create policy knowledge_documents_delete on public.knowledge_documents
  for delete to authenticated using (app.is_admin(tenant_id));

create policy knowledge_chunks_select on public.knowledge_chunks
  for select to authenticated using (app.is_member(tenant_id));
create policy knowledge_chunks_delete on public.knowledge_chunks
  for delete to authenticated using (app.is_admin(tenant_id));

-- -----------------------------------------------------------------------------
-- 9. Catalogo y comercio
-- -----------------------------------------------------------------------------

create policy catalog_categories_select on public.catalog_categories
  for select to authenticated using (app.is_member(tenant_id));
create policy catalog_categories_write on public.catalog_categories
  for all to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

create policy products_select on public.products
  for select to authenticated using (app.is_member(tenant_id));
create policy products_write on public.products
  for all to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

create policy orders_select on public.orders
  for select to authenticated using (app.is_member(tenant_id));
create policy orders_insert on public.orders
  for insert to authenticated with check (app.is_member(tenant_id));
create policy orders_update on public.orders
  for update to authenticated
  using (app.is_member(tenant_id)) with check (app.is_member(tenant_id));
create policy orders_delete on public.orders
  for delete to authenticated
  using (app.is_admin(tenant_id) and status = 'draft');

create policy order_items_select on public.order_items
  for select to authenticated using (app.is_member(tenant_id));
create policy order_items_write on public.order_items
  for all to authenticated
  using (app.is_member(tenant_id)) with check (app.is_member(tenant_id));

create policy numbering_sequences_select on public.numbering_sequences
  for select to authenticated using (app.is_admin(tenant_id));

-- -----------------------------------------------------------------------------
-- 10. Documentos fiscales
-- -----------------------------------------------------------------------------
-- Un comprobante emitido no se modifica ni se elimina. Para dejarlo sin efecto
-- se emite una nota de credito o se marca como anulado, y ambas cosas dejan
-- rastro. Por eso no hay politica de DELETE.
-- -----------------------------------------------------------------------------

create policy sales_invoices_select on public.sales_invoices
  for select to authenticated using (app.is_member(tenant_id));
create policy sales_invoices_insert on public.sales_invoices
  for insert to authenticated with check (app.is_member(tenant_id));
create policy sales_invoices_update on public.sales_invoices
  for update to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

create policy sales_invoice_items_select on public.sales_invoice_items
  for select to authenticated using (app.is_member(tenant_id));
create policy sales_invoice_items_insert on public.sales_invoice_items
  for insert to authenticated with check (app.is_member(tenant_id));

create policy expenses_select on public.purchases_and_expenses
  for select to authenticated using (app.is_member(tenant_id));
create policy expenses_write on public.purchases_and_expenses
  for all to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

-- -----------------------------------------------------------------------------
-- 11. Configuracion, respuestas rapidas y auditoria
-- -----------------------------------------------------------------------------

create policy company_settings_select on public.company_settings
  for select to authenticated using (app.is_member(tenant_id));
create policy company_settings_insert on public.company_settings
  for insert to authenticated with check (app.is_admin(tenant_id));
create policy company_settings_update on public.company_settings
  for update to authenticated
  using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

create policy quick_replies_select on public.quick_replies
  for select to authenticated using (app.is_member(tenant_id));
create policy quick_replies_write on public.quick_replies
  for all to authenticated
  using (app.is_member(tenant_id)) with check (app.is_member(tenant_id));

create policy audit_log_select on public.audit_log
  for select to authenticated using (app.is_admin(tenant_id));

-- La bitacora solo admite altas del propio usuario: nadie puede escribir una
-- entrada a nombre de otro, y nadie puede borrar ni editar lo ya registrado.
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (app.is_member(tenant_id) and actor_id = auth.uid());
