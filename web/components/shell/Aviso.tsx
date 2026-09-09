// =============================================================================
// Aviso
// =============================================================================
// Pieza compartida por todas las pantallas de gestion.
// =============================================================================

"use client";

export function Aviso({
  tono, onCerrar, children,
}: {
  tono: "error" | "exito" | "neutro";
  onCerrar?: () => void;
  children: React.ReactNode;
}) {
  const clases = {
    error:  "bg-rose-50 text-rose-800",
    exito:  "bg-emerald-50 text-emerald-800",
    neutro: "bg-slate-100 text-slate-700",
  }[tono];

  return (
    <div
      // role="alert" solo en los errores: si se pusiera en todos, un lector de
      // pantalla interrumpiria al usuario para anunciarle cada confirmacion.
      role={tono === "error" ? "alert" : undefined}
      className={`flex items-start gap-3 rounded-lg px-3 py-2 text-sm ${clases}`}
    >
      <span className="flex-1">{children}</span>
      {onCerrar && (
        <button onClick={onCerrar} className="underline hover:no-underline">cerrar</button>
      )}
    </div>
  );
}
