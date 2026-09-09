// =============================================================================
// Despacho de un mensaje saliente
// =============================================================================
// Todo lo que sale del sistema pasa por aqui, venga del agente o de un
// operador. Ninguna otra parte del codigo llama a la API de un canal.
// =============================================================================

import {
  db, getChannelAccount, getAccessToken,
  completeOutboundJob, failOutboundJob,
  type OutboundJob,
} from "../db.ts";
import { driverFor } from "../channels/registry.ts";
import { ChannelError } from "../channels/types.ts";
import { log, describeError } from "../logger.ts";

interface DispatchContext {
  message_id: string;
  tenant_id: string;
  conversation_id: string;
  channel_account_id: string;
  channel: "whatsapp" | "instagram" | "facebook" | "tiktok";
  recipient_id: string;
  content: string | null;
  media_type: string;
  media_url: string | null;
  service_window_expires_at: string | null;
  handling_mode: "bot" | "human";
}

const MEDIA_BUCKET = "channel-media";
const SIGNED_URL_TTL_SECONDS = 3600;

export async function processOutboundJob(job: OutboundJob): Promise<void> {
  try {
    const { data, error } = await db.rpc("outbound_dispatch_context", {
      p_job_id: job.id,
    });
    if (error) throw new Error(`outbound_dispatch_context: ${error.message}`);

    const ctx = (Array.isArray(data) ? data[0] : data) as DispatchContext | null;
    if (!ctx) {
      // El mensaje o la conversacion se borraron entre el encolado y el envio.
      // No hay nada que enviar y reintentar no lo va a resucitar.
      await killJob(job.id, "El mensaje ya no existe");
      return;
    }

    const account = await getChannelAccount(ctx.channel_account_id);
    const token = await getAccessToken(account);
    const driver = driverFor(ctx.channel);

    // -----------------------------------------------------------------------
    // Ventana de servicio de 24 horas
    // -----------------------------------------------------------------------
    // WhatsApp solo permite mensajes libres mientras la ventana este abierta.
    // Fuera de ella hay que usar una plantilla aprobada. Comprobarlo antes de
    // llamar evita un rechazo que consumiria un intento y, sobre todo, deja en
    // el mensaje un motivo entendible en lugar de un codigo de error de Meta.
    if (ctx.channel === "whatsapp" && ctx.service_window_expires_at) {
      const expires = new Date(ctx.service_window_expires_at).getTime();
      if (Number.isFinite(expires) && expires < Date.now()) {
        await killJob(
          job.id,
          "La ventana de servicio de 24 h de WhatsApp esta cerrada: este mensaje " +
          "requiere una plantilla aprobada por Meta",
        );
        log.warn("Envio bloqueado por ventana de servicio cerrada", {
          conversationId: ctx.conversation_id, messageId: ctx.message_id,
        });
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Archivos
    // -----------------------------------------------------------------------
    // En la base, media_url guarda una ruta del bucket privado. Los canales
    // necesitan una URL a la que ellos puedan entrar, asi que se firma en el
    // momento del envio y con caducidad corta.
    let mediaUrl = ctx.media_url;
    if (mediaUrl && !mediaUrl.startsWith("http")) {
      const { data: signed, error: signError } = await db.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(mediaUrl, SIGNED_URL_TTL_SECONDS);

      if (signError || !signed?.signedUrl) {
        throw new ChannelError(
          `No se pudo firmar la URL del archivo ${mediaUrl}: ${signError?.message ?? "sin URL"}`,
          { permanent: false },
        );
      }
      mediaUrl = signed.signedUrl;
    }

    const result = await driver.sendMessage({
      account,
      token,
      recipientId: ctx.recipient_id,
      content: ctx.content,
      mediaType: ctx.media_type,
      mediaUrl,
    });

    await completeOutboundJob(job.id, result.channelMessageId);

    log.info("Mensaje enviado", {
      jobId: job.id,
      tenantId: ctx.tenant_id,
      conversationId: ctx.conversation_id,
      channel: ctx.channel,
      channelMessageId: result.channelMessageId,
    });

    // Messenger e Instagram no admiten pie de foto: el texto que acompana a un
    // adjunto va como mensaje aparte. Se encola DESPUES de cerrar este trabajo,
    // asi que un fallo del texto no reintenta el adjunto ni lo duplica.
    if (result.pendingText) {
      const { error: eTexto } = await db.rpc("enqueue_outbound_message", {
        p_conversation_id: ctx.conversation_id,
        p_content: result.pendingText,
        p_sender_type: "bot",
        p_sender_user_id: null,
        p_media_type: "text",
        p_media_url: null,
        p_payload: { origen: "pie_de_adjunto", mensaje_adjunto: ctx.message_id },
      });

      if (eTexto) {
        // El adjunto si salio. Se registra para que el hueco sea visible y no
        // se confunda con un envio completo.
        log.error("El adjunto salio pero su texto no se pudo encolar", {
          jobId: job.id, conversationId: ctx.conversation_id, error: eTexto.message,
        });
      }
    }
  } catch (error) {
    const detail = describeError(error);

    if (error instanceof ChannelError && error.permanent) {
      await killJob(job.id, detail);
      log.error("Envio descartado por error permanente", {
        jobId: job.id, status: error.status, codigo: error.channelCode, error: detail,
      });
      return;
    }

    await failOutboundJob(job.id, detail);
    // `intento` recibia el UUID del trabajo por un error de copia, asi que en
    // los registros no se distinguia un primer intento de un quinto: justo el
    // dato con el que se diagnostica una cuenta con el token caducado.
    log.warn("Envio fallido, se reintentara", {
      jobId: job.id, intento: job.attempts, error: detail,
    });
  }
}

async function killJob(jobId: string, reason: string): Promise<void> {
  const { error } = await db.rpc("kill_outbound_job", {
    p_job_id: jobId,
    p_error: reason,
  });
  if (error) log.error("No se pudo cerrar el envio", { jobId, error: error.message });
}
