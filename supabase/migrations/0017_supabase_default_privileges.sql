-- =============================================================================
-- 0017 · Los privilegios por defecto de Supabase
-- =============================================================================
-- La migracion 0016 quito el EXECUTE que PostgreSQL concede a PUBLIC en toda
-- funcion nueva. Eso basta en un PostgreSQL normal, y por eso las pruebas
-- pasaban: en un servidor limpio, tras 0016, `anon` no podia ejecutar nada
-- salvo order_public_view.
--
-- Un proyecto de Supabase no es un PostgreSQL limpio. Trae configurado
--
--     alter default privileges in schema public
--       grant all on functions to anon, authenticated, service_role;
--
-- de modo que cada funcion nace con concesiones NOMINALES a esos tres roles,
-- ademas de la de PUBLIC. Revocar de PUBLIC no toca una concesion nominal:
-- son entradas distintas de la ACL. Comprobado en el proyecto real, `anon`
-- podia ejecutar search_knowledge, financial_summary, mark_conversation_read,
-- set_handling_mode y send_operator_message.
--
-- `anon` es la clave que viaja dentro del JavaScript del navegador. Con
-- send_operator_message accesible, cualquiera podia escribirle a los clientes
-- de cualquier empresa haciendose pasar por ella.
--
-- Esta migracion revoca por nombre y vuelve a conceder solo lo necesario. Es
-- idempotente: se puede aplicar las veces que haga falta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tabla rasa sobre funciones
-- -----------------------------------------------------------------------------
-- Se revoca de PUBLIC, de anon y de authenticated a la vez. Lo que cada rol
-- necesita se devuelve abajo, explicitamente y con la firma completa.
-- -----------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as firma
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
      and p.prokind in ('f', 'p')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.firma);
  end loop;
end $$;

-- El backend corre en un servidor con la clave de servicio: puede ejecutar todo.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as firma
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
      and p.prokind in ('f', 'p')
  loop
    execute format('grant execute on function %s to service_role', r.firma);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Lo que la interfaz del operador necesita
-- -----------------------------------------------------------------------------

grant execute on function
  public.search_knowledge(uuid, extensions.vector, integer, double precision),
  public.financial_summary(uuid, date, date),
  public.mark_conversation_read(uuid),
  public.set_handling_mode(uuid, public.handling_mode),
  public.send_operator_message(uuid, text, public.media_type, text),
  public.enqueue_product_message(uuid, uuid),
  public.mark_order_paid(uuid, varchar, varchar),
  public.next_correlative(uuid, varchar, varchar),
  public.issue_invoice_for_order(uuid, public.invoice_kind, varchar, varchar, varchar, text),
  public.issue_invoice(uuid, public.invoice_kind, varchar, varchar, varchar, numeric, numeric, char, uuid, uuid)
  to authenticated;

-- Las de `app` sostienen las politicas de RLS. Una politica se evalua con los
-- privilegios de quien consulta, asi que sin EXECUTE aqui no se puede leer nada.

grant execute on function
  app.current_tenant_ids(),
  app.is_member(uuid),
  app.has_role(uuid, public.tenant_role[]),
  app.is_admin(uuid),
  app.assert_tenant_access(uuid),
  app.can_write(uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Lo unico que `anon` puede ejecutar
-- -----------------------------------------------------------------------------
-- La pagina publica de la orden. Su autorizacion es el token del enlace, no la
-- sesion: por eso es la excepcion, y por eso es la unica.
-- -----------------------------------------------------------------------------

grant execute on function public.order_public_view(text) to anon;

-- -----------------------------------------------------------------------------
-- 4. Tablas y secuencias: `anon` no toca ninguna
-- -----------------------------------------------------------------------------
-- La RLS ya lo bloquea, porque todas las politicas son `to authenticated` y una
-- tabla con RLS y sin politica aplicable devuelve cero filas. Aun asi se revoca:
-- si algun dia una politica se escribe mal, el GRANT es la segunda puerta.
-- -----------------------------------------------------------------------------

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- -----------------------------------------------------------------------------
-- 5. Que lo que se cree en el futuro no vuelva a nacer abierto
-- -----------------------------------------------------------------------------

alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app
  revoke execute on functions from public, anon, authenticated;

alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
