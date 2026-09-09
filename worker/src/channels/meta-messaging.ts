// =============================================================================
// Messenger e Instagram (Send API)
// =============================================================================
// Los dos canales comparten formato de envio:
//   POST {base}/{version}/{account_id}/messages
//   { recipient: { id }, message: { text } | { attachment }, messaging_type }
//
// La diferencia esta en el host y en el token, y viene de como se conecto la
// cuenta. Por eso api_base_url es una columna de channel_accounts y no una
// constante del codigo:
//
//   Messenger                      -> graph.facebook.com  + token de pagina
//   Instagram con Facebook Login   -> graph.facebook.com  + token de pagina
//   Instagram con Instagram Login  -> graph.instagram.com + token de usuario IG
//
// Elegir uno solo en el codigo obligaria a rehacer el envio el dia que llegue
// un cliente conectado de la otra forma.
// =============================================================================

import {
  ChannelError, classifyMetaError, fetchWithTimeout,
  type ChannelDriver, type MediaDownload, type MediaRef,
  type SendParams, type SendResult,
} from "./types.ts";
import { extensionForMime } from "./whatsapp.ts";
import type { Channel } from "../db.ts";

const ATTACHMENT_KIND: Record<string, "image" | "video" | "audio" | "file"> = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "file",
  sticker: "image",
};

function buildDriver(channel: Channel): ChannelDriver {
  return {
    channel,

    async sendMessage({ account, token, recipientId, content, mediaType, mediaUrl }: SendParams): Promise<SendResult> {
      const endpoint =
        `${account.api_base_url}/${account.api_version}/${account.external_account_id}/messages`;

      const kind = ATTACHMENT_KIND[mediaType];
      const messages: Record<string, unknown>[] = [];

      if (kind && mediaUrl) {
        messages.push({
          attachment: {
            type: kind,
            payload: { url: mediaUrl, is_reusable: true },
          },
        });
        // A diferencia de WhatsApp, aqui el adjunto no admite pie de foto: el
        // texto tiene que ir como un segundo mensaje.
        if (content && content.trim() !== "") messages.push({ text: content });
      } else {
        if (!content || content.trim() === "") {
          throw new ChannelError("No hay nada que enviar: sin texto y sin archivo", {
            permanent: true,
          });
        }
        messages.push({ text: content });
      }

      let lastId: string | null = null;

      for (const message of messages) {
        const response = await fetchWithTimeout(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            // RESPONSE declara que se contesta a un mensaje del usuario, que es
            // siempre el caso aqui: el bot y el operador responden, no inician.
            messaging_type: "RESPONSE",
            message,
          }),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) throw classifyMetaError(response.status, payload);

        lastId = (payload as any)?.message_id ?? lastId;
      }

      return { channelMessageId: lastId };
    },

    async downloadMedia({ mediaUrl }: MediaRef): Promise<MediaDownload> {
      // Messenger e Instagram entregan una URL ya firmada. No lleva token, y
      // caduca en minutos: hay que descargarla en cuanto llega el evento.
      if (!mediaUrl) {
        throw new ChannelError(`${channel} no entrego URL del adjunto`, {
          permanent: true,
        });
      }

      const response = await fetchWithTimeout(mediaUrl, {}, 60_000);
      if (!response.ok) {
        const expired = response.status === 403 || response.status === 404;
        throw new ChannelError(
          expired
            ? `La URL del adjunto ya caduco (HTTP ${response.status})`
            : `Descarga del adjunto fallo con HTTP ${response.status}`,
          { permanent: expired, status: response.status },
        );
      }

      const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
      const bytes = new Uint8Array(await response.arrayBuffer());

      return {
        bytes,
        mimeType,
        fileName: `${channel}-${Date.now()}.${extensionForMime(mimeType)}`,
      };
    },
  };
}

export const messengerDriver = buildDriver("facebook");
export const instagramDriver = buildDriver("instagram");
