// =============================================================================
// Columna de conversaciones
// =============================================================================

"use client";

import { contactLabel, serviceWindowClosed, type ConversationRow, type Channel } from "@/lib/types";
import { formatRelative } from "@/lib/format";
import { ChannelBadge } from "./ChannelBadge";
import type { Filters } from "./InboxShell";

const CANALES: { valor: Channel | "todos"; etiqueta: string }[] = [
  { valor: "todos", etiqueta: "Todos" },
  { valor: "whatsapp", etiqueta: "WhatsApp" },
  { valor: "instagram", etiqueta: "Instagram" },
  { valor: "facebook", etiqueta: "Messenger" },
  { valor: "tiktok", etiqueta: "TikTok" },
];

export function ConversationList({
  conversations, total, selectedId, filters, cargando, onFiltersChange, onSelect,
}: {
  conversations: ConversationRow[];
  total: number;
  selectedId: string | null;
  filters: Filters;
  cargando: boolean;
  onFiltersChange: (f: Filters) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div className="shrink-0 space-y-2 border-b border-slate-200 p-3">
        <input
          type="search"
          value={filters.busqueda}
          onChange={(e) => onFiltersChange({ ...filters, busqueda: e.target.value })}
          placeholder="Buscar por nombre, teléfono o texto"
          aria-label="Buscar conversaciones"
          className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm
                     focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
        />

        <div className="flex flex-wrap gap-1">
          {CANALES.map((canal) => (
            <button
              key={canal.valor}
              onClick={() => onFiltersChange({ ...filters, channel: canal.valor })}
              aria-pressed={filters.channel === canal.valor}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                filters.channel === canal.valor
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {canal.etiqueta}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          <Toggle
            activo={filters.soloNoLeidos}
            onClick={() => onFiltersChange({ ...filters, soloNoLeidos: !filters.soloNoLeidos })}
          >
            No leídos
          </Toggle>
          <Toggle
            activo={filters.soloHumanos}
            onClick={() => onFiltersChange({ ...filters, soloHumanos: !filters.soloHumanos })}
          >
            Atención humana
          </Toggle>
          <Toggle
            activo={filters.soloMios}
            onClick={() => onFiltersChange({ ...filters, soloMios: !filters.soloMios })}
          >
            Asignados a mí
          </Toggle>
        </div>

        <p className="text-[11px] text-slate-400">
          {cargando
            ? "Cargando…"
            : conversations.length === total
              ? `${total} conversaciones`
              : `${conversations.length} de ${total}`}
        </p>
      </div>

      <ul className="inbox-scroll min-h-0 flex-1 divide-y divide-slate-100">
        {!cargando && conversations.length === 0 && (
          <li className="p-6 text-center text-sm text-slate-500">
            {total === 0
              ? "Sin conversaciones todavía."
              : "Ninguna conversación coincide con los filtros."}
          </li>
        )}

        {conversations.map((conversation) => {
          const activa = conversation.id === selectedId;
          const noLeidos = conversation.unread_count;
          const ventanaCerrada = serviceWindowClosed(conversation);

          return (
            <li key={conversation.id}>
              <button
                onClick={() => onSelect(conversation.id)}
                aria-current={activa}
                className={`flex w-full gap-3 px-3 py-3 text-left transition ${
                  activa ? "bg-indigo-50" : "hover:bg-slate-50"
                }`}
              >
                <div className="pt-0.5">
                  <ChannelBadge channel={conversation.channel} size="md" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className={`min-w-0 flex-1 truncate text-sm ${
                      noLeidos > 0 ? "font-semibold text-slate-900" : "font-medium text-slate-700"
                    }`}>
                      {contactLabel(conversation)}
                    </p>
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {formatRelative(conversation.last_message_at)}
                    </span>
                  </div>

                  <p className={`mt-0.5 truncate text-xs ${
                    noLeidos > 0 ? "text-slate-700" : "text-slate-500"
                  }`}>
                    {conversation.last_message_preview ?? "Sin mensajes"}
                  </p>

                  <div className="mt-1.5 flex items-center gap-1.5">
                    {conversation.handling_mode === "human" && (
                      <Etiqueta clase="bg-amber-100 text-amber-800">Humano</Etiqueta>
                    )}
                    {/* Aviso temprano: si la ventana esta cerrada, el operador
                        no puede escribir libremente y conviene que lo sepa antes
                        de abrir el hilo y redactar una respuesta. */}
                    {ventanaCerrada && (
                      <Etiqueta clase="bg-slate-200 text-slate-600">24 h cerrada</Etiqueta>
                    )}
                    {noLeidos > 0 && (
                      <span className="ml-auto rounded-full bg-indigo-600 px-1.5 py-0.5
                                       text-[10px] font-semibold text-white">
                        {noLeidos}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Toggle({
  activo, onClick, children,
}: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={activo}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
        activo
          ? "border-indigo-300 bg-indigo-100 text-indigo-800"
          : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function Etiqueta({ clase, children }: { clase: string; children: React.ReactNode }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${clase}`}>
      {children}
    </span>
  );
}
