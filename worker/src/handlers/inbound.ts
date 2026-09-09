// =============================================================================
// Procesamiento de un evento entrante
// =============================================================================
// Orden de operaciones, y el motivo de cada paso:
//
//   1. Guardar el mensaje.       Primero, siempre. Si el proceso muere despues,
//                                el mensaje del cliente ya esta en la bandeja y
//                                un operador puede atenderlo a mano.
//   2. Guardar el archivo.       Las URLs de los canales caducan en minutos.
//   3. Respetar el modo humano.  Si un operador tomo el hilo, el bot calla.
//   4. Consultar la IA.
//   5. Encolar la respuesta.     Nunca se envia desde aqui: se encola, para que
//                                un fallo del canal se reintente solo.
// =============================================================================

import {
  db, getChannelAccount, completeInboundEvent, failInboundEvent,
  type InboundEvent,
} from "../db.ts";
import { ChannelError } from "../channels/types.ts";
import { storeIncomingMedia } from "../media.ts";
import { runAiPipeline } from "../ai/pipeline.ts";
import { log, describeError } from "../logger.ts";

interface NormalizedMessage {
  kind: "message";
  channel: string;
  external_account_id: string;
  channel_user_id: string;
  message_id: string | null;
  timestamp_ms: number;
  content: string | null;
  media_type: string;
  media_external_id: string | null;
  media_url: string | null;
  display_name: string | null;
}

interface NormalizedStatus {
  kind: "status";
  channel: string;
  external_account_id: string;
  channel_message_id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp_ms: number;
  error: string | null;
}

interface IngestResult {
  contact_id: string;
  conversation_id: string;
  message_id: string;
  handling_mode: "bot" | "human";
  is_duplicate: boolean;
  is_new_contact: boolean;
}

export async function processInboundEvent(event: InboundEvent): Promise<void> {
  const payload = event.payload as unknown as NormalizedMessage | NormalizedStatus;

  // Un evento cuya cuenta de canal no esta dada de alta no se puede atribuir a
  // ninguna empresa. Se cierra como definitivo en lugar de reintentarlo cinco
  // veces: la fila queda con tenant_id nulo y el indice de diagnostico la
  // encuentra, que es como se detecta un canal mal configurado.
  if (!event.channel_account_id) {
    await killEvent(
      event.id,
      `Cuenta de canal ${payload.channel}:${payload.external_account_id} no registrada en channel_accounts`,
    );
    log.warn("Evento sin cuenta de canal registrada", {
      eventId: event.id,
      channel: payload.channel,
      externalAccountId: payload.external_account_id,
    });
    return;
  }

  try {
    const account = await getChannelAccount(event.channel_account_id);

    if (payload.kind === "status") {
      await applyStatus(event, payload, account.id);
      await completeInboundEvent(event.id);
      return;
    }

    // -----------------------------------------------------------------------
    // 1. Contacto, conversacion y mensaje, en una transaccion
    // -----------------------------------------------------------------------
    const { data, error } = await db.rpc("ingest_inbound_message", {
      p_channel_account_id: account.id,
      p_channel_user_id: payload.channel_user_id,
      p_channel_message_id: payload.message_id,
      p_content: payload.content,
      p_media_type: payload.media_type,
      p_media_url: null,
      p_media_external_id: payload.media_external_id,
      p_display_name: payload.display_name,
      p_payload: { channel: payload.channel, received_ms: payload.timestamp_ms },
      p_sent_at: new Date(payload.timestamp_ms).toISOString(),
    });

    if (error) throw new Error(`ingest_inbound_message: ${error.message}`);

    const result = (Array.isArray(data) ? data[0] : data) as IngestResult | null;
    if (!result) throw new Error("ingest_inbound_message no devolvio resultado");

    if (result.is_duplicate) {
      // Reintento de Meta sobre un mensaje ya procesado. Se cierra sin hacer
      // nada mas: volver a llamar a la IA le mandaria al cliente una segunda
      // respuesta a la misma pregunta.
      log.info("Evento duplicado descartado", {
        eventId: event.id, messageId: result.message_id,
      });
      await completeInboundEvent(event.id);
      return;
    }

    log.info("Mensaje entrante registrado", {
      eventId: event.id,
      tenantId: account.tenant_id,
      conversationId: result.conversation_id,
      messageId: result.message_id,
      channel: account.channel,
      nuevoContacto: result.is_new_contact,
      mediaType: payload.media_type,
    });

    // -----------------------------------------------------------------------
    // 2. Archivo adjunto
    // -----------------------------------------------------------------------
    if (payload.media_external_id || payload.media_url) {
      try {
        const stored = await storeIncomingMedia({
          account,
          tenantId: account.tenant_id,
          conversationId: result.conversation_id,
          messageId: result.message_id,
          mediaExternalId: payload.media_external_id,
          mediaUrl: payload.media_url,
        });

        if (stored) {
          await db.from("messages")
            .update({ media_url: stored.path, media_mime_type: stored.mimeType })
            .eq("id", result.message_id);
        }
      } catch (mediaError) {
        // El archivo se perdio, pero el mensaje esta guardado y la conversacion
        // sigue. Se anota el problema en el mensaje para que el operador sepa
        // que habia un adjunto que no se pudo recuperar.
        const detail = describeError(mediaError);
        log.error("No se pudo guardar el adjunto", {
          messageId: result.message_id, error: detail,
        });
        await db.from("messages")
          .update({ error_text: `Adjunto no recuperado: ${detail}`.slice(0, 500) })
          .eq("id", result.message_id);
      }
    }

    // -----------------------------------------------------------------------
    // 3. Modo humano
    // -----------------------------------------------------------------------
    if (result.handling_mode === "human") {
      log.info("Conversacion en control humano: el agente no interviene", {
        conversationId: result.conversation_id,
      });
      await completeInboundEvent(event.id);
      return;
    }

    // -----------------------------------------------------------------------
    // 4. Agente de IA
    // -----------------------------------------------------------------------
    const outcome = await runAiPipeline({
      tenantId: account.tenant_id,
      conversationId: result.conversation_id,
      inboundMessageId: result.message_id,
      userText: payload.content ?? "",
    });

    if (outcome.action === "silent") {
      log.info("El agente no responde", {
        conversationId: result.conversation_id, motivo: outcome.reason,
      });
      await completeInboundEvent(event.id);
      return;
    }

    // -----------------------------------------------------------------------
    // 5. Escalado y respuesta
    // -----------------------------------------------------------------------
    // El escalado va ANTES de encolar la respuesta. Asi, si el cliente escribe
    // otra vez de inmediato, su segundo mensaje ya encuentra la conversacion en
    // modo humano y el bot no vuelve a contestar encima del operador.
    if (outcome.action === "escalate") {
      const { error: escalateError } = await db.rpc("escalate_conversation", {
        p_conversation_id: result.conversation_id,
        p_reason: outcome.reason.slice(0, 60),
      });
      if (escalateError) {
        throw new Error(`escalate_conversation: ${escalateError.message}`);
      }
      log.info("Conversacion escalada a operador", {
        conversationId: result.conversation_id, motivo: outcome.reason,
      });
    }

    const { error: enqueueError } = await db.rpc("enqueue_outbound_message", {
      p_conversation_id: result.conversation_id,
      p_content: outcome.text,
      p_sender_type: "bot",
      p_sender_user_id: null,
      p_media_type: "text",
      p_media_url: null,
      p_payload: { origen: "agente_ia", motivo: outcome.action },
    });

    if (enqueueError) {
      throw new Error(`enqueue_outbound_message: ${enqueueError.message}`);
    }

    await completeInboundEvent(event.id);
  } catch (error) {
    const detail = describeError(error);

    if (error instanceof ChannelError && error.permanent) {
      await killEvent(event.id, detail);
      log.error("Evento descartado por error permanente", { eventId: event.id, error: detail });
      return;
    }

    await failInboundEvent(event.id, detail);
    log.error("Evento fallido, se reintentara", {
      eventId: event.id, intento: event.attempts, error: detail,
    });
  }
}

// -----------------------------------------------------------------------------
// Acuses de entrega
// -----------------------------------------------------------------------------

async function applyStatus(
  event: InboundEvent,
  payload: NormalizedStatus,
  accountId: string,
): Promise<void> {
  // Messenger e Instagram no dicen que mensaje se leyo: mandan una marca de
  // tiempo. La clave sintetica que genero el webhook lo indica.
  if (payload.channel_message_id.startsWith("read:")) {
    const [, channelUserId, watermark] = payload.channel_message_id.split(":");
    if (!channelUserId || !watermark) return;

    const { data, error } = await db.rpc("apply_read_watermark", {
      p_channel_account_id: accountId,
      p_channel_user_id: channelUserId,
      p_watermark: new Date(Number(watermark)).toISOString(),
    });

    if (error) throw new Error(`apply_read_watermark: ${error.message}`);
    log.debug("Marca de lectura aplicada", { eventId: event.id, mensajes: data });
    return;
  }

  const { error } = await db.rpc("apply_delivery_status", {
    p_channel_account_id: accountId,
    p_channel_message_id: payload.channel_message_id,
    p_status: payload.status,
    p_error: payload.error,
  });

  if (error) throw new Error(`apply_delivery_status: ${error.message}`);
}

async function killEvent(eventId: string, reason: string): Promise<void> {
  const { error } = await db.rpc("kill_inbound_event", {
    p_event_id: eventId,
    p_error: reason,
  });
  if (error) log.error("No se pudo cerrar el evento", { eventId, error: error.message });
}
