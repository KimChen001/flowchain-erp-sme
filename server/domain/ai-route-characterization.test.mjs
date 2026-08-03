import assert from "node:assert/strict";
import test from "node:test";
import { handleAiRoute } from "../routes/ai.routes.mjs";
import { createProductReviewScenarioDb } from "./test-fixtures/product-review-scenario.mjs";

function createRoute(body, database = createProductReviewScenarioDb()) {
  let response = null;
  let providerCalls = 0;
  let persistenceWrites = 0;
  const context = {
    req: { method: "POST", headers: {}, body },
    res: {},
    url: new URL("/api/ai/chat", "http://localhost"),
    db: database,
    readBody: async request => request.body,
    writeDb: async () => { persistenceWrites += 1; },
    event: () => {},
    ensureRfqs: db => Array.isArray(db.rfqs) ? db.rfqs : [],
    ensurePurchaseRequests: db => Array.isArray(db.purchaseRequests) ? db.purchaseRequests : [],
    ensureInventoryMovements: db => Array.isArray(db.inventoryMovements) ? db.inventoryMovements : [],
    ensureEvents: db => Array.isArray(db.events) ? db.events : [],
    ensureAuditLog: db => Array.isArray(db.auditLog) ? db.auditLog : [],
    supplierPerformance: db => Array.isArray(db.suppliers) ? db.suppliers : [],
    supplierRecommendations: () => null,
    supplierQuoteCount: 0,
    openaiDispatcher: { dispatch() { providerCalls += 1; throw new Error("provider must not run"); } },
    arkDispatcher: { dispatch() { providerCalls += 1; throw new Error("provider must not run"); } },
    aiMaxTokens: 120,
    repositories: {},
    send(_response, status, payload) {
      response = { status, payload };
    },
  };
  return {
    context,
    database,
    get response() { return response; },
    get providerCalls() { return providerCalls; },
    get persistenceWrites() { return persistenceWrites; },
  };
}

function businessSnapshot(db) {
  return structuredClone({
    purchaseRequests: db.purchaseRequests,
    rfqs: db.rfqs,
    purchaseOrders: db.purchaseOrders,
    receivingDocs: db.receivingDocs,
    supplierInvoices: db.supplierInvoices,
    inventoryMovements: db.inventoryMovements,
    salesOrders: db.salesOrders,
    suppliers: db.suppliers,
    products: db.products,
  });
}

async function characterize({ moduleId, message }) {
  const route = createRoute({ moduleId, message, question: message });
  const before = businessSnapshot(route.database);
  assert.equal(await handleAiRoute(route.context), true);
  assert.equal(route.response.status, 200);
  assert.equal(route.providerCalls, 0);
  assert.equal(route.persistenceWrites, 0);
  assert.deepEqual(businessSnapshot(route.database), before);
  return route.response.payload;
}

function contract(payload) {
  return {
    intent: payload.intent?.name,
    provider: payload.provider,
    providerStatus: payload.providerStatus || null,
    degraded: payload.degraded === true,
    cardTypes: (payload.cards || []).map(card => card.type),
    evidenceIds: (payload.evidence || []).map(item => item.id),
  };
}

test("AI route preserves deterministic handler precedence across core read domains", async () => {
  const cases = [
    {
      moduleId: "inventory",
      message: "库存风险有哪些？",
      expected: {
        intent: "inventory_status_query",
        provider: "local_status_query",
        cardTypes: ["inventory_risk_summary", "evidence", "recommended_actions"],
        evidenceIds: ["items", "inventory_movements"],
      },
    },
    {
      moduleId: "sales",
      message: "有哪些销售订单交付风险？",
      expected: {
        intent: "customer_delivery_risk_query",
        provider: "deterministic",
        cardTypes: ["sales_demand_summary", "sales_order_delivery_risk", "evidence", "recommended_actions"],
        evidenceIds: ["SO-2026-0412-A", "SKU-00412", "PO-2026-1282", "1", "SUP-SZXY", "GRN-202605-0419"],
      },
    },
    {
      moduleId: "procurement",
      message: "RFQ-26-0046 有几家回复？",
      expected: {
        intent: "rfq_response_query",
        provider: "local_rfq_operational_query",
        cardTypes: ["rfq_response_summary", "evidence", "recommended_actions"],
        evidenceIds: ["RFQ-26-0046", "RFQ-26-0046"],
      },
    },
    {
      moduleId: "srm",
      message: "哪些供应商需要跟进？",
      expected: {
        intent: "supplier_high_risk_summary_query",
        provider: "local_supplier_operational_query",
        cardTypes: ["supplier_high_risk_summary", "supplier_scoring_explanation", "supplier_next_actions", "supplier_boundary_notice", "evidence", "recommended_actions"],
        evidenceIds: ["supplier_risk_summary", "supplier_alpha_boundary"],
      },
    },
    {
      moduleId: "finance",
      message: "哪些三单匹配有差异？",
      expected: {
        intent: "finance_variance_explanation_query",
        provider: "local_finance_collaboration_query",
        cardTypes: ["finance_variance_summary", "three_way_match_summary", "finance_boundary_notice", "evidence", "recommended_actions"],
        evidenceIds: ["INV-SZ-260601", "MATCH-INV-SZ-260601"],
      },
    },
    {
      moduleId: "overview",
      message: "展示 PO-2026-1282 的证据链",
      expected: {
        intent: "evidence_graph_query",
        provider: "deterministic",
        cardTypes: ["evidence_graph", "evidence", "recommended_actions"],
        evidenceIds: ["PO-2026-1282", "SKU-00412", "1", "2", "6", "8", "SO-2026-0412-A", "PR-2026-2401"],
      },
    },
  ];

  for (const item of cases) {
    const actual = contract(await characterize(item));
    assert.deepEqual(actual, {
      ...item.expected,
      providerStatus: item.expected.provider === "deterministic" || item.expected.provider === "local_finance_collaboration_query"
        ? "deterministic"
        : null,
      degraded: false,
    }, item.message);
  }
});

test("AI route preserves review-only PR and RFQ draft contracts", async () => {
  for (const item of [
    { message: "PR A100 300 urgent", type: "pr_draft", intent: "prepare_purchase_request_draft" },
    { message: "Create RFQ for A100 qty 1000", type: "rfq_draft", intent: "prepare_rfq_draft" },
  ]) {
    const payload = await characterize({ moduleId: "procurement", message: item.message });
    const draft = payload.cards.find(card => card.type === item.type);
    const missing = payload.cards.find(card => card.type === "missing_fields");
    assert.equal(payload.intent.name, item.intent);
    assert.equal(payload.mode, "draft_preparation");
    assert.equal(payload.provider, "local_draft_preparation");
    assert.equal(draft.reviewRequired, true);
    assert.equal(draft.data.documentStatus, "draft");
    assert.ok(Array.isArray(missing.fields));
    assert.deepEqual((payload.cards || []).map(card => card.type), [
      item.type,
      "missing_fields",
      "confidence_summary",
      "recommended_actions",
    ]);
  }
});

test("compound AI orchestration keeps model and mutation boundaries closed", async () => {
  const payload = await characterize({
    moduleId: "overview",
    message: "今天有什么要做，订单还有多少没有收货，哪些供应商有风险？",
  });
  assert.equal(payload.intent.name, "compound_business_query");
  assert.equal(payload.provider, "local");
  assert.equal(payload.providerStatus, "deterministic");
  assert.equal(payload.aiModelRoute.usedModel, false);
  assert.equal(payload.aiModelRoute.providerCallsAllowed, false);
  assert.deepEqual(payload.cards.map(card => card.type), [
    "compound_summary",
    "compound_section",
    "compound_section",
    "evidence",
    "recommended_actions",
  ]);
});
