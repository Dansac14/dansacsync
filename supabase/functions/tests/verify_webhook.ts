// =============================================================================
// Verificacion del webhook · firma y normalizacion
// =============================================================================
// Se ejecuta con:
//   node --experimental-strip-types supabase/functions/tests/verify_webhook.ts
//
// No necesita credenciales ni base de datos: prueba las dos piezas puras de la
// funcion, que son justo donde estaban los fallos de la especificacion original.
// =============================================================================

import { createHmac } from "node:crypto";
import { verifyMetaSignature, safeEqual } from "../_shared/signature.ts";
import { normalizeMetaPayload, dedupeKey } from "../_shared/normalize.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    process.stdout.write(`OK   ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` · ${detail}` : ""}`);
    process.stdout.write(`FALLO ${name}${detail ? ` · ${detail}` : ""}\n`);
  }
}

const SECRET = "app-secret-de-prueba";
const encoder = new TextEncoder();

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// =============================================================================
// Firma
// =============================================================================

const cuerpo = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
const bytes = encoder.encode(cuerpo);

check(
  "Firma valida se acepta",
  await verifyMetaSignature(bytes, sign(cuerpo), SECRET),
);

check(
  "Firma de otro secreto se rechaza",
  !(await verifyMetaSignature(bytes, sign(cuerpo, "secreto-equivocado"), SECRET)),
);

check(
  "Cuerpo alterado invalida la firma",
  !(await verifyMetaSignature(encoder.encode(cuerpo + " "), sign(cuerpo), SECRET)),
);

// Este es el fallo que tumbaba el servicio: timingSafeEqual lanza excepcion
// cuando las longitudes no coinciden. Con la implementacion original, esta
// unica peticion habria devuelto un error 500 en lugar de un 401.
let noLanzo = true;
try {
  const resultado = await verifyMetaSignature(bytes, "sha256=abc", SECRET);
  check("Firma corta se rechaza sin lanzar excepcion", resultado === false);
} catch (error) {
  noLanzo = false;
  check("Firma corta se rechaza sin lanzar excepcion", false,
    `lanzo ${error instanceof Error ? error.name : "error"}`);
}

for (const [nombre, cabecera] of [
  ["cabecera ausente", null],
  ["cabecera vacia", ""],
  ["sin prefijo de algoritmo", createHmac("sha256", SECRET).update(cuerpo).digest("hex")],
  ["algoritmo sha1", "sha1=" + createHmac("sha1", SECRET).update(cuerpo).digest("hex")],
  ["hexadecimal invalido", "sha256=" + "z".repeat(64)],
  ["demasiado larga", "sha256=" + "a".repeat(128)],
] as [string, string | null][]) {
  let rechazada = false;
  try {
    rechazada = !(await verifyMetaSignature(bytes, cabecera, SECRET));
  } catch {
    rechazada = false;
  }
  check(`Se rechaza sin excepcion: ${nombre}`, rechazada);
}

check("safeEqual distingue cadenas de igual longitud", !safeEqual("abcd", "abce"));
check("safeEqual acepta cadenas identicas", safeEqual("abcd", "abcd"));

// =============================================================================
// Normalizacion
// =============================================================================

// -----------------------------------------------------------------------------
// Lote de WhatsApp: tres mensajes repartidos en dos entradas y dos cambios,
// mas un acuse de entrega. La implementacion original leia solo
// entry[0].changes[0].value.messages[0] y habria procesado UNO de los tres.
// -----------------------------------------------------------------------------

const loteWhatsApp = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA-1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "51987654321", phone_number_id: "PN-1" },
            contacts: [{ profile: { name: "Rosa Quispe" }, wa_id: "51999111222" }],
            messages: [
              { from: "51999111222", id: "wamid.1", timestamp: "1757000000", type: "text",
                text: { body: "Hola, cuanto cuesta el taller?" } },
              { from: "51999111222", id: "wamid.2", timestamp: "1757000005", type: "image",
                image: { id: "MEDIA-9", mime_type: "image/jpeg", caption: "Este es mi negocio" } },
            ],
          },
        },
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN-1" },
            messages: [
              { from: "51988777666", id: "wamid.3", timestamp: "1757000010", type: "text",
                text: { body: "Buenas, informacion por favor" } },
            ],
          },
        },
      ],
    },
    {
      id: "WABA-1",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN-1" },
            statuses: [
              { id: "wamid.saliente.1", status: "delivered", timestamp: "1757000020",
                recipient_id: "51999111222" },
            ],
          },
        },
      ],
    },
  ],
};

const eventosWa = normalizeMetaPayload(loteWhatsApp);
const mensajesWa = eventosWa.filter((e) => e.kind === "message");
const acusesWa = eventosWa.filter((e) => e.kind === "status");

check("Lote de WhatsApp: se recuperan los 3 mensajes", mensajesWa.length === 3,
  `se obtuvieron ${mensajesWa.length}`);
check("Lote de WhatsApp: se recupera el acuse de entrega", acusesWa.length === 1);

const primero = mensajesWa[0] as any;
check("WhatsApp: cuenta resuelta por phone_number_id", primero.external_account_id === "PN-1");
check("WhatsApp: nombre de perfil cruzado desde contacts", primero.display_name === "Rosa Quispe");
check("WhatsApp: texto extraido", primero.content === "Hola, cuanto cuesta el taller?");
check("WhatsApp: marca de tiempo en milisegundos", primero.timestamp_ms === 1757000000000);

const conImagen = mensajesWa[1] as any;
check("WhatsApp: imagen con id de medio", conImagen.media_external_id === "MEDIA-9");
check("WhatsApp: el pie de foto cuenta como contenido",
  conImagen.content === "Este es mi negocio");
check("WhatsApp: tipo de medio correcto", conImagen.media_type === "image");
check("WhatsApp: no hay URL de medio, solo id", conImagen.media_url === null);

// -----------------------------------------------------------------------------
// Messenger e Instagram
// -----------------------------------------------------------------------------

const loteMessenger = {
  object: "page",
  entry: [{
    id: "PAGE-1",
    messaging: [
      { sender: { id: "PSID-1" }, recipient: { id: "PAGE-1" }, timestamp: 1757000000000,
        message: { mid: "mid.1", text: "Tienen delivery?" } },
      // Eco de un mensaje nuestro: si no se descarta, el bot se responde solo.
      { sender: { id: "PAGE-1" }, recipient: { id: "PSID-1" }, timestamp: 1757000001000,
        message: { mid: "mid.eco", text: "Respuesta del bot", is_echo: true } },
      { sender: { id: "PSID-1" }, recipient: { id: "PAGE-1" }, timestamp: 1757000002000,
        message: { mid: "mid.2",
          attachments: [{ type: "image", payload: { url: "https://cdn.example/foto.jpg" } }] } },
      { sender: { id: "PSID-1" }, recipient: { id: "PAGE-1" }, timestamp: 1757000003000,
        delivery: { mids: ["mid.saliente.1", "mid.saliente.2"], watermark: 1757000003000 } },
      { sender: { id: "PSID-1" }, recipient: { id: "PAGE-1" }, timestamp: 1757000004000,
        read: { watermark: 1757000004000 } },
    ],
  }],
};

const eventosFb = normalizeMetaPayload(loteMessenger);
const mensajesFb = eventosFb.filter((e) => e.kind === "message");
const acusesFb = eventosFb.filter((e) => e.kind === "status");

check("Messenger: el eco propio se descarta", mensajesFb.length === 2,
  `se obtuvieron ${mensajesFb.length} mensajes`);
check("Messenger: ningun mensaje viene de la propia pagina",
  mensajesFb.every((m: any) => m.channel_user_id === "PSID-1"));
check("Messenger: canal identificado como facebook",
  mensajesFb.every((m: any) => m.channel === "facebook"));
check("Messenger: adjunto con URL directa",
  (mensajesFb[1] as any).media_url === "https://cdn.example/foto.jpg");
check("Messenger: dos mids entregados generan dos acuses",
  acusesFb.filter((s: any) => s.status === "delivered").length === 2);
check("Messenger: la marca de lectura se convierte en acuse",
  acusesFb.some((s: any) => s.status === "read" && s.channel_message_id.startsWith("read:")));

const loteInstagram = {
  object: "instagram",
  entry: [{
    id: "IG-1",
    messaging: [
      { sender: { id: "IGSID-1" }, recipient: { id: "IG-1" }, timestamp: 1757000000000,
        message: { mid: "ig.1", text: "Hola!" } },
    ],
  }],
};

const eventosIg = normalizeMetaPayload(loteInstagram);
check("Instagram: canal identificado por object",
  eventosIg.length === 1 && (eventosIg[0] as any).channel === "instagram");
check("Instagram: cuenta resuelta por entry.id",
  (eventosIg[0] as any).external_account_id === "IG-1");

// -----------------------------------------------------------------------------
// Casos limite
// -----------------------------------------------------------------------------

check("Payload vacio no produce eventos", normalizeMetaPayload({}).length === 0);
check("Payload sin entry no produce eventos",
  normalizeMetaPayload({ object: "page" }).length === 0);
check("Cambio sin metadata se ignora sin lanzar",
  normalizeMetaPayload({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messages: [{ from: "1", id: "x" }] } }] }],
  }).length === 0);
check("Campo distinto de messages se ignora",
  normalizeMetaPayload({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "account_review_update", value: { decision: "APPROVED" } }] }],
  }).length === 0);

// -----------------------------------------------------------------------------
// Claves de deduplicacion
// -----------------------------------------------------------------------------

const clavesWa = mensajesWa.map(dedupeKey);
check("Claves de deduplicacion unicas por mensaje",
  new Set(clavesWa).size === clavesWa.length);
check("La clave no depende del momento de recepcion",
  dedupeKey(mensajesWa[0]!) === dedupeKey(mensajesWa[0]!));
check("La clave incluye canal, cuenta y mensaje",
  clavesWa[0] === "whatsapp:PN-1:msg:wamid.1", clavesWa[0]);
check("Mensaje y acuse del mismo id no colisionan",
  dedupeKey(mensajesWa[0]!) !== dedupeKey(acusesWa[0]!));

// =============================================================================

process.stdout.write("\n" + "=".repeat(70) + "\n");
if (failures.length === 0) {
  process.stdout.write(` ${passed} VERIFICACIONES PASARON\n`);
  process.stdout.write("=".repeat(70) + "\n");
} else {
  process.stdout.write(` ${passed} pasaron, ${failures.length} FALLARON:\n`);
  for (const f of failures) process.stdout.write(`   · ${f}\n`);
  process.stdout.write("=".repeat(70) + "\n");
  process.exit(1);
}

if (!noLanzo) process.exit(1);
