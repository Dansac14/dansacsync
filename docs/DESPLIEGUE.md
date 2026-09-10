# Despliegue

El sistema está completo en código: base de datos, webhook, worker, agente RAG,
Inbox, catálogo, órdenes y módulo fiscal. Lo que falta es conectarlo a
servicios reales.

Orden de despliegue, y por qué ese orden:

1. **Supabase** — es la base de todo lo demás.
2. **Edge Function del webhook** — necesita el proyecto ya creado.
3. **Worker** — necesita la base y las credenciales de canal.
4. **Vercel** — el Inbox; es lo último porque sin datos no muestra nada.

Las credenciales de Meta y la clave de OpenAI se pueden añadir después: sin
ellas el sistema arranca, guarda los mensajes que lleguen y los deja en la
bandeja para una persona.

---

## 1. Subir el repositorio a GitHub

El historial de Git ya viene con sus commits hechos. Solo falta apuntarlo al
repositorio remoto.

El repositorio en GitHub debe ser **privado**. Este código incluye la lógica
fiscal, el esquema completo y las políticas de seguridad del SaaS.

Lo que se sube es el contenido de esta carpeta **en la raíz** del repositorio:
`README.md`, `docs/`, `supabase/`, `web/`, `worker/` deben quedar en el primer
nivel. Si al abrir el repositorio en GitHub ves una sola carpeta que contiene
todo, el push se hizo desde el directorio padre equivocado.

```bash
git remote add origin git@github.com:Dansac14/dansacsync.git
git branch -M main
git push -u origin main
```

Con HTTPS en lugar de SSH:

```bash
git remote add origin https://github.com/Dansac14/dansacsync.git
git branch -M main
git push -u origin main
```

Comprueba antes que no vas a subir secretos. Los `.example` sí se suben; los
`.env` reales, nunca:

```bash
git ls-files | grep -E '(^|/)\.env(\.|$)' | grep -v '\.example$'
```

Si ese comando no imprime nada, no hay secretos versionados.

---

## 2. Crear el proyecto en Supabase

Desde el panel de Supabase, dentro de tu organización:

- **Nombre:** `synchrony-dansac`
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

`db push` aplica los 17 archivos de `supabase/migrations/` en orden alfabético,
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

-- 61 políticas
select count(*) from pg_policies where schemaname = 'public';

-- pgvector activo
select extname, extversion from pg_extension where extname = 'vector';

-- La comprobación más importante de todas: `anon` es la clave que viaja en el
-- navegador, y solo debe poder ejecutar order_public_view. Cualquier otra
-- función en esta lista es un agujero.
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','app')
  and has_function_privilege('anon', p.oid, 'EXECUTE');
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

## 7. Desplegar el webhook

```bash
supabase secrets set META_APP_SECRET=... META_VERIFY_TOKEN=...
supabase functions deploy webhook-social --no-verify-jwt
```

`--no-verify-jwt` es obligatorio: Meta llama sin un token de Supabase. La
autenticación del webhook es la firma HMAC del propio evento, que la función
verifica antes de tocar la base de datos.

La URL que se registra en Meta es:
`https://<project-ref>.supabase.co/functions/v1/webhook-social`

---

## 8. Levantar el worker

El worker es un proceso permanente. **Vercel no sirve**: sus funciones son
efímeras y mueren al terminar la petición. Necesita Railway, Fly.io, Render o
un VPS.

Para la primera prueba basta con correrlo en tu propia máquina:

```bash
cp .env.example .env    # y complétalo
cd worker
npm install
npm start
```

El worker lee el `.env` de la **raíz** del repositorio, no uno dentro de
`worker/`. Variables mínimas: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y,
para que el agente responda, `OPENAI_API_KEY`. Sin la clave de IA el worker
arranca igual: guarda los mensajes y escala cada conversación a una persona,
que es el comportamiento correcto, no un fallo.

Los tres archivos de entorno son distintos y no se mezclan:

| Archivo | Lo lee | Prefijo de las variables |
|---|---|---|
| `.env` (raíz) | el worker | sin prefijo |
| `web/.env.local` | Next.js | `NEXT_PUBLIC_` |
| `supabase secrets set` | la Edge Function | sin prefijo |

---

## 9. Indexar los manuales

```bash
cd worker
npm run ingest -- --tenant mi-empresa --title "Manual Operativo 2026" \
                  --file ./manuales/operativo.md
```

Hasta que haya al menos un manual indexado, el agente escala todas las
consultas a una persona en lugar de improvisar respuestas.

---

## 10. Vercel

Directorio raíz del proyecto: **`web/`**. Variables necesarias:

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | La URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | La clave publicable |
| `NEXT_PUBLIC_APP_URL` | La URL que Vercel asigne, para los enlaces de pago |

La `SUPABASE_SERVICE_ROLE_KEY` **no va en Vercel**. El Inbox trabaja con la
sesión del operador y toda consulta pasa por la RLS. Y nunca con el prefijo
`NEXT_PUBLIC_`, que la publicaría al navegador.

Después del despliegue, en Supabase → Authentication → URL Configuration, pon
la URL de Vercel como **Site URL**: sin eso, el ingreso redirige a localhost.
