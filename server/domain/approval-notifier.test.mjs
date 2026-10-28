import test from "node:test";
import assert from "node:assert/strict";
import { approvalEmailsEnabled, createApprovalNotifier, findApprovalRecipients, notifyApprovalWaiting } from "../notifications/approval-notifier.mjs";

const tenantId = "tenant-approval-notice";
const submitter = { authenticated: true, tenantId, userId: "u-submitter" };
const env = {
  FLOWCHAIN_PUBLIC_BASE_URL: "https://flowchain.test",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "true",
};

const approver = (id, overrides = {}) => ({ id, email: `${id}@example.com`, languagePreference: null, warehouseScopes: [], ...overrides });

// A Prisma stand-in holding just the rows the notifier reads. user.findMany
// applies the filters the query asks the database for, so the tests check
// the query as well as the result.
function stubPrisma({ documents = {}, users = [], exceptions = [], tenant = { defaultLanguage: "en-US" } } = {}) {
  const calls = { userQueries: [], audits: [] };
  const byId = (rows) => ({ findFirst: async ({ where }) => (rows || []).find((row) => row.id === where.id && (!row.tenantId || row.tenantId === where.tenantId)) || null });
  return {
    calls,
    purchaseRequest: byId(documents.purchaseRequest),
    purchaseOrder: byId(documents.purchaseOrder),
    supplierInvoice: byId(documents.supplierInvoice),
    inventoryAdjustmentDocument: byId(documents.inventoryAdjustmentDocument),
    financeMatchException: {
      findFirst: async ({ where }) => exceptions.find((row) => row.id === where.id) || null,
      count: async ({ where }) => exceptions.filter((row) => row.supplierInvoiceId === where.supplierInvoiceId && where.status.in.includes(row.status)).length,
    },
    tenant: { findUnique: async () => tenant },
    user: {
      findMany: async (query) => {
        calls.userQueries.push(query);
        const { where } = query;
        const permission = where.roleAssignments.some.role.permissions.some.permissionCode;
        return users.filter((user) =>
          (user.status || "active") === where.status
          && (user.approvalEmailsEnabled ?? true) === where.approvalEmailsEnabled
          && (!where.id || user.id !== where.id.not)
          && (user.permissions || []).includes(permission));
      },
    },
    auditLog: { create: async ({ data }) => { calls.audits.push(data); return data; } },
  };
}

function recordingMailer({ fail = () => false } = {}) {
  const sent = [];
  return {
    sent,
    async send(message) {
      if (fail(message)) throw Object.assign(new Error("boom"), { code: "MAIL_DELIVERY_FAILED", provider: "postmark", status: 503, providerCode: "300" });
      sent.push(message);
      return { provider: "recorder", messageId: `m-${sent.length}` };
    },
  };
}

function captureLogger() {
  const lines = [];
  const push = (line) => lines.push(JSON.parse(line));
  return { lines, info: push, warn: push, error: push };
}

const notifier = ({ prisma, mailer = recordingMailer(), logger = captureLogger(), environment = env }) => ({
  mailer,
  logger,
  service: createApprovalNotifier({ env: environment, prismaFactory: async () => prisma, mailer, logger }),
});

test("a submitted PR emails each approver once, in their language, with only its type, number and link", async () => {
  const prisma = stubPrisma({
    documents: { purchaseRequest: [{ id: "PR-AB12", tenantId, status: "submitted", amount: "999.00", supplierName: "Globex" }] },
    users: [
      approver("u-manager-en", { permissions: ["procurement.purchase_order.approve"] }),
      approver("u-manager-zh", { languagePreference: "zh-CN", permissions: ["procurement.purchase_order.approve"] }),
      approver("u-submitter", { permissions: ["procurement.purchase_order.approve"] }),
      approver("u-opted-out", { approvalEmailsEnabled: false, permissions: ["procurement.purchase_order.approve"] }),
      approver("u-disabled", { status: "disabled", permissions: ["procurement.purchase_order.approve"] }),
      approver("u-viewer", { permissions: ["procurement.purchase_order.read"] }),
      approver("u-bad-address", { email: "not-an-email", permissions: ["procurement.purchase_order.approve"] }),
    ],
  });
  const { service, mailer, logger } = notifier({ prisma });
  const outcome = await service.documentWaiting({ identity: submitter, documentType: "purchase_request", documentId: "PR-AB12" }).delivery;

  assert.equal(outcome.status, "sent");
  assert.deepEqual(outcome.recipientUserIds, ["u-manager-en", "u-manager-zh"]);
  assert.deepEqual(mailer.sent.map((message) => [message.to, message.subject, message.tag]), [
    ["u-manager-en@example.com", "Purchase request PR-AB12 is waiting for approval", "approval-waiting"],
    ["u-manager-zh@example.com", "采购申请 PR-AB12 等待审批", "approval-waiting"],
  ]);
  for (const message of mailer.sent) {
    assert.ok(message.text.includes("https://flowchain.test/app/procurement/requests/PR-AB12"));
    assert.equal(/999|Globex/.test(`${message.text}${message.html}`), false);
  }
  const [query] = prisma.calls.userQueries;
  assert.equal(query.where.tenantId, tenantId);
  assert.deepEqual(query.where.id, { not: "u-submitter" });
  assert.deepEqual(query.where.roleAssignments, { some: { status: "active", role: { status: "active", permissions: { some: { permissionCode: "procurement.purchase_order.approve" } } } } });

  assert.equal(prisma.calls.audits.length, 1);
  const [audit] = prisma.calls.audits;
  assert.equal(audit.source, "approval_notifications");
  assert.equal(audit.action, "approval_email_sent");
  assert.equal(audit.actorId, null);
  assert.equal(audit.entityId, "PR-AB12");
  assert.deepEqual(audit.metadata.recipientUserIds, ["u-manager-en", "u-manager-zh"]);
  assert.deepEqual(audit.metadata.failedUserIds, []);
  assert.equal(JSON.stringify([audit, logger.lines]).includes("@example.com"), false, "audit and logs name users by id, never address");
});

test("a replayed or unrecognised command result sends nothing", () => {
  let calls = 0;
  const ctx = { identity: submitter, approvalNotifier: { documentWaiting: () => { calls += 1; return { delivery: Promise.resolve() }; } } };
  assert.equal(notifyApprovalWaiting(ctx, { id: "PR-1", idempotentReplay: true }, { documentType: "purchase_request", documentId: "PR-1" }), null);
  assert.equal(notifyApprovalWaiting(ctx, { id: "PR-1" }, { documentType: "purchase_request", documentId: "PR-1" }), null, "no replay flag: not known to be new");
  assert.equal(notifyApprovalWaiting(ctx, null, { documentType: "purchase_request", documentId: "PR-1" }), null);
  assert.equal(notifyApprovalWaiting({ identity: submitter }, { idempotentReplay: false }, { documentType: "purchase_request" }), null, "no notifier configured");
  assert.equal(calls, 0);
  assert.ok(notifyApprovalWaiting(ctx, { id: "PR-1", idempotentReplay: false }, { documentType: "purchase_request", documentId: "PR-1" }));
  assert.equal(calls, 1);
  const throwing = { identity: submitter, approvalNotifier: { documentWaiting: () => { throw new Error("broken"); } } };
  assert.equal(notifyApprovalWaiting(throwing, { idempotentReplay: false }, { documentType: "purchase_order" }), null, "never throws into the route");
});

test("a document that is no longer waiting, or another tenant's, sends nothing", async () => {
  const users = [approver("u-manager", { permissions: ["procurement.purchase_order.approve"] })];
  const prisma = stubPrisma({
    documents: {
      purchaseRequest: [{ id: "PR-DRAFT", tenantId, status: "draft" }, { id: "PR-OTHER", tenantId: "tenant-b", status: "submitted" }],
      purchaseOrder: [{ id: "PO-APPROVED", tenantId, status: "approved", metadata: {} }],
    },
    users,
  });
  const { service, mailer } = notifier({ prisma });
  for (const [documentType, documentId] of [["purchase_request", "PR-DRAFT"], ["purchase_request", "PR-OTHER"], ["purchase_request", "PR-MISSING"], ["purchase_order", "PO-APPROVED"]]) {
    const outcome = await service.documentWaiting({ identity: submitter, documentType, documentId }).delivery;
    assert.deepEqual(outcome, { status: "skipped", reason: "not_waiting" }, documentId);
  }
  assert.equal(mailer.sent.length, 0);
  assert.equal(prisma.calls.userQueries.length, 0);
  assert.equal(prisma.calls.audits.length, 0);
});

test("a PO uses its order number; a failing provider only logs, the delivery resolves, and the audit row lists who failed", async () => {
  const prisma = stubPrisma({
    documents: { purchaseOrder: [{ id: "po-uuid-1", tenantId, status: "pending_approval", metadata: { orderNumber: "PO-2026-0007" } }] },
    users: [
      approver("u-a", { permissions: ["procurement.purchase_order.approve"] }),
      approver("u-b", { permissions: ["procurement.purchase_order.approve"] }),
    ],
  });
  const mailer = recordingMailer({ fail: (message) => message.to.startsWith("u-b") });
  const { service, logger } = notifier({ prisma, mailer });
  const outcome = await service.documentWaiting({ identity: submitter, documentType: "purchase_order", documentId: "po-uuid-1" }).delivery;
  assert.equal(outcome.status, "sent");
  assert.deepEqual(outcome.recipientUserIds, ["u-a"]);
  assert.deepEqual(outcome.failedUserIds, ["u-b"]);
  assert.equal(mailer.sent[0].subject, "Purchase order PO-2026-0007 is waiting for approval");
  assert.ok(mailer.sent[0].text.includes("https://flowchain.test/app/procurement/orders/po-uuid-1"));
  const failed = logger.lines.find((line) => line.event === "approval_email_failed");
  assert.deepEqual(failed, { event: "approval_email_failed", documentType: "purchase_order", documentId: "po-uuid-1", userId: "u-b", provider: "postmark", status: 503, providerCode: "300", code: "MAIL_DELIVERY_FAILED" });
  assert.deepEqual(prisma.calls.audits[0].metadata.failedUserIds, ["u-b"]);

  const brokenLogger = captureLogger();
  const broken = createApprovalNotifier({ env, prismaFactory: async () => { throw Object.assign(new Error("db down"), { code: "P1001" }); }, mailer: recordingMailer(), logger: brokenLogger });
  const result = await broken.documentWaiting({ identity: submitter, documentType: "purchase_order", documentId: "po-uuid-1" }).delivery;
  assert.deepEqual(result, { status: "failed", reason: "error" });
  assert.equal(brokenLogger.lines[0].event, "approval_email_failed");
  assert.equal(brokenLogger.lines[0].code, "P1001");
});

test("an adjustment goes only to approvers with operate access to every warehouse on its lines", async () => {
  const prisma = stubPrisma({
    documents: { inventoryAdjustmentDocument: [{ id: "adj-1", tenantId, adjustmentNumber: "ADJ-0042", workflowStatus: "draft", postingStatus: "unposted", lines: [{ warehouseId: "wh-1" }, { warehouseId: "wh-2" }, { warehouseId: "wh-1" }] }] },
    users: [
      approver("u-both", { permissions: ["inventory.adjustment.approve"], warehouseScopes: [{ warehouseId: "wh-1", accessLevel: "operate" }, { warehouseId: "wh-2", accessLevel: "operate" }] }),
      approver("u-one", { permissions: ["inventory.adjustment.approve"], warehouseScopes: [{ warehouseId: "wh-1", accessLevel: "operate" }] }),
      approver("u-read", { permissions: ["inventory.adjustment.approve"], warehouseScopes: [{ warehouseId: "wh-1", accessLevel: "operate" }, { warehouseId: "wh-2", accessLevel: "read" }] }),
      approver("u-creator-only", { permissions: ["inventory.adjustment.create"], warehouseScopes: [{ warehouseId: "wh-1", accessLevel: "operate" }, { warehouseId: "wh-2", accessLevel: "operate" }] }),
    ],
  });
  const { service, mailer } = notifier({ prisma });
  const outcome = await service.documentWaiting({ identity: submitter, documentType: "inventory_adjustment", documentId: "adj-1" }).delivery;
  assert.deepEqual(outcome.recipientUserIds, ["u-both"]);
  assert.equal(mailer.sent[0].subject, "Inventory adjustment ADJ-0042 is waiting for approval");
  assert.ok(mailer.sent[0].text.includes("https://flowchain.test/app/inventory/adjustments/adj-1"));

  const ready = stubPrisma({ documents: { inventoryAdjustmentDocument: [{ id: "adj-2", tenantId, adjustmentNumber: "ADJ-0043", workflowStatus: "ready", postingStatus: "unposted", lines: [] }] } });
  assert.equal((await notifier({ prisma: ready }).service.documentWaiting({ identity: submitter, documentType: "inventory_adjustment", documentId: "adj-2" }).delivery).reason, "not_waiting");

  const direct = await findApprovalRecipients(prisma, { tenantId, permissionCode: "inventory.adjustment.approve", warehouseIds: ["wh-1"] });
  assert.deepEqual(direct.map((user) => user.id), ["u-both", "u-one", "u-read"]);
});

test("a bill is waiting when matched, or when no open or rejected match exception is left", async () => {
  const users = [approver("u-finance", { permissions: ["finance.supplier_invoice.approve"] })];
  const prisma = stubPrisma({
    documents: { supplierInvoice: [
      { id: "bill-matched", tenantId, status: "matched", invoiceNumber: "INV-881" },
      { id: "bill-exception", tenantId, status: "exception", invoiceNumber: null },
      { id: "bill-submitted", tenantId, status: "submitted", invoiceNumber: "INV-9" },
    ] },
    exceptions: [
      { id: "ex-1", supplierInvoiceId: "bill-exception", status: "approved" },
      { id: "ex-2", supplierInvoiceId: "bill-exception", status: "open" },
    ],
    users,
  });
  const { service, mailer } = notifier({ prisma });
  const matched = await service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", documentId: "bill-matched" }).delivery;
  assert.equal(matched.status, "sent");
  assert.equal(mailer.sent[0].subject, "Supplier invoice INV-881 is waiting for approval");
  assert.ok(mailer.sent[0].text.includes("https://flowchain.test/app/procurement/bills/bill-matched"));
  assert.equal((await service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", documentId: "bill-submitted" }).delivery).reason, "not_waiting");
  assert.equal((await service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", matchExceptionId: "ex-1" }).delivery).reason, "not_waiting", "one exception is still open");

  prisma.financeMatchException.count = async () => 0;
  const cleared = await service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", matchExceptionId: "ex-2" }).delivery;
  assert.equal(cleared.status, "sent");
  assert.equal(mailer.sent[1].subject, "Supplier invoice bill-exception is waiting for approval", "no invoice number: the id");

  const financeOff = notifier({ prisma, environment: { ...env, FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "false" } });
  assert.equal((await financeOff.service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", documentId: "bill-matched" }).delivery).reason, "capability_disabled");
});

test("the kill switch, a missing production origin and a workspace default of Chinese", async () => {
  assert.equal(approvalEmailsEnabled({}), true);
  for (const value of ["off", "OFF", "false", "0"]) assert.equal(approvalEmailsEnabled({ FLOWCHAIN_APPROVAL_EMAILS: value }), false);
  const prisma = stubPrisma({
    documents: { purchaseRequest: [{ id: "PR-ZH", tenantId, status: "submitted" }] },
    users: [approver("u-manager", { permissions: ["procurement.purchase_order.approve"] })],
    tenant: { defaultLanguage: "zh-CN" },
  });
  let factoryCalls = 0;
  const off = createApprovalNotifier({ env: { ...env, FLOWCHAIN_APPROVAL_EMAILS: "off" }, prismaFactory: async () => { factoryCalls += 1; return prisma; }, mailer: recordingMailer(), logger: captureLogger() });
  assert.deepEqual(await off.documentWaiting({ identity: submitter, documentType: "purchase_request", documentId: "PR-ZH" }).delivery, { status: "skipped", reason: "disabled" });
  assert.equal(factoryCalls, 0, "switched off: nothing is read");

  const production = notifier({ prisma, environment: { NODE_ENV: "production" } });
  const skipped = await production.service.documentWaiting({ identity: submitter, documentType: "purchase_request", documentId: "PR-ZH", req: { headers: { host: "localhost" } } }).delivery;
  assert.equal(skipped.reason, "public_base_url_missing");
  assert.equal(production.mailer.sent.length, 0);

  const chinese = notifier({ prisma });
  await chinese.service.documentWaiting({ identity: submitter, documentType: "purchase_request", documentId: "PR-ZH" }).delivery;
  assert.equal(chinese.mailer.sent[0].subject, "采购申请 PR-ZH 等待审批", "no personal preference: the workspace default");

  assert.equal((await chinese.service.documentWaiting({ identity: submitter, documentType: "sales_order", documentId: "SO-1" }).delivery).reason, "invalid_request");
  assert.equal((await chinese.service.documentWaiting({ identity: { authenticated: true }, documentType: "purchase_request", documentId: "PR-ZH" }).delivery).reason, "invalid_request");
});

test("an exception review that leaves another exception open, or rejects one, sends nothing", async () => {
  const prisma = stubPrisma({
    exceptions: [
      { id: "ex-approved", supplierInvoiceId: "bill-two", status: "approved" },
      { id: "ex-still-open", supplierInvoiceId: "bill-two", status: "open" },
      { id: "ex-rejected", supplierInvoiceId: "bill-other", status: "rejected" },
    ],
    users: [approver("u-finance", { permissions: ["finance.supplier_invoice.approve"] })],
  });
  prisma.supplierInvoice.findFirst = async ({ where }) => ({ "bill-two": { id: "bill-two", status: "exception", invoiceNumber: "INV-2" }, "bill-other": { id: "bill-other", status: "exception", invoiceNumber: "INV-3" } })[where.id] || null;
  const { service, mailer } = notifier({ prisma });
  const leftOpen = await service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", matchExceptionId: "ex-approved" }).delivery;
  assert.deepEqual(leftOpen, { status: "skipped", reason: "not_waiting" }, "another exception is still open");
  const rejected = await service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", matchExceptionId: "ex-rejected" }).delivery;
  assert.deepEqual(rejected, { status: "skipped", reason: "not_waiting" }, "a rejected exception blocks approval");
  const unknown = await service.documentWaiting({ identity: submitter, documentType: "supplier_invoice", matchExceptionId: "ex-missing" }).delivery;
  assert.deepEqual(unknown, { status: "skipped", reason: "not_waiting" });
  assert.equal(mailer.sent.length, 0);
  assert.equal(prisma.calls.userQueries.length, 0);
  assert.equal(prisma.calls.audits.length, 0);
});

test("a failed audit write after sending is logged as approval_email_audit_failed, not as a failed send", async () => {
  const prisma = stubPrisma({
    documents: { purchaseRequest: [{ id: "PR-AUDIT", tenantId, status: "submitted" }] },
    users: [approver("u-manager", { permissions: ["procurement.purchase_order.approve"] })],
  });
  prisma.auditLog.create = async () => { throw Object.assign(new Error("audit table locked"), { code: "P2034" }); };
  const { service, mailer, logger } = notifier({ prisma });
  const outcome = await service.documentWaiting({ identity: submitter, documentType: "purchase_request", documentId: "PR-AUDIT" }).delivery;
  assert.equal(outcome.status, "sent");
  assert.equal(outcome.audited, false);
  assert.equal(mailer.sent.length, 1);
  assert.deepEqual(logger.lines.map((line) => line.event), ["approval_email_sent", "approval_email_audit_failed"]);
  assert.deepEqual(logger.lines[1], { event: "approval_email_audit_failed", documentType: "purchase_request", documentId: "PR-AUDIT", recipientUserIds: ["u-manager"], failedUserIds: [], code: "P2034" });
  assert.equal(JSON.stringify(logger.lines).includes("@example.com"), false, "no address in the log");
});
