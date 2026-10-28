import assert from "node:assert/strict";
import test from "node:test";
import { handleOperationalFinanceRoute } from "./operational-finance.routes.mjs";
import { handleProcurementWorkflowRoute } from "./procurement-workflow.routes.mjs";

// Which route calls hand a document to the approval notifier: only the
// commands that start a wait, only on a new execution, and only after the
// answer. Previews, reads and other actions never do.
const identity = { authenticated: true, tenantId: "signed-tenant", userId: "signed-user", role: "manager" };

function notifierSpy() {
  const calls = [];
  return { calls, documentWaiting: (input) => { calls.push(input); return { delivery: Promise.resolve() }; } };
}

function financeContext({ path, method = "POST", command, notifier, body = { expectedVersion: 1, idempotencyKey: "k-1" } }) {
  const sent = [];
  const ctx = {
    req: { method, headers: {} },
    res: {},
    url: new URL(`http://localhost${path}`),
    env: { FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true" },
    identity,
    approvalNotifier: notifier,
    operationalFinancePrisma: {},
    operationalFinanceReadService: {},
    operationalFinanceCommandService: command,
    operationalFinanceO2cReadService: {},
    operationalFinanceO2cCommandService: {},
    internalSettlementReadService: {},
    internalSettlementCommandService: {},
    readBody: async () => body,
    send: (_res, status, payload) => { sent.push({ status, payload, notifiedBefore: notifier.calls.length }); },
  };
  return { ctx, sent };
}

const invoiceResult = (idempotentReplay, status = "matched") => ({ entityType: "SupplierInvoice", entityId: "bill-1", invoice: { id: "bill-1", status }, idempotentReplay });
const exceptionResult = (idempotentReplay) => ({ entityType: "FinanceMatchException", entityId: "ex-1", exception: { id: "ex-1", supplierInvoiceId: "bill-1", status: "approved" }, idempotentReplay });

test("a bill match notifies after answering; a match preview or a replayed match does not", async () => {
  const command = {
    previewMatchSupplierInvoice: async () => ({ allowed: true, blockingIssues: [] }),
    matchSupplierInvoice: async (_id, input) => invoiceResult(input.idempotencyKey === "replayed"),
  };
  const notifier = notifierSpy();

  const preview = financeContext({ path: "/api/finance/supplier-invoices/bill-1/match-preview", command, notifier });
  assert.equal(await handleOperationalFinanceRoute(preview.ctx), true);
  assert.equal(preview.sent[0].status, 200);
  assert.equal(notifier.calls.length, 0, "a preview never notifies");

  const match = financeContext({ path: "/api/finance/supplier-invoices/bill-1/match", command, notifier });
  assert.equal(await handleOperationalFinanceRoute(match.ctx), true);
  assert.equal(match.sent[0].status, 200);
  assert.equal(match.sent[0].notifiedBefore, 0, "the answer is sent first");
  assert.equal(notifier.calls.length, 1);
  assert.equal(notifier.calls[0].documentType, "supplier_invoice");
  assert.equal(notifier.calls[0].documentId, "bill-1");
  assert.equal(notifier.calls[0].identity, identity);

  const replay = financeContext({ path: "/api/finance/supplier-invoices/bill-1/match", command, notifier, body: { expectedVersion: 1, idempotencyKey: "replayed" } });
  await handleOperationalFinanceRoute(replay.ctx);
  assert.equal(replay.sent[0].status, 200);
  assert.equal(notifier.calls.length, 1, "a replayed match sends nothing");
});

test("an exception review hands over the exception; a review preview never notifies", async () => {
  const command = {
    previewReviewMatchException: async () => ({ allowed: true, blockingIssues: [] }),
    reviewMatchException: async (_id, input) => exceptionResult(input.idempotencyKey === "replayed"),
  };
  const notifier = notifierSpy();
  const body = { expectedVersion: 0, decision: "approved", resolution: "Price agreed", idempotencyKey: "k-review" };

  const preview = financeContext({ path: "/api/finance/match-exceptions/ex-1/review-preview", command, notifier, body });
  assert.equal(await handleOperationalFinanceRoute(preview.ctx), true);
  assert.equal(preview.sent[0].status, 200);
  assert.equal(notifier.calls.length, 0);

  const review = financeContext({ path: "/api/finance/match-exceptions/ex-1/review", command, notifier, body });
  await handleOperationalFinanceRoute(review.ctx);
  assert.equal(review.sent[0].status, 200);
  assert.deepEqual(notifier.calls.map(({ documentType, matchExceptionId, documentId }) => ({ documentType, matchExceptionId, documentId })), [{ documentType: "supplier_invoice", matchExceptionId: "ex-1", documentId: undefined }],
    "the notifier decides from the bill whether it now waits");

  const replay = financeContext({ path: "/api/finance/match-exceptions/ex-1/review", command, notifier, body: { ...body, idempotencyKey: "replayed" } });
  await handleOperationalFinanceRoute(replay.ctx);
  assert.equal(notifier.calls.length, 1);
});

test("other bill actions and a failed match never notify", async () => {
  const notifier = notifierSpy();
  const command = {
    submitSupplierInvoice: async () => invoiceResult(false, "submitted"),
    approveSupplierInvoice: async () => ({ ...invoiceResult(false, "approved"), payable: { id: "pay-1" } }),
    matchSupplierInvoice: async () => { throw Object.assign(new Error("changed"), { name: "AuthorizationError", status: 403, code: "AUTHORIZATION_PERMISSION_DENIED" }); },
  };
  for (const action of ["submit", "approve", "match"]) {
    const call = financeContext({ path: `/api/finance/supplier-invoices/bill-1/${action}`, command, notifier });
    await handleOperationalFinanceRoute(call.ctx);
    assert.ok(call.sent.length, action);
  }
  assert.equal(notifier.calls.length, 0);
});

function procurementContext({ path, method = "POST", notifier, requests = {}, orders = {}, body = { expectedVersion: 1, idempotencyKey: "k-1" } }) {
  const sent = [];
  return {
    sent,
    ctx: {
      req: { method, headers: {} },
      res: {},
      url: new URL(`http://localhost${path}`),
      env: {},
      identity,
      approvalNotifier: notifier,
      repositories: { procurementRequests: requests, procurementAuthority: orders },
      readBody: async () => body,
      send: (_res, status, payload) => { sent.push({ status, payload, notifiedBefore: notifier.calls.length }); },
    },
  };
}

test("only a PR or PO submit notifies, after answering, and not on a replay; reads and other actions never do", async () => {
  const notifier = notifierSpy();
  const requests = {
    transitionPurchaseRequest: async (id, action, input) => ({ id, status: action === "submit" ? "submitted" : action, idempotentReplay: input.idempotencyKey === "replayed" }),
    readPurchaseRequest: async (id) => ({ id, status: "submitted", lines: [] }),
  };
  const orders = {
    submitPurchaseOrder: async (id, input) => ({ entityType: "PurchaseOrder", entityId: id, status: "pending_approval", idempotentReplay: input.idempotencyKey === "replayed" }),
    approvePurchaseOrder: async (id) => ({ entityType: "PurchaseOrder", entityId: id, status: "approved", idempotentReplay: false }),
  };

  const submitted = procurementContext({ path: "/api/procurement/requests/PR-1/submit", notifier, requests });
  await handleProcurementWorkflowRoute(submitted.ctx);
  assert.equal(submitted.sent[0].status, 200);
  assert.equal(submitted.sent[0].notifiedBefore, 0, "the answer is sent first");
  assert.deepEqual(notifier.calls.map(({ documentType, documentId }) => [documentType, documentId]), [["purchase_request", "PR-1"]]);

  for (const path of ["/api/procurement/requests/PR-1/approve", "/api/procurement/requests/PR-1/withdraw"]) {
    const call = procurementContext({ path, notifier, requests });
    await handleProcurementWorkflowRoute(call.ctx);
    assert.equal(call.sent[0].status, 200, path);
  }
  const replayed = procurementContext({ path: "/api/procurement/requests/PR-1/submit", notifier, requests, body: { expectedVersion: 1, idempotencyKey: "replayed" } });
  await handleProcurementWorkflowRoute(replayed.ctx);
  const read = procurementContext({ path: "/api/procurement/requests/PR-1/path-recommendation", method: "GET", notifier, requests });
  await handleProcurementWorkflowRoute(read.ctx);
  assert.equal(notifier.calls.length, 1);

  const po = procurementContext({ path: "/api/procurement/orders/po-1/submit", notifier, orders, body: { expectedVersion: 0 } });
  await handleProcurementWorkflowRoute(po.ctx);
  assert.equal(po.sent[0].status, 200);
  assert.deepEqual(notifier.calls.slice(1).map(({ documentType, documentId }) => [documentType, documentId]), [["purchase_order", "po-1"]]);
  const approved = procurementContext({ path: "/api/procurement/orders/po-1/approve", notifier, orders, body: { expectedVersion: 1 } });
  await handleProcurementWorkflowRoute(approved.ctx);
  const replayedPo = procurementContext({ path: "/api/procurement/orders/po-1/submit", notifier, orders, body: { expectedVersion: 0, idempotencyKey: "replayed" } });
  await handleProcurementWorkflowRoute(replayedPo.ctx);
  assert.equal(notifier.calls.length, 2);
});
