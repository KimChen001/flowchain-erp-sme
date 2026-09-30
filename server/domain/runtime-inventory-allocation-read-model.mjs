import { purchaseOrderLineRemaining } from './open-purchase-order.mjs'
import { isPurchaseOrderReceivable } from './procurement-status-authority.mjs'

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

function limitation(code, sku) { return sku ? `${code}:${sku}` : code }

export const STOCK_STATUSES = Object.freeze(['out_of_stock', 'below_safety_stock', 'below_reorder_point', 'ok', 'unknown'])

// An SKU at risk in the reports: open sales demand the available stock cannot
// cover. The inventory risk KPI counts these, and the assistant lists them.
export const isInventoryRiskSku = row => row?.shortage !== null && row?.shortage !== undefined && row.shortage > 0

// The item master holds the planning thresholds. A zero or missing master value
// means none is set there, so the inventory balance rows' values are used.
function stockThreshold(masterValue, inventoryRows, field) {
  const fromMaster = quantity(masterValue)
  if (fromMaster !== null && fromMaster > 0) return fromMaster
  const fromBalances = inventoryRows.map(row => quantity(row[field])).filter(value => value !== null && value > 0)
  return fromBalances.length ? fromBalances.reduce((sum, value) => sum + value, 0) : null
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
  const demandLines = rows(context.salesOrders).flatMap(salesDemandLines)
  const keys = new Set([
    ...rows(context.inventoryItems).map(itemKey),
    ...demandLines.map(line => line.sku),
    ...rows(context.purchaseOrders).flatMap(po => rows(po.lines).map(lineKey)),
  ].filter(Boolean))

  const availability = [...keys].map(sku => {
    const inventoryRows = rows(context.inventoryItems).filter(row => itemKey(row) === sku)
    const skuDemand = demandLines.filter(line => line.sku === sku && salesOrderIsOpen(line.order))
    const salesOrders = [...new Set(skuDemand.map(line => line.order))]
    const committedPos = rows(context.purchaseOrders).filter(po => isPurchaseOrderReceivable(po.status))
    // A fully received line is no longer supply; an unknown remainder stays so it is reported.
    const poLines = committedPos.flatMap(po => rows(po.lines).filter(line => lineKey(line) === sku && lineInTransit(line) !== 0).map(line => ({ po, line })))
    const dataLimitations = []

    const onHandParts = inventoryRows.map(row => quantity(row.onHandQuantity ?? row.onHand ?? row.currentStock))
    const explicitReserved = inventoryRows.map(row => quantity(row.reservedQuantity ?? row.reservedQty))
    const salesReserved = skuDemand.map(line => line.reserved)
    const openDemandParts = skuDemand.map(({ ordered, fulfilled }) => ordered === null || fulfilled === null ? null : Math.max(0, ordered - fulfilled))
    const incomingParts = poLines.map(({ line }) => lineInTransit(line))

    if (!inventoryRows.length) dataLimitations.push(limitation('inventory_balance_missing', sku))
    if (inventoryRows.length && onHandParts.includes(null)) dataLimitations.push(limitation('on_hand_quantity_missing', sku))
    if (openDemandParts.includes(null)) dataLimitations.push(limitation('sales_demand_quantity_missing', sku))
    if (poLines.some((_, index) => incomingParts[index] === null)) dataLimitations.push(limitation('open_po_remaining_quantity_missing', sku))

    const onHand = inventoryRows.length ? sumKnown(onHandParts) : null
    // Inventory Runtime is authoritative for reserved when it exposes the field.
    // Otherwise reservation is read once from Sales Runtime; the two sources are never added together.
    const hasInventoryReserved = inventoryRows.some(row => finite(row.reservedQuantity ?? row.reservedQty))
    let reserved
    if (hasInventoryReserved) {
      reserved = explicitReserved.every(value => value !== null) ? sumKnown(explicitReserved) : null
      if (reserved === null) dataLimitations.push(limitation('reserved_quantity_incomplete', sku))
    } else if (salesOrders.length) {
      reserved = salesReserved.every(value => value !== null) ? sumKnown(salesReserved) : null
      if (reserved === null) dataLimitations.push(limitation('sales_reservation_quantity_missing', sku))
    } else {
      reserved = null
      if (inventoryRows.length) dataLimitations.push(limitation('reserved_quantity_missing', sku))
    }
    const available = onHand === null || reserved === null ? null : Math.max(0, onHand - reserved)
    const openSalesDemand = sumKnown(openDemandParts)
    const incomingApprovedPo = sumKnown(incomingParts)
    const shortage = available === null || openSalesDemand === null ? null : Math.max(0, openSalesDemand - available)
    const availableToPromise = available === null || openSalesDemand === null || incomingApprovedPo === null
      ? null
      : available + incomingApprovedPo - openSalesDemand
    const master = rows(context.items).find(row => itemKey(row) === sku)
    const safetyStock = stockThreshold(master?.safetyStock, inventoryRows, 'safetyStock')
    const reorderPoint = stockThreshold(master?.reorderPoint, inventoryRows, 'reorderPoint')
    const stockStatus = stockStatusFor({ available, availableToPromise, safetyStock, reorderPoint })
    return {
      sku,
      itemId: text(master?.itemId || inventoryRows[0]?.itemId || sku),
      itemName: text(master?.itemName || master?.name || inventoryRows[0]?.itemName || inventoryRows[0]?.name || sku),
      onHand,
      reserved,
      available,
      openSalesDemand,
      incomingApprovedPo,
      shortage,
      availableToPromise,
      safetyStock,
      reorderPoint,
      stockStatus,
      riskLevel: riskLevelFor({ shortage, availableToPromise, stockStatus }),
      salesOrderIds: salesOrders.map(row => text(row.salesOrderId || row.id)).filter(Boolean),
      purchaseOrderIds: poLines.map(({ po }) => text(po.id || po.po)).filter(Boolean),
      evidence: [
        ...salesOrders.map(row => ({ entityType: 'sales_order', entityId: text(row.salesOrderId || row.id), canonicalRoute: `/app/sales/orders/${encodeURIComponent(text(row.salesOrderId || row.id))}` })),
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
