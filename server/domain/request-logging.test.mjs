import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createScmServer } from "../bootstrap/scm-server.mjs";
import { noteRequestActor, requestLogEnabled, withRequestLogging } from "../bootstrap/request-logging.mjs";
import { withServerErrorBoundary } from "../bootstrap/server-error-boundary.mjs";

function memoryLogger() {
  const lines = [];
  const sink = (level) => (line) => lines.push({ level, entry: JSON.parse(line) });
  return { lines, info: sink("info"), warn: sink("warn"), error: sink("error") };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

// The finish event can fire just after the client sees the response.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  const port = await listen(server);
  try {
    return await run(port);
  } finally {
    await close(server);
  }
}

test("each API request gets an id and one log line without query, headers, or body", async () => {
  const logger = memoryLogger();
  let counter = 0;
  const handler = withRequestLogging(async (req, res) => {
    noteRequestActor(req, { authenticated: true, tenantId: "tenant-log", userId: "user-log", email: "buyer@example.com" });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end("{}");
  }, { logger, idFactory: () => `generated-id-${(counter += 1)}` });

  await withServer(handler, async (port) => {
    const response = await request(port, "POST", "/api/purchase-orders?search=secret-query&token=query-token-value", {
      Authorization: "Bearer header-token-value",
      Cookie: "session=cookie-value",
    });
    await settle();
    assert.equal(response.status, 201);
    assert.equal(response.headers["x-request-id"], "generated-id-1");
  });

  assert.equal(logger.lines.length, 1);
  const [{ level, entry }] = logger.lines;
  assert.equal(level, "info");
  assert.deepEqual(
    { ...entry, time: typeof entry.time, durationMs: typeof entry.durationMs },
    {
      time: "string",
      level: "info",
      event: "http_request",
      requestId: "generated-id-1",
      method: "POST",
      path: "/api/purchase-orders",
      status: 201,
      durationMs: "number",
      tenantId: "tenant-log",
      userId: "user-log",
    },
  );
  assert.doesNotMatch(JSON.stringify(logger.lines), /secret-query|query-token-value|header-token-value|cookie-value|buyer@example\.com/);
});

test("a well-formed forwarded request id is kept and anything else is replaced", async () => {
  const logger = memoryLogger();
  const handler = withRequestLogging(async (_req, res) => res.end("ok"), { logger, idFactory: () => "fresh-request-id" });
  await withServer(handler, async (port) => {
    const kept = await request(port, "GET", "/api/items", { "X-Request-Id": "upstream-proxy:4f2a-91" });
    const tooShort = await request(port, "GET", "/api/items", { "X-Request-Id": "short" });
    const injected = await request(port, "GET", "/api/items", { "X-Request-Id": "abcdefgh\" level=admin" });
    await settle();
    assert.equal(kept.headers["x-request-id"], "upstream-proxy:4f2a-91");
    assert.equal(tooShort.headers["x-request-id"], "fresh-request-id");
    assert.equal(injected.headers["x-request-id"], "fresh-request-id");
  });
  assert.deepEqual(logger.lines.map(({ entry }) => entry.requestId), ["upstream-proxy:4f2a-91", "fresh-request-id", "fresh-request-id"]);
});

test("probes and successful static assets are not logged; failures always are", async () => {
  const logger = memoryLogger();
  const handler = withRequestLogging(async (req, res) => {
    res.statusCode = req.url.startsWith("/broken") ? 503 : 200;
    res.end("ok");
  }, { logger });
  await withServer(handler, async (port) => {
    for (const path of ["/api/health", "/api/ready", "/assets/app.js", "/app/procurement/orders", "/broken/asset.js"])
      await request(port, "GET", path);
    await settle();
  });
  assert.deepEqual(logger.lines.map(({ level, entry }) => [level, entry.path, entry.status]), [["error", "/broken/asset.js", 503]]);
});

test("an unhandled error returns its request id and logs it once, sanitized", async () => {
  const requestLogger = memoryLogger();
  const errorLogger = memoryLogger();
  const handler = withRequestLogging(
    withServerErrorBoundary(async () => {
      throw Object.assign(new Error("connect failed DATABASE_URL=postgres://app:hunter2@db/prod DASHSCOPE_API_KEY=sk-live-123"), { code: "P1001" });
    }, { logger: errorLogger }),
    { logger: requestLogger, idFactory: () => "failing-request-id" },
  );
  await withServer(handler, async (port) => {
    const response = await request(port, "GET", "/api/home/overview");
    await settle();
    assert.equal(response.status, 500);
    assert.equal(response.headers["x-request-id"], "failing-request-id");
    assert.deepEqual(JSON.parse(response.body), { error: "Internal server error", requestId: "failing-request-id" });
  });
  assert.equal(errorLogger.lines.length, 1);
  assert.equal(errorLogger.lines[0].level, "error");
  assert.equal(errorLogger.lines[0].entry.event, "server_error");
  assert.equal(errorLogger.lines[0].entry.requestId, "failing-request-id");
  assert.match(errorLogger.lines[0].entry.error, /^P1001: connect failed/);
  assert.doesNotMatch(JSON.stringify(errorLogger.lines), /hunter2|sk-live-123|postgres:\/\//);
  assert.deepEqual(requestLogger.lines.map(({ level, entry }) => [level, entry.status, entry.requestId]), [["error", 500, "failing-request-id"]]);
});

test("an error after the response started is still logged", async () => {
  const errorLogger = memoryLogger();
  const handler = withRequestLogging(withServerErrorBoundary(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("partial");
    throw new Error("stream broke");
  }, { logger: errorLogger }), { idFactory: () => "streaming-request-id" });
  await withServer(handler, async (port) => {
    const response = await request(port, "GET", "/api/exports/items");
    assert.equal(response.body, "partial");
  });
  assert.deepEqual(errorLogger.lines.map(({ entry }) => [entry.requestId, entry.error]), [["streaming-request-id", "Error: stream broke"]]);
});

test("the composed server tags responses with an id and logs only when asked", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:5432/flowchain_request_logging";
  const requestLogger = memoryLogger();
  const quiet = createScmServer();
  const logged = createScmServer({ requestLogger });
  try {
    const quietPort = await listen(quiet);
    const loggedPort = await listen(logged);
    const quietResponse = await request(quietPort, "GET", "/api/not-a-route");
    const loggedResponse = await request(loggedPort, "GET", "/api/not-a-route?email=buyer@example.com", { Authorization: "Bearer not-a-real-token" });
    await settle();
    assert.equal(quietResponse.status, 404);
    assert.match(quietResponse.headers["x-request-id"], /^[0-9a-f-]{36}$/);
    assert.equal(loggedResponse.status, 404);
    assert.deepEqual(
      requestLogger.lines.map(({ entry }) => [entry.method, entry.path, entry.status, entry.requestId]),
      [["GET", "/api/not-a-route", 404, loggedResponse.headers["x-request-id"]]],
    );
    assert.doesNotMatch(JSON.stringify(requestLogger.lines), /buyer@example\.com|not-a-real-token/);
  } finally {
    await close(quiet);
    await close(logged);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("the access log is on by default and can be switched off", () => {
  assert.equal(requestLogEnabled({}), true);
  assert.equal(requestLogEnabled({ FLOWCHAIN_REQUEST_LOG: "off" }), false);
  assert.equal(requestLogEnabled({ FLOWCHAIN_REQUEST_LOG: " OFF " }), false);
});
