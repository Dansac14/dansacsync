-- =============================================================================
-- 0012 · Lectura de secretos y almacenamiento de archivos de los canales
-- =============================================================================
-- Los tokens de Meta y TikTok viven en Supabase Vault, cifrados. La tabla
-- channel_accounts solo guarda el nombre con el que recuperarlos. Esta funcion
-- es el unico camino para leerlos, y solo la puede ejecutar service_role.
--
-- Los bloques que dependen de `vault` y `storage` se ejecutan de forma dinamica
-- o condicional: asi estas mismas migraciones siguen aplicandose en un Postgres
-- limpio, donde esos esquemas no existen, sin fallar.
-- =============================================================================

create or replace function public.get_channel_secret(
  p_channel_account_id uuid,
  p_kind               text
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_name   text;
  v_secret text;
begin
  if p_kind not in ('access_token', 'app_secret', 'verify_token') then
    raise exception 'Tipo de secreto no reconocido: %', p_kind;
  end if;

  select case p_kind
           when 'access_token' then ca.access_token_secret_name
           when 'app_secret'   then ca.app_secret_secret_name
           when 'verify_token' then ca.verify_token_secret_name
         end
    into v_name
  from public.channel_accounts ca
  where ca.id = p_channel_account_id;

  -- Cuenta inexistente o secreto no configurado. Devolver null es correcto:
  -- quien llama decide si eso es un error para la operacion que intentaba.
  if v_name is null then
    return null;
  end if;

  if not exists (select 1 from pg_namespace where nspname = 'vault') then
    raise exception 'Supabase Vault no esta disponible en esta base de datos';
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into v_secret
    using v_name;

  if v_secret is null then
    raise exception 'El secreto "%" no existe en Vault', v_name;
  end if;

  return v_secret;
end;
$$;

-- Nadie mas que el backend puede leer un token de produccion.
revoke all on function public.get_channel_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.get_channel_secret(uuid, text) to service_role;

comment on function public.get_channel_secret(uuid, text) is
  'Lee de Vault el token de una cuenta de canal. Solo service_role.';

-- -----------------------------------------------------------------------------
-- Almacenamiento de los archivos que llegan por los canales
-- -----------------------------------------------------------------------------
-- WhatsApp no envia la URL del archivo, envia un id que hay que canjear contra
-- la Graph API. Messenger e Instagram si envian URL, pero firmada y con
-- caducidad de minutos. En los dos casos, si el archivo no se guarda al
-- recibirlo, se pierde: la conversacion queda con un hueco imposible de
-- recuperar despues.
--
-- Convencion de ruta: <tenant_id>/<conversation_id>/<message_id>.<ext>
-- El primer segmento es el tenant, y es lo que usa la politica de acceso.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'Esquema storage ausente: se omite el bucket de archivos (normal fuera de Supabase)';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values ('channel-media', 'channel-media', false, 104857600)  -- 100 MiB
  on conflict (id) do nothing;

  -- Un operador solo ve los archivos de su propia empresa. La comparacion se
  -- hace sobre el primer segmento de la ruta.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'channel_media_select'
  ) then
    execute $pol$
      create policy channel_media_select on storage.objects
        for select to authenticated
        using (
          bucket_id = 'channel-media'
          and app.is_member((storage.foldername(name))[1]::uuid)
        )
    $pol$;
  end if;

  -- La escritura es exclusiva del worker con service_role: los archivos los
  -- trae el sistema desde el canal, no los sube el navegador.
end $$;
