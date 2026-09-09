# Omnichannel Social CRM & IA Agent

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
| 2 | Webhook unificado y despacho multicanal | Pendiente |
| 3 | Motor RAG e ingesta de manuales | Pendiente |
| 4 | Inbox del operador con takeover en tiempo real | Pendiente |
| 5 | Catálogo, órdenes y módulo fiscal (interfaz) | Pendiente |

---

## Arquitectura

```
Meta / TikTok
     │  webhook firmado
     ▼
Edge Function ──► inbound_events (cola en Postgres, deduplicada)
                        │
                        ▼
                    Worker  ──► ingest_inbound_message()  ── contacto, conversación, mensaje
                        │
                        ├──► search_knowledge()  ── RAG filtrado por tenant
                        │
                        └──► outbound_jobs ──► Graph API / TikTok Business Messaging
                                     │
                                     ▼
                            Inbox (Next.js + Supabase Realtime)
```

La cola vive en Postgres y no en Redis: el encolado ocurre en la misma
transacción que la deduplicación, así que no existe la ventana en la que un
evento se acepta y se pierde. `FOR UPDATE SKIP LOCKED` da concurrencia real
entre varios workers sin una segunda pieza de infraestructura que mantener.

---

## Decisiones de diseño que corrigen la especificación original

| Problema en la especificación | Solución aplicada |
|---|---|
| `tenant_id` existía en las tablas pero ninguna consulta lo usaba | RLS obligatoria en las 25 tablas; el aislamiento lo hace cumplir Postgres, no el código |
| No había forma de saber a qué empresa pertenece un webhook entrante | Tabla `channel_accounts` con `unique (channel, external_account_id)` |
| Un reintento de Meta duplicaba el mensaje y la respuesta del bot | `unique (channel_account_id, channel_message_id)` y corte temprano en la ingesta |
| `normalizeEvent` solo leía el primer mensaje del lote | El webhook recorre `entry[].changes[].value.messages[]` completo |
| `timingSafeEqual` lanzaba excepción con longitudes distintas | Comparación de tiempo constante con verificación previa de longitud |
| La búsqueda vectorial no filtraba por empresa | `search_knowledge()` filtra por `tenant_id` dentro de la consulta |
| Instagram, Facebook y TikTok eran `console.log` | Despacho real por Graph API y TikTok Business Messaging |
| `bot_enabled` apagaba el bot para la persona en todos sus canales | `handling_mode` por conversación: el control se toma sobre un hilo |
| Nada contemplaba la ventana de 24 h de WhatsApp | `service_window_expires_at` se reinicia con cada mensaje del cliente |
| El correlativo fiscal se habría repetido con dos ventas simultáneas | `next_correlative()` atómico, verificado con 8 conexiones en paralelo |
| Los items de la orden en un JSONB perdían el precio histórico | Tabla `order_items` con copia congelada del producto |
| No existían operadores ni autenticación | `tenant_members` ligado a `auth.users`, con roles |
| Los tokens de Meta iban en texto plano en la tabla | Solo se guarda el nombre del secreto; el valor vive en Supabase Vault |

---

## Estructura

```
supabase/
  migrations/
    0001_extensions_and_types.sql       Extensiones y tipos del dominio
    0002_tenancy_and_access.sql         Tenants, miembros, cuentas de canal, funciones de autorización
    0003_contacts_and_messaging.sql     Contactos, identidad unificada, conversaciones, mensajes
    0004_event_queues.sql               Colas de entrada y salida, trazas de IA
    0005_knowledge_rag.sql              Documentos, fragmentos, índice HNSW, búsqueda semántica
    0006_catalog_and_orders.sql         Numeración correlativa, catálogo, órdenes
    0007_fiscal_documents.sql           Comprobantes, emisión, compras y gastos
    0008_settings_and_audit.sql         Configuración por empresa, respuestas rápidas, bitácora
    0009_row_level_security.sql         63 políticas RLS
    0010_domain_functions.sql           Ingesta, colas, acciones del operador
    0011_provisioning_and_realtime.sql  Alta de empresa y publicación en tiempo real
  tests/
    00_supabase_shim.sql                Emula auth.uid() y los roles para probar en Postgres limpio
    01_verify_core.sql                  14 verificaciones de invariantes
```

---

## Verificación

Ejecutado sobre PostgreSQL 16.13 con pgvector 0.6.0:

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
```

Prueba de concurrencia del correlativo fiscal, 8 conexiones simultáneas
asignando 25 números cada una:

```
filas=200  distintos=200  min=1  max=200  huecos=0
```

Para reproducirlo en un Postgres limpio:

```bash
createdb crm_test
psql -d crm_test -f supabase/tests/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d crm_test -f "$f"; done
psql -v ON_ERROR_STOP=1 -d crm_test -f supabase/tests/01_verify_core.sql
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
| `service_role` | Worker y Edge Functions | `BYPASSRLS`: es el único que escribe en las colas y como el bot |
