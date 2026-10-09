import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { can } from '../auth/authorization-service.mjs'
import { capabilityForEnvironment } from '../domain/capability-registry.mjs'

// GET /api/me/approvals-waiting: how many decisions wait for this person.
// GET /api/me/approval-history: the approval decisions the signed-in user
// made, newest first, for "Done by me" in the approval inbox. It reads the
// audit rows each approve or reject command writes, filtered to this actor,
// so a person only ever sees their own decisions. Amounts and suppliers are
// left out: the record's own page shows them under its read permissions.

// Audit action -> document type and decision.
const DECISIONS = Object.freeze({
  purchase_request_approve: ['purchase_request', 'approved'],
  purchase_request_reject: ['purchase_request', 'rejected'],
  purchase_order_approve: ['purchase_order', 'approved'],
  purchase_order_reject: ['purchase_order', 'rejected'],
  purchase_order_return_for_revision: ['purchase_order', 'returned'],
  supplier_invoice_approved: ['supplier_invoice', 'approved'],
})
export const APPROVAL_HISTORY_ACTIONS = Object.freeze(Object.keys(DECISIONS))

const text = (value) => String(value ?? '').trim()
const DAY_MS = 24 * 60 * 60 * 1000

export async function listApprovalHistory(prisma, { tenantId, actorId, days = 30, limit = 50, now = new Date() }) {
  const since = new Date(now.getTime() - Math.min(90, Math.max(1, Number(days) || 30)) * DAY_MS)
  const rows = await prisma.auditLog.findMany({
    where: { tenantId, actorId, action: { in: APPROVAL_HISTORY_ACTIONS }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, Number(limit) || 50)),
    select: { id: true, action: true, entityId: true, createdAt: true, metadata: true },
  })
  // Document numbers: an order's number lives in its metadata, a bill has
  // its supplier's invoice number; a request's id is its number.
  const ids = (type) => [...new Set(rows.filter((row) => DECISIONS[row.action][0] === type).map((row) => row.entityId))]
  const [orders, invoices] = await Promise.all([
    ids('purchase_order').length ? prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: ids('purchase_order') } }, select: { id: true, metadata: true } }) : [],
    ids('supplier_invoice').length ? prisma.supplierInvoice.findMany({ where: { tenantId, id: { in: ids('supplier_invoice') } }, select: { id: true, invoiceNumber: true } }) : [],
  ])
  const numbers = new Map([
    ...orders.map((row) => [row.id, text(row.metadata?.orderNumber) || row.id]),
    ...invoices.map((row) => [row.id, text(row.invoiceNumber) || row.id]),
  ])
  return rows.map((row) => {
    const [documentType, decision] = DECISIONS[row.action]
    return {
      id: row.id,
      documentType,
      documentId: row.entityId,
      documentNumber: numbers.get(row.entityId) || row.entityId,
      decision,
      decidedAt: row.createdAt.toISOString(),
      // The person's own reason for a rejection or a return.
      reason: text(row.metadata?.reason) || null,
    }
  })
}

// How many documents wait for a decision this person can make: the count on
// the phone's Approvals tab. The same rules as the approval emails
// (server/notifications/approval-notifier.mjs): a submitted purchase request
// or an order pending approval for holders of the order approve permission;
// a matched bill, or an exception bill with no open or rejected exception,
// for holders of the bill approve permission while bills are switched on.
export async function countWaitingApprovals(prisma, { actor, env = process.env }) {
  const tenantId = actor.tenantId
  const allowed = (permission) => can({ actor, permission, tenantId })
  const procurement = allowed('procurement.purchase_order.approve')
  const bills = allowed('finance.supplier_invoice.approve') && Boolean(capabilityForEnvironment('payable-obligation', env)?.enabled)
  const [requests, orders, matched, exceptionBills] = await Promise.all([
    procurement ? prisma.purchaseRequest.count({ where: { tenantId, status: 'submitted' } }) : 0,
    procurement ? prisma.purchaseOrder.count({ where: { tenantId, status: 'pending_approval' } }) : 0,
    bills ? prisma.supplierInvoice.count({ where: { tenantId, status: 'matched' } }) : 0,
    bills ? prisma.supplierInvoice.findMany({ where: { tenantId, status: 'exception' }, select: { id: true } }) : [],
  ])
  const blocked = exceptionBills.length
    ? new Set((await prisma.financeMatchException.findMany({
      where: { supplierInvoiceId: { in: exceptionBills.map((row) => row.id) }, status: { in: ['open', 'rejected'] } },
      select: { supplierInvoiceId: true },
    })).map((row) => row.supplierInvoiceId))
    : new Set()
  const supplierInvoices = matched + exceptionBills.filter((row) => !blocked.has(row.id)).length
  return { count: requests + orders + supplierInvoices, byType: { purchaseRequests: requests, purchaseOrders: orders, supplierInvoices } }
}

export async function handleApprovalHistoryRoute(ctx) {
  const history = ctx.url.pathname === '/api/me/approval-history'
  const waiting = ctx.url.pathname === '/api/me/approvals-waiting'
  if (ctx.req.method !== 'GET' || (!history && !waiting)) return false
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' })
    return true
  }
  const prisma = await getPrismaClient(ctx.env || process.env)
  const actor = await resolveProvisionedActor(prisma, ctx.identity)
  if (waiting) {
    ctx.send(ctx.res, 200, await countWaitingApprovals(prisma, { actor, env: ctx.env || process.env }))
    return true
  }
  const items = await listApprovalHistory(prisma, {
    tenantId: actor.tenantId,
    actorId: actor.user.id,
    days: ctx.url.searchParams.get('days') || 30,
    limit: ctx.url.searchParams.get('limit') || 50,
  })
  ctx.send(ctx.res, 200, { items })
  return true
}
