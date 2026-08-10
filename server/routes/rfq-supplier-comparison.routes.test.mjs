import assert from "node:assert/strict";
import test from "node:test";
import { RfqSupplierComparisonError } from "../domain/rfq-supplier-comparison-service.mjs";
import { handleRfqSupplierComparisonRoute } from "./rfq-supplier-comparison.routes.mjs";

function routeContext({
  path = "/api/procurement/rfqs/RFQ%201/comparison",
  method = "GET",
  authenticated = true,
  service,
} = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      req: { method },
      res: {},
      url: new URL(`http://localhost${path}`),
      identity: authenticated
        ? { authenticated: true, tenantId: "signed-tenant", userId: "signed-user", role: "buyer" }
        : { authenticated: false },
      rfqSupplierComparisonService: service,
      send: (_res, status, payload) => sent.push({ status, payload }),
    },
  };
}

test("comparison route passes decoded RFQ ID and signed identity", async () => {
  let observed;
  const payload = { rfqId: "RFQ 1", comparisonAvailability: "side_by_side_available" };
  const route = routeContext({
    service: {
      getComparison: async (rfqId, context) => {
        observed = { rfqId, tenantId: context.identity.tenantId, userId: context.identity.userId };
        return payload;
      },
    },
  });
  assert.equal(await handleRfqSupplierComparisonRoute(route.ctx), true);
  assert.deepEqual(observed, { rfqId: "RFQ 1", tenantId: "signed-tenant", userId: "signed-user" });
  assert.deepEqual(route.sent, [{ status: 200, payload }]);
});

test("comparison route requires authentication", async () => {
  const route = routeContext({ authenticated: false });
  assert.equal(await handleRfqSupplierComparisonRoute(route.ctx), true);
  assert.deepEqual(route.sent, [{ status: 401, payload: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } }]);
});

test("comparison route maps permission, missing RFQ, and validation errors", async (t) => {
  for (const [status, code] of [
    [403, "AUTHORIZATION_PERMISSION_DENIED"],
    [404, "RFQ_NOT_FOUND"],
    [422, "RFQ_ID_REQUIRED"],
  ]) {
    await t.test(String(status), async () => {
      const route = routeContext({
        service: {
          getComparison: async () => {
            if (status === 403) throw Object.assign(new Error("Denied"), { name: "AuthorizationError", code, status });
            throw new RfqSupplierComparisonError(code, "Safe comparison error", status);
          },
        },
      });
      await handleRfqSupplierComparisonRoute(route.ctx);
      assert.equal(route.sent[0].status, status);
      assert.equal(route.sent[0].payload.code, code);
    });
  }
});

test("comparison route redacts unexpected persistence failures", async () => {
  const route = routeContext({
    service: {
      getComparison: async () => {
        throw Object.assign(new Error("P2002 secret database URL"), { code: "P2002" });
      },
    },
  });
  await handleRfqSupplierComparisonRoute(route.ctx);
  assert.deepEqual(route.sent, [{ status: 500, payload: { code: "RFQ_SUPPLIER_COMPARISON_FAILED", message: "The supplier comparison could not be loaded." } }]);
  assert.doesNotMatch(JSON.stringify(route.sent), /P2002|secret|database URL/);
});

test("comparison route rejects malformed encoded RFQ IDs", async () => {
  const route = routeContext({
    path: "/api/procurement/rfqs/%E0%A4%A/comparison",
    service: { getComparison: async () => { throw new Error("should not call service"); } },
  });
  await handleRfqSupplierComparisonRoute(route.ctx);
  assert.deepEqual(route.sent, [{ status: 422, payload: { code: "RFQ_ID_INVALID", message: "rfqId is invalid." } }]);
});

test("comparison route ignores unrelated methods and paths", async () => {
  const wrongMethod = routeContext({ method: "POST" });
  const wrongPath = routeContext({ path: "/api/procurement/rfqs/rfq-1/supplier-responses" });
  assert.equal(await handleRfqSupplierComparisonRoute(wrongMethod.ctx), false);
  assert.equal(await handleRfqSupplierComparisonRoute(wrongPath.ctx), false);
});
