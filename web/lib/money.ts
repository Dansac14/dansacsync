// =============================================================================
// Importes
// =============================================================================
// Regla: los importes se muestran, no se calculan. Todo total viene de la base,
// donde se computa en NUMERIC. Sumar decimales en JavaScript produce
// diferencias de centimos, y un total que no cuadra con el comprobante emitido
// es un problema contable, no visual.
// =============================================================================

const FORMATOS = new Map<string, Intl.NumberFormat>();

function formato(moneda: string): Intl.NumberFormat {
  const clave = moneda.toUpperCase();
  let f = FORMATOS.get(clave);
  if (!f) {
    f = new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency: clave,
      minimumFractionDigits: 2,
    });
    FORMATOS.set(clave, f);
  }
  return f;
}

/** Formatea un importe que ya viene calculado de la base. */
export function money(valor: number | string | null | undefined, moneda = "PEN"): string {
  if (valor === null || valor === undefined || valor === "") return "—";

  // La base devuelve NUMERIC como cadena para no perder precision en el JSON.
  const numero = typeof valor === "string" ? Number(valor) : valor;
  if (!Number.isFinite(numero)) return "—";

  try {
    return formato(moneda).format(numero);
  } catch {
    // Codigo de moneda que Intl no conoce: se muestra el numero con el codigo.
    return `${moneda} ${numero.toFixed(2)}`;
  }
}

/**
 * Convierte lo que escribe una persona en un numero para enviar a la base.
 * Acepta coma o punto como separador decimal, que es lo que de verdad teclea
 * alguien en Peru, y rechaza el resto en lugar de interpretarlo como 0.
 */
export function parseAmount(entrada: string): number | null {
  const limpio = entrada.trim().replace(/\s/g, "").replace(",", ".");
  if (limpio === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;

  const numero = Number(limpio);
  return Number.isFinite(numero) && numero >= 0 ? numero : null;
}

/** Valida un RUC peruano: 11 digitos. */
export function esRuc(valor: string): boolean {
  return /^\d{11}$/.test(valor.trim());
}

/** Valida un DNI peruano: 8 digitos. */
export function esDni(valor: string): boolean {
  return /^\d{8}$/.test(valor.trim());
}

const ESTADOS_ORDEN: Record<string, { texto: string; clase: string }> = {
  draft:           { texto: "Borrador",       clase: "bg-slate-100 text-slate-600" },
  pending_payment: { texto: "Por cobrar",     clase: "bg-amber-100 text-amber-800" },
  paid:            { texto: "Pagada",         clase: "bg-emerald-100 text-emerald-800" },
  fulfilled:       { texto: "Entregada",      clase: "bg-indigo-100 text-indigo-800" },
  cancelled:       { texto: "Anulada",        clase: "bg-slate-200 text-slate-500" },
  refunded:        { texto: "Devuelta",       clase: "bg-rose-100 text-rose-800" },
};

export function estadoOrden(estado: string): { texto: string; clase: string } {
  return ESTADOS_ORDEN[estado] ?? { texto: estado, clase: "bg-slate-100 text-slate-600" };
}
