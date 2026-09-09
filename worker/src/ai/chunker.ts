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

/**
 * Parte una seccion larga en fragmentos, con solape para no cortar una idea.
 *
 * La version anterior hacia `.slice(0, MAX_CHARS * 2)` al arrastrar el solape y
 * TIRABA todo lo que excediera, sin volver a procesarlo. Con una seccion de un
 * parrafo corto seguido de uno largo —una politica escrita de corrido, algo
 * normal en un manual de oficina— se perdia casi la mitad del documento, y la
 * ingesta lo reportaba como exito. El agente quedaba diciendo que no sabe sobre
 * contenido que si estaba en el manual.
 *
 * Ahora nada se descarta: el texto se recorre entero y cada corte continua
 * donde acabo el anterior.
 */
export function chunkSection(body: string): string[] {
  const limpio = body.trim();
  if (limpio.length === 0) return [];
  if (limpio.length <= MAX_CHARS) return [limpio];

  const chunks: string[] = [];
  const parrafos = limpio.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);

  // Cola de piezas por colocar. Un parrafo mas largo que el maximo se parte
  // aqui por frases, y sus trozos vuelven a la cola en orden.
  const pendientes: string[] = [];
  for (const parrafo of parrafos) {
    if (parrafo.length <= MAX_CHARS) {
      pendientes.push(parrafo);
      continue;
    }

    let resto = parrafo;
    while (resto.length > MAX_CHARS) {
      const ventana = resto.slice(0, MAX_CHARS);
      const ultimoPunto = Math.max(
        ventana.lastIndexOf(". "), ventana.lastIndexOf("? "),
        ventana.lastIndexOf("! "), ventana.lastIndexOf("; "),
        ventana.lastIndexOf("\n"),
      );
      // Si no hay puntuacion en la segunda mitad, se corta por el limite: es
      // preferible un corte seco a un fragmento que se pasa del tamano.
      const corte = ultimoPunto > MAX_CHARS * 0.5 ? ultimoPunto + 1 : MAX_CHARS;
      pendientes.push(resto.slice(0, corte).trim());
      resto = resto.slice(corte).trim();
    }
    if (resto.length > 0) pendientes.push(resto);
  }

  let actual = "";
  for (const pieza of pendientes) {
    const candidato = actual.length === 0 ? pieza : `${actual}\n\n${pieza}`;

    if (candidato.length <= MAX_CHARS) {
      actual = candidato;
      continue;
    }

    if (actual.length > 0) {
      chunks.push(actual);
      // Se arrastra el final del fragmento anterior para que una idea partida
      // siga siendo recuperable desde el siguiente. El solape se recorta a un
      // limite de frase cuando se puede, para no empezar a media palabra.
      const cola = actual.slice(-OVERLAP_CHARS);
      const primerEspacio = cola.indexOf(" ");
      const solape = primerEspacio > 0 ? cola.slice(primerEspacio + 1) : cola;
      actual = `${solape}\n\n${pieza}`;
    } else {
      actual = pieza;
    }

    // El solape mas la pieza pueden pasarse del maximo. Se emite tal cual en
    // lugar de recortarlo: el limite es una guia de tamano, y perder texto es
    // peor que un fragmento algo mas largo.
    if (actual.length > MAX_CHARS) {
      chunks.push(actual);
      actual = "";
    }
  }

  if (actual.trim().length > 0) chunks.push(actual.trim());
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
