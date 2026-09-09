// =============================================================================
// Configuracion del worker
// =============================================================================
// Todo lo que falte se detecta al arrancar, no en medio de un mensaje de un
// cliente real. Un worker que arranca sin credenciales y falla en el primer
// evento es peor que uno que no arranca: el evento ya consumio un intento.
// =============================================================================

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Falta la variable de entorno ${name}. Revisa .env contra .env.example.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} debe ser un entero positivo, se recibio "${raw}"`);
  }
  return n;
}

export const config = {
  supabaseUrl: required("SUPABASE_URL"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  workerId: optional("WORKER_ID", `worker-${process.pid}`),
  pollIntervalMs: integer("WORKER_POLL_INTERVAL_MS", 1000),
  batchSize: integer("WORKER_BATCH_SIZE", 10),
  concurrency: integer("WORKER_CONCURRENCY", 5),

  // Token de la aplicacion del SaaS. Se usa cuando la cuenta de canal no tiene
  // un token propio guardado en Vault.
  metaSystemUserToken: optional("META_SYSTEM_USER_TOKEN", ""),

  appUrl: optional("NEXT_PUBLIC_APP_URL", ""),
} as const;

export type Config = typeof config;
