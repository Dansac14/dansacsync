// =============================================================================
// Resumen financiero
// =============================================================================
// Aqui no hay grafico, y es deliberado: lo que se necesita saber son cuatro
// cifras de un periodo, no una tendencia. Un grafico de cuatro barras ocupa
// media pantalla para decir lo que dicen cuatro numeros grandes.
//
// Todas las cifras vienen de financial_summary() en la base. El navegador no
// suma nada: sumar decimales en JavaScript produce diferencias de centimos, y
// un resumen que no cuadra con la suma de los comprobantes no sirve de nada.
// =============================================================================

"use client";

import { useCallback, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { money, parseAmount } from "@/lib/money";
import { Aviso } from "@/components/shell/Aviso";

export interface Resumen {
  ventas_base: number;
  ventas_igv: number;
  ventas_total: number;
  comprobantes: number;
  gastos_base: number;
  gastos_igv: number;
  gastos_total: number;
  documentos_gasto: number;
  resultado: number;
  igv_por_pagar: number;
}

interface Gasto {
  id: string;
  supplier_name: string;
  supplier_tax_id: string | null;
  document_kind: string;
  document_number: string | null;
  category: string;
  currency: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  expense_date: string;
}

interface Comprobante {
  id: string;
  full_number: string;
  kind: string;
  state: string;
  receiver_name: string;
  receiver_tax_id: string;
  currency: string;
  total: number;
  issued_at: string;
}

const CATEGORIAS = [
  "Materiales", "Servicios", "Alquiler", "Personal", "Publicidad",
  "Transporte", "Software", "Impuestos", "Otros",
];

export function FinanceDashboard({
  tenantId, esAdmin, moneda, resumenInicial, desdeInicial, hastaInicial,
  gastosIniciales, comprobantesIniciales, tasaIgv,
}: {
  tenantId: string;
  esAdmin: boolean;
  moneda: string;
  resumenInicial: Resumen | null;
  desdeInicial: string;
  hastaInicial: string;
  gastosIniciales: Gasto[];
  comprobantesIniciales: Comprobante[];
  tasaIgv: number;
}) {
  const supabase = createSupabaseBrowserClient();

  const [desde, setDesde] = useState(desdeInicial);
  const [hasta, setHasta] = useState(hastaInicial);
  const [resumen, setResumen] = useState<Resumen | null>(resumenInicial);
  const [gastos, setGastos] = useState<Gasto[]>(gastosIniciales);
  const [comprobantes, setComprobantes] = useState<Comprobante[]>(comprobantesIniciales);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Nuevo gasto
  const [proveedor, setProveedor] = useState("");
  const [rucProveedor, setRucProveedor] = useState("");
  const [numeroDoc, setNumeroDoc] = useState("");
  const [categoria, setCategoria] = useState(CATEGORIAS[0]!);
  const [importe, setImporte] = useState("");
  const [conIgv, setConIgv] = useState(true);
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));

  const consultar = useCallback(async () => {
    setError(null);
    setOcupado(true);

    // Las tres consultas usan el MISMO periodo. La tabla de comprobantes se
    // quedaba fuera de esta funcion: al cambiar a "90 dias" las cifras de
    // arriba y los gastos se actualizaban y los comprobantes seguian siendo
    // los del mes en curso. Dos tablas contradictorias en la misma pantalla.
    const [r, g, c] = await Promise.all([
      supabase.rpc("financial_summary", {
        p_tenant_id: tenantId, p_from: desde, p_to: hasta,
      }),
      supabase.from("purchases_and_expenses")
        .select("id, supplier_name, supplier_tax_id, document_kind, document_number, category, currency, subtotal, tax_amount, total, expense_date")
        .eq("tenant_id", tenantId)
        .gte("expense_date", desde)
        .lte("expense_date", hasta)
        .order("expense_date", { ascending: false }),
      supabase.from("sales_invoices")
        .select("id, full_number, kind, state, receiver_name, receiver_tax_id, currency, total, issued_at")
        .eq("tenant_id", tenantId)
        .gte("issued_at", `${desde}T00:00:00`)
        // El limite superior incluye el dia entero: sin la hora, un comprobante
        // emitido hoy a las 15:00 quedaria fuera de un periodo que acaba hoy.
        .lte("issued_at", `${hasta}T23:59:59.999`)
        .order("issued_at", { ascending: false })
        .limit(500),
    ]);

    setOcupado(false);

    if (r.error) { setError(`No se pudo calcular el resumen: ${r.error.message}`); return; }
    if (g.error) { setError(`No se pudieron leer los gastos: ${g.error.message}`); return; }
    if (c.error) { setError(`No se pudieron leer los comprobantes: ${c.error.message}`); return; }

    setResumen((Array.isArray(r.data) ? r.data[0] : r.data) as Resumen);
    setGastos((g.data ?? []) as Gasto[]);
    setComprobantes((c.data ?? []) as Comprobante[]);
  }, [supabase, tenantId, desde, hasta]);

  const registrarGasto = useCallback(async () => {
    setError(null); setAviso(null);

    if (proveedor.trim() === "") { setError("Falta el nombre del proveedor."); return; }

    const total = parseAmount(importe);
    if (total === null || total <= 0) {
      setError("El importe no es válido. Usa solo números, con hasta dos decimales.");
      return;
    }

    // El usuario escribe el total del documento, que es lo que tiene delante.
    // La base imponible y el IGV se derivan de ahí: pedirle las tres cifras
    // invita a que no cuadren.
    const base = conIgv ? Math.round((total / (1 + tasaIgv)) * 100) / 100 : total;
    const igv = conIgv ? Math.round((total - base) * 100) / 100 : 0;

    setOcupado(true);
    const { error: e } = await supabase.from("purchases_and_expenses").insert({
      tenant_id: tenantId,
      supplier_name: proveedor.trim(),
      supplier_tax_id: rucProveedor.trim() || null,
      document_kind: "factura",
      document_number: numeroDoc.trim() || null,
      category: categoria,
      currency: moneda,
      subtotal: base,
      tax_amount: igv,
      total: conIgv ? base + igv : total,
      expense_date: fecha,
    });
    setOcupado(false);

    if (e) { setError(e.message); return; }

    setAviso("Gasto registrado.");
    setProveedor(""); setRucProveedor(""); setNumeroDoc(""); setImporte("");
    void consultar();
  }, [supabase, tenantId, proveedor, rucProveedor, numeroDoc, categoria,
      importe, conIgv, fecha, moneda, tasaIgv, consultar]);

  const resultado = resumen?.resultado ?? 0;
  const ganancia = resultado >= 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Finanzas</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Calculado en la base a partir de los comprobantes emitidos y los gastos
          registrados.
        </p>
      </div>

      {error && <Aviso tono="error" onCerrar={() => setError(null)}>{error}</Aviso>}
      {aviso && <Aviso tono="exito" onCerrar={() => setAviso(null)}>{aviso}</Aviso>}

      {/* Filtros en una sola fila, encima de las cifras que gobiernan. */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <div>
          <label htmlFor="desde" className="block text-xs font-medium text-slate-700">Desde</label>
          <input
            id="desde" type="date" value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className="mt-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label htmlFor="hasta" className="block text-xs font-medium text-slate-700">Hasta</label>
          <input
            id="hasta" type="date" value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className="mt-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <button
          onClick={() => void consultar()}
          disabled={ocupado}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white
                     transition hover:bg-slate-800 disabled:bg-slate-300"
        >
          {ocupado ? "Calculando…" : "Aplicar"}
        </button>

        <div className="ml-auto flex gap-1">
          {[
            { etiqueta: "Este mes", dias: 0 },
            { etiqueta: "30 días", dias: 30 },
            { etiqueta: "90 días", dias: 90 },
          ].map((rango) => (
            <button
              key={rango.etiqueta}
              onClick={() => {
                const hoy = new Date();
                const fin = hoy.toISOString().slice(0, 10);
                const ini = rango.dias === 0
                  ? new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10)
                  : new Date(hoy.getTime() - rango.dias * 86_400_000).toISOString().slice(0, 10);
                setDesde(ini); setHasta(fin);
              }}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium
                         text-slate-600 transition hover:bg-slate-200"
            >
              {rango.etiqueta}
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Cifras cabecera */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Indicador
          etiqueta="Ventas"
          valor={money(resumen?.ventas_total, moneda)}
          detalle={`Base ${money(resumen?.ventas_base, moneda)} · IGV ${money(resumen?.ventas_igv, moneda)}`}
          pie={`${resumen?.comprobantes ?? 0} comprobante${resumen?.comprobantes === 1 ? "" : "s"}`}
        />
        <Indicador
          etiqueta="Gastos"
          valor={money(resumen?.gastos_total, moneda)}
          detalle={`Base ${money(resumen?.gastos_base, moneda)} · IGV ${money(resumen?.gastos_igv, moneda)}`}
          pie={`${resumen?.documentos_gasto ?? 0} documento${resumen?.documentos_gasto === 1 ? "" : "s"}`}
        />
        <Indicador
          etiqueta="Resultado"
          valor={money(Math.abs(resultado), moneda)}
          // El signo se dice con la palabra, no solo con el color: quien no
          // distingue verde de rojo tiene que poder leerlo igual.
          estado={resumen ? (ganancia ? "ganancia" : "pérdida") : undefined}
          estadoBueno={ganancia}
          detalle="Ventas sin IGV menos gastos sin IGV"
        />
        <Indicador
          etiqueta="IGV por pagar"
          valor={money(resumen?.igv_por_pagar, moneda)}
          detalle="IGV de ventas menos IGV de compras"
          pie="Referencia; la declaración la hace tu contador"
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">Comprobantes emitidos</h2>
          </header>
          {comprobantes.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">
              Sin comprobantes en este periodo.
            </p>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-slate-200 bg-white text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Número</th>
                    <th className="px-3 py-2 font-medium">Receptor</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {comprobantes.map((c) => (
                    <tr key={c.id} className={c.kind === "nota_credito" ? "text-rose-700" : ""}>
                      <td className="px-3 py-2 font-mono text-xs">
                        {c.full_number}
                        {c.kind === "nota_credito" && (
                          <span className="ml-1 text-[10px]">(nota de crédito)</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">{c.receiver_name}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {c.kind === "nota_credito" ? "−" : ""}{money(c.total, c.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">Compras y gastos</h2>
          </header>

          {esAdmin && (
            <div className="space-y-2 border-b border-slate-200 bg-slate-50 p-3">
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={proveedor}
                  onChange={(e) => setProveedor(e.target.value)}
                  placeholder="Proveedor"
                  className={ENTRADA}
                />
                <input
                  value={rucProveedor}
                  onChange={(e) => setRucProveedor(e.target.value.replace(/\D/g, ""))}
                  placeholder="RUC (opcional)"
                  inputMode="numeric"
                  maxLength={11}
                  className={`${ENTRADA} font-mono`}
                />
                <input
                  value={numeroDoc}
                  onChange={(e) => setNumeroDoc(e.target.value)}
                  placeholder="N.º de documento"
                  className={ENTRADA}
                />
                <select
                  value={categoria}
                  onChange={(e) => setCategoria(e.target.value)}
                  className={ENTRADA}
                >
                  {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input
                  value={importe}
                  onChange={(e) => setImporte(e.target.value)}
                  placeholder="Total del documento"
                  inputMode="decimal"
                  className={ENTRADA}
                />
                <input
                  type="date"
                  value={fecha}
                  onChange={(e) => setFecha(e.target.value)}
                  className={ENTRADA}
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={conIgv}
                    onChange={(e) => setConIgv(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  El importe incluye IGV ({(tasaIgv * 100).toFixed(0)} %)
                </label>
                <button
                  onClick={() => void registrarGasto()}
                  disabled={ocupado}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white
                             transition hover:bg-slate-800 disabled:bg-slate-300"
                >
                  Registrar gasto
                </button>
              </div>
            </div>
          )}

          {gastos.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">
              Sin gastos en este periodo.
            </p>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-slate-200 bg-white text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Proveedor</th>
                    <th className="px-3 py-2 font-medium">Categoría</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {gastos.map((g) => (
                    <tr key={g.id}>
                      <td className="px-3 py-2">
                        <p className="text-xs">{g.supplier_name}</p>
                        <p className="text-[10px] text-slate-400">{g.expense_date}</p>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{g.category}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {money(g.total, g.currency)}
                        <span className="block text-[10px] text-slate-400">
                          IGV {money(g.tax_amount, g.currency)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const ENTRADA =
  "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs " +
  "focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none";

function Indicador({
  etiqueta, valor, detalle, pie, estado, estadoBueno,
}: {
  etiqueta: string;
  valor: string;
  detalle?: string;
  pie?: string;
  estado?: string;
  estadoBueno?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium text-slate-500">{etiqueta}</p>

      <p className="mt-1 flex items-baseline gap-2">
        {/* La cifra va en tinta, no en color de serie: el color se reserva para
            el estado, que además viene con su palabra. */}
        <span className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
          {valor}
        </span>
        {estado && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
            estadoBueno ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
          }`}>
            {estado}
          </span>
        )}
      </p>

      {detalle && <p className="mt-1.5 text-[11px] text-slate-500">{detalle}</p>}
      {pie && <p className="mt-0.5 text-[11px] text-slate-400">{pie}</p>}
    </div>
  );
}
