import { readTodayForReader, todayDecisions } from '../services/today-read-service.mjs'
import { AI_TOOL_LIMITS, aiToolPurchaseOrder, aiToolRef, defineAiTool } from './ai-read-tool-contract.mjs'

// The assistant's view of Today's decision items (docs/drafted-decisions-design.md
// §4.8): the same items, drafts and decisions the Today page shows, read the
// same way (server/services/today-read-service.mjs), so "what should I handle
// first?" and the welcome card agree with Today. The model reads compact
// rows: no email address and no contact name ever reach it. The chat's
// decision cards (show_decisions) fetch the full drafts themselves.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const number = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
const fold = (value) => text(value).toLowerCase()

const ENTITY_TYPES = Object.freeze({ reorder_now: 'item', purchase_order_overdue: 'purchase_order', purchase_request_to_convert: 'purchase_request' })

// What a draft prepares, in figures the answer may state.
function preparedOf(draft, today) {
  if (!draft) return null
  if (draft.type === 'purchase_request') {
    const lead = number(draft.supplier?.leadTimeDays)
    return {
      // The day an order placed today would arrive, by the recorded lead time.
      ...(lead !== null && lead >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? { arrivesIfOrderedToday: addDays(today, lead) } : {}),
      type: 'purchase_request',
      quantity: number(draft.quantity), unit: draft.unit || null, supplier: draft.supplier?.name || null,
      raisedToMinimum: Boolean(draft.raisedToMinimum), minimumOrderQuantity: number(draft.supplier?.minimumOrderQuantity), leadTimeDays: number(draft.supplier?.leadTimeDays),
      shortfall: number(draft.shortfall), position: number(draft.position), reorderPoint: number(draft.reorderPoint), orderByDate: draft.orderByDate || null,
      openRequests: array(draft.openRequests).map((request) => request.number),
    }
  }
  if (draft.type === 'supplier_follow_up') {
    return {
      type: 'supplier_follow_up',
      orderNumber: draft.orderNumber, supplier: draft.supplier?.name || null, dueDate: draft.dueDate || null, overdueDays: number(draft.overdueDays),
      linesStillToReceive: array(draft.lines).length + (Number(draft.moreLines) || 0),
      lines: array(draft.lines).slice(0, 5).map((line) => ({ sku: line.sku || null, remaining: number(line.remaining), unit: line.unit || null, promisedDate: line.promisedDate || null })),
      // Whether an address is on record for the send step; never the address.
      emailOnRecord: Boolean(text(draft.supplier?.email)),
    }
  }
  if (draft.type === 'purchase_orders_from_request') {
    return {
      type: 'purchase_orders_from_request',
      requestNumber: draft.number,
      orders: array(draft.orders).map((order) => ({ supplier: order.supplierName, currency: order.currency, lines: order.lines })),
      linesMissingData: array(draft.missing).length,
    }
  }
  return null
}

function rowOf(entry) {
  const row = entry.row || {}
  return {
    key: entry.key, kind: row.kind, label: row.label || row.recordId, name: row.name || null,
    date: row.date || null, dateKind: row.dateKind || null, overdueDays: Number(row.overdueDays) || 0,
    ref: aiToolRef(row.entityType || ENTITY_TYPES[row.kind], row.recordId, row.label || row.recordId),
  }
}

// The tool's result from the Today decisions (todayDecisions).
const addDays = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function decisionItemsResult(decisions, { include = 'waiting', limit = 10 } = {}, { today = null } = {}) {
  const waiting = array(decisions.waiting)
  const setAside = array(decisions.setAside)
  const take = Math.min(Math.max(Number(limit) || 10, 1), AI_TOOL_LIMITS.maxRows)
  return {
    // The person decides on each with their own click, in the card.
    canDecide: decisions.canDecide === true,
    supplierEmailOn: decisions.supplierEmail?.canSend === true,
    waitingTotal: waiting.length,
    setAsideTotal: setAside.length,
    ...(include !== 'set_aside' ? {
      waiting: waiting.slice(0, take).map((entry) => ({ ...rowOf(entry), returned: entry.returned === true, prepared: preparedOf(entry.draft, today) })),
    } : {}),
    ...(include !== 'waiting' ? {
      setAside: setAside.slice(0, take).map((entry) => ({
        ...rowOf(entry), decision: entry.decision, reasonCode: entry.reasonCode || null, note: entry.note ? text(entry.note).slice(0, AI_TOOL_LIMITS.text) : null,
        returnOn: entry.returnOn || null, decidedOn: entry.decidedOn || null, decidedBy: entry.decidedBy?.name || null,
        documentNumber: entry.documentNumber || null,
      })),
    } : {}),
  }
}

// Read through the request's own services when it carries them
// (aiReadServices, as the other read tools do in tests), else Today's read.
async function readDecisions(context) {
  const route = context?.routeContext
  if (!route) return { error: 'decisions_unavailable' }
  const injected = route.aiReadServices?.todayDecisions
  if (typeof injected === 'function') {
    const decisions = await injected()
    return decisions?.available ? { decisions } : { error: 'decisions_unavailable' }
  }
  try {
    const reader = await readTodayForReader(route)
    const decisions = await todayDecisions(route, reader)
    return decisions.available ? { decisions, reader } : { error: 'decisions_unavailable' }
  } catch {
    return { error: 'decisions_unavailable' }
  }
}

export const decisionItemsTool = defineAiTool({
  name: 'decision_items',
  description: 'The decisions waiting for this user on Today, each with the next step FlowChain prepared, and the ones set aside: the same items the Today page shows. Kinds: reorder_now (prepared: a purchase request with its supplier and quantity, the shortfall raised to the supplier\'s minimum order), purchase_order_overdue (prepared: a follow-up to the supplier with the lines still to receive) and purchase_request_to_convert (prepared: the purchase orders the approved request would make). waiting rows are ordered by date like Today; returned marks one that came back after being set aside. setAside rows say what was decided (not_now until returnOn, not_needed with a reasonCode, chased, accepted, covered by an open request), by whom and when. canDecide: whether this user may act on them; supplierEmailOn: whether a follow-up can be emailed from the card. Use it for "what should I handle first?" and what is waiting for a decision, then show_decisions to show the cards.',
  parameters: {
    include: { type: 'string', enum: ['waiting', 'set_aside', 'all'], description: 'waiting by default.' },
    limit: { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows, description: '10 by default.' },
  },
  available: (_facts, context) => Boolean(context?.routeContext && context.prisma && context.tenantId),
  assistantV2Only: true,
  async run(args, { context }) {
    const read = await readDecisions(context)
    if (read.error) return read
    return decisionItemsResult(read.decisions, args, { today: read.reader?.today || context.today || null })
  },
})

// The record a history question names: a purchase order by its number, an
// item by its SKU, or a purchase request by its number, among what the user
// may read.
function historyRecord(facts, query) {
  const po = facts.purchaseOrders ? aiToolPurchaseOrder(facts, query) : null
  if (po) return { entityType: 'purchase_order', recordId: po.id, label: po.orderNumber }
  const item = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)].find((row) => fold(row.sku) === fold(query))
  if (item?.itemId) return { entityType: 'item', recordId: item.itemId, label: item.sku }
  const request = [...array(facts.purchaseRequests?.open), ...array(facts.purchaseRequests?.rows)].find((row) => fold(row.number) === fold(query) || fold(row.id) === fold(query))
  if (request) return { entityType: 'purchase_request', recordId: request.id, label: request.number || request.id }
  return null
}

// A record's decision items and the follow-up emails sent on it, newest first.
function prismaHistory(prisma) {
  if (!prisma?.decisionItem) return null
  return {
    async read({ tenantId, recordId, entityType }) {
      const items = await prisma.decisionItem.findMany({
        where: { tenantId, recordId },
        include: { decidedBy: { select: { name: true } } },
        orderBy: { raisedAt: 'desc' },
        take: 10,
      })
      const emails = entityType === 'purchase_order'
        ? await prisma.auditLog.findMany({ where: { tenantId, entityType: 'purchase_order', entityId: recordId, action: 'supplier_follow_up_sent' }, select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 10 })
        : []
      return { items, emails }
    },
  }
}

const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null)

export const decisionHistoryTool = defineAiTool({
  name: 'decision_history',
  description: 'What was decided on one record on Today, newest first: each time it came up (raisedOn), what was decided (not_now, not_needed with a reasonCode, chased, accepted, covered), by whom and when, and how it ended (resolved when the record no longer needed it, expired when that happened before anyone decided). emailedOn lists the days a follow-up was emailed to the supplier. Use it for "did we chase PO-…?", "why isn\'t 22423 on Today?" or "who set this aside?".',
  parameters: {
    record: { type: 'string', description: 'A purchase order number, a SKU, or a purchase request number.' },
  },
  required: ['record'],
  available: (_facts, context) => Boolean(context?.prisma && context.tenantId),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const record = historyRecord(facts, args.record)
    if (!record) return { error: 'not_found' }
    const store = context.routeContext?.aiReadServices?.decisionHistory || prismaHistory(context.prisma)
    if (!store) return { error: 'decisions_unavailable' }
    const { items, emails } = await store.read({ tenantId: context.tenantId, recordId: String(record.recordId), entityType: record.entityType })
    return {
      record: { label: record.label, ref: aiToolRef(record.entityType, record.recordId, record.label) },
      items: items.map((item) => ({
        kind: item.kind, state: item.state, raisedOn: item.snapshot?.raisedOn || day(item.raisedAt),
        decision: item.decision || null, reasonCode: item.reasonCode || null, note: item.note ? text(item.note).slice(0, AI_TOOL_LIMITS.text) : null,
        decidedOn: item.snapshot?.decidedOn || day(item.decidedAt), decidedBy: item.decidedBy?.name || null, returnOn: item.returnOn || null,
        endedOn: day(item.resolvedAt),
      })),
      emailedOn: [...new Set(emails.map((row) => day(row.createdAt)))],
    }
  },
})
