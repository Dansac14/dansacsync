// =============================================================================
// Ajustes de la empresa y del agente
// =============================================================================
// Todo lo que en la especificacion original estaba fijo en el codigo del prompt
// se edita aqui: nombre del bot, tono, modelo, umbral de similitud, palabras que
// disparan el escalado y los mensajes que ve el cliente. Cambiarlo no requiere
// un despliegue.
// =============================================================================

"use client";

import { useCallback, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Aviso } from "@/components/shell/Aviso";

export interface Ajustes {
  tenant_id: string;
  company_name: string;
  trade_name: string | null;
  logo_url: string | null;
  primary_color: string;
  default_language: string;
  default_currency: string;
  timezone: string;
  support_phone: string | null;
  support_email: string | null;
  tax_id_number: string;
  legal_address: string;
  invoice_series_default: string;
  receipt_series_default: string;
  tax_rate_default: number;
  ai_enabled: boolean;
  ai_bot_name: string;
  ai_tone: string;
  ai_model: string;
  ai_embedding_model: string;
  ai_temperature: number;
  ai_max_output_tokens: number;
  ai_persona_instructions: string | null;
  ai_min_similarity: number;
  ai_match_count: number;
  escalation_keywords: string[];
  escalation_on_no_context: boolean;
  escalation_message: string;
  no_context_message: string;
  ai_unavailable_message: string;
  public_store_url: string | null;
  payment_instructions: string | null;
}

interface CuentaCanal {
  id: string;
  channel: string;
  display_name: string;
  external_account_id: string;
  phone_number: string | null;
  is_active: boolean;
  last_event_at: string | null;
  access_token_secret_name: string | null;
}

interface Documento {
  id: string;
  title: string;
  status: string;
  chunk_count: number;
  updated_at: string;
}

const TONOS = [
  { valor: "friendly", etiqueta: "Cercano" },
  { valor: "professional", etiqueta: "Profesional" },
  { valor: "concise", etiqueta: "Directo" },
  { valor: "warm", etiqueta: "Cálido" },
];

export function SettingsForm({
  ajustesIniciales, esAdmin, cuentas, documentos,
}: {
  ajustesIniciales: Ajustes;
  esAdmin: boolean;
  cuentas: CuentaCanal[];
  documentos: Documento[];
}) {
  const supabase = createSupabaseBrowserClient();

  const [a, setA] = useState<Ajustes>(ajustesIniciales);
  const [palabras, setPalabras] = useState(ajustesIniciales.escalation_keywords.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const set = <K extends keyof Ajustes>(clave: K, valor: Ajustes[K]) =>
    setA((prev) => ({ ...prev, [clave]: valor }));

  const guardar = useCallback(async () => {
    setError(null); setAviso(null);

    if (a.company_name.trim() === "") { setError("La razón social no puede quedar vacía."); return; }
    if (!/^\d{11}$/.test(a.tax_id_number.trim())) {
      setError("El RUC de la empresa debe tener 11 dígitos.");
      return;
    }
    if (a.legal_address.trim() === "") { setError("Falta la dirección fiscal."); return; }
    if (a.ai_min_similarity <= 0 || a.ai_min_similarity >= 1) {
      setError("El umbral de similitud tiene que estar entre 0 y 1.");
      return;
    }
    if (a.public_store_url && !/^https?:\/\//.test(a.public_store_url)) {
      setError("La URL de la tienda debe empezar por http:// o https://");
      return;
    }

    const listaPalabras = palabras
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 1);

    setOcupado(true);
    const { error: e } = await supabase
      .from("company_settings")
      .update({
        company_name: a.company_name.trim(),
        trade_name: a.trade_name?.trim() || null,
        logo_url: a.logo_url?.trim() || null,
        primary_color: a.primary_color,
        default_language: a.default_language,
        default_currency: a.default_currency,
        timezone: a.timezone,
        support_phone: a.support_phone?.trim() || null,
        support_email: a.support_email?.trim() || null,
        tax_id_number: a.tax_id_number.trim(),
        legal_address: a.legal_address.trim(),
        invoice_series_default: a.invoice_series_default.trim().toUpperCase(),
        receipt_series_default: a.receipt_series_default.trim().toUpperCase(),
        ai_enabled: a.ai_enabled,
        ai_bot_name: a.ai_bot_name.trim(),
        ai_tone: a.ai_tone,
        ai_model: a.ai_model.trim(),
        ai_temperature: a.ai_temperature,
        ai_max_output_tokens: a.ai_max_output_tokens,
        ai_persona_instructions: a.ai_persona_instructions?.trim() || null,
        ai_min_similarity: a.ai_min_similarity,
        ai_match_count: a.ai_match_count,
        escalation_keywords: listaPalabras,
        escalation_on_no_context: a.escalation_on_no_context,
        escalation_message: a.escalation_message.trim(),
        no_context_message: a.no_context_message.trim(),
        ai_unavailable_message: a.ai_unavailable_message.trim(),
        public_store_url: a.public_store_url?.trim() || null,
        payment_instructions: a.payment_instructions?.trim() || null,
      })
      .eq("tenant_id", a.tenant_id);
    setOcupado(false);

    if (e) { setError(e.message); return; }
    setAviso("Ajustes guardados. El worker los recoge en menos de un minuto.");
  }, [supabase, a, palabras]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Ajustes</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Datos de la empresa, comportamiento del agente y canales conectados.
        </p>
      </div>

      {error && <Aviso tono="error" onCerrar={() => setError(null)}>{error}</Aviso>}
      {aviso && <Aviso tono="exito" onCerrar={() => setAviso(null)}>{aviso}</Aviso>}
      {!esAdmin && (
        <Aviso tono="neutro">
          Solo un administrador o propietario puede cambiar estos ajustes.
        </Aviso>
      )}

      <fieldset disabled={!esAdmin} className="space-y-5">
        {/* ---------------------------------------------------------------- */}
        <Bloque titulo="Empresa">
          <Campo etiqueta="Razón social">
            <input value={a.company_name} onChange={(e) => set("company_name", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo etiqueta="Nombre comercial" ayuda="Es el que ve el cliente en la página de pago.">
            <input value={a.trade_name ?? ""} onChange={(e) => set("trade_name", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo etiqueta="RUC">
            <input
              value={a.tax_id_number}
              onChange={(e) => set("tax_id_number", e.target.value.replace(/\D/g, ""))}
              maxLength={11} inputMode="numeric" className={`${ENTRADA} font-mono`}
            />
          </Campo>
          <Campo etiqueta="Dirección fiscal">
            <input value={a.legal_address} onChange={(e) => set("legal_address", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo etiqueta="Teléfono de soporte">
            <input value={a.support_phone ?? ""} onChange={(e) => set("support_phone", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo etiqueta="Correo de soporte">
            <input value={a.support_email ?? ""} onChange={(e) => set("support_email", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo etiqueta="Moneda">
            <select value={a.default_currency} onChange={(e) => set("default_currency", e.target.value)} className={ENTRADA}>
              <option value="PEN">PEN · soles</option>
              <option value="USD">USD · dólares</option>
            </select>
          </Campo>
          <Campo etiqueta="Idioma por defecto">
            <select value={a.default_language} onChange={(e) => set("default_language", e.target.value)} className={ENTRADA}>
              <option value="es">Español</option>
              <option value="en">Inglés</option>
              <option value="pt">Portugués</option>
            </select>
          </Campo>
          <Campo etiqueta="Serie de boletas">
            <input value={a.receipt_series_default} onChange={(e) => set("receipt_series_default", e.target.value)}
                   maxLength={10} className={`${ENTRADA} font-mono`} />
          </Campo>
          <Campo etiqueta="Serie de facturas">
            <input value={a.invoice_series_default} onChange={(e) => set("invoice_series_default", e.target.value)}
                   maxLength={10} className={`${ENTRADA} font-mono`} />
          </Campo>
        </Bloque>

        {/* ---------------------------------------------------------------- */}
        <Bloque titulo="Tienda y pagos">
          <Campo
            etiqueta="URL pública de la tienda"
            ayuda="Se usa para el enlace que acompaña cada ficha de producto y cada orden. Sin esto, la ficha se envía sin enlace en lugar de con uno roto."
          >
            <input value={a.public_store_url ?? ""} onChange={(e) => set("public_store_url", e.target.value)}
                   placeholder="https://tienda.miempresa.pe" className={ENTRADA} />
          </Campo>
          <Campo
            ancho
            etiqueta="Instrucciones de pago"
            ayuda="Es lo que el cliente lee en la página de su orden: cuentas bancarias, Yape, Plin."
          >
            <textarea value={a.payment_instructions ?? ""} onChange={(e) => set("payment_instructions", e.target.value)}
                      rows={3} className={`${ENTRADA} resize-y`} />
          </Campo>
        </Bloque>

        {/* ---------------------------------------------------------------- */}
        <Bloque titulo="Agente de IA">
          <Campo ancho etiqueta="">
            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input type="checkbox" checked={a.ai_enabled}
                     onChange={(e) => set("ai_enabled", e.target.checked)}
                     className="rounded border-slate-300" />
              El agente responde automáticamente
            </label>
            <p className="mt-1 text-[11px] text-slate-400">
              Si lo apagas, los mensajes siguen entrando y quedan en la bandeja
              esperando a una persona.
            </p>
          </Campo>

          <Campo etiqueta="Nombre del asistente">
            <input value={a.ai_bot_name} onChange={(e) => set("ai_bot_name", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo etiqueta="Tono">
            <select value={a.ai_tone} onChange={(e) => set("ai_tone", e.target.value)} className={ENTRADA}>
              {TONOS.map((t) => <option key={t.valor} value={t.valor}>{t.etiqueta}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Modelo">
            <input value={a.ai_model} onChange={(e) => set("ai_model", e.target.value)} className={`${ENTRADA} font-mono`} />
          </Campo>
          <Campo
            etiqueta="Modelo de embeddings"
            ayuda="No se cambia desde aquí: cambiarlo obliga a reindexar todos los manuales, porque un índice hecho con un modelo no sirve para buscar con otro."
          >
            <input value={a.ai_embedding_model} disabled className={`${ENTRADA} bg-slate-50 font-mono text-slate-500`} />
          </Campo>

          <Campo
            etiqueta={`Umbral de similitud: ${a.ai_min_similarity.toFixed(2)}`}
            ayuda="Más alto, el agente calla y escala más; más bajo, responde con contexto menos relacionado."
          >
            <input type="range" min={0.1} max={0.9} step={0.05}
                   value={a.ai_min_similarity}
                   onChange={(e) => set("ai_min_similarity", Number(e.target.value))}
                   className="w-full" />
          </Campo>
          <Campo etiqueta={`Fragmentos por consulta: ${a.ai_match_count}`}>
            <input type="range" min={1} max={20} step={1}
                   value={a.ai_match_count}
                   onChange={(e) => set("ai_match_count", Number(e.target.value))}
                   className="w-full" />
          </Campo>
          <Campo etiqueta={`Temperatura: ${Number(a.ai_temperature).toFixed(2)}`}
                 ayuda="Baja para atención al cliente: interesa que repita bien el dato, no que sea creativo.">
            <input type="range" min={0} max={1} step={0.05}
                   value={a.ai_temperature}
                   onChange={(e) => set("ai_temperature", Number(e.target.value))}
                   className="w-full" />
          </Campo>
          <Campo etiqueta="Máximo de palabras por respuesta (tokens)">
            <input type="number" min={100} max={2000} step={50}
                   value={a.ai_max_output_tokens}
                   onChange={(e) => set("ai_max_output_tokens", Number(e.target.value))}
                   className={ENTRADA} />
          </Campo>

          <Campo ancho etiqueta="Instrucciones adicionales"
                 ayuda="Se añaden al final de las reglas del agente. No pueden hacer que invente datos: la regla de responder solo con el manual está por encima.">
            <textarea value={a.ai_persona_instructions ?? ""}
                      onChange={(e) => set("ai_persona_instructions", e.target.value)}
                      rows={3} className={`${ENTRADA} resize-y`} />
          </Campo>
        </Bloque>

        {/* ---------------------------------------------------------------- */}
        <Bloque titulo="Escalado a una persona">
          <Campo ancho etiqueta="Palabras que escalan la conversación"
                 ayuda="Separadas por comas. Si el cliente escribe cualquiera de ellas, la conversación pasa a un operador sin consultar al modelo.">
            <textarea value={palabras} onChange={(e) => setPalabras(e.target.value)}
                      rows={2} className={`${ENTRADA} resize-y`} />
          </Campo>

          <Campo ancho etiqueta="">
            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input type="checkbox" checked={a.escalation_on_no_context}
                     onChange={(e) => set("escalation_on_no_context", e.target.checked)}
                     className="rounded border-slate-300" />
              Escalar cuando el manual no tenga la respuesta
            </label>
            <p className="mt-1 text-[11px] text-slate-400">
              Recomendado. Si lo apagas, el agente simplemente no responde a lo
              que no encuentra, y el cliente se queda esperando.
            </p>
          </Campo>

          <Campo ancho etiqueta="Mensaje al pasar a una persona">
            <input value={a.escalation_message} onChange={(e) => set("escalation_message", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo ancho etiqueta="Mensaje cuando no hay respuesta en el manual">
            <input value={a.no_context_message} onChange={(e) => set("no_context_message", e.target.value)} className={ENTRADA} />
          </Campo>
          <Campo ancho etiqueta="Mensaje si el agente no está disponible">
            <input value={a.ai_unavailable_message} onChange={(e) => set("ai_unavailable_message", e.target.value)} className={ENTRADA} />
          </Campo>
        </Bloque>

        {esAdmin && (
          <div className="sticky bottom-4 flex justify-end">
            <button
              onClick={() => void guardar()}
              disabled={ocupado}
              className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white
                         shadow-lg transition hover:bg-indigo-700 disabled:bg-slate-300"
            >
              {ocupado ? "Guardando…" : "Guardar ajustes"}
            </button>
          </div>
        )}
      </fieldset>

      {/* ------------------------------------------------------------------ */}
      <Bloque titulo="Canales conectados">
        {cuentas.length === 0 ? (
          <p className="col-span-2 text-sm text-slate-500">
            Ningún canal conectado. Los mensajes entrantes de un canal sin dar de
            alta se guardan para diagnóstico y no se procesan, porque no hay
            forma de saber a qué empresa pertenecen.
          </p>
        ) : (
          <ul className="col-span-2 divide-y divide-slate-100">
            {cuentas.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-24 text-xs font-medium capitalize">{c.channel}</span>
                <span className="min-w-0 flex-1 truncate">{c.display_name}</span>
                <span className="font-mono text-[11px] text-slate-400">
                  {c.phone_number ?? c.external_account_id}
                </span>
                {!c.access_token_secret_name && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
                    sin token propio
                  </span>
                )}
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  c.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-500"
                }`}>
                  {c.is_active ? "activo" : "inactivo"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Bloque>

      <Bloque titulo="Manuales indexados">
        {documentos.length === 0 ? (
          <p className="col-span-2 text-sm text-slate-500">
            Sin manuales indexados. Hasta que haya al menos uno, el agente escala
            todas las consultas a una persona en lugar de improvisar respuestas.
            Se indexan con <code className="font-mono text-xs">npm run ingest</code> desde el worker.
          </p>
        ) : (
          <ul className="col-span-2 divide-y divide-slate-100">
            {documentos.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <span className="text-xs text-slate-500">{d.chunk_count} fragmentos</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  d.status === "indexed" ? "bg-emerald-100 text-emerald-800"
                  : d.status === "failed" ? "bg-rose-100 text-rose-800"
                  : "bg-slate-200 text-slate-600"
                }`}>
                  {d.status === "indexed" ? "indexado"
                   : d.status === "failed" ? "falló" : d.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Bloque>
    </div>
  );
}

const ENTRADA =
  "w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm " +
  "focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none " +
  "disabled:bg-slate-50 disabled:text-slate-400";

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{titulo}</h2>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </section>
  );
}

function Campo({
  etiqueta, ayuda, ancho, children,
}: {
  etiqueta: string;
  ayuda?: string;
  ancho?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={ancho ? "md:col-span-2" : undefined}>
      {etiqueta && (
        <label className="block text-xs font-medium text-slate-700">{etiqueta}</label>
      )}
      <div className={etiqueta ? "mt-1" : undefined}>{children}</div>
      {ayuda && <p className="mt-1 text-[11px] text-slate-400">{ayuda}</p>}
    </div>
  );
}
