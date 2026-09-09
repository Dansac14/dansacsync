// =============================================================================
// Contrato de un canal
// =============================================================================
// Cada canal implementa esta interfaz y el resto del worker no sabe nada de
// Meta ni de TikTok. Anadir un canal nuevo es escribir un archivo y registrarlo.
// =============================================================================

import type { ChannelAccount, Channel } from "../db.ts";

export interface SendParams {
  account: ChannelAccount;
  token: string;
  /** Identificador del destinatario en el canal (wa_id, PSID, IGSID). */
  recipientId: string;
  content: string | null;
  mediaType: string;
  mediaUrl: string | null;
}

export interface SendResult {
  /** Id que devuelve el canal, para poder cruzar despues los acuses de entrega. */
  channelMessageId: string | null;
}

export interface MediaRef {
  account: ChannelAccount;
  token: string;
  mediaExternalId: string | null;
  mediaUrl: string | null;
}

export interface MediaDownload {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface ChannelDriver {
  channel: Channel;
  sendMessage(params: SendParams): Promise<SendResult>;
  downloadMedia(ref: MediaRef): Promise<MediaDownload>;
}

// -----------------------------------------------------------------------------
// Errores
// -----------------------------------------------------------------------------
// La distincion entre permanente y transitorio no es cosmetica: decide si el
// trabajo se reintenta. Reintentar cinco veces un mensaje que Meta rechaza por
// estar fuera de la ventana de 24 horas retrasa toda la cola y no cambia el
// resultado. Y darse por vencido ante un 503 pierde un mensaje que habria
// salido al segundo intento.
// -----------------------------------------------------------------------------

export class ChannelError extends Error {
  readonly permanent: boolean;
  readonly status: number | null;
  readonly channelCode: string | null;

  constructor(
    message: string,
    options: { permanent: boolean; status?: number | null; channelCode?: string | null },
  ) {
    super(message);
    this.name = "ChannelError";
    this.permanent = options.permanent;
    this.status = options.status ?? null;
    this.channelCode = options.channelCode ?? null;
  }
}

/**
 * Clasifica una respuesta HTTP de la Graph API.
 *
 * Transitorio: 429 y 5xx, mas los codigos de limite de tasa de Meta.
 * Permanente: el resto de los 4xx. Un token invalido, un destinatario que
 * bloqueo la cuenta o un mensaje fuera de la ventana de servicio no mejoran
 * porque se reintenten.
 */
export function classifyMetaError(
  status: number,
  body: unknown,
): ChannelError {
  const error = (body as any)?.error ?? {};
  const code = error.code != null ? String(error.code) : null;
  const subcode = error.error_subcode != null ? String(error.error_subcode) : null;
  const detail = error.message ?? `HTTP ${status}`;

  // Limites de tasa de Meta: 4 (aplicacion), 80007 y 130429 (cuenta o numero),
  // 613 (llamadas por hora). Todos se resuelven esperando.
  const rateLimited = ["4", "80007", "130429", "613"].includes(code ?? "");
  const transient = status === 429 || status >= 500 || rateLimited;

  const parts = [detail];
  if (code) parts.push(`code=${code}`);
  if (subcode) parts.push(`subcode=${subcode}`);

  return new ChannelError(parts.join(" · "), {
    permanent: !transient,
    status,
    channelCode: code,
  });
}

/** Timeout para no dejar un trabajo tomado si el canal no responde nunca. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ChannelError(`El canal no respondio en ${timeoutMs} ms`, {
        permanent: false,
      });
    }
    // Fallo de red: siempre transitorio.
    throw new ChannelError(
      `Error de red al llamar al canal: ${error instanceof Error ? error.message : String(error)}`,
      { permanent: false },
    );
  } finally {
    clearTimeout(timer);
  }
}
