// =============================================================================
// Hilo de mensajes
// =============================================================================
// Tres emisores con tres aspectos distintos: el cliente, el agente de IA y el
// operador. Distinguirlos importa porque el operador tiene que saber que le
// contesto el bot antes de escribir, para no repetirlo ni contradecirlo.
// =============================================================================

"use client";

import { useEffect, useRef } from "react";
import type { MessageRow } from "@/lib/types";
import { formatDayDivider, formatFull, formatRelative } from "@/lib/format";
import { DeliveryTag } from "./ChannelBadge";

export function MessageThread({
  conversationId, messages, cargando, userId,
}: {
  conversationId: string;
  messages: MessageRow[];
  cargando: boolean;
  userId: string;
}) {
  const finRef = useRef<HTMLDivElement>(null);
  const contenedorRef = useRef<HTMLDivElement>(null);

  // Al llegar un mensaje nuevo se baja al final, pero solo si el operador ya
  // estaba abajo. Si estaba leyendo mas arriba, moverle la vista le hace perder
  // el sitio en plena lectura.
  useEffect(() => {
    const contenedor = contenedorRef.current;
    if (!contenedor) return;

    const distanciaAlFinal =
      contenedor.scrollHeight - contenedor.scrollTop - contenedor.clientHeight;

    if (distanciaAlFinal < 150) {
      finRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  // Al cambiar de conversacion hay que ir al final de inmediato y sin animacion.
  // Sin esto, el efecto de arriba no dispara —la vista viene desplazada del hilo
  // anterior, asi que no esta "cerca del final"— y el operador abre un chat
  // mirando el medio de la conversacion en lugar del ultimo mensaje.
  useEffect(() => {
    finRef.current?.scrollIntoView({ block: "end" });
  }, [conversationId, cargando]);

  if (cargando) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Cargando conversación…
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Esta conversación no tiene mensajes.
      </div>
    );
  }

  let diaAnterior = "";

  return (
    <div ref={contenedorRef} className="inbox-scroll min-h-0 flex-1 px-4 py-4">
      <div className="mx-auto max-w-3xl space-y-1">
        {messages.map((mensaje) => {
          const dia = formatDayDivider(mensaje.created_at);
          const nuevoDia = dia !== diaAnterior;
          diaAnterior = dia;

          return (
            <div key={mensaje.id}>
              {nuevoDia && (
                <div className="my-4 flex items-center gap-3">
                  <span className="h-px flex-1 bg-slate-200" />
                  <span className="text-[11px] font-medium text-slate-400">{dia}</span>
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
              )}
              <Burbuja mensaje={mensaje} userId={userId} />
            </div>
          );
        })}
        <div ref={finRef} />
      </div>
    </div>
  );
}

function Burbuja({ mensaje, userId }: { mensaje: MessageRow; userId: string }) {
  const delCliente = mensaje.direction === "inbound";
  const delBot = mensaje.sender_type === "bot";
  const mio = mensaje.sender_user_id === userId;

  const estilo = delCliente
    ? "bg-white border border-slate-200 text-slate-800"
    : delBot
      ? "bg-emerald-50 border border-emerald-200 text-emerald-950"
      : "bg-indigo-600 text-white";

  const autor = delCliente
    ? null
    : delBot
      ? "Agente de IA"
      : mio ? "Tú" : "Otro operador";

  return (
    <div className={`flex ${delCliente ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 shadow-sm ${estilo}`}>
        {autor && (
          <p className={`mb-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            delBot ? "text-emerald-700" : "text-indigo-200"
          }`}>
            {autor}
          </p>
        )}

        {mensaje.content && (
          <p className="text-sm whitespace-pre-wrap break-words">{mensaje.content}</p>
        )}

        {/* Los archivos viven en un bucket privado: la ruta guardada no es una
            URL abrible. Se indica el tipo en lugar de mostrar un enlace roto. */}
        {mensaje.media_type !== "text" && (
          <p className={`mt-1 text-xs italic ${
            delCliente ? "text-slate-500" : delBot ? "text-emerald-700" : "text-indigo-100"
          }`}>
            {etiquetaMedio(mensaje)}
          </p>
        )}

        {mensaje.error_text && (
          <p className="mt-1 text-[11px] text-rose-600">{mensaje.error_text}</p>
        )}

        <div className={`mt-1 flex items-center gap-2 ${delCliente ? "" : "justify-end"}`}>
          <time
            dateTime={mensaje.created_at}
            title={formatFull(mensaje.created_at)}
            className={`text-[10px] ${
              delCliente ? "text-slate-400" : delBot ? "text-emerald-600" : "text-indigo-200"
            }`}
          >
            {formatRelative(mensaje.created_at)}
          </time>
          {!delCliente && <DeliveryTag status={mensaje.delivery_status} />}
        </div>
      </div>
    </div>
  );
}

const NOMBRE_MEDIO: Record<string, string> = {
  image: "Imagen",
  video: "Video",
  audio: "Audio",
  document: "Documento",
  sticker: "Sticker",
  location: "Ubicación compartida",
  contact_card: "Contacto compartido",
  interactive: "Respuesta a un botón",
  template: "Plantilla",
  unsupported: "Contenido no soportado por el canal",
};

function etiquetaMedio(mensaje: MessageRow): string {
  const nombre = NOMBRE_MEDIO[mensaje.media_type] ?? mensaje.media_type;
  return mensaje.media_url ? `${nombre} adjunta` : `${nombre} (no recuperada)`;
}
