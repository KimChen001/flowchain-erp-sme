import assert from "node:assert/strict";
import test from "node:test";
import { RfqSupplierResponseCommandError } from "../domain/rfq-supplier-response-command-service.mjs";
import { handleRfqSupplierResponseRoute } from "./rfq-supplier-response.routes.mjs";

function routeContext({ path, body = {}, authenticated = true, headers = {}, service } = {}) {
  const sent = [];
  const ctx = {
    req: { method: "POST", headers },
    res: {},
    url: new URL(`http://localhost${path}`),
    identity: authenticated ? { authenticated: true, tenantId: "signed-tenant", userId: "signed-user", role: "buyer" } : { authenticated: false },
    rfqSupplierResponseCommandService: service,
    readBody: async () => body,
    send: (_res, status, payload) => sent.push({ status, payload }),
  };
  return { ctx, sent };
}

test("initial and append routes pass decoded IDs, signed identity, and header idempotency", async () => {
  const calls = [];
  const service = {
    recordInitialResponse: async (rfqId, input, context) => {
      calls.push({ operation: "initial", rfqId, input, context });
      return { entityId: "quotation-1", entityVersion: 1, idempotentReplay: false };
    },
    appendRevision: async (rfqId, supplierId, input, context) => {
      calls.push({ operation: "append", rfqId, supplierId, input, context });
      return { entityId: "quotation-1", entityVersion: 2, idempotentReplay: false };
    },
  };
  const initial = routeContext({
    path: "/api/procurement/rfqs/RFQ%201/supplier-responses",
    headers: { "idempotency-key": "header-key" },
    body: { idempotencyKey: "body-key", supplierId: "supplier-1" },
    service,
  });
  assert.equal(await handleRfqSupplierResponseRoute(initial.ctx), true);
  assert.equal(initial.sent[0].status, 201);
  assert.equal(calls[0].rfqId, "RFQ 1");
  assert.equal(calls[0].input.idempotencyKey, "header-key");
  assert.equal(calls[0].context.identity.tenantId, "signed-tenant");

  const append = routeContext({
    path: "/api/procurement/rfqs/RFQ%201/supplier-responses/SUP%201/revisions",
    body: { idempotencyKey: "append-key", expectedVersion: 1 },
    service,
  });
  assert.equal(await handleRfqSupplierResponseRoute(append.ctx), true);
  assert.equal(append.sent[0].status, 201);
  assert.deepEqual({ rfqId: calls[1].rfqId, supplierId: calls[1].supplierId }, { rfqId: "RFQ 1", supplierId: "SUP 1" });
});

test("route returns a committed idempotent replay without changing its result", async () => {
  const replay = { entityId: "quotation-1", entityVersion: 2, idempotentReplay: true };
  const { ctx, sent } = routeContext({
    path: "/api/procurement/rfqs/rfq-1/supplier-responses/supplier-1/revisions",
    body: { idempotencyKey: "replay-key" },
    service: { appendRevision: async () => replay },
  });
  await handleRfqSupplierResponseRoute(ctx);
  assert.deepEqual(sent, [{ status: 201, payload: replay }]);
});

test("route maps authentication and known command failures to stable status codes", async (t) => {
  const unauthenticated = routeContext({ path: "/api/procurement/rfqs/rfq-1/supplier-responses", authenticated: false });
  await handleRfqSupplierResponseRoute(unauthenticated.ctx);
  assert.deepEqual(unauthenticated.sent, [{ status: 401, payload: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } }]);

  for (const [status, code] of [
    [404, "RFQ_NOT_FOUND"],
    [409, "RFQ_RESPONSE_VERSION_CONFLICT"],
    [422, "RFQ_RESPONSE_DECIMAL_INVALID"],
  ]) {
    await t.test(String(status), async () => {
      const route = routeContext({
        path: "/api/procurement/rfqs/rfq-1/supplier-responses",
        body: { idempotencyKey: "key", supplierId: "supplier-1" },
        service: { recordInitialResponse: async () => { throw new RfqSupplierResponseCommandError(code, "Safe message", status, { availableActions: ["reload"] }); } },
      });
      await handleRfqSupplierResponseRoute(route.ctx);
      assert.deepEqual(route.sent, [{ status, payload: { code, message: "Safe message", details: { availableActions: ["reload"] } } }]);
    });
  }

  const forbidden = routeContext({
    path: "/api/procurement/rfqs/rfq-1/supplier-responses",
    body: { idempotencyKey: "key", supplierId: "supplier-1" },
    service: { recordInitialResponse: async () => { throw Object.assign(new Error("Denied"), { name: "AuthorizationError", code: "AUTHORIZATION_PERMISSION_DENIED", status: 403 }); } },
  });
  await handleRfqSupplierResponseRoute(forbidden.ctx);
  assert.equal(forbidden.sent[0].status, 403);
  assert.equal(forbidden.sent[0].payload.code, "AUTHORIZATION_PERMISSION_DENIED");
});

test("route rejects non-object JSON and redacts unexpected persistence failures", async () => {
  const malformed = routeContext({ path: "/api/procurement/rfqs/rfq-1/supplier-responses", body: [] });
  await handleRfqSupplierResponseRoute(malformed.ctx);
  assert.equal(malformed.sent[0].status, 422);
  assert.equal(malformed.sent[0].payload.code, "RFQ_RESPONSE_PAYLOAD_INVALID");

  const invalidJson = routeContext({ path: "/api/procurement/rfqs/rfq-1/supplier-responses" });
  invalidJson.ctx.readBody = async () => { throw new SyntaxError("Unexpected token in private payload"); };
  await handleRfqSupplierResponseRoute(invalidJson.ctx);
  assert.deepEqual(invalidJson.sent, [{ status: 422, payload: { code: "RFQ_RESPONSE_PAYLOAD_INVALID", message: "The request body must contain valid JSON." } }]);

  const failed = routeContext({
    path: "/api/procurement/rfqs/rfq-1/supplier-responses",
    body: { idempotencyKey: "key", supplierId: "supplier-1" },
    service: { recordInitialResponse: async () => { throw Object.assign(new Error("P2002 secret database URL"), { code: "P2002" }); } },
  });
  await handleRfqSupplierResponseRoute(failed.ctx);
  assert.deepEqual(failed.sent, [{ status: 500, payload: { code: "RFQ_SUPPLIER_RESPONSE_COMMAND_FAILED", message: "The supplier response command could not be completed." } }]);
  assert.doesNotMatch(JSON.stringify(failed.sent), /P2002|secret|database URL/);
});

test("route ignores unrelated methods and paths", async () => {
  const { ctx, sent } = routeContext({ path: "/api/procurement/rfqs/rfq-1/supplier-responses" });
  ctx.req.method = "GET";
  assert.equal(await handleRfqSupplierResponseRoute(ctx), false);
  assert.deepEqual(sent, []);
});
