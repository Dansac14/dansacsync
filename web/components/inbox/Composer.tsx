// =============================================================================
// Caja de escritura del operador
// =============================================================================
// Dos avisos que evitan errores concretos:
//
//   · Ventana de 24 h cerrada en WhatsApp: el envio seria rechazado por Meta.
//     Se bloquea y se explica, en lugar de dejar escribir y fallar despues.
//
//   · Conversacion en modo IA: si el operador escribe, el bot sigue activo y
//     puede contestar encima. Se avisa y se ofrece tomar el control.
// =============================================================================

"use client";

import { useEffect, useRef, useState } from "react";
import { serviceWindowClosed, type ConversationRow } from "@/lib/types";
import { formatRemaining } from "@/lib/format";

const LIMITE_CARACTERES = 4000;

export function Composer({
  conversation, enviando, onSend,
}: {
  conversation: ConversationRow;
  enviando: boolean;
  onSend: (texto: string) => void;
}) {
  const [texto, setTexto] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const ventanaCerrada = serviceWindowClosed(conversation);
  const enModoBot = conversation.handling_mode === "bot";
  const puedeEnviar = !ventanaCerrada && !enviando && texto.trim().length > 0;

  // El borrador es por conversacion: cambiar de hilo no debe arrastrar lo que
  // se estaba escribiendo en el anterior y mandarselo al cliente equivocado.
  useEffect(() => {
    setTexto("");
    areaRef.current?.focus();
  }, [conversation.id]);

  // La caja crece con el texto, hasta un limite.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
  }, [texto]);

  function enviar() {
    const limpio = texto.trim();
    if (!limpio || ventanaCerrada || enviando) return;
    onSend(limpio);
    setTexto("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envia, Shift+Enter hace salto de linea: es lo que espera cualquiera
    // que venga de WhatsApp.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      enviar();
    }
  }

  return (
    <div className="shrink-0 border-t border-slate-200 bg-white">
      {ventanaCerrada && (
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          <strong className="font-semibold">Ventana de 24 horas cerrada.</strong>{" "}
          WhatsApp solo permite mensajes libres durante las 24 horas siguientes al
          último mensaje del cliente. Para retomar el contacto hace falta una
          plantilla aprobada por Meta.
        </div>
      )}

      {!ventanaCerrada && conversation.channel === "whatsapp"
        && conversation.service_window_expires_at && (
        <div className="border-b border-slate-100 px-4 py-1.5 text-[11px] text-slate-400">
          Ventana de servicio: quedan {formatRemaining(conversation.service_window_expires_at)}
        </div>
      )}

      {enModoBot && !ventanaCerrada && (
        <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-800">
          El agente de IA sigue atendiendo esta conversación. Si escribes sin tomar
          el control, el agente puede responder también al próximo mensaje del cliente.
        </div>
      )}

      <div className="flex items-end gap-2 p-3">
        <textarea
          ref={areaRef}
          value={texto}
          onChange={(e) => setTexto(e.target.value.slice(0, LIMITE_CARACTERES))}
          onKeyDown={onKeyDown}
          disabled={ventanaCerrada}
          rows={1}
          placeholder={
            ventanaCerrada
              ? "No se puede escribir con la ventana cerrada"
              : "Escribe tu respuesta. Enter envía, Shift+Enter salta de línea."
          }
          aria-label="Mensaje para el cliente"
          className="max-h-40 min-h-[38px] flex-1 resize-none rounded-lg border border-slate-300
                     px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200
                     focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50
                     disabled:text-slate-400"
        />

        <button
          onClick={enviar}
          disabled={!puedeEnviar}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition
                     hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {enviando ? "Enviando…" : "Enviar"}
        </button>
      </div>

      {texto.length > LIMITE_CARACTERES - 200 && (
        <p className="px-4 pb-2 text-[11px] text-amber-700">
          {LIMITE_CARACTERES - texto.length} caracteres restantes
        </p>
      )}
    </div>
  );
}
