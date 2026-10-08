import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { createRouteContext } from "../bootstrap/request-context.mjs";
import { noteRequestActor, requestActorOf, withRequestLogging } from "../bootstrap/request-logging.mjs";
import { withServerErrorBoundary } from "../bootstrap/server-error-boundary.mjs";
import { registerProcessErrorHandlers } from "../bootstrap/server-lifecycle.mjs";
import {
  WEBHOOK_HOURLY_LIMIT,
  WEBHOOK_KEY_WINDOW_MS,
  createErrorReporter,
  errorWebhookUrl,
} from "../observability/error-reporter.mjs";
import { handlePriceHistoryRoute } from "../routes/price-history.routes.mjs";

const WEBHOOK = "https://hooks.example.com/services/T000/B000/hook-secret-part";

function memoryLogger() {
  const lines = [];
  const sink = (level) => (line) => lines.push({ level, raw: line, entry: JSON.parse(line) });
  return { lines, info: sink("info"), warn: sink("warn"), error: sink("error") };
}

function recordingFetch(respond = async () => ({ ok: true, status: 200 })) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  return { calls, fetchImpl };
}

function clock(start = Date.parse("2026-10-08T12:00:00.000Z")) {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => { at += ms; } };
}

// A request as the server sees it: id, actor and URL with a query string.
function signedInRequest(url = "/api/purchase-orders/PO-7?search=buyer%40example.com&token=query-token") {
  const req = { method: "POST", url, headers: { authorization: "Bearer header-token-value", cookie: "session=cookie-value" } };
  noteRequestActor(req, { authenticated: true, tenantId: "tenant-a", userId: "user-1", email: "buyer@example.com", name: "Pat Lee" });
  return req;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function secretError() {
  const error = Object.assign(new Error("connect failed DATABASE_URL=postgres://app:hunter2@db/prod with Bearer abc.def.ghi"), { code: "P1001" });
  error.stack = [
    "Error: connect failed DATABASE_URL=postgres://app:hunter2@db/prod",
    ...Array.from({ length: 12 }, (_, index) => `    at frame${index} (/app/server/file${index}.mjs:${index + 1}:1)`),
    "    at connect (postgresql://app:hunter2@db/prod)",
  ].join("\n");
  return error;
}

test("one server_error line with method, path, status, stack and actor ids only", () => {
  const logger = memoryLogger();
  const reporter = createErrorReporter({ logger, env: {}, commitSha: "abc1234", now: clock().now });
  reporter.report(secretError(), { req: signedInRequest(), requestId: "req-12345678", status: 500, phase: "boundary" });

  assert.equal(logger.lines.length, 1);
  const [{ level, entry, raw }] = logger.lines;
  assert.equal(level, "error");
  assert.deepEqual(Object.keys(entry), [
    "time", "level", "event", "requestId", "method", "path", "status", "phase",
    "error", "errorName", "errorCode", "stack", "tenantId", "userId", "commitSha",
  ]);
  assert.equal(entry.event, "server_error");
  assert.equal(entry.method, "POST");
  assert.equal(entry.path, "/api/purchase-orders/PO-7");
  assert.equal(entry.status, 500);
  assert.equal(entry.errorName, "Error");
  assert.equal(entry.errorCode, "P1001");
  assert.match(entry.error, /^P1001: connect failed/);
  assert.equal(entry.tenantId, "tenant-a");
  assert.equal(entry.userId, "user-1");
  assert.equal(entry.commitSha, "abc1234");
  assert.match(entry.stack, /^at frame0 /);
  assert.equal(entry.stack.split("\n").length, 13, "every frame outside production");
  assert.doesNotMatch(raw, /hunter2|postgres:\/\/|postgresql:\/\/|abc\.def\.ghi|header-token-value|cookie-value|query-token|buyer@example\.com|buyer%40|Pat Lee/);
});

test("production keeps the first 8 stack frames", () => {
  for (const env of [{ NODE_ENV: "production" }, { FLOWCHAIN_DEPLOYMENT_PROFILE: "production" }]) {
    const logger = memoryLogger();
    createErrorReporter({ logger, env }).report(secretError(), { status: 500 });
    const { entry } = logger.lines[0];
    assert.equal(entry.stack.split("\n").length, 8);
    assert.match(entry.stack.split("\n").at(-1), /^at frame7 /);
  }
});

test("a logger without error() gets the line on warn(); a broken logger is ignored", () => {
  const warned = [];
  createErrorReporter({ logger: { warn: (line) => warned.push(line) }, env: {} }).report(new Error("x"));
  assert.equal(warned.length, 1);
  assert.doesNotThrow(() => createErrorReporter({ logger: { error() { throw new Error("sink down"); } }, env: {} }).report(new Error("x")));
  assert.doesNotThrow(() => createErrorReporter({ logger: {}, env: {} }).report("a thrown string"));
});

test("non-Error values are reported with a fixed name and no stack", () => {
  const logger = memoryLogger();
  createErrorReporter({ logger, env: {} }).report("plain string thrown");
  assert.equal(logger.lines[0].entry.errorName, "NonErrorThrown");
  assert.equal(logger.lines[0].entry.stack, undefined);
});

test("the webhook gets name, code, path and request id, never the message or actor ids", async () => {
  const logger = memoryLogger();
  const { calls, fetchImpl } = recordingFetch();
  const reporter = createErrorReporter({
    logger,
    env: { FLOWCHAIN_ERROR_WEBHOOK_URL: WEBHOOK, RENDER_SERVICE_NAME: "flowchain-staging" },
    fetchImpl,
    commitSha: "abc1234",
    now: clock().now,
  });
  const returned = reporter.report(secretError(), { req: signedInRequest("/api/users/buyer@example.com/roles?x=1"), requestId: "req-12345678", status: 500, phase: "boundary" });
  assert.equal(returned, undefined, "report() never hands back a promise to await");
  assert.equal(calls.length, 0, "the POST starts after report() has returned");
  await settle();

  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls;
  assert.equal(url, WEBHOOK);
  assert.equal(init.method, "POST");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(body).sort(), [
    "commitSha", "content", "errorCode", "errorName", "event", "method", "path", "requestId",
    "service", "status", "suppressed", "text", "time",
  ]);
  assert.equal(body.text, body.content);
  assert.equal(body.service, "flowchain-staging");
  assert.equal(body.path, "/api/users/[redacted]/roles");
  assert.equal(body.errorCode, "P1001");
  assert.equal(body.suppressed, 0);
  assert.match(body.text, /server_error P1001 on 500 POST \/api\/users\/\[redacted\]\/roles \(request req-12345678\)/);
  assert.doesNotMatch(init.body, /connect failed|hunter2|tenant-a|user-1|buyer@example\.com|Pat Lee|header-token/);
  assert.doesNotMatch(JSON.stringify(logger.lines), /hooks\.example\.com|hook-secret-part/);
});

test("alerts are limited to 1 per code and path per 5 minutes and 10 an hour, counting what was held back", async () => {
  const time = clock();
  const { calls, fetchImpl } = recordingFetch();
  const reporter = createErrorReporter({ logger: memoryLogger(), env: { FLOWCHAIN_ERROR_WEBHOOK_URL: WEBHOOK }, fetchImpl, now: time.now });
  const fail = (code, url = "/api/items") => reporter.report(Object.assign(new Error("x"), { code }), { req: { method: "GET", url }, status: 500 });

  fail("P1001");
  fail("P1001");
  fail("P1001");
  fail("P2002");
  fail("P1001", "/api/suppliers");
  await settle();
  assert.deepEqual(calls.map(({ body }) => [body.errorCode, body.path]), [["P1001", "/api/items"], ["P2002", "/api/items"], ["P1001", "/api/suppliers"]]);

  time.advance(WEBHOOK_KEY_WINDOW_MS);
  fail("P1001");
  await settle();
  assert.equal(calls.at(-1).body.suppressed, 2);

  for (let index = 0; index < 20; index += 1) fail(`CODE_${index}`);
  await settle();
  assert.equal(calls.length, WEBHOOK_HOURLY_LIMIT);

  time.advance(60 * 60_000);
  fail("CODE_15");
  await settle();
  assert.equal(calls.length, WEBHOOK_HOURLY_LIMIT + 1);
  assert.equal(calls.at(-1).body.suppressed, 1);
});

test("a failing, hanging or throwing webhook never throws and is logged once per window without the URL", async () => {
  const time = clock();
  for (const respond of [
    async () => ({ ok: false, status: 404 }),
    async () => { throw new Error(`getaddrinfo ENOTFOUND ${WEBHOOK}`); },
    () => { throw new Error("synchronous failure"); },
  ]) {
    const logger = memoryLogger();
    const reporter = createErrorReporter({ logger, env: { FLOWCHAIN_ERROR_WEBHOOK_URL: WEBHOOK }, fetchImpl: respond, now: time.now });
    assert.doesNotThrow(() => reporter.report(new Error("a"), { req: { method: "GET", url: "/api/a" } }));
    assert.doesNotThrow(() => reporter.report(new Error("b"), { req: { method: "GET", url: "/api/b" } }));
    await reporter.flush(500);
    const failures = logger.lines.filter(({ entry }) => entry.event === "error_webhook_failed");
    assert.equal(failures.length, 1);
    assert.deepEqual(Object.keys(failures[0].entry), ["time", "level", "event", "status"]);
    assert.doesNotMatch(JSON.stringify(logger.lines), /hooks\.example\.com|hook-secret-part/);
  }

  // A hanging endpoint is aborted by the timeout.
  const logger = memoryLogger();
  let aborted = false;
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  });
  const reporter = createErrorReporter({ logger, env: { FLOWCHAIN_ERROR_WEBHOOK_URL: WEBHOOK }, fetchImpl: hanging, timeoutMs: 20 });
  reporter.report(new Error("slow"));
  await reporter.flush(1_000);
  assert.equal(aborted, true);
  assert.equal(logger.lines.filter(({ entry }) => entry.event === "error_webhook_failed").length, 1);
});

test("only an https webhook URL is used; anything else is reported as disabled without the value", async () => {
  assert.deepEqual(errorWebhookUrl({}), { url: null, reason: "not_configured" });
  assert.deepEqual(errorWebhookUrl({ FLOWCHAIN_ERROR_WEBHOOK_URL: "http://hooks.example.com/x" }), { url: null, reason: "https_required" });
  assert.deepEqual(errorWebhookUrl({ FLOWCHAIN_ERROR_WEBHOOK_URL: "not a url" }), { url: null, reason: "invalid_url" });

  const logger = memoryLogger();
  const { calls, fetchImpl } = recordingFetch();
  const reporter = createErrorReporter({ logger, env: { FLOWCHAIN_ERROR_WEBHOOK_URL: "http://hooks.example.com/plain-secret" }, fetchImpl });
  reporter.report(new Error("x"));
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(reporter.webhookEnabled, false);
  assert.deepEqual(logger.lines[0].entry.event, "error_webhook_disabled");
  assert.deepEqual(logger.lines[0].entry.reason, "https_required");
  assert.doesNotMatch(JSON.stringify(logger.lines), /plain-secret|hooks\.example\.com/);
});

test("the test alert bypasses the rate limit and resolves with the outcome", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const reporter = createErrorReporter({ logger: memoryLogger(), env: { FLOWCHAIN_ERROR_WEBHOOK_URL: WEBHOOK }, fetchImpl });
  assert.deepEqual(await reporter.sendTestAlert(), { sent: true, status: 200 });
  assert.deepEqual(await reporter.sendTestAlert(), { sent: true, status: 200 });
  assert.equal(calls[0].body.errorCode, "FLOWCHAIN_TEST_ALERT");
  assert.deepEqual(await createErrorReporter({ env: {} }).sendTestAlert(), { sent: false, reason: "not_configured" });
});

test("requestActorOf returns a copy of the noted ids, or nothing", () => {
  const req = signedInRequest();
  assert.deepEqual(requestActorOf(req), { tenantId: "tenant-a", userId: "user-1" });
  requestActorOf(req).tenantId = "changed";
  assert.equal(requestActorOf(req).tenantId, "tenant-a");
  assert.deepEqual(requestActorOf({}), {});
});

test("a route-level 500 now writes a server_error line through the route context", async () => {
  const logger = memoryLogger();
  const reporter = createErrorReporter({ logger, env: {} });
  const req = signedInRequest("/api/procurement/price-history?key=ITEM-1%7Cpcs%7CUSD");
  req.method = "GET";
  const sent = [];
  const ctx = createRouteContext({
    req,
    res: {},
    url: new URL(`http://localhost${req.url}`),
    identity: { authenticated: true, tenantId: "tenant-a", userId: "user-1" },
    domain: {},
    runtime: {},
    errorReporter: reporter,
  });
  ctx.send = (_res, status, payload) => sent.push({ status, payload });
  ctx.priceHistoryService = { read: async () => { throw Object.assign(new Error("P2010 raw query failed at postgres://secret"), { code: "P2010" }); } };

  await handlePriceHistoryRoute(ctx);
  assert.deepEqual(sent, [{ status: 500, payload: { code: "PRICE_HISTORY_FAILED", message: "The price history could not be loaded." } }]);
  assert.equal(logger.lines.length, 1);
  assert.deepEqual(
    (({ event, method, path, status, phase, errorCode, tenantId, userId }) => ({ event, method, path, status, phase, errorCode, tenantId, userId }))(logger.lines[0].entry),
    { event: "server_error", method: "GET", path: "/api/procurement/price-history", status: 500, phase: "route", errorCode: "P2010", tenantId: "tenant-a", userId: "user-1" },
  );
  assert.doesNotMatch(logger.lines[0].raw, /postgres:\/\/secret/);
});

async function serve(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

test("a 500 a route sends without reporting is still recorded once; a reported one is not doubled", async () => {
  const logger = memoryLogger();
  const reporter = createErrorReporter({ logger, env: {} });
  const silent = (_req, res) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"code":"X"}'); };
  const reported = (req, res) => { reporter.report(new Error("known"), { req, status: 500, phase: "route" }); silent(req, res); };
  const handler = withRequestLogging(withServerErrorBoundary(async (req, res) => (req.url.startsWith("/api/silent") ? silent(req, res) : reported(req, res)), { reporter }));

  await serve(handler, async (port) => {
    const silentResponse = await get(port, "/api/silent?q=1");
    const reportedResponse = await get(port, "/api/reported");
    assert.deepEqual([silentResponse.status, silentResponse.body], [500, '{"code":"X"}']);
    assert.deepEqual([reportedResponse.status, reportedResponse.body], [500, '{"code":"X"}']);
    await settle();
  });
  assert.deepEqual(
    logger.lines.map(({ entry }) => [entry.path, entry.errorName, entry.errorCode, entry.phase, "stack" in entry]),
    [["/api/silent", "UnreportedServerError", "HTTP_500", "response", false], ["/api/reported", "Error", "Error", "route", true]],
  );
});

test("process errors are logged as fatal, alerts are flushed, then the process exits 1", async () => {
  const target = new EventEmitter();
  const exits = [];
  const logger = memoryLogger();
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const reporter = createErrorReporter({ logger, env: { FLOWCHAIN_ERROR_WEBHOOK_URL: WEBHOOK }, fetchImpl });
  const remove = registerProcessErrorHandlers({ reporter, target, exit: (code) => exits.push(code), flushTimeoutMs: 1_000 });
  assert.equal(target.listenerCount("uncaughtException"), 1);
  assert.equal(target.listenerCount("unhandledRejection"), 1);

  target.emit("uncaughtException", Object.assign(new Error("boom with sk-live-123"), { code: "ERR_BOOM" }));
  await settle();
  assert.deepEqual(exits, [], "waits for the alert in flight");
  resolveFetch({ ok: true, status: 200 });
  await settle();
  await settle();
  assert.deepEqual(exits, [1]);
  const { entry } = logger.lines[0];
  assert.deepEqual([entry.event, entry.phase, entry.fatal, entry.errorCode], ["process_error", "uncaughtException", true, "ERR_BOOM"]);
  assert.doesNotMatch(logger.lines[0].raw, /sk-live-123/);

  // A second failure while exiting exits at once.
  target.emit("unhandledRejection", "late rejection");
  assert.deepEqual(exits, [1, 1]);

  remove();
  assert.equal(target.listenerCount("uncaughtException"), 0);
  assert.equal(target.listenerCount("unhandledRejection"), 0);
});

test("a process error exits even when the webhook never answers", async () => {
  const target = new EventEmitter();
  const exits = [];
  const reporter = createErrorReporter({ logger: memoryLogger(), env: { FLOWCHAIN_ERROR_WEBHOOK_URL: WEBHOOK }, fetchImpl: () => new Promise(() => {}) });
  registerProcessErrorHandlers({ reporter, target, exit: (code) => exits.push(code), flushTimeoutMs: 20 });
  target.emit("unhandledRejection", new Error("never answered"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(exits, [1]);
});
