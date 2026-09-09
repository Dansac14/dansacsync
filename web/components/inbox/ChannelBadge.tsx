import type { Channel, DeliveryStatus } from "@/lib/types";

const CANALES: Record<Channel, { nombre: string; clase: string; inicial: string }> = {
  whatsapp:  { nombre: "WhatsApp",  clase: "bg-[#25D366]", inicial: "W" },
  instagram: { nombre: "Instagram", clase: "bg-[#E1306C]", inicial: "I" },
  facebook:  { nombre: "Messenger", clase: "bg-[#1877F2]", inicial: "F" },
  tiktok:    { nombre: "TikTok",    clase: "bg-slate-900",  inicial: "T" },
};

export function ChannelBadge({ channel, size = "sm" }: { channel: Channel; size?: "sm" | "md" }) {
  const canal = CANALES[channel];
  const dimension = size === "md" ? "h-6 w-6 text-[11px]" : "h-4 w-4 text-[9px]";

  return (
    <span
      // El título es lo que hace legible el color para quien no distingue
      // WhatsApp de Messenger por el verde y el azul.
      title={canal.nombre}
      aria-label={canal.nombre}
      className={`inline-flex ${dimension} shrink-0 items-center justify-center rounded-full
                  font-bold text-white ${canal.clase}`}
    >
      {canal.inicial}
    </span>
  );
}

export function channelName(channel: Channel): string {
  return CANALES[channel].nombre;
}

// -----------------------------------------------------------------------------
// Estado de entrega
// -----------------------------------------------------------------------------
// Se muestra solo en los mensajes salientes. Que un operador vea "fallido" en
// lugar de nada es la diferencia entre reintentar y creer que el cliente ya
// recibio la respuesta.
// -----------------------------------------------------------------------------

const ESTADOS: Record<DeliveryStatus, { texto: string; clase: string }> = {
  pending:   { texto: "enviando…",  clase: "text-slate-400" },
  sent:      { texto: "enviado",    clase: "text-slate-400" },
  delivered: { texto: "entregado",  clase: "text-slate-500" },
  read:      { texto: "leído",      clase: "text-indigo-600" },
  failed:    { texto: "no se envió", clase: "text-rose-600 font-medium" },
};

export function DeliveryTag({ status }: { status: DeliveryStatus }) {
  const estado = ESTADOS[status];
  return <span className={`text-[10px] ${estado.clase}`}>{estado.texto}</span>;
}
