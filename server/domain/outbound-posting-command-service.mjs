import { createHash, randomUUID } from 'node:crypto'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { assertWarehouseAccess, resolveProvisionedActor } from './pilot-identity.mjs'
import {
  buildReservationReleasePlan,
  buildSalesOrderReservationPlan,
  buildShipmentCancellationPlan,
  buildShipmentDraftPlan,
  buildShipmentPostingPlan,
  buildShipmentReversalPlan,
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
  outboundReservationStatus,
  outboundText as text,
} from './outbound-transaction-policy.mjs'

export const OUTBOUND_COMMAND_TYPES = Object.freeze({
  reserve: 'reserve_sales_order_inventory',
  release: 'release_sales_order_reservation',
  draft: 'create_shipment_draft',
  cancel: 'cancel_shipment_draft',
  post: 'post_sales_shipment',
  reverse: 'reverse_sales_shipment',
})
const commandPermissions = Object.freeze({
  [OUTBOUND_COMMAND_TYPES.reserve]: 'shipment.prepare',
  [OUTBOUND_COMMAND_TYPES.release]: 'shipment.prepare',
  [OUTBOUND_COMMAND_TYPES.draft]: 'shipment.prepare',
  [OUTBOUND_COMMAND_TYPES.cancel]: 'shipment.prepare',
  [OUTBOUND_COMMAND_TYPES.post]: 'shipment.post',
  [OUTBOUND_COMMAND_TYPES.reverse]: 'shipment.reverse',
})

export class OutboundCommandError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'OutboundCommandError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const fail = (code, message, status = 400, details) => { throw new OutboundCommandError(code, message, status, details) }

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  return value
}

export const outboundRequestHash = (value) => createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
const executionWhere = (tenantId, commandType, idempotencyKey) => ({ tenantId_commandType_idempotencyKey: { tenantId, commandType, idempotencyKey } })
const quantity = (value, label = 'quantity') => {
  try { const units = decimalUnits(value); if (units <= 0n) fail('RESERVATION_VALIDATION_FAILED', `${label} must be positive.`, 422); return decimalString(units) }
  catch (error) { if (error instanceof OutboundCommandError) throw error; fail('RESERVATION_VALIDATION_FAILED', `${label} must be a positive quantity with at most four decimal places.`, 422) }
}
const required = (value, label, code = 'RESERVATION_VALIDATION_FAILED') => { const result = text(value); if (!result) fail(code, `${label} is required.`, code === 'IDEMPOTENCY_KEY_REQUIRED' ? 400 : 422); return result }
const expectedVersion = (value, label) => { const version = Number(value); if (!Number.isInteger(version) || version < 0) fail('RESERVATION_VALIDATION_FAILED', `${label} must be a non-negative integer.`, 422); return version }

function mutationScope(identity) {
  if (!identity?.authenticated || !text(identity.tenantId) || !text(identity.userId)) fail('ACTOR_NOT_PROVISIONED', 'A signed, provisioned actor is required.', 403)
  return { tenantId: text(identity.tenantId), actorId: text(identity.userId), identity }
}

function assertEnabled(env) {
  if (text(env.FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING).toLowerCase() !== 'true') {
    fail('OUTBOUND_CAPABILITY_NOT_AVAILABLE', 'Database outbound posting is not enabled for this runtime.', 409)
  }
}

function normalizeInput(commandType, input = {}) {
  const idempotencyKey = required(input.idempotencyKey, 'idempotencyKey', 'IDEMPOTENCY_KEY_REQUIRED')
  let payload
  if (commandType === OUTBOUND_COMMAND_TYPES.reserve) payload = {
    salesOrderId: required(input.salesOrderId, 'salesOrderId'), expectedOrderVersion: expectedVersion(input.expectedOrderVersion, 'expectedOrderVersion'),
    allocations: (input.allocations || []).map((entry) => ({ salesOrderLineId: required(entry.salesOrderLineId, 'salesOrderLineId'), warehouseId: required(entry.warehouseId, 'warehouseId'), location: text(entry.location), quantity: quantity(entry.quantity) })),
  }
  else if (commandType === OUTBOUND_COMMAND_TYPES.release) payload = {
    salesOrderId: required(input.salesOrderId, 'salesOrderId'), expectedOrderVersion: expectedVersion(input.expectedOrderVersion, 'expectedOrderVersion'), reason: required(input.reason, 'reason'),
    releases: (input.releases || []).map((entry) => ({ reservationId: required(entry.reservationId, 'reservationId'), quantity: quantity(entry.quantity), expectedReservationVersion: expectedVersion(entry.expectedReservationVersion, 'expectedReservationVersion') })),
  }
  else if (commandType === OUTBOUND_COMMAND_TYPES.draft) payload = {
    salesOrderId: required(input.salesOrderId, 'salesOrderId'), shipmentNumber: required(input.shipmentNumber, 'shipmentNumber'), expectedOrderVersion: expectedVersion(input.expectedOrderVersion, 'expectedOrderVersion'),
    lines: (input.lines || []).map((line) => ({ salesOrderLineId: required(line.salesOrderLineId, 'salesOrderLineId'), allocations: (line.allocations || []).map((entry) => ({ reservationId: required(entry.reservationId, 'reservationId'), quantity: quantity(entry.quantity) })) })),
  }
  else if (commandType === OUTBOUND_COMMAND_TYPES.cancel) payload = { shipmentId: required(input.shipmentId, 'shipmentId'), expectedShipmentVersion: expectedVersion(input.expectedShipmentVersion, 'expectedShipmentVersion'), reason: required(input.reason, 'reason') }
  else if (commandType === OUTBOUND_COMMAND_TYPES.post) payload = { shipmentId: required(input.shipmentId, 'shipmentId'), expectedShipmentVersion: expectedVersion(input.expectedShipmentVersion, 'expectedShipmentVersion') }
  else if (commandType === OUTBOUND_COMMAND_TYPES.reverse) payload = { shipmentId: required(input.shipmentId, 'shipmentId'), expectedShipmentVersion: expectedVersion(input.expectedShipmentVersion, 'expectedShipmentVersion'), reason: required(input.reason, 'reason') }
  else fail('RESERVATION_VALIDATION_FAILED', 'Unknown outbound command type.', 422)
  return { idempotencyKey, payload, requestHash: outboundRequestHash(payload) }
}

function replay(execution, hash) {
  if (!execution) return null
  if (execution.requestHash !== hash) fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'The idempotency key was already used with a different payload.', 409)
  if (execution.status !== 'completed' || !execution.resultPayload) fail('COMMAND_EXECUTION_IN_PROGRESS', 'The command is already in progress.', 409)
  return { ...execution.resultPayload, idempotentReplay: true }
}

const isConcurrencyError = (error) => error?.code === 'P2034' || (error?.code === 'P2010' && /40001|40P01|serialization|deadlock/i.test(JSON.stringify(error?.meta || error))) || /serialization|deadlock|write conflict/i.test(text(error?.message))
const isUniqueError = (error) => error?.code === 'P2002'
const isShipmentNumberConflict = (error) => isUniqueError(error) && /shipmentNumber|ShipmentDocument_tenantId_shipmentNumber/i.test(JSON.stringify(error?.meta || error))

async function lockIds(tx, table, tenantId, ids) {
  for (const id of [...new Set(ids.map(text).filter(Boolean))].sort()) {
    const rows = await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`, tenantId, id)
    if (!rows.length) return false
  }
  return true
}

async function lockChildIds(tx, table, ids) {
  for (const id of [...new Set(ids.map(text).filter(Boolean))].sort()) await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id)
}

async function lockBalanceKeys(tx, tenantId, keys) {
  const normalized = keys.map((key) => ({ tenantId, sku: text(key.sku || key.reservation?.sku), warehouseId: text(key.warehouseId), locationKey: text(key.locationKey) }))
    .sort((a, b) => `${a.tenantId}|${a.sku}|${a.warehouseId}|${a.locationKey}`.localeCompare(`${b.tenantId}|${b.sku}|${b.warehouseId}|${b.locationKey}`))
  for (const key of normalized) await tx.$queryRawUnsafe('SELECT "id" FROM "InventoryBalance" WHERE "tenantId" = $1 AND "sku" = $2 AND "warehouseKey" = $3 AND "locationKey" = $4 FOR UPDATE', key.tenantId, key.sku, key.warehouseId, key.locationKey)
}

async function lockOrderAggregate(tx, tenantId, salesOrderId, lineIds = []) {
  if (!await lockIds(tx, 'SalesOrder', tenantId, [salesOrderId])) fail('SALES_ORDER_NOT_FOUND', 'Sales order was not found.', 404)
  await lockChildIds(tx, 'SalesOrderLine', lineIds)
}

async function lockShipmentAggregate(tx, tenantId, shipmentId) {
  if (!await lockIds(tx, 'ShipmentDocument', tenantId, [shipmentId])) fail('SHIPMENT_NOT_FOUND', 'Shipment was not found.', 404)
  const lines = await tx.shipmentLine.findMany({ where: { shipmentId }, select: { id: true, salesOrderLineId: true } })
  await lockChildIds(tx, 'ShipmentLine', lines.map((line) => line.id))
  const allocations = await tx.shipmentAllocation.findMany({ where: { tenantId, shipmentLineId: { in: lines.map((line) => line.id) } }, select: { id: true, reservationId: true, warehouseId: true, locationKey: true, reservation: { select: { sku: true } } } })
  await lockIds(tx, 'ShipmentAllocation', tenantId, allocations.map((allocation) => allocation.id))
  await lockIds(tx, 'InventoryReservation', tenantId, allocations.map((allocation) => allocation.reservationId))
  return { lines, allocations }
}

function enforce(plan) {
  if (!plan.allowed) { const issue = plan.blockingIssues[0]; fail(issue.code, issue.message, issue.status || 422, issue.details) }
  return plan
}

function plainReservation(reservation) {
  return { id: reservation.id, salesOrderId: reservation.salesOrderId, salesOrderLineId: reservation.salesOrderLineId, sku: reservation.sku, warehouseId: reservation.warehouseId, location: reservation.location || '', reservedQuantity: decimalString(decimalUnits(reservation.reservedQuantity)), allocatedQuantity: decimalString(decimalUnits(reservation.allocatedQuantity)), consumedQuantity: decimalString(decimalUnits(reservation.consumedQuantity)), releasedQuantity: decimalString(decimalUnits(reservation.releasedQuantity)), status: reservation.status, version: reservation.version }
}

function auditData({ idFactory, tenantId, actorId, action, entityType, entityId, summary, commandType, idempotencyKey, metadata = {} }) {
  return { id: idFactory(), tenantId, actorId, source: 'outbound_command_service', module: 'sales_outbound', action, entityType, entityId, summary, metadata: { commandType, idempotencyKey, ...metadata } }
}

export function createOutboundPostingCommandService({ prisma, env = process.env, idFactory = randomUUID, now = () => new Date(), faultInjector = async () => {} } = {}) {
  if (!prisma) throw new Error('prisma is required')

  async function execute(commandType, input, context, work) {
    assertEnabled(env)
    const scope = mutationScope(context?.identity || context)
    // Finish any one-time legacy assignment provisioning before opening the
    // serializable business transaction so concurrent commands share it.
    await resolveProvisionedActor(prisma, scope.identity)
    const normalized = normalizeInput(commandType, input)
    const existing = await prisma.businessCommandExecution.findUnique({ where: executionWhere(scope.tenantId, commandType, normalized.idempotencyKey) })
    const existingReplay = replay(existing, normalized.requestHash)
    if (existingReplay) return existingReplay
    try {
      return await prisma.$transaction(async (tx) => {
        const actor = await resolveProvisionedActor(tx, scope.identity)
        assertAuthorized({ actor, permission: commandPermissions[commandType], tenantId: actor.tenantId })
        const inside = await tx.businessCommandExecution.findUnique({ where: executionWhere(scope.tenantId, commandType, normalized.idempotencyKey) })
        const insideReplay = replay(inside, normalized.requestHash)
        if (insideReplay) return insideReplay
        const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: scope.tenantId, commandType, idempotencyKey: normalized.idempotencyKey, requestHash: normalized.requestHash, status: 'pending' } })
        await tx.$queryRawUnsafe('SELECT "id" FROM "BusinessCommandExecution" WHERE "id" = $1 FOR UPDATE', execution.id)
        const result = await work(tx, actor, normalized.payload, normalized, execution)
        await faultInjector('before_command_complete', { tx, commandType, result })
        await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: 'completed', entityType: result.entityType, entityId: result.entityId, resultPayload: result, completedAt: now() } })
        return { ...result, idempotentReplay: false }
      }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 })
    } catch (error) {
      if (error instanceof OutboundCommandError || error?.name === 'PilotIdentityError') throw error
      if (isUniqueError(error)) {
        const concurrent = await prisma.businessCommandExecution.findUnique({ where: executionWhere(scope.tenantId, commandType, normalized.idempotencyKey) })
        const result = replay(concurrent, normalized.requestHash)
        if (result) return result
        if (isShipmentNumberConflict(error)) fail('SHIPMENT_NUMBER_CONFLICT', 'Shipment number is already in use for this workspace.', 409)
      }
      if (isConcurrencyError(error)) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Outbound inventory changed in another transaction. Retry with fresh state.', 409)
      throw error
    }
  }

  async function reserveSalesOrderInventory(input, context) {
    return execute(OUTBOUND_COMMAND_TYPES.reserve, input, context, async (tx, actor, payload, normalized, execution) => {
      const lineIds = payload.allocations.map((entry) => entry.salesOrderLineId)
      await lockOrderAggregate(tx, actor.tenantId, payload.salesOrderId, lineIds)
      const order = await tx.salesOrder.findFirst({ where: { id: payload.salesOrderId, tenantId: actor.tenantId }, include: { lines: true } })
      if (order.version !== payload.expectedOrderVersion) fail('SALES_ORDER_VERSION_CONFLICT', 'Sales order version does not match.', 409)
      const lineMap = new Map(order.lines.map((line) => [line.id, line]))
      await lockBalanceKeys(tx, actor.tenantId, payload.allocations.map((entry) => ({ ...entry, sku: lineMap.get(entry.salesOrderLineId)?.sku, locationKey: text(entry.location).toLowerCase() })))
      const plan = enforce(await buildSalesOrderReservationPlan({ prisma: tx, tenantId: actor.tenantId, ...payload }))
      assertWarehouseAccess(actor, plan.quantityPlans.map((entry) => entry.warehouseId), 'operate')
      for (const impact of plan.balanceImpacts) {
        const updated = await tx.inventoryBalance.updateMany({ where: { id: impact.balanceId, tenantId: actor.tenantId, version: impact.version, availableQuantity: { gte: decimalString(impact.quantityUnits) } }, data: { reservedQuantity: impact.reservedAfter, availableQuantity: impact.availableAfter, version: { increment: 1 } } })
        if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Inventory balance changed during reservation.', 409)
      }
      for (const impact of plan.salesOrderLineImpacts) {
        const updated = await tx.salesOrderLine.updateMany({ where: { id: impact.salesOrderLineId, salesOrderId: order.id, version: impact.version }, data: { reservedQuantity: impact.reservedAfter, version: { increment: 1 } } })
        if (updated.count !== 1) fail('SALES_ORDER_VERSION_CONFLICT', 'Sales order line changed during reservation.', 409)
      }
      const reservations = []
      for (const entry of plan.quantityPlans) {
        const reservation = await tx.inventoryReservation.create({ data: { id: idFactory(), tenantId: actor.tenantId, salesOrderId: order.id, salesOrderLineId: entry.salesOrderLineId, itemId: entry.itemId, sku: entry.sku, warehouseId: entry.warehouseId, location: entry.location || null, locationKey: entry.locationKey, reservedQuantity: decimalString(entry.quantity), allocatedQuantity: '0', consumedQuantity: '0', releasedQuantity: '0', status: 'active', reservedById: actor.user.id } })
        reservations.push(reservation)
        await tx.inventoryReservationEvent.create({ data: { id: idFactory(), tenantId: actor.tenantId, reservationId: reservation.id, eventType: 'reserved', quantity: decimalString(entry.quantity), commandType: OUTBOUND_COMMAND_TYPES.reserve, commandExecutionId: execution.id, actorId: actor.user.id } })
      }
      const orderUpdated = await tx.salesOrder.updateMany({ where: { id: order.id, tenantId: actor.tenantId, version: order.version }, data: { reservationStatus: plan.salesOrderStatusImpacts.after.reservationStatus, version: { increment: 1 } } })
      if (orderUpdated.count !== 1) fail('SALES_ORDER_VERSION_CONFLICT', 'Sales order changed during reservation.', 409)
      const audit = auditData({ idFactory, tenantId: actor.tenantId, actorId: actor.user.id, action: 'sales_inventory_reserved', entityType: 'SalesOrder', entityId: order.id, summary: `Inventory reserved for sales order ${order.orderNumber}.`, commandType: OUTBOUND_COMMAND_TYPES.reserve, idempotencyKey: normalized.idempotencyKey, metadata: { reservationIds: reservations.map((entry) => entry.id), balanceIds: plan.balanceImpacts.map((entry) => entry.balanceId) } })
      await tx.auditLog.create({ data: audit })
      return { entityType: 'SalesOrder', entityId: order.id, salesOrder: { id: order.id, version: order.version + 1, reservationStatus: plan.salesOrderStatusImpacts.after.reservationStatus, fulfillmentStatus: order.fulfillmentStatus }, reservations: reservations.map(plainReservation), auditEventId: audit.id }
    })
  }

  async function releaseSalesOrderReservation(input, context) {
    return execute(OUTBOUND_COMMAND_TYPES.release, input, context, async (tx, actor, payload, normalized, execution) => {
      await lockOrderAggregate(tx, actor.tenantId, payload.salesOrderId)
      const order = await tx.salesOrder.findFirst({ where: { id: payload.salesOrderId, tenantId: actor.tenantId } })
      if (order.version !== payload.expectedOrderVersion) fail('SALES_ORDER_VERSION_CONFLICT', 'Sales order version does not match.', 409)
      if (!await lockIds(tx, 'InventoryReservation', actor.tenantId, payload.releases.map((entry) => entry.reservationId))) fail('RESERVATION_NOT_FOUND', 'Reservation was not found.', 404)
      const reservations = await tx.inventoryReservation.findMany({ where: { tenantId: actor.tenantId, id: { in: payload.releases.map((entry) => entry.reservationId) } } })
      await lockChildIds(tx, 'SalesOrderLine', reservations.map((entry) => entry.salesOrderLineId))
      await lockBalanceKeys(tx, actor.tenantId, reservations)
      const plan = enforce(await buildReservationReleasePlan({ prisma: tx, tenantId: actor.tenantId, ...payload }))
      assertWarehouseAccess(actor, plan.reservationImpacts.map((entry) => entry.reservation.warehouseId), 'operate')
      for (const impact of plan.balanceImpacts) { const updated = await tx.inventoryBalance.updateMany({ where: { id: impact.balanceId, version: impact.version, reservedQuantity: { gte: decimalString(impact.quantityUnits) } }, data: { reservedQuantity: impact.reservedAfter, availableQuantity: impact.availableAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Inventory balance changed during release.', 409) }
      for (const impact of plan.salesOrderLineImpacts) { const updated = await tx.salesOrderLine.updateMany({ where: { id: impact.salesOrderLineId, version: impact.version, reservedQuantity: { gte: decimalString(impact.quantityUnits) } }, data: { reservedQuantity: impact.reservedAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('RESERVATION_QUANTITY_CONFLICT', 'Sales order line changed during release.', 409) }
      const changed = []
      for (const impact of plan.reservationImpacts) { const updated = await tx.inventoryReservation.updateMany({ where: { id: impact.reservationId, tenantId: actor.tenantId, version: impact.reservation.version }, data: { releasedQuantity: impact.releasedAfter, status: impact.statusAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('RESERVATION_VERSION_CONFLICT', 'Reservation changed during release.', 409); await tx.inventoryReservationEvent.create({ data: { id: idFactory(), tenantId: actor.tenantId, reservationId: impact.reservationId, eventType: 'released', quantity: decimalString(impact.quantityUnits), commandType: OUTBOUND_COMMAND_TYPES.release, commandExecutionId: execution.id, actorId: actor.user.id, reason: payload.reason } }); changed.push({ ...impact.reservation, releasedQuantity: impact.releasedAfter, status: impact.statusAfter, version: impact.reservation.version + 1 }) }
      await tx.salesOrder.update({ where: { id: order.id }, data: { reservationStatus: plan.salesOrderStatusImpacts.after.reservationStatus, version: { increment: 1 } } })
      const audit = auditData({ idFactory, tenantId: actor.tenantId, actorId: actor.user.id, action: 'sales_reservation_released', entityType: 'SalesOrder', entityId: order.id, summary: `Inventory reservation released: ${payload.reason}`, commandType: OUTBOUND_COMMAND_TYPES.release, idempotencyKey: normalized.idempotencyKey, metadata: { reservationIds: changed.map((entry) => entry.id), reason: payload.reason } }); await tx.auditLog.create({ data: audit })
      return { entityType: 'SalesOrder', entityId: order.id, salesOrder: { id: order.id, version: order.version + 1, reservationStatus: plan.salesOrderStatusImpacts.after.reservationStatus, fulfillmentStatus: order.fulfillmentStatus }, reservations: changed.map(plainReservation), auditEventId: audit.id }
    })
  }

  async function createShipmentDraft(input, context) {
    return execute(OUTBOUND_COMMAND_TYPES.draft, input, context, async (tx, actor, payload, normalized, execution) => {
      await lockOrderAggregate(tx, actor.tenantId, payload.salesOrderId, payload.lines.map((line) => line.salesOrderLineId))
      const order = await tx.salesOrder.findFirst({ where: { id: payload.salesOrderId, tenantId: actor.tenantId } })
      if (order.version !== payload.expectedOrderVersion) fail('SALES_ORDER_VERSION_CONFLICT', 'Sales order version does not match.', 409)
      const reservationIds = payload.lines.flatMap((line) => line.allocations.map((entry) => entry.reservationId))
      if (!await lockIds(tx, 'InventoryReservation', actor.tenantId, reservationIds)) fail('RESERVATION_NOT_FOUND', 'Reservation was not found.', 404)
      const plan = enforce(await buildShipmentDraftPlan({ prisma: tx, tenantId: actor.tenantId, ...payload }))
      assertWarehouseAccess(actor, plan.reservationImpacts.map((entry) => entry.reservation.warehouseId), 'operate')
      const shipment = await tx.shipmentDocument.create({ data: { id: idFactory(), tenantId: actor.tenantId, shipmentNumber: payload.shipmentNumber, salesOrderId: order.id, workflowStatus: 'ready', postingStatus: 'unposted' } })
      const allocations = []
      for (const linePlan of plan.quantityPlans) {
        const shipmentLine = await tx.shipmentLine.create({ data: { id: idFactory(), shipmentId: shipment.id, salesOrderLineId: linePlan.salesOrderLineId, itemId: linePlan.orderLine.itemId, sku: linePlan.orderLine.sku, requestedQuantity: decimalString(linePlan.requestedQuantityUnits), postedQuantity: '0', unit: linePlan.orderLine.unit } })
        for (const entry of linePlan.allocations) allocations.push(await tx.shipmentAllocation.create({ data: { id: idFactory(), tenantId: actor.tenantId, shipmentLineId: shipmentLine.id, reservationId: entry.reservationId, warehouseId: entry.reservation.warehouseId, location: entry.reservation.location, locationKey: entry.reservation.locationKey, quantity: decimalString(entry.quantityUnits), status: 'allocated' } }))
      }
      for (const impact of plan.reservationImpacts) { const updated = await tx.inventoryReservation.updateMany({ where: { id: impact.reservationId, version: impact.reservation.version }, data: { allocatedQuantity: impact.allocatedAfter, status: impact.statusAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Reservation changed during shipment allocation.', 409); await tx.inventoryReservationEvent.create({ data: { id: idFactory(), tenantId: actor.tenantId, reservationId: impact.reservationId, eventType: 'allocated', quantity: decimalString(impact.quantityUnits), commandType: OUTBOUND_COMMAND_TYPES.draft, commandExecutionId: execution.id, actorId: actor.user.id, metadata: { shipmentId: shipment.id } } }) }
      await tx.salesOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } })
      const audit = auditData({ idFactory, tenantId: actor.tenantId, actorId: actor.user.id, action: 'shipment_draft_created', entityType: 'ShipmentDocument', entityId: shipment.id, summary: `Shipment ${shipment.shipmentNumber} draft created.`, commandType: OUTBOUND_COMMAND_TYPES.draft, idempotencyKey: normalized.idempotencyKey, metadata: { salesOrderId: order.id, allocationIds: allocations.map((entry) => entry.id) } }); await tx.auditLog.create({ data: audit })
      return { entityType: 'ShipmentDocument', entityId: shipment.id, shipment: { id: shipment.id, shipmentNumber: shipment.shipmentNumber, workflowStatus: 'ready', postingStatus: 'unposted', version: shipment.version }, salesOrderVersion: order.version + 1, allocationIds: allocations.map((entry) => entry.id), auditEventId: audit.id }
    })
  }

  async function cancelShipmentDraft(input, context) {
    return execute(OUTBOUND_COMMAND_TYPES.cancel, input, context, async (tx, actor, payload, normalized, execution) => {
      const locked = await lockShipmentAggregate(tx, actor.tenantId, payload.shipmentId)
      const shipment = await tx.shipmentDocument.findFirst({ where: { id: payload.shipmentId, tenantId: actor.tenantId } })
      if (shipment.version !== payload.expectedShipmentVersion) fail('SHIPMENT_VERSION_CONFLICT', 'Shipment version does not match.', 409)
      const plan = enforce(await buildShipmentCancellationPlan({ prisma: tx, tenantId: actor.tenantId, ...payload }))
      assertWarehouseAccess(actor, locked.allocations.map((entry) => entry.warehouseId), 'operate')
      for (const impact of plan.reservationImpacts) { const updated = await tx.inventoryReservation.updateMany({ where: { id: impact.reservationId, version: impact.reservation.version }, data: { allocatedQuantity: impact.allocatedAfter, status: impact.statusAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Reservation changed during cancellation.', 409); await tx.inventoryReservationEvent.create({ data: { id: idFactory(), tenantId: actor.tenantId, reservationId: impact.reservationId, eventType: 'deallocated', quantity: decimalString(impact.quantityUnits), commandType: OUTBOUND_COMMAND_TYPES.cancel, commandExecutionId: execution.id, actorId: actor.user.id, reason: payload.reason, metadata: { shipmentId: shipment.id } } }) }
      await tx.shipmentAllocation.updateMany({ where: { tenantId: actor.tenantId, shipmentLineId: { in: locked.lines.map((line) => line.id) }, status: 'allocated' }, data: { status: 'deallocated', version: { increment: 1 } } })
      await tx.shipmentDocument.update({ where: { id: shipment.id }, data: { workflowStatus: 'cancelled', version: { increment: 1 }, metadata: { cancellationReason: payload.reason } } })
      const audit = auditData({ idFactory, tenantId: actor.tenantId, actorId: actor.user.id, action: 'shipment_draft_cancelled', entityType: 'ShipmentDocument', entityId: shipment.id, summary: `Shipment ${shipment.shipmentNumber} cancelled: ${payload.reason}`, commandType: OUTBOUND_COMMAND_TYPES.cancel, idempotencyKey: normalized.idempotencyKey }); await tx.auditLog.create({ data: audit })
      return { entityType: 'ShipmentDocument', entityId: shipment.id, shipment: { id: shipment.id, workflowStatus: 'cancelled', postingStatus: shipment.postingStatus, version: shipment.version + 1 }, auditEventId: audit.id }
    })
  }

  async function postShipment(input, context) {
    return execute(OUTBOUND_COMMAND_TYPES.post, input, context, async (tx, actor, payload, normalized, execution) => {
      const initial = await tx.shipmentDocument.findFirst({ where: { id: payload.shipmentId, tenantId: actor.tenantId } })
      if (!initial) fail('SHIPMENT_NOT_FOUND', 'Shipment was not found.', 404)
      await lockOrderAggregate(tx, actor.tenantId, initial.salesOrderId)
      const orderState = await tx.salesOrder.findFirst({ where: { id: initial.salesOrderId, tenantId: actor.tenantId }, select: { workflowStatus: true } })
      if (orderState?.workflowStatus === 'on_hold') fail('SALES_ORDER_ON_HOLD', 'Sales order is on hold and cannot be posted. Resume the order first.', 409)
      if (orderState?.workflowStatus !== 'confirmed') fail('SALES_ORDER_INVALID_STATE', 'Sales order must be confirmed before its shipment can be posted.', 409)
      const locked = await lockShipmentAggregate(tx, actor.tenantId, payload.shipmentId)
      await lockChildIds(tx, 'SalesOrderLine', locked.lines.map((line) => line.salesOrderLineId))
      const current = await tx.shipmentDocument.findFirst({ where: { id: payload.shipmentId, tenantId: actor.tenantId } })
      if (current.version !== payload.expectedShipmentVersion) fail('SHIPMENT_VERSION_CONFLICT', 'Shipment version does not match.', 409)
      await lockBalanceKeys(tx, actor.tenantId, locked.allocations)
      const plan = enforce(await buildShipmentPostingPlan({ prisma: tx, tenantId: actor.tenantId, ...payload }))
      assertWarehouseAccess(actor, locked.allocations.map((entry) => entry.warehouseId), 'operate')
      const postingBatchId = idFactory(), occurredAt = now(), movements = []
      for (const entry of plan.quantityPlans) {
        const { allocation } = entry; const line = allocation.shipmentLine; const reservation = allocation.reservation
        const orderLine = plan.shipment.salesOrder.lines.find((candidate) => candidate.id === line.salesOrderLineId)
        movements.push(await tx.inventoryMovement.create({ data: { id: idFactory(), tenantId: actor.tenantId, itemId: reservation.itemId, sku: reservation.sku, itemName: orderLine?.itemName || null, warehouseId: allocation.warehouseId, location: allocation.location, locationKey: allocation.locationKey, movementType: 'shipment_posting', movementLabel: 'Sales shipment posted', movementDate: occurredAt, occurredAt, sourceDocument: plan.shipment.shipmentNumber, sourceDocumentType: 'ShipmentDocument', sourceDocumentId: plan.shipment.id, sourceDocumentLineId: allocation.id, quantityIn: '0', quantityOut: decimalString(entry.quantityUnits), adjustmentQty: '0', status: 'posted', owner: actor.user.id, actorId: actor.user.id, unit: line.unit, relatedSalesOrderId: plan.shipment.salesOrderId, postingBatchId, inventoryImpact: 'decrease_on_hand_and_reserved_available_unchanged_v1' } }))
      }
      for (const impact of plan.balanceImpacts) { const updated = await tx.inventoryBalance.updateMany({ where: { id: impact.balanceId, version: impact.version, onHandQuantity: { gte: decimalString(impact.quantityUnits) }, reservedQuantity: { gte: decimalString(impact.quantityUnits) } }, data: { onHandQuantity: impact.onHandAfter, reservedQuantity: impact.reservedAfter, availableQuantity: impact.availableAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Inventory balance changed during posting.', 409) }
      for (const impact of plan.reservationImpacts) { const updated = await tx.inventoryReservation.updateMany({ where: { id: impact.reservationId, version: impact.reservation.version }, data: { allocatedQuantity: impact.allocatedAfter, consumedQuantity: impact.consumedAfter, status: impact.statusAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Reservation changed during posting.', 409); await tx.inventoryReservationEvent.create({ data: { id: idFactory(), tenantId: actor.tenantId, reservationId: impact.reservationId, eventType: 'consumed', quantity: decimalString(impact.quantityUnits), commandType: OUTBOUND_COMMAND_TYPES.post, commandExecutionId: execution.id, actorId: actor.user.id, metadata: { shipmentId: plan.shipment.id, postingBatchId } } }) }
      for (const impact of plan.salesOrderLineImpacts) { const updated = await tx.salesOrderLine.updateMany({ where: { id: impact.salesOrderLineId, version: impact.version }, data: { reservedQuantity: impact.reservedAfter, fulfilledQuantity: impact.fulfilledAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Sales order line changed during posting.', 409) }
      for (const impact of plan.shipmentLineImpacts) await tx.shipmentLine.update({ where: { id: impact.shipmentLineId }, data: { postedQuantity: impact.postedAfter, version: { increment: 1 } } })
      await tx.shipmentAllocation.updateMany({ where: { tenantId: actor.tenantId, shipmentLineId: { in: locked.lines.map((line) => line.id) }, status: 'allocated' }, data: { status: 'consumed', version: { increment: 1 } } })
      await tx.salesOrder.update({ where: { id: plan.shipment.salesOrderId }, data: { reservationStatus: plan.salesOrderStatusImpacts.after.reservationStatus, fulfillmentStatus: plan.salesOrderStatusImpacts.after.fulfillmentStatus, version: { increment: 1 } } })
      await tx.shipmentDocument.update({ where: { id: plan.shipment.id }, data: { postingStatus: 'posted', postedAt: occurredAt, postedById: actor.user.id, version: { increment: 1 } } })
      const audit = auditData({ idFactory, tenantId: actor.tenantId, actorId: actor.user.id, action: 'sales_shipment_posted', entityType: 'ShipmentDocument', entityId: plan.shipment.id, summary: `Shipment ${plan.shipment.shipmentNumber} posted.`, commandType: OUTBOUND_COMMAND_TYPES.post, idempotencyKey: normalized.idempotencyKey, metadata: { postingBatchId, movementIds: movements.map((entry) => entry.id) } }); await tx.auditLog.create({ data: audit })
      return { entityType: 'ShipmentDocument', entityId: plan.shipment.id, shipment: { id: plan.shipment.id, workflowStatus: plan.shipment.workflowStatus, postingStatus: 'posted', version: plan.shipment.version + 1 }, postingBatchId, movementIds: movements.map((entry) => entry.id), auditEventId: audit.id }
    })
  }

  async function reverseShipment(input, context) {
    return execute(OUTBOUND_COMMAND_TYPES.reverse, input, context, async (tx, actor, payload, normalized, execution) => {
      const initial = await tx.shipmentDocument.findFirst({ where: { id: payload.shipmentId, tenantId: actor.tenantId } })
      if (!initial) fail('SHIPMENT_NOT_FOUND', 'Shipment was not found.', 404)
      await lockOrderAggregate(tx, actor.tenantId, initial.salesOrderId)
      const locked = await lockShipmentAggregate(tx, actor.tenantId, payload.shipmentId)
      await lockChildIds(tx, 'SalesOrderLine', locked.lines.map((line) => line.salesOrderLineId))
      const current = await tx.shipmentDocument.findFirst({ where: { id: payload.shipmentId, tenantId: actor.tenantId } })
      if (current.version !== payload.expectedShipmentVersion) fail('SHIPMENT_VERSION_CONFLICT', 'Shipment version does not match.', 409)
      await lockBalanceKeys(tx, actor.tenantId, locked.allocations)
      const plan = enforce(await buildShipmentReversalPlan({ prisma: tx, tenantId: actor.tenantId, ...payload }))
      assertWarehouseAccess(actor, locked.allocations.map((entry) => entry.warehouseId), 'operate')
      const postingBatchId = idFactory(), occurredAt = now(), movements = []
      for (const entry of plan.quantityPlans) {
        const original = entry.movement, allocation = entry.allocation, reservation = allocation.reservation
        const reversal = await tx.inventoryMovement.create({ data: { id: idFactory(), tenantId: actor.tenantId, itemId: original.itemId || reservation.itemId, sku: original.sku, itemName: original.itemName, warehouseId: original.warehouseId, location: original.location, locationKey: original.locationKey, movementType: 'shipment_reversal', movementLabel: 'Sales shipment reversed', movementDate: occurredAt, occurredAt, sourceDocument: plan.shipment.shipmentNumber, sourceDocumentType: 'ShipmentDocument', sourceDocumentId: plan.shipment.id, sourceDocumentLineId: allocation.id, quantityIn: decimalString(entry.quantityUnits), quantityOut: '0', adjustmentQty: '0', status: 'posted', owner: actor.user.id, actorId: actor.user.id, unit: original.unit, relatedSalesOrderId: plan.shipment.salesOrderId, postingBatchId, reversalOfMovementId: original.id, inventoryImpact: 'increase_on_hand_and_reserved_available_unchanged_v1', reason: payload.reason } })
        await tx.inventoryMovement.update({ where: { id: original.id }, data: { reversedByMovementId: reversal.id } }); movements.push(reversal)
      }
      for (const impact of plan.balanceImpacts) { const updated = await tx.inventoryBalance.updateMany({ where: { id: impact.balanceId, version: impact.version }, data: { onHandQuantity: impact.onHandAfter, reservedQuantity: impact.reservedAfter, availableQuantity: impact.availableAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Inventory balance changed during reversal.', 409) }
      for (const impact of plan.reservationImpacts) { const updated = await tx.inventoryReservation.updateMany({ where: { id: impact.reservationId, version: impact.reservation.version }, data: { consumedQuantity: impact.consumedAfter, status: impact.statusAfter, version: { increment: 1 } } }); if (updated.count !== 1) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Reservation changed during reversal.', 409); await tx.inventoryReservationEvent.create({ data: { id: idFactory(), tenantId: actor.tenantId, reservationId: impact.reservationId, eventType: 'restored', quantity: decimalString(impact.quantityUnits), commandType: OUTBOUND_COMMAND_TYPES.reverse, commandExecutionId: execution.id, actorId: actor.user.id, reason: payload.reason, metadata: { shipmentId: plan.shipment.id, postingBatchId } } }) }
      for (const impact of plan.salesOrderLineImpacts) await tx.salesOrderLine.update({ where: { id: impact.salesOrderLineId }, data: { reservedQuantity: impact.reservedAfter, fulfilledQuantity: impact.fulfilledAfter, version: { increment: 1 } } })
      for (const impact of plan.shipmentLineImpacts) await tx.shipmentLine.update({ where: { id: impact.shipmentLineId }, data: { postedQuantity: impact.postedAfter, version: { increment: 1 } } })
      await tx.shipmentAllocation.updateMany({ where: { tenantId: actor.tenantId, shipmentLineId: { in: locked.lines.map((line) => line.id) }, status: 'consumed' }, data: { status: 'reversed', version: { increment: 1 } } })
      await tx.salesOrder.update({ where: { id: plan.shipment.salesOrderId }, data: { reservationStatus: plan.salesOrderStatusImpacts.after.reservationStatus, fulfillmentStatus: plan.salesOrderStatusImpacts.after.fulfillmentStatus, version: { increment: 1 } } })
      await tx.shipmentDocument.update({ where: { id: plan.shipment.id }, data: { postingStatus: 'reversed', reversedAt: occurredAt, reversedById: actor.user.id, reversalReason: payload.reason, version: { increment: 1 } } })
      const audit = auditData({ idFactory, tenantId: actor.tenantId, actorId: actor.user.id, action: 'sales_shipment_reversed', entityType: 'ShipmentDocument', entityId: plan.shipment.id, summary: `Shipment ${plan.shipment.shipmentNumber} reversed: ${payload.reason}`, commandType: OUTBOUND_COMMAND_TYPES.reverse, idempotencyKey: normalized.idempotencyKey, metadata: { postingBatchId, movementIds: movements.map((entry) => entry.id), reason: payload.reason } }); await tx.auditLog.create({ data: audit })
      return { entityType: 'ShipmentDocument', entityId: plan.shipment.id, shipment: { id: plan.shipment.id, workflowStatus: plan.shipment.workflowStatus, postingStatus: 'reversed', version: plan.shipment.version + 1, reversalReason: payload.reason }, postingBatchId, movementIds: movements.map((entry) => entry.id), auditEventId: audit.id }
    })
  }

  return { reserveSalesOrderInventory, releaseSalesOrderReservation, createShipmentDraft, cancelShipmentDraft, postShipment, reverseShipment }
}
