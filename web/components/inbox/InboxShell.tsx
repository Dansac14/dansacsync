// =============================================================================
// Bandeja · estado, tiempo real y disposicion
// =============================================================================
// Tres columnas: conversaciones, hilo y ficha del contacto.
//
// El tiempo real es lo que hace usable esta pantalla. Sin el, dos operadores
// atenderian el mismo chat sin saberlo, y un mensaje nuevo solo apareceria al
// recargar. Realtime de Supabase respeta la RLS, asi que la suscripcion solo
// entrega filas de la empresa del operador.
// =============================================================================

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  contactLabel,
  type Channel, type ConversationRow, type Group, type Membership, type MessageRow,
} from "@/lib/types";
import { ConversationList } from "./ConversationList";
import { MessageThread } from "./MessageThread";
import { Composer } from "./Composer";
import { ContactPanel } from "./ContactPanel";
import { ChannelBadge, channelName } from "./ChannelBadge";

const CONVERSATION_SELECT = `
  id, tenant_id, contact_id, channel, status, handling_mode, assigned_operator_id,
  unread_count, last_message_at, last_message_preview, service_window_expires_at,
  contacts(id, first_name, last_name, phone, email),
  channel_identities(channel_user_id, display_name)
`;

export interface Filters {
  channel: Channel | "todos";
  soloNoLeidos: boolean;
  soloMios: boolean;
  soloHumanos: boolean;
  busqueda: string;
}

const FILTROS_INICIALES: Filters = {
  channel: "todos",
  soloNoLeidos: false,
  soloMios: false,
  soloHumanos: false,
  busqueda: "",
};

export function InboxShell({
  userId, userEmail, memberships, active, groups, onLogout,
}: {
  userId: string;
  userEmail: string;
  memberships: Membership[];
  active: Membership;
  groups: Group[];
  onLogout: () => Promise<void>;
}) {
  const supabase = createSupabaseBrowserClient();
  const tenantId = active.tenant_id;

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [filters, setFilters] = useState<Filters>(FILTROS_INICIALES);
  const [cargandoLista, setCargandoLista] = useState(true);
  const [cargandoHilo, setCargandoHilo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // El id seleccionado se guarda en una referencia para que el manejador de
  // tiempo real no se vuelva a crear con cada cambio de conversacion: si se
  // recreara, la suscripcion se cerraria y se abriria constantemente.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // ---------------------------------------------------------------------------
  // Carga de la lista
  // ---------------------------------------------------------------------------

  const cargarConversaciones = useCallback(async () => {
    const { data, error: consultaError } = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("tenant_id", tenantId)
      .neq("status", "resolved")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(200);

    if (consultaError) {
      setError(`No se pudieron cargar las conversaciones: ${consultaError.message}`);
      setCargandoLista(false);
      return;
    }

    setConversations((data ?? []) as unknown as ConversationRow[]);
    setError(null);
    setCargandoLista(false);
  }, [supabase, tenantId]);

  useEffect(() => {
    setCargandoLista(true);
    setSelectedId(null);
    setMessages([]);
    void cargarConversaciones();
  }, [cargarConversaciones]);

  // ---------------------------------------------------------------------------
  // Carga de un hilo
  // ---------------------------------------------------------------------------

  const abrirConversacion = useCallback(async (conversationId: string) => {
    setSelectedId(conversationId);
    setCargandoHilo(true);

    const { data, error: consultaError } = await supabase
      .from("messages")
      .select(`id, conversation_id, direction, sender_type, sender_user_id, content,
               media_type, media_url, media_mime_type, delivery_status, error_text, created_at`)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(300);

    if (consultaError) {
      setError(`No se pudo abrir la conversación: ${consultaError.message}`);
      setCargandoHilo(false);
      return;
    }

    setMessages((data ?? []) as MessageRow[]);
    setCargandoHilo(false);

    // Marcar como leido es una escritura, asi que puede fallar por permisos.
    // Si falla, no se interrumpe la lectura del hilo: solo queda el contador.
    const { error: leidoError } = await supabase.rpc("mark_conversation_read", {
      p_conversation_id: conversationId,
    });
    if (!leidoError) {
      setConversations((prev) => prev.map(
        (c) => c.id === conversationId ? { ...c, unread_count: 0 } : c,
      ));
    }
  }, [supabase]);

  // ---------------------------------------------------------------------------
  // Tiempo real
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const canal = supabase
      .channel(`inbox:${tenantId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `tenant_id=eq.${tenantId}` },
        (payload) => {
          const mensaje = payload.new as MessageRow;

          // Si el hilo abierto es el del mensaje, se anade en el sitio.
          if (mensaje.conversation_id === selectedRef.current) {
            setMessages((prev) =>
              // Puede llegar por realtime un mensaje que ya se anadio de forma
              // optimista al enviarlo: se evita duplicarlo.
              prev.some((m) => m.id === mensaje.id) ? prev : [...prev, mensaje],
            );
          }

          // La lista se refresca desde la base y no a mano: los contadores y la
          // vista previa los calculan triggers, y replicar esa logica en el
          // cliente es garantizar que un dia deje de coincidir.
          void cargarConversaciones();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `tenant_id=eq.${tenantId}` },
        (payload) => {
          const mensaje = payload.new as MessageRow;
          setMessages((prev) => prev.map((m) => m.id === mensaje.id ? { ...m, ...mensaje } : m));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `tenant_id=eq.${tenantId}` },
        () => { void cargarConversaciones(); },
      )
      .subscribe();

    return () => { void supabase.removeChannel(canal); };
  }, [supabase, tenantId, cargarConversaciones]);

  // ---------------------------------------------------------------------------
  // Acciones
  // ---------------------------------------------------------------------------

  const seleccionada = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const enviar = useCallback(async (texto: string) => {
    if (!seleccionada) return;

    setEnviando(true);
    const { error: envioError } = await supabase.rpc("send_operator_message", {
      p_conversation_id: seleccionada.id,
      p_content: texto,
      p_media_type: "text",
      p_media_url: null,
    });
    setEnviando(false);

    if (envioError) {
      setError(`No se pudo enviar: ${envioError.message}`);
      return;
    }
    setError(null);
    // No se anade el mensaje a mano: llega por tiempo real con su id real y su
    // estado de entrega, que es justo lo que el operador necesita ver.
  }, [supabase, seleccionada]);

  const cambiarModo = useCallback(async (modo: "bot" | "human") => {
    if (!seleccionada) return;

    const { error: modoError } = await supabase.rpc("set_handling_mode", {
      p_conversation_id: seleccionada.id,
      p_mode: modo,
    });

    if (modoError) {
      setError(`No se pudo cambiar el modo: ${modoError.message}`);
      return;
    }
    setError(null);
    void cargarConversaciones();
  }, [supabase, seleccionada, cargarConversaciones]);

  // ---------------------------------------------------------------------------
  // Filtrado
  // ---------------------------------------------------------------------------

  const visibles = useMemo(() => {
    const busqueda = filters.busqueda.trim().toLowerCase();

    return conversations.filter((c) => {
      if (filters.channel !== "todos" && c.channel !== filters.channel) return false;
      if (filters.soloNoLeidos && c.unread_count === 0) return false;
      if (filters.soloHumanos && c.handling_mode !== "human") return false;
      if (filters.soloMios && c.assigned_operator_id !== userId) return false;

      if (busqueda) {
        const heno = [
          contactLabel(c),
          c.contacts?.phone ?? "",
          c.contacts?.email ?? "",
          c.last_message_preview ?? "",
        ].join(" ").toLowerCase();
        if (!heno.includes(busqueda)) return false;
      }
      return true;
    });
  }, [conversations, filters, userId]);

  const totalNoLeidos = useMemo(
    () => conversations.reduce((suma, c) => suma + c.unread_count, 0),
    [conversations],
  );

  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col">
      <TopBar
        userEmail={userEmail}
        memberships={memberships}
        active={active}
        totalNoLeidos={totalNoLeidos}
        onLogout={onLogout}
      />

      {error && (
        <div role="alert" className="flex items-start gap-3 bg-rose-50 px-4 py-2 text-sm text-rose-800">
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-rose-600 underline hover:no-underline"
          >
            cerrar
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-full max-w-sm shrink-0 flex-col border-r border-slate-200 bg-white md:w-80 lg:w-96">
          <ConversationList
            conversations={visibles}
            total={conversations.length}
            selectedId={selectedId}
            filters={filters}
            cargando={cargandoLista}
            onFiltersChange={setFilters}
            onSelect={(id) => void abrirConversacion(id)}
          />
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-slate-50">
          {seleccionada ? (
            <>
              <ThreadHeader
                conversation={seleccionada}
                onModeChange={(modo) => void cambiarModo(modo)}
              />
              <MessageThread
                conversationId={seleccionada.id}
                messages={messages}
                cargando={cargandoHilo}
                userId={userId}
              />
              <Composer
                conversation={seleccionada}
                enviando={enviando}
                onSend={(texto) => void enviar(texto)}
              />
            </>
          ) : (
            <SinSeleccion hayConversaciones={conversations.length > 0} />
          )}
        </section>

        {seleccionada && (
          <aside className="hidden w-72 shrink-0 border-l border-slate-200 bg-white xl:block">
            <ContactPanel conversation={seleccionada} groups={groups} />
          </aside>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function TopBar({
  userEmail, memberships, active, totalNoLeidos, onLogout,
}: {
  userEmail: string;
  memberships: Membership[];
  active: Membership;
  totalNoLeidos: number;
  onLogout: () => Promise<void>;
}) {
  return (
    <header className="flex shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-sm font-semibold text-slate-900">
          {active.tenants?.business_name ?? "Empresa"}
        </h1>
        {totalNoLeidos > 0 && (
          <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white">
            {totalNoLeidos}
          </span>
        )}
      </div>

      {/* Un operador puede atender varias empresas del SaaS. El cambio recarga
          la pagina a proposito: cambiar de empresa cambia el tenant de todas
          las consultas y de la suscripcion de tiempo real. */}
      {memberships.length > 1 && (
        <form method="get" className="ml-2">
          <label htmlFor="empresa" className="sr-only">Empresa</label>
          <select
            id="empresa"
            name="empresa"
            defaultValue={active.tenants?.slug ?? ""}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700"
          >
            {memberships.map((m) => (
              <option key={m.tenant_id} value={m.tenants?.slug ?? ""}>
                {m.tenants?.business_name ?? m.tenant_id}
              </option>
            ))}
          </select>
        </form>
      )}

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-xs text-slate-500 sm:inline">
          {userEmail} · {active.role}
        </span>
        <form action={onLogout}>
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium
                       text-slate-700 transition hover:bg-slate-50"
          >
            Salir
          </button>
        </form>
      </div>
    </header>
  );
}

function ThreadHeader({
  conversation, onModeChange,
}: {
  conversation: ConversationRow;
  onModeChange: (modo: "bot" | "human") => void;
}) {
  const enHumano = conversation.handling_mode === "human";

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
      <ChannelBadge channel={conversation.channel} size="md" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">
          {contactLabel(conversation)}
        </p>
        <p className="truncate text-xs text-slate-500">
          {channelName(conversation.channel)}
          {conversation.channel_identities?.channel_user_id
            && ` · ${conversation.channel_identities.channel_user_id}`}
        </p>
      </div>

      <span
        className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
          enHumano ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
        }`}
      >
        {enHumano ? "Atención humana" : "Agente de IA activo"}
      </span>

      {/* Un solo boton que alterna. Dos botones separados obligan al operador a
          leer cual esta activo antes de pulsar. */}
      <button
        onClick={() => onModeChange(enHumano ? "bot" : "human")}
        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
          enHumano
            ? "border border-slate-300 text-slate-700 hover:bg-slate-50"
            : "bg-amber-500 text-white hover:bg-amber-600"
        }`}
      >
        {enHumano ? "Devolver a la IA" : "Tomar control"}
      </button>
    </header>
  );
}

function SinSeleccion({ hayConversaciones }: { hayConversaciones: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <p className="text-sm font-medium text-slate-700">
          {hayConversaciones
            ? "Elige una conversación"
            : "Todavía no hay conversaciones"}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {hayConversaciones
            ? "El hilo se abre a la derecha y se actualiza solo cuando llega un mensaje nuevo."
            : "Cuando un cliente escriba por WhatsApp, Instagram o Messenger, aparecerá aquí sin recargar."}
        </p>
      </div>
    </div>
  );
}
