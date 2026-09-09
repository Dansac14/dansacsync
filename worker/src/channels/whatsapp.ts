// =============================================================================
// WhatsApp Cloud API
// =============================================================================
// Envio:    POST {base}/{version}/{phone_number_id}/messages
// Descarga: el webhook trae un id de medio, no una URL. Hay que pedir la URL a
//           la Graph API y despues descargarla con el token en la cabecera. Es
//           el unico canal de los cuatro que exige este doble paso.
// =============================================================================

import {
  ChannelError, classifyMetaError, fetchWithTimeout,
  type ChannelDriver, type MediaDownload, type MediaRef,
  type SendParams, type SendResult,
} from "./types.ts";

const MEDIA_KIND: Record<string, "image" | "video" | "audio" | "document" | "sticker"> = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "document",
  sticker: "sticker",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export function extensionForMime(mimeType: string): string {
  const clean = mimeType.split(";")[0]?.trim() ?? "";
  return EXTENSION_BY_MIME[clean] ?? "bin";
}

export const whatsappDriver: ChannelDriver = {
  channel: "whatsapp",

  async sendMessage({ account, token, recipientId, content, mediaType, mediaUrl }: SendParams): Promise<SendResult> {
    const endpoint =
      `${account.api_base_url}/${account.api_version}/${account.external_account_id}/messages`;

    const kind = MEDIA_KIND[mediaType];
    let body: Record<string, unknown>;

    if (kind && mediaUrl) {
      // WhatsApp acepta una URL publica y descarga el archivo el mismo. El pie
      // de foto va dentro del nodo del medio, no como mensaje aparte: si se
      // enviara aparte, el cliente veria dos mensajes en lugar de uno.
      const media: Record<string, unknown> = { link: mediaUrl };
      if (content && kind !== "sticker" && kind !== "audio") media.caption = content;

      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientId,
        type: kind,
        [kind]: media,
      };
    } else {
      if (!content || content.trim() === "") {
        throw new ChannelError("No hay nada que enviar: sin texto y sin archivo", {
          permanent: true,
        });
      }
      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientId,
        type: "text",
        // preview_url activa la tarjeta de vista previa cuando el texto lleva
        // un enlace, que es justo el caso de los enlaces de pago del catalogo.
        text: { body: content, preview_url: true },
      };
    }

    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) throw classifyMetaError(response.status, payload);

    return {
      channelMessageId: (payload as any)?.messages?.[0]?.id ?? null,
    };
  },

  async downloadMedia({ account, token, mediaExternalId }: MediaRef): Promise<MediaDownload> {
    if (!mediaExternalId) {
      throw new ChannelError("WhatsApp no entrego id de medio", { permanent: true });
    }

    // Paso 1: pedir la URL temporal del archivo.
    const metaEndpoint = `${account.api_base_url}/${account.api_version}/${mediaExternalId}`;
    const metaResponse = await fetchWithTimeout(metaEndpoint, {
      headers: { authorization: `Bearer ${token}` },
    });

    const metadata = await metaResponse.json().catch(() => null);
    if (!metaResponse.ok) throw classifyMetaError(metaResponse.status, metadata);

    const url = (metadata as any)?.url;
    const mimeType = (metadata as any)?.mime_type ?? "application/octet-stream";
    if (!url) {
      throw new ChannelError(
        `La Graph API no devolvio URL para el medio ${mediaExternalId}`,
        { permanent: true },
      );
    }

    // Paso 2: descargar. Esta URL tambien exige el token, aunque sea temporal.
    const fileResponse = await fetchWithTimeout(url, {
      headers: { authorization: `Bearer ${token}` },
    }, 60_000);

    if (!fileResponse.ok) {
      throw new ChannelError(
        `Descarga del medio ${mediaExternalId} fallo con HTTP ${fileResponse.status}`,
        { permanent: fileResponse.status < 500 && fileResponse.status !== 429,
          status: fileResponse.status },
      );
    }

    return {
      bytes: new Uint8Array(await fileResponse.arrayBuffer()),
      mimeType,
      fileName: `${mediaExternalId}.${extensionForMime(mimeType)}`,
    };
  },
};
