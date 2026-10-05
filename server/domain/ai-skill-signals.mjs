// Attention signals over the skill facts (ai-skill-readers.mjs). Each signal is
// one reason one record needs attention. Signals hold codes and numbers only.
//
// Each signal carries the date that makes it urgent (`when`). Today's
// priorities and the supplier list are ordered by that date alone
// (compareSignalsByDate): what is past its date first, the longest overdue
// first; then what falls due within DUE_SOON_DAYS, the soonest first; then
// open problems by how long they have been open, the oldest first; then what
// has no date (stock below its levels); then what falls due later. Every
// answer line states that date, so the reader can check the order.
//
// The fixed scores below still order the highest-risk list and the drafts.
// They are versioned and need product sign-off. Ties break by record id so
// the order never depends on read order.

export const AI_SKILL_SIGNAL_VERSION = 'ai-skill-signals-v1'
export const AI_SKILL_SIGNAL_WEIGHTS = Object.freeze({
  po_overdue: 80, // plus one per day late, up to 20
  stock_shortage: 85,
  stock_below_safety: 75,
  invoice_variance: 70,
  stock_below_reorder: 60,
  grn_rejected_qty: 60,
  rfq_ready_to_award: 55,
  po_due_7d: 50,
  pr_awaiting_approval: 45, // plus 10 when the request is high priority
  po_partially_received: 40,
  grn_received_unposted: 35,
})
const OVERDUE_BONUS_CAP = 20
const HIGH_PRIORITY_BONUS = 10
export const DUE_SOON_DAYS = 7
// "Recent" for the supplier list's recent activity: the last 7 days, today included.
export const AI_SKILL_RECENT_DAYS = 7
const DAY = 86_400_000

const array = (value) => Array.isArray(value) ? value : []
const severityFor = (score) => score >= 70 ? 'risk' : score >= 50 ? 'warning' : 'info'
const areaFor = { purchase_order: 'purchasing', item: 'inventory', supplier_invoice: 'finance', purchase_request: 'purchasing', rfq: 'sourcing', receiving_doc: 'receiving' }
export const aiSkillDaysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)
const daysBetween = aiSkillDaysBetween
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))

// The date that makes a signal urgent, measured from the report day (asOf):
//   overdue  a date that has passed (days past it);
//   due      a date still ahead (days until it);
//   open     a problem that started on a date (days since);
//   undated  no date (stock below its levels).
export function aiSkillWhenDue(date, asOf) {
  if (!isDay(date) || !isDay(asOf)) return { kind: 'undated', days: null, date: null }
  const days = daysBetween(asOf, date)
  return days < 0 ? { kind: 'overdue', days: -days, date } : { kind: 'due', days, date }
}
export function aiSkillWhenOpen(date, asOf) {
  if (!isDay(date) || !isDay(asOf)) return { kind: 'undated', days: null, date: null }
  return { kind: 'open', days: Math.max(0, daysBetween(date, asOf)), date }
}
const UNDATED = Object.freeze({ kind: 'undated', days: null, date: null })

function signal(type, entityType, entityId, label, data, extra = {}) {
  const base = AI_SKILL_SIGNAL_WEIGHTS[type]
  const score = base + (extra.bonus || 0)
  return {
    id: `${type}:${entityId}`, type, score, severity: severityFor(score), entityType, entityId, label: label || entityId,
    area: areaFor[entityType], supplierId: extra.supplierId || null, supplier: extra.supplier || null,
    money: extra.money || null, data, when: extra.when || UNDATED,
  }
}

// Remaining quantity already on its way for a SKU: open purchase orders and
// purchase requests awaiting approval. A shortage they cover is labelled covered.
function projection(facts, sku, incoming) {
  const pendingRequests = array(facts.purchaseRequests?.awaitingApproval).filter((row) => row.sku === sku).reduce((sum, row) => sum + (row.quantity ?? 0), 0)
  return { incoming: incoming ?? null, pendingRequests }
}

export function buildAiSkillSignals(facts) {
  const signals = []
  const asOf = facts.asOf
  for (const po of array(facts.purchaseOrders?.rows)) {
    const common = { supplierId: po.supplierId, supplier: po.supplier, when: aiSkillWhenDue(po.dueDate, asOf) }
    const lineData = { remaining: po.remaining, unit: po.unit, sku: po.sku, itemId: po.itemId, openLines: po.openLines, dueDate: po.dueDate, supplier: po.supplier }
    // The report's own overdue days decide lateness, as in the reports.
    if (po.overdueDays > 0) signals.push(signal('po_overdue', 'purchase_order', po.id, po.orderNumber, { ...lineData, days: po.overdueDays }, { ...common, bonus: Math.min(OVERDUE_BONUS_CAP, po.overdueDays), when: { kind: 'overdue', days: po.overdueDays, date: po.dueDate || null } }))
    else if (po.dueDate && asOf && daysBetween(asOf, po.dueDate) >= 0 && daysBetween(asOf, po.dueDate) <= DUE_SOON_DAYS) signals.push(signal('po_due_7d', 'purchase_order', po.id, po.orderNumber, { ...lineData, days: daysBetween(asOf, po.dueDate) }, common))
    if (po.status === 'partially_received') signals.push(signal('po_partially_received', 'purchase_order', po.id, po.orderNumber, { ...lineData, received: po.received, ordered: po.ordered }, common))
  }
  for (const row of array(facts.inventory?.rows)) {
    const covered = projection(facts, row.sku, row.incomingApprovedPo)
    const data = { sku: row.sku, itemName: row.itemName, available: row.available, demand: row.openSalesDemand, shortage: row.shortage, incoming: row.incomingApprovedPo, atp: row.availableToPromise, safety: row.safetyStock, reorder: row.reorderPoint, pendingRequests: covered.pendingRequests, purchaseOrderIds: row.purchaseOrderIds }
    if (row.shortage !== null && row.shortage > 0) signals.push(signal('stock_shortage', 'item', row.itemId, row.sku, { ...data, covered: (row.incomingApprovedPo ?? 0) >= row.shortage }))
    if (['out_of_stock', 'below_safety_stock'].includes(row.stockStatus)) signals.push(signal('stock_below_safety', 'item', row.itemId, row.sku, { ...data, covered: row.safetyStock !== null && (row.available ?? 0) + (row.incomingApprovedPo ?? 0) + covered.pendingRequests >= row.safetyStock }))
    else if (row.stockStatus === 'below_reorder_point') signals.push(signal('stock_below_reorder', 'item', row.itemId, row.sku, { ...data, covered: false }))
  }
  for (const invoice of array(facts.invoices?.variances)) {
    signals.push(signal('invoice_variance', 'supplier_invoice', invoice.id, invoice.invoiceNumber, { variance: invoice.variance, currency: invoice.currency, supplier: invoice.supplier, poId: invoice.poId, status: invoice.status }, { supplierId: invoice.supplierId, supplier: invoice.supplier, money: invoice.variance === null ? null : { amount: Math.abs(invoice.variance), currency: invoice.currency }, when: aiSkillWhenOpen(invoice.invoiceDate, asOf) }))
  }
  for (const request of array(facts.purchaseRequests?.awaitingApproval)) {
    signals.push(signal('pr_awaiting_approval', 'purchase_request', request.id, request.id, { priority: request.priority, sku: request.sku, skus: request.skus, itemIds: request.itemIds, quantity: request.quantity, unit: request.unit, requiredDate: request.requiredDate }, { bonus: request.priority === 'high' ? HIGH_PRIORITY_BONUS : 0, when: aiSkillWhenDue(request.requiredDate, asOf) }))
  }
  for (const rfq of array(facts.rfqs?.readyToAward)) signals.push(signal('rfq_ready_to_award', 'rfq', rfq.id, rfq.id, { responses: rfq.responses, title: rfq.title }, { when: aiSkillWhenDue(rfq.due, asOf) }))
  for (const receipt of array(facts.receipts?.rejected)) signals.push(signal('grn_rejected_qty', 'receiving_doc', receipt.id, receipt.documentNumber, { rejected: receipt.rejected, unit: receipt.unit, supplier: receipt.supplier, poId: receipt.poId }, { supplierId: receipt.supplierId || null, supplier: receipt.supplier, when: aiSkillWhenOpen(receipt.arrivedDay, asOf) }))
  for (const receipt of array(facts.receipts?.unposted)) signals.push(signal('grn_received_unposted', 'receiving_doc', receipt.id, receipt.documentNumber, { poId: receipt.poId }, { supplierId: receipt.supplierId || null, supplier: receipt.supplier, when: aiSkillWhenOpen(receipt.arrivedDay, asOf) }))
  return signals.sort(compareSignals)
}

export function compareSignals(a, b) {
  return b.score - a.score || a.entityId.localeCompare(b.entityId) || a.type.localeCompare(b.type)
}

// Undated signals in a fixed order of what they mean: demand that cannot be
// met, then stock under its safety level, then at its reorder point.
const UNDATED_ORDER = ['stock_shortage', 'stock_below_safety', 'stock_below_reorder']
function dateBucket(when) {
  if (when?.kind === 'overdue') return 0
  if (when?.kind === 'due' && when.days <= DUE_SOON_DAYS) return 1
  if (when?.kind === 'open') return 2
  if (when?.kind === 'due') return 4
  return 3
}

// The order by date described at the top: no score is involved.
export function compareSignalsByDate(a, b) {
  const bucket = dateBucket(a.when) - dateBucket(b.when)
  if (bucket) return bucket
  const kind = a.when?.kind
  const days = kind === 'overdue' || kind === 'open' ? (b.when.days ?? 0) - (a.when.days ?? 0)
    : kind === 'due' ? (a.when.days ?? 0) - (b.when.days ?? 0)
      : (UNDATED_ORDER.includes(a.type) ? UNDATED_ORDER.indexOf(a.type) : 99) - (UNDATED_ORDER.includes(b.type) ? UNDATED_ORDER.indexOf(b.type) : 99)
  return days || a.entityId.localeCompare(b.entityId) || a.type.localeCompare(b.type)
}

// One entry per record, by date: its most urgent signal, with the others it
// also has.
export function rankAiSkillItemsByDate(signals) {
  const byEntity = new Map()
  for (const item of [...signals].sort(compareSignalsByDate)) {
    const key = `${item.entityType}:${item.entityId}`
    const existing = byEntity.get(key)
    if (existing) existing.also.push(item.type)
    else byEntity.set(key, { ...item, also: [] })
  }
  return [...byEntity.values()].sort(compareSignalsByDate).map((item, index) => ({ ...item, rank: index + 1 }))
}

// One entry per record: its strongest signal, with the others it also has.
export function rankAiSkillItems(signals) {
  const byEntity = new Map()
  for (const item of [...signals].sort(compareSignals)) {
    const key = `${item.entityType}:${item.entityId}`
    const existing = byEntity.get(key)
    if (existing) existing.also.push(item.type)
    else byEntity.set(key, { ...item, also: [] })
  }
  return [...byEntity.values()].sort(compareSignals).map((item, index) => ({ ...item, rank: index + 1 }))
}

export function countAiSkillSignals(signals) {
  return Object.fromEntries(Object.keys(AI_SKILL_SIGNAL_WEIGHTS).map((type) => [type, signals.filter((item) => item.type === type).length]))
}
