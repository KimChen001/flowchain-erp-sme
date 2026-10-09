import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_HISTORY_ACTIONS, handleApprovalHistoryRoute, listApprovalHistory } from "./approval-history.routes.mjs";

// A Prisma stand-in that records the audit query and answers number lookups.
function fakePrisma(rows) {
  const calls = [];
  return {
    calls,
    auditLog: { findMany: async (query) => (calls.push(query), rows) },
    purchaseOrder: { findMany: async ({ where }) => where.id.in.map((id) => ({ id, metadata: { orderNumber: `PO-NO-${id}` } })) },
    supplierInvoice: { findMany: async ({ where }) => where.id.in.map((id) => ({ id, invoiceNumber: `INV-${id}` })) },
  };
}

test("approval history lists only this person's decisions, with numbers and their reasons", async () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const prisma = fakePrisma([
    { id: "a1", action: "purchase_request_reject", entityId: "PR-1", createdAt: new Date("2026-10-09T10:00:00Z"), metadata: { reason: "Over budget" } },
    { id: "a2", action: "purchase_order_approve", entityId: "po-1", createdAt: new Date("2026-10-08T10:00:00Z"), metadata: { reason: null } },
    { id: "a3", action: "supplier_invoice_approved", entityId: "bill-1", createdAt: new Date("2026-10-07T10:00:00Z"), metadata: {} },
    { id: "a4", action: "purchase_order_return_for_revision", entityId: "po-2", createdAt: new Date("2026-10-06T10:00:00Z"), metadata: { reason: "Wrong supplier" } },
  ]);
  const items = await listApprovalHistory(prisma, { tenantId: "tenant", actorId: "user-1", days: 30, now });

  const [query] = prisma.calls;
  assert.equal(query.where.tenantId, "tenant");
  assert.equal(query.where.actorId, "user-1");
  assert.deepEqual(query.where.action.in, APPROVAL_HISTORY_ACTIONS);
  assert.equal(query.where.createdAt.gte.toISOString(), "2026-09-09T12:00:00.000Z");
  assert.deepEqual(items.map((item) => [item.documentType, item.documentNumber, item.decision, item.reason]), [
    ["purchase_request", "PR-1", "rejected", "Over budget"],
    ["purchase_order", "PO-NO-po-1", "approved", null],
    ["supplier_invoice", "INV-bill-1", "approved", null],
    ["purchase_order", "PO-NO-po-2", "returned", "Wrong supplier"],
  ]);
  // No amounts or suppliers: the record's page shows those under its own permissions.
  assert.equal(Object.hasOwn(items[0], "amount"), false);
});

test("approval history caps the window and the page size", async () => {
  const prisma = fakePrisma([]);
  await listApprovalHistory(prisma, { tenantId: "tenant", actorId: "user-1", days: 400, limit: 1000, now: new Date("2026-10-09T00:00:00Z") });
  assert.equal(prisma.calls[0].where.createdAt.gte.toISOString(), "2026-07-11T00:00:00.000Z");
  assert.equal(prisma.calls[0].take, 100);
});

test("approval history needs a signed-in person and ignores other paths", async () => {
  const sent = [];
  const ctx = (path, authenticated) => ({ req: { method: "GET" }, res: {}, url: new URL(`http://local${path}`), identity: { authenticated }, send: (_res, status, payload) => sent.push({ status, payload }) });
  assert.equal(await handleApprovalHistoryRoute(ctx("/api/me/profile", true)), false);
  assert.equal(await handleApprovalHistoryRoute(ctx("/api/me/approval-history", false)), true);
  assert.equal(sent[0].status, 401);
});

// An authorization context as resolveProvisionedActor builds it.
const actorWith = (...permissions) => ({ authenticated: true, complete: true, tenantId: "tenant", permissionCodes: new Set(permissions), roleIds: [] });
function countingPrisma() {
  const queries = [];
  return {
    queries,
    purchaseRequest: { count: async ({ where }) => (queries.push(["pr", where]), 2) },
    purchaseOrder: { count: async ({ where }) => (queries.push(["po", where]), 1) },
    supplierInvoice: {
      count: async ({ where }) => (queries.push(["bill", where]), 3),
      findMany: async () => [{ id: "bill-a" }, { id: "bill-b" }],
    },
    // bill-a still has an open exception, so only bill-b can be approved.
    financeMatchException: { findMany: async () => [{ supplierInvoiceId: "bill-a" }] },
  };
}

test("the waiting count follows the approve permissions and the bill capability", async () => {
  const { countWaitingApprovals } = await import("./approval-history.routes.mjs");
  const both = countingPrisma();
  const all = await countWaitingApprovals(both, { actor: actorWith("procurement.purchase_order.approve", "finance.supplier_invoice.approve"), env: { FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true" } });
  assert.deepEqual(all.byType, { purchaseRequests: 2, purchaseOrders: 1, supplierInvoices: 4 });
  assert.equal(all.count, 7);
  assert.deepEqual(both.queries.find(([kind]) => kind === "pr")[1], { tenantId: "tenant", status: "submitted" });
  assert.deepEqual(both.queries.find(([kind]) => kind === "po")[1], { tenantId: "tenant", status: "pending_approval" });

  const none = countingPrisma();
  assert.deepEqual(await countWaitingApprovals(none, { actor: actorWith("procurement.purchase_request.read"), env: {} }), { count: 0, byType: { purchaseRequests: 0, purchaseOrders: 0, supplierInvoices: 0 } });
  assert.equal(none.queries.length, 0);

  // Bills are left out while the bill capability is off.
  const off = countingPrisma();
  const procurementOnly = await countWaitingApprovals(off, { actor: actorWith("procurement.purchase_order.approve", "finance.supplier_invoice.approve"), env: {} });
  assert.equal(procurementOnly.byType.supplierInvoices, 0);
});
