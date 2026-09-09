// =============================================================================
// Worker
// =============================================================================
// Dos bucles independientes sobre las dos colas. Van separados porque tienen
// ritmos distintos: la entrada depende de la IA y tarda segundos, la salida es
// una llamada HTTP y tarda milisegundos. Con un solo bucle, una respuesta lenta
// del modelo retrasaria el envio de mensajes ya listos.
//
// Se puede correr varias replicas sin coordinacion: el reparto lo hace Postgres
// con FOR UPDATE SKIP LOCKED, no el worker.
// =============================================================================

import { config } from "./config.ts";
import {
  claimInboundEvents, claimOutboundJobs, invalidateAccountCache,
  type InboundEvent, type OutboundJob,
} from "./db.ts";
import { processInboundEvent } from "./handlers/inbound.ts";
import { processOutboundJob } from "./handlers/outbound.ts";
import { log, describeError } from "./logger.ts";

let running = true;

/** Ejecuta las tareas en grupos, para no abrir cien conexiones a la vez. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    const slice = items.slice(i, i + limit);
    // allSettled y no all: un fallo ya se registro dentro del manejador y no
    // debe impedir que el resto del lote se procese.
    await Promise.allSettled(slice.map(task));
  }
}

async function pollLoop<T>(params: {
  name: string;
  claim: (limit: number) => Promise<T[]>;
  handle: (item: T) => Promise<void>;
}): Promise<void> {
  const { name, claim, handle } = params;
  // Espera creciente cuando la cola esta vacia, para no interrogar la base mil
  // veces por minuto de madrugada. Vuelve al minimo en cuanto hay trabajo.
  let idleDelay = config.pollIntervalMs;
  const maxIdleDelay = 15_000;

  while (running) {
    try {
      const items = await claim(config.batchSize);

      if (items.length === 0) {
        await sleep(idleDelay);
        idleDelay = Math.min(idleDelay * 2, maxIdleDelay);
        continue;
      }

      idleDelay = config.pollIntervalMs;
      await runWithConcurrency(items, config.concurrency, handle);

      // Si el lote vino lleno, probablemente queda mas: se sigue sin esperar.
      if (items.length < config.batchSize) await sleep(config.pollIntervalMs);
    } catch (error) {
      // Un fallo aqui es de la base o de la red, no de un evento concreto.
      // El bucle no se rompe: espera y vuelve a intentar.
      log.error(`Bucle ${name} fallo`, { error: describeError(error) });
      await sleep(5_000);
    }
  }

  log.info(`Bucle ${name} detenido`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Apagado ordenado
// -----------------------------------------------------------------------------
// Al recibir la senal se deja de tomar trabajo nuevo y se espera a que termine
// lo que esta en curso. Sin esto, un despliegue dejaria eventos en estado
// 'processing' con locked_by de un proceso que ya no existe, y habria que
// liberarlos a mano.
// -----------------------------------------------------------------------------

function installShutdownHandlers(): void {
  const shutdown = (signal: string) => {
    if (!running) return;
    log.info("Apagando worker", { signal });
    running = false;

    // Margen para que los manejadores en vuelo cierren su trabajo.
    setTimeout(() => {
      log.warn("Apagado forzado tras el tiempo de espera");
      process.exit(0);
    }, 30_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    log.error("Promesa rechazada sin manejar", { error: describeError(reason) });
  });
  process.on("uncaughtException", (error) => {
    log.error("Excepcion no capturada: el proceso termina", { error: describeError(error) });
    process.exit(1);
  });
}

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  installShutdownHandlers();

  log.info("Worker iniciado", {
    workerId: config.workerId,
    batchSize: config.batchSize,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
  });

  // Las cuentas y los secretos se refrescan periodicamente para que desactivar
  // un canal o rotar un token surta efecto sin reiniciar el proceso.
  const refresher = setInterval(() => invalidateAccountCache(), 60_000);
  refresher.unref();

  await Promise.all([
    pollLoop<InboundEvent>({
      name: "entrada",
      claim: claimInboundEvents,
      handle: processInboundEvent,
    }),
    pollLoop<OutboundJob>({
      name: "salida",
      claim: claimOutboundJobs,
      handle: processOutboundJob,
    }),
  ]);

  log.info("Worker terminado");
}

main().catch((error) => {
  log.error("El worker no pudo arrancar", { error: describeError(error) });
  process.exit(1);
});
