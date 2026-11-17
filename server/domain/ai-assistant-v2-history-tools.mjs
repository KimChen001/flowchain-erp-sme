import { AI_TOOL_LIMITS, aiStockSku, aiToolList, aiToolPurchaseOrder, aiToolRef, aiToolSupplier, defineAiTool } from './ai-read-tool-contract.mjs'
import { createInventoryAuthoritativeReadService } from './inventory-authoritative-read-service.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'

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
    return {
      ...(salesOrderId ? { order: text(args.order) } : { days, from: addCalendarDays(from, 1), to: text(facts.today) }),
      ...(args.sku ? { sku: args.sku } : {}),
      ...(found.length > SHIPMENTS_READ ? { partial: { limit: SHIPMENTS_READ } } : {}),
      ...aiToolList(rows, args.limit),
    }
  },
})

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
  if (order) return { kind: 'purchase_order', id: text(order.id), label: text(order.orderNumber) || text(order.id) }
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
    const rows = array(await context.prisma.auditLog.findMany({
      where: { tenantId: context.tenantId, entityId: found.id, entityType: { in: HISTORY_KINDS[found.kind].types } },
      select: { createdAt: true, action: true, summary: true, metadata: true, actor: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: HISTORY_READ + 1,
    }))
    return {
      record: found.label,
      kind: found.kind,
      ref: aiToolRef(found.kind, found.id, found.label),
      ...(rows.length > HISTORY_READ ? { partial: { limit: HISTORY_READ } } : {}),
      ...aiToolList(rows.slice(0, HISTORY_READ).map((row) => {
        const before = row.metadata?.before, after = row.metadata?.after
        return {
          at: (row.createdAt instanceof Date ? row.createdAt.toISOString() : text(row.createdAt)).slice(0, 16) || null,
          action: text(row.action) || null, summary: text(row.summary).slice(0, AI_TOOL_LIMITS.text) || null, by: text(row.actor?.name) || null,
          ...(sensitive && (before !== undefined || after !== undefined) ? { before: before ?? null, after: after ?? null } : {}),
        }
      })),
    }
  },
})

export const AI_ASSISTANT_V2_HISTORY_TOOLS = Object.freeze([stockMovements, listShipments, recordHistory])
