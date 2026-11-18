import { purchaseOrderLineRemaining, reportCalendarDay } from './open-purchase-order.mjs'
import { isPurchaseOrderPending, isPurchaseOrderReceivable } from './procurement-status-authority.mjs'

const rows = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const finite = value => value !== '' && value != null && Number.isFinite(Number(value))
const quantity = value => finite(value) ? Number(value) : null
const sumKnown = values => values.some(value => value === null) ? null : values.reduce((sum, value) => sum + value, 0)
const itemKey = row => text(row.sku || row.itemId || row.id)
const lineKey = line => text(line.sku || line.itemId || line.id)
// In transit is the unreceived remainder of a committed purchase order line
// (approved, issued or partially received), not the ordered quantity. Legacy
// ordered-quantity field names are read before the shared remaining helper.
const lineInTransit = line => purchaseOrderLineRemaining({
  orderedQuantity: line.orderedQuantity ?? line.quantityOrdered ?? line.orderedQty ?? line.quantity ?? line.qty,
  receivedQuantity: line.receivedQuantity ?? line.receivedQty,
})
// The unit an item's stock is kept in, as recorded on the item master: from
// the read context's itemUnits (every item a purchase order line names, read
// apart from the bounded item list), else the master's recordedUnit, else a
// plain item's unit fields. mapItem's baseUom and inventory balance rows fill
// a missing unit with the 'pcs' placeholder, so they are never read when a
// recorded unit is available.
function recordedUnitsOf(itemUnits) {
  const units = new Map()
  for (const row of rows(itemUnits)) {
    for (const key of [text(row.sku), text(row.itemId)]) if (key && !units.has(key)) units.set(key, text(row.unit))
  }
  return units
}
function stockUnitOf(units, sku, master) {
  if (units.has(sku)) return units.get(sku)
  if (master && Object.hasOwn(master, 'recordedUnit')) return text(master.recordedUnit)
  return text(master?.unit || master?.baseUom || master?.baseUnit)
}
const poLineUnit = line => text(line.unit || line.unitSnapshot)
const sameUnit = (a, b) => a.toLowerCase() === b.toLowerCase()
const salesOrderIsOpen = row => !['draft', 'cancelled', 'canceled'].includes(text(row.workflowStatus || row.status))

// Sales demand is booked per order line on that line's SKU. The order-level sku
// and quantities only summarise the first line and the order total, so a
// multi-line order must never be booked on its first SKU. Orders read without
// lines fall back to the order-level fields.
function salesDemandLines(order) {
  const lines = rows(order.lines)
  if (!lines.length) return [{ order, sku: itemKey(order), ordered: quantity(order.orderedQty ?? order.quantity ?? order.demandQty), fulfilled: quantity(order.fulfilledQty ?? order.shippedQty), reserved: quantity(order.reservedQty ?? order.reservedQuantity) }]
  return lines.map(line => ({
    order,
    sku: text(line.sku || line.itemId),
    ordered: quantity(line.orderedQuantity ?? line.orderedQty ?? line.quantity),
    fulfilled: quantity(line.fulfilledQuantity ?? line.fulfilledQty ?? line.shippedQty),
    reserved: quantity(line.reservedQuantity ?? line.reservedQty),
  }))
}

// Open sales demand per SKU, in the order the SKUs first appear on the
// orders. A line counts only on an open order (not draft or cancelled); each
// figure is null when a quantity it adds up is missing, as sumKnown leaves it.
//   openLines         the open orders' lines of the SKU
//   openDemand        sum of ordered - fulfilled, never below 0 per line
//   unreservedDemand  sum of ordered - fulfilled - reserved, never below 0 per line
//   reserved          sum of the lines' reservations
//   salesOrderIds     the open orders still to ship some of it, as listed
// The database read adds up the same figures over every order
// (summarizeDemandBySku in db-sales-order-read-repository.mjs).
export function salesDemandBySku(salesOrders) {
  const bySku = new Map()
  for (const line of rows(salesOrders).flatMap(salesDemandLines)) {
    if (!line.sku) continue
    if (!bySku.has(line.sku)) bySku.set(line.sku, { sku: line.sku, openLines: 0, openDemand: 0, unreservedDemand: 0, reserved: 0, orders: new Set() })
    if (!salesOrderIsOpen(line.order)) continue
    const entry = bySku.get(line.sku)
    const { ordered, fulfilled, reserved } = line
    entry.openLines += 1
    const known = ordered !== null && fulfilled !== null
    entry.openDemand = entry.openDemand === null || !known ? null : entry.openDemand + Math.max(0, ordered - fulfilled)
    entry.unreservedDemand = entry.unreservedDemand === null || !known ? null : entry.unreservedDemand + Math.max(0, ordered - fulfilled - (reserved ?? 0))
    entry.reserved = entry.reserved === null || reserved === null ? null : entry.reserved + reserved
    // The orders that still need this SKU: a line shipped in full is history,
    // not demand (a line with an unknown quantity stays, so it is reported).
    if (!known || ordered > fulfilled) entry.orders.add(line.order)
  }
  return [...bySku.values()].map(({ orders, ...entry }) => ({ ...entry, salesOrderIds: [...orders].map(order => text(order.salesOrderId || order.id)) }))
}

// What the model reads. A read context from the database carries
// allocationInputs (business-read-context-service.mjs): stock added up per SKU,
// every item, open demand added up per SKU and every committed purchase order,
// read over all of the workspace's records rather than the context's bounded
// lists (design audit 2026-11-15, L15). Other contexts use their own lists.
function inputsOf(context) {
  const inputs = context.allocationInputs
  if (inputs) {
    return {
      inventoryItems: rows(inputs.inventoryItems),
      items: rows(inputs.items),
      itemUnits: rows(inputs.itemUnits),
      purchaseOrders: rows(inputs.purchaseOrders),
      demand: rows(inputs.salesDemand),
      purchaseOrderKeys: rows(inputs.purchaseOrderKeys).map(text),
    }
  }
  const purchaseOrders = rows(context.purchaseOrders)
  return {
    inventoryItems: rows(context.inventoryItems),
    items: rows(context.items),
    itemUnits: rows(context.itemUnits),
    purchaseOrders,
    demand: salesDemandBySku(context.salesOrders),
    purchaseOrderKeys: purchaseOrders.flatMap(po => rows(po.lines).map(lineKey)),
  }
}

const NO_DEMAND = Object.freeze({ openLines: 0, openDemand: 0, unreservedDemand: 0, reserved: 0, salesOrderIds: [] })

function limitation(code, sku) { return sku ? `${code}:${sku}` : code }

export const STOCK_STATUSES = Object.freeze(['out_of_stock', 'below_safety_stock', 'below_reorder_point', 'ok', 'unknown'])

// An SKU at risk in the reports: open sales demand the available stock cannot
// cover. The inventory risk KPI counts these, and the assistant lists them.
export const isInventoryRiskSku = row => row?.shortage !== null && row?.shortage !== undefined && row.shortage > 0

// The item master holds the planning thresholds, and only it: a zero or
// missing value is none set. The balance rows' copies were added up as a
// fallback, so a reorder point set to 0 on purpose came back from old
// balance values, and the inventory page and the reorder list disagreed
// (design audit L3-21, L12-07).
function stockThreshold(masterValue) {
  const fromMaster = quantity(masterValue)
  return fromMaster !== null && fromMaster > 0 ? fromMaster : null
}

// Stable status codes; the client translates them. Stock on hand now is
// compared with the safety stock. The reorder point is compared with the
// inventory position (available + in transit - open demand, i.e. ATP), so an
// SKU already covered by open purchase orders is not flagged for reorder
// again. When ATP is unknown the available quantity is used.
function stockStatusFor({ available, availableToPromise, safetyStock, reorderPoint }) {
  if (available === null) return 'unknown'
  if (available <= 0) return 'out_of_stock'
  if (safetyStock !== null && available < safetyStock) return 'below_safety_stock'
  if (reorderPoint !== null && (availableToPromise ?? available) <= reorderPoint) return 'below_reorder_point'
  return 'ok'
}

// High means open sales demand the available stock cannot cover. Stock at or
// below the safety stock without unmet demand is medium, never low.
function riskLevelFor({ shortage, availableToPromise, stockStatus }) {
  if (shortage === null) return 'unknown'
  if (shortage > 0) return 'high'
  if (availableToPromise < 0 || ['out_of_stock', 'below_safety_stock'].includes(stockStatus)) return 'medium'
  return 'low'
}

export function buildRuntimeInventoryAllocation(context) {
  const inputs = inputsOf(context)
  const keys = new Set([
    ...inputs.inventoryItems.map(itemKey),
    ...inputs.demand.map(entry => text(entry.sku)),
    ...inputs.purchaseOrderKeys,
  ].filter(Boolean))
  const recordedUnits = recordedUnitsOf(inputs.itemUnits)
  const groupBy = (list, keyOf) => {
    const grouped = new Map()
    for (const row of list) {
      const key = keyOf(row)
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(row)
    }
    return grouped
  }
  const inventoryBySku = groupBy(inputs.inventoryItems, itemKey)
  const demandBySku = new Map(inputs.demand.map(entry => [text(entry.sku), entry]))
  const mastersBySku = groupBy(inputs.items, itemKey)
  // Every line of a committed purchase order (approved, issued or partially
  // received), by SKU, in the orders' order.
  const committedLinesBySku = groupBy(
    inputs.purchaseOrders.filter(po => isPurchaseOrderReceivable(po.status)).flatMap(po => rows(po.lines).map(line => ({ po, line }))),
    ({ line }) => lineKey(line),
  )
  // Every line of a draft or pending-approval purchase order, by SKU: on order
  // for the inventory position, apart from incoming (design audit C2).
  const pendingLinesBySku = groupBy(
    inputs.purchaseOrders.filter(po => isPurchaseOrderPending(po.status)).flatMap(po => rows(po.lines).map(line => ({ po, line }))),
    ({ line }) => lineKey(line),
  )

  const availability = [...keys].map(sku => {
    const inventoryRows = inventoryBySku.get(sku) || []
    const demand = demandBySku.get(sku) || NO_DEMAND
    const master = mastersBySku.get(sku)?.[0]
    const stockUnit = stockUnitOf(recordedUnits, sku, master)
    const dataLimitations = []
    // A fully received line is no longer supply; an unknown remainder stays so it is reported.
    // Incoming counts only lines in the item's stock unit: a line recorded in
    // another unit (a CASE line on an item kept in pcs) is listed in
    // incomingExcluded and never added. A line whose unit, or whose item's
    // unit, is not recorded is counted and the limitation says so.
    const poLines = []
    const incomingExcluded = []
    for (const { po, line } of committedLinesBySku.get(sku) || []) {
      if (lineInTransit(line) === 0) continue
      const unit = poLineUnit(line)
      if (unit && stockUnit && !sameUnit(unit, stockUnit)) {
        incomingExcluded.push({ purchaseOrderId: text(po.id || po.po), orderNumber: text(po.orderNumber || po.po || po.id), lineId: text(line.id), unit, remaining: lineInTransit(line) })
        continue
      }
      if (!unit || !stockUnit) dataLimitations.push(limitation('po_line_unit_not_recorded', sku))
      poLines.push({ po, line })
    }
    if (incomingExcluded.length) dataLimitations.push(limitation('po_line_unit_mismatch', sku))
    // Pending lines in the stock unit; a line in another unit is never added.
    const pendingLines = []
    for (const { po, line } of pendingLinesBySku.get(sku) || []) {
      const remaining = lineInTransit(line)
      if (remaining === 0) continue
      const unit = poLineUnit(line)
      if (unit && stockUnit && !sameUnit(unit, stockUnit)) continue
      pendingLines.push({ purchaseOrderId: text(po.id || po.po), orderNumber: text(po.orderNumber || po.po || po.id), status: text(po.status), remaining })
    }

    const onHandParts = inventoryRows.map(row => quantity(row.onHandQuantity ?? row.onHand ?? row.currentStock))
    const explicitReserved = inventoryRows.map(row => quantity(row.reservedQuantity ?? row.reservedQty))
    const incomingParts = poLines.map(({ line }) => lineInTransit(line))

    if (!inventoryRows.length) dataLimitations.push(limitation('inventory_balance_missing', sku))
    if (inventoryRows.length && onHandParts.includes(null)) dataLimitations.push(limitation('on_hand_quantity_missing', sku))
    if (demand.openDemand === null) dataLimitations.push(limitation('sales_demand_quantity_missing', sku))
    if (poLines.some((_, index) => incomingParts[index] === null)) dataLimitations.push(limitation('open_po_remaining_quantity_missing', sku))

    const onHand = inventoryRows.length ? sumKnown(onHandParts) : null
    // Inventory Runtime is authoritative for reserved when it exposes the field.
    // Otherwise reservation is read once from Sales Runtime; the two sources are never added together.
    const hasInventoryReserved = inventoryRows.some(row => finite(row.reservedQuantity ?? row.reservedQty))
    let reserved
    if (hasInventoryReserved) {
      reserved = explicitReserved.every(value => value !== null) ? sumKnown(explicitReserved) : null
      if (reserved === null) dataLimitations.push(limitation('reserved_quantity_incomplete', sku))
    } else if (demand.openLines) {
      reserved = demand.reserved
      if (reserved === null) dataLimitations.push(limitation('sales_reservation_quantity_missing', sku))
    } else {
      reserved = null
      if (inventoryRows.length) dataLimitations.push(limitation('reserved_quantity_missing', sku))
    }
    const available = onHand === null || reserved === null ? null : Math.max(0, onHand - reserved)
    const openSalesDemand = demand.openDemand
    // The part of each line's open demand its own reservation does not cover
    // yet. Reserved stock is already out of available, so demand it covers is
    // not set against available a second time.
    const unreservedSalesDemand = demand.unreservedDemand
    const incomingApprovedPo = sumKnown(incomingParts)
    const shortage = available === null || unreservedSalesDemand === null ? null : Math.max(0, unreservedSalesDemand - available)
    const availableToPromise = available === null || unreservedSalesDemand === null || incomingApprovedPo === null
      ? null
      : available + incomingApprovedPo - unreservedSalesDemand
    const safetyStock = stockThreshold(master?.safetyStock)
    const reorderPoint = stockThreshold(master?.reorderPoint)
    const stockStatus = stockStatusFor({ available, availableToPromise, safetyStock, reorderPoint })
    return {
      sku,
      itemId: text(master?.itemId || inventoryRows[0]?.itemId || sku),
      itemName: text(master?.itemName || master?.name || inventoryRows[0]?.itemName || inventoryRows[0]?.name || sku),
      onHand,
      reserved,
      available,
      openSalesDemand,
      unreservedSalesDemand,
      incomingApprovedPo,
      // The lines incomingApprovedPo adds up, each with the day it is due
      // (the line's promised date, else the order's expected date; '' when
      // neither is recorded), and the lines left out for their unit.
      incomingLines: poLines.map(({ po, line }) => ({ purchaseOrderId: text(po.id || po.po), orderNumber: text(po.orderNumber || po.po || po.id), lineId: text(line.id), remaining: lineInTransit(line), dueDay: reportCalendarDay(line.promisedDate || po.expectedDate) })),
      incomingExcluded,
      // Draft and pending-approval purchase order lines, and their total
      // (null when a remainder is unknown): on order, not yet committed.
      pendingPurchaseQty: sumKnown(pendingLines.map(line => line.remaining)),
      pendingLines,
      shortage,
      availableToPromise,
      safetyStock,
      reorderPoint,
      stockStatus,
      riskLevel: riskLevelFor({ shortage, availableToPromise, stockStatus }),
      salesOrderIds: rows(demand.salesOrderIds).map(text).filter(Boolean),
      purchaseOrderIds: poLines.map(({ po }) => text(po.id || po.po)).filter(Boolean),
      evidence: [
        ...rows(demand.salesOrderIds).map(text).map(id => ({ entityType: 'sales_order', entityId: id, canonicalRoute: `/app/sales/orders/${encodeURIComponent(id)}` })),
        ...poLines.map(({ po }) => ({ entityType: 'purchase_order', entityId: text(po.id || po.po), canonicalRoute: `/app/procurement/orders/${encodeURIComponent(text(po.id || po.po))}` })),
      ],
      dataLimitations: [...new Set(dataLimitations)],
    }
  })

  const knownShortages = availability.map(row => row.shortage).filter(value => value !== null)
  return {
    availability,
    allocation: availability,
    summary: {
      skuCount: availability.length,
      highRiskSkuCount: availability.filter(row => row.riskLevel === 'high').length,
      totalShortageQty: knownShortages.length === availability.length ? knownShortages.reduce((sum, value) => sum + value, 0) : null,
      reservedQty: availability.every(row => row.reserved !== null) ? availability.reduce((sum, row) => sum + row.reserved, 0) : null,
      incomingPurchaseQty: availability.every(row => row.incomingApprovedPo !== null) ? availability.reduce((sum, row) => sum + row.incomingApprovedPo, 0) : null,
      atpInsufficientSkuCount: availability.filter(row => row.availableToPromise !== null && row.availableToPromise < 0).length,
      stockStatusCounts: Object.fromEntries(STOCK_STATUSES.map(code => [code, availability.filter(row => row.stockStatus === code).length])),
    },
    risks: availability.filter(row => ['high', 'medium'].includes(row.riskLevel)),
    evidenceLinks: availability.flatMap(row => row.evidence),
    dataLimitations: [...new Set([...rows(context.dataLimitations), ...availability.flatMap(row => row.dataLimitations)])],
  }
}

export function getRuntimeSkuAvailability(model, sku) {
  const decoded = decodeURIComponent(text(sku))
  return model.availability.find(row => row.sku === decoded || row.itemId === decoded) || null
}
