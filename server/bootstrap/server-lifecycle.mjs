import { disconnectPrismaClient } from "../persistence/prisma-client.mjs";

const noopLogger = { info() {}, warn() {}, error() {} };

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}

export function createServerLifecycle({
  server,
  disconnect = disconnectPrismaClient,
  logger = console,
  shutdownTimeoutMs = 10_000,
} = {}) {
  if (!server) throw new TypeError("server is required");
  const log = logger || noopLogger;
  let shutdownPromise;

  async function performShutdown(reason) {
    log.info?.(`[lifecycle] shutdown started (${reason})`);
    let timeout;
    let httpError;
    try {
      try {
        await Promise.race([
          closeHttpServer(server),
          new Promise((resolve) => {
            timeout = setTimeout(() => {
              log.warn?.("[lifecycle] HTTP drain timeout reached; closing remaining connections");
              server.closeAllConnections?.();
              resolve();
            }, shutdownTimeoutMs);
          }),
        ]);
      } catch (error) {
        httpError = error;
      }
      await disconnect();
      if (httpError) throw httpError;
      log.info?.("[lifecycle] shutdown complete");
    } finally {
      clearTimeout(timeout);
    }
  }

  function shutdown(reason = "manual") {
    if (!shutdownPromise) shutdownPromise = performShutdown(reason);
    return shutdownPromise;
  }

  return {
    shutdown,
    get shuttingDown() { return Boolean(shutdownPromise); },
  };
}

export function registerShutdownSignals({ lifecycle, signalTarget = process, logger = console } = {}) {
  if (!lifecycle?.shutdown) throw new TypeError("lifecycle.shutdown is required");
  const handlers = new Map();
  const remove = () => {
    for (const [signal, handler] of handlers) signalTarget.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const handler = async () => {
      try {
        await lifecycle.shutdown(signal);
        if (signalTarget === process) process.exitCode = 0;
      } catch {
        logger?.error?.("[lifecycle] shutdown failed");
        if (signalTarget === process) process.exitCode = 1;
      } finally {
        remove();
      }
    };
    handlers.set(signal, handler);
    signalTarget.once(signal, handler);
  }
  return remove;
}
