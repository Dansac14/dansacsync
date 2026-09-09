// =============================================================================
// Agente de IA con RAG
// =============================================================================
// Regla que gobierna todo este archivo: el agente responde con lo que esta en
// los manuales de la empresa, o no responde. Nunca rellena un hueco con su
// conocimiento general.
//
// Un asistente de atencion al cliente que improvisa un precio, un horario o una
// condicion de pago no comete un error de estilo: compromete a la empresa con
// algo que no ofrece. Por eso cuando la busqueda no encuentra contexto
// suficiente, la conversacion pasa a una persona en lugar de arriesgar una
// respuesta.
// =============================================================================

import { db } from "../db.ts";
import { log } from "../logger.ts";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const OPENAI_BASE = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

export interface CompanySettings {
  tenant_id: string;
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
  company_name: string;
  default_language: string;
}

export interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  title: string;
  section_name: string | null;
  content: string;
  similarity: number;
}

export type AiOutcome =
  | { action: "silent"; reason: string }
  | { action: "reply"; text: string }
  | { action: "escalate"; text: string; reason: string };

const SETTINGS_TTL_MS = 30_000;
const settingsCache = new Map<string, { value: CompanySettings; expires: number }>();

export async function getCompanySettings(tenantId: string): Promise<CompanySettings> {
  const cached = settingsCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const { data, error } = await db
    .from("company_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .single();

  if (error) {
    throw new Error(`No se pudo leer la configuracion de ${tenantId}: ${error.message}`);
  }

  const settings = data as CompanySettings;
  settingsCache.set(tenantId, { value: settings, expires: Date.now() + SETTINGS_TTL_MS });
  return settings;
}

// -----------------------------------------------------------------------------
// Llamadas al proveedor de IA
// -----------------------------------------------------------------------------

async function callOpenAI(path: string, body: unknown, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OPENAI_BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as any;

    if (!response.ok) {
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`OpenAI ${path}: ${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function embed(text: string, model: string): Promise<number[]> {
  const payload = await callOpenAI("/embeddings", { model, input: text }, 15_000);
  const vector = payload?.data?.[0]?.embedding;

  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("El proveedor devolvio un embedding vacio");
  }
  // El esquema declara vector(1536). Un modelo con otra dimension no falla al
  // llamar: falla al insertar, mucho despues y con un error confuso.
  if (vector.length !== 1536) {
    throw new Error(
      `El modelo ${model} devuelve ${vector.length} dimensiones y el esquema ` +
      `espera 1536. Cambia ai_embedding_model o migra la columna embedding.`,
    );
  }
  return vector as number[];
}

async function searchKnowledge(
  tenantId: string,
  vector: number[],
  settings: CompanySettings,
): Promise<RetrievedChunk[]> {
  const { data, error } = await db.rpc("search_knowledge", {
    p_tenant_id: tenantId,
    // pgvector acepta el literal de texto '[a,b,c]'.
    p_embedding: `[${vector.join(",")}]`,
    p_match_count: settings.ai_match_count,
    p_min_similarity: settings.ai_min_similarity,
  });

  if (error) throw new Error(`search_knowledge: ${error.message}`);
  return (data ?? []) as RetrievedChunk[];
}

// -----------------------------------------------------------------------------
// Instrucciones del sistema
// -----------------------------------------------------------------------------

const ESCALATION_TAG = "[TRANSFERIR_A_OPERADOR]";

function buildSystemPrompt(settings: CompanySettings, context: string): string {
  const persona = settings.ai_persona_instructions?.trim();

  return [
    `Eres ${settings.ai_bot_name}, asistente de ${settings.company_name}.`,
    `Atiendes clientes por redes sociales. Tono: ${settings.ai_tone}.`,
    `Responde en el idioma en que te escriba el cliente; por defecto, ${settings.default_language}.`,
    "",
    "REGLAS:",
    "1. Responde solo con lo que aparece en el CONTEXTO. Si el contexto no",
    "   contiene la respuesta, no la deduzcas ni la completes con conocimiento",
    `   propio: incluye la etiqueta exacta ${ESCALATION_TAG} y nada mas.`,
    "2. Nunca inventes ni estimes precios, plazos, horarios, sedes, descuentos",
    "   ni condiciones de pago. Esos datos solo pueden salir del contexto.",
    `3. Si el cliente pide un descuento, cuotas, financiamiento, factura con`,
    `   retencion o hablar con una persona, incluye ${ESCALATION_TAG}.`,
    "4. Se breve: dos parrafos cortos como maximo. Es un chat, no un correo.",
    "5. No menciones el contexto, los documentos ni que eres un modelo.",
    persona ? `\nINSTRUCCIONES ADICIONALES DE LA EMPRESA:\n${persona}` : "",
    "",
    "CONTEXTO:",
    context,
  ].filter(Boolean).join("\n");
}

function matchesEscalationKeyword(text: string, keywords: string[]): string | null {
  // Se normalizan acentos para que "atencion" encuentre "atención".
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  for (const keyword of keywords) {
    const clean = keyword.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    if (clean.length > 0 && normalized.includes(clean)) return keyword;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Pipeline
// -----------------------------------------------------------------------------

export async function runAiPipeline(params: {
  tenantId: string;
  conversationId: string;
  inboundMessageId: string;
  userText: string;
}): Promise<AiOutcome> {
  const { tenantId, conversationId, inboundMessageId, userText } = params;
  const started = Date.now();
  const settings = await getCompanySettings(tenantId);

  if (!settings.ai_enabled) {
    return { action: "silent", reason: "ai_deshabilitada" };
  }

  const text = userText?.trim() ?? "";
  if (text === "") {
    // Un audio o una imagen sin pie de foto no tiene nada que buscar. El
    // agente no adivina: la atiende una persona.
    return {
      action: "escalate",
      text: settings.escalation_message,
      reason: "sin_texto",
    };
  }

  // Si no hay proveedor configurado, el cliente no se queda sin respuesta: la
  // conversacion pasa a un humano con un aviso. Un silencio es una atencion
  // perdida; un error visible en el chat, peor todavia.
  if (!OPENAI_API_KEY) {
    log.warn("OPENAI_API_KEY no configurada: se escala a humano", { tenantId });
    return {
      action: "escalate",
      text: settings.ai_unavailable_message,
      reason: "ia_no_configurada",
    };
  }

  // 1. Peticion explicita de hablar con una persona: no hace falta gastar una
  //    llamada al modelo para saber que hay que escalar.
  const keyword = matchesEscalationKeyword(text, settings.escalation_keywords ?? []);
  if (keyword) {
    await recordRun({
      tenantId, conversationId, inboundMessageId, userText: text,
      model: settings.ai_model, embeddingModel: null, chunks: [],
      answer: settings.escalation_message, escalated: true,
      reason: `palabra_clave:${keyword}`, latencyMs: Date.now() - started,
    });
    return {
      action: "escalate",
      text: settings.escalation_message,
      reason: `palabra_clave:${keyword}`,
    };
  }

  // 2. Recuperacion
  let chunks: RetrievedChunk[] = [];
  try {
    const vector = await embed(text, settings.ai_embedding_model);
    chunks = await searchKnowledge(tenantId, vector, settings);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await recordRun({
      tenantId, conversationId, inboundMessageId, userText: text,
      model: settings.ai_model, embeddingModel: settings.ai_embedding_model,
      chunks: [], answer: null, escalated: true, reason: "fallo_recuperacion",
      latencyMs: Date.now() - started, error: detail,
    });
    // Se escala en lugar de reintentar: el cliente esta esperando y un fallo
    // del proveedor puede durar minutos.
    return {
      action: "escalate",
      text: settings.ai_unavailable_message,
      reason: "fallo_recuperacion",
    };
  }

  if (chunks.length === 0) {
    if (!settings.escalation_on_no_context) {
      return { action: "silent", reason: "sin_contexto" };
    }
    await recordRun({
      tenantId, conversationId, inboundMessageId, userText: text,
      model: settings.ai_model, embeddingModel: settings.ai_embedding_model,
      chunks: [], answer: settings.no_context_message, escalated: true,
      reason: "sin_contexto", latencyMs: Date.now() - started,
    });
    return {
      action: "escalate",
      text: settings.no_context_message,
      reason: "sin_contexto",
    };
  }

  // 3. Generacion
  const context = chunks
    .map((c) => `### ${c.title}${c.section_name ? ` · ${c.section_name}` : ""}\n${c.content}`)
    .join("\n\n---\n\n");

  let answer: string;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  try {
    const payload = await callOpenAI("/chat/completions", {
      model: settings.ai_model,
      temperature: Number(settings.ai_temperature),
      max_tokens: settings.ai_max_output_tokens,
      messages: [
        { role: "system", content: buildSystemPrompt(settings, context) },
        { role: "user", content: text },
      ],
    }, 30_000);

    answer = payload?.choices?.[0]?.message?.content ?? "";
    promptTokens = payload?.usage?.prompt_tokens ?? null;
    completionTokens = payload?.usage?.completion_tokens ?? null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await recordRun({
      tenantId, conversationId, inboundMessageId, userText: text,
      model: settings.ai_model, embeddingModel: settings.ai_embedding_model,
      chunks, answer: null, escalated: true, reason: "fallo_generacion",
      latencyMs: Date.now() - started, error: detail,
    });
    return {
      action: "escalate",
      text: settings.ai_unavailable_message,
      reason: "fallo_generacion",
    };
  }

  const escalated = answer.includes(ESCALATION_TAG);
  const clean = answer.replaceAll(ESCALATION_TAG, "").trim();

  // El modelo pidio escalar pero no escribio nada aprovechable: se usa el
  // mensaje de la empresa en lugar de enviar un texto vacio.
  const finalText = clean.length > 0
    ? clean
    : (escalated ? settings.escalation_message : settings.no_context_message);

  await recordRun({
    tenantId, conversationId, inboundMessageId, userText: text,
    model: settings.ai_model, embeddingModel: settings.ai_embedding_model,
    chunks, answer: finalText, escalated,
    reason: escalated ? "solicitado_por_modelo" : null,
    latencyMs: Date.now() - started,
    promptTokens, completionTokens,
  });

  return escalated
    ? { action: "escalate", text: finalText, reason: "solicitado_por_modelo" }
    : { action: "reply", text: finalText };
}

// -----------------------------------------------------------------------------
// Traza
// -----------------------------------------------------------------------------
// Queda registrado que fragmentos se usaron y con que similitud. Es lo unico
// que permite responder despues por que el agente contesto lo que contesto, y
// detectar que un manual mal indexado esta dando respuestas pobres.
// -----------------------------------------------------------------------------

async function recordRun(params: {
  tenantId: string;
  conversationId: string;
  inboundMessageId: string;
  userText: string;
  model: string;
  embeddingModel: string | null;
  chunks: RetrievedChunk[];
  answer: string | null;
  escalated: boolean;
  reason: string | null;
  latencyMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  error?: string;
}): Promise<void> {
  const { error } = await db.from("ai_runs").insert({
    tenant_id: params.tenantId,
    conversation_id: params.conversationId,
    inbound_message_id: params.inboundMessageId,
    user_text: params.userText,
    model: params.model,
    embedding_model: params.embeddingModel,
    retrieved_chunks: params.chunks.map((c) => ({
      chunk_id: c.chunk_id,
      document_id: c.document_id,
      title: c.title,
      section: c.section_name,
      similarity: Number(c.similarity.toFixed(4)),
    })),
    top_similarity: params.chunks.length > 0
      ? Number(params.chunks[0]!.similarity.toFixed(4))
      : null,
    answer_text: params.answer,
    escalated: params.escalated,
    escalation_reason: params.reason?.slice(0, 60) ?? null,
    prompt_tokens: params.promptTokens ?? null,
    completion_tokens: params.completionTokens ?? null,
    latency_ms: params.latencyMs,
    error_text: params.error ?? null,
  });

  // La traza no debe tumbar la atencion al cliente: si no se puede guardar, se
  // registra el problema y la respuesta sigue su camino.
  if (error) log.error("No se pudo registrar la ejecucion de IA", { error: error.message });
}
