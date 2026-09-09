// =============================================================================
// Ficha del contacto
// =============================================================================
// Lo que el operador necesita tener delante mientras responde: quien es, por
// donde escribe, en que grupos esta y desde cuando.
// =============================================================================

"use client";

import { useCallback, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { contactLabel, type ConversationRow, type Group } from "@/lib/types";
import { formatFull } from "@/lib/format";
import { channelName } from "./ChannelBadge";

interface Pertenencia {
  group_id: string;
  entered_at: string;
  groups: Group | null;
}

export function ContactPanel({
  conversation, groups,
}: {
  conversation: ConversationRow;
  groups: Group[];
}) {
  const supabase = createSupabaseBrowserClient();
  const [pertenencias, setPertenencias] = useState<Pertenencia[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const { data, error: consultaError } = await supabase
      .from("contact_groups")
      .select("group_id, entered_at, groups(id, name, color, system_key)")
      .eq("contact_id", conversation.contact_id);

    if (consultaError) {
      setError(consultaError.message);
      return;
    }
    setPertenencias((data ?? []) as unknown as Pertenencia[]);
    setError(null);
  }, [supabase, conversation.contact_id]);

  useEffect(() => { void cargar(); }, [cargar]);

  const alternarGrupo = useCallback(async (group: Group, dentro: boolean) => {
    setOcupado(true);

    const { error: escrituraError } = dentro
      ? await supabase.from("contact_groups")
          .delete()
          .eq("contact_id", conversation.contact_id)
          .eq("group_id", group.id)
      : await supabase.from("contact_groups")
          .insert({
            contact_id: conversation.contact_id,
            group_id: group.id,
            tenant_id: conversation.tenant_id,
          });

    setOcupado(false);

    if (escrituraError) {
      setError(escrituraError.message);
      return;
    }
    setError(null);
    void cargar();
  }, [supabase, conversation.contact_id, conversation.tenant_id, cargar]);

  const idsActuales = new Set(pertenencias.map((p) => p.group_id));

  return (
    <div className="inbox-scroll h-full p-4">
      <h2 className="text-sm font-semibold text-slate-900">{contactLabel(conversation)}</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        {channelName(conversation.channel)}
      </p>

      <dl className="mt-4 space-y-2 text-xs">
        <Dato etiqueta="Teléfono" valor={conversation.contacts?.phone} />
        <Dato etiqueta="Correo" valor={conversation.contacts?.email} />
        <Dato
          etiqueta="Identificador del canal"
          valor={conversation.channel_identities?.channel_user_id}
          mono
        />
        <Dato
          etiqueta="Último mensaje"
          valor={conversation.last_message_at ? formatFull(conversation.last_message_at) : null}
        />
        <Dato
          etiqueta="Estado"
          valor={conversation.status === "open" ? "Abierta"
            : conversation.status === "pending" ? "Pendiente" : "Resuelta"}
        />
      </dl>

      <hr className="my-4 border-slate-200" />

      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Grupos
      </h3>

      {error && (
        <p className="mt-2 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">{error}</p>
      )}

      <ul className="mt-2 space-y-1">
        {groups.length === 0 && (
          <li className="text-xs text-slate-400">Esta empresa no tiene grupos.</li>
        )}

        {groups.map((group) => {
          const dentro = idsActuales.has(group.id);
          // Los grupos del sistema los gestiona el motor: "Atencion humana" se
          // asigna al escalar y "Leads nuevos" al primer mensaje. Dejar que se
          // quiten a mano crearia un estado que el sistema volveria a cambiar.
          const gestionado = group.system_key !== null;

          return (
            <li key={group.id}>
              <button
                onClick={() => !gestionado && void alternarGrupo(group, dentro)}
                disabled={ocupado || gestionado}
                title={gestionado ? "Grupo gestionado automáticamente por el sistema" : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left
                            text-xs transition ${
                  gestionado
                    ? "cursor-default"
                    : "hover:bg-slate-50 disabled:opacity-50"
                }`}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: dentro ? group.color : "transparent",
                           border: `1.5px solid ${group.color}` }}
                />
                <span className={dentro ? "font-medium text-slate-800" : "text-slate-500"}>
                  {group.name}
                </span>
                {gestionado && (
                  <span className="ml-auto text-[10px] text-slate-400">automático</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Dato({
  etiqueta, valor, mono,
}: {
  etiqueta: string;
  valor: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-slate-400">{etiqueta}</dt>
      <dd className={`text-slate-700 ${mono ? "font-mono text-[11px] break-all" : ""}`}>
        {valor && valor.trim() !== "" ? valor : <span className="text-slate-300">—</span>}
      </dd>
    </div>
  );
}
