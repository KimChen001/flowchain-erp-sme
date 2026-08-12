import assert from "node:assert/strict";
import test from "node:test";
import { handleRfqAwardDecisionRoute } from "./rfq-award-decision.routes.mjs";

function context({ method = "GET", path = "/api/procurement/rfqs/rfq-1/award-decision", authenticated = true, service, body = {} } = {}) {
  const replies = [];
  return {
    req: { method, headers: {} }, res: {}, url: new URL(path, "http://localhost"),
    identity: authenticated ? { authenticated: true } : { authenticated: false },
    rfqAwardDecisionService: service,
    readBody: async () => body,
    send: (_res, status, payload) => replies.push({ status, payload }),
    replies,
  };
}

test("RFQ Award route returns a redacted internal error", async () => {
  const ctx = context({ service: { getAwardDecision: async () => { throw new Error("secret database detail"); } } });
  assert.equal(await handleRfqAwardDecisionRoute(ctx), true);
  assert.deepEqual(ctx.replies, [{ status: 500, payload: { code: "RFQ_AWARD_DECISION_FAILED", message: "The Award Decision request could not be completed." } }]);
  assert.equal(JSON.stringify(ctx.replies).includes("secret database detail"), false);
});

test("RFQ Award route requires authentication before service resolution", async () => {
  const ctx = context({ authenticated: false });
  assert.equal(await handleRfqAwardDecisionRoute(ctx), true);
  assert.equal(ctx.replies[0].status, 401);
  assert.equal(ctx.replies[0].payload.code, "AUTHENTICATION_REQUIRED");
});

test("RFQ Award POST rejects non-object input", async () => {
  const ctx = context({ method: "POST", path: "/api/procurement/rfqs/rfq-1/award-decisions", body: [] , service: {} });
  assert.equal(await handleRfqAwardDecisionRoute(ctx), true);
  assert.equal(ctx.replies[0].status, 422);
  assert.equal(ctx.replies[0].payload.code, "RFQ_AWARD_INPUT_INVALID");
});

test("RFQ Award route declines unrelated requests", async () => {
  const ctx = context({ path: "/api/procurement/rfqs/rfq-1/comparison" });
  assert.equal(await handleRfqAwardDecisionRoute(ctx), false);
  assert.deepEqual(ctx.replies, []);
});
