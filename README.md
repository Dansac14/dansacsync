# Synchrony Dansac

CRM social omnicanal multi-tenant con agente de IA sobre WhatsApp, Instagram,
Facebook y TikTok. Incluye RAG sobre los manuales de cada empresa, toma de
control humano, catálogo, órdenes y comprobantes fiscales peruanos.

Proyecto independiente. No comparte infraestructura, base de datos ni
credenciales con ningún otro sistema.

---

## Estado

| Fase | Alcance | Estado |
|------|---------|--------|
| 1 | Esquema de datos, RLS y funciones de dominio | **Completa y verificada** |
| 2 | Webhook unificado, worker y despacho multicanal | **Completa y verificada** · TikTok sin implementar |
| 3 | Motor RAG e ingesta de manuales | **Completa** · sin probar aún contra un proveedor real |
| 4 | Inbox del operador con takeover en tiempo real | **Completa** · compila y se sirve; sin probar aún contra datos reales |
| 5 | Catálogo, órdenes, finanzas y ajustes | **Completa** · compila y se sirve |
| — | Revisión de seguridad y endurecimiento | **Completa** · 9 fallos graves corregidos |

Lo que falta para que el sistema atienda a un cliente real: un proyecto
Supabase, credenciales de Meta, una clave de OpenAI y los manuales de la
empresa indexados. El código está completo para esos tres canales.

---

## Arquitectura

```
Meta (WhatsApp · Messenger · Instagram)
        │  POST firmado con HMAC-SHA256
        ▼
Edge Function webhook-social
        │  verifica firma → normaliza el lote → resuelve tenant
        ▼
inbound_events          cola en Postgres, deduplicada por evento
        │
        ▼
Worker · bucle de entrada
        ├─ ingest_inbound_message()   contacto, conversación y mensaje, en una transacción
        ├─ storeIncomingMedia()       descarga el adjunto antes de que caduque su URL
        ├─ runAiPipeline()            embedding → search_knowledge() → respuesta anclada
        └─ escalate_conversation()    cuando no hay contexto suficiente
        │
        ▼
outbound_jobs           cola de salida, con reintentos y backoff
        │
        ▼
Worker · bucle de salida ──► Graph API v25
                                  │
                                  ▼
                        Inbox del operador (Fase 4)
```

Dos decisiones que estructuran todo lo demás:

**La cola vive en Postgres, no en Redis.** El encolado ocurre en la misma
transacción que la deduplicación, así que no existe la ventana en la que un
evento se acepta y se pierde. `FOR UPDATE SKIP LOCKED` reparte el trabajo entre
varios workers sin coordinación y sin una segunda pieza de infraestructura.

**El webhook no procesa, solo encola.** Meta espera un 200 en pocos segundos y,
si tarda, reintenta el evento y acaba desactivando la suscripción. Cualquier
trabajo lento puesto en el webhook termina en mensajes duplicados y en un canal
caído.

---

## Decisiones de diseño que corrigen la especificación original

| Problema en la especificación | Solución aplicada |
|---|---|
| `tenant_id` existía en las tablas pero ninguna consulta lo usaba | RLS obligatoria en las 25 tablas; el aislamiento lo hace cumplir Postgres, no el código |
| No había forma de saber a qué empresa pertenece un webhook entrante | Tabla `channel_accounts` con `unique (channel, external_account_id)` |
| Un reintento de Meta duplicaba el mensaje y la respuesta del bot | `unique (channel_account_id, channel_message_id)` y corte temprano en la ingesta |
| `normalizeEvent` leía solo el primer mensaje del lote | Se recorre `entry[].changes[].value.messages[]` completo |
| `timingSafeEqual` lanzaba excepción con longitudes distintas | Comparación en tiempo constante que rechaza en vez de abortar |
| Los ecos de Messenger hacían que el bot se respondiera a sí mismo | `is_echo` se descarta en la normalización |
| La búsqueda vectorial no filtraba por empresa | `search_knowledge()` filtra por `tenant_id` dentro de la consulta |
| Instagram y Facebook eran `console.log` | Despacho real por Graph API, con los dos flujos de Instagram |
| `bot_enabled` apagaba el bot para la persona en todos sus canales | `handling_mode` por conversación: el control se toma sobre un hilo |
| Nada contemplaba la ventana de 24 h de WhatsApp | `service_window_expires_at` se reinicia con cada mensaje del cliente |
| Todo fallo se reintentaba igual | Error permanente frente a transitorio: un token revocado no gasta cinco intentos |
| Un acuse atrasado habría hecho retroceder el estado de un mensaje leído | `apply_delivery_status()` solo avanza |
| El correlativo fiscal se habría repetido con dos ventas simultáneas | `next_correlative()` atómico, verificado con 8 conexiones en paralelo |
| Los items de la orden en un JSONB perdían el precio histórico | Tabla `order_items` con copia congelada del producto |
| No existían operadores ni autenticación | `tenant_members` ligado a `auth.users`, con roles |
| Los tokens de Meta iban en texto plano en la tabla | Solo se guarda el nombre del secreto; el valor vive en Supabase Vault |
| El prompt, el tono y las palabras de escalado estaban fijos en el código | Todo en `company_settings`, por empresa y editable sin desplegar |
| Un manual reindexado a medias dejaba al agente con medio documento | `replace_document_chunks()` sustituye en una sola transacción |

---

## Estructura

```
supabase/
  migrations/                          14 archivos, se aplican en orden alfabético
    0001_extensions_and_types          Extensiones y tipos del dominio
    0002_tenancy_and_access            Tenants, miembros, cuentas de canal, autorización
    0003_contacts_and_messaging        Contactos, identidad unificada, conversaciones, mensajes
    0004_event_queues                  Colas de entrada y salida, trazas de IA
    0005_knowledge_rag                 Documentos, fragmentos, índice HNSW, búsqueda semántica
    0006_catalog_and_orders            Numeración correlativa, catálogo, órdenes
    0007_fiscal_documents              Comprobantes, emisión, compras y gastos
    0008_settings_and_audit            Configuración por empresa, respuestas rápidas, bitácora
    0009_row_level_security            63 políticas RLS
    0010_domain_functions              Ingesta, colas, acciones del operador
    0011_provisioning_and_realtime     Alta de empresa y publicación en tiempo real
    0012_secrets_and_media_storage     Lectura de Vault y bucket de archivos
    0013_queue_finalizers_and_receipts Fallos definitivos y acuses de entrega
    0014_escalation_and_knowledge      Escalado a operador y reindexado atómico
    0015_commerce_operations           Ficha de producto, pago, comprobante, resumen
    0016_hardening                     Correcciones de la revisión de seguridad
  functions/
    _shared/signature.ts               Verificación HMAC y handshake
    _shared/normalize.ts               Los tres formatos de Meta a un sobre único
    webhook-social/index.ts            Punto de entrada de los canales
    tests/verify_webhook.ts            38 verificaciones de firma y normalización
  tests/
    00_supabase_shim.sql               Emula auth.uid() y los roles en Postgres limpio
    01_verify_core.sql                 14 verificaciones del núcleo
    02_verify_channels.sql             5 verificaciones de acuses, escalado y reindexado
    03_verify_commerce.sql             9 verificaciones de catálogo, pago y fiscal
    04_verify_hardening.sql            9 ataques reales que ya no funcionan

worker/
  src/index.ts                         Dos bucles de cola, apagado ordenado
  src/config.ts                        Validación de entorno al arrancar
  src/db.ts                            Colas, cuentas de canal y secretos
  src/media.ts                         Descarga y guardado de adjuntos
  src/channels/types.ts                Contrato de canal y clasificación de errores
  src/channels/whatsapp.ts             Envío y descarga en dos pasos
  src/channels/meta-messaging.ts       Messenger e Instagram
  src/channels/tiktok.ts               Sin implementar, falla con motivo explícito
  src/handlers/inbound.ts              Ingesta, adjunto, modo humano, IA, escalado
  src/handlers/outbound.ts             Ventana de 24 h, firma de URL, despacho
  src/ai/pipeline.ts                   RAG con escalado cuando falta contexto
  src/ai/chunker.ts                    Troceado por secciones del documento
  src/ai/ingest.ts                     CLI de indexación de manuales
  tests/verify_chunker.ts              22 verificaciones de troceado

web/
  app/layout.tsx                       Raíz de la aplicación
  app/login/page.tsx                   Ingreso, sin registro público
  app/login/actions.ts                 Server actions de sesión
  app/inbox/page.tsx                   Carga inicial: usuario, empresas, grupos
  components/inbox/InboxShell.tsx      Estado, tiempo real y disposición
  components/inbox/ConversationList.tsx Columna de conversaciones con filtros
  components/inbox/MessageThread.tsx   Hilo con separadores de día y acuses
  components/inbox/Composer.tsx        Caja de escritura con avisos de ventana
  components/inbox/ContactPanel.tsx    Ficha del contacto y grupos
  components/inbox/ChannelBadge.tsx    Distintivo de canal y estado de entrega
  lib/supabase/{client,server,middleware}.ts  Clientes y renovación de sesión
  lib/types.ts                         Tipos del esquema y nombre del contacto
  lib/format.ts                        Fechas relativas y ventana de servicio
  middleware.ts                        Guardia de rutas
  app/ordenes/page.tsx                 Órdenes: crear, cobrar, emitir comprobante
  app/catalogo/page.tsx                Catálogo de productos y categorías
  app/finanzas/page.tsx                Resumen financiero, gastos y comprobantes
  app/ajustes/page.tsx                 Empresa, agente de IA, canales y manuales
  app/p/[token]/page.tsx               Página pública de la orden, sin sesión
  components/orders/OrdersManager.tsx  Órdenes y emisión fiscal
  components/catalog/CatalogManager.tsx Catálogo
  components/finance/FinanceDashboard.tsx Cifras del periodo y gastos
  components/settings/SettingsForm.tsx Ajustes de empresa y del agente
  components/inbox/ProductPicker.tsx   Envío de ficha desde la conversación
  lib/money.ts                         Importes, RUC y DNI
  lib/tenant.ts                        Resolución de usuario y empresa
  tests/verify_inbox_logic.ts          27 verificaciones de lógica de interfaz
  tests/verify_money.ts                41 verificaciones de importes y documentos
```

---

## Verificación

Todo lo siguiente corre sin credenciales externas y sin Supabase: PostgreSQL 16
con pgvector para la base, Node para los módulos puros.

```bash
# Base de datos: 14 migraciones + 19 invariantes
createdb crm_test
psql -d crm_test -f supabase/tests/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d crm_test -f "$f"; done
psql -v ON_ERROR_STOP=1 -d crm_test -f supabase/tests/01_verify_core.sql
psql -v ON_ERROR_STOP=1 -d crm_test -f supabase/tests/02_verify_channels.sql

# Webhook: firma y normalización
node --experimental-strip-types supabase/functions/tests/verify_webhook.ts

# Troceado de manuales
node --experimental-strip-types worker/tests/verify_chunker.ts

# Lógica del Inbox
node --experimental-strip-types web/tests/verify_inbox_logic.ts

# Tipos y build
cd worker && npm install && npm run typecheck
cd ../web && npm install && npm run build
```

Resultado actual: **175 verificaciones en verde, sin credenciales externas.**

| Suite | Qué comprueba | Verificaciones |
|---|---|---|
| `01_verify_core.sql` | Aislamiento, idempotencia, numeración, totales | 14 |
| `02_verify_channels.sql` | Acuses, escalado, reindexado atómico | 5 |
| `03_verify_commerce.sql` | Catálogo, pago, comprobante, resumen, página pública | 9 |
| `04_verify_hardening.sql` | Ataques reales que ya no funcionan | 9 |
| `verify_webhook.ts` | Firma HMAC y normalización de los tres formatos | 45 |
| `verify_chunker.ts` | Troceado de manuales sin pérdida de texto | 25 |
| `verify_inbox_logic.ts` | Nombre de contacto, ventana de 24 h, fechas | 27 |
| `verify_money.ts` | Importes, RUC, DNI, estados | 41 |

Más el typecheck del worker, el build del frontend, y la comprobación de que
`/login` responde 200 y `/inbox` sin sesión redirige a `/login?destino=/inbox`.

Base de datos:

```
OK  1 · Aprovisionamiento deja tenant, propietario, ajustes, grupos y series
OK  2 · Reintento de webhook: 1 contacto, 1 conversación, 1 mensaje
OK  3 · Un mismo número en dos empresas produce dos contactos separados
OK  4 · Ventana de 24 h, no leídos y vista previa se mantienen solos
OK  5 · Un operador solo ve su empresa; la fuga la bloquea Postgres
OK  6 · Un operador no puede escribir mensajes a nombre del bot
OK  7 · 50 correlativos consecutivos, sin huecos ni repetidos
OK  8 · Orden 2 x 118.00 -> base 200.00 + IGV 36.00 = 236.00
OK  9 · Comprobante F001-00000051 emitido; factura sin RUC rechazada
OK 10 · Con vectores idénticos, cada empresa recupera solo su manual
OK 11 · Toma de control aplicada y registrada en la bitácora
OK 12 · El mensaje del operador queda encolado y atribuido a él
OK 13 · 20 eventos repartidos 12/8 entre dos workers, ninguno duplicado
OK 14 · Backoff creciente y paso a "dead" al agotar los reintentos
OK 15 · El acuse avanza sent->delivered->read, no retrocede, y failed siempre entra
OK 16 · La marca de lectura afecta solo a los mensajes anteriores a ella
OK 17 · Escalado: apaga el bot, agrupa al contacto y deja bitácora, sin duplicar
OK 18 · Reindexado atómico: un fragmento inválido deja el manual anterior intacto
OK 19 · Un error permanente cierra el trabajo y marca el mensaje como fallido con motivo
```

Prueba de concurrencia del correlativo fiscal, 8 conexiones simultáneas
asignando 25 números cada una:

```
filas=200  distintos=200  min=1  max=200  huecos=0
```

En Supabase se aplican solo los archivos de `migrations/`; el shim no se usa
porque `auth`, `auth.uid()` y los roles ya existen.

---

## Modelo de acceso

| Quién | Cómo entra | Qué puede hacer |
|---|---|---|
| `anon` | Sin sesión | Nada. No recibe ningún privilegio |
| `authenticated` | Sesión de Supabase Auth | Solo las filas de las empresas donde es miembro activo |
| `owner` / `admin` | Rol en `tenant_members` | Configuración, canales, catálogo, conocimiento, comprobantes |
| `operator` | Rol en `tenant_members` | Conversaciones, contactos, órdenes, envío de mensajes como él mismo |
| `service_role` | Worker y Edge Functions | `BYPASSRLS`: el único que escribe en las colas y como el bot |

---

## El Inbox

Tres columnas: conversaciones, hilo y ficha del contacto.

- **Tiempo real.** Un mensaje nuevo aparece sin recargar. Sin esto, dos
  operadores atenderían el mismo chat sin saberlo. Realtime respeta la RLS, así
  que la suscripción solo entrega filas de la empresa del operador.
- **Los tres emisores se distinguen.** Cliente, agente de IA y operador tienen
  aspecto distinto: el operador necesita saber qué contestó el bot antes de
  escribir, para no repetirlo ni contradecirlo.
- **Aviso de ventana de 24 h.** Si está cerrada, la caja de escritura se bloquea
  y se explica por qué, en lugar de dejar redactar un mensaje que Meta va a
  rechazar. La etiqueta aparece también en la lista, antes de abrir el hilo.
- **Aviso de modo IA.** Si el operador escribe sin tomar el control, el agente
  sigue activo y puede responder encima. Se advierte.
- **Estado de entrega en cada mensaje saliente.** Que un operador vea "no se
  envió" en lugar de nada es la diferencia entre reintentar y creer que el
  cliente ya recibió la respuesta.
- **Los grupos del sistema no se editan a mano.** "Atención humana" se asigna al
  escalar y "Leads nuevos" al primer mensaje: dejarlos editables crearía un
  estado que el motor volvería a cambiar.

---

## Puesta en marcha

`docs/DESPLIEGUE.md` tiene los pasos completos. En resumen:

```bash
# 1. Base de datos
supabase link --project-ref <ref>
supabase db push

# 2. Webhook
supabase secrets set META_APP_SECRET=... META_VERIFY_TOKEN=...
supabase functions deploy webhook-social --no-verify-jwt

# 3. Worker
cd worker && npm install && npm start

# 4. Indexar los manuales de una empresa
npm run ingest -- --tenant mi-empresa --title "Manual Operativo 2026" \
                  --file ./manuales/operativo.md

# 5. Inbox
cd ../web && npm install && npm run build && npm start
```

En Vercel, el directorio raíz del proyecto es `web/` y las variables necesarias
son `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. La
`SUPABASE_SERVICE_ROLE_KEY` no va en Vercel: el Inbox trabaja con la sesión del
operador y toda consulta pasa por la RLS.

El webhook se despliega con `--no-verify-jwt` porque Meta lo llama sin un token
de Supabase: su autenticación es la firma HMAC del propio evento, que la función
verifica antes de tocar la base de datos.

---

## TikTok

Sin implementar, deliberadamente. `worker/src/channels/tiktok.ts` falla de
inmediato con un motivo explícito en lugar de aparentar que funciona.

El esquema de firma del webhook y el endpoint de envío de mensaje directo de
TikTok Business Messaging no tienen documentación pública: el acceso está detrás
de una aplicación aprobada en el portal de TikTok for Business. Un HMAC
inventado no falla de forma visible: o rechaza todos los eventos legítimos, o
los acepta sin comprobar nada y deja el webhook abierto para que cualquiera
inyecte mensajes en las conversaciones de un cliente.

Para completarlo hacen falta dos datos del portal: el esquema exacto de firma
(cabecera, qué se firma, con qué secreto) y el endpoint de envío con su formato
de cuerpo. Con eso, el archivo se completa siguiendo el mismo contrato que los
otros tres y no hay que tocar nada más: la base de datos ya acepta `tiktok` como
canal y el registro de canales ya lo contempla.

---

## Revisión de seguridad

El esquema y el código pasaron por una revisión independiente. Encontró **nueve
fallos con consecuencia real**, todos corregidos en `0016_hardening.sql` y en el
código, y cada uno tiene ahora una prueba que reproduce el ataque y verifica que
ya no funciona.

| Fallo | Qué permitía | Corrección |
|---|---|---|
| EXECUTE por defecto para PUBLIC | Once funciones ejecutables por `anon` (la clave que viaja en el navegador): emitir facturas en empresas ajenas, cobrar órdenes, escribir a clientes de otra empresa como su bot | `revoke` explícito sobre todas las funciones y `alter default privileges` para las futuras |
| Comprobación que se desactivaba a sí misma | `if auth.uid() is not null and not app.is_member(…)` no comprobaba nada cuando `auth.uid()` era NULL | `app.assert_tenant_access()`: exige pertenencia salvo que quien llame sea el backend |
| Escritura entre empresas por la fila hija | Insertar una línea con MI `tenant_id` en una orden AJENA reescribía su total; lo mismo en la bandeja de otra empresa | Claves ajenas compuestas `(tenant_id, padre_id)` contra `unique (tenant_id, id)` |
| `next_correlative` sin comprobar | Quemar correlativos fiscales de cualquier empresa; en Perú, una serie con huecos es una contingencia ante SUNAT | Comprobación de pertenencia y validación del ámbito |
| El rol `viewer` escribía | El rol de solo lectura no existía en la base | `app.can_write()` en todas las políticas de escritura |
| Comprobantes insertables a mano | Insertar el correlativo que la secuencia iba a asignar bloqueaba la facturación de forma irreversible | Emisión solo por función; sin política de INSERT |
| Comprobantes emitidos reescribibles | Cambiar importe, receptor y correlativo de un documento ya declarado | Trigger de inmutabilidad |
| Importes de orden manipulables | `total = 0.01` en una orden de 1750, o pasarla a pagada sin descontar stock | Restricción de coherencia y permisos por columna |
| Autoría falsificable | Cargar gastos y comprobantes a nombre de otra persona | Triggers que fuerzan `created_by` al usuario de la sesión |

Y en el código:

| Fallo | Consecuencia |
|---|---|
| Rama de `changes[].value.messaging` inalcanzable | Con una cuenta conectada de esa forma, el mensaje del cliente desaparecía sin dejar rastro |
| El duplicado enmascaraba fallos posteriores | Si la IA o el encolado fallaban, el reintento veía "duplicado" y el cliente no recibía respuesta nunca |
| Dos POST en un trabajo de Messenger | Un 429 en el segundo hacía que el cliente recibiera la imagen hasta cinco veces |
| El troceador descartaba texto | Se perdía casi la mitad de un manual, y la ingesta lo reportaba como éxito |
| Trabajos abandonados en `processing` | Si el worker moría, esos mensajes no se respondían nunca y nadie se enteraba |
| Membresías sin filtrar por usuario | El rol y `esAdmin` se tomaban de la fila de un compañero |
| Carrera al cambiar de conversación | El operador leía un hilo y le escribía la respuesta a otro cliente |
| `formatDayDivider` sin validar | Una fecha inválida tumbaba el panel del hilo completo |
| El borrador se borraba antes de confirmar | El operador perdía el texto redactado si el envío fallaba |
| Se anunciaba "enviada" lo encolado | Un aviso verde afirmaba algo que aún podía fallar |
| La tabla de comprobantes no seguía al periodo | Dos tablas contradictorias en la misma pantalla |
