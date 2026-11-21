import { AI_TOOL_LIMITS, aiStockSku, aiToolList, aiToolPurchaseOrder, aiToolRef, aiToolSupplier, defineAiTool } from './ai-read-tool-contract.mjs'
import { createInventoryAuthoritativeReadService } from './inventory-authoritative-read-service.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { supplierReplyRecordedDates } from './supplier-reply-outcome.mjs'
import { readRecordedReplyRevisions } from './supplier-reply-revisions.mjs'

// What happened to stock and to sales orders, for questions the assistant
// answered as "not recorded" though the app records them (design audit
// 2026-11-15, L5-04: "did SO-123 ship?", "why is 85123A 50 down since
// yesterday?"). Each reads through the app's own rules: stock movements
// through the inventory read service, which checks the reader's permission
// and warehouses itself; shipments with shipment.read, in the reader's
// warehouses. The descriptions stay short: every request carries them.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const can = (context, permission) => Boolean(context?.actor?.permissionCodes?.has?.(permission))
const number = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? 0 : Number(value))
const day = (value) => (value instanceof Date ? value.toISOString() : text(value)).slice(0, 10) || null
const daysParam = { type: 'integer', minimum: 1, maximum: 365 }
const limitParam = { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows }
const DEFAULT_DAYS = 30
const MOVEMENTS_READ = 200
const SHIPMENTS_READ = 200

// The movements of one item over the last days, newest first, with the
// totals in and out. The service reads at most 200; when all 200 fall in the
// window, the older ones are not read and the result says partial.
const stockMovements = defineAiTool({
  name: 'stock_movements',
  description: 'One SKU\'s stock movements in and out over the last days (default 30), with totals.',
  parameters: { sku: { type: 'string' }, days: daysParam },
  required: ['sku'],
  available: (facts, context) => Boolean(facts?.inventory) && Boolean(context?.actor && context.prisma) && can(context, 'inventory.balance.read'),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const found = aiStockSku(facts, args.sku)
    if (found.error) return found
    const days = args.days || DEFAULT_DAYS
    const from = addCalendarDays(text(facts.today), -days)
    const service = context.routeContext?.aiReadServices?.stockMovements || createInventoryAuthoritativeReadService({ prisma: context.prisma })
    const read = await service.listMovements({ sku: found.sku, sort: 'occurredAt', direction: 'desc', pageSize: MOVEMENTS_READ }, { identity: context.routeContext?.identity })
    const movements = array(read.movements)
    const inWindow = movements.filter((row) => day(row.occurredAt || row.date) > from)
    const totals = inWindow.reduce((sum, row) => ({ in: sum.in + number(row.quantityIn), out: sum.out + number(row.quantityOut), adjusted: sum.adjusted + number(row.adjustmentQty) }), { in: 0, out: 0, adjusted: 0 })
    return {
      sku: found.sku, days, from: addCalendarDays(from, 1), to: text(facts.today),
      totals: { ...totals, net: totals.in - totals.out + totals.adjusted, unit: inWindow[0]?.unit || null },
      ...(movements.length >= MOVEMENTS_READ && inWindow.length === movements.length ? { partial: { limit: MOVEMENTS_READ } } : {}),
      ...aiToolList(inWindow.map((row) => ({
        // One signed quantity: in less out plus any adjustment.
        date: day(row.occurredAt || row.date), type: text(row.movementType) || null, quantity: number(row.quantityIn) - number(row.quantityOut) + number(row.adjustmentQty),
        unit: text(row.unit) || null, documentNumber: text(row.sourceDocumentNumber || row.relatedSalesOrderNumber) || null, reason: text(row.reason) || null,
      })), args.limit),
    }
  },
})

// Posted shipments over the last days, or of one sales order, newest first,
// each with its lines; a reader limited to some warehouses sees the lines
// shipped from them.
const listShipments = defineAiTool({
  name: 'list_shipments',
  description: 'Posted shipments with their lines: of one sales order, or the last days (default 30).',
  parameters: { order: { type: 'string' }, sku: { type: 'string' }, days: daysParam },
  available: (_facts, context) => Boolean(context?.actor && context.prisma) && can(context, 'shipment.read'),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const { prisma, tenantId } = context
    let salesOrderId = null
    if (args.order) {
      const order = await prisma.salesOrder.findFirst({ where: { tenantId, orderNumber: text(args.order) }, select: { id: true } })
      if (!order) return { error: 'not_found' }
      salesOrderId = order.id
    }
    const days = args.days || DEFAULT_DAYS
    const from = addCalendarDays(text(facts.today), -days)
    const found = array(await prisma.shipmentDocument.findMany({
      where: { tenantId, postingStatus: { in: ['posted', 'reversed'] }, ...(salesOrderId ? { salesOrderId } : { postedAt: { gte: new Date(`${addCalendarDays(from, 1)}T00:00:00Z`) } }) },
      select: { id: true, shipmentNumber: true, postedAt: true, reversedAt: true, postingStatus: true, salesOrder: { select: { id: true, orderNumber: true, customerName: true } }, lines: { select: { sku: true, postedQuantity: true, unit: true, allocations: { select: { warehouseId: true } } } } },
      orderBy: [{ postedAt: 'desc' }, { id: 'asc' }],
      take: SHIPMENTS_READ + 1,
    }))
    const access = context.routeContext?.reportReadAccess || reportReadAccessFor(context.actor)
    const scope = Array.isArray(access?.warehouseIds) ? new Set(access.warehouseIds) : null
    const visibleLine = (line) => !scope || array(line.allocations).some((entry) => scope.has(text(entry.warehouseId)))
    const rows = found.slice(0, SHIPMENTS_READ).map((row) => ({ row, lines: array(row.lines).filter(visibleLine).filter((line) => !args.sku || fold(line.sku) === fold(args.sku)) }))
      .filter((entry) => entry.lines.length)
      .map(({ row, lines }) => ({
        shipment: text(row.shipmentNumber) || text(row.id), shipped: day(row.postedAt), salesOrder: text(row.salesOrder?.orderNumber) || null, customer: text(row.salesOrder?.customerName) || null,
        ...(row.reversedAt || text(row.postingStatus) === 'reversed' ? { reversed: true } : {}),
        lines: lines.map((line) => ({ sku: text(line.sku), quantity: number(line.postedQuantity), unit: text(line.unit) || null })),
        ref: aiToolRef('sales_order', row.salesOrder?.id || '', text(row.salesOrder?.orderNumber) || ''),
      }))
    // How many shipments and sales orders shipped each month of the window,
    // over every shipment, not the rows read (2026-11-20 question set: "how
    // many sales orders did we ship in October?" got "200 rows shown of
    // 3,380+, no total per month"). For a reader of every warehouse, without
    // a SKU; reversed shipments are not counted.
    // A scope that holds every warehouse of the workspace reads as all of them
    // (2026-11-21 live run: the walkthrough users have one scope row each, so
    // byMonth never came, and "can't give a count" was the answer).
    const everyWarehouse = !scope || await scopeHoldsEveryWarehouse(prisma, tenantId, scope)
    const byMonth = !salesOrderId && !args.sku && everyWarehouse ? await shipmentsByMonth(prisma, tenantId, { from, today: text(facts.today), timeZone: facts.timezone }) : null
    return {
      ...(salesOrderId ? { order: text(args.order) } : { days, from: addCalendarDays(from, 1), to: text(facts.today) }),
      ...(args.sku ? { sku: args.sku } : {}),
      ...(byMonth ? { byMonth } : {}),
      ...(found.length > SHIPMENTS_READ ? { partial: { limit: SHIPMENTS_READ } } : {}),
      ...aiToolList(rows, args.limit),
    }
  },
})

// Whether a set of warehouse ids holds every warehouse of the workspace.
async function scopeHoldsEveryWarehouse(prisma, tenantId, scope) {
  if (typeof prisma?.warehouse?.findMany !== 'function') return false
  const warehouses = await prisma.warehouse.findMany({ where: { tenantId }, select: { id: true } }).catch(() => null)
  return Array.isArray(warehouses) && warehouses.length > 0 && warehouses.every((row) => scope.has(text(row.id)))
}

// Posted shipments per calendar month of the workspace's time zone, from the
// day after `from` to today: { month, shipments, salesOrders } oldest first,
// with from and to on a month the window covers only part of (#433 review:
// with 30 days, "2026-10" held only 22–31 Oct and said nothing of it). null
// past SHIPMENT_MONTHS_READ rows or when the read fails.
const SHIPMENT_MONTHS_READ = 50000
async function shipmentsByMonth(prisma, tenantId, { from, today, timeZone }) {
  const start = addCalendarDays(from, 1)
  const rows = await prisma.shipmentDocument.findMany({
    // A day early, so a shipment posted late on the first day in a zone
    // ahead of UTC is read; the day check below keeps the window.
    where: { tenantId, postingStatus: 'posted', postedAt: { gte: new Date(`${addCalendarDays(start, -1)}T00:00:00Z`) } },
    select: { postedAt: true, salesOrderId: true },
    take: SHIPMENT_MONTHS_READ + 1,
  }).catch(() => null)
  if (!Array.isArray(rows) || rows.length > SHIPMENT_MONTHS_READ) return null
  let localDay
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: text(timeZone) || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    localDay = (value) => (value instanceof Date || value ? format.format(new Date(value)) : null)
  } catch {
    localDay = (value) => day(value)
  }
  const months = new Map()
  for (const row of rows) {
    const shipped = localDay(row.postedAt)
    if (!shipped || shipped < start || (today && shipped > today)) continue
    const month = shipped.slice(0, 7)
    if (!months.has(month)) months.set(month, { shipments: 0, orders: new Set() })
    const entry = months.get(month)
    entry.shipments += 1
    if (text(row.salesOrderId)) entry.orders.add(text(row.salesOrderId))
  }
  const lastDayOf = (month) => { const [year, number] = month.split('-').map(Number); return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}` }
  return [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, entry]) => {
    const monthFrom = start > `${month}-01` ? start : null
    const monthTo = today && today < lastDayOf(month) ? today : null
    return { month, shipments: entry.shipments, salesOrders: entry.orders.size, ...(monthFrom || monthTo ? { partial: true, from: monthFrom || `${month}-01`, to: monthTo || lastDayOf(month) } : {}) }
  })
}

// The audit log's names for each kind of record, as its writers spell them,
// and the permission that reads the record itself.
const HISTORY_KINDS = Object.freeze({
  purchase_order: { types: ['purchase_order', 'PurchaseOrder'], read: 'procurement.purchase_order.read' },
  sales_order: { types: ['SalesOrder', 'sales_order'], read: 'sales_order.read' },
  item: { types: ['item', 'inventory_item'], read: 'inventory.balance.read' },
  supplier: { types: ['supplier'], read: null },
})
const HISTORY_READ = 50

// The record the model named, among those the reader may read: a purchase
// order number, a sales order number, an SKU or a supplier, in that order. A
// purchase order, item or supplier is found in the reader's facts (already
// masked to them); a sales order needs sales_order.read. One argument instead
// of a kind and a record keeps the tool's text short: every request carries
// it. { kind, id, label } or { error }.
async function historyRecord(record, { facts, context }) {
  const allowed = (kind) => !HISTORY_KINDS[kind].read || can(context, HISTORY_KINDS[kind].read)
  const order = allowed('purchase_order') ? aiToolPurchaseOrder(facts, record) : null
  if (order) return { kind: 'purchase_order', id: text(order.id), label: text(order.orderNumber) || text(order.id), order }
  if (allowed('sales_order')) {
    const sale = await context.prisma.salesOrder.findFirst({ where: { tenantId: context.tenantId, OR: [{ id: text(record) }, { orderNumber: text(record) }] }, select: { id: true, orderNumber: true } })
    if (sale) return { kind: 'sales_order', id: sale.id, label: text(sale.orderNumber) || sale.id }
  }
  const stock = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)]
  const item = allowed('item') ? stock.find((row) => text(row.sku).toLowerCase() === text(record).toLowerCase() && row.itemId) : null
  if (item) return { kind: 'item', id: text(item.itemId), label: text(item.sku) }
  const found = aiToolSupplier(facts, record)
  if (found.supplier) return { kind: 'supplier', id: text(found.supplier.id), label: text(found.supplier.name) || text(found.supplier.id) }
  return found.error === 'supplier_ambiguous' ? { error: 'ambiguous', candidates: found.candidates } : { error: 'not_found' }
}

// Supplier replies on a purchase order's history (#363 §4.10: "What did Acme
// say about PO-0012?" is answered from the history, with no new tool). Their
// audit rows keep only codes ("…: proposed."), so each reply a row names is
// read here, at read time: the day it was received, per line the SKU with
// the day it gave or why it went to the person, the supplier's short quote,
// the dates recorded, and the decision with its reason. Values the reading
// gave that the reply does not hold (dropped lines) are left out. SKUs come
// from the order as the reader's facts hold it. supplierReplies counts the
// order's replies, so "none recorded" is said, not guessed.
//
// Each reply's details go once on a row the result shows (the first
// AI_TOOL_LIMITS.rows): its paste, else the newest shown row naming it. A
// reply named only by rows past those is listed in earlierReplies. The newest
// replies are given in detail up to REPLY_DETAIL_CHARS, so the result stays
// well under the tool result limit (24,000 characters); replyDetails says how
// many were (#400 review).
const REPLY_READ = AI_TOOL_LIMITS.items
const REPLY_DETAIL_CHARS = 8000
const SHOWN_ROWS = AI_TOOL_LIMITS.rows
const dayText = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10)) || null
const atText = (value) => (value instanceof Date ? value.toISOString() : text(value)).slice(0, 16) || null
const isReplyRow = (row) => text(row.action).startsWith('supplier_reply_') && Boolean(text(row.metadata?.replyId))
function replyLine(line, skuOf) {
  const sku = skuOf(line.purchaseOrderLineId) || text(line.ref) || null
  const dated = (line.outcome === 'proposed' || line.outcome === 'confirmed') && line.proposedDate
  return {
    sku,
    ...(dated ? { date: line.proposedDate, ...(line.outcome === 'confirmed' ? { unchanged: true } : {}) } : { issue: text(line.issue) || text(line.outcome) || null }),
    ...(!dated && Array.isArray(line.readings) && line.readings.length ? { readings: line.readings } : {}),
    ...(line.quote ? { quote: text(line.quote).slice(0, AI_TOOL_LIMITS.text) } : {}),
  }
}
// The details of the replies the rows name, newest first, as a Map by id.
async function supplierReplyDetails(ids, { context, found }) {
  if (!ids.length) return new Map()
  const replies = array(await context.prisma.supplierReply.findMany({
    where: { tenantId: context.tenantId, purchaseOrderId: found.id, id: { in: ids } },
    select: { id: true, receivedOn: true, source: true, state: true, readingStatus: true, check: true, decision: true, reasonCode: true, note: true, revisionIds: true },
  }))
  // The dates each recorded reply wrote, found as the reliability measure
  // finds them.
  const revisions = await readRecordedReplyRevisions(context.prisma, context.tenantId, replies)
  const lines = [...array(found.order?.openLines), ...array(found.order?.closedLines)]
  const skuOf = (lineId) => text(lines.find((line) => text(line.lineId) === text(lineId))?.sku) || null
  const byId = new Map(replies.map((reply) => {
    const dates = supplierReplyRecordedDates(revisions.filter((row) => row.replyId === reply.id))
    const recorded = [...dates].slice(0, AI_TOOL_LIMITS.items).map(([lineId, date]) => ({ sku: skuOf(lineId), date }))
    return [reply.id, {
      received: text(reply.receivedOn) || null,
      ...(text(reply.source) && reply.source !== 'paste' ? { source: reply.source } : {}),
      state: text(reply.state) || null,
      ...(reply.readingStatus && reply.readingStatus !== 'read' ? { read: text(reply.readingStatus) } : {}),
      lines: array(reply.check?.lines).filter((line) => line?.outcome !== 'dropped').slice(0, AI_TOOL_LIMITS.items).map((line) => replyLine(line, skuOf)),
      ...(recorded.length ? { recorded } : {}),
      ...(reply.decision ? { decision: { option: text(reply.decision), ...(reply.reasonCode ? { reason: text(reply.reasonCode) } : {}), ...(text(reply.note) ? { note: text(reply.note).slice(0, AI_TOOL_LIMITS.text) } : {}) } } : {}),
    }]
  }))
  return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)]))
}
// Where each reply's details go: { homes: row index -> id, earlier: [{ at,
// ...details }], detailed, of }. Newest replies first, within the budget.
function placeReplyDetails(rows, details) {
  const shown = Math.min(rows.length, SHOWN_ROWS)
  const homes = new Map()
  const earlier = []
  let used = 0
  let detailed = 0
  for (const [id, detail] of details) {
    const size = JSON.stringify(detail).length
    if (detailed && used + size > REPLY_DETAIL_CHARS) continue
    used += size
    detailed += 1
    const naming = [...rows.entries()].filter(([, row]) => isReplyRow(row) && text(row.metadata.replyId) === id)
    const paste = naming.find(([, row]) => row.action === 'supplier_reply_pasted')
    const home = paste && paste[0] < shown ? paste[0] : naming.find(([index]) => index < shown)?.[0]
    if (home !== undefined) homes.set(home, id)
    else earlier.push({ at: atText((paste || naming[0])[1].createdAt), ...detail })
  }
  return { homes, earlier, detailed }
}

// Who changed a record and when, newest first, from the audit log (design
// audit 2026-11-15, L5-04: "who moved PO-020's date?"). Needs audit.read, as
// the audit page does, and the record's own read permission; the before and
// after values need audit.read_sensitive, as there.
const recordHistory = defineAiTool({
  name: 'record_history',
  description: 'Who changed a PO, SO, SKU or supplier, and when.',
  parameters: { record: { type: 'string' } },
  required: ['record'],
  available: (_facts, context) => Boolean(context?.actor && context.prisma) && can(context, 'audit.read'),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const found = await historyRecord(args.record, { facts, context })
    if (found.error) return found
    const sensitive = can(context, 'audit.read_sensitive')
    const order = found.kind === 'purchase_order'
    const [read, supplierReplies] = await Promise.all([
      context.prisma.auditLog.findMany({
        where: { tenantId: context.tenantId, entityId: found.id, entityType: { in: HISTORY_KINDS[found.kind].types } },
        select: { createdAt: true, action: true, summary: true, metadata: true, actor: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: HISTORY_READ + 1,
      }),
      order ? context.prisma.supplierReply.count({ where: { tenantId: context.tenantId, purchaseOrderId: found.id, state: { not: 'superseded' } } }) : null,
    ])
    const rows = array(read).slice(0, HISTORY_READ)
    const named = [...new Set(rows.filter(isReplyRow).map((row) => text(row.metadata.replyId)))]
    const details = order ? await supplierReplyDetails(named.slice(0, REPLY_READ), { context, found }) : new Map()
    const { homes, earlier, detailed } = placeReplyDetails(rows, details)
    return {
      record: found.label,
      kind: found.kind,
      ref: aiToolRef(found.kind, found.id, found.label),
      ...(order ? { supplierReplies } : {}),
      ...(detailed < named.length ? { replyDetails: { detailed, of: named.length } } : {}),
      ...(earlier.length ? { earlierReplies: earlier } : {}),
      ...(array(read).length > HISTORY_READ ? { partial: { limit: HISTORY_READ } } : {}),
      ...aiToolList(rows.map((row, index) => {
        const before = row.metadata?.before, after = row.metadata?.after
        const reply = homes.has(index) ? details.get(homes.get(index)) : null
        return {
          at: atText(row.createdAt),
          action: text(row.action) || null, summary: text(row.summary).slice(0, AI_TOOL_LIMITS.text) || null, by: text(row.actor?.name) || null,
          ...(sensitive && (before !== undefined || after !== undefined) ? { before: before ?? null, after: after ?? null } : {}),
          ...(reply ? { reply } : {}),
        }
      })),
    }
  },
})

export const AI_ASSISTANT_V2_HISTORY_TOOLS = Object.freeze([stockMovements, listShipments, recordHistory])
