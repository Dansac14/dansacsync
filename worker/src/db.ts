// =============================================================================
// Acceso a datos del worker
// =============================================================================
// El worker usa service_role, que ignora la RLS. Es lo correcto y a la vez lo
// mas delicado del sistema: aqui no hay red de seguridad de Postgres, asi que
// cada consulta filtra por lo que corresponde de forma explicita.
//
// Ninguna de estas funciones se llama desde el navegador: este proceso corre en
// un servidor y la clave de servicio nunca sale de el.
// =============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import { log } from "./logger.ts";

export const db: SupabaseClient = createClient(
  config.supabaseUrl,
  config.serviceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// -----------------------------------------------------------------------------
// Tipos que reflejan el esquema
// -----------------------------------------------------------------------------

export type Channel = "whatsapp" | "instagram" | "facebook" | "tiktok";

export interface ChannelAccount {
  id: string;
  tenant_id: string;
  channel: Channel;
  external_account_id: string;
  display_name: string;
  api_base_url: string;
  api_version: string;
  phone_number: string | null;
  page_id: string | null;
  access_token_secret_name: string | null;
  is_active: boolean;
}

export interface InboundEvent {
  id: string;
  tenant_id: string | null;
  channel_account_id: string | null;
  channel: Channel | null;
  dedupe_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface OutboundJob {
  id: string;
  tenant_id: string;
  message_id: string;
  conversation_id: string;
  attempts: number;
  max_attempts: number;
}

export interface OutboundContext {
  job: OutboundJob;
  account: ChannelAccount;
  recipientId: string;
  content: string | null;
  mediaType: string;
  mediaUrl: string | null;
  serviceWindowExpiresAt: string | null;
}

// -----------------------------------------------------------------------------
// Colas
// -----------------------------------------------------------------------------

export async function claimInboundEvents(limit: number): Promise<InboundEvent[]> {
  const { data, error } = await db.rpc("claim_inbound_events", {
    p_worker_id: config.workerId,
    p_limit: limit,
  });
  if (error) throw new Error(`claim_inbound_events: ${error.message}`);
  return (data ?? []) as InboundEvent[];
}

export async function completeInboundEvent(eventId: string): Promise<void> {
  const { error } = await db.rpc("complete_inbound_event", { p_event_id: eventId });
  if (error) log.error("No se pudo cerrar el evento", { eventId, error: error.message });
}

export async function failInboundEvent(eventId: string, reason: string): Promise<void> {
  const { error } = await db.rpc("fail_inbound_event", {
    p_event_id: eventId,
    p_error: reason,
  });
  if (error) log.error("No se pudo marcar el fallo del evento", { eventId, error: error.message });
}

export async function claimOutboundJobs(limit: number): Promise<OutboundJob[]> {
  const { data, error } = await db.rpc("claim_outbound_jobs", {
    p_worker_id: config.workerId,
    p_limit: limit,
  });
  if (error) throw new Error(`claim_outbound_jobs: ${error.message}`);
  return (data ?? []) as OutboundJob[];
}

export async function completeOutboundJob(
  jobId: string,
  channelMessageId: string | null,
): Promise<void> {
  const { error } = await db.rpc("complete_outbound_job", {
    p_job_id: jobId,
    p_channel_message_id: channelMessageId,
  });

  // Si el cierre falla, el mensaje YA salio al cliente pero la fila queda en
  // 'processing' y ninguna consulta la vuelve a recoger: el operador veria
  // "enviando…" para siempre. Se registra como error grave; el recuperador
  // periodico la devolvera a la cola y el reintento la cerrara.
  if (error) {
    log.error("El mensaje salio pero no se pudo cerrar su trabajo", {
      jobId, channelMessageId, error: error.message,
    });
  }
}

export async function failOutboundJob(jobId: string, reason: string): Promise<void> {
  const { error } = await db.rpc("fail_outbound_job", {
    p_job_id: jobId,
    p_error: reason,
  });
  if (error) log.error("No se pudo marcar el fallo del envio", { jobId, error: error.message });
}

// -----------------------------------------------------------------------------
// Cuentas de canal y secretos
// -----------------------------------------------------------------------------
// Las cuentas cambian muy poco y se consultan en cada evento, asi que se
// guardan en memoria un rato. El TTL es corto a proposito: si un administrador
// desconecta un canal, el worker debe dejar de usarlo en menos de un minuto.
// -----------------------------------------------------------------------------

const ACCOUNT_TTL_MS = 60_000;
const SECRET_TTL_MS = 300_000;

const accountCache = new Map<string, { value: ChannelAccount; expires: number }>();
const secretCache = new Map<string, { value: string; expires: number }>();

export async function getChannelAccount(accountId: string): Promise<ChannelAccount> {
  const cached = accountCache.get(accountId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const { data, error } = await db
    .from("channel_accounts")
    .select("id, tenant_id, channel, external_account_id, display_name, api_base_url, api_version, phone_number, page_id, access_token_secret_name, is_active")
    .eq("id", accountId)
    .single();

  if (error) throw new Error(`No se pudo leer la cuenta de canal ${accountId}: ${error.message}`);

  const account = data as ChannelAccount;
  if (!account.is_active) {
    throw new Error(`La cuenta de canal ${account.display_name} esta desactivada`);
  }

  accountCache.set(accountId, { value: account, expires: Date.now() + ACCOUNT_TTL_MS });
  return account;
}

/**
 * Token de acceso de una cuenta.
 *
 * Prioridad: el token propio de la cuenta guardado en Vault y, si no tiene uno,
 * el token de la aplicacion del SaaS. Si no hay ninguno de los dos se lanza un
 * error en lugar de intentar el envio: una llamada sin credencial devuelve un
 * 401 que consumiria un reintento sin aportar informacion.
 */
export async function getAccessToken(account: ChannelAccount): Promise<string> {
  if (account.access_token_secret_name) {
    const key = `${account.id}:access_token`;
    const cached = secretCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    const { data, error } = await db.rpc("get_channel_secret", {
      p_channel_account_id: account.id,
      p_kind: "access_token",
    });

    if (error) {
      throw new Error(`No se pudo leer el token de ${account.display_name}: ${error.message}`);
    }
    if (typeof data === "string" && data.length > 0) {
      secretCache.set(key, { value: data, expires: Date.now() + SECRET_TTL_MS });
      return data;
    }
  }

  if (config.metaSystemUserToken) return config.metaSystemUserToken;

  throw new Error(
    `La cuenta ${account.display_name} no tiene token propio en Vault y no hay ` +
    `META_SYSTEM_USER_TOKEN configurado`,
  );
}

/**
 * Devuelve a la cola los trabajos que quedaron tomados por un worker que murio.
 * El plazo lo decide la base (5 minutos por defecto), no el cliente.
 */
export async function requeueStaleJobs(): Promise<{ entrada: number; salida: number }> {
  const { data, error } = await db.rpc("requeue_stale_jobs");
  if (error) throw new Error(`requeue_stale_jobs: ${error.message}`);

  const fila = (Array.isArray(data) ? data[0] : data) as
    { entrada: number; salida: number } | null;

  return { entrada: fila?.entrada ?? 0, salida: fila?.salida ?? 0 };
}

/** Se llama al desactivar una cuenta o rotar un token, para no servir datos viejos. */
export function invalidateAccountCache(accountId?: string): void {
  if (accountId) {
    accountCache.delete(accountId);
    secretCache.delete(`${accountId}:access_token`);
    return;
  }
  accountCache.clear();
  secretCache.clear();
}
