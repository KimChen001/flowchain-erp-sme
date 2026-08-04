import assert from "node:assert/strict";
import test from "node:test";
import { handleAiRoute } from "../routes/ai.routes.mjs";
import { createProductReviewScenarioDb } from "./test-fixtures/product-review-scenario.mjs";

function routeContext(body, db) {
  let response;
  let persistenceWrites = 0;
  return {
    context: {
      req: { method: "POST", headers: {}, body },
      res: {},
      url: new URL("/api/ai/chat", "http://localhost"),
      db,
      readBody: async request => request.body,
      writeDb: async () => { persistenceWrites += 1; },
      event: () => {},
      ensureRfqs: database => database.rfqs || [],
      ensurePurchaseRequests: database => database.purchaseRequests || [],
      ensureInventoryMovements: database => database.inventoryMovements || [],
      ensureEvents: database => database.events || [],
      ensureAuditLog: database => database.auditLog || [],
      supplierPerformance: database => database.suppliers || [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 0,
      repositories: {},
      openaiDispatcher: { dispatch() { throw new Error("provider must remain closed"); } },
      arkDispatcher: { dispatch() { throw new Error("provider must remain closed"); } },
      aiMaxTokens: 120,
      send(_res, status, payload) { response = { status, payload }; },
    },
    get response() { return response; },
    get persistenceWrites() { return persistenceWrites; },
  };
}

test("AI reads, evidence explanations, drafts, and compound commands never mutate business facts", async () => {
  const prompts = [
    ["sales", "有哪些销售订单交付风险？"],
    ["inventory", "库存风险有哪些？"],
    ["procurement", "RFQ-26-0046 有几家回复？"],
    ["srm", "哪些供应商需要跟进？"],
    ["finance", "哪些三单匹配有差异？"],
    ["overview", "展示 PO-2026-1282 的证据链"],
    ["procurement", "PR A100 300 urgent"],
    ["procurement", "Create RFQ for A100 qty 1000"],
    ["overview", "今天有什么要做，订单还有多少没有收货，哪些供应商有风险？"],
  ];

  for (const [moduleId, message] of prompts) {
    const db = createProductReviewScenarioDb();
    const before = structuredClone(db);
    const route = routeContext({ moduleId, message, question: message }, db);
    assert.equal(await handleAiRoute(route.context), true, message);
    assert.equal(route.response.status, 200, message);
    assert.equal(route.persistenceWrites, 0, message);
    assert.deepEqual(db, before, message);

    const draftCards = (route.response.payload.cards || []).filter(card => /_draft$/.test(card.type));
    for (const draft of draftCards) {
      assert.equal(draft.reviewRequired, true, message);
      assert.equal(draft.data.documentStatus, "draft", message);
    }
    const actionKinds = (route.response.payload.cards || [])
      .filter(card => card.type === "recommended_actions")
      .flatMap(card => card.actions || [])
      .map(action => action.kind);
    assert.equal(actionKinds.includes("execute"), false, message);
    assert.equal(actionKinds.includes("business_command"), false, message);
  }
});
