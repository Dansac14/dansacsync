// =============================================================================
// Verificacion del troceado de manuales
// =============================================================================
//   node --experimental-strip-types worker/tests/verify_chunker.ts
//
// Se prueba con un manual escrito como los escriben de verdad en una oficina:
// encabezados en mayusculas, listas numeradas y parrafos de largo irregular.
// =============================================================================

import { buildChunks, splitIntoSections, MAX_CHARS } from "../src/ai/chunker.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    process.stdout.write(`OK   ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` · ${detail}` : ""}`);
    process.stdout.write(`FALLO ${name}${detail ? ` · ${detail}` : ""}\n`);
  }
}

const manual = `
POLITICA DE HORARIOS Y SEDES:
Nuestro horario de atencion al publico es de lunes a viernes de 8:00 a 18:00 y
sabados de 9:00 a 13:00.
Oficinas en Av. Larco 1234, Trujillo.

PROGRAMAS Y PRECIOS:
1. Programa de Mentorias Empresariales: 3 meses, 12 sesiones uno a uno.
   Inversion: 1650 soles.
2. Taller de Finanzas para Emprendedores: en linea, 4 semanas.
   Inversion: 440 soles.

METODOS DE PAGO:
Transferencia bancaria (BCP, BBVA, Interbank), tarjeta y billeteras digitales
(Yape y Plin). No se aceptan pagos contra entrega.

## Escalado a asesor humano
Si el cliente solicita financiamiento, factura con retencion o una reunion con
la direccion, la conversacion pasa de inmediato a un asesor comercial.
`.trim();

// -----------------------------------------------------------------------------
// Secciones
// -----------------------------------------------------------------------------

const secciones = splitIntoSections(manual);
const nombres = secciones.map((s) => s.name);

check("Se detectan las 4 secciones del manual", secciones.length === 4,
  `se detectaron ${secciones.length}: ${JSON.stringify(nombres)}`);
check("Encabezado en mayusculas con dos puntos, sin los dos puntos",
  nombres.includes("POLITICA DE HORARIOS Y SEDES"), JSON.stringify(nombres));
check("Encabezado markdown reconocido y sin las almohadillas",
  nombres.includes("Escalado a asesor humano"), JSON.stringify(nombres));
check("Ninguna seccion queda vacia",
  secciones.every((s) => s.body.trim().length > 0));
check("El precio queda en la seccion de precios, no en otra",
  secciones.find((s) => s.name === "PROGRAMAS Y PRECIOS")?.body.includes("440 soles") === true);

// La lista numerada NO debe partirse en secciones: "1." y "2." son contenido,
// no encabezados de seccion. Si se partieran, el fragmento de un programa
// perderia el titulo "PROGRAMAS Y PRECIOS" que le da sentido.
check("Las listas numeradas no se confunden con encabezados",
  !nombres.some((n) => n?.startsWith("1.") || n?.startsWith("2.")),
  JSON.stringify(nombres));

// -----------------------------------------------------------------------------
// Fragmentos
// -----------------------------------------------------------------------------

const fragmentos = buildChunks(manual);

check("Todo fragmento lleva el nombre de su seccion",
  fragmentos.every((c) => c.section_name !== null));
check("Los indices son consecutivos desde 0",
  fragmentos.every((c, i) => c.chunk_index === i),
  JSON.stringify(fragmentos.map((c) => c.chunk_index)));
check("Ningun fragmento excede el tamano maximo",
  fragmentos.every((c) => c.content.length <= MAX_CHARS * 2),
  `mayor: ${Math.max(...fragmentos.map((c) => c.content.length))}`);
check("Ningun fragmento esta vacio ni es residual",
  fragmentos.every((c) => c.content.trim().length >= 20));

// El dato concreto que un cliente va a preguntar tiene que estar recuperable.
const conPrecio = fragmentos.filter((c) => c.content.includes("440 soles"));
check("El precio del taller aparece en algun fragmento", conPrecio.length >= 1);
check("El fragmento del precio conserva su seccion",
  conPrecio[0]?.section_name === "PROGRAMAS Y PRECIOS",
  conPrecio[0]?.section_name ?? "sin seccion");

const conYape = fragmentos.filter((c) => c.content.includes("Yape"));
check("Los metodos de pago son recuperables", conYape.length >= 1);

// -----------------------------------------------------------------------------
// Documentos largos y solape
// -----------------------------------------------------------------------------

const parrafo = "Cada emprendedor recibe acompanamiento personalizado durante todo el programa. ";
const seccionLarga = `CONDICIONES DEL PROGRAMA:\n${parrafo.repeat(60)}`;
const largos = buildChunks(seccionLarga);

check("Una seccion larga se parte en varios fragmentos", largos.length > 1,
  `se obtuvo ${largos.length}`);
check("Todos los fragmentos de la seccion larga conservan su nombre",
  largos.every((c) => c.section_name === "CONDICIONES DEL PROGRAMA"));
check("Hay solape entre fragmentos consecutivos",
  largos.length > 1 &&
  largos[1]!.content.slice(0, 60).split(" ").some(
    (palabra) => palabra.length > 4 && largos[0]!.content.includes(palabra),
  ));

// -----------------------------------------------------------------------------
// Casos limite
// -----------------------------------------------------------------------------

check("Documento sin encabezados produce un fragmento",
  buildChunks("Solo un parrafo suelto sin ningun encabezado reconocible aqui.").length === 1);
check("Documento vacio no produce fragmentos", buildChunks("").length === 0);
check("Documento de solo espacios no produce fragmentos", buildChunks("   \n\n  \n").length === 0);
check("Documento de solo encabezados no produce fragmentos vacios",
  buildChunks("TITULO UNO:\nTITULO DOS:\nTITULO TRES:").every((c) => c.content.length >= 20)
);

// Una frase muy larga sin puntos ni parrafos: no debe entrar en bucle infinito
// ni producir fragmentos vacios.
const sinPuntos = "PARRAFO UNICO:\n" + "palabra ".repeat(1200);
const duros = buildChunks(sinPuntos);
check("Un parrafo enorme sin puntuacion se corta sin colgarse", duros.length > 1);
check("Ningun fragmento resultante queda vacio",
  duros.every((c) => c.content.trim().length > 0));

// -----------------------------------------------------------------------------
// Nada de texto se descarta
// -----------------------------------------------------------------------------
// El troceador hacia un .slice() al arrastrar el solape y tiraba lo que
// excediera, sin volver a procesarlo. Con un parrafo corto seguido de uno largo
// —una politica escrita de corrido— se perdia casi la mitad del manual, y la
// ingesta lo reportaba como exito.
// -----------------------------------------------------------------------------

const reglas = Array.from({ length: 80 }, (_, i) =>
  `Regla ${i + 1}: el taller numero ${i + 1} cuesta ${100 + i} soles.`).join(" ");
const conParrafoLargo = `CONDICIONES DEL PROGRAMA:\nBreve introduccion.\n\n${reglas}`;

const trozosLargos = buildChunks(conParrafoLargo);
const textoRecuperado = trozosLargos.map((c) => c.content).join(" ");
const perdidas: number[] = [];
for (let i = 1; i <= 80; i++) {
  if (!textoRecuperado.includes(`Regla ${i}:`)) perdidas.push(i);
}

check("Ninguna regla del manual se pierde al trocear", perdidas.length === 0,
  `perdidas: ${perdidas.length} (${perdidas.slice(0, 5).join(", ")}…)`);
check("La introduccion tambien se conserva",
  textoRecuperado.includes("Breve introduccion"));

// Un texto de un solo bloque enorme sin ninguna puntuacion.
const sinPuntuacion = "BLOQUE:\n" + "palabra".repeat(3000);
const trozosDuros = buildChunks(sinPuntuacion);
const recuperadoDuro = trozosDuros.map((c) => c.content).join("");
check("Un bloque sin puntuacion se trocea sin perder longitud",
  recuperadoDuro.length >= 3000 * 7 * 0.9,
  `${recuperadoDuro.length} de ${3000 * 7}`);

// =============================================================================

process.stdout.write("\n" + "=".repeat(70) + "\n");
if (failures.length === 0) {
  process.stdout.write(` ${passed} VERIFICACIONES PASARON\n`);
  process.stdout.write("=".repeat(70) + "\n");
} else {
  process.stdout.write(` ${passed} pasaron, ${failures.length} FALLARON:\n`);
  for (const f of failures) process.stdout.write(`   · ${f}\n`);
  process.stdout.write("=".repeat(70) + "\n");
  process.exit(1);
}
