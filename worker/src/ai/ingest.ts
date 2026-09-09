// =============================================================================
// Ingesta y vectorizacion de manuales
// =============================================================================
// Uso:
//   npm run ingest -- --tenant <slug|uuid> --title "Manual Operativo 2026" \
//                     --file ./manuales/operativo.md [--language es]
//
// El troceado respeta la estructura del documento en lugar de cortar cada N
// palabras a ciegas. La diferencia se nota en las respuestas: un fragmento que
// empieza a media frase y mezcla el final de "Horarios" con el principio de
// "Formas de pago" recupera mal y confunde al modelo. Cortando por secciones,
// cada fragmento habla de una sola cosa y llega con su titulo como contexto.
// =============================================================================

import { readFile } from "node:fs/promises";
import { db } from "../db.ts";
import { log } from "../logger.ts";
import { buildChunks } from "./chunker.ts";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const OPENAI_BASE = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

const EMBED_BATCH = 64;   // el endpoint acepta varias entradas por llamada

// -----------------------------------------------------------------------------
// Embeddings
// -----------------------------------------------------------------------------

async function embedBatch(inputs: string[], model: string): Promise<number[][]> {
  const response = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: inputs }),
  });

  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok) {
    throw new Error(`OpenAI /embeddings: ${payload?.error?.message ?? response.status}`);
  }

  const vectors: number[][] = (payload?.data ?? [])
    // El orden de la respuesta no esta garantizado: viene con indice.
    .sort((a: any, b: any) => a.index - b.index)
    .map((row: any) => row.embedding);

  if (vectors.length !== inputs.length) {
    throw new Error(
      `Se pidieron ${inputs.length} embeddings y llegaron ${vectors.length}`,
    );
  }
  return vectors;
}

// -----------------------------------------------------------------------------
// Argumentos
// -----------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`El argumento --${key} necesita un valor`);
    }
    args[key] = value;
    i++;
  }
  return args;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTenantId(reference: string): Promise<string> {
  if (UUID.test(reference)) return reference;

  const { data, error } = await db
    .from("tenants").select("id").eq("slug", reference.toLowerCase()).single();

  if (error || !data) {
    throw new Error(`No existe ninguna empresa con slug "${reference}"`);
  }
  return (data as { id: string }).id;
}

// -----------------------------------------------------------------------------
// Programa
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  for (const required of ["tenant", "title", "file"]) {
    if (!args[required]) {
      throw new Error(
        `Falta --${required}.\n\n` +
        `Uso: npm run ingest -- --tenant <slug|uuid> --title "Manual" --file ruta.md [--language es]`,
      );
    }
  }

  if (!OPENAI_API_KEY) {
    throw new Error("Falta OPENAI_API_KEY: sin proveedor no se pueden generar embeddings");
  }

  const tenantId = await resolveTenantId(args.tenant!);
  const text = await readFile(args.file!, "utf8");

  if (text.trim().length === 0) {
    throw new Error(`El archivo ${args.file} esta vacio`);
  }

  const chunks = buildChunks(text);
  if (chunks.length === 0) {
    throw new Error("El documento no produjo ningun fragmento indexable");
  }

  // Modelo de embeddings de la propia empresa: tiene que ser el mismo con el
  // que se consulta despues. Indexar con uno y buscar con otro no da error,
  // da resultados sin sentido.
  const { data: settings, error: settingsError } = await db
    .from("company_settings").select("ai_embedding_model").eq("tenant_id", tenantId).single();

  if (settingsError) {
    throw new Error(`No se pudo leer la configuracion de la empresa: ${settingsError.message}`);
  }
  const model = (settings as { ai_embedding_model: string }).ai_embedding_model;

  log.info("Indexando documento", {
    tenantId, titulo: args.title, fragmentos: chunks.length, modelo: model,
  });

  // Documento: se reutiliza si ya existe, para que reindexar no lo duplique.
  const { data: document, error: documentError } = await db
    .from("knowledge_documents")
    .upsert({
      tenant_id: tenantId,
      title: args.title!,
      source_type: "manual",
      language: args.language ?? "es",
      status: "processing",
    }, { onConflict: "tenant_id,title" })
    .select("id")
    .single();

  if (documentError) {
    throw new Error(`No se pudo registrar el documento: ${documentError.message}`);
  }
  const documentId = (document as { id: string }).id;

  // Embeddings por lotes.
  const withEmbeddings: Record<string, unknown>[] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const slice = chunks.slice(i, i + EMBED_BATCH);
    const vectors = await embedBatch(slice.map((c) => c.content), model);

    slice.forEach((chunk, offset) => {
      const vector = vectors[offset]!;
      if (vector.length !== 1536) {
        throw new Error(
          `El modelo ${model} devuelve ${vector.length} dimensiones y el esquema espera 1536`,
        );
      }
      withEmbeddings.push({
        section_name: chunk.section_name,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        token_count: chunk.token_count,
        embedding: `[${vector.join(",")}]`,
      });
    });

    log.info("Lote vectorizado", {
      hecho: Math.min(i + EMBED_BATCH, chunks.length), total: chunks.length,
    });
  }

  // Sustitucion atomica: el agente nunca ve el manual a medio indexar.
  const { data: count, error: replaceError } = await db.rpc("replace_document_chunks", {
    p_document_id: documentId,
    p_chunks: withEmbeddings,
  });

  if (replaceError) {
    await db.from("knowledge_documents")
      .update({ status: "failed", error_text: replaceError.message })
      .eq("id", documentId);
    throw new Error(`No se pudieron guardar los fragmentos: ${replaceError.message}`);
  }

  const sections = new Set(chunks.map((c) => c.section_name ?? "(sin seccion)"));
  log.info("Documento indexado", {
    documentId, fragmentos: count, secciones: sections.size,
  });

  process.stdout.write(
    `\nIndexado "${args.title}": ${count} fragmentos en ${sections.size} secciones.\n` +
    `Secciones detectadas:\n` +
    [...sections].map((s) => `  · ${s}`).join("\n") + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
