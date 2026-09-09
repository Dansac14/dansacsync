// =============================================================================
// Verificacion de la logica del Inbox
// =============================================================================
//   node --experimental-strip-types web/tests/verify_inbox_logic.ts
//
// Prueba las funciones puras que deciden que ve el operador: como se nombra un
// contacto del que apenas se sabe nada, y si la ventana de servicio esta abierta.
// Un error en cualquiera de las dos se ve en pantalla todo el dia.
// =============================================================================

import { contactLabel, serviceWindowClosed, type ConversationRow } from "../lib/types.ts";
import { formatRelative, formatRemaining, formatDayDivider } from "../lib/format.ts";

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

function conversacion(parcial: Partial<ConversationRow>): ConversationRow {
  return {
    id: "c1", tenant_id: "t1", contact_id: "k1",
    channel: "whatsapp", status: "open", handling_mode: "bot",
    assigned_operator_id: null, unread_count: 0,
    last_message_at: null, last_message_preview: null,
    service_window_expires_at: null,
    contacts: null, channel_identities: null,
    ...parcial,
  };
}

// =============================================================================
// Nombre del contacto
// =============================================================================
// Orden de preferencia: nombre completo, nombre de perfil del canal, telefono,
// y como ultimo recurso el identificador del canal. Instagram no manda el
// perfil con el mensaje, asi que el ultimo caso es habitual, no teorico.
// =============================================================================

check("Nombre y apellido se combinan",
  contactLabel(conversacion({
    contacts: { id: "k1", first_name: "Rosa", last_name: "Quispe", phone: null, email: null },
  })) === "Rosa Quispe");

check("Solo nombre, sin espacio sobrante",
  contactLabel(conversacion({
    contacts: { id: "k1", first_name: "Rosa", last_name: null, phone: null, email: null },
  })) === "Rosa");

check("Sin nombre, se usa el perfil del canal",
  contactLabel(conversacion({
    contacts: { id: "k1", first_name: null, last_name: null, phone: null, email: null },
    channel_identities: { channel_user_id: "51999111222", display_name: "rosita_negocios" },
  })) === "rosita_negocios");

check("Sin nombre ni perfil, se usa el telefono",
  contactLabel(conversacion({
    contacts: { id: "k1", first_name: null, last_name: null, phone: "+51999111222", email: null },
    channel_identities: { channel_user_id: "51999111222", display_name: null },
  })) === "+51999111222");

check("Sin nada, se usan los ultimos digitos del identificador",
  contactLabel(conversacion({
    channel_identities: { channel_user_id: "17841400000000123", display_name: null },
  })) === "Contacto 000123");

check("Sin ningun dato, no queda vacio",
  contactLabel(conversacion({})) === "Contacto sin nombre");

// Un nombre en blanco no debe ganar al perfil del canal: en la base es un
// string vacio, no null, cuando el canal lo mando asi.
check("Nombre en blanco no gana al perfil del canal",
  contactLabel(conversacion({
    contacts: { id: "k1", first_name: "   ", last_name: null, phone: null, email: null },
    channel_identities: { channel_user_id: "1", display_name: "perfil_real" },
  })) === "perfil_real",
  contactLabel(conversacion({
    contacts: { id: "k1", first_name: "   ", last_name: null, phone: null, email: null },
    channel_identities: { channel_user_id: "1", display_name: "perfil_real" },
  })));

// =============================================================================
// Ventana de servicio de 24 h
// =============================================================================

const enUnaHora = new Date(Date.now() + 3_600_000).toISOString();
const haceUnaHora = new Date(Date.now() - 3_600_000).toISOString();

check("WhatsApp con ventana futura: abierta",
  !serviceWindowClosed(conversacion({ service_window_expires_at: enUnaHora })));

check("WhatsApp con ventana pasada: cerrada",
  serviceWindowClosed(conversacion({ service_window_expires_at: haceUnaHora })));

// Sin fecha significa que el cliente nunca escribio. Tratarlo como abierta
// dejaria al operador redactar un mensaje que Meta va a rechazar.
check("WhatsApp sin fecha de ventana: se considera cerrada",
  serviceWindowClosed(conversacion({ service_window_expires_at: null })));

// La regla de 24 h es de WhatsApp. Aplicarla a Instagram bloquearia respuestas
// perfectamente validas.
for (const canal of ["instagram", "facebook", "tiktok"] as const) {
  check(`${canal} nunca se bloquea por la ventana de WhatsApp`,
    !serviceWindowClosed(conversacion({ channel: canal, service_window_expires_at: null })));
}

// =============================================================================
// Formato de fechas
// =============================================================================

check("Fecha nula no rompe el formato", formatRelative(null) === "");
check("Fecha invalida no rompe el formato", formatRelative("no-es-fecha") === "");

const ahora = new Date();
const hoyMismo = formatRelative(ahora.toISOString());
check("Un mensaje de hoy muestra la hora", /\d{1,2}:\d{2}/.test(hoyMismo), hoyMismo);

const hace10Dias = new Date(Date.now() - 10 * 86_400_000).toISOString();
const antiguo = formatRelative(hace10Dias);
check("Un mensaje de hace 10 dias muestra la fecha, no la hora",
  antiguo !== "" && !/^\d{1,2}:\d{2}/.test(antiguo), antiguo);

check("Ventana sin fecha se describe como cerrada",
  formatRemaining(null) === "cerrada");
check("Ventana vencida se describe como cerrada",
  formatRemaining(haceUnaHora) === "cerrada");
check("Ventana con casi 2 h restantes se describe en horas",
  /^1 h \d+ min$/.test(formatRemaining(new Date(Date.now() + 6_000_000).toISOString())),
  formatRemaining(new Date(Date.now() + 6_000_000).toISOString()));
check("Ventana con minutos restantes se describe en minutos",
  /^\d+ min$/.test(formatRemaining(new Date(Date.now() + 600_000).toISOString())),
  formatRemaining(new Date(Date.now() + 600_000).toISOString()));

check("El separador de hoy dice Hoy",
  formatDayDivider(ahora.toISOString()) === "Hoy");
check("El separador de ayer dice Ayer",
  formatDayDivider(new Date(Date.now() - 86_400_000).toISOString()) === "Ayer");
check("El separador antiguo trae dia y mes",
  formatDayDivider(hace10Dias).length > 6, formatDayDivider(hace10Dias));

// Esta era la unica de las tres funciones de fecha sin validar. Al llamarse
// dentro del render del hilo, una fecha invalida lanzaba RangeError y tumbaba
// el panel completo, no solo esa burbuja; y con null mostraba un separador de
// "1 de enero" en medio de la conversacion.
let separadorLanzo = false;
let separadorInvalido = "";
try {
  separadorInvalido = formatDayDivider("no-es-fecha");
} catch {
  separadorLanzo = true;
}
check("El separador de dia no lanza con una fecha invalida", !separadorLanzo);
check("El separador de dia devuelve vacio con una fecha invalida",
  separadorInvalido === "", separadorInvalido);
check("El separador de dia devuelve vacio con null",
  formatDayDivider(null) === "", formatDayDivider(null));

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
