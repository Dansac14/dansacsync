// =============================================================================
// Formato de fechas y textos para la bandeja
// =============================================================================

const HOY = new Intl.DateTimeFormat("es-PE", { hour: "2-digit", minute: "2-digit" });
const ESTA_SEMANA = new Intl.DateTimeFormat("es-PE", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const ANTIGUO = new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short" });
const COMPLETO = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
});

/**
 * Hora relativa al momento actual, como la muestran las apps de mensajeria:
 * la hora si es de hoy, el dia si es de esta semana, la fecha si es mas antiguo.
 * Un operador con cien conversaciones necesita distinguir de un vistazo lo de
 * hace diez minutos de lo de la semana pasada.
 */
export function formatRelative(iso: string | null): string {
  if (!iso) return "";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const ahora = new Date();
  const mismoDia = date.toDateString() === ahora.toDateString();
  if (mismoDia) return HOY.format(date);

  const diferenciaDias = (ahora.getTime() - date.getTime()) / 86_400_000;
  if (diferenciaDias < 7) return ESTA_SEMANA.format(date);

  return ANTIGUO.format(date);
}

export function formatFull(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : COMPLETO.format(date);
}

/** Cuanto queda de la ventana de servicio, en palabras. */
export function formatRemaining(iso: string | null): string {
  if (!iso) return "cerrada";

  const restante = new Date(iso).getTime() - Date.now();
  if (restante <= 0) return "cerrada";

  const horas = Math.floor(restante / 3_600_000);
  const minutos = Math.floor((restante % 3_600_000) / 60_000);

  if (horas >= 1) return `${horas} h ${minutos} min`;
  return `${minutos} min`;
}

export function formatDayDivider(iso: string | null): string {
  // Se valida como las otras dos. Sin esto, un created_at nulo o mal formado
  // lanzaba RangeError DENTRO del render del hilo y tumbaba el panel completo,
  // no solo esa burbuja; y con null mostraba un separador de "1 de enero" en
  // medio de la conversacion.
  if (!iso) return "";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const ahora = new Date();

  if (date.toDateString() === ahora.toDateString()) return "Hoy";

  const ayer = new Date(ahora);
  ayer.setDate(ayer.getDate() - 1);
  if (date.toDateString() === ayer.toDateString()) return "Ayer";

  return new Intl.DateTimeFormat("es-PE", {
    weekday: "long", day: "numeric", month: "long",
  }).format(date);
}
