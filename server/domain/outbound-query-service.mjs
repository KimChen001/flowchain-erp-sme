import { assertWarehouseAccess, hasWarehouseAccess, resolveProvisionedActor } from './pilot-identity.mjs'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import {
  buildReservationReleasePlan,
  buildSalesOrderReservationPlan,
  buildShipmentCancellationPlan,
  buildShipmentDraftPlan,
  buildShipmentPostingPlan,
  buildShipmentReversalPlan,
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
  outboundText as text,
} from './outbound-transaction-policy.mjs'

export class OutboundQueryError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.name = 'OutboundQueryError'; this.code = code; this.status = status; this.details = details }
}
const fail = (code, message, status = 400, details) => { throw new OutboundQueryError(code, message, status, details) }
const fixed = (value) => decimalString(decimalUnits(value || 0))
const capability = (capabilities, id) => capabilities?.[id] || { enabled: false }

function identityFrom(context) {
  const identity = context?.identity || context
  if (!identity?.authenticated) fail('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401)
  return identity
}

function assertPreviewCapability(capabilities, id) {
  if (!capability(capabilities, id).enabled) fail('OUTBOUND_CAPABILITY_NOT_AVAILABLE', `${id} requires database persistence and explicit server enablement.`, 409)
}

function previewWarehouseIds(plan) {
  const fromQuantityPlans = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (value.warehouseId) fromQuantityPlans.push(value.warehouseId)
    Object.values(value).forEach(visit)
  }
  visit(plan.quantityPlans)
  return [...new Set([
    ...fromQuantityPlans,
    ...plan.balanceImpacts.map((impact) => impact.warehouseId || impact.allocation?.warehouseId || impact.reservation?.warehouseId),
    ...plan.reservationImpacts.map((impact) => impact.reservation?.warehouseId),
    ...(plan.shipment?.lines || []).flatMap((line) => (line.allocations || []).map((allocation) => allocation.warehouseId)),
  ].map(text).filter(Boolean))]
}

async function assertPreviewWarehouseAccess(prisma, resolved, plan) {
  const warehouseIds = previewWarehouseIds(plan)
  const owned = warehouseIds.length ? await prisma.warehouse.count({ where: { tenantId: resolved.tenantId, id: { in: warehouseIds } } }) : 0
  if (owned !== warehouseIds.length || !hasWarehouseAccess(resolved, warehouseIds, 'read')) fail('WAREHOUSE_SCOPE_DENIED', 'The requested outbound preview was not found.', 404)
  return previewModel(plan)
}

function previewModel(plan) {
  return {
    operation: plan.operation,
    allowed: plan.allowed,
    blockingIssues: plan.blockingIssues,
    warnings: plan.warnings,
    normalizedPlan: plan.normalizedPlan || null,
    balanceImpacts: plan.balanceImpacts.map((impact) => ({ balanceId: impact.balanceId, sku: impact.sku || impact.allocation?.reservation?.sku || impact.reservation?.sku, warehouseId: impact.warehouseId || impact.allocation?.warehouseId || impact.reservation?.warehouseId, location: impact.location || impact.allocation?.location || impact.reservation?.location || '', onHandBefore: impact.onHandBefore, onHandAfter: impact.onHandAfter, reservedBefore: impact.reservedBefore, reservedAfter: impact.reservedAfter, availableBefore: impact.availableBefore, availableAfter: impact.availableAfter })),
    reservationImpacts: plan.reservationImpacts.map((impact) => ({ reservationId: impact.reservationId, quantity: decimalString(impact.quantityUnits), allocatedBefore: impact.allocatedBefore ?? fixed(impact.reservation?.allocatedQuantity), allocatedAfter: impact.allocatedAfter ?? fixed(impact.reservation?.allocatedQuantity), consumedBefore: impact.consumedBefore ?? fixed(impact.reservation?.consumedQuantity), consumedAfter: impact.consumedAfter ?? fixed(impact.reservation?.consumedQuantity), releasedBefore: impact.releasedBefore ?? fixed(impact.reservation?.releasedQuantity), releasedAfter: impact.releasedAfter ?? fixed(impact.reservation?.releasedQuantity), statusAfter: impact.statusAfter })),
    salesOrderLineImpacts: plan.salesOrderLineImpacts.map((impact) => ({ salesOrderLineId: impact.salesOrderLineId, quantity: decimalString(impact.quantityUnits), reservedBefore: impact.reservedBefore, reservedAfter: impact.reservedAfter, fulfilledBefore: impact.fulfilledBefore, fulfilledAfter: impact.fulfilledAfter })),
    salesOrderStatusImpacts: plan.salesOrderStatusImpacts,
    shipmentImpacts: plan.shipmentImpacts,
    factsToCreate: plan.factsToCreate,
    limitations: ['Negative inventory, direct shipment without reservation, lot/serial allocation, picking, costing, and outbound UI are not supported in this beta.'],
  }
}

export function createOutboundQueryService({ prisma, capabilities = {} } = {}) {
  if (!prisma) throw new Error('prisma is required')

  async function actor(context) { return resolveProvisionedActor(prisma, identityFrom(context)) }
  // Order state and the reservation and shipment-draft previews read the
  // order (sales_order.read); shipment state and the shipment previews read
  // the shipment (shipment.read). The commands check their own permissions.
  async function reader(context, permission) {
    const resolved = await actor(context)
    assertAuthorized({ actor: resolved, permission, tenantId: resolved.tenantId })
    return resolved
  }

  async function getSalesOrderOutboundState({ salesOrderId }, context) {
    const resolved = await reader(context, 'sales_order.read')
    const order = await prisma.salesOrder.findFirst({ where: { id: text(salesOrderId), tenantId: resolved.tenantId }, include: { lines: { orderBy: { id: 'asc' } }, reservations: { orderBy: { id: 'asc' } }, shipments: { orderBy: { createdAt: 'asc' } } } })
    if (!order) fail('SALES_ORDER_NOT_FOUND', 'Sales order was not found.', 404)
    assertWarehouseAccess(resolved, order.reservations.map((reservation) => reservation.warehouseId), 'read', { maskExistence: true })
    return {
      salesOrder: { id: order.id, orderNumber: order.orderNumber, workflowStatus: order.workflowStatus, reservationStatus: order.reservationStatus, fulfillmentStatus: order.fulfillmentStatus, promisedDate: order.promisedDate, currency: order.currency, version: order.version },
      lines: order.lines.map((line) => { const ordered = decimalUnits(line.orderedQuantity), reserved = decimalUnits(line.reservedQuantity), fulfilled = decimalUnits(line.fulfilledQuantity); return { id: line.id, sku: line.sku, itemName: line.itemName, orderedQuantity: decimalString(ordered), reservedQuantity: decimalString(reserved), fulfilledQuantity: decimalString(fulfilled), remainingToReserve: decimalString(ordered - reserved - fulfilled), remainingToFulfill: decimalString(ordered - fulfilled), version: line.version } }),
      reservations: order.reservations.map((reservation) => { const reserved = decimalUnits(reservation.reservedQuantity), allocated = decimalUnits(reservation.allocatedQuantity), consumed = decimalUnits(reservation.consumedQuantity), released = decimalUnits(reservation.releasedQuantity); return { id: reservation.id, salesOrderLineId: reservation.salesOrderLineId, sku: reservation.sku, warehouseId: reservation.warehouseId, location: reservation.location || '', reservedQuantity: decimalString(reserved), allocatedQuantity: decimalString(allocated), consumedQuantity: decimalString(consumed), releasedQuantity: decimalString(released), activeReservedQuantity: decimalString(reserved - consumed - released), allocatableQuantity: decimalString(reserved - consumed - released - allocated), status: reservation.status, version: reservation.version } }),
      shipments: order.shipments.map((shipment) => ({ id: shipment.id, shipmentNumber: shipment.shipmentNumber, workflowStatus: shipment.workflowStatus, postingStatus: shipment.postingStatus, version: shipment.version })),
      capabilities,
      limitations: ['Authoritative Sales Order creation and maintenance experience is a Phase 3.5 boundary.'],
    }
  }

  async function getShipmentPostingState({ shipmentId }, context) {
    const resolved = await reader(context, 'shipment.read')
    const shipment = await prisma.shipmentDocument.findFirst({ where: { id: text(shipmentId), tenantId: resolved.tenantId }, include: { lines: { orderBy: { id: 'asc' }, include: { allocations: { orderBy: { id: 'asc' } } } } } })
    if (!shipment) fail('SHIPMENT_NOT_FOUND', 'Shipment was not found.', 404)
    const allocations = shipment.lines.flatMap((line) => line.allocations)
    assertWarehouseAccess(resolved, allocations.map((allocation) => allocation.warehouseId), 'read', { maskExistence: true })
    const movements = await prisma.inventoryMovement.findMany({ where: { tenantId: resolved.tenantId, sourceDocumentId: shipment.id, movementType: { in: ['shipment_posting', 'shipment_reversal'] } }, orderBy: { createdAt: 'asc' } })
    const originals = new Map(movements.filter((movement) => movement.movementType === 'shipment_posting').map((movement) => [movement.sourceDocumentLineId, movement]))
    const reversals = new Map(movements.filter((movement) => movement.movementType === 'shipment_reversal').map((movement) => [movement.sourceDocumentLineId, movement]))
    return {
      shipment: { id: shipment.id, shipmentNumber: shipment.shipmentNumber, salesOrderId: shipment.salesOrderId, workflowStatus: shipment.workflowStatus, postingStatus: shipment.postingStatus, version: shipment.version, postedAt: shipment.postedAt, reversedAt: shipment.reversedAt, reversalReason: shipment.reversalReason },
      lines: shipment.lines.map((line) => ({ id: line.id, salesOrderLineId: line.salesOrderLineId, sku: line.sku, requestedQuantity: fixed(line.requestedQuantity), postedQuantity: fixed(line.postedQuantity), unit: line.unit, version: line.version })),
      allocations: allocations.map((allocation) => ({ id: allocation.id, reservationId: allocation.reservationId, warehouseId: allocation.warehouseId, location: allocation.location || '', quantity: fixed(allocation.quantity), status: allocation.status, movementId: originals.get(allocation.id)?.id || null, reversalMovementId: reversals.get(allocation.id)?.id || null })),
      postingBatchId: movements.find((movement) => movement.postingBatchId)?.postingBatchId || null,
      capabilities,
      limitations: [],
    }
  }

  async function previewSalesOrderReservation(input, context) { const resolved = await reader(context, 'sales_order.read'); assertPreviewCapability(capabilities, 'sales-reservation'); return assertPreviewWarehouseAccess(prisma, resolved, await buildSalesOrderReservationPlan({ prisma, tenantId: resolved.tenantId, ...input })) }
  async function previewReservationRelease(input, context) { const resolved = await reader(context, 'sales_order.read'); assertPreviewCapability(capabilities, 'sales-reservation'); return assertPreviewWarehouseAccess(prisma, resolved, await buildReservationReleasePlan({ prisma, tenantId: resolved.tenantId, ...input })) }
  async function previewShipmentDraft(input, context) { const resolved = await reader(context, 'sales_order.read'); assertPreviewCapability(capabilities, 'sales-shipment-draft'); return assertPreviewWarehouseAccess(prisma, resolved, await buildShipmentDraftPlan({ prisma, tenantId: resolved.tenantId, ...input })) }
  async function previewShipmentCancellation(input, context) { const resolved = await reader(context, 'shipment.read'); assertPreviewCapability(capabilities, 'sales-shipment-draft'); return assertPreviewWarehouseAccess(prisma, resolved, await buildShipmentCancellationPlan({ prisma, tenantId: resolved.tenantId, ...input })) }
  async function previewShipmentPosting(input, context) { const resolved = await reader(context, 'shipment.read'); assertPreviewCapability(capabilities, 'sales-shipment-posting'); return assertPreviewWarehouseAccess(prisma, resolved, await buildShipmentPostingPlan({ prisma, tenantId: resolved.tenantId, ...input })) }
  async function previewShipmentReversal(input, context) { const resolved = await reader(context, 'shipment.read'); assertPreviewCapability(capabilities, 'sales-shipment-reversal'); return assertPreviewWarehouseAccess(prisma, resolved, await buildShipmentReversalPlan({ prisma, tenantId: resolved.tenantId, ...input })) }

  return { getSalesOrderOutboundState, getShipmentPostingState, previewSalesOrderReservation, previewReservationRelease, previewShipmentDraft, previewShipmentCancellation, previewShipmentPosting, previewShipmentReversal }
}
