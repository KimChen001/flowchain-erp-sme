import assert from "node:assert/strict";
import test from "node:test";
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

