-- =============================================================================
-- Verificacion de los privilegios por defecto de Supabase
-- =============================================================================
-- Estas pruebas existen porque las anteriores no bastaron. Se ejecutaban en un
-- PostgreSQL limpio, donde la migracion 0016 dejaba a `anon` sin nada; en el
-- proyecto real de Supabase, `anon` seguia pudiendo ejecutar cinco funciones,
-- entre ellas send_operator_message.
--
-- La diferencia esta en que Supabase configura
--     alter default privileges in schema public
--       grant all on functions to anon, authenticated, service_role;
-- de modo que cada funcion nace con concesiones nominales para esos roles.
-- Revocar de PUBLIC no las quita: son entradas distintas de la ACL.
--
-- Para que esto se detecte aqui y no en produccion, el arranque de estas
-- pruebas reproduce esa configuracion antes de comprobar nada.
--
-- Se ejecuta despues de 01, 02, 03 y 04.
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- PRUEBA 38 · `anon` solo puede ejecutar la vista publica de la orden
-- -----------------------------------------------------------------------------
-- `anon` es la clave que va escrita dentro del JavaScript que sirve el
-- navegador: es publica por diseno. Cualquier funcion que aparezca en esta
-- lista es ejecutable por cualquiera que abra el inspector.
-- -----------------------------------------------------------------------------

do $$
declare
  v_sobran text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by 1)
  into v_sobran
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app')
    and p.prokind in ('f', 'p')
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.proname <> 'order_public_view';

  if v_sobran is not null then
    raise exception 'FALLO 38: anon puede ejecutar funciones que no le corresponden: %', v_sobran;
  end if;

  if not has_function_privilege('anon', 'public.order_public_view(text)', 'EXECUTE') then
    raise exception 'FALLO 38b: anon no puede ejecutar order_public_view, la pagina publica de la orden quedaria rota';
  end if;

  raise notice 'OK 38 · anon ejecuta unicamente order_public_view';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 39 · `authenticated` no alcanza la maquinaria interna
-- -----------------------------------------------------------------------------
-- Un operador con sesion valida es un usuario de una empresa, no del sistema.
-- get_channel_secret es el caso grave: devuelve el token de WhatsApp guardado
-- en Vault, y con el se puede escribir a los clientes de cualquier empresa.
-- -----------------------------------------------------------------------------

do $$
declare
  v_interna text;
  v_firma   text;
begin
  foreach v_firma in array array[
    'public.get_channel_secret(uuid, text)',
    'public.provision_tenant(varchar, varchar, uuid, varchar, text, char, varchar, varchar)',
    'public.resolve_channel_account(public.channel_type, text)',
    'public.enqueue_inbound_event(text, jsonb, public.channel_type, uuid, uuid, boolean)',
    'public.claim_inbound_events(text, integer)',
    'public.claim_outbound_jobs(text, integer)',
    'public.requeue_stale_jobs(interval)'
  ]
  loop
    -- to_regprocedure devuelve nulo si la funcion no existe con esa firma: eso
    -- tambien es un fallo, porque significaria que la prueba dejo de vigilar.
    if to_regprocedure(v_firma) is null then
      raise exception 'FALLO 39: la funcion % no existe; la prueba dejaria de comprobar nada', v_firma;
    end if;

    if has_function_privilege('authenticated', v_firma, 'EXECUTE') then
      v_interna := coalesce(v_interna || ', ', '') || v_firma;
    end if;
  end loop;

  if v_interna is not null then
    raise exception 'FALLO 39b: authenticated alcanza funciones internas del backend: %', v_interna;
  end if;

  raise notice 'OK 39 · authenticated no alcanza la maquinaria interna del backend';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 40 · `authenticated` si conserva lo que el Inbox necesita
-- -----------------------------------------------------------------------------
-- El riesgo simetrico de revocar de mas: si esto se rompe, la bandeja deja de
-- funcionar. Las de `app` sostienen las politicas de RLS, que se evaluan con
-- los privilegios de quien consulta.
-- -----------------------------------------------------------------------------

do $$
declare
  v_falta text;
  v_firma text;
begin
  foreach v_firma in array array[
    'app.current_tenant_ids()',
    'app.is_member(uuid)',
    'app.is_admin(uuid)',
    'app.can_write(uuid)',
    'public.mark_conversation_read(uuid)',
    'public.set_handling_mode(uuid, public.handling_mode)',
    'public.send_operator_message(uuid, text, public.media_type, text)',
    'public.financial_summary(uuid, date, date)',
    'public.mark_order_paid(uuid, varchar, varchar)'
  ]
  loop
    if to_regprocedure(v_firma) is null then
      raise exception 'FALLO 40: la funcion % no existe', v_firma;
    end if;

    if not has_function_privilege('authenticated', v_firma, 'EXECUTE') then
      v_falta := coalesce(v_falta || ', ', '') || v_firma;
    end if;
  end loop;

  if v_falta is not null then
    raise exception 'FALLO 40b: authenticated perdio funciones que el Inbox necesita: %', v_falta;
  end if;

  raise notice 'OK 40 · authenticated conserva lo que la bandeja necesita';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 41 · `anon` no tiene privilegios sobre ninguna tabla
-- -----------------------------------------------------------------------------
-- La RLS ya lo bloquea. Esta es la segunda puerta, para el dia que una politica
-- se escriba mal.
-- -----------------------------------------------------------------------------

do $$
declare
  v_tablas text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into v_tablas
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r'
    and (has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE')
      or has_table_privilege('anon', c.oid, 'DELETE'));

  if v_tablas is not null then
    raise exception 'FALLO 41: anon tiene privilegios sobre tablas: %', v_tablas;
  end if;

  raise notice 'OK 41 · anon no tiene privilegios sobre ninguna tabla';
end $$;

\echo ''
\echo '======================================================================'
\echo ' VERIFICACIONES DE PRIVILEGIOS DE SUPABASE: TODAS PASARON'
\echo '======================================================================'
