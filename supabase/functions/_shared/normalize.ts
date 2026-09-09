// =============================================================================
// Normalizacion de eventos entrantes
// =============================================================================
// WhatsApp, Messenger, Instagram y TikTok mandan tres formas de payload
// distintas. Toda esa variedad se traduce aqui a un unico sobre normalizado, y
// es ese sobre el que se guarda en la cola. Consecuencia practica: el worker no
// conoce el formato de Meta. El dia que Meta cambie una estructura, solo cambia
// este archivo.
//
// La especificacion original leia unicamente
// entry[0].changes[0].value.messages[0], es decir el primer mensaje del primer
// cambio de la primera entrada. Meta agrupa varios eventos en un mismo POST
// cuando llegan seguidos, asi que ese codigo descartaba mensajes de clientes
// reales en silencio. Aqui se recorren los tres niveles completos.
// =============================================================================

export type Channel = "whatsapp" | "instagram" | "facebook" | "tiktok";

export type MediaType =
  | "text" | "image" | "video" | "audio" | "document" | "sticker"
  | "location" | "contact_card" | "template" | "interactive" | "unsupported";

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface NormalizedMessage {
  kind: "message";
  channel: Channel;
  external_account_id: string;
  channel_user_id: string;
  message_id: string | null;
  timestamp_ms: number;
  content: string | null;
  media_type: MediaType;
  media_external_id: string | null;
  media_url: string | null;
  display_name: string | null;
  raw: unknown;
}

export interface NormalizedStatus {
  kind: "status";
  channel: Channel;
  external_account_id: string;
  channel_message_id: string;
  status: DeliveryStatus;
  timestamp_ms: number;
  error: string | null;
  raw: unknown;
}

export type NormalizedEvent = NormalizedMessage | NormalizedStatus;

// -----------------------------------------------------------------------------
// Tipos de medio
// -----------------------------------------------------------------------------

const WHATSAPP_MEDIA: Record<string, MediaType> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "audio",
  voice: "audio",
  document: "document",
  sticker: "sticker",
  location: "location",
  contacts: "contact_card",
  interactive: "interactive",
  button: "interactive",
  template: "template",
};

const META_ATTACHMENT_MEDIA: Record<string, MediaType> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
  // Instagram: menciones en historias y respuestas a historias llegan como
  // adjunto de tipo imagen con un contexto distinto.
  story_mention: "image",
  share: "unsupported",
  location: "location",
  fallback: "unsupported",
};

function asMillis(value: unknown, fallbackNow = true): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackNow ? Date.now() : 0;
  // WhatsApp envia segundos; Messenger e Instagram, milisegundos.
  return n < 1e12 ? n * 1000 : n;
}

// -----------------------------------------------------------------------------
// WhatsApp Cloud API
// -----------------------------------------------------------------------------
// object: "whatsapp_business_account"
// La cuenta se identifica por value.metadata.phone_number_id, que es lo que se
// busca en channel_accounts para saber a que empresa pertenece el mensaje.
// -----------------------------------------------------------------------------

function normalizeWhatsAppValue(value: any): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const accountId = value?.metadata?.phone_number_id;
  if (!accountId) return events;

  // El nombre de perfil viene en un array aparte, no dentro del mensaje.
  const namesByWaId = new Map<string, string>();
  for (const contact of value?.contacts ?? []) {
    if (contact?.wa_id && contact?.profile?.name) {
      namesByWaId.set(String(contact.wa_id), String(contact.profile.name));
    }
  }

  for (const msg of value?.messages ?? []) {
    const type = String(msg?.type ?? "unsupported");
    const mediaType = WHATSAPP_MEDIA[type] ?? "unsupported";
    const mediaNode = msg?.[type];

    let content: string | null = null;
    if (type === "text") {
      content = msg?.text?.body ?? null;
    } else if (type === "button") {
      content = msg?.button?.text ?? null;
    } else if (type === "interactive") {
      content = msg?.interactive?.button_reply?.title
        ?? msg?.interactive?.list_reply?.title
        ?? null;
    } else if (mediaNode?.caption) {
      // El pie de foto es texto del cliente y cuenta como contenido.
      content = String(mediaNode.caption);
    }

    events.push({
      kind: "message",
      channel: "whatsapp",
      external_account_id: String(accountId),
      channel_user_id: String(msg?.from ?? ""),
      message_id: msg?.id ? String(msg.id) : null,
      timestamp_ms: asMillis(msg?.timestamp),
      content,
      media_type: mediaType,
      // WhatsApp no manda la URL del archivo: manda un id que hay que
      // canjear contra la Graph API con el token de la cuenta.
      media_external_id: mediaNode?.id ? String(mediaNode.id) : null,
      media_url: null,
      display_name: namesByWaId.get(String(msg?.from)) ?? null,
      raw: msg,
    });
  }

  // Acuses de entrega y lectura de los mensajes que enviamos.
  for (const status of value?.statuses ?? []) {
    const mapped = String(status?.status ?? "");
    const known: DeliveryStatus | null =
      mapped === "sent" ? "sent"
      : mapped === "delivered" ? "delivered"
      : mapped === "read" ? "read"
      : mapped === "failed" ? "failed"
      : null;

    if (!known || !status?.id) continue;

    events.push({
      kind: "status",
      channel: "whatsapp",
      external_account_id: String(accountId),
      channel_message_id: String(status.id),
      status: known,
      timestamp_ms: asMillis(status?.timestamp),
      error: status?.errors?.[0]?.title
        ? `${status.errors[0].code ?? ""} ${status.errors[0].title}`.trim()
        : null,
      raw: status,
    });
  }

  return events;
}

// -----------------------------------------------------------------------------
// Messenger e Instagram
// -----------------------------------------------------------------------------
// Comparten la estructura entry[].messaging[]. Se distinguen por payload.object:
// "page" es Messenger, "instagram" es Instagram. La cuenta se identifica por
// entry[].id (page id o id de la cuenta profesional de Instagram).
// -----------------------------------------------------------------------------

function normalizeMessagingEntry(entry: any, channel: Channel): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const accountId = entry?.id;
  if (!accountId) return events;

  for (const m of entry?.messaging ?? []) {
    const timestamp = asMillis(m?.timestamp);

    // is_echo marca los mensajes que enviamos nosotros y Meta nos devuelve.
    // Sin este descarte el bot se responderia a si mismo en bucle.
    if (m?.message?.is_echo) continue;

    if (m?.message) {
      const attachment = m.message.attachments?.[0];
      const mediaType: MediaType = attachment
        ? (META_ATTACHMENT_MEDIA[String(attachment.type)] ?? "unsupported")
        : "text";

      events.push({
        kind: "message",
        channel,
        external_account_id: String(accountId),
        channel_user_id: String(m?.sender?.id ?? ""),
        message_id: m.message.mid ? String(m.message.mid) : null,
        timestamp_ms: timestamp,
        content: m.message.text ?? null,
        media_type: mediaType,
        media_external_id: null,
        // Messenger e Instagram si mandan URL directa, pero firmada y con
        // caducidad: hay que descargarla pronto y guardarla.
        media_url: attachment?.payload?.url ? String(attachment.payload.url) : null,
        display_name: null,
        raw: m,
      });
      continue;
    }

    // Botones y menus persistentes.
    if (m?.postback) {
      events.push({
        kind: "message",
        channel,
        external_account_id: String(accountId),
        channel_user_id: String(m?.sender?.id ?? ""),
        message_id: m.postback.mid ? String(m.postback.mid) : null,
        timestamp_ms: timestamp,
        content: m.postback.title ?? m.postback.payload ?? null,
        media_type: "interactive",
        media_external_id: null,
        media_url: null,
        display_name: null,
        raw: m,
      });
      continue;
    }

    // Acuse de entrega: llega con la lista de mids entregados.
    if (m?.delivery?.mids) {
      for (const mid of m.delivery.mids) {
        events.push({
          kind: "status", channel,
          external_account_id: String(accountId),
          channel_message_id: String(mid),
          status: "delivered",
          timestamp_ms: timestamp,
          error: null,
          raw: m,
        });
      }
      continue;
    }

    // Acuse de lectura: no identifica mensajes, solo dice hasta que momento
    // leyo el usuario. Se resuelve en el worker contra la conversacion.
    if (m?.read) {
      events.push({
        kind: "status", channel,
        external_account_id: String(accountId),
        channel_message_id: `read:${m?.sender?.id}:${m.read.watermark}`,
        status: "read",
        timestamp_ms: timestamp,
        error: null,
        raw: m,
      });
    }
  }

  return events;
}

// -----------------------------------------------------------------------------
// Punto de entrada
// -----------------------------------------------------------------------------

export function normalizeMetaPayload(payload: any): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const object = String(payload?.object ?? "");

  for (const entry of payload?.entry ?? []) {
    if (object === "whatsapp_business_account") {
      for (const change of entry?.changes ?? []) {
        if (change?.field && change.field !== "messages") continue;
        events.push(...normalizeWhatsAppValue(change?.value));
      }
      continue;
    }

    if (object === "instagram") {
      events.push(...normalizeMessagingEntry(entry, "instagram"));
      continue;
    }

    if (object === "page") {
      events.push(...normalizeMessagingEntry(entry, "facebook"));
      continue;
    }

    // Instagram con Facebook Login puede llegar con object "page" y los
    // eventos dentro de changes[].value en lugar de messaging[].
    for (const change of entry?.changes ?? []) {
      if (change?.field === "messages" && change?.value?.messaging) {
        events.push(...normalizeMessagingEntry(
          { id: entry.id, messaging: change.value.messaging },
          object === "instagram" ? "instagram" : "facebook",
        ));
      }
    }
  }

  return events;
}

/**
 * Clave de deduplicacion.
 *
 * Meta reintenta el mismo POST hasta recibir un 200, asi que la clave tiene que
 * depender solo del contenido del evento y nunca del momento de recepcion.
 * Incluye la cuenta porque dos empresas distintas podrian, en teoria, recibir
 * ids de mensaje que colisionen.
 */
export function dedupeKey(event: NormalizedEvent): string {
  if (event.kind === "status") {
    return `${event.channel}:${event.external_account_id}:status:${event.channel_message_id}:${event.status}`;
  }
  if (event.message_id) {
    return `${event.channel}:${event.external_account_id}:msg:${event.message_id}`;
  }
  // Un mensaje sin id es anomalo. Se compone una clave estable con lo que hay
  // para no perderlo, en lugar de descartarlo.
  return `${event.channel}:${event.external_account_id}:raw:${event.channel_user_id}:${event.timestamp_ms}`;
}
