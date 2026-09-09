// =============================================================================
// Ordenes
// =============================================================================
// Ninguna operacion de dinero se calcula aqui. La interfaz dice QUE se cobra
// —contacto, productos y cantidades— y la base calcula CUANTO, descuenta stock
// y emite el comprobante. Esto no es purismo: si el navegador pudiera enviar el
// total, un comprobante fiscal podria salir con cifras que no corresponden a
// sus lineas.
// =============================================================================

"use client";

import { useCallback, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { money, estadoOrden, esRuc, esDni } from "@/lib/money";
import { formatFull } from "@/lib/format";
import { Aviso } from "@/components/shell/Aviso";

interface ContactoLigero {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  tax_id_number: string | null;
  tax_name: string | null;
}

interface ProductoLigero {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  currency: string;
  tax_rate: number;
  track_stock: boolean;
  stock_quantity: number;
}

interface Comprobante {
  id: string;
  full_number: string;
  kind: string;
  state: string;
  total: number;
}

interface Orden {
  id: string;
  order_number: number;
  contact_id: string;
  status: string;
  currency: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  paid_at: string | null;
  created_at: string;
  public_token: string;
  contacts: { first_name: string | null; last_name: string | null; phone: string | null } | null;
  sales_invoices: Comprobante[];
}

interface LineaBorrador {
  producto: ProductoLigero;
  cantidad: number;
}

const ESTADOS = [
  { valor: "todos", etiqueta: "Todas" },
  { valor: "pending_payment", etiqueta: "Por cobrar" },
  { valor: "paid", etiqueta: "Pagadas" },
  { valor: "draft", etiqueta: "Borradores" },
] as const;

export function OrdersManager({
  tenantId, ordenesIniciales, contactos, productos, monedaEmpresa,
  serieBoleta, serieFactura, urlTienda,
}: {
  tenantId: string;
  ordenesIniciales: Orden[];
  contactos: ContactoLigero[];
  productos: ProductoLigero[];
  monedaEmpresa: string;
  serieBoleta: string;
  serieFactura: string;
  urlTienda: string | null;
}) {
  const supabase = createSupabaseBrowserClient();

  const [ordenes, setOrdenes] = useState<Orden[]>(ordenesIniciales);
  const [filtro, setFiltro] = useState<string>("todos");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Nueva orden
  const [creando, setCreando] = useState(false);
  const [contactoId, setContactoId] = useState("");
  const [buscaContacto, setBuscaContacto] = useState("");
  const [lineas, setLineas] = useState<LineaBorrador[]>([]);

  // Emision de comprobante
  const [emitiendo, setEmitiendo] = useState<Orden | null>(null);
  const [tipoDoc, setTipoDoc] = useState<"boleta" | "factura">("boleta");
  const [docReceptor, setDocReceptor] = useState("");
  const [nombreReceptor, setNombreReceptor] = useState("");

  const recargar = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("orders")
      .select(`id, order_number, contact_id, status, currency, subtotal, tax_amount, total,
               paid_at, created_at, public_token,
               contacts(first_name, last_name, phone),
               sales_invoices(id, full_number, kind, state, total)`)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (e) { setError(e.message); return; }
    setOrdenes((data ?? []) as unknown as Orden[]);
  }, [supabase, tenantId]);

  // ---------------------------------------------------------------------------
  // Crear
  // ---------------------------------------------------------------------------

  const totalBorrador = useMemo(
    // Este total es solo una vista previa para la persona que crea la orden.
    // El que vale es el que calcula la base al guardar las lineas.
    () => lineas.reduce((suma, l) => suma + l.producto.price * l.cantidad, 0),
    [lineas],
  );

  const crearOrden = useCallback(async () => {
    setError(null); setAviso(null);

    if (!contactoId) { setError("Elige a qué contacto se le factura."); return; }
    if (lineas.length === 0) { setError("Añade al menos un producto."); return; }

    const monedas = new Set(lineas.map((l) => l.producto.currency));
    if (monedas.size > 1) {
      setError("Todos los productos de una orden deben estar en la misma moneda.");
      return;
    }

    setOcupado(true);

    const { data: orden, error: eOrden } = await supabase
      .from("orders")
      .insert({
        tenant_id: tenantId,
        contact_id: contactoId,
        currency: lineas[0]!.producto.currency,
        status: "pending_payment",
      })
      .select("id")
      .single();

    if (eOrden || !orden) {
      setOcupado(false);
      setError(`No se pudo crear la orden: ${eOrden?.message ?? "sin respuesta"}`);
      return;
    }

    const { error: eLineas } = await supabase.from("order_items").insert(
      lineas.map((l) => ({
        tenant_id: tenantId,
        order_id: (orden as { id: string }).id,
        product_id: l.producto.id,
        // Copia congelada: si el precio cambia mañana, esta orden conserva el
        // que se cobró.
        name: l.producto.name,
        sku: l.producto.sku,
        unit_price: l.producto.price,
        quantity: l.cantidad,
        tax_rate: l.producto.tax_rate,
      })),
    );

    setOcupado(false);

    if (eLineas) {
      // La orden quedó sin líneas y con total cero. Se avisa en lugar de
      // dejarla escondida: es visible en la lista como borrador vacío.
      setError(
        `La orden se creó pero sus líneas fallaron: ${eLineas.message}. ` +
        `Revísala en la lista y complétala o anúlala.`,
      );
      void recargar();
      return;
    }

    setAviso("Orden creada.");
    setCreando(false);
    setContactoId("");
    setLineas([]);
    void recargar();
  }, [supabase, tenantId, contactoId, lineas, recargar]);

  // ---------------------------------------------------------------------------
  // Cobrar
  // ---------------------------------------------------------------------------

  const cobrar = useCallback(async (orden: Orden) => {
    setError(null); setAviso(null);
    setOcupado(true);

    const { error: e } = await supabase.rpc("mark_order_paid", {
      p_order_id: orden.id,
      p_provider: "registro manual",
      p_reference: null,
    });

    setOcupado(false);

    if (e) {
      // El mensaje de la base ya explica el motivo, incluido el stock
      // insuficiente con el nombre del producto.
      setError(e.message);
      return;
    }
    setAviso(`Orden ${orden.order_number} cobrada. El stock se descontó solo.`);
    void recargar();
  }, [supabase, recargar]);

  // ---------------------------------------------------------------------------
  // Emitir comprobante
  // ---------------------------------------------------------------------------

  const abrirEmision = useCallback((orden: Orden) => {
    const contacto = contactos.find((c) => c.id === orden.contact_id);
    setEmitiendo(orden);
    setTipoDoc("boleta");
    setDocReceptor(contacto?.tax_id_number ?? "");
    setNombreReceptor(
      contacto?.tax_name
      ?? [contacto?.first_name, contacto?.last_name].filter(Boolean).join(" ")
      ?? "",
    );
    setError(null); setAviso(null);
  }, [contactos]);

  const emitir = useCallback(async () => {
    if (!emitiendo) return;

    const doc = docReceptor.trim();
    const nombre = nombreReceptor.trim();

    if (nombre === "") { setError("Falta el nombre o razón social del receptor."); return; }

    // Se valida antes de llamar: la base tiene la misma regla, pero un aviso
    // aquí es más claro que un error de restricción.
    if (tipoDoc === "factura" && !esRuc(doc)) {
      setError("Una factura necesita un RUC de 11 dígitos.");
      return;
    }
    if (tipoDoc === "boleta" && doc !== "" && !esDni(doc) && !esRuc(doc)) {
      setError("Para la boleta, el documento debe ser un DNI de 8 dígitos o un RUC de 11.");
      return;
    }

    setOcupado(true);
    const { data, error: e } = await supabase.rpc("issue_invoice_for_order", {
      p_order_id: emitiendo.id,
      p_kind: tipoDoc,
      p_series: tipoDoc === "factura" ? serieFactura : serieBoleta,
      p_receiver_tax_id: doc === "" ? "00000000" : doc,
      p_receiver_name: nombre,
      p_receiver_address: null,
    });
    setOcupado(false);

    if (e) { setError(e.message); return; }

    const emitido = (Array.isArray(data) ? data[0] : data) as { full_number?: string } | null;
    setAviso(`Comprobante ${emitido?.full_number ?? ""} emitido.`);
    setEmitiendo(null);
    void recargar();
  }, [supabase, emitiendo, tipoDoc, docReceptor, nombreReceptor, serieBoleta, serieFactura, recargar]);

  // ---------------------------------------------------------------------------

  const visibles = useMemo(
    () => filtro === "todos" ? ordenes : ordenes.filter((o) => o.status === filtro),
    [ordenes, filtro],
  );

  const contactosFiltrados = useMemo(() => {
    const q = buscaContacto.trim().toLowerCase();
    if (!q) return contactos.slice(0, 30);
    return contactos.filter((c) =>
      `${c.first_name ?? ""} ${c.last_name ?? ""} ${c.phone ?? ""}`.toLowerCase().includes(q),
    ).slice(0, 30);
  }, [contactos, buscaContacto]);

  const nombreContacto = (orden: Orden) => {
    const c = orden.contacts;
    const completo = [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim();
    return completo || c?.phone || "Contacto sin nombre";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Órdenes</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {ordenes.filter((o) => o.status === "pending_payment").length} por cobrar ·
            {" "}{ordenes.filter((o) => o.status === "paid").length} pagadas
          </p>
        </div>
        <button
          onClick={() => { setCreando(!creando); setError(null); setAviso(null); }}
          className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white
                     transition hover:bg-indigo-700"
        >
          {creando ? "Cancelar" : "Nueva orden"}
        </button>
      </div>

      {error && <Aviso tono="error" onCerrar={() => setError(null)}>{error}</Aviso>}
      {aviso && <Aviso tono="exito" onCerrar={() => setAviso(null)}>{aviso}</Aviso>}

      {/* -------------------------------------------------------------------- */}
      {creando && (
        <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Nueva orden</h2>

          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">Contacto</label>
              <input
                value={buscaContacto}
                onChange={(e) => setBuscaContacto(e.target.value)}
                placeholder="Buscar por nombre o teléfono"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
              <select
                value={contactoId}
                onChange={(e) => setContactoId(e.target.value)}
                size={6}
                className="mt-2 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="">— elegir —</option>
                {contactosFiltrados.map((c) => (
                  <option key={c.id} value={c.id}>
                    {[c.first_name, c.last_name].filter(Boolean).join(" ") || "Sin nombre"}
                    {c.phone ? ` · ${c.phone}` : ""}
                  </option>
                ))}
              </select>
              {contactos.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-700">
                  Todavía no hay contactos. Aparecen solos cuando alguien escribe
                  por un canal.
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">Productos</label>
              <select
                value=""
                onChange={(e) => {
                  const producto = productos.find((p) => p.id === e.target.value);
                  if (!producto) return;
                  setLineas((prev) =>
                    prev.some((l) => l.producto.id === producto.id)
                      ? prev.map((l) => l.producto.id === producto.id
                          ? { ...l, cantidad: l.cantidad + 1 } : l)
                      : [...prev, { producto, cantidad: 1 }]);
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="">— añadir producto —</option>
                {productos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {money(p.price, p.currency)}
                    {p.track_stock ? ` · stock ${p.stock_quantity}` : ""}
                  </option>
                ))}
              </select>

              <ul className="mt-2 space-y-1">
                {lineas.length === 0 && (
                  <li className="text-xs text-slate-400">Sin productos todavía.</li>
                )}
                {lineas.map((linea) => (
                  <li key={linea.producto.id}
                      className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">{linea.producto.name}</span>
                    <input
                      type="number"
                      min={1}
                      value={linea.cantidad}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setLineas((prev) => prev.map((l) =>
                          l.producto.id === linea.producto.id
                            ? { ...l, cantidad: Number.isInteger(n) && n > 0 ? n : 1 } : l));
                      }}
                      className="w-14 rounded border border-slate-300 px-1 py-0.5 text-right"
                    />
                    <span className="w-24 text-right whitespace-nowrap">
                      {money(linea.producto.price * linea.cantidad, linea.producto.currency)}
                    </span>
                    <button
                      onClick={() => setLineas((prev) =>
                        prev.filter((l) => l.producto.id !== linea.producto.id))}
                      className="text-slate-400 hover:text-rose-600"
                      aria-label={`Quitar ${linea.producto.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>

              {lineas.length > 0 && (
                <p className="mt-2 text-right text-sm font-medium text-slate-800">
                  {money(totalBorrador, lineas[0]!.producto.currency)}
                  <span className="ml-1 text-[10px] font-normal text-slate-400">
                    vista previa · el total lo calcula la base
                  </span>
                </p>
              )}
            </div>
          </div>

          <button
            onClick={() => void crearOrden()}
            disabled={ocupado}
            className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white
                       transition hover:bg-indigo-700 disabled:bg-slate-300"
          >
            {ocupado ? "Creando…" : "Crear orden"}
          </button>
        </section>
      )}

      {/* -------------------------------------------------------------------- */}
      <div className="flex flex-wrap gap-1">
        {ESTADOS.map((estado) => (
          <button
            key={estado.valor}
            onClick={() => setFiltro(estado.valor)}
            aria-pressed={filtro === estado.valor}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
              filtro === estado.valor
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {estado.etiqueta}
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {visibles.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            {ordenes.length === 0
              ? "Todavía no hay órdenes."
              : "Ninguna orden en este estado."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">N.º</th>
                  <th className="px-3 py-2 font-medium">Contacto</th>
                  <th className="px-3 py-2 font-medium">Fecha</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2 font-medium">Comprobante</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibles.map((orden) => {
                  const estado = estadoOrden(orden.status);
                  const comprobante = orden.sales_invoices?.find(
                    (i) => i.state !== "voided" && (i.kind === "boleta" || i.kind === "factura"));

                  return (
                    <tr key={orden.id}>
                      <td className="px-3 py-2 font-mono text-xs">{orden.order_number}</td>
                      <td className="px-3 py-2">{nombreContacto(orden)}</td>
                      <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                        {formatFull(orden.created_at)}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {money(orden.total, orden.currency)}
                        <span className="block text-[10px] text-slate-400">
                          IGV {money(orden.tax_amount, orden.currency)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${estado.clase}`}>
                          {estado.texto}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {comprobante
                          ? <span className="font-mono">{comprobante.full_number}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {orden.status === "pending_payment" && (
                          <button
                            onClick={() => void cobrar(orden)}
                            disabled={ocupado}
                            className="text-xs text-emerald-700 hover:underline disabled:opacity-50"
                          >
                            registrar pago
                          </button>
                        )}
                        {(orden.status === "paid" || orden.status === "fulfilled")
                          && !comprobante && (
                          <button
                            onClick={() => abrirEmision(orden)}
                            className="ml-3 text-xs text-indigo-600 hover:underline"
                          >
                            emitir comprobante
                          </button>
                        )}
                        {urlTienda && (
                          <button
                            onClick={async () => {
                              const enlace = `${urlTienda.replace(/\/$/, "")}/p/${orden.public_token}`;
                              // En contexto no seguro o sin permiso, la promesa
                              // se rechaza. Antes se anunciaba "copiado" igual y
                              // el rechazo quedaba sin manejar: el usuario pegaba
                              // algo que no estaba en el portapapeles.
                              try {
                                await navigator.clipboard.writeText(enlace);
                                setAviso(`Enlace de la orden ${orden.order_number} copiado.`);
                              } catch {
                                setError(`No se pudo copiar. El enlace es: ${enlace}`);
                              }
                            }}
                            className="ml-3 text-xs text-slate-500 hover:underline"
                          >
                            copiar enlace
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* -------------------------------------------------------------------- */}
      {emitiendo && (
        <section className="rounded-xl border border-slate-300 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">
            Emitir comprobante · orden {emitiendo.order_number} ·
            {" "}{money(emitiendo.total, emitiendo.currency)}
          </h2>

          <p className="mt-1 text-xs text-slate-500">
            Los importes se copian de las líneas de la orden. Aquí solo se indica
            a nombre de quién se emite.
          </p>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">Tipo</label>
              <select
                value={tipoDoc}
                onChange={(e) => setTipoDoc(e.target.value as "boleta" | "factura")}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="boleta">Boleta · serie {serieBoleta}</option>
                <option value="factura">Factura · serie {serieFactura}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                {tipoDoc === "factura" ? "RUC" : "DNI o RUC"}
                {tipoDoc === "boleta" && (
                  <span className="ml-1 font-normal text-slate-400">(opcional)</span>
                )}
              </label>
              <input
                value={docReceptor}
                onChange={(e) => setDocReceptor(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                maxLength={11}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                {tipoDoc === "factura" ? "Razón social" : "Nombre"}
              </label>
              <input
                value={nombreReceptor}
                onChange={(e) => setNombreReceptor(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => void emitir()}
              disabled={ocupado}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white
                         transition hover:bg-indigo-700 disabled:bg-slate-300"
            >
              {ocupado ? "Emitiendo…" : "Emitir"}
            </button>
            <button
              onClick={() => setEmitiendo(null)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700
                         transition hover:bg-slate-50"
            >
              Cancelar
            </button>
          </div>

          <p className="mt-3 text-[11px] text-slate-400">
            El comprobante queda registrado con su serie y correlativo. El envío
            a la administración tributaria lo hace el OSE o PSE que se conecte
            después: aquí se guardan el documento y su respuesta.
          </p>
        </section>
      )}
    </div>
  );
}
