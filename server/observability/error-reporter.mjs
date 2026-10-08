import { redactSecrets, sanitizeErrorSummary } from "./redact.mjs";
import { requestActorOf, requestIdOf, requestLogPath } from "../bootstrap/request-logging.mjs";

// One reporter per server. It writes one JSON line per unexpected error and,
// when FLOWCHAIN_ERROR_WEBHOOK_URL is an https URL, posts a short alert to it
// (a Slack or Discord incoming webhook, or anything that accepts JSON).
//
// Never written or sent: request bodies, headers, query strings and the
// webhook URL itself. Error messages and stacks are logged after known
// secret shapes are redacted (./redact.mjs); paths are logged as requested,
// so record ids may appear. The log line carries the signed-in tenant and
// user ids; the webhook carries no ids and no error message, only the
// error's name and code, and masks path segments that hold an email.
//
// The webhook is fire-and-forget: report() returns before the POST starts,
// a slow or failing endpoint never delays or fails a request, and alerts are
// rate limited so a failure loop cannot flood the channel.

export const WEBHOOK_TIMEOUT_MS = 3_000;
export const WEBHOOK_KEY_WINDOW_MS = 5 * 60_000;
export const WEBHOOK_HOURLY_LIMIT = 10;
const HOUR_MS = 60 * 60_000;
const PRODUCTION_STACK_FRAMES = 8;
const MAX_STACK_LENGTH = 4_000;
export const WEBHOOK_MAX_KEYS = 500;
const MAX_KEYS = WEBHOOK_MAX_KEYS;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

const text = (value) => String(value ?? "").trim();
const isClientErrorStatus = (status) => Number.isInteger(status) && status >= 400 && status < 500;

export function isProductionEnv(env = process.env) {
  return text(env.NODE_ENV).toLowerCase() === "production"
    || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === "production";
}

// The production flags alone: a reporter built from this logs like the
// server's own but never sends an alert. Used where no reporter was passed in.
export function logOnlyEnv(env = process.env) {
  return { NODE_ENV: env.NODE_ENV, FLOWCHAIN_DEPLOYMENT_PROFILE: env.FLOWCHAIN_DEPLOYMENT_PROFILE };
}

// Only https is accepted, so an alert never crosses the network in clear text.
export function errorWebhookUrl(env = process.env) {
  const raw = text(env.FLOWCHAIN_ERROR_WEBHOOK_URL);
  if (!raw) return { url: null, reason: "not_configured" };
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return { url: null, reason: "https_required" };
    return { url: url.href, reason: null };
  } catch {
    return { url: null, reason: "invalid_url" };
  }
}

// Error names and codes are class names and constants such as P2002 or
// PrismaClientKnownRequestError. Anything else is dropped rather than risk
// carrying free text into an alert.
function identifier(value) {
  const candidate = text(value);
  return SAFE_IDENTIFIER.test(candidate) ? candidate : "";
}

function errorNameOf(error) {
  if (error instanceof Error) return identifier(error.name) || identifier(error.constructor?.name) || "Error";
  return error === undefined || error === null ? "UnknownError" : "NonErrorThrown";
}

function errorCodeOf(error, name) {
  return identifier(error?.code) || name;
}

// Only the "at ..." frames: the message is already in the `error` field, and
// keeping it out of the stack means it is redacted and truncated in one place.
function stackOf(error, production) {
  if (typeof error?.stack !== "string") return undefined;
  const frames = error.stack.split(/\r?\n/).filter((line) => /^\s+at\s/.test(line)).map((line) => line.trim());
  if (!frames.length) return undefined;
  const kept = production ? frames.slice(0, PRODUCTION_STACK_FRAMES) : frames;
  return redactSecrets(kept.join("\n")).slice(0, MAX_STACK_LENGTH);
}

// A path segment that holds an email address, plain or percent-encoded, is
// masked before the path leaves the server for the alert channel.
const EMAIL_MARK = /@|%40/i;
function alertPath(path) {
  return redactSecrets(path.split("/").map((segment) => (EMAIL_MARK.test(segment) ? "[redacted]" : segment)).join("/"));
}

function writeLine(logger, level, entry) {
  const write = level === "error" && typeof logger?.error === "function"
    ? logger.error
    : typeof logger?.warn === "function" ? logger.warn : logger?.error;
  if (typeof write !== "function") return;
  try {
    write.call(logger, JSON.stringify(entry));
  } catch {
    // A broken log sink must never break the response.
  }
}

export function createErrorReporter({
  logger = console,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  commitSha = "",
  timeoutMs = WEBHOOK_TIMEOUT_MS,
} = {}) {
  const production = isProductionEnv(env);
  const service = text(env.RENDER_SERVICE_NAME) || "flowchain";
  const { url: webhookUrl, reason: webhookReason } = errorWebhookUrl(env);
  const reported = new WeakSet();
  const pending = new Set();
  const lastSentByKey = new Map();
  const suppressedByKey = new Map();
  let hourlySends = [];
  let otherSuppressed = 0;
  let lastFailureLoggedAt = -Infinity;

  if (!webhookUrl && webhookReason !== "not_configured") {
    // Says why alerts are off without repeating the configured value.
    writeLine(logger, "warn", {
      time: now().toISOString(),
      level: "warn",
      event: "error_webhook_disabled",
      reason: webhookReason,
    });
  }

  function logWebhookFailure(status) {
    const at = now().getTime();
    if (at - lastFailureLoggedAt < WEBHOOK_KEY_WINDOW_MS) return;
    lastFailureLoggedAt = at;
    writeLine(logger, "warn", {
      time: new Date(at).toISOString(),
      level: "warn",
      event: "error_webhook_failed",
      status,
    });
  }

  function post(payload) {
    if (!webhookUrl || typeof fetchImpl !== "function") return Promise.resolve({ sent: false, reason: webhookReason || "fetch_unavailable" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const attempt = Promise.resolve()
      .then(() => fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        // A redirect could lead the alert off https; webhooks never need one.
        redirect: "error",
      }))
      .then((response) => {
        const status = Number(response?.status) || 0;
        // The answer is not read; releasing it frees the connection.
        try { response?.body?.cancel?.()?.catch?.(() => {}); } catch { /* already released */ }
        if (response?.ok) return { sent: true, status };
        logWebhookFailure(status);
        return { sent: false, status, reason: "rejected" };
      })
      .catch(() => {
        // Timeouts and network errors carry the URL in their message; only
        // the fact of the failure is logged.
        logWebhookFailure(0);
        return { sent: false, status: 0, reason: "unreachable" };
      })
      .finally(() => {
        clearTimeout(timer);
        pending.delete(attempt);
      });
    pending.add(attempt);
    return attempt;
  }

  // Keys whose 5-minute window is over are forgotten, and their held-back
  // counts move to otherSuppressed, which the next alert of any key carries.
  // Neither map grows past MAX_KEYS.
  function prune(at) {
    for (const [key, sentAt] of lastSentByKey) {
      if (at - sentAt < WEBHOOK_KEY_WINDOW_MS) continue;
      lastSentByKey.delete(key);
      otherSuppressed += suppressedByKey.get(key) || 0;
      suppressedByKey.delete(key);
    }
    for (const [key, count] of suppressedByKey) {
      if (suppressedByKey.size < MAX_KEYS) break;
      // Oldest first (insertion order).
      otherSuppressed += count;
      suppressedByKey.delete(key);
    }
  }

  function holdBack(key) {
    if (suppressedByKey.has(key) || suppressedByKey.size < MAX_KEYS) {
      suppressedByKey.set(key, (suppressedByKey.get(key) || 0) + 1);
    } else {
      otherSuppressed += 1;
    }
  }

  // 1 alert per error code and path per 5 minutes, at most 10 an hour. What
  // is held back is counted and reported with the next alert for that key
  // (or, once the key is forgotten, with the next alert of any key).
  function admit(key, at) {
    hourlySends = hourlySends.filter((sentAt) => at - sentAt < HOUR_MS);
    if (lastSentByKey.size >= MAX_KEYS || suppressedByKey.size >= MAX_KEYS) prune(at);
    const last = lastSentByKey.get(key);
    if ((last !== undefined && at - last < WEBHOOK_KEY_WINDOW_MS) || hourlySends.length >= WEBHOOK_HOURLY_LIMIT) {
      holdBack(key);
      return null;
    }
    const suppressed = (suppressedByKey.get(key) || 0) + otherSuppressed;
    suppressedByKey.delete(key);
    otherSuppressed = 0;
    lastSentByKey.set(key, at);
    hourlySends.push(at);
    return { suppressed };
  }

  function alert(entry) {
    if (!webhookUrl) return;
    // A client error (such as a 403 for a missing workspace) is logged but
    // never alerts, so it cannot use up the hourly limit. Crash lines carry no
    // status and still alert, as do errors after a 2xx response had started.
    if (isClientErrorStatus(entry.status)) return;
    const at = Date.parse(entry.time) || now().getTime();
    const path = entry.path === undefined ? undefined : alertPath(entry.path);
    const admitted = admit(`${entry.errorCode}|${path ?? entry.phase ?? ""}`, at);
    if (!admitted) return;
    const where = [entry.status, entry.method, path].filter((part) => part !== undefined && part !== "").join(" ");
    const summary = `FlowChain ${service}: ${entry.event} ${entry.errorCode}${where ? ` on ${where}` : ""}`
      + `${entry.requestId ? ` (request ${entry.requestId})` : ""}`
      + `${admitted.suppressed ? `, ${admitted.suppressed} more held back` : ""}`;
    post({
      text: summary,
      content: summary,
      event: entry.event,
      service,
      commitSha: entry.commitSha,
      requestId: entry.requestId,
      method: entry.method,
      path,
      status: entry.status,
      errorName: entry.errorName,
      errorCode: entry.errorCode,
      time: entry.time,
      suppressed: admitted.suppressed,
    });
  }

  // options: req (to read the request id, method, path and actor ids), status
  // (what the caller was or will be sent), phase (boundary, route, ...),
  // event (server_error by default; process_error for crashes), fatal.
  function report(error, { req, requestId, status, phase, event = "server_error", fatal } = {}) {
    let id = "";
    let written = false;
    try {
      if (req) reported.add(req);
      const errorName = errorNameOf(error);
      id = requestId || (req ? requestIdOf(req) : "");
      const stack = stackOf(error, production);
      const level = isClientErrorStatus(status) ? "warn" : "error";
      const entry = {
        time: now().toISOString(),
        level,
        event,
        ...(id ? { requestId: id } : {}),
        ...(req ? { method: identifier(req.method) || "UNKNOWN", path: requestLogPath(req) } : {}),
        ...(Number.isInteger(status) ? { status } : {}),
        ...(phase ? { phase } : {}),
        ...(fatal ? { fatal: true } : {}),
        error: sanitizeErrorSummary(error),
        errorName,
        errorCode: errorCodeOf(error, errorName),
        ...(stack ? { stack } : {}),
        ...(req ? requestActorOf(req) : {}),
        ...(text(commitSha) ? { commitSha: text(commitSha) } : {}),
      };
      writeLine(logger, level, entry);
      written = true;
      alert(entry);
    } catch {
      if (written) return;
      // The error could not be described (for example an object whose
      // properties throw). A minimal line still records that it happened;
      // reporting must never turn one failure into two.
      writeLine(logger, "error", {
        time: new Date().toISOString(),
        level: "error",
        event: identifier(event) || "server_error",
        ...(typeof id === "string" && id ? { requestId: id } : {}),
        ...(Number.isInteger(status) ? { status } : {}),
        errorName: "UnloggableError",
      });
    }
  }

  // Route handlers that answer 500 themselves are expected to report the
  // error first; this records the ones that do not, without a stack.
  function reportUnreported(req, status) {
    if (!req || reported.has(req)) return;
    report(Object.assign(new Error(`Route answered ${status} without reporting an error`), {
      name: "UnreportedServerError",
      code: `HTTP_${status}`,
      stack: undefined,
    }), { req, status, phase: "response" });
  }

  // Waits for alerts in flight, up to timeoutMs; used before a crash exit.
  async function flush(waitMs = 2_000) {
    if (!pending.size) return;
    let timer;
    await Promise.race([
      Promise.allSettled([...pending]),
      // Kept referenced: while a crash waits here, nothing else may hold
      // the process open.
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  // For scripts/send-test-alert.mjs: bypasses the rate limit and resolves
  // with the outcome, so the script can say whether the alert arrived.
  function sendTestAlert() {
    const time = now().toISOString();
    const summary = `FlowChain ${service}: test alert. Error alerts reach this channel.`;
    return post({
      text: summary,
      content: summary,
      event: "test_alert",
      service,
      commitSha: text(commitSha) || undefined,
      errorName: "TestAlert",
      errorCode: "FLOWCHAIN_TEST_ALERT",
      time,
      suppressed: 0,
    });
  }

  return {
    report,
    reportUnreported,
    wasReported: (req) => Boolean(req) && reported.has(req),
    flush,
    sendTestAlert,
    get webhookEnabled() { return Boolean(webhookUrl); },
    // For tests: how many keys the rate limiter is holding.
    get trackedKeys() { return { sent: lastSentByKey.size, suppressed: suppressedByKey.size }; },
  };
}
