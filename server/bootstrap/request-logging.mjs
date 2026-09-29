import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// A proxy or client may forward its own X-Request-Id so one id follows the
// request across systems. Anything outside this shape is replaced, so the
// header can never carry text into a log line.
const FORWARDED_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
// Liveness and readiness probes arrive every few seconds and would bury real
// traffic. Static assets are logged only when they fail.
const UNLOGGED_PATHS = new Set(["/api/health", "/api/ready"]);
const MAX_LOGGED_PATH = 512;

const requestIds = new WeakMap();
const requestActors = new WeakMap();

const text = (value) => String(value ?? "").trim();

export function requestIdOf(req) {
  return requestIds.get(req) || "";
}

// Called once identity is resolved. Only opaque ids are kept; names, emails,
// tokens, and request bodies never reach the log.
export function noteRequestActor(req, identity) {
  if (!identity?.authenticated) return;
  requestActors.set(req, {
    tenantId: text(identity.tenantId),
    userId: text(identity.userId),
  });
}

function loggedPath(req) {
  const raw = String(req.url || "/");
  let path;
  try {
    path = new URL(raw, "http://localhost").pathname;
  } catch {
    path = raw.split("?")[0];
  }
  return path.slice(0, MAX_LOGGED_PATH);
}

function shouldLog(path, status) {
  if (UNLOGGED_PATHS.has(path)) return false;
  return path.startsWith("/api/") || status >= 500;
}

// Gives every request an id, returned in the X-Request-Id header, and, when a
// logger is supplied, writes one JSON line per API request once the response
// ends. The line holds the method, path without its query string, status,
// duration, and signed-in tenant and user ids. Query strings, headers, and
// bodies are never logged.
export function withRequestLogging(handleRequest, {
  logger = null,
  idFactory = randomUUID,
  clock = () => performance.now(),
  now = () => new Date(),
} = {}) {
  return async function handleRequestWithRequestId(req, res) {
    const forwarded = text(req.headers?.["x-request-id"]);
    const requestId = FORWARDED_REQUEST_ID.test(forwarded) ? forwarded : idFactory();
    requestIds.set(req, requestId);
    res.setHeader("X-Request-Id", requestId);
    if (logger) {
      const startedAt = clock();
      let written = false;
      const write = () => {
        if (written) return;
        written = true;
        const path = loggedPath(req);
        const status = res.statusCode;
        if (!shouldLog(path, status)) return;
        const line = JSON.stringify({
          time: now().toISOString(),
          level: status >= 500 ? "error" : "info",
          event: "http_request",
          requestId,
          method: req.method,
          path,
          status,
          durationMs: Math.round((clock() - startedAt) * 10) / 10,
          ...(res.writableFinished ? {} : { aborted: true }),
          ...requestActors.get(req),
        });
        try {
          const method = status >= 500 && typeof logger.error === "function" ? logger.error : logger.info;
          method?.call(logger, line);
        } catch {
          // A broken log sink must never break the response.
        }
      };
      res.once("finish", write);
      res.once("close", write);
    }
    return handleRequest(req, res);
  };
}

export function requestLogEnabled(env = process.env) {
  return text(env.FLOWCHAIN_REQUEST_LOG).toLowerCase() !== "off";
}
