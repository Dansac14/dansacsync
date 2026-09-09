// =============================================================================
// webhook-social · Punto de entrada unico para los cuatro canales
// =============================================================================
// Responsabilidad y limite: esta funcion verifica, normaliza y encola. No
// consulta la IA, no envia respuestas y no escribe contactos ni mensajes. Eso
// lo hace el worker.
//
// El motivo es un requisito de la plataforma, no una preferencia de estilo:
// Meta espera un 200 en pocos segundos y, si tarda o falla, reintenta el evento
// y acaba desactivando la suscripcion del webhook. Cualquier trabajo lento
// puesto aqui termina en mensajes duplicados y en un canal caido.
//
// Orden de operaciones, estricto:
//   1. Leer los bytes crudos del cuerpo.
//   2. Verificar la firma. Hasta que la firma valida, el contenido no se cree.
//   3. Normalizar y encolar.
//   4. Responder 200.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  handleVerificationHandshake,
  verifyMetaSignature,
} from "../_shared/signature.ts";
import {
  dedupeKey,
  normalizeMetaPayload,
  type NormalizedEvent,
} from "../_shared/normalize.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const META_VERIFY_TOKEN = Deno.env.get("META_VERIFY_TOKEN") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

interface ResolvedAccount {
  id: string;
  tenant_id: string;
  channel: string;
  app_secret_secret_name: string | null;
}

/** Cache por invocacion: un mismo POST suele traer varios eventos de la misma cuenta. */
async function resolveAccount(
  cache: Map<string, ResolvedAccount | null>,
  channel: string,
  externalAccountId: string,
): Promise<ResolvedAccount | null> {
  const key = `${channel}:${externalAccountId}`;
  if (cache.has(key)) return cache.get(key)!;

  const { data, error } = await db.rpc("resolve_channel_account", {
    p_channel: channel,
    p_external_account_id: externalAccountId,
  });

  if (error) {
    console.error("resolve_channel_account fallo", { key, error: error.message });
    cache.set(key, null);
    return null;
  }

  const account = (Array.isArray(data) ? data[0] : data) as ResolvedAccount | null;
  cache.set(key, account ?? null);
  return account ?? null;
}

/**
 * Obtiene el App Secret propio de una cuenta, para los tenants que traen su
 * propia aplicacion de Meta en lugar de usar la del SaaS.
 */
async function accountAppSecret(accountId: string): Promise<string | null> {
  const { data, error } = await db.rpc("get_channel_secret", {
    p_channel_account_id: accountId,
    p_kind: "app_secret",
  });
  if (error) {
    console.error("get_channel_secret fallo", { accountId, error: error.message });
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Verifica la firma.
 *
 * Primero contra el App Secret de la plataforma, que es el caso normal en un
 * SaaS: una sola aplicacion de Meta atiende a todos los tenants. Si no cuadra,
 * se intenta con el secreto propio de la cuenta senalada por el payload.
 *
 * Ese segundo intento mira el cuerpo sin haberlo verificado todavia, y eso esta
 * bien mientras solo se use para ELEGIR con que clave comprobar: el contenido
 * no se procesa hasta que una de las dos verificaciones pasa. Un atacante puede
 * decidir contra que clave se le compara, no puede pasar la comparacion.
 */
async function verifyRequest(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  payload: any,
  cache: Map<string, ResolvedAccount | null>,
): Promise<boolean> {
  if (META_APP_SECRET &&
      await verifyMetaSignature(rawBody, signatureHeader, META_APP_SECRET)) {
    return true;
  }

  const candidates = new Set<string>();
  const object = String(payload?.object ?? "");
  for (const entry of payload?.entry ?? []) {
    if (object === "whatsapp_business_account") {
      for (const change of entry?.changes ?? []) {
        const id = change?.value?.metadata?.phone_number_id;
        if (id) candidates.add(String(id));
      }
    } else if (entry?.id) {
      candidates.add(String(entry.id));
    }
  }

  const channel = object === "whatsapp_business_account" ? "whatsapp"
    : object === "instagram" ? "instagram"
    : "facebook";

  for (const externalId of candidates) {
    const account = await resolveAccount(cache, channel, externalId);
    if (!account?.app_secret_secret_name) continue;

    const secret = await accountAppSecret(account.id);
    if (secret && await verifyMetaSignature(rawBody, signatureHeader, secret)) {
      return true;
    }
  }

  return false;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);

  // -------------------------------------------------------------------------
  // Handshake de verificacion del webhook
  // -------------------------------------------------------------------------
  if (request.method === "GET") {
    return handleVerificationHandshake(url, META_VERIFY_TOKEN);
  }

  if (request.method !== "POST") {
    return new Response("Metodo no permitido", { status: 405 });
  }

  // -------------------------------------------------------------------------
  // Cuerpo crudo. Se leen los bytes antes de cualquier parseo, porque la firma
  // se calcula sobre ellos exactamente como llegaron.
  // -------------------------------------------------------------------------
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const signatureHeader = request.headers.get("x-hub-signature-256");

  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response("Cuerpo JSON invalido", { status: 400 });
  }

  const cache = new Map<string, ResolvedAccount | null>();

  // Canal desconocido: TikTok usa otro esquema de firma y todavia no esta
  // implementado. Se rechaza explicitamente en lugar de aceptarlo sin verificar.
  if (!signatureHeader) {
    console.warn("Evento sin cabecera de firma", { object: payload?.object });
    return new Response("Firma ausente", { status: 401 });
  }

  const verified = await verifyRequest(rawBody, signatureHeader, payload, cache);
  if (!verified) {
    console.warn("Firma invalida", { object: payload?.object });
    return new Response("Firma invalida", { status: 401 });
  }

  // -------------------------------------------------------------------------
  // Normalizar y encolar
  // -------------------------------------------------------------------------
  const events: NormalizedEvent[] = normalizeMetaPayload(payload);

  if (events.length === 0) {
    // Evento legitimo de un tipo que no procesamos. Se acepta para que Meta no
    // lo reintente indefinidamente.
    return Response.json({ status: "ignorado", motivo: "sin eventos aplicables" });
  }

  let queued = 0, duplicates = 0, unresolved = 0, failed = 0;

  for (const event of events) {
    const account = await resolveAccount(
      cache, event.channel, event.external_account_id,
    );

    if (!account) unresolved++;

    const { data, error } = await db.rpc("enqueue_inbound_event", {
      p_dedupe_key: dedupeKey(event),
      p_payload: event,
      p_channel: event.channel,
      p_channel_account_id: account?.id ?? null,
      p_tenant_id: account?.tenant_id ?? null,
      p_signature_verified: true,
    });

    if (error) {
      // No se corta el bucle: un evento problematico no debe impedir que se
      // encolen los demas del mismo lote.
      failed++;
      console.error("enqueue_inbound_event fallo", {
        dedupe: dedupeKey(event), error: error.message,
      });
      continue;
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      { event_id: string; was_duplicate: boolean } | null;

    if (row?.was_duplicate) duplicates++; else queued++;
  }

  // Se responde 200 incluso con fallos parciales: un 500 haria que Meta
  // reintentase todo el lote, incluidos los eventos ya encolados. Los fallos
  // quedan en el registro de la funcion y el evento perdido se detecta por el
  // hueco, no por un reintento que duplicaria trabajo.
  return Response.json({
    status: "recibido",
    encolados: queued,
    duplicados: duplicates,
    sin_cuenta: unresolved,
    fallidos: failed,
  });
});
