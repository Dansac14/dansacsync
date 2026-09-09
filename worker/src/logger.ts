// =============================================================================
// Registro estructurado
// =============================================================================
// Salida en JSON por linea, para que cualquier agregador de logs pueda filtrar
// por tenant o por evento sin analizar texto libre.
//
// Regla que se respeta en todo el worker: nunca se registra el contenido de un
// mensaje de un cliente ni un token. Se registran identificadores.
// =============================================================================

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

const SENSITIVE = /token|secret|authorization|password|apikey|api_key/i;

/** Elimina cualquier valor cuya clave sugiera que es una credencial. */
function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.test(key) ? "[oculto]" : redact(val);
  }
  return out;
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };

  const serialized = JSON.stringify(line);
  if (level === "error" || level === "warn") process.stderr.write(serialized + "\n");
  else process.stdout.write(serialized + "\n");
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit("debug", m, c),
  info:  (m: string, c?: Record<string, unknown>) => emit("info", m, c),
  warn:  (m: string, c?: Record<string, unknown>) => emit("warn", m, c),
  error: (m: string, c?: Record<string, unknown>) => emit("error", m, c),
};

/** Convierte cualquier valor lanzado en un texto util para last_error. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 1000);
  }
  if (typeof error === "string") return error.slice(0, 1000);
  try {
    return JSON.stringify(error).slice(0, 1000);
  } catch {
    return String(error).slice(0, 1000);
  }
}
