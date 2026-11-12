import { randomUUID } from 'node:crypto'
import { decisionKey, decisionSnapshot } from '../domain/decision-items.mjs'

// Decision items in PostgreSQL (prisma DecisionItem; docs/drafted-decisions-design.md).
// Live items have activeKey "kind:recordId"; a resolved or expired item keeps
// its row with activeKey null as history. Each person's decision and reopen
// writes an AuditLog row in the same transaction.

const fail = (status, code, message, details = {}) => Object.assign(new Error(message), { status, code, ...details })

const LIVE_SELECT = { decidedBy: { select: { id: true, name: true } } }

export function createDecisionItemRepository({ prisma }) {
  const model = prisma.decisionItem

  async function listLive(tenantId) {
    return model.findMany({ where: { tenantId, activeKey: { not: null } }, include: LIVE_SELECT })
  }

  // Raises items for new rows, reopens decided items whose condition changed
  // and closes items whose row went away. Another reader may raise the same
  // key at the same moment; the unique index keeps one.
  async function applySync(tenantId, plan, { now = new Date(), today = null } = {}) {
    if (plan.create.length) {
      await model.createMany({
        data: plan.create.map((row) => ({
          id: randomUUID(), tenantId, activeKey: decisionKey(row), kind: row.kind, entityType: row.entityType, recordId: String(row.recordId),
          state: 'open', raisedAt: now, snapshot: { raisedOn: today, date: row.date || null },
        })),
        skipDuplicates: true,
      })
    }
    for (const item of plan.reopen) {
      await model.updateMany({
        where: { id: item.id, tenantId, state: 'decided' },
        data: { state: 'open', returnOn: null, snapshot: { ...(item.snapshot || {}), returnedOn: today, returnedFrom: item.decision } },
      })
    }
    for (const { item, state } of plan.close) {
      await model.updateMany({ where: { id: item.id, tenantId, activeKey: item.activeKey }, data: { state, activeKey: null, resolvedAt: now } })
    }
  }

  // The system records that an open request already covers a reorder item.
  async function markCovered(tenantId, item, request, { now = new Date(), today = null } = {}) {
    await model.updateMany({
      where: { id: item.id, tenantId, state: 'open' },
      data: {
        state: 'decided', decision: 'covered', decidedAt: now, decidedById: null, documentType: 'purchase_request', documentId: request.id,
        snapshot: { ...(item.snapshot || {}), decidedOn: today, documents: [request.id], documentNumber: request.number },
      },
    })
  }

  // The live item for a row, raised now if no read has raised it yet. A sync
  // raising the same key at the same moment wins the unique index; its row
  // is read instead.
  async function liveItem(tenantId, row, { now, today }) {
    const key = decisionKey(row)
    const found = await model.findFirst({ where: { tenantId, activeKey: key } })
    if (found) return found
    try {
      return await model.create({ data: { id: randomUUID(), tenantId, activeKey: key, kind: row.kind, entityType: row.entityType, recordId: String(row.recordId), state: 'open', raisedAt: now, snapshot: { raisedOn: today, date: row.date || null } } })
    } catch (error) {
      if (error?.code !== 'P2002') throw error
      return model.findFirst({ where: { tenantId, activeKey: key } })
    }
  }

  async function alreadyDecided(tenantId, id) {
    const current = await model.findFirst({ where: { tenantId, id }, include: LIVE_SELECT })
    return fail(409, 'DECISION_ALREADY_MADE', 'Someone has already decided on this. Reload Today to see who.', { decidedBy: current?.decidedBy?.name || null, decision: current?.decision || null })
  }

  // A person's decision on the live item for a row of their Today. Only an
  // open item takes a decision: of two people deciding at once, the second
  // gets 409 with the first one's name.
  async function decide(tenantId, actorId, row, parsed, { now = new Date(), today } = {}) {
    const item = await liveItem(tenantId, row, { now, today })
    if (item.state !== 'open') throw await alreadyDecided(tenantId, item.id)
    const documents = parsed.documentIds || []
    return prisma.$transaction(async (tx) => {
      const written = await tx.decisionItem.updateMany({
        where: { id: item.id, tenantId, state: 'open' },
        data: {
          state: 'decided', decision: parsed.decision, reasonCode: parsed.reasonCode, note: parsed.note, returnOn: parsed.returnOn,
          decidedAt: now, decidedById: actorId, documentType: parsed.documentType || null, documentId: documents[0] || null,
          snapshot: { ...(item.snapshot || {}), ...decisionSnapshot(row, today), ...(documents.length ? { documents } : {}) },
        },
      })
      if (written.count !== 1) throw await alreadyDecided(tenantId, item.id)
      const saved = await tx.decisionItem.findFirst({ where: { id: item.id, tenantId } })
      await tx.auditLog.create({ data: {
        id: randomUUID(), tenantId, source: 'today', module: 'today', action: 'decision_item_decided', entityType: row.entityType, entityId: String(row.recordId), actorId,
        summary: `Today: ${row.kind} ${parsed.decision}${parsed.reasonCode ? ` (${parsed.reasonCode})` : ''}`,
        metadata: { decisionItemId: item.id, kind: row.kind, decision: parsed.decision, reasonCode: parsed.reasonCode, returnOn: parsed.returnOn, documentType: parsed.documentType || null, documentIds: documents },
      } })
      return saved
    })
  }

  // Puts a set-aside item back among the open ones.
  async function reopen(tenantId, actorId, row, { now = new Date(), today } = {}) {
    const key = decisionKey(row)
    return prisma.$transaction(async (tx) => {
      const item = await tx.decisionItem.findFirst({ where: { tenantId, activeKey: key } })
      const notSetAside = () => fail(409, 'DECISION_NOT_SET_ASIDE', 'This is not set aside any more. Reload Today.')
      if (!item || item.state !== 'decided') throw notSetAside()
      const written = await tx.decisionItem.updateMany({
        where: { id: item.id, tenantId, state: 'decided' },
        data: { state: 'open', returnOn: null, snapshot: { ...(item.snapshot || {}), returnedOn: today, returnedFrom: item.decision, reopenedBy: actorId } },
      })
      if (written.count !== 1) throw notSetAside()
      const saved = await tx.decisionItem.findFirst({ where: { id: item.id, tenantId } })
      await tx.auditLog.create({ data: {
        id: randomUUID(), tenantId, source: 'today', module: 'today', action: 'decision_item_reopened', entityType: row.entityType, entityId: String(row.recordId), actorId,
        summary: `Today: ${row.kind} reopened`, metadata: { decisionItemId: item.id, kind: row.kind, previousDecision: item.decision, at: now.toISOString() },
      } })
      return saved
    })
  }

  async function findLive(tenantId, key) {
    return model.findFirst({ where: { tenantId, activeKey: key } })
  }

  // Whether every id names a document of that type in this workspace.
  async function documentsExist(tenantId, documentType, ids) {
    const table = documentType === 'purchase_order' ? prisma.purchaseOrder : documentType === 'purchase_request' ? prisma.purchaseRequest : null
    if (!table || !ids.length) return false
    return (await table.count({ where: { tenantId, id: { in: ids } } })) === ids.length
  }

  // The purchase orders a converted request records it made.
  async function ordersFromRequest(tenantId, requestId) {
    const request = await prisma.purchaseRequest.findFirst({ where: { tenantId, id: String(requestId) }, select: { status: true, linkedPoId: true, metadata: true } })
    if (!request) return []
    const linked = Array.isArray(request.metadata?.linkedPurchaseOrderIds) ? request.metadata.linkedPurchaseOrderIds : []
    return [...new Set([...linked, request.linkedPoId].map((id) => String(id ?? '').trim()).filter(Boolean))]
  }

  return { listLive, applySync, markCovered, decide, reopen, findLive, documentsExist, ordersFromRequest }
}
