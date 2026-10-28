import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { withServerErrorBoundary } from "../bootstrap/server-error-boundary.mjs";
import { handleSessionRoutes } from "../bootstrap/session-routes.mjs";
import { createErrorReporter } from "../observability/error-reporter.mjs";
import { handleAttachmentRoute } from "../routes/attachments.routes.mjs";
import { handleBankReconciliationRoute } from "../routes/bank-reconciliation.routes.mjs";
import { DEFAULT_MAX_BODY_BYTES, bodyLimitForFile, readBody, send } from "../utils/http.mjs";
import { KNOWLEDGE_FILE_LIMITS } from "./ai-knowledge-file-parser.mjs";
import { MAX_UPLOAD_BYTES } from "./attachment-service.mjs";
import { bankStatementLimits } from "./bank-statement-service.mjs";

// A request stream that records whether anything was pulled from it.
function streamedRequest(chunks, headers = {}) {
  const pulled = [];
  const req = Object.assign(
    Readable.from((async function* () {
      for (const chunk of chunks) {
        pulled.push(chunk.length);
        yield Buffer.from(chunk);
      }
    })()),
    { method: "POST", headers },
  );
  return { req, pulled };
}

test("readBody parses a normal body, treats an empty one as {}, and reads a request once", async () => {
  const { req } = streamedRequest(['{"name":', '"Acme"}']);
  assert.deepEqual(await readBody(req), { name: "Acme" });
  assert.deepEqual(await readBody(req), { name: "Acme" });
  assert.deepEqual(await readBody(streamedRequest([]).req), {});
});

test("a Content-Length over the cap is refused with 413 before any of the body is read", async () => {
  const { req, pulled } = streamedRequest(["{}"], { "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) });
  await assert.rejects(readBody(req), { name: "RequestBodyError", code: "REQUEST_BODY_TOO_LARGE", status: 413, details: { limitBytes: DEFAULT_MAX_BODY_BYTES } });
  assert.deepEqual(pulled, []);
});

test("a streamed body that passes the cap is refused with 413 and the rest is drained, not kept", async () => {
  const { req } = streamedRequest(Array.from({ length: 8 }, () => "x".repeat(1024)));
  await assert.rejects(readBody(req, { maxBytes: 2500 }), { code: "REQUEST_BODY_TOO_LARGE", status: 413, details: { limitBytes: 2500 } });
  await once(req, "end");
});

test("a body that is not JSON is a 400 and is still a SyntaxError for routes that map it", async () => {
  const error = await readBody(streamedRequest(["{not json"]).req).catch((caught) => caught);
  assert.ok(error instanceof SyntaxError);
  assert.equal(error.name, "RequestBodyError");
  assert.equal(error.code, "REQUEST_BODY_INVALID_JSON");
  assert.equal(error.status, 400);
});

test("a route's larger cap admits a body the default refuses, and every upload limit fits its base64 body", async () => {
  const body = { fileName: "statement.csv", contentBase64: "A".repeat(2 * 1024 * 1024) };
  const text = JSON.stringify(body);
  await assert.rejects(readBody(streamedRequest([text]).req), { status: 413 });
  assert.deepEqual(await readBody(streamedRequest([text]).req, { maxBytes: bodyLimitForFile(2 * 1024 * 1024) }), body);
  for (const fileBytes of [MAX_UPLOAD_BYTES, KNOWLEDGE_FILE_LIMITS.maximumBytes, bankStatementLimits({}).maxFileBytes]) {
    const encoded = Buffer.alloc(fileBytes).toString("base64").length;
    assert.ok(bodyLimitForFile(fileBytes) >= encoded + 64 * 1024, `${fileBytes} bytes of file must fit with room for the other fields`);
  }
});

test("attachment and bank statement uploads pass their own cap; other routes keep the default", async () => {
  const reads = [];
  const readBodyRecorder = async (_req, options) => (reads.push(options), {});
  const sent = [];
  const attachment = (path) => ({
    req: { method: "POST", headers: {} },
    res: {},
    url: new URL(`http://local${path}`),
    identity: { authenticated: true, tenantId: "tenant", userId: "user" },
    env: { FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: "true" },
    attachmentPrisma: {},
    attachmentService: { stageUpload: async () => ({}), bindReceiving: async () => ({}) },
    readBody: readBodyRecorder,
    send: (_res, status, payload) => sent.push({ status, payload }),
  });
  await handleAttachmentRoute(attachment("/api/uploads/stage"));
  await handleAttachmentRoute(attachment("/api/receiving/drafts/GRN-1/attachments"));
  const env = { FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_BANK_RECONCILIATION: "true", FLOWCHAIN_BANK_IMPORT_MAX_FILE_BYTES: String(5 * 1024 * 1024) };
  await handleBankReconciliationRoute({
    req: { method: "POST", headers: {} },
    res: {},
    url: new URL("http://local/api/finance/bank-statements/uploads"),
    identity: { authenticated: true, tenantId: "tenant", userId: "user" },
    env,
    bankReconciliationPrisma: {},
    bankStatementService: { stageUpload: async () => ({}) },
    bankReconciliationService: {},
    readBody: readBodyRecorder,
    send: (_res, status, payload) => sent.push({ status, payload }),
  });
  assert.deepEqual(sent.map((item) => item.status), [201, 201, 201]);
  assert.deepEqual(reads, [{ maxBytes: bodyLimitForFile(MAX_UPLOAD_BYTES) }, undefined, { maxBytes: bodyLimitForFile(5 * 1024 * 1024) }]);
});

test("an upload route answers the 413 itself instead of a 500", async () => {
  const sent = [];
  const { req } = streamedRequest(["{}"], { "content-length": String(bodyLimitForFile(MAX_UPLOAD_BYTES) + 1) });
  await handleAttachmentRoute({
    req,
    res: {},
    url: new URL("http://local/api/uploads/stage"),
    identity: { authenticated: true, tenantId: "tenant", userId: "user" },
    env: { FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: "true" },
    attachmentPrisma: {},
    attachmentService: { stageUpload: async () => assert.fail("an oversized upload must not reach the service") },
    readBody,
    reportError: () => assert.fail("a 413 is not an unexpected error"),
    send: (_res, status, payload) => sent.push({ status, payload }),
  });
  assert.equal(sent[0].status, 413);
  assert.equal(sent[0].payload.code, "REQUEST_BODY_TOO_LARGE");
});

test("sign-in routes refuse an oversized body and still treat an unreadable one as empty", async () => {
  const requested = [];
  const emailLinks = { request: async (input) => requested.push(input.email) };
  const call = (req) => handleSessionRoutes({ req, res: { writeHead() {}, end() {} }, url: new URL("http://local/api/auth/email-link"), identity: { authenticated: false }, emailLinks, env: {} });
  await assert.rejects(call(streamedRequest(["{}"], { "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) }).req), { code: "REQUEST_BODY_TOO_LARGE", status: 413 });
  assert.equal(await call(streamedRequest(["{not json"]).req), true);
  assert.deepEqual(requested, [undefined]);
});

test("over a real socket the server answers 413 and 400 as JSON, and later requests still succeed", async () => {
  const lines = [];
  const logger = { warn: (line) => lines.push(["warn", line]), error: (line) => lines.push(["error", line]) };
  const reporter = createErrorReporter({ logger, env: {} });
  const maxBytes = 4096;
  const server = http.createServer(withServerErrorBoundary(async (req, res) => send(res, 200, await readBody(req, { maxBytes })), { reporter }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const call = (write, headers = {}, { unfinished = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/api/example", headers, agent }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        if (unfinished) req.destroy();
        resolve({ status: res.statusCode, body: JSON.parse(text) });
      });
    });
    req.on("error", reject);
    write(req);
  });
  try {
    const declared = await call((req) => req.end("x".repeat(maxBytes + 1)), { "content-length": maxBytes + 1 });
    assert.deepEqual([declared.status, declared.body.code], [413, "REQUEST_BODY_TOO_LARGE"]);

    // No Content-Length, and the request is never finished: the 413 must not
    // wait for the end of the body.
    const streamed = await call((req) => {
      for (let i = 0; i < 3; i += 1) req.write("x".repeat(maxBytes / 2));
    }, {}, { unfinished: true });
    assert.deepEqual([streamed.status, streamed.body.code], [413, "REQUEST_BODY_TOO_LARGE"]);

    // A finished streamed body over the cap. The next two requests go out on
    // the kept-alive connection, which must not be reset under them.
    const finished = await call(async (req) => {
      for (let i = 0; i < 6; i += 1) {
        req.write("x".repeat(maxBytes / 2));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      req.end();
    });
    assert.deepEqual([finished.status, finished.body.code], [413, "REQUEST_BODY_TOO_LARGE"]);

    const malformed = await call((req) => req.end("{not json"), { "content-type": "application/json" });
    assert.deepEqual([malformed.status, malformed.body.code], [400, "REQUEST_BODY_INVALID_JSON"]);

    const normal = await call((req) => req.end(JSON.stringify({ quantity: 3 })), { "content-type": "application/json" });
    assert.deepEqual(normal, { status: 200, body: { quantity: 3 } });

    // Refused bodies are client errors: logged as warnings, never as server errors.
    assert.deepEqual(lines.map(([level]) => level), ["warn", "warn", "warn", "warn"]);
  } finally {
    agent.destroy();
    server.close();
  }
});
