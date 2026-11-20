import { isPurchaseOrderPending, isPurchaseOrderReceivable } from '../domain/procurement-status-authority.mjs'
import { buildRuntimeInventoryAllocation } from '../domain/runtime-inventory-allocation-read-model.mjs'
import { DEMAND_WINDOW_DAYS, dailyDemand, itemStockUnit } from '../domain/reorder-list.mjs'
import { recordedItemUnit } from '../repositories/db-master-data-repository.mjs'

// The stock line's inputs for a few SKUs only (the reply's), read narrowly
// rather than through the whole business context, and set out by the
// inventory page's own allocation model (buildRuntimeInventoryAllocation), so
// available stock, the reorder point, incoming and the unit rules are the
// page's:
//   - stock: balance rows of these SKUs in the reader's warehouses, added up
//     per SKU as loadAllocationStock adds them (db-inventory-read-repository.mjs);
//   - items: their records (reorder point, name, recorded unit);
//   - incoming: every committed or pending purchase order with a line of one
//     of them (as listCommittedPurchaseOrders reads, every warehouse);
//   - demand, for readers of sales orders: their lines on open sales orders
//     (not draft or cancelled, not shipped in full), each with the day
//     promised to the customer;
//   - the recorded rate: posted shipments of the last 90 days, one query for
//     them all, the reorder list's daily demand, unrounded; only for a reader
//     of every warehouse, as the reorder list and the assistant read it.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const number = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
const dayOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : /^\d{4}-\d{2}-\d{2}/.test(text(value)) ? text(value).slice(0, 10) : null)
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
const OPEN_EXCLUDED = ['draft', 'cancelled', 'canceled']

// warehouseIds: the reader's warehouses, or null for every warehouse.
export async function readSupplierReplyStockInputs({ prisma, tenantId, today, timeZone, skus, warehouseIds = null, salesOrdersVisible = false }) {
  const keys = [...new Set(array(skus).map(text).filter(Boolean))]
  if (!keys.length) return { items: [], incoming: [], demand: salesOrdersVisible ? [] : null, rates: new Map() }
  const scoped = Array.isArray(warehouseIds)
  const [balances, records, statuses, salesLines] = await Promise.all([
    prisma.inventoryBalance.findMany({
      where: { tenantId, sku: { in: keys }, ...(scoped ? { warehouseId: { in: warehouseIds } } : {}) },
      select: { sku: true, itemId: true, itemName: true, onHandQuantity: true, availableQuantity: true, reservedQuantity: true },
    }),
    prisma.item.findMany({ where: { tenantId, sku: { in: keys } } }),
    prisma.$queryRaw`SELECT DISTINCT status FROM "PurchaseOrder" WHERE "tenantId" = ${tenantId}`,
    salesOrdersVisible
      ? prisma.salesOrderLine.findMany({
        // Open orders still to ship, as countOrdersWithOpenDemand counts them.
        where: { sku: { in: keys }, salesOrder: { tenantId, workflowStatus: { notIn: OPEN_EXCLUDED }, fulfillmentStatus: { not: 'fully_fulfilled' } } },
        select: { sku: true, orderedQuantity: true, fulfilledQuantity: true, reservedQuantity: true, salesOrder: { select: { id: true, promisedDate: true } } },
      })
      : null,
  ])
  const open = array(statuses).map((row) => row.status).filter((status) => isPurchaseOrderReceivable(status) || isPurchaseOrderPending(status))
  const orders = open.length
    ? await prisma.purchaseOrder.findMany({
      where: { tenantId, status: { in: open }, lines: { some: { sku: { in: keys } } } },
      select: { id: true, status: true, expectedDate: true, lines: { where: { sku: { in: keys } }, select: { id: true, sku: true, itemId: true, orderedQuantity: true, receivedQuantity: true, unit: true, metadata: true } } },
    })
    : []

  // Stock added up per SKU, as loadAllocationStock adds the balance rows.
  const stock = new Map()
  for (const row of array(balances)) {
    const sku = text(row.sku)
    const entry = stock.get(sku) || { sku, itemId: text(row.itemId) || null, itemName: text(row.itemName) || null, onHandQuantity: 0, reservedQuantity: 0 }
    entry.onHandQuantity += number(row.onHandQuantity) ?? number(row.availableQuantity) ?? 0
    entry.reservedQuantity += number(row.reservedQuantity) ?? 0
    stock.set(sku, entry)
  }
  const salesDemand = salesLines ? demandSummary(salesLines) : []
  const allocation = buildRuntimeInventoryAllocation({
    allocationInputs: {
      inventoryItems: [...stock.values()],
      items: array(records).map((record) => ({ sku: text(record.sku), itemId: text(record.id), itemName: text(record.name), name: text(record.name), reorderPoint: record.reorderPoint, safetyStock: record.safetyStock, recordedUnit: recordedItemUnit(record) })),
      itemUnits: array(records).map((record) => ({ sku: text(record.sku), itemId: text(record.id), unit: recordedItemUnit(record) })),
      // The expected date as mapPo gives it (an ISO string): a line with no
      // promised date of its own falls back to it (reportCalendarDay).
      purchaseOrders: array(orders).map((po) => ({
        id: po.id, status: po.status, expectedDate: po.expectedDate?.toISOString?.() || po.expectedDate || null,
        lines: array(po.lines).map((line) => ({ id: line.id, sku: line.sku, itemId: line.itemId, orderedQuantity: String(line.orderedQuantity ?? ''), receivedQuantity: String(line.receivedQuantity ?? ''), unit: line.unit, promisedDate: line.metadata?.promisedDate || null })),
      })),
      salesDemand,
      purchaseOrderKeys: [],
    },
  })
  const unitBySku = new Map(array(records).map((record) => [text(record.sku), recordedItemUnit(record) || null]))
  const rows = allocation.availability.filter((row) => keys.includes(text(row.sku)))
  // The allocation's incoming is already in each item's stock unit.
  const items = rows.map((row) => ({ sku: row.sku, itemName: row.itemName, unit: unitBySku.get(text(row.sku)) || null, available: row.available, reorderPoint: row.reorderPoint }))
  const incoming = rows.flatMap((row) => array(row.incomingLines).map((line) => ({ lineId: line.lineId, purchaseOrderId: line.purchaseOrderId, sku: row.sku, unit: null, remaining: line.remaining, promisedDate: line.dueDay || null })))
  const demand = salesLines
    ? salesLines.map((line) => ({
      sku: text(line.sku),
      quantity: Math.max(0, (number(line.orderedQuantity) ?? 0) - (number(line.fulfilledQuantity) ?? 0) - (number(line.reservedQuantity) ?? 0)),
      promisedDate: dayOf(line.salesOrder?.promisedDate),
    }))
    : null
  const rates = scoped && !(await everyWarehouse(prisma, tenantId, warehouseIds)) ? new Map() : await recordedRates(prisma, { tenantId, today, timeZone, records })
  return { items, incoming, demand, rates }
}

// Open demand per SKU, as summarizeDemandBySku adds it up (only reservations
// matter here, for a SKU whose balance rows record none).
function demandSummary(lines) {
  const bySku = new Map()
  for (const line of lines) {
    const sku = text(line.sku)
    const entry = bySku.get(sku) || { sku, openLines: 0, openDemand: 0, unreservedDemand: 0, reserved: 0, salesOrderIds: [] }
    const ordered = number(line.orderedQuantity) ?? 0
    const fulfilled = number(line.fulfilledQuantity) ?? 0
    const reserved = number(line.reservedQuantity) ?? 0
    entry.openLines += 1
    entry.openDemand += Math.max(0, ordered - fulfilled)
    entry.unreservedDemand += Math.max(0, ordered - fulfilled - reserved)
    entry.reserved += reserved
    bySku.set(sku, entry)
  }
  return [...bySku.values()]
}

async function everyWarehouse(prisma, tenantId, warehouseIds) {
  const warehouses = array(await prisma.warehouse.findMany({ where: { tenantId }, select: { id: true } }))
  return warehouses.length > 0 && warehouses.every((row) => warehouseIds.includes(row.id))
}

// Average shipped per day over the reorder list's window, by SKU, from one
// query over the items' posted shipment lines; the exact shipped total over
// the window's days (dailyDemand's shippedUnits), not its rounded figure.
async function recordedRates(prisma, { tenantId, today, timeZone, records }) {
  const byId = new Map(array(records).map((record) => [text(record.id), record]))
  if (!byId.size || typeof prisma.shipmentLine?.findMany !== 'function') return new Map()
  const lines = array(await prisma.shipmentLine.findMany({
    where: { itemId: { in: [...byId.keys()] }, shipment: { tenantId, postingStatus: 'posted', postedAt: { gte: new Date(`${addDays(today, -DEMAND_WINDOW_DAYS - 1)}T00:00:00Z`), lt: new Date(`${addDays(today, 1)}T12:00:00Z`) } } },
    select: { itemId: true, unit: true, postedQuantity: true, shipment: { select: { postedAt: true } } },
  }))
  const rates = new Map()
  for (const [id, record] of byId) {
    const own = lines.filter((line) => text(line.itemId) === id).map((line) => ({ unit: line.unit, quantity: Number(line.postedQuantity), postedAt: line.shipment?.postedAt?.toISOString?.() || line.shipment?.postedAt || null }))
    const { shippedUnits } = dailyDemand({ lines: own, stockUnit: itemStockUnit(record), today, timeZone })
    if (shippedUnits) rates.set(text(record.sku), shippedUnits / DEMAND_WINDOW_DAYS / 10000)
  }
  return rates
}
