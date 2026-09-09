// =============================================================================
// Catalogo
// =============================================================================
// El precio se guarda con el IGV incluido, que es como lo piensa y lo comunica
// una empresa peruana: "el taller cuesta 118 soles". La base extrae el impuesto
// cuando hace falta desglosarlo en la orden o el comprobante.
// =============================================================================

"use client";

import { useCallback, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { money, parseAmount } from "@/lib/money";
import { Aviso } from "@/components/shell/Aviso";

interface Categoria { id: string; name: string }

interface Producto {
  id: string;
  category_id: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  tax_rate: number;
  images: string[];
  track_stock: boolean;
  stock_quantity: number;
  is_active: boolean;
}

interface Borrador {
  name: string;
  sku: string;
  description: string;
  price: string;
  currency: string;
  category_id: string;
  track_stock: boolean;
  stock_quantity: string;
  image: string;
}

const BORRADOR_VACIO: Borrador = {
  name: "", sku: "", description: "", price: "", currency: "PEN",
  category_id: "", track_stock: false, stock_quantity: "0", image: "",
};

export function CatalogManager({
  tenantId, esAdmin, categoriasIniciales, productosIniciales, monedaEmpresa,
}: {
  tenantId: string;
  esAdmin: boolean;
  categoriasIniciales: Categoria[];
  productosIniciales: Producto[];
  monedaEmpresa: string;
}) {
  const supabase = createSupabaseBrowserClient();

  const [categorias, setCategorias] = useState<Categoria[]>(categoriasIniciales);
  const [productos, setProductos] = useState<Producto[]>(productosIniciales);
  const [borrador, setBorrador] = useState<Borrador>({ ...BORRADOR_VACIO, currency: monedaEmpresa });
  const [editando, setEditando] = useState<string | null>(null);
  const [nuevaCategoria, setNuevaCategoria] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [soloActivos, setSoloActivos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const recargar = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("products")
      .select("id, category_id, sku, name, description, price, currency, tax_rate, images, track_stock, stock_quantity, is_active")
      .eq("tenant_id", tenantId)
      .order("name");

    if (e) { setError(e.message); return; }
    setProductos((data ?? []) as Producto[]);
  }, [supabase, tenantId]);

  const guardar = useCallback(async () => {
    setError(null); setAviso(null);

    const nombre = borrador.name.trim();
    if (nombre === "") { setError("El producto necesita un nombre."); return; }

    const precio = parseAmount(borrador.price);
    if (precio === null) {
      setError("El precio no es válido. Usa solo números, con hasta dos decimales.");
      return;
    }

    const stock = borrador.track_stock ? Number(borrador.stock_quantity) : 0;
    if (borrador.track_stock && (!Number.isInteger(stock) || stock < 0)) {
      setError("El stock debe ser un número entero de cero o más.");
      return;
    }

    setOcupado(true);
    const fila = {
      tenant_id: tenantId,
      name: nombre,
      sku: borrador.sku.trim() || null,
      description: borrador.description.trim() || null,
      price: precio,
      currency: borrador.currency,
      category_id: borrador.category_id || null,
      track_stock: borrador.track_stock,
      stock_quantity: stock,
      // Una sola imagen desde la interfaz. La columna admite varias porque los
      // catalogos de Meta las aceptan, pero enviar más de una por WhatsApp
      // significa enviar varios mensajes: se deja para cuando haga falta.
      images: borrador.image.trim() ? [borrador.image.trim()] : [],
    };

    const { error: e } = editando
      ? await supabase.from("products").update(fila).eq("id", editando)
      : await supabase.from("products").insert(fila);

    setOcupado(false);

    if (e) {
      setError(
        e.code === "23505"
          ? `Ya existe otro producto con el código ${fila.sku}.`
          : e.message,
      );
      return;
    }

    setAviso(editando ? "Producto actualizado." : "Producto creado.");
    setBorrador({ ...BORRADOR_VACIO, currency: monedaEmpresa });
    setEditando(null);
    void recargar();
  }, [supabase, tenantId, borrador, editando, monedaEmpresa, recargar]);

  const alternarActivo = useCallback(async (producto: Producto) => {
    setOcupado(true);
    const { error: e } = await supabase
      .from("products")
      .update({ is_active: !producto.is_active })
      .eq("id", producto.id);
    setOcupado(false);

    if (e) { setError(e.message); return; }
    void recargar();
  }, [supabase, recargar]);

  const crearCategoria = useCallback(async () => {
    const nombre = nuevaCategoria.trim();
    if (nombre === "") return;

    setOcupado(true);
    const { data, error: e } = await supabase
      .from("catalog_categories")
      .insert({ tenant_id: tenantId, name: nombre })
      .select("id, name")
      .single();
    setOcupado(false);

    if (e) {
      setError(e.code === "23505" ? `Ya existe la categoría "${nombre}".` : e.message);
      return;
    }
    setCategorias((prev) => [...prev, data as Categoria].sort((a, b) => a.name.localeCompare(b.name)));
    setNuevaCategoria("");
  }, [supabase, tenantId, nuevaCategoria]);

  const editar = useCallback((producto: Producto) => {
    setEditando(producto.id);
    setBorrador({
      name: producto.name,
      sku: producto.sku ?? "",
      description: producto.description ?? "",
      price: String(producto.price),
      currency: producto.currency,
      category_id: producto.category_id ?? "",
      track_stock: producto.track_stock,
      stock_quantity: String(producto.stock_quantity),
      image: producto.images[0] ?? "",
    });
    setError(null); setAviso(null);
  }, []);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return productos.filter((p) => {
      if (soloActivos && !p.is_active) return false;
      if (!q) return true;
      return `${p.name} ${p.sku ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q);
    });
  }, [productos, busqueda, soloActivos]);

  const nombreCategoria = (id: string | null) =>
    categorias.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Catálogo</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {productos.length} producto{productos.length === 1 ? "" : "s"} ·
            {" "}{productos.filter((p) => p.is_active).length} activo
            {productos.filter((p) => p.is_active).length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {error && <Aviso tono="error" onCerrar={() => setError(null)}>{error}</Aviso>}
      {aviso && <Aviso tono="exito" onCerrar={() => setAviso(null)}>{aviso}</Aviso>}

      {!esAdmin && (
        <Aviso tono="neutro">
          Tu rol es <strong>{"operador"}</strong>: puedes consultar el catálogo y enviar
          productos desde la bandeja, pero no modificarlo.
        </Aviso>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* ------------------------------------------------------------------ */}
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, código o descripción"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm
                         focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={soloActivos}
                onChange={(e) => setSoloActivos(e.target.checked)}
                className="rounded border-slate-300"
              />
              Solo activos
            </label>
          </div>

          {visibles.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">
              {productos.length === 0
                ? "El catálogo está vacío. Crea el primer producto con el formulario de al lado."
                : "Ningún producto coincide con la búsqueda."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Producto</th>
                    <th className="px-3 py-2 font-medium">Categoría</th>
                    <th className="px-3 py-2 text-right font-medium">Precio</th>
                    <th className="px-3 py-2 text-right font-medium">Stock</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibles.map((producto) => (
                    <tr key={producto.id} className={producto.is_active ? "" : "bg-slate-50 text-slate-400"}>
                      <td className="px-3 py-2">
                        <p className="font-medium">{producto.name}</p>
                        {producto.sku && (
                          <p className="font-mono text-[11px] text-slate-400">{producto.sku}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {nombreCategoria(producto.category_id)}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {money(producto.price, producto.currency)}
                        <span className="ml-1 text-[10px] text-slate-400">IGV incl.</span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs">
                        {producto.track_stock
                          ? <span className={producto.stock_quantity === 0 ? "text-rose-600 font-medium" : ""}>
                              {producto.stock_quantity}
                            </span>
                          : <span className="text-slate-300">sin control</span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {esAdmin && (
                          <>
                            <button
                              onClick={() => editar(producto)}
                              className="text-xs text-indigo-600 hover:underline"
                            >
                              editar
                            </button>
                            <button
                              onClick={() => void alternarActivo(producto)}
                              disabled={ocupado}
                              className="ml-3 text-xs text-slate-500 hover:underline disabled:opacity-50"
                            >
                              {producto.is_active ? "desactivar" : "activar"}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ------------------------------------------------------------------ */}
        {esAdmin && (
          <aside className="space-y-4">
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-900">
                {editando ? "Editar producto" : "Nuevo producto"}
              </h2>

              <div className="mt-3 space-y-3">
                <Campo etiqueta="Nombre">
                  <input
                    value={borrador.name}
                    onChange={(e) => setBorrador({ ...borrador, name: e.target.value })}
                    className={ENTRADA}
                  />
                </Campo>

                <Campo etiqueta="Código (SKU)" opcional>
                  <input
                    value={borrador.sku}
                    onChange={(e) => setBorrador({ ...borrador, sku: e.target.value })}
                    className={ENTRADA}
                  />
                </Campo>

                <Campo etiqueta="Descripción" opcional>
                  <textarea
                    value={borrador.description}
                    onChange={(e) => setBorrador({ ...borrador, description: e.target.value })}
                    rows={3}
                    className={`${ENTRADA} resize-y`}
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Es el texto que recibe el cliente cuando le envías la ficha por WhatsApp.
                  </p>
                </Campo>

                <div className="grid grid-cols-[1fr_5rem] gap-2">
                  <Campo etiqueta="Precio (IGV incluido)">
                    <input
                      value={borrador.price}
                      onChange={(e) => setBorrador({ ...borrador, price: e.target.value })}
                      inputMode="decimal"
                      placeholder="118.00"
                      className={ENTRADA}
                    />
                  </Campo>
                  <Campo etiqueta="Moneda">
                    <select
                      value={borrador.currency}
                      onChange={(e) => setBorrador({ ...borrador, currency: e.target.value })}
                      className={ENTRADA}
                    >
                      <option value="PEN">PEN</option>
                      <option value="USD">USD</option>
                    </select>
                  </Campo>
                </div>

                <Campo etiqueta="Categoría" opcional>
                  <select
                    value={borrador.category_id}
                    onChange={(e) => setBorrador({ ...borrador, category_id: e.target.value })}
                    className={ENTRADA}
                  >
                    <option value="">Sin categoría</option>
                    {categorias.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </Campo>

                <Campo etiqueta="Imagen (URL)" opcional>
                  <input
                    value={borrador.image}
                    onChange={(e) => setBorrador({ ...borrador, image: e.target.value })}
                    placeholder="https://…"
                    className={ENTRADA}
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Tiene que ser accesible desde internet: WhatsApp la descarga
                    él mismo para mostrarla.
                  </p>
                </Campo>

                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={borrador.track_stock}
                    onChange={(e) => setBorrador({ ...borrador, track_stock: e.target.checked })}
                    className="rounded border-slate-300"
                  />
                  Controlar stock
                </label>

                {borrador.track_stock && (
                  <Campo etiqueta="Unidades disponibles">
                    <input
                      value={borrador.stock_quantity}
                      onChange={(e) => setBorrador({ ...borrador, stock_quantity: e.target.value })}
                      inputMode="numeric"
                      className={ENTRADA}
                    />
                    <p className="mt-1 text-[11px] text-slate-400">
                      Se descuenta solo al cobrar una orden.
                    </p>
                  </Campo>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => void guardar()}
                    disabled={ocupado}
                    className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white
                               transition hover:bg-indigo-700 disabled:bg-slate-300"
                  >
                    {ocupado ? "Guardando…" : editando ? "Guardar cambios" : "Crear producto"}
                  </button>
                  {editando && (
                    <button
                      onClick={() => {
                        setEditando(null);
                        setBorrador({ ...BORRADOR_VACIO, currency: monedaEmpresa });
                      }}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700
                                 transition hover:bg-slate-50"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-900">Categorías</h2>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {categorias.length === 0 && (
                  <li className="text-slate-400">Todavía no hay categorías.</li>
                )}
                {categorias.map((c) => <li key={c.id}>{c.name}</li>)}
              </ul>
              <div className="mt-3 flex gap-2">
                <input
                  value={nuevaCategoria}
                  onChange={(e) => setNuevaCategoria(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void crearCategoria(); }}
                  placeholder="Nueva categoría"
                  className={ENTRADA}
                />
                <button
                  onClick={() => void crearCategoria()}
                  disabled={ocupado || nuevaCategoria.trim() === ""}
                  className="rounded-lg border border-slate-300 px-3 text-sm text-slate-700
                             transition hover:bg-slate-50 disabled:opacity-50"
                >
                  Añadir
                </button>
              </div>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}

const ENTRADA =
  "w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm " +
  "focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none";

function Campo({
  etiqueta, opcional, children,
}: {
  etiqueta: string;
  opcional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-700">
        {etiqueta}
        {opcional && <span className="ml-1 font-normal text-slate-400">(opcional)</span>}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
