// =============================================================================
// Verificacion del manejo de importes y documentos
// =============================================================================
//   node --experimental-strip-types web/tests/verify_money.ts
//
// Estas funciones estan entre lo que teclea una persona y lo que se guarda como
// importe de una venta. Un fallo aqui no da error: da una cifra equivocada en
// un comprobante fiscal.
// =============================================================================

import { money, parseAmount, esRuc, esDni, estadoOrden } from "../lib/money.ts";

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

// =============================================================================
// Lectura de importes escritos por una persona
// =============================================================================

check("Entero simple", parseAmount("118") === 118);
check("Con punto decimal", parseAmount("118.50") === 118.5);
// Quien escribe importes en Peru teclea coma con la misma frecuencia que punto.
check("Con coma decimal", parseAmount("118,50") === 118.5);
check("Con espacios alrededor", parseAmount("  99.90  ") === 99.9);
check("Cero es un importe valido", parseAmount("0") === 0);
check("Un decimal", parseAmount("5.5") === 5.5);

// Lo que NO debe colarse. El peligro real no es el error: es que una entrada
// mal formada se interprete como 0 y se guarde una venta de cero soles.
const invalidos: [string, string][] = [
  ["vacio", ""],
  ["solo espacios", "   "],
  ["texto", "ciento dieciocho"],
  ["tres decimales", "118.505"],
  ["negativo", "-50"],
  ["dos separadores", "1.118.50"],
  ["separador de miles", "1,118.50"],
  ["numero con moneda", "S/ 118.00"],
  ["solo el punto", "."],
  ["notacion cientifica", "1e3"],
  ["suma", "100+18"],
  ["infinito", "Infinity"],
];

for (const [nombre, entrada] of invalidos) {
  check(`Se rechaza: ${nombre}`, parseAmount(entrada) === null,
    `devolvio ${JSON.stringify(parseAmount(entrada))}`);
}

// =============================================================================
// Presentacion
// =============================================================================

const soles = money(118, "PEN");
check("Soles llevan su simbolo", soles.includes("118"), soles);
check("Soles con dos decimales", /118[.,]00/.test(soles), soles);

const dolares = money(1650.5, "USD");
check("Dolares con separador de miles", /1[.,]650[.,]50/.test(dolares), dolares);

// La base devuelve NUMERIC como cadena para no perder precision en el JSON:
// si la funcion no lo aceptara, todos los importes se verian como "—".
check("Acepta la cadena que devuelve la base", money("236.00", "PEN").includes("236"),
  money("236.00", "PEN"));

check("Nulo se muestra como raya", money(null) === "—");
check("Indefinido se muestra como raya", money(undefined) === "—");
check("Cadena vacia se muestra como raya", money("") === "—");
check("No numerico se muestra como raya", money("abc") === "—", money("abc"));
check("Cero se muestra, no se oculta", money(0, "PEN") !== "—", money(0, "PEN"));

// Una moneda desconocida no debe romper la pantalla entera.
const raro = money(100, "XYZ");
check("Moneda desconocida no rompe", raro.includes("100"), raro);

// =============================================================================
// Documentos de identidad
// =============================================================================

check("RUC valido", esRuc("20481234567"));
check("RUC de 10 digitos se rechaza", !esRuc("2048123456"));
check("RUC de 12 digitos se rechaza", !esRuc("204812345678"));
check("RUC con letras se rechaza", !esRuc("2048123456A"));
check("RUC con espacios alrededor se acepta", esRuc(" 20481234567 "));
check("RUC vacio se rechaza", !esRuc(""));

check("DNI valido", esDni("44556677"));
check("DNI de 7 digitos se rechaza", !esDni("4455667"));
check("DNI de 11 digitos no es DNI", !esDni("20481234567"));

// =============================================================================
// Estados de orden
// =============================================================================

check("Estado conocido se traduce", estadoOrden("pending_payment").texto === "Por cobrar");
check("Estado pagado se traduce", estadoOrden("paid").texto === "Pagada");
// Si manana la base gana un estado nuevo, la pantalla debe mostrar su nombre
// crudo en lugar de quedarse en blanco.
check("Estado desconocido se muestra crudo", estadoOrden("nuevo_estado").texto === "nuevo_estado");
check("Todo estado trae clase de color", estadoOrden("cualquiera").clase.length > 0);

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
