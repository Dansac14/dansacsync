// =============================================================================
// Verificacion de firma de webhooks
// =============================================================================
// Meta firma cada evento con HMAC-SHA256 del CUERPO CRUDO usando el App Secret,
// y lo envia en la cabecera X-Hub-Signature-256 con el prefijo "sha256=".
//
// Dos detalles que hay que respetar o la verificacion falla siempre:
//
//   1. Hay que firmar los bytes exactos que llegaron. Si se hace JSON.parse y
//      luego JSON.stringify, el resultado casi nunca coincide byte a byte con
//      lo que envio Meta (orden de claves, escapes unicode, espacios), y la
//      firma no valida nunca.
//
//   2. La comparacion no puede abortar. La implementacion habitual usa
//      timingSafeEqual directamente, que LANZA una excepcion cuando los dos
//      buffers tienen longitudes distintas. Basta con que alguien mande una
//      cabecera de firma corta para provocar un error 500 en cada peticion.
//      Aqui la longitud se comprueba antes y se responde false.
// =============================================================================

const encoder = new TextEncoder();

/**
 * Compara dos cadenas en tiempo constante respecto a su contenido.
 * La longitud se compara antes, porque una diferencia de longitud ya es
 * publica: esta en el tamano de la cabecera recibida.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, payload as BufferSource);

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifica la cabecera X-Hub-Signature-256 de Meta.
 *
 * @param rawBody Los bytes exactos del cuerpo, sin parsear ni reserializar.
 * @param header  Valor de la cabecera, con el prefijo "sha256=".
 * @param appSecret App Secret de la aplicacion de Meta.
 */
export async function verifyMetaSignature(
  rawBody: Uint8Array,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header || !appSecret) return false;

  const separator = header.indexOf("=");
  if (separator < 0) return false;

  const algorithm = header.slice(0, separator);
  const received = header.slice(separator + 1).toLowerCase();

  if (algorithm !== "sha256") return false;
  // SHA-256 en hexadecimal son 64 caracteres exactos.
  if (received.length !== 64 || !/^[0-9a-f]+$/.test(received)) return false;

  const expected = await hmacSha256Hex(appSecret, rawBody);
  return safeEqual(received, expected);
}

/**
 * Responde al handshake de verificacion del webhook.
 *
 * Meta llama con GET y hub.mode=subscribe. Hay que devolver hub.challenge tal
 * cual, en texto plano: si se devuelve JSON o con comillas, el panel rechaza
 * la suscripcion sin decir por que.
 */
export function handleVerificationHandshake(
  url: URL,
  expectedToken: string,
): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) {
    return new Response("Peticion de verificacion incompleta", { status: 400 });
  }

  if (!expectedToken || !token || !safeEqual(token, expectedToken)) {
    return new Response("Token de verificacion invalido", { status: 403 });
  }

  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
