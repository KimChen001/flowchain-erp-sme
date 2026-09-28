import { createHash, randomUUID } from 'node:crypto'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import {
  buildReceivingPostingPlan,
  buildReceivingReversalPlan,
  RECEIVABLE_PO_STATUSES,
  RECEIVABLE_WORKFLOW_STATUSES,
  receivingDecimalString as decimalString,
  receivingDecimalUnits as decimalUnits,
  receivingFulfillmentStatus,
  receivingLocationKey as normalizeLocation,
  receivingMovementNetUnits,
  receivingWorkflowStatus,
} from './receiving-transaction-policy.mjs'

const POST_COMMAND = 'receiving.post'
const REVERSE_COMMAND = 'receiving.reverse'
export { RECEIVABLE_PO_STATUSES, RECEIVABLE_WORKFLOW_STATUSES }

export class ReceivingCommandError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'ReceivingCommandError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status = 400, details) {
  throw new ReceivingCommandError(code, message, status, details)
}

function text(value = '') {
  return String(value ?? '').trim()
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function feedRow({ tenantId, entityType, entityId, entityVersion = null, actorId, requestId, operation = 'upsert' }) {
  return { tenantId, entityType, entityId, operation, entityVersion, actorId, source: 'receiving_command_service', requestId, payloadHash: requestHash({ entityType, entityId, entityVersion, operation }), sensitivityGroups: [] }
}

function executionKey(tenantId, commandType, idempotencyKey) {
  return { tenantId_commandType_idempotencyKey: { tenantId, commandType, idempotencyKey } }
}

function balanceKey({ tenantId, sku, warehouseId, locationKey }) {
  return { tenantId_sku_warehouseKey_locationKey: { tenantId, sku, warehouseKey: text(warehouseId), locationKey } }
}

function plainBalance(balance) {
  return {
    id: balance.id,
    sku: balance.sku,
    warehouseId: balance.warehouseId,
    warehouseKey: balance.warehouseKey,
    location: balance.location,
    locationKey: balance.locationKey,
    onHandQuantity: decimalString(decimalUnits(balance.onHandQuantity)),
    availableQuantity: decimalString(decimalUnits(balance.availableQuantity)),
    reservedQuantity: decimalString(decimalUnits(balance.reservedQuantity)),
    version: balance.version,
  }
}

function plainMovement(movement) {
  return {
    id: movement.id,
    movementType: movement.movementType,
    sourceDocumentId: movement.sourceDocumentId,
    sourceDocumentLineId: movement.sourceDocumentLineId,
    sku: movement.sku,
    warehouseId: movement.warehouseId,
    location: movement.location,
    quantityIn: decimalString(decimalUnits(movement.quantityIn)),
    quantityOut: decimalString(decimalUnits(movement.quantityOut)),
    adjustmentQty: decimalString(decimalUnits(movement.adjustmentQty)),
    reversalOfMovementId: movement.reversalOfMovementId,
    reversedByMovementId: movement.reversedByMovementId,
    postingBatchId: movement.postingBatchId,
  }
}

function tenantContext(context = {}) {
  const identity = context.identity || context
  const tenantId = text(identity.tenantId)
  if (!identity.authenticated || !tenantId) {
    fail('TENANT_CONTEXT_REQUIRED', 'A server-resolved tenant context is required.', 403)
  }
  const actorId = text(identity.userId)
  if (!actorId) fail('TENANT_CONTEXT_REQUIRED', 'A server-resolved actor is required.', 403)
  return { tenantId, actorId, identity }
}

function commandInput(input, commandType) {
  const receivingDocumentId = text(input.receivingDocumentId)
  const idempotencyKey = text(input.idempotencyKey)
  if (!receivingDocumentId) fail('RECEIVING_VALIDATION_FAILED', 'receivingDocumentId is required.')
  if (!idempotencyKey) fail('RECEIVING_VALIDATION_FAILED', 'idempotencyKey is required.')
  const payload = commandType === POST_COMMAND
    ? { receivingDocumentId, expectedVersion: input.expectedVersion ?? null }
    : { receivingDocumentId, reason: text(input.reason) }
  if (commandType === REVERSE_COMMAND && !payload.reason) fail('RECEIVING_VALIDATION_FAILED', 'A reversal reason is required.')
  return { receivingDocumentId, idempotencyKey, payload, hash: requestHash(payload) }
}

function replay(existing, hash) {
  if (!existing) return null
  if (existing.requestHash !== hash) {
    fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'The idempotency key was already used with a different payload.', 409)
  }
  if (existing.status !== 'completed' || !existing.resultPayload) {
    fail('RECEIVING_CONCURRENT_POSTING_CONFLICT', 'The command is already in progress.', 409)
  }
  return { ...existing.resultPayload, idempotentReplay: true }
}

function isUniqueConflict(error) {
  return error?.code === 'P2002'
}

function isTransactionConflict(error) {
  return error?.code === 'P2034' || /serialization|deadlock|write conflict/i.test(text(error?.message))
}

async function ensureTenantAndActor(tx, { tenantId, actorId, identity }, { allowLocalActorBootstrap = false } = {}) {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })
  if (!tenant) fail('TENANT_CONTEXT_REQUIRED', 'The authenticated tenant is not provisioned.', 403)
  const existingActor = await tx.user.findUnique({ where: { id: actorId }, select: { tenantId: true, role: true, status: true } })
  if (existingActor && existingActor.tenantId !== tenantId) fail('TENANT_CONTEXT_REQUIRED', 'Actor and tenant context do not match.', 403)
  if (existingActor?.status === 'disabled') fail('USER_DISABLED', 'The workspace user is disabled.', 403)
  if (existingActor && text(existingActor.role).toLowerCase() !== text(identity.role).toLowerCase()) fail('SESSION_STALE', 'User authorization changed. Sign in again.', 401)
  if (!existingActor) {
    if (!allowLocalActorBootstrap) {
      fail('ACTOR_NOT_PROVISIONED', 'The authenticated actor is not provisioned for this tenant.', 403)
    }
    const safeActor = actorId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'actor'
    await tx.user.create({
      data: {
        id: actorId,
        tenantId,
        email: `${safeActor}@local.flowchain.invalid`,
        name: text(identity.name) || actorId,
        role: text(identity.role) || 'manager',
      },
    })
  }
}

async function assertOperateWarehouseScope(tx, scope, receivingDocument, { allowTestBypass = false } = {}) {
  if (allowTestBypass && scope.identity.source === 'test') return
  const warehouseIds = [...new Set([receivingDocument.warehouseId, ...receivingDocument.lines.map(line => line.warehouseId)].map(text).filter(Boolean))]
  const scopeCount = await tx.userWarehouseScope.count({ where: { tenantId: scope.tenantId, userId: scope.actorId, warehouseId: { in: warehouseIds }, accessLevel: 'operate' } })
  if (scopeCount !== warehouseIds.length) fail('WAREHOUSE_SCOPE_DENIED', 'The actor lacks operate access to every receiving warehouse.', 403)
}

function poStatus(lines, currentStatus, baseStatus) {
  const quantities = lines.map((line) => ({
    ordered: decimalUnits(line.orderedQuantity),
    received: decimalUnits(line.receivedQuantity),
  }))
  if (quantities.length && quantities.every((line) => line.received >= line.ordered)) return 'fully_received'
  if (quantities.some((line) => line.received > 0n)) return 'partially_received'
  return text(baseStatus) || (['partially_received', 'fully_received'].includes(currentStatus) ? 'approved' : currentStatus)
}

async function lockReceivingDocument(tx, tenantId, receivingDocumentId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "ReceivingDocument" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE',
    tenantId,
    receivingDocumentId,
  )
  if (!rows.length) fail('RECEIVING_NOT_FOUND', 'Receiving document was not found.', 404)
}

async function loadPostingAggregate(tx, tenantId, receivingDocumentId) {
  await lockReceivingDocument(tx, tenantId, receivingDocumentId)
  const receivingDocument = await tx.receivingDocument.findFirst({
    where: { id: receivingDocumentId, tenantId },
    include: { lines: true },
  })
  if (!receivingDocument) fail('RECEIVING_NOT_FOUND', 'Receiving document was not found.', 404)
  if (!receivingDocument.poId) fail('RECEIVING_VALIDATION_FAILED', 'Receiving document must reference a purchase order.')
  const purchaseOrder = await tx.purchaseOrder.findFirst({
    where: { id: receivingDocument.poId, tenantId },
    include: { lines: true },
  })
  if (!purchaseOrder) fail('RECEIVING_NOT_FOUND', 'Related purchase order was not found.', 404)
  return { receivingDocument, purchaseOrder }
}

function enforcePolicy(plan) {
  const blocked = plan.blockingIssues[0]
  if (blocked) fail(blocked.code, blocked.message, blocked.status || 400, blocked.details)
  return plan
}

function auditMetadata({ action, before, after, purchaseOrder, receivingDocument, postingBatchId, idempotencyKey, movements, balances, reason }) {
  const deltasByPoLine = new Map()
  for (const movement of movements) {
    const receivingLine = receivingDocument.lines.find((line) => line.id === movement.sourceDocumentLineId)
    const purchaseOrderLine = purchaseOrder.lines.find((line) => line.id === receivingLine?.purchaseOrderLineId)
    if (!purchaseOrderLine) continue
    const delta = decimalUnits(movement.quantityIn) - decimalUnits(movement.quantityOut)
    deltasByPoLine.set(purchaseOrderLine.id, (deltasByPoLine.get(purchaseOrderLine.id) || 0n) + delta)
  }
  const purchaseOrderLineChanges = [...deltasByPoLine.entries()].map(([purchaseOrderLineId, delta]) => {
    const purchaseOrderLine = purchaseOrder.lines.find((line) => line.id === purchaseOrderLineId)
    const receivedBefore = decimalUnits(purchaseOrderLine.receivedQuantity)
    return {
      purchaseOrderLineId,
      receivedBefore: decimalString(receivedBefore),
      receivedDelta: decimalString(delta),
      receivedAfter: decimalString(receivedBefore + delta),
    }
  })
  return {
    source: 'receiving_command_service',
    action,
    relatedPurchaseOrderId: purchaseOrder.id,
    relatedWarehouseIds: [...new Set(balances.map((balance) => balance.warehouseId))],
    postingBatchId,
    idempotencyKey,
    before,
    after,
    poWorkflowBefore: before.poWorkflowStatus ?? null,
    poWorkflowAfter: after.poWorkflowStatus ?? null,
    poFulfillmentBefore: before.poFulfillmentStatus ?? null,
    poFulfillmentAfter: after.poFulfillmentStatus ?? null,
    movementIds: movements.map((movement) => movement.id),
    purchaseOrderLineChanges,
    balanceChanges: balances.map((balance, index) => {
      const movement = movements[index]
      const delta = movement
        ? decimalUnits(movement.quantityIn) - decimalUnits(movement.quantityOut) + decimalUnits(movement.adjustmentQty)
        : 0n
      const afterOnHand = decimalUnits(balance.onHandQuantity)
      const afterAvailable = decimalUnits(balance.availableQuantity)
      return {
        balanceId: balance.id,
        sku: balance.sku,
        warehouseId: balance.warehouseId,
        locationKey: balance.locationKey,
        deltaOnHandQuantity: decimalString(delta),
        deltaAvailableQuantity: decimalString(delta),
        before: {
          onHandQuantity: decimalString(afterOnHand - delta),
          availableQuantity: decimalString(afterAvailable - delta),
        },
        after: {
          onHandQuantity: decimalString(afterOnHand),
          availableQuantity: decimalString(afterAvailable),
        },
      }
    }),
    reason: reason || null,
    receivingDocumentNumber: receivingDocument.documentNumber,
  }
}

// Reconciliation and the reversal ledger replay share one net-movement formula,
// receivingMovementNetUnits, so they cannot disagree about a location's on-hand.
export function calculateMovementBalance(movements = []) {
  return decimalString(movements.reduce((sum, movement) => sum + receivingMovementNetUnits(movement), 0n))
}

export { decimalUnits as receivingDecimalUnits, decimalString as receivingDecimalString }

export function createReceivingPostingCommandService({ prisma, now = () => new Date(), idFactory = randomUUID, faultInjector = async () => {}, env = process.env } = {}) {
  if (!prisma) throw new Error('Prisma client is required for receiving posting commands.')

  async function execute({ commandType, input, context, work }) {
    const scope = tenantContext(context)
    const normalized = commandInput(input, commandType)
    const lookup = executionKey(scope.tenantId, commandType, normalized.idempotencyKey)
    const existing = await prisma.businessCommandExecution.findUnique({ where: lookup })
    const existingReplay = replay(existing, normalized.hash)
    if (existingReplay) return existingReplay

    try {
      return await prisma.$transaction(async (tx) => {
        const allowLocalActorBootstrap = text(env.NODE_ENV).toLowerCase() === 'test' || ['1', 'true', 'yes'].includes(text(env.FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP).toLowerCase())
        await ensureTenantAndActor(tx, scope, { allowLocalActorBootstrap })
        const actor = await resolveProvisionedActor(tx, scope.identity)
        assertAuthorized({ actor, permission: commandType, tenantId: scope.tenantId })
        const executionId = idFactory()
        await tx.businessCommandExecution.create({
          data: {
            id: executionId,
            tenantId: scope.tenantId,
            commandType,
            idempotencyKey: normalized.idempotencyKey,
            requestHash: normalized.hash,
            status: 'pending',
            entityType: 'ReceivingDocument',
            entityId: normalized.receivingDocumentId,
          },
        })
        const result = await work(tx, scope, normalized)
        await tx.businessCommandExecution.update({
          where: { id: executionId },
          data: { status: 'completed', resultPayload: result, completedAt: now() },
        })
        return { ...result, idempotentReplay: false }
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (error instanceof ReceivingCommandError) throw error
      if (isUniqueConflict(error)) {
        const concurrent = await prisma.businessCommandExecution.findUnique({ where: lookup })
        const concurrentReplay = replay(concurrent, normalized.hash)
        if (concurrentReplay) return concurrentReplay
        fail('RECEIVING_CONCURRENT_POSTING_CONFLICT', 'Receiving was changed by another transaction.', 409)
      }
      if (isTransactionConflict(error)) fail('RECEIVING_CONCURRENT_POSTING_CONFLICT', 'Receiving was changed by another transaction.', 409)
      throw error
    }
  }

  async function postReceiving(input, context) {
    return execute({
      commandType: POST_COMMAND,
      input,
      context,
      work: async (tx, scope, normalized) => {
        const { receivingDocument, purchaseOrder } = await loadPostingAggregate(tx, scope.tenantId, normalized.receivingDocumentId)
        await assertOperateWarehouseScope(tx, scope, receivingDocument, { allowTestBypass: text(env.NODE_ENV).toLowerCase() === 'test' })
        if (receivingDocument.postingStatus !== 'unposted') {
          fail('RECEIVING_ALREADY_POSTED', 'Receiving document is already posted.', 409)
        }
        if (input.expectedVersion !== undefined && Number(input.expectedVersion) !== receivingDocument.version) {
          fail('RECEIVING_VERSION_CONFLICT', 'Receiving document version does not match.', 409)
        }
        const policy = enforcePolicy(await buildReceivingPostingPlan({ prisma: tx, tenantId: scope.tenantId, receivingDocument, purchaseOrder }))
        const plans = policy.quantityPlans
        const postingBatchId = idFactory()
        const occurredAt = now()
        const movements = []
        const balances = []
        const updatedPoLines = new Map(purchaseOrder.lines.map((line) => [line.id, { ...line }]))

        for (const plan of plans) {
          const quantity = decimalString(plan.accepted)
          const movement = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: scope.tenantId,
              itemId: plan.itemId,
              sku: plan.sku,
              itemName: plan.line.itemName || plan.poLine.itemName,
              warehouseId: plan.warehouseId,
              location: plan.location || null,
              locationKey: plan.locationKey,
              movementType: 'receipt_posting',
              movementLabel: 'Receiving posted',
              movementDate: occurredAt,
              occurredAt,
              sourceDocument: receivingDocument.documentNumber || receivingDocument.id,
              sourceDocumentType: 'receiving_document',
              sourceDocumentId: receivingDocument.id,
              sourceDocumentLineId: plan.line.id,
              quantityIn: quantity,
              quantityOut: '0',
              adjustmentQty: '0',
              status: 'posted',
              owner: scope.actorId,
              actorId: scope.actorId,
              unit: plan.line.unit || plan.poLine.unit,
              relatedPoId: purchaseOrder.id,
              relatedGrnId: receivingDocument.id,
              postingBatchId,
              inventoryImpact: 'increase_on_hand_and_available_v1',
              evidence: { receivingDocumentId: receivingDocument.id, purchaseOrderId: purchaseOrder.id, purchaseOrderLineId: plan.poLine.id },
              metadata: { acceptedQty: quantity, rejectedQty: decimalString(plan.rejected), v1Rule: 'acceptedQty increases onHandQuantity and availableQuantity' },
            },
          })
          movements.push(movement)
          const balance = await tx.inventoryBalance.upsert({
            where: balanceKey({ tenantId: scope.tenantId, sku: plan.sku, warehouseId: plan.warehouseId, locationKey: plan.locationKey }),
            create: {
              id: idFactory(), tenantId: scope.tenantId, itemId: plan.itemId, sku: plan.sku,
              itemName: plan.line.itemName || plan.poLine.itemName, warehouseId: plan.warehouseId,
              warehouseKey: plan.warehouseId,
              location: plan.location || null, locationKey: plan.locationKey,
              onHandQuantity: quantity, availableQuantity: quantity, reservedQuantity: '0',
              unit: plan.line.unit || plan.poLine.unit, status: 'available', version: 1,
            },
            update: {
              onHandQuantity: { increment: quantity }, availableQuantity: { increment: quantity },
              itemId: plan.itemId, itemName: plan.line.itemName || plan.poLine.itemName,
              location: plan.location || null, unit: plan.line.unit || plan.poLine.unit, version: { increment: 1 },
            },
          })
          balances.push(balance)
          const currentPoLine = updatedPoLines.get(plan.poLine.id)
          const nextReceived = decimalUnits(currentPoLine.receivedQuantity) + plan.accepted
          const updated = await tx.purchaseOrderLine.updateMany({
            where: { id: currentPoLine.id, purchaseOrderId: purchaseOrder.id, version: currentPoLine.version },
            data: { receivedQuantity: decimalString(nextReceived), version: { increment: 1 } },
          })
          if (updated.count !== 1) fail('RECEIVING_VERSION_CONFLICT', 'A purchase order line changed during receiving.', 409)
          updatedPoLines.set(plan.poLine.id, { ...currentPoLine, receivedQuantity: decimalString(nextReceived), version: currentPoLine.version + 1 })
        }

        await faultInjector('after_movements', { tx, receivingDocument, purchaseOrder, movements, balances })
        const poLines = [...updatedPoLines.values()]
        const nextPoStatus = poStatus(poLines, purchaseOrder.status, purchaseOrder.receivingBaseStatus)
        const poUpdated = await tx.purchaseOrder.updateMany({
          where: { id: purchaseOrder.id, tenantId: scope.tenantId, version: purchaseOrder.version },
          data: {
            status: nextPoStatus,
            receivingBaseStatus: purchaseOrder.receivingBaseStatus || purchaseOrder.status,
            version: { increment: 1 },
          },
        })
        if (poUpdated.count !== 1) fail('RECEIVING_VERSION_CONFLICT', 'Purchase order changed during receiving.', 409)
        const documentUpdated = await tx.receivingDocument.updateMany({
          where: { id: receivingDocument.id, tenantId: scope.tenantId, version: receivingDocument.version, postingStatus: 'unposted' },
          data: { postingStatus: 'posted', postedAt: occurredAt, postedById: scope.actorId, version: { increment: 1 } },
        })
        if (documentUpdated.count !== 1) fail('RECEIVING_CONCURRENT_POSTING_CONFLICT', 'Receiving was posted by another transaction.', 409)
        const auditId = idFactory()
        await tx.auditLog.create({
          data: {
            id: auditId, tenantId: scope.tenantId, actorId: scope.actorId, source: 'receiving_command_service',
            module: 'procurement_receiving', action: 'receiving_posted', entityType: 'ReceivingDocument', entityId: receivingDocument.id,
            summary: `Receiving ${receivingDocument.documentNumber || receivingDocument.id} posted to inventory.`,
            metadata: auditMetadata({
              action: 'receiving_posted', before: { postingStatus: receivingDocument.postingStatus, poStatus: purchaseOrder.status, poWorkflowStatus: receivingWorkflowStatus(purchaseOrder), poFulfillmentStatus: receivingFulfillmentStatus(purchaseOrder.lines) },
              after: { postingStatus: 'posted', poStatus: nextPoStatus, poWorkflowStatus: receivingWorkflowStatus({ ...purchaseOrder, status: nextPoStatus, receivingBaseStatus: purchaseOrder.receivingBaseStatus || purchaseOrder.status }), poFulfillmentStatus: receivingFulfillmentStatus(poLines) }, purchaseOrder, receivingDocument,
              postingBatchId, idempotencyKey: normalized.idempotencyKey, movements, balances,
            }),
          },
        })
        await tx.domainChangeFeed.createMany({ data: [
          feedRow({ tenantId: scope.tenantId, entityType: 'ReceivingDocument', entityId: receivingDocument.id, entityVersion: receivingDocument.version + 1, actorId: scope.actorId, requestId: normalized.idempotencyKey }),
          feedRow({ tenantId: scope.tenantId, entityType: 'PurchaseOrder', entityId: purchaseOrder.id, entityVersion: purchaseOrder.version + 1, actorId: scope.actorId, requestId: normalized.idempotencyKey }),
          ...poLines.map((line) => feedRow({ tenantId: scope.tenantId, entityType: 'PurchaseOrderLine', entityId: line.id, entityVersion: line.version, actorId: scope.actorId, requestId: normalized.idempotencyKey })),
          ...movements.map((movement) => feedRow({ tenantId: scope.tenantId, entityType: 'InventoryMovement', entityId: movement.id, actorId: scope.actorId, requestId: normalized.idempotencyKey })),
          ...balances.map((balance) => feedRow({ tenantId: scope.tenantId, entityType: 'InventoryBalance', entityId: balance.id, entityVersion: balance.version, actorId: scope.actorId, requestId: normalized.idempotencyKey })),
        ] })
        await faultInjector('after_audit', { tx, receivingDocument, purchaseOrder, movements, balances, auditId })
        return {
          receivingDocument: { id: receivingDocument.id, postingStatus: 'posted', workflowStatus: receivingDocument.workflowStatus, version: receivingDocument.version + 1 },
          purchaseOrder: { id: purchaseOrder.id, status: nextPoStatus, version: purchaseOrder.version + 1, lines: poLines.map((line) => ({ id: line.id, receivedQuantity: text(line.receivedQuantity) })) },
          movements: movements.map(plainMovement), affectedBalances: balances.map(plainBalance), auditEventId: auditId, postingBatchId,
        }
      },
    })
  }

  async function reverseReceiving(input, context) {
    return execute({
      commandType: REVERSE_COMMAND,
      input,
      context,
      work: async (tx, scope, normalized) => {
        const { receivingDocument, purchaseOrder } = await loadPostingAggregate(tx, scope.tenantId, normalized.receivingDocumentId)
        await assertOperateWarehouseScope(tx, scope, receivingDocument, { allowTestBypass: text(env.NODE_ENV).toLowerCase() === 'test' })
        const policy = enforcePolicy(await buildReceivingReversalPlan({ prisma: tx, tenantId: scope.tenantId, receivingDocument, purchaseOrder }))
        const originalMovements = policy.originalMovements

        const postingBatchId = idFactory()
        const occurredAt = now()
        const reversalMovements = []
        const balances = []
        const receivingLines = new Map(receivingDocument.lines.map((line) => [line.id, line]))
        const poLines = new Map(purchaseOrder.lines.map((line) => [line.id, { ...line }]))

        for (const original of originalMovements) {
          const quantity = decimalUnits(original.quantityIn)
          const key = balanceKey({ tenantId: scope.tenantId, sku: original.sku, warehouseId: original.warehouseId, locationKey: original.locationKey })
          const balance = await tx.inventoryBalance.findUnique({ where: key })
          if (!balance || decimalUnits(balance.onHandQuantity) < quantity || decimalUnits(balance.availableQuantity) < quantity) {
            fail('RECEIVING_REVERSAL_NOT_SAFE', 'Inventory balance is insufficient for a safe reversal.', 409)
          }
          const reversalId = idFactory()
          const reversal = await tx.inventoryMovement.create({
            data: {
              id: reversalId, tenantId: scope.tenantId, itemId: original.itemId, sku: original.sku,
              itemName: original.itemName, warehouseId: original.warehouseId, location: original.location,
              locationKey: original.locationKey, movementType: 'receipt_reversal', movementLabel: 'Receiving reversed',
              movementDate: occurredAt, occurredAt, sourceDocument: receivingDocument.documentNumber || receivingDocument.id,
              sourceDocumentType: 'receiving_document', sourceDocumentId: receivingDocument.id,
              sourceDocumentLineId: original.sourceDocumentLineId, quantityIn: '0', quantityOut: decimalString(quantity),
              adjustmentQty: '0', status: 'posted', owner: scope.actorId, actorId: scope.actorId, unit: original.unit,
              relatedPoId: purchaseOrder.id, relatedGrnId: receivingDocument.id, postingBatchId,
              reversalOfMovementId: original.id, inventoryImpact: 'decrease_on_hand_and_available_v1', reason: normalized.payload.reason,
              evidence: { reversalOfMovementId: original.id, receivingDocumentId: receivingDocument.id, purchaseOrderId: purchaseOrder.id },
              metadata: { reversalReason: normalized.payload.reason, v1Rule: 'receipt reversal decreases onHandQuantity and availableQuantity' },
            },
          })
          reversalMovements.push(reversal)
          // Posted movement facts are immutable. Reversal may only append the
          // reverse link; quantities, source identity, and movement type stay unchanged.
          await tx.inventoryMovement.update({ where: { id: original.id }, data: { reversedByMovementId: reversalId } })
          const balanceUpdated = await tx.inventoryBalance.updateMany({
            where: { id: balance.id, tenantId: scope.tenantId, version: balance.version, onHandQuantity: { gte: decimalString(quantity) }, availableQuantity: { gte: decimalString(quantity) } },
            data: { onHandQuantity: { decrement: decimalString(quantity) }, availableQuantity: { decrement: decimalString(quantity) }, version: { increment: 1 } },
          })
          if (balanceUpdated.count !== 1) fail('RECEIVING_REVERSAL_NOT_SAFE', 'Inventory balance changed during reversal.', 409)
          balances.push({ ...balance, onHandQuantity: decimalString(decimalUnits(balance.onHandQuantity) - quantity), availableQuantity: decimalString(decimalUnits(balance.availableQuantity) - quantity), version: balance.version + 1 })

          const receivingLine = receivingLines.get(original.sourceDocumentLineId)
          const poLine = receivingLine ? poLines.get(receivingLine.purchaseOrderLineId) : null
          if (!poLine || decimalUnits(poLine.receivedQuantity) < quantity) fail('RECEIVING_REVERSAL_NOT_SAFE', 'Purchase order received quantity cannot be safely reversed.', 409)
          const nextReceived = decimalUnits(poLine.receivedQuantity) - quantity
          const lineUpdated = await tx.purchaseOrderLine.updateMany({
            where: { id: poLine.id, purchaseOrderId: purchaseOrder.id, version: poLine.version, receivedQuantity: { gte: decimalString(quantity) } },
            data: { receivedQuantity: decimalString(nextReceived), version: { increment: 1 } },
          })
          if (lineUpdated.count !== 1) fail('RECEIVING_VERSION_CONFLICT', 'A purchase order line changed during reversal.', 409)
          poLines.set(poLine.id, { ...poLine, receivedQuantity: decimalString(nextReceived), version: poLine.version + 1 })
        }

        await faultInjector('after_reversal_movements', { tx, receivingDocument, purchaseOrder, reversalMovements, balances })
        const nextPoLines = [...poLines.values()]
        const nextPoStatus = poStatus(nextPoLines, purchaseOrder.status, purchaseOrder.receivingBaseStatus)
        const poUpdated = await tx.purchaseOrder.updateMany({
          where: { id: purchaseOrder.id, tenantId: scope.tenantId, version: purchaseOrder.version },
          data: { status: nextPoStatus, version: { increment: 1 } },
        })
        if (poUpdated.count !== 1) fail('RECEIVING_VERSION_CONFLICT', 'Purchase order changed during reversal.', 409)
        const documentUpdated = await tx.receivingDocument.updateMany({
          where: { id: receivingDocument.id, tenantId: scope.tenantId, version: receivingDocument.version, postingStatus: 'posted' },
          data: { postingStatus: 'reversed', reversedAt: occurredAt, reversedById: scope.actorId, reversalReason: normalized.payload.reason, version: { increment: 1 } },
        })
        if (documentUpdated.count !== 1) fail('RECEIVING_CONCURRENT_POSTING_CONFLICT', 'Receiving was changed by another transaction.', 409)
        const auditId = idFactory()
        await tx.auditLog.create({
          data: {
            id: auditId, tenantId: scope.tenantId, actorId: scope.actorId, source: 'receiving_command_service',
            module: 'procurement_receiving', action: 'receiving_reversed', entityType: 'ReceivingDocument', entityId: receivingDocument.id,
            summary: `Receiving ${receivingDocument.documentNumber || receivingDocument.id} reversed: ${normalized.payload.reason}`,
            metadata: auditMetadata({
              action: 'receiving_reversed', before: { postingStatus: receivingDocument.postingStatus, poStatus: purchaseOrder.status, poWorkflowStatus: receivingWorkflowStatus(purchaseOrder), poFulfillmentStatus: receivingFulfillmentStatus(purchaseOrder.lines) },
              after: { postingStatus: 'reversed', poStatus: nextPoStatus, poWorkflowStatus: receivingWorkflowStatus({ ...purchaseOrder, status: nextPoStatus }), poFulfillmentStatus: receivingFulfillmentStatus(nextPoLines) }, purchaseOrder, receivingDocument,
              postingBatchId, idempotencyKey: normalized.idempotencyKey, movements: reversalMovements, balances, reason: normalized.payload.reason,
            }),
          },
        })
        await tx.domainChangeFeed.createMany({ data: [
          feedRow({ tenantId: scope.tenantId, entityType: 'ReceivingDocument', entityId: receivingDocument.id, entityVersion: receivingDocument.version + 1, actorId: scope.actorId, requestId: normalized.idempotencyKey }),
          feedRow({ tenantId: scope.tenantId, entityType: 'PurchaseOrder', entityId: purchaseOrder.id, entityVersion: purchaseOrder.version + 1, actorId: scope.actorId, requestId: normalized.idempotencyKey }),
          ...nextPoLines.map((line) => feedRow({ tenantId: scope.tenantId, entityType: 'PurchaseOrderLine', entityId: line.id, entityVersion: line.version, actorId: scope.actorId, requestId: normalized.idempotencyKey })),
          ...reversalMovements.map((movement) => feedRow({ tenantId: scope.tenantId, entityType: 'InventoryMovement', entityId: movement.id, actorId: scope.actorId, requestId: normalized.idempotencyKey })),
          ...balances.map((balance) => feedRow({ tenantId: scope.tenantId, entityType: 'InventoryBalance', entityId: balance.id, entityVersion: balance.version, actorId: scope.actorId, requestId: normalized.idempotencyKey })),
        ] })
        return {
          receivingDocument: { id: receivingDocument.id, postingStatus: 'reversed', workflowStatus: receivingDocument.workflowStatus, version: receivingDocument.version + 1 },
          purchaseOrder: { id: purchaseOrder.id, status: nextPoStatus, version: purchaseOrder.version + 1, lines: nextPoLines.map((line) => ({ id: line.id, receivedQuantity: text(line.receivedQuantity) })) },
          movements: reversalMovements.map(plainMovement), affectedBalances: balances.map(plainBalance), auditEventId: auditId, postingBatchId,
        }
      },
    })
  }

  async function reconcileInventoryBalance({ tenantId, sku, warehouseId, location = '' } = {}) {
    const locationKey = normalizeLocation(location)
    const balance = await prisma.inventoryBalance.findUnique({ where: balanceKey({ tenantId, sku, warehouseId, locationKey }) })
    const movements = await prisma.inventoryMovement.findMany({ where: { tenantId, sku, warehouseId, locationKey, status: 'posted' } })
    const calculatedOnHandQuantity = calculateMovementBalance(movements)
    return {
      balance: balance ? plainBalance(balance) : null,
      calculatedOnHandQuantity,
      matches: Boolean(balance) && decimalUnits(balance.onHandQuantity) === decimalUnits(calculatedOnHandQuantity),
      movementIds: movements.map((movement) => movement.id),
    }
  }

  return { postReceiving, reverseReceiving, reconcileInventoryBalance }
}
