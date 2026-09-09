// =============================================================================
// Troceado de documentos
// =============================================================================
// Separado de la ingesta para poder probarlo sin proveedor de IA ni base de
// datos: es la pieza que decide la calidad de las respuestas del agente.
//
// El troceado respeta la estructura del documento en lugar de cortar cada N
// palabras a ciegas. La diferencia se nota en las respuestas: un fragmento que
// empieza a media frase y mezcla el final de "Horarios" con el principio de
// "Formas de pago" recupera mal y confunde al modelo. Cortando por secciones,
// cada fragmento habla de una sola cosa y llega con su titulo como contexto.
// =============================================================================

export const MAX_CHARS = 1400;   // aprox. 350 tokens en espanol
export const OVERLAP_CHARS = 200;

export interface Chunk {
  section_name: string | null;
  chunk_index: number;
  content: string;
  token_count: number;
}

// -----------------------------------------------------------------------------
// Troceado
// -----------------------------------------------------------------------------

/**
 * Divide por encabezados. Reconoce tres formas habituales en manuales reales:
 * markdown (# TITULO), numeradas (1. TITULO) y en mayusculas terminadas en dos
 * puntos (FORMAS DE PAGO:), que es como suelen venir los documentos de oficina.
 */
export function splitIntoSections(text: string): { name: string | null; body: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { name: string | null; body: string }[] = [];

  let currentName: string | null = null;
  let buffer: string[] = [];

  const isHeading = (line: string): boolean => {
    const t = line.trim();
    if (t.length === 0 || t.length > 120) return false;

    // Encabezado markdown.
    if (/^#{1,6}\s+\S/.test(t)) return true;

    // Linea numerada. Aqui hay que distinguir dos cosas que se escriben igual:
    //
    //   "1. INTRODUCCION"                         -> titulo de seccion
    //   "1. Programa de Mentorias: 3 meses..."    -> elemento de una lista
    //
    // Tratar el segundo caso como titulo parte la seccion que lo contiene y el
    // fragmento pierde el encabezado que le da sentido: el precio de un
    // programa se queda sin "PROGRAMAS Y PRECIOS" encima, y el agente lo
    // recupera peor. Solo cuenta como titulo si va en mayusculas y es corto.
    const numbered = t.match(/^\d+(?:\.\d+)*[.)]\s+(.+)$/);
    if (numbered) {
      const rest = numbered[1]!.trim();
      return rest.length <= 60 && !/[a-záéíóúñü]/.test(rest);
    }

    // Linea corta en mayusculas, con o sin dos puntos al final. El rango
    // incluye las minusculas acentuadas: sin ellas, "Programación Anual"
    // pasaria por titulo en mayusculas.
    if (/^[A-ZÁÉÍÓÚÑÜ0-9][^a-záéíóúñü]{4,}:?$/.test(t)) return true;

    return false;
  };

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body.length > 0) sections.push({ name: currentName, body });
    buffer = [];
  };

  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      currentName = line.trim().replace(/^#{1,6}\s+/, "").replace(/:$/, "").slice(0, 255);
      continue;
    }
    buffer.push(line);
  }
  flush();

  // Documento sin ningun encabezado reconocible: se trata como una sola pieza.
  if (sections.length === 0) {
    const body = text.trim();
    if (body.length > 0) sections.push({ name: null, body });
  }

  return sections;
}

/** Parte una seccion larga por parrafos, con solape para no cortar una idea. */
export function chunkSection(body: string): string[] {
  if (body.length <= MAX_CHARS) return [body];

  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;

    if (candidate.length <= MAX_CHARS) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
      // Se arrastra el final del fragmento anterior para que la frase que
      // quedo partida siga siendo recuperable desde el siguiente.
      const tail = current.slice(-OVERLAP_CHARS);
      current = `${tail}\n\n${paragraph}`.slice(0, MAX_CHARS * 2);
    } else {
      current = paragraph;
    }

    // Un solo parrafo mas largo que el maximo: se corta por frases.
    while (current.length > MAX_CHARS) {
      const window = current.slice(0, MAX_CHARS);
      const lastStop = Math.max(
        window.lastIndexOf(". "), window.lastIndexOf("? "),
        window.lastIndexOf("! "), window.lastIndexOf("\n"),
      );
      const cut = lastStop > MAX_CHARS * 0.5 ? lastStop + 1 : MAX_CHARS;
      chunks.push(current.slice(0, cut).trim());
      current = current.slice(Math.max(cut - OVERLAP_CHARS, 0));
    }
  }

  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

export function buildChunks(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of splitIntoSections(text)) {
    for (const piece of chunkSection(section.body)) {
      const content = piece.trim();
      if (content.length < 20) continue;   // fragmentos sin sustancia

      chunks.push({
        section_name: section.name,
        chunk_index: index++,
        // Estimacion, no medicion: sirve para vigilar el tamano, no para facturar.
        token_count: Math.ceil(content.length / 4),
        content,
      });
    }
  }

  return chunks;
}
