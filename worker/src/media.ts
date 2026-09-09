// =============================================================================
// Archivos que llegan por los canales
// =============================================================================
// Hay una ventana muy corta para quedarse con un archivo entrante:
//
//   WhatsApp entrega un id que se canjea por una URL temporal.
//   Messenger e Instagram entregan una URL firmada que caduca en minutos.
//
// Si no se descarga al recibir el evento, el archivo se pierde y la
// conversacion queda con un hueco que no se puede reconstruir. Por eso esto
// ocurre en el mismo paso que la ingesta y no en un proceso posterior.
// =============================================================================

import { db, getAccessToken, type ChannelAccount } from "./db.ts";
import { driverFor } from "./channels/registry.ts";
import { ChannelError } from "./channels/types.ts";
import { log } from "./logger.ts";

const BUCKET = "channel-media";
const MAX_BYTES = 100 * 1024 * 1024;

export interface StoredMedia {
  /** Ruta dentro del bucket. El frontend pide una URL firmada con ella. */
  path: string;
  mimeType: string;
  bytes: number;
}

/**
 * Descarga el archivo del canal y lo guarda en Supabase Storage.
 *
 * Convencion de ruta: <tenant_id>/<conversation_id>/<message_id>.<ext>
 * El primer segmento es el tenant porque es lo que usa la politica de acceso
 * del bucket para aislar a cada empresa.
 */
export async function storeIncomingMedia(params: {
  account: ChannelAccount;
  tenantId: string;
  conversationId: string;
  messageId: string;
  mediaExternalId: string | null;
  mediaUrl: string | null;
}): Promise<StoredMedia | null> {
  const { account, tenantId, conversationId, messageId } = params;

  if (!params.mediaExternalId && !params.mediaUrl) return null;

  const driver = driverFor(account.channel);
  const token = await getAccessToken(account);

  const file = await driver.downloadMedia({
    account,
    token,
    mediaExternalId: params.mediaExternalId,
    mediaUrl: params.mediaUrl,
  });

  if (file.bytes.byteLength === 0) {
    throw new ChannelError("El canal devolvio un archivo vacio", { permanent: true });
  }
  if (file.bytes.byteLength > MAX_BYTES) {
    throw new ChannelError(
      `El archivo pesa ${file.bytes.byteLength} bytes y supera el limite de ${MAX_BYTES}`,
      { permanent: true },
    );
  }

  const extension = file.fileName.split(".").pop() ?? "bin";
  const path = `${tenantId}/${conversationId}/${messageId}.${extension}`;

  const { error } = await db.storage.from(BUCKET).upload(path, file.bytes, {
    contentType: file.mimeType,
    // Un reintento del mismo evento debe sobrescribir, no fallar por duplicado.
    upsert: true,
  });

  if (error) {
    // Fallo de almacenamiento: transitorio. El mensaje ya esta guardado, asi
    // que el reintento solo repite la descarga y la subida.
    throw new ChannelError(`No se pudo guardar el archivo: ${error.message}`, {
      permanent: false,
    });
  }

  log.info("Archivo entrante guardado", {
    tenantId, messageId, path, bytes: file.bytes.byteLength, mimeType: file.mimeType,
  });

  return { path, mimeType: file.mimeType, bytes: file.bytes.byteLength };
}
