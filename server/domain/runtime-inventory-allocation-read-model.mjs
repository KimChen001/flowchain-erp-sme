const rows = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const finite = value => value !== '' && value != null && Number.isFinite(Number(value))
const quantity = value => finite(value) ? Number(value) : null
const sumKnown = values => values.some(value => value === null) ? null : values.reduce((sum, value) => sum + value, 0)
const statusIsIncoming = status => ['approved', 'issued'].includes(text(status).toLowerCase())
const itemKey = row => text(row.sku || row.itemId || row.id)
const lineKey = line => text(line.sku || line.itemId || line.id)
const lineQty = line => quantity(line.quantityOrdered ?? line.orderedQty ?? line.quantity ?? line.qty)
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
    const approvedPos = rows(context.purchaseOrders).filter(po => statusIsIncoming(po.status))
    const poLines = approvedPos.flatMap(po => rows(po.lines).filter(line => lineKey(line) === sku).map(line => ({ po, line })))
    const dataLimitations = []

    const onHandParts = inventoryRows.map(row => quantity(row.onHandQuantity ?? row.onHand ?? row.currentStock))
    const explicitReserved = inventoryRows.map(row => quantity(row.reservedQuantity ?? row.reservedQty))
    const salesReserved = skuDemand.map(line => line.reserved)
    const openDemandParts = skuDemand.map(({ ordered, fulfilled }) => ordered === null || fulfilled === null ? null : Math.max(0, ordered - fulfilled))
    const incomingParts = poLines.map(({ line }) => lineQty(line))

    if (!inventoryRows.length) dataLimitations.push(limitation('inventory_balance_missing', sku))
    if (inventoryRows.length && onHandParts.includes(null)) dataLimitations.push(limitation('on_hand_quantity_missing', sku))
    if (openDemandParts.includes(null)) dataLimitations.push(limitation('sales_demand_quantity_missing', sku))
    if (poLines.some((_, index) => incomingParts[index] === null)) dataLimitations.push(limitation('approved_po_quantity_missing', sku))

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
      riskLevel: shortage === null ? 'unknown' : shortage > 0 ? 'high' : availableToPromise < 0 ? 'medium' : 'low',
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
