// =============================================================================
// Envio de una ficha de producto desde la conversacion
// =============================================================================
// El operador elige el producto; el texto y el precio los arma la base con los
// datos vigentes. Si la interfaz compusiera el mensaje, bastaria con tener la
// pantalla abierta desde ayer para enviarle a un cliente un precio que ya
// cambio.
// =============================================================================

"use client";

import { useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { money } from "@/lib/money";

export interface ProductoEnviable {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  currency: string;
  track_stock: boolean;
  stock_quantity: number;
  images: string[];
}

export function ProductPicker({
  conversationId, productos, deshabilitado, onEnviado, onError,
}: {
  conversationId: string;
  productos: ProductoEnviable[];
  deshabilitado: boolean;
  onEnviado: (nombre: string) => void;
  onError: (mensaje: string) => void;
}) {
  const supabase = createSupabaseBrowserClient();
  const [abierto, setAbierto] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [enviando, setEnviando] = useState<string | null>(null);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return productos.slice(0, 40);
    return productos
      .filter((p) => `${p.name} ${p.sku ?? ""}`.toLowerCase().includes(q))
      .slice(0, 40);
  }, [productos, busqueda]);

  async function enviar(producto: ProductoEnviable) {
    setEnviando(producto.id);
    const { error } = await supabase.rpc("enqueue_product_message", {
      p_conversation_id: conversationId,
      p_product_id: producto.id,
    });
    setEnviando(null);

    if (error) { onError(`No se pudo enviar la ficha: ${error.message}`); return; }

    onEnviado(producto.name);
    setAbierto(false);
    setBusqueda("");
  }

  return (
    <div className="relative">
      <button
        onClick={() => setAbierto(!abierto)}
        disabled={deshabilitado}
        title={deshabilitado
          ? "La ventana de 24 h está cerrada: no se pueden enviar mensajes libres"
          : "Enviar la ficha de un producto"}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium
                   text-slate-700 transition hover:bg-slate-50
                   disabled:cursor-not-allowed disabled:opacity-40"
      >
        Enviar producto
      </button>

      {abierto && !deshabilitado && (
        <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-xl border
                        border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-200 p-2">
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar producto"
              autoFocus
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm
                         focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
          </div>

          <ul className="max-h-72 overflow-y-auto">
            {visibles.length === 0 && (
              <li className="p-4 text-center text-xs text-slate-500">
                {productos.length === 0
                  ? "El catálogo no tiene productos activos."
                  : "Ningún producto coincide."}
              </li>
            )}

            {visibles.map((producto) => {
              const sinStock = producto.track_stock && producto.stock_quantity <= 0;

              return (
                <li key={producto.id}>
                  <button
                    onClick={() => void enviar(producto)}
                    disabled={enviando !== null}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs
                               transition hover:bg-slate-50 disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-800">
                        {producto.name}
                      </span>
                      <span className="text-slate-500">
                        {money(producto.price, producto.currency)}
                        {producto.images.length === 0 && " · sin imagen"}
                        {/* Se avisa pero no se bloquea: hay negocios que venden
                            bajo pedido y el stock cero no impide cotizar. */}
                        {sinStock && " · sin stock"}
                      </span>
                    </span>
                    {enviando === producto.id && (
                      <span className="text-[10px] text-slate-400">enviando…</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-slate-200 px-3 py-2 text-[10px] text-slate-400">
            Se encola con el precio y la imagen que tenga el producto ahora. El
            estado de entrega aparece en el hilo.
          </div>
        </div>
      )}
    </div>
  );
}
