import assert from "node:assert/strict";
import test from "node:test";
import { buildAiFinanceCollaborationResponse } from "./ai-finance-collaboration-query.mjs";
import {
  buildProcurementDocumentLinks,
  getProcurementDocument,
} from "./procurement-read-model.mjs";
import { createProductReviewScenarioDb } from "./test-fixtures/product-review-scenario.mjs";

test("three-way match read model preserves invoice, PO, GRN, variance, and relationship evidence", () => {
  const db = createProductReviewScenarioDb();
  const match = getProcurementDocument(db, "threeWayMatch", "MATCH-INV-SZ-260601");
  assert.deepEqual({
    documentType: match.documentType,
    id: match.id,
    invoiceId: match.invoiceId,
    poId: match.poId,
    grnId: match.grnId,
    supplier: match.supplier,
    poAmount: match.poAmount,
    invoiceAmount: match.invoiceAmount,
    varianceAmount: match.varianceAmount,
    varianceRate: match.varianceRate,
    currency: match.currency,
    matchStatus: match.matchStatus,
    blockingReason: match.blockingReason,
  }, {
    documentType: "threeWayMatch",
    id: "MATCH-INV-SZ-260601",
    invoiceId: "INV-SZ-260601",
    poId: "PO-2026-1282",
    grnId: "GRN-202605-0419",
    supplier: "深圳新元电气",
    poAmount: 96000,
    invoiceAmount: 96000,
    varianceAmount: 3200,
    varianceRate: 0.0333,
    currency: "CNY",
    matchStatus: "存在差异",
    blockingReason: "PO 金额与发票金额存在差异，需复核后处理。",
  });
  assert.deepEqual(match.relatedDocuments.map(document => document.type), ["pr", "rfq", "po", "grn", "invoice"]);
  assert.ok(buildProcurementDocumentLinks(db).some(link =>
    link.sourceType === "invoice" &&
    link.sourceId === "INV-SZ-260601" &&
    link.targetType === "threeWayMatch" &&
    link.targetId === "MATCH-INV-SZ-260601" &&
    link.relationship === "matched_by"
  ));
});

test("finance AI explains three-way match variance without payment, posting, tax, or approval authority", () => {
  const db = createProductReviewScenarioDb();
  const before = structuredClone(db);
  const response = buildAiFinanceCollaborationResponse(db, {
    moduleId: "finance",
    message: "哪些三单匹配有差异？",
  });
  const variance = response.cards.find(card => card.type === "finance_variance_summary");
  const matches = response.cards.find(card => card.type === "three_way_match_summary");
  const boundary = response.cards.find(card => card.type === "finance_boundary_notice");

  assert.equal(response.intent.name, "finance_variance_explanation_query");
  assert.equal(response.providerStatus, "deterministic");
  assert.deepEqual(variance.data.topVariances[0], {
    invoiceId: "INV-SZ-260601",
    supplier: "深圳新元电气",
    amount: 96000,
    currency: "CNY",
    dueDate: "",
    matchStatus: "存在差异",
    invoiceStatus: "待处理",
    varianceAmount: 3200,
    relatedPo: "PO-2026-1282",
    relatedGrn: "GRN-202605-0419",
    reason: "匹配状态 存在差异，差异金额 ¥3,200",
  });
  assert.deepEqual(matches.data.topMatches[0], {
    matchId: "MATCH-INV-SZ-260601",
    invoice: "INV-SZ-260601",
    po: "PO-2026-1282",
    grn: "GRN-202605-0419",
    supplier: "深圳新元电气",
    status: "存在差异",
    varianceAmount: 3200,
    reason: "PO 金额与发票金额存在差异，需复核后处理。",
  });
  assert.deepEqual(boundary.data, {
    boundary: "当前 Alpha 仅展示财务协同可见性：不执行付款、不做会计过账、不处理税务申报，也不进行最终审批。",
    paymentExecution: "disabled",
    accountingPosting: "disabled",
    taxFiling: "disabled",
    finalApproval: "disabled",
  });
  assert.deepEqual(db, before);
});
