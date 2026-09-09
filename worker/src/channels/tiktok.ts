// =============================================================================
// TikTok Business Messaging
// =============================================================================
// SIN IMPLEMENTAR, a proposito y de forma explicita.
//
// A diferencia de WhatsApp, Messenger e Instagram, la mensajeria directa de
// TikTok no tiene documentacion publica del esquema de firma del webhook ni del
// endpoint de envio: el acceso esta detras de una aplicacion aprobada en el
// portal de TikTok for Business.
//
// Escribir aqui una verificacion de firma inventada seria peor que no tener
// canal. Un HMAC con el algoritmo equivocado no falla de forma visible: o
// rechaza todos los eventos legitimos, o los acepta sin comprobar nada y deja
// el webhook abierto para que cualquiera inyecte mensajes en las conversaciones
// de un cliente. Por eso este driver falla de inmediato y con un mensaje claro.
//
// Para completarlo hacen falta dos cosas del portal de TikTok:
//   1. El esquema exacto de firma del webhook: nombre de la cabecera, que se
//      firma (cuerpo crudo, o timestamp mas cuerpo) y con que secreto.
//   2. El endpoint de envio de mensaje directo con su formato de cuerpo.
//
// Con esos dos datos, este archivo se completa siguiendo el mismo contrato que
// los otros tres y no hay que tocar nada mas del worker: el registro de canales
// ya lo contempla y la base de datos ya acepta 'tiktok' como canal.
// =============================================================================

import {
  ChannelError,
  type ChannelDriver, type MediaDownload, type MediaRef, type SendParams, type SendResult,
} from "./types.ts";

const MOTIVO =
  "El canal TikTok todavia no esta implementado: falta el esquema de firma del " +
  "webhook y el endpoint de envio, que requieren una aplicacion aprobada en el " +
  "portal de TikTok for Business. Los mensajes hacia TikTok no se envian.";

export const tiktokDriver: ChannelDriver = {
  channel: "tiktok",

  async sendMessage(_params: SendParams): Promise<SendResult> {
    // Permanente: reintentar no cambia nada hasta que el canal se implemente.
    throw new ChannelError(MOTIVO, { permanent: true });
  },

  async downloadMedia(_ref: MediaRef): Promise<MediaDownload> {
    throw new ChannelError(MOTIVO, { permanent: true });
  },
};
