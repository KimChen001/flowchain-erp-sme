import { randomUUID } from "node:crypto";
import { normalizeSignInEmail } from "../auth/email-link-sign-in.mjs";
import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { PURCHASE_ORDER_STATUS, PURCHASE_REQUEST_STATUS } from "../domain/procurement-status-authority.mjs";
import { effectiveLanguage } from "../domain/workspace-settings-contract.mjs";
import { APPROVAL_WAITING_TAG, buildApprovalWaitingEmail } from "../mail/approval-waiting-email.mjs";
import { createMailer } from "../mail/mailer.mjs";
import { publicBaseUrl } from "../mail/public-base-url.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

// Approval emails: when a document starts waiting for approval, the people
// who may approve it get an email that says so. People decide: the email
// carries the document type, its number and a link to its page, never an
// action, and FlowChain's approval lists stay the record of what waits.
//
// Sending starts after the command has committed and is never awaited by the
// request, so a slow or failing provider cannot fail or slow the command. It
// is best effort: a message still being sent when the server stops is lost.
// Recipients are read from the same role, permission and warehouse rows the
// approve command checks; nothing here changes them.
const text = (value) => String(value ?? "").trim();
const unique = (values) => [...new Set(values.map(text).filter(Boolean))];

export const APPROVAL_EMAILS_AUDIT_SOURCE = "approval_notifications";

export function approvalEmailsEnabled(env = process.env) {
  return !["off", "false", "0", "disabled"].includes(text(env.FLOWCHAIN_APPROVAL_EMAILS).toLowerCase());
}

// Per document type: the permission its approve command needs, the page the
// link opens, and whether the document is waiting now (re-read after commit).
const DOCUMENTS = Object.freeze({
  purchase_request: {
    permission: "procurement.purchase_order.approve",
    path: (id) => `/app/procurement/requests/${encodeURIComponent(id)}`,
    async load(prisma, { tenantId, documentId }) {
      const row = documentId ? await prisma.purchaseRequest.findFirst({ where: { id: documentId, tenantId }, select: { id: true, status: true } }) : null;
      return row?.status === PURCHASE_REQUEST_STATUS.SUBMITTED ? { id: row.id, number: row.id, warehouseIds: [] } : null;
    },
  },
  purchase_order: {
    permission: "procurement.purchase_order.approve",
    path: (id) => `/app/procurement/orders/${encodeURIComponent(id)}`,
    async load(prisma, { tenantId, documentId }) {
      const row = documentId ? await prisma.purchaseOrder.findFirst({ where: { id: documentId, tenantId }, select: { id: true, status: true, metadata: true } }) : null;
      return row?.status === PURCHASE_ORDER_STATUS.PENDING_APPROVAL ? { id: row.id, number: text(row.metadata?.orderNumber) || row.id, warehouseIds: [] } : null;
    },
  },
  // A bill can be approved once it is matched, or once every match exception
  // on it is approved: the approve command's own rule.
  supplier_invoice: {
    permission: "finance.supplier_invoice.approve",
    capability: "payable-obligation",
    path: (id) => `/app/procurement/bills/${encodeURIComponent(id)}`,
    async load(prisma, { tenantId, documentId, matchExceptionId }) {
      let invoiceId = documentId;
      if (!invoiceId && matchExceptionId) {
        const exception = await prisma.financeMatchException.findFirst({ where: { id: matchExceptionId, tenantId }, select: { supplierInvoiceId: true } });
        invoiceId = exception?.supplierInvoiceId;
      }
      const row = invoiceId ? await prisma.supplierInvoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, status: true, invoiceNumber: true } }) : null;
      if (!row || !["matched", "exception"].includes(row.status)) return null;
      if (row.status === "exception") {
        const blocking = await prisma.financeMatchException.count({ where: { supplierInvoiceId: row.id, status: { in: ["open", "rejected"] } } });
        if (blocking) return null;
      }
      return { id: row.id, number: text(row.invoiceNumber) || row.id, warehouseIds: [] };
    },
  },
  // An adjustment has no submit step: readying it is the approval, so it
  // waits from the moment it is created. Its approvers also need operate
  // access to every warehouse on its lines.
  inventory_adjustment: {
    permission: "inventory.adjustment.approve",
    capability: "inventory-adjustment-document",
    path: (id) => `/app/inventory/adjustments/${encodeURIComponent(id)}`,
    async load(prisma, { tenantId, documentId }) {
      const row = documentId ? await prisma.inventoryAdjustmentDocument.findFirst({ where: { id: documentId, tenantId }, select: { id: true, adjustmentNumber: true, workflowStatus: true, postingStatus: true, lines: { select: { warehouseId: true } } } }) : null;
      if (!row || row.workflowStatus !== "draft" || row.postingStatus !== "unposted") return null;
      return { id: row.id, number: text(row.adjustmentNumber) || row.id, warehouseIds: unique(row.lines.map((line) => line.warehouseId)) };
    },
  },
});

export const APPROVAL_NOTICE_DOCUMENT_TYPES = Object.freeze(Object.keys(DOCUMENTS));

// Active users of the tenant who chose approval emails, other than the person
// whose action started the wait, holding the permission through an active
// assignment of an active role (as resolveAuthorizationContext reads it),
// with operate access to every listed warehouse, and with a usable address.
export async function findApprovalRecipients(prisma, { tenantId, permissionCode, excludeUserId = null, warehouseIds = [] }) {
  const warehouses = unique(warehouseIds);
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      status: "active",
      approvalEmailsEnabled: true,
      ...(text(excludeUserId) ? { id: { not: text(excludeUserId) } } : {}),
      roleAssignments: { some: { status: "active", role: { status: "active", permissions: { some: { permissionCode } } } } },
    },
    select: { id: true, email: true, languagePreference: true, warehouseScopes: { select: { warehouseId: true, accessLevel: true } } },
    orderBy: { id: "asc" },
  });
  return users
    .filter((user) => {
      const operate = new Set((user.warehouseScopes || []).filter((scope) => scope.accessLevel === "operate").map((scope) => scope.warehouseId));
      return warehouses.every((warehouseId) => operate.has(warehouseId));
    })
    .filter((user) => normalizeSignInEmail(user.email))
    .map(({ id, email, languagePreference }) => ({ id, email, languagePreference }));
}

const languageFor = (user, tenant) => {
  try {
    return effectiveLanguage(user, tenant);
  } catch {
    // An unsupported stored preference falls back to US English.
    return "en-US";
  }
};

export function createApprovalNotifier({ env = process.env, prismaFactory = getPrismaClient, mailer = null, logger = console } = {}) {
  let resolvedMailer = mailer;
  const getMailer = () => (resolvedMailer ||= createMailer(env));
  const log = (level, entry) => logger[level]?.(JSON.stringify(entry));

  async function deliver({ tenantId, actorId, documentType, documentId, matchExceptionId, baseUrl }) {
    const spec = DOCUMENTS[documentType];
    if (spec.capability && !capabilityForEnvironment(spec.capability, env)?.enabled) return { status: "skipped", reason: "capability_disabled" };
    const prisma = await prismaFactory(env);
    const document = await spec.load(prisma, { tenantId, documentId: text(documentId), matchExceptionId: text(matchExceptionId) });
    if (!document) return { status: "skipped", reason: "not_waiting" };
    if (!baseUrl) {
      log("warn", { event: "approval_email_skipped", reason: "public_base_url_missing", documentType, documentId: document.id });
      return { status: "skipped", reason: "public_base_url_missing", documentId: document.id };
    }
    const recipients = await findApprovalRecipients(prisma, { tenantId, permissionCode: spec.permission, excludeUserId: actorId, warehouseIds: document.warehouseIds });
    if (!recipients.length) return { status: "skipped", reason: "no_recipients", documentId: document.id };
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLanguage: true } });
    const link = `${baseUrl}${spec.path(document.id)}`;
    const outcomes = await Promise.allSettled(recipients.map(async (user) => {
      const message = buildApprovalWaitingEmail({ language: languageFor(user, tenant), documentType, documentNumber: document.number, link });
      return getMailer().send({ to: user.email, ...message, tag: APPROVAL_WAITING_TAG });
    }));
    const recipientUserIds = [];
    const failedUserIds = [];
    outcomes.forEach((outcome, index) => {
      const userId = recipients[index].id;
      if (outcome.status === "fulfilled") {
        recipientUserIds.push(userId);
        log("info", { event: "approval_email_sent", documentType, documentId: document.id, userId, provider: outcome.value?.provider || null, messageId: outcome.value?.messageId || null });
        return;
      }
      failedUserIds.push(userId);
      const error = outcome.reason;
      log("error", { event: "approval_email_failed", documentType, documentId: document.id, userId, provider: error?.provider || null, status: error?.status || null, providerCode: error?.providerCode || null, code: error?.code || "MAIL_DELIVERY_FAILED" });
    });
    // One audit row per notice, naming people by user id only: who was sent
    // it and whose send failed. The sends are over by now, so a failed audit
    // write is logged as itself, not as a failed send.
    let audited = true;
    try {
      await prisma.auditLog.create({ data: {
        id: randomUUID(),
        tenantId,
        source: APPROVAL_EMAILS_AUDIT_SOURCE,
        module: "notifications",
        action: "approval_email_sent",
        entityType: "ApprovalEmail",
        entityId: document.id,
        actorId: null,
        summary: `Approval email for ${documentType} sent to ${recipientUserIds.length} of ${recipients.length} approvers.`,
        metadata: { documentType, documentId: document.id, triggeredById: actorId, recipientUserIds, failedUserIds },
      } });
    } catch (error) {
      audited = false;
      log("error", { event: "approval_email_audit_failed", documentType, documentId: document.id, recipientUserIds, failedUserIds, code: error?.code || "AUDIT_WRITE_FAILED" });
    }
    return { status: recipientUserIds.length ? "sent" : "failed", documentId: document.id, recipientUserIds, failedUserIds, audited };
  }

  // Returns at once. `delivery` settles when sending finishes and never
  // rejects; the request does not wait for it.
  function documentWaiting({ identity, documentType, documentId = null, matchExceptionId = null, req = null } = {}) {
    if (!approvalEmailsEnabled(env)) return { delivery: Promise.resolve({ status: "skipped", reason: "disabled" }) };
    const tenantId = text(identity?.tenantId);
    if (!DOCUMENTS[documentType] || !tenantId) return { delivery: Promise.resolve({ status: "skipped", reason: "invalid_request" }) };
    // Read while the request is still open; sending happens after it.
    const baseUrl = publicBaseUrl(env, req);
    const actorId = text(identity?.userId || identity?.id) || null;
    const delivery = Promise.resolve()
      .then(() => deliver({ tenantId, actorId, documentType, documentId, matchExceptionId, baseUrl }))
      .catch((error) => {
        log("error", { event: "approval_email_failed", documentType, documentId: text(documentId) || null, matchExceptionId: text(matchExceptionId) || null, code: error?.code || "APPROVAL_EMAIL_FAILED" });
        return { status: "failed", reason: "error" };
      });
    return { delivery };
  }

  return { documentWaiting };
}

// For routes, after the response is sent: tell the approvers, but only for a
// new execution. A replayed command (idempotentReplay true) sent its email
// the first time, so it sends nothing. Never throws and never waits.
export function notifyApprovalWaiting(ctx, result, target) {
  if (!ctx?.approvalNotifier || result?.idempotentReplay !== false) return null;
  try {
    return ctx.approvalNotifier.documentWaiting({ identity: ctx.identity, req: ctx.req, ...target });
  } catch {
    return null;
  }
}
