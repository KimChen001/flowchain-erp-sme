const SCALE = 10_000n
const ZERO = 0n

export const outboundText = (value = '') => String(value ?? '').trim()
export const outboundLocationKey = (value = '') => outboundText(value).toLowerCase()

// Customer invoice statuses in which an invoice holds the shipment it bills.
// Operational finance counts these when preventing a shipment from being
// invoiced twice, and shipment reversal refuses to undo a shipment that any of
// them still holds. One definition, so the two rules cannot disagree. A draft
// does not hold the shipment: submitting it re-validates the shipment.
export const SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES = Object.freeze([
  'submitted',
  'approved',
  'issued',
  'disputed',
])

export function outboundDecimalUnits(value) {
  const raw = outboundText(value ?? '0') || '0'
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw Object.assign(new Error(`Invalid decimal quantity: ${raw}`), { code: 'RESERVATION_VALIDATION_FAILED' })
  const negative = raw.startsWith('-')
  const unsigned = negative ? raw.slice(1) : raw
  const [whole, fraction = ''] = unsigned.split('.')
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4))) {
    throw Object.assign(new Error(`Quantity exceeds four decimal places: ${raw}`), { code: 'RESERVATION_VALIDATION_FAILED' })
  }
  const units = BigInt(whole) * SCALE + BigInt((fraction.slice(0, 4) + '0000').slice(0, 4))
  return negative ? -units : units
}

export function outboundDecimalString(units) {
  const value = BigInt(units)
  const negative = value < ZERO
  const absolute = negative ? -value : value
  return `${negative ? '-' : ''}${absolute / SCALE}.${String(absolute % SCALE).padStart(4, '0')}`
}

export function outboundReservationStatus(reservation) {
  const reserved = outboundDecimalUnits(reservation.reservedQuantity)
  const allocated = outboundDecimalUnits(reservation.allocatedQuantity)
  const consumed = outboundDecimalUnits(reservation.consumedQuantity)
  const released = outboundDecimalUnits(reservation.releasedQuantity)
  const active = reserved - consumed - released
  if (active === ZERO) return consumed === reserved ? 'consumed' : 'released'
  if (consumed > ZERO) return 'partially_consumed'
  if (allocated === active) return 'allocated'
  if (allocated > ZERO) return 'partially_allocated'
  return 'active'
}

export function outboundOrderStatuses(lines = []) {
  const values = lines.map((line) => ({
    ordered: outboundDecimalUnits(line.orderedQuantity),
    reserved: outboundDecimalUnits(line.reservedQuantity),
    fulfilled: outboundDecimalUnits(line.fulfilledQuantity),
  }))
  const reservationStatus = !values.length || values.every((line) => line.reserved === ZERO)
    ? 'not_reserved'
    : values.every((line) => line.reserved + line.fulfilled >= line.ordered)
      ? 'fully_reserved'
      : 'partially_reserved'
  const fulfillmentStatus = !values.length || values.every((line) => line.fulfilled === ZERO)
    ? 'not_fulfilled'
    : values.every((line) => line.fulfilled >= line.ordered)
      ? 'fully_fulfilled'
      : 'partially_fulfilled'
  return { reservationStatus, fulfillmentStatus }
}

function policyError(code, message, status = 422, details) {
  return { code, message, status, ...(details ? { details } : {}) }
}

function safeUnits(value, issues, label) {
  try { return outboundDecimalUnits(value) } catch (error) {
    issues.push(policyError(error.code || 'RESERVATION_VALIDATION_FAILED', `${label}: ${error.message || error}`))
    return null
  }
}

const balanceKey = ({ sku, warehouseId, locationKey }) => `${outboundText(sku)}|${outboundText(warehouseId)}|${outboundText(locationKey)}`
const balanceWhere = ({ tenantId, sku, warehouseId, locationKey }) => ({
  tenantId_sku_warehouseKey_locationKey: { tenantId, sku, warehouseKey: warehouseId, locationKey },
})
const sorted = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
const emptyFacts = () => ({ inventoryMovements: [], reservationEvents: [], auditEvents: 1, commandExecutions: 1 })

function basePlan(operation, blockingIssues, additions = {}) {
  return {
    operation,
    allowed: blockingIssues.length === 0,
    blockingIssues,
    warnings: [],
    balanceImpacts: [],
    reservationImpacts: [],
    salesOrderLineImpacts: [],
    salesOrderStatusImpacts: null,
    shipmentImpacts: [],
    factsToCreate: emptyFacts(),
    ...additions,
  }
}

async function loadOrder(prisma, tenantId, salesOrderId) {
  return prisma.salesOrder.findFirst({
    where: { id: outboundText(salesOrderId), tenantId },
    include: { lines: { orderBy: { id: 'asc' } } },
  })
}

async function loadShipment(prisma, tenantId, shipmentId) {
  return prisma.shipmentDocument.findFirst({
    where: { id: outboundText(shipmentId), tenantId },
    include: {
      salesOrder: { include: { lines: { orderBy: { id: 'asc' } } } },
      lines: { orderBy: { id: 'asc' }, include: { allocations: { orderBy: { id: 'asc' }, include: { reservation: true } } } },
    },
  })
}

function projectOrderLines(order, impacts) {
  const byId = new Map(impacts.map((impact) => [impact.salesOrderLineId, impact]))
  return order.lines.map((line) => {
    const impact = byId.get(line.id)
    return impact ? { ...line, reservedQuantity: impact.reservedAfter, fulfilledQuantity: impact.fulfilledAfter } : line
  })
}

async function validateOrderItems(prisma, tenantId, order, blockingIssues) {
  const itemIds = sorted(order.lines.map((line) => outboundText(line.itemId)))
  const items = itemIds.length ? await prisma.item.findMany({ where: { tenantId, id: { in: itemIds } }, orderBy: { id: 'asc' } }) : []
  const itemMap = new Map(items.map((item) => [item.id, item]))
  for (const line of order.lines) {
    const item = itemMap.get(line.itemId)
    if (!item || item.tenantId !== tenantId || item.id !== line.itemId || item.sku !== line.sku || item.status !== 'active') {
      blockingIssues.push(policyError('SALES_ORDER_ITEM_INVALID', `Sales order line ${line.id} does not reference an active tenant item with the same SKU.`, 422))
    }
  }
  return itemMap
}

export async function buildSalesOrderReservationPlan({ prisma, tenantId, salesOrderId, allocations = [] }) {
  const blockingIssues = []
  const order = await loadOrder(prisma, tenantId, salesOrderId)
  if (!order) return basePlan('reserve', [policyError('SALES_ORDER_NOT_FOUND', 'Sales order was not found.', 404)])
  if (order.workflowStatus !== 'confirmed') blockingIssues.push(policyError('SALES_ORDER_NOT_CONFIRMED', 'Sales order must be confirmed before inventory can be reserved.', 409))
  if (!Array.isArray(allocations) || allocations.length === 0) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'At least one reservation allocation is required.'))
  await validateOrderItems(prisma, tenantId, order, blockingIssues)

  const lines = new Map(order.lines.map((line) => [line.id, line]))
  const normalizedAllocations = []
  const byBalance = new Map()
  const byLine = new Map()
  for (const allocation of allocations || []) {
    const salesOrderLineId = outboundText(allocation.salesOrderLineId)
    const warehouseId = outboundText(allocation.warehouseId)
    const location = outboundText(allocation.location)
    const locationKey = outboundLocationKey(location)
    const line = lines.get(salesOrderLineId)
    const quantity = safeUnits(allocation.quantity, blockingIssues, `Allocation ${salesOrderLineId || '(missing)'} quantity`)
    if (!line) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'Reservation allocation must reference a line on this sales order.'))
    if (!warehouseId) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'warehouseId is required.'))
    if (quantity !== null && quantity <= ZERO) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'Reservation quantity must be positive.'))
    if (!line || !warehouseId || quantity === null || quantity <= ZERO) continue
    const key = balanceKey({ sku: line.sku, warehouseId, locationKey })
    byBalance.set(key, (byBalance.get(key) || ZERO) + quantity)
    byLine.set(line.id, (byLine.get(line.id) || ZERO) + quantity)
    normalizedAllocations.push({ salesOrderLineId, warehouseId, location, locationKey, quantity, sku: line.sku, itemId: line.itemId, itemName: line.itemName, unit: line.unit, balanceKey: key })
  }

  const warehouseIds = sorted(normalizedAllocations.map((entry) => entry.warehouseId))
  const warehouses = warehouseIds.length ? await prisma.warehouse.findMany({ where: { tenantId, id: { in: warehouseIds }, status: 'active' }, select: { id: true } }) : []
  const activeWarehouses = new Set(warehouses.map((warehouse) => warehouse.id))
  for (const warehouseId of warehouseIds) if (!activeWarehouses.has(warehouseId)) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', `Warehouse ${warehouseId} is not active for this tenant.`))

  const balanceImpacts = []
  for (const key of sorted([...byBalance.keys()])) {
    const allocation = normalizedAllocations.find((entry) => entry.balanceKey === key)
    const balance = await prisma.inventoryBalance.findUnique({ where: balanceWhere({ tenantId, ...allocation }) })
    if (!balance) {
      const mismatched = await prisma.inventoryBalance.findFirst({ where: { tenantId, warehouseKey: allocation.warehouseId, locationKey: allocation.locationKey, itemId: allocation.itemId }, select: { id: true } })
      blockingIssues.push(mismatched ? policyError('SALES_ORDER_ITEM_INVALID', 'Inventory balance SKU does not match the sales order item.', 422) : policyError('RESERVATION_INSUFFICIENT_AVAILABLE', `Inventory balance for ${allocation.sku} was not found.`))
      continue
    }
    if (balance.itemId !== allocation.itemId || balance.sku !== allocation.sku) blockingIssues.push(policyError('SALES_ORDER_ITEM_INVALID', `Inventory balance ${balance.id} does not match the sales order item and SKU.`, 422))
    const onHand = safeUnits(balance.onHandQuantity, blockingIssues, `Balance ${balance.id} onHandQuantity`)
    const reserved = safeUnits(balance.reservedQuantity, blockingIssues, `Balance ${balance.id} reservedQuantity`)
    const available = safeUnits(balance.availableQuantity, blockingIssues, `Balance ${balance.id} availableQuantity`)
    const quantity = byBalance.get(key)
    if (onHand === null || reserved === null || available === null) continue
    if (available !== onHand - reserved) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', `Inventory balance ${balance.id} does not reconcile.`))
    if (available < quantity) blockingIssues.push(policyError('RESERVATION_INSUFFICIENT_AVAILABLE', `Available inventory for ${allocation.sku} is insufficient.`, 422, { balanceId: balance.id }))
    balanceImpacts.push({ balanceId: balance.id, ...allocation, quantityUnits: quantity, onHandBefore: outboundDecimalString(onHand), onHandAfter: outboundDecimalString(onHand), reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved + quantity), availableBefore: outboundDecimalString(available), availableAfter: outboundDecimalString(available - quantity), version: balance.version })
  }

  const salesOrderLineImpacts = []
  for (const lineId of sorted([...byLine.keys()])) {
    const line = lines.get(lineId)
    const quantity = byLine.get(lineId)
    const ordered = safeUnits(line.orderedQuantity, blockingIssues, `Sales order line ${line.id} orderedQuantity`)
    const reserved = safeUnits(line.reservedQuantity, blockingIssues, `Sales order line ${line.id} reservedQuantity`)
    const fulfilled = safeUnits(line.fulfilledQuantity, blockingIssues, `Sales order line ${line.id} fulfilledQuantity`)
    if (ordered === null || reserved === null || fulfilled === null) continue
    if (reserved + fulfilled + quantity > ordered) blockingIssues.push(policyError('RESERVATION_OVER_ORDERED', `Reservation exceeds ordered quantity for line ${line.id}.`))
    salesOrderLineImpacts.push({ salesOrderLineId: line.id, quantityUnits: quantity, reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved + quantity), fulfilledBefore: outboundDecimalString(fulfilled), fulfilledAfter: outboundDecimalString(fulfilled), version: line.version })
  }
  const statuses = outboundOrderStatuses(projectOrderLines(order, salesOrderLineImpacts))
  return basePlan('reserve', blockingIssues, {
    order,
    normalizedPlan: { salesOrderId: order.id, allocations: normalizedAllocations.map((entry) => ({ ...entry, quantity: outboundDecimalString(entry.quantity) })) },
    quantityPlans: normalizedAllocations,
    balanceImpacts,
    salesOrderLineImpacts,
    salesOrderStatusImpacts: { before: { reservationStatus: order.reservationStatus, fulfillmentStatus: order.fulfillmentStatus }, after: statuses },
    factsToCreate: { ...emptyFacts(), reservationEvents: normalizedAllocations.map((entry) => ({ eventType: 'reserved', quantity: outboundDecimalString(entry.quantity) })) },
  })
}

export async function buildReservationReleasePlan({ prisma, tenantId, salesOrderId, reason, releases = [] }) {
  const blockingIssues = []
  const order = await loadOrder(prisma, tenantId, salesOrderId)
  if (!order) return basePlan('release', [policyError('SALES_ORDER_NOT_FOUND', 'Sales order was not found.', 404)])
  if (!outboundText(reason)) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'A release reason is required.'))
  if (!Array.isArray(releases) || releases.length === 0) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'At least one release is required.'))
  const releaseByReservation = new Map()
  const expectedVersions = new Map()
  for (const release of releases || []) {
    const id = outboundText(release.reservationId)
    const quantity = safeUnits(release.quantity, blockingIssues, `Reservation ${id || '(missing)'} release quantity`)
    if (!id || quantity === null || quantity <= ZERO) {
      if (quantity !== null && quantity <= ZERO) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'Release quantity must be positive.'))
      continue
    }
    releaseByReservation.set(id, (releaseByReservation.get(id) || ZERO) + quantity)
    expectedVersions.set(id, release.expectedReservationVersion)
  }
  const reservations = releaseByReservation.size ? await prisma.inventoryReservation.findMany({ where: { tenantId, salesOrderId: order.id, id: { in: sorted([...releaseByReservation.keys()]) } }, orderBy: { id: 'asc' } }) : []
  const found = new Map(reservations.map((reservation) => [reservation.id, reservation]))
  const reservationImpacts = []
  const lineDeltas = new Map()
  const balanceDeltas = new Map()
  for (const id of sorted([...releaseByReservation.keys()])) {
    const reservation = found.get(id)
    if (!reservation) { blockingIssues.push(policyError('RESERVATION_NOT_FOUND', `Reservation ${id} was not found.`, 404)); continue }
    if (expectedVersions.get(id) !== undefined && Number(expectedVersions.get(id)) !== reservation.version) blockingIssues.push(policyError('RESERVATION_VERSION_CONFLICT', `Reservation ${id} version does not match.`, 409))
    const quantity = releaseByReservation.get(id)
    const reserved = safeUnits(reservation.reservedQuantity, blockingIssues, `Reservation ${id} reservedQuantity`)
    const allocated = safeUnits(reservation.allocatedQuantity, blockingIssues, `Reservation ${id} allocatedQuantity`)
    const consumed = safeUnits(reservation.consumedQuantity, blockingIssues, `Reservation ${id} consumedQuantity`)
    const released = safeUnits(reservation.releasedQuantity, blockingIssues, `Reservation ${id} releasedQuantity`)
    if ([reserved, allocated, consumed, released].some((value) => value === null)) continue
    const allocatable = reserved - consumed - released - allocated
    if (quantity > allocatable) blockingIssues.push(policyError(allocated > ZERO ? 'RESERVATION_ALREADY_ALLOCATED' : 'RESERVATION_QUANTITY_CONFLICT', `Reservation ${id} does not have enough allocatable quantity.`, 409))
    reservationImpacts.push({ reservation, reservationId: id, quantityUnits: quantity, releasedBefore: outboundDecimalString(released), releasedAfter: outboundDecimalString(released + quantity), allocatedBefore: outboundDecimalString(allocated), consumedBefore: outboundDecimalString(consumed), statusAfter: outboundReservationStatus({ ...reservation, releasedQuantity: outboundDecimalString(released + quantity) }) })
    lineDeltas.set(reservation.salesOrderLineId, (lineDeltas.get(reservation.salesOrderLineId) || ZERO) + quantity)
    const key = balanceKey(reservation)
    balanceDeltas.set(key, { reservation, quantity: (balanceDeltas.get(key)?.quantity || ZERO) + quantity })
  }
  const balanceImpacts = []
  for (const key of sorted([...balanceDeltas.keys()])) {
    const { reservation, quantity } = balanceDeltas.get(key)
    const balance = await prisma.inventoryBalance.findUnique({ where: balanceWhere({ tenantId, ...reservation }) })
    if (!balance) { blockingIssues.push(policyError('RESERVATION_QUANTITY_CONFLICT', 'Reservation inventory balance was not found.', 409)); continue }
    const onHand = outboundDecimalUnits(balance.onHandQuantity)
    const reserved = outboundDecimalUnits(balance.reservedQuantity)
    const available = outboundDecimalUnits(balance.availableQuantity)
    if (reserved < quantity || available !== onHand - reserved) blockingIssues.push(policyError('RESERVATION_QUANTITY_CONFLICT', `Balance ${balance.id} cannot release the requested quantity.`, 409))
    balanceImpacts.push({ balanceId: balance.id, reservation, quantityUnits: quantity, onHandBefore: outboundDecimalString(onHand), onHandAfter: outboundDecimalString(onHand), reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved - quantity), availableBefore: outboundDecimalString(available), availableAfter: outboundDecimalString(available + quantity), version: balance.version })
  }
  const lineMap = new Map(order.lines.map((line) => [line.id, line]))
  const salesOrderLineImpacts = sorted([...lineDeltas.keys()]).map((lineId) => {
    const line = lineMap.get(lineId); const quantity = lineDeltas.get(lineId)
    const reserved = outboundDecimalUnits(line.reservedQuantity); const fulfilled = outboundDecimalUnits(line.fulfilledQuantity)
    if (reserved < quantity) blockingIssues.push(policyError('RESERVATION_QUANTITY_CONFLICT', `Sales order line ${lineId} cannot release the requested quantity.`, 409))
    return { salesOrderLineId: lineId, quantityUnits: quantity, reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved - quantity), fulfilledBefore: outboundDecimalString(fulfilled), fulfilledAfter: outboundDecimalString(fulfilled), version: line.version }
  })
  const statuses = outboundOrderStatuses(projectOrderLines(order, salesOrderLineImpacts))
  return basePlan('release', blockingIssues, { order, normalizedPlan: { salesOrderId: order.id, reason: outboundText(reason), releases: sorted([...releaseByReservation.keys()]).map((id) => ({ reservationId: id, quantity: outboundDecimalString(releaseByReservation.get(id)), expectedReservationVersion: expectedVersions.get(id) ?? null })) }, reservationImpacts, balanceImpacts, salesOrderLineImpacts, salesOrderStatusImpacts: { before: { reservationStatus: order.reservationStatus, fulfillmentStatus: order.fulfillmentStatus }, after: statuses }, factsToCreate: { ...emptyFacts(), reservationEvents: reservationImpacts.map((impact) => ({ reservationId: impact.reservationId, eventType: 'released', quantity: outboundDecimalString(impact.quantityUnits) })) } })
}

export async function buildShipmentDraftPlan({ prisma, tenantId, salesOrderId, shipmentNumber, lines = [] }) {
  const blockingIssues = []
  const order = await loadOrder(prisma, tenantId, salesOrderId)
  if (!order) return basePlan('create_shipment_draft', [policyError('SALES_ORDER_NOT_FOUND', 'Sales order was not found.', 404)])
  if (order.workflowStatus !== 'confirmed') blockingIssues.push(policyError('SALES_ORDER_NOT_CONFIRMED', 'Sales order must be confirmed before a shipment draft can be created.', 409))
  if (!outboundText(shipmentNumber)) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'shipmentNumber is required.'))
  if (!Array.isArray(lines) || lines.length === 0) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'At least one shipment line is required.'))
  await validateOrderItems(prisma, tenantId, order, blockingIssues)
  if (outboundText(shipmentNumber)) {
    const duplicate = await prisma.shipmentDocument.findFirst({ where: { tenantId, shipmentNumber: outboundText(shipmentNumber) }, select: { id: true } })
    if (duplicate) blockingIssues.push(policyError('SHIPMENT_NUMBER_CONFLICT', 'Shipment number is already in use for this workspace.', 409))
  }
  const orderLines = new Map(order.lines.map((line) => [line.id, line]))
  const reservationIds = sorted((lines || []).flatMap((line) => (line.allocations || []).map((allocation) => outboundText(allocation.reservationId))))
  const reservations = reservationIds.length ? await prisma.inventoryReservation.findMany({ where: { tenantId, salesOrderId: order.id, id: { in: reservationIds } }, orderBy: { id: 'asc' } }) : []
  const reservationMap = new Map(reservations.map((reservation) => [reservation.id, reservation]))
  const byReservation = new Map()
  const normalizedLines = []
  for (const requestedLine of lines || []) {
    const salesOrderLineId = outboundText(requestedLine.salesOrderLineId)
    const orderLine = orderLines.get(salesOrderLineId)
    if (!orderLine) { blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'Shipment line must reference this sales order.')); continue }
    const normalizedAllocations = []
    for (const allocation of requestedLine.allocations || []) {
      const reservationId = outboundText(allocation.reservationId)
      const quantity = safeUnits(allocation.quantity, blockingIssues, `Shipment allocation ${reservationId || '(missing)'} quantity`)
      const reservation = reservationMap.get(reservationId)
      if (!reservation) blockingIssues.push(policyError('RESERVATION_NOT_FOUND', `Reservation ${reservationId} was not found.`, 404))
      else if (reservation.salesOrderLineId !== salesOrderLineId) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', `Reservation ${reservationId} does not belong to shipment line ${salesOrderLineId}.`))
      if (quantity !== null && quantity <= ZERO) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'Shipment allocation quantity must be positive.'))
      if (!reservation || reservation.salesOrderLineId !== salesOrderLineId || quantity === null || quantity <= ZERO) continue
      byReservation.set(reservationId, (byReservation.get(reservationId) || ZERO) + quantity)
      normalizedAllocations.push({ reservationId, quantityUnits: quantity, reservation })
    }
    if (!normalizedAllocations.length) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', `Shipment line ${salesOrderLineId} has no valid allocations.`))
    normalizedLines.push({ salesOrderLineId, orderLine, allocations: normalizedAllocations, requestedQuantityUnits: normalizedAllocations.reduce((sum, allocation) => sum + allocation.quantityUnits, ZERO) })
  }
  const reservationImpacts = []
  for (const reservationId of sorted([...byReservation.keys()])) {
    const reservation = reservationMap.get(reservationId); const quantity = byReservation.get(reservationId)
    const reserved = outboundDecimalUnits(reservation.reservedQuantity); const allocated = outboundDecimalUnits(reservation.allocatedQuantity); const consumed = outboundDecimalUnits(reservation.consumedQuantity); const released = outboundDecimalUnits(reservation.releasedQuantity)
    const allocatable = reserved - allocated - consumed - released
    if (quantity > allocatable) blockingIssues.push(policyError('SHIPMENT_RESERVATION_INSUFFICIENT', `Reservation ${reservationId} does not have enough allocatable quantity.`, 409))
    reservationImpacts.push({ reservation, reservationId, quantityUnits: quantity, allocatedBefore: outboundDecimalString(allocated), allocatedAfter: outboundDecimalString(allocated + quantity), statusAfter: outboundReservationStatus({ ...reservation, allocatedQuantity: outboundDecimalString(allocated + quantity) }) })
  }
  return basePlan('create_shipment_draft', blockingIssues, { order, normalizedPlan: { salesOrderId: order.id, shipmentNumber: outboundText(shipmentNumber), lines: normalizedLines.map((line) => ({ salesOrderLineId: line.salesOrderLineId, requestedQuantity: outboundDecimalString(line.requestedQuantityUnits), allocations: line.allocations.map((allocation) => ({ reservationId: allocation.reservationId, quantity: outboundDecimalString(allocation.quantityUnits) })) })) }, quantityPlans: normalizedLines, reservationImpacts, shipmentImpacts: [{ workflowStatusBefore: null, workflowStatusAfter: 'ready', postingStatusBefore: null, postingStatusAfter: 'unposted' }], factsToCreate: { ...emptyFacts(), reservationEvents: reservationImpacts.map((impact) => ({ reservationId: impact.reservationId, eventType: 'allocated', quantity: outboundDecimalString(impact.quantityUnits) })) } })
}

export async function buildShipmentCancellationPlan({ prisma, tenantId, shipmentId, reason }) {
  const blockingIssues = []
  const shipment = await loadShipment(prisma, tenantId, shipmentId)
  if (!shipment) return basePlan('cancel_shipment_draft', [policyError('SHIPMENT_NOT_FOUND', 'Shipment was not found.', 404)])
  if (!outboundText(reason)) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'A cancellation reason is required.'))
  if (shipment.workflowStatus === 'cancelled') blockingIssues.push(policyError('SHIPMENT_ALREADY_CANCELLED', 'Shipment is already cancelled.', 409))
  else if (!['draft', 'ready'].includes(shipment.workflowStatus) || shipment.postingStatus !== 'unposted') blockingIssues.push(policyError('SHIPMENT_NOT_CANCELLABLE', 'Only an unposted draft or ready shipment can be cancelled.', 409))
  const allocations = shipment.lines.flatMap((line) => line.allocations).filter((allocation) => allocation.status === 'allocated')
  const byReservation = new Map()
  for (const allocation of allocations) byReservation.set(allocation.reservationId, { reservation: allocation.reservation, quantity: (byReservation.get(allocation.reservationId)?.quantity || ZERO) + outboundDecimalUnits(allocation.quantity) })
  const reservationImpacts = sorted([...byReservation.keys()]).map((reservationId) => {
    const { reservation, quantity } = byReservation.get(reservationId); const allocated = outboundDecimalUnits(reservation.allocatedQuantity)
    if (allocated < quantity) blockingIssues.push(policyError('SHIPMENT_RESERVATION_INSUFFICIENT', `Reservation ${reservationId} cannot be deallocated.`, 409))
    return { reservation, reservationId, quantityUnits: quantity, allocatedBefore: outboundDecimalString(allocated), allocatedAfter: outboundDecimalString(allocated - quantity), statusAfter: outboundReservationStatus({ ...reservation, allocatedQuantity: outboundDecimalString(allocated - quantity) }) }
  })
  return basePlan('cancel_shipment_draft', blockingIssues, { shipment, normalizedPlan: { shipmentId: shipment.id, reason: outboundText(reason) }, reservationImpacts, shipmentImpacts: [{ shipmentId: shipment.id, workflowStatusBefore: shipment.workflowStatus, workflowStatusAfter: 'cancelled', postingStatusBefore: shipment.postingStatus, postingStatusAfter: shipment.postingStatus }], factsToCreate: { ...emptyFacts(), reservationEvents: reservationImpacts.map((impact) => ({ reservationId: impact.reservationId, eventType: 'deallocated', quantity: outboundDecimalString(impact.quantityUnits) })) } })
}

export async function buildShipmentPostingPlan({ prisma, tenantId, shipmentId }) {
  const blockingIssues = []
  const shipment = await loadShipment(prisma, tenantId, shipmentId)
  if (!shipment) return basePlan('post_shipment', [policyError('SHIPMENT_NOT_FOUND', 'Shipment was not found.', 404)])
  await validateOrderItems(prisma, tenantId, shipment.salesOrder, blockingIssues)
  if (shipment.salesOrder.workflowStatus === 'on_hold') blockingIssues.push(policyError('SALES_ORDER_ON_HOLD', 'Sales order is on hold and cannot be posted. Resume the order first.', 409))
  else if (shipment.salesOrder.workflowStatus !== 'confirmed') blockingIssues.push(policyError('SALES_ORDER_INVALID_STATE', 'Sales order must be confirmed before its shipment can be posted.', 409))
  if (shipment.postingStatus === 'posted') blockingIssues.push(policyError('SHIPMENT_ALREADY_POSTED', 'Shipment is already posted.', 409))
  else if (shipment.postingStatus === 'reversed') blockingIssues.push(policyError('SHIPMENT_ALREADY_REVERSED', 'Shipment is already reversed.', 409))
  else if (shipment.workflowStatus === 'cancelled') blockingIssues.push(policyError('SHIPMENT_ALREADY_CANCELLED', 'Cancelled shipment cannot be posted.', 409))
  else if (shipment.workflowStatus !== 'ready' || shipment.postingStatus !== 'unposted') blockingIssues.push(policyError('SHIPMENT_NOT_READY', 'Shipment is not ready for posting.', 409))
  const allocations = shipment.lines.flatMap((line) => line.allocations.map((allocation) => ({ ...allocation, shipmentLine: line })))
  if (!allocations.length || allocations.some((allocation) => allocation.status !== 'allocated')) blockingIssues.push(policyError('SHIPMENT_NOT_READY', 'Every shipment allocation must be allocated before posting.', 409))
  const byReservation = new Map(), byBalance = new Map(), byOrderLine = new Map(), byShipmentLine = new Map()
  for (const allocation of allocations) {
    const quantity = outboundDecimalUnits(allocation.quantity)
    byReservation.set(allocation.reservationId, { reservation: allocation.reservation, quantity: (byReservation.get(allocation.reservationId)?.quantity || ZERO) + quantity })
    const key = balanceKey({ ...allocation, sku: allocation.reservation.sku })
    byBalance.set(key, { allocation, quantity: (byBalance.get(key)?.quantity || ZERO) + quantity })
    byOrderLine.set(allocation.shipmentLine.salesOrderLineId, (byOrderLine.get(allocation.shipmentLine.salesOrderLineId) || ZERO) + quantity)
    byShipmentLine.set(allocation.shipmentLine.id, (byShipmentLine.get(allocation.shipmentLine.id) || ZERO) + quantity)
  }
  const reservationImpacts = sorted([...byReservation.keys()]).map((reservationId) => {
    const { reservation, quantity } = byReservation.get(reservationId); const allocated = outboundDecimalUnits(reservation.allocatedQuantity); const consumed = outboundDecimalUnits(reservation.consumedQuantity); const released = outboundDecimalUnits(reservation.releasedQuantity); const reserved = outboundDecimalUnits(reservation.reservedQuantity)
    if (allocated < quantity || reserved - consumed - released < quantity) blockingIssues.push(policyError('SHIPMENT_RESERVATION_INSUFFICIENT', `Reservation ${reservationId} is insufficient for posting.`, 409))
    return { reservation, reservationId, quantityUnits: quantity, allocatedBefore: outboundDecimalString(allocated), allocatedAfter: outboundDecimalString(allocated - quantity), consumedBefore: outboundDecimalString(consumed), consumedAfter: outboundDecimalString(consumed + quantity), statusAfter: outboundReservationStatus({ ...reservation, allocatedQuantity: outboundDecimalString(allocated - quantity), consumedQuantity: outboundDecimalString(consumed + quantity) }) }
  })
  const balanceImpacts = []
  for (const key of sorted([...byBalance.keys()])) {
    const { allocation, quantity } = byBalance.get(key)
    const balance = await prisma.inventoryBalance.findUnique({ where: balanceWhere({ tenantId, ...allocation, sku: allocation.reservation.sku }) })
    if (!balance) { const mismatched = await prisma.inventoryBalance.findFirst({ where: { tenantId, warehouseKey: allocation.warehouseId, locationKey: allocation.locationKey, itemId: allocation.reservation.itemId }, select: { id: true } }); blockingIssues.push(mismatched ? policyError('SALES_ORDER_ITEM_INVALID', 'Inventory balance SKU does not match the shipment reservation item.', 422) : policyError('SHIPMENT_RESERVATION_INSUFFICIENT', 'Shipment inventory balance was not found.', 409)); continue }
    if (balance.itemId !== allocation.reservation.itemId || balance.sku !== allocation.reservation.sku) blockingIssues.push(policyError('SALES_ORDER_ITEM_INVALID', `Inventory balance ${balance.id} does not match the shipment reservation item and SKU.`, 422))
    const onHand = outboundDecimalUnits(balance.onHandQuantity); const reserved = outboundDecimalUnits(balance.reservedQuantity); const available = outboundDecimalUnits(balance.availableQuantity)
    if (available !== onHand - reserved) blockingIssues.push(policyError('SHIPMENT_RESERVATION_INSUFFICIENT', `Balance ${balance.id} does not reconcile.`, 409))
    if (onHand < quantity || reserved < quantity) blockingIssues.push(policyError('SHIPMENT_RESERVATION_INSUFFICIENT', `Balance ${balance.id} is insufficient for posting.`, 409))
    balanceImpacts.push({ balanceId: balance.id, allocation, quantityUnits: quantity, onHandBefore: outboundDecimalString(onHand), onHandAfter: outboundDecimalString(onHand - quantity), reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved - quantity), availableBefore: outboundDecimalString(available), availableAfter: outboundDecimalString(available), version: balance.version })
  }
  const orderLineMap = new Map(shipment.salesOrder.lines.map((line) => [line.id, line]))
  const salesOrderLineImpacts = sorted([...byOrderLine.keys()]).map((lineId) => {
    const line = orderLineMap.get(lineId); const quantity = byOrderLine.get(lineId); const ordered = outboundDecimalUnits(line.orderedQuantity); const reserved = outboundDecimalUnits(line.reservedQuantity); const fulfilled = outboundDecimalUnits(line.fulfilledQuantity)
    if (reserved < quantity) blockingIssues.push(policyError('SHIPMENT_RESERVATION_INSUFFICIENT', `Sales order line ${lineId} has insufficient reserved quantity.`, 409))
    if (fulfilled + quantity > ordered) blockingIssues.push(policyError('SHIPMENT_OVER_FULFILLMENT', `Shipment would over-fulfill sales order line ${lineId}.`, 409))
    return { salesOrderLineId: lineId, quantityUnits: quantity, reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved - quantity), fulfilledBefore: outboundDecimalString(fulfilled), fulfilledAfter: outboundDecimalString(fulfilled + quantity), version: line.version }
  })
  const shipmentLineImpacts = shipment.lines.map((line) => { const before = outboundDecimalUnits(line.postedQuantity); const quantity = byShipmentLine.get(line.id) || ZERO; return { shipmentLineId: line.id, postedBefore: outboundDecimalString(before), postedAfter: outboundDecimalString(before + quantity), quantityUnits: quantity, version: line.version } })
  const statuses = outboundOrderStatuses(projectOrderLines(shipment.salesOrder, salesOrderLineImpacts))
  return basePlan('post_shipment', blockingIssues, { shipment, normalizedPlan: { shipmentId: shipment.id }, quantityPlans: allocations.map((allocation) => ({ allocation, quantityUnits: outboundDecimalUnits(allocation.quantity) })), balanceImpacts, reservationImpacts, salesOrderLineImpacts, shipmentLineImpacts, salesOrderStatusImpacts: { before: { reservationStatus: shipment.salesOrder.reservationStatus, fulfillmentStatus: shipment.salesOrder.fulfillmentStatus }, after: statuses }, shipmentImpacts: [{ shipmentId: shipment.id, workflowStatusBefore: shipment.workflowStatus, workflowStatusAfter: shipment.workflowStatus, postingStatusBefore: shipment.postingStatus, postingStatusAfter: 'posted' }], factsToCreate: { ...emptyFacts(), inventoryMovements: allocations.map((allocation) => ({ movementType: 'shipment_posting', sourceDocumentLineId: allocation.id, quantityOut: outboundDecimalString(outboundDecimalUnits(allocation.quantity)) })), reservationEvents: reservationImpacts.map((impact) => ({ reservationId: impact.reservationId, eventType: 'consumed', quantity: outboundDecimalString(impact.quantityUnits) })) } })
}

export async function buildShipmentReversalPlan({ prisma, tenantId, shipmentId, reason }) {
  const blockingIssues = []
  const shipment = await loadShipment(prisma, tenantId, shipmentId)
  if (!shipment) return basePlan('reverse_shipment', [policyError('SHIPMENT_NOT_FOUND', 'Shipment was not found.', 404)])
  await validateOrderItems(prisma, tenantId, shipment.salesOrder, blockingIssues)
  if (!outboundText(reason)) blockingIssues.push(policyError('RESERVATION_VALIDATION_FAILED', 'A reversal reason is required.'))
  if (shipment.postingStatus === 'reversed') blockingIssues.push(policyError('SHIPMENT_ALREADY_REVERSED', 'Shipment is already reversed.', 409))
  else if (shipment.postingStatus !== 'posted') blockingIssues.push(policyError('SHIPMENT_REVERSAL_NOT_SAFE', 'Only a posted shipment can be reversed.', 409))
  // A submitted, approved or issued customer invoice bills this shipment, and
  // an issued one has already produced a receivable. Undoing the shipment
  // underneath it would leave the customer owing money for goods the system
  // then records as never shipped. Customer invoices have no cancel, so the
  // refusal is permanent; the correction for billed goods is a customer return
  // and credit note, which the message says.
  const holdingInvoice = await prisma.customerInvoice.findFirst({
    where: { tenantId, shipmentId: shipment.id, status: { in: [...SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES] } },
    select: { id: true, invoiceNumber: true, status: true },
    orderBy: { id: 'asc' },
  })
  if (holdingInvoice) blockingIssues.push(policyError('SHIPMENT_REVERSAL_BLOCKED_BY_INVOICE', 'A customer invoice already bills this shipment, so it can no longer be reversed. To take these goods back, use a customer return and credit note.', 409, { customerInvoiceId: holdingInvoice.id, invoiceNumber: holdingInvoice.invoiceNumber, invoiceStatus: holdingInvoice.status }))
  const allocations = shipment.lines.flatMap((line) => line.allocations.map((allocation) => ({ ...allocation, shipmentLine: line })))
  const originalMovements = await prisma.inventoryMovement.findMany({ where: { tenantId, sourceDocumentId: shipment.id, movementType: 'shipment_posting' }, orderBy: { sourceDocumentLineId: 'asc' } })
  const movementMap = new Map(originalMovements.map((movement) => [movement.sourceDocumentLineId, movement]))
  const byReservation = new Map(), byBalance = new Map(), byOrderLine = new Map(), byShipmentLine = new Map()
  for (const allocation of allocations) {
    const movement = movementMap.get(allocation.id)
    const orderLine = shipment.salesOrder.lines.find((line) => line.id === allocation.shipmentLine.salesOrderLineId)
    const movementMatches = movement
      && movement.movementType === 'shipment_posting'
      && movement.tenantId === tenantId
      && movement.sourceDocumentType === 'ShipmentDocument'
      && movement.sourceDocumentId === shipment.id
      && movement.sourceDocumentLineId === allocation.id
      && movement.relatedSalesOrderId === shipment.salesOrderId
      && !movement.reversedByMovementId
      && outboundDecimalUnits(movement.quantityOut) === outboundDecimalUnits(allocation.quantity)
      && outboundDecimalUnits(movement.quantityIn) === ZERO
      && movement.sku === allocation.reservation.sku
      && movement.itemId === allocation.reservation.itemId
      && movement.warehouseId === allocation.warehouseId
      && outboundText(movement.locationKey) === outboundText(allocation.locationKey)
      && outboundText(movement.unit) === outboundText(allocation.shipmentLine.unit)
      && allocation.status === 'consumed'
      && allocation.reservation.tenantId === tenantId
      && allocation.reservation.salesOrderLineId === allocation.shipmentLine.salesOrderLineId
      && orderLine?.itemId === allocation.reservation.itemId
    if (!movementMatches) { blockingIssues.push(policyError('SHIPMENT_REVERSAL_NOT_SAFE', `Original posting facts for allocation ${allocation.id} do not match the shipment.`, 409)); continue }
    const quantity = outboundDecimalUnits(allocation.quantity)
    byReservation.set(allocation.reservationId, { reservation: allocation.reservation, quantity: (byReservation.get(allocation.reservationId)?.quantity || ZERO) + quantity })
    const key = balanceKey({ ...allocation, sku: allocation.reservation.sku }); byBalance.set(key, { allocation, quantity: (byBalance.get(key)?.quantity || ZERO) + quantity })
    byOrderLine.set(allocation.shipmentLine.salesOrderLineId, (byOrderLine.get(allocation.shipmentLine.salesOrderLineId) || ZERO) + quantity)
    byShipmentLine.set(allocation.shipmentLine.id, (byShipmentLine.get(allocation.shipmentLine.id) || ZERO) + quantity)
  }
  const reservationImpacts = sorted([...byReservation.keys()]).map((reservationId) => { const { reservation, quantity } = byReservation.get(reservationId); const consumed = outboundDecimalUnits(reservation.consumedQuantity); const allocated = outboundDecimalUnits(reservation.allocatedQuantity); if (consumed < quantity) blockingIssues.push(policyError('SHIPMENT_REVERSAL_NOT_SAFE', `Reservation ${reservationId} cannot be restored.`, 409)); return { reservation, reservationId, quantityUnits: quantity, consumedBefore: outboundDecimalString(consumed), consumedAfter: outboundDecimalString(consumed - quantity), allocatedBefore: outboundDecimalString(allocated), allocatedAfter: outboundDecimalString(allocated), statusAfter: outboundReservationStatus({ ...reservation, consumedQuantity: outboundDecimalString(consumed - quantity) }) } })
  const balanceImpacts = []
  for (const key of sorted([...byBalance.keys()])) { const { allocation, quantity } = byBalance.get(key); const balance = await prisma.inventoryBalance.findUnique({ where: balanceWhere({ tenantId, ...allocation, sku: allocation.reservation.sku }) }); if (!balance) { const mismatched = await prisma.inventoryBalance.findFirst({ where: { tenantId, warehouseKey: allocation.warehouseId, locationKey: allocation.locationKey, itemId: allocation.reservation.itemId }, select: { id: true } }); blockingIssues.push(mismatched ? policyError('SALES_ORDER_ITEM_INVALID', 'Inventory balance SKU does not match the shipment reservation item.', 422) : policyError('SHIPMENT_REVERSAL_NOT_SAFE', 'Shipment balance was not found.', 409)); continue } if (balance.itemId !== allocation.reservation.itemId || balance.sku !== allocation.reservation.sku) blockingIssues.push(policyError('SALES_ORDER_ITEM_INVALID', `Inventory balance ${balance.id} does not match the shipment reservation item and SKU.`, 422)); const onHand = outboundDecimalUnits(balance.onHandQuantity); const reserved = outboundDecimalUnits(balance.reservedQuantity); const available = outboundDecimalUnits(balance.availableQuantity); if (available !== onHand - reserved) blockingIssues.push(policyError('SHIPMENT_REVERSAL_NOT_SAFE', `Balance ${balance.id} does not reconcile.`, 409)); balanceImpacts.push({ balanceId: balance.id, allocation, quantityUnits: quantity, onHandBefore: outboundDecimalString(onHand), onHandAfter: outboundDecimalString(onHand + quantity), reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved + quantity), availableBefore: outboundDecimalString(available), availableAfter: outboundDecimalString(available), version: balance.version }) }
  const orderLineMap = new Map(shipment.salesOrder.lines.map((line) => [line.id, line]))
  const salesOrderLineImpacts = sorted([...byOrderLine.keys()]).map((lineId) => { const line = orderLineMap.get(lineId); const quantity = byOrderLine.get(lineId); const reserved = outboundDecimalUnits(line.reservedQuantity); const fulfilled = outboundDecimalUnits(line.fulfilledQuantity); if (fulfilled < quantity) blockingIssues.push(policyError('SHIPMENT_REVERSAL_NOT_SAFE', `Sales order line ${lineId} cannot be reversed.`, 409)); return { salesOrderLineId: lineId, quantityUnits: quantity, reservedBefore: outboundDecimalString(reserved), reservedAfter: outboundDecimalString(reserved + quantity), fulfilledBefore: outboundDecimalString(fulfilled), fulfilledAfter: outboundDecimalString(fulfilled - quantity), version: line.version } })
  const shipmentLineImpacts = shipment.lines.map((line) => { const before = outboundDecimalUnits(line.postedQuantity); const quantity = byShipmentLine.get(line.id) || ZERO; if (before < quantity) blockingIssues.push(policyError('SHIPMENT_REVERSAL_NOT_SAFE', `Shipment line ${line.id} cannot be reversed.`, 409)); return { shipmentLineId: line.id, postedBefore: outboundDecimalString(before), postedAfter: outboundDecimalString(before - quantity), quantityUnits: quantity, version: line.version } })
  const statuses = outboundOrderStatuses(projectOrderLines(shipment.salesOrder, salesOrderLineImpacts))
  return basePlan('reverse_shipment', blockingIssues, { shipment, originalMovements, normalizedPlan: { shipmentId: shipment.id, reason: outboundText(reason) }, quantityPlans: allocations.filter((allocation) => movementMap.has(allocation.id)).map((allocation) => ({ allocation, movement: movementMap.get(allocation.id), quantityUnits: outboundDecimalUnits(allocation.quantity) })), balanceImpacts, reservationImpacts, salesOrderLineImpacts, shipmentLineImpacts, salesOrderStatusImpacts: { before: { reservationStatus: shipment.salesOrder.reservationStatus, fulfillmentStatus: shipment.salesOrder.fulfillmentStatus }, after: statuses }, shipmentImpacts: [{ shipmentId: shipment.id, workflowStatusBefore: shipment.workflowStatus, workflowStatusAfter: shipment.workflowStatus, postingStatusBefore: shipment.postingStatus, postingStatusAfter: 'reversed' }], factsToCreate: { ...emptyFacts(), inventoryMovements: originalMovements.map((movement) => ({ movementType: 'shipment_reversal', reversalOfMovementId: movement.id, quantityIn: outboundDecimalString(outboundDecimalUnits(movement.quantityOut)) })), reservationEvents: reservationImpacts.map((impact) => ({ reservationId: impact.reservationId, eventType: 'restored', quantity: outboundDecimalString(impact.quantityUnits) })) } })
}
