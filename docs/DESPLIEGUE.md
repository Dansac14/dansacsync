# Despliegue

Estado actual: **solo existe la capa de datos.** Estas instrucciones cubren
GitHub y Supabase. Vercel queda para cuando exista `web/`, porque hoy no hay
frontend que desplegar.

---

## 1. Subir el repositorio a GitHub

El historial de Git ya viene iniciado con el commit inicial hecho. Solo falta
apuntarlo a tu repositorio.

Crea el repositorio en GitHub **vacío y privado** (sin README, sin .gitignore,
sin licencia: ya están aquí y un archivo autogenerado provocaría un conflicto
en el primer push).

```bash
cd omnichannel-crm

git remote add origin git@github.com:<tu-usuario>/omnichannel-social-crm.git
git branch -M main
git push -u origin main
```

Con HTTPS en lugar de SSH:

```bash
git remote add origin https://github.com/<tu-usuario>/omnichannel-social-crm.git
git branch -M main
git push -u origin main
```

Comprueba antes que no vas a subir secretos:

```bash
git ls-files | grep -E '^\.env$' && echo "ALTO: .env quedaría versionado" || echo "OK: ningún .env versionado"
```

---

## 2. Crear el proyecto en Supabase

Desde el panel de Supabase, dentro de tu organización:

- **Nombre:** el que prefieras, por ejemplo `omnichannel-social-crm`
- **Región:** `sa-east-1` (São Paulo) es la más cercana a Perú; `us-east-1`
  (Virginia) es la más estándar. Cualquiera de las dos funciona.
- **Contraseña de la base de datos:** guárdala en tu gestor de contraseñas. No
  se puede recuperar después, solo restablecer.

Anota el **project ref**: la cadena que aparece en la URL del panel, del estilo
`abcdefghijklmnopqrst`.

---

## 3. Aplicar las migraciones

Con el CLI de Supabase:

```bash
npm install -g supabase

supabase login
supabase link --project-ref <tu-project-ref>
supabase db push
```

`db push` aplica los 11 archivos de `supabase/migrations/` en orden alfabético,
que es el orden correcto: cada uno depende de los anteriores.

Sin el CLI, con `psql` directo:

```bash
export PGURL='postgresql://postgres:<contraseña>@db.<project-ref>.supabase.co:5432/postgres'

for f in supabase/migrations/*.sql; do
  echo "aplicando $f"
  psql -v ON_ERROR_STOP=1 "$PGURL" -f "$f"
done
```

`ON_ERROR_STOP=1` es importante: sin él, un error a mitad de camino deja la base
en un estado intermedio y el resto de los archivos siguen corriendo sobre un
esquema incompleto.

**No apliques `supabase/tests/00_supabase_shim.sql` en Supabase.** Ese archivo
crea los roles y `auth.uid()` para poder probar en un Postgres limpio; en
Supabase ya existen y ejecutarlo fallaría.

---

## 4. Comprobar que quedó bien

```sql
-- 25 tablas
select count(*) from pg_tables where schemaname = 'public';

-- 0 tablas sin RLS. Cualquier número distinto de 0 es un problema de seguridad.
select tablename
from pg_tables t
join pg_class c on c.relname = t.tablename
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
where t.schemaname = 'public' and not c.relrowsecurity;

-- 63 políticas
select count(*) from pg_policies where schemaname = 'public';

-- pgvector activo
select extname, extversion from pg_extension where extname = 'vector';
```

Además, el panel de Supabase tiene un asesor de seguridad en
**Advisors → Security**. Después de aplicar las migraciones debería salir
limpio; si reporta tablas sin RLS, algo no se aplicó.

---

## 5. Dar de alta la primera empresa

`provision_tenant` deja tenant, propietario, configuración, grupos del sistema y
series de numeración en una sola transacción. Necesita un usuario ya creado en
Supabase Auth.

```sql
-- 1. Crea el usuario desde el panel: Authentication → Users → Add user
--    y copia su UUID.

-- 2. Da de alta la empresa con ese usuario como propietario.
select * from public.provision_tenant(
  'Mi Empresa S.A.C.',        -- razón social
  'mi-empresa',               -- slug, en minúsculas
  '<uuid-del-usuario>',       -- propietario
  '20481234567',              -- RUC
  'Av. Larco 1234, Trujillo'  -- dirección fiscal
);
```

Esta función solo puede ejecutarla `service_role`: el alta de empresas es un
acto de aprovisionamiento del SaaS, no algo que se dispare desde el navegador.

---

## 6. Guardar los secretos de canal en Vault

Los tokens de Meta y TikTok no se guardan en `channel_accounts`. Ahí solo va el
nombre con el que recuperarlos, para que ni un volcado de la tabla ni un error
de RLS expongan una credencial de producción.

```sql
select vault.create_secret(
  '<token-de-acceso-real>',
  'meta_token_mi_empresa',
  'Token de System User de Meta para Mi Empresa S.A.C.'
);

insert into public.channel_accounts (
  tenant_id, channel, external_account_id, display_name,
  phone_number, access_token_secret_name
)
values (
  '<tenant-id>', 'whatsapp', '<phone_number_id>', 'WhatsApp Mi Empresa',
  '+51987654321', 'meta_token_mi_empresa'
);
```

`external_account_id` debe ser exactamente el `phone_number_id` de WhatsApp, el
`page_id` de Facebook o el id de la cuenta de Instagram Business. Es la llave
que traduce un webhook entrante a una empresa: si no coincide, el evento llega,
se guarda para diagnóstico y no se procesa.

---

## 7. Vercel

Pendiente. Se conecta cuando exista `web/` con su `package.json`. Conectarlo
antes deja un despliegue fallido o un proyecto en blanco.

Cuando llegue el momento, las variables que necesita son `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. La
`SUPABASE_SERVICE_ROLE_KEY` no va en Vercel salvo que se use en rutas de
servidor, y nunca con el prefijo `NEXT_PUBLIC_`, que la publicaría al navegador.
