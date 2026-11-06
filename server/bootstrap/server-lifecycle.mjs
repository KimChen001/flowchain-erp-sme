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

// An uncaught exception or unhandled rejection still ends the process with
// exit code 1, as Node does by default; first it is logged as one
// "process_error" line (sanitized, like request errors) and an alert in
// flight gets up to flushTimeoutMs to leave. A second failure while that
// happens exits at once.
export function registerProcessErrorHandlers({
  reporter,
  target = process,
  exit = (code) => process.exit(code),
  flushTimeoutMs = 2_000,
} = {}) {
  if (!reporter?.report) throw new TypeError("reporter.report is required");
  let exiting = false;
  const handlers = new Map();
  for (const origin of ["uncaughtException", "unhandledRejection"]) {
    const handler = async (error) => {
      if (target === process) process.exitCode = 1;
      if (exiting) return exit(1);
      exiting = true;
      try {
        reporter.report(error, { event: "process_error", phase: origin, fatal: true });
        await reporter.flush?.(flushTimeoutMs);
      } catch {
        // Nothing may keep the process alive after a fatal error.
      } finally {
        exit(1);
      }
    };
    handlers.set(origin, handler);
    target.on(origin, handler);
  }
  return () => {
    for (const [origin, handler] of handlers) target.removeListener(origin, handler);
    handlers.clear();
  };
}
