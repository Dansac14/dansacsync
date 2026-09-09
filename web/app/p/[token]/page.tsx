// =============================================================================
// Pagina publica de una orden
// =============================================================================
// Es la unica pantalla del sistema que abre alguien sin sesion: el cliente que
// recibio el enlace por WhatsApp.
//
// Se busca por token, no por id de orden, y todo lo que se muestra viene de
// order_public_view(), que devuelve solo lo que el comprador necesita ver. La
// pagina no consulta ninguna tabla: si manana se anade una columna con datos
// internos, no puede filtrarse por aqui.
// =============================================================================

import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { money } from "@/lib/money";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tu orden",
  // Una orden no debe aparecer en buscadores aunque alguien comparta el enlace.
  robots: { index: false, follow: false },
};

interface Linea {
  nombre: string;
  cantidad: number;
  precio: number;
  importe: number;
}

interface Vista {
  numero: number;
  estado: string;
  moneda: string;
  subtotal: number;
  igv: number;
  descuento: number;
  total: number;
  creada: string;
  pagada: string | null;
  items: Linea[];
  empresa: {
    nombre: string | null;
    logo: string | null;
    color: string | null;
    telefono: string | null;
    correo: string | null;
    instrucciones: string | null;
  };
}

export default async function OrdenPublicaPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc("order_public_view", { p_token: token });
  const vista = (data ?? null) as Vista | null;

  if (error || !vista) {
    // El mismo mensaje para un token inexistente y para uno mal formado: decir
    // cual es el caso permitiria averiguar que tokens existen.
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-16">
        <div className="max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-base font-semibold text-slate-900">Enlace no válido</h1>
          <p className="mt-2 text-sm text-slate-600">
            Este enlace no corresponde a ninguna orden. Puede haber caducado o
            estar incompleto. Escríbele a la empresa por el mismo canal donde lo
            recibiste y te enviarán uno nuevo.
          </p>
        </div>
      </main>
    );
  }

  const pagada = vista.estado === "paid" || vista.estado === "fulfilled";
  const anulada = vista.estado === "cancelled" || vista.estado === "refunded";

  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <header className="text-center">
        {vista.empresa.logo && (
          // Imagen de un dominio que configura la propia empresa, asi que se
          // usa <img> y no next/image: el optimizador exige lista de dominios.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={vista.empresa.logo}
            alt={vista.empresa.nombre ?? ""}
            className="mx-auto mb-3 h-12 w-auto object-contain"
          />
        )}
        <h1 className="text-lg font-semibold text-slate-900">
          {vista.empresa.nombre ?? "Tu orden"}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">Orden N.º {vista.numero}</p>
      </header>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <div
          className={`mb-4 rounded-lg px-3 py-2 text-center text-sm font-medium ${
            pagada ? "bg-emerald-50 text-emerald-800"
            : anulada ? "bg-slate-100 text-slate-600"
            : "bg-amber-50 text-amber-900"
          }`}
        >
          {pagada ? "Pago registrado. ¡Gracias!"
           : anulada ? "Esta orden ya no está vigente."
           : "Pendiente de pago"}
        </div>

        <ul className="divide-y divide-slate-100">
          {vista.items.map((linea, indice) => (
            <li key={indice} className="flex gap-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="text-slate-800">{linea.nombre}</p>
                <p className="text-xs text-slate-500">
                  {Number(linea.cantidad)} × {money(linea.precio, vista.moneda)}
                </p>
              </div>
              <span className="whitespace-nowrap text-slate-800 tabular-nums">
                {money(linea.importe, vista.moneda)}
              </span>
            </li>
          ))}
        </ul>

        <dl className="mt-4 space-y-1 border-t border-slate-200 pt-3 text-sm">
          <Fila etiqueta="Subtotal" valor={money(vista.subtotal, vista.moneda)} />
          <Fila etiqueta="IGV" valor={money(vista.igv, vista.moneda)} />
          {Number(vista.descuento) > 0 && (
            <Fila etiqueta="Descuento" valor={`− ${money(vista.descuento, vista.moneda)}`} />
          )}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(vista.total, vista.moneda)}</dd>
          </div>
        </dl>
      </div>

      {!pagada && !anulada && vista.empresa.instrucciones && (
        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Cómo pagar</h2>
          <p className="mt-2 text-sm whitespace-pre-wrap text-slate-700">
            {vista.empresa.instrucciones}
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Cuando hayas pagado, envía la constancia por el mismo canal donde
            recibiste este enlace.
          </p>
        </section>
      )}

      {(vista.empresa.telefono || vista.empresa.correo) && (
        <footer className="mt-4 text-center text-xs text-slate-500">
          {vista.empresa.telefono && <span>{vista.empresa.telefono}</span>}
          {vista.empresa.telefono && vista.empresa.correo && <span> · </span>}
          {vista.empresa.correo && <span>{vista.empresa.correo}</span>}
        </footer>
      )}
    </main>
  );
}

function Fila({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <dt>{etiqueta}</dt>
      <dd className="tabular-nums">{valor}</dd>
    </div>
  );
}
