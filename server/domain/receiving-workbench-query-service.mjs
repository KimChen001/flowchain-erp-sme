import { ReceivingCommandError } from './receiving-posting-command-service.mjs'
import {
  buildReceivingPostingPlan,
  buildReceivingReversalPlan,
  receivingDecimalString,
  receivingDecimalUnits,
  receivingFulfillmentStatus,
  receivingLocationKey,
  receivingWorkflowStatus,
} from './receiving-transaction-policy.mjs'
import { assertWarehouseAccess, hasWarehouseAccess, resolveProvisionedActor } from './pilot-identity.mjs'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'

const ZERO = 0n
const text = (value = '') => String(value ?? '').trim()
const decimal = (value) => receivingDecimalString(receivingDecimalUnits(value ?? '0'))
const iso = (value) => value ? new Date(value).toISOString() : null
const add = (a, b) => receivingDecimalUnits(a) + receivingDecimalUnits(b)

function fail(code, message, status = 400, details) {
  throw new ReceivingCommandError(code, message, status, details)
}

function tenantScope(context = {}) {
  const identity = context.identity || context
  if (!identity?.authenticated) fail('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401)
  const tenantId = text(identity.tenantId)
  if (!tenantId) fail('TENANT_CONTEXT_REQUIRED', 'A server-resolved tenant context is required.', 403)
  return { tenantId, actorId: text(identity.userId), identity }
}

export const fulfillmentStatus = receivingFulfillmentStatus

export const workflowStatusOf = receivingWorkflowStatus

function lotSerialCapability(line) {
  return {
    state: line?.lotNumber || line?.serialData ? 'schema-ready' : 'not-requested',
    postingAvailable: false,
    message: 'Lot/Serial posting is not connected in this beta.',
  }
}

async function loadAggregate(prisma, tenantId, receivingDocumentId) {
  const receivingDocument = await prisma.receivingDocument.findFirst({ where: { id: receivingDocumentId, tenantId }, include: { lines: true } })
  if (!receivingDocument) fail('RECEIVING_NOT_FOUND', 'Receiving document was not found.', 404)
  const purchaseOrder = receivingDocument.poId
    ? await prisma.purchaseOrder.findFirst({ where: { id: receivingDocument.poId, tenantId }, include: { lines: true } })
    : null
  if (!purchaseOrder) fail('RECEIVING_NOT_FOUND', 'Related purchase order was not found.', 404)
  const warehouseIds = [...new Set([receivingDocument.warehouseId, ...receivingDocument.lines.map((line) => line.warehouseId)].filter(Boolean))]
  const warehouses = warehouseIds.length ? await prisma.warehouse.findMany({ where: { tenantId, id: { in: warehouseIds } } }) : []
  const supplier = receivingDocument.supplierId
    ? await prisma.supplier.findFirst({ where: { tenantId, id: receivingDocument.supplierId } })
    : null
  return { receivingDocument, purchaseOrder, warehouses: new Map(warehouses.map((row) => [row.id, row])), supplier }
}

function detailModel(aggregate, capabilities = {}, availableActions = {}) {
  const { receivingDocument: grn, purchaseOrder: po, warehouses, supplier } = aggregate
  const poLines = new Map(po.lines.map((line) => [line.id, line]))
  const posted = grn.postingStatus === 'posted'
  const documentAcceptedByPoLine = grn.lines.reduce((result, line) => {
    if (line.purchaseOrderLineId) result.set(line.purchaseOrderLineId, (result.get(line.purchaseOrderLineId) || ZERO) + receivingDecimalUnits(line.acceptedQty))
    return result
  }, new Map())
  const lines = grn.lines.map((line) => {
    const poLine = poLines.get(line.purchaseOrderLineId) || {}
    const accepted = receivingDecimalUnits(line.acceptedQty)
    const currentReceived = receivingDecimalUnits(poLine.receivedQuantity)
    const currentlyApplied = posted ? accepted : ZERO
    const documentCurrentlyApplied = posted ? (documentAcceptedByPoLine.get(line.purchaseOrderLineId) || ZERO) : ZERO
    const previous = currentReceived - documentCurrentlyApplied
    const remaining = receivingDecimalUnits(poLine.orderedQuantity) - currentReceived
    const warehouse = warehouses.get(line.warehouseId || grn.warehouseId)
    return {
      id: line.id,
      poLineId: line.purchaseOrderLineId,
      itemId: line.itemId,
      sku: line.sku,
      itemName: line.itemName,
      orderedQuantity: decimal(poLine.orderedQuantity),
      previouslyReceivedQuantity: receivingDecimalString(previous < ZERO ? ZERO : previous),
      documentAcceptedQuantity: decimal(line.acceptedQty),
      currentlyAppliedQuantity: receivingDecimalString(currentlyApplied),
      acceptedQuantity: decimal(line.acceptedQty),
      rejectedQuantity: decimal(line.rejectedQty),
      rejectionReason: text(line.metadata?.rejectionReason) || null,
      remainingReceivableQuantity: receivingDecimalString(remaining < ZERO ? ZERO : remaining),
      unit: line.unit || poLine.unit,
      warehouse: warehouse ? { id: warehouse.id, code: warehouse.code, name: warehouse.name } : null,
      location: line.location || '',
      lotSerialCapability: lotSerialCapability(line),
    }
  })
  return {
    receivingDocument: {
      id: grn.id, documentNumber: grn.documentNumber || grn.id, workflowStatus: grn.workflowStatus,
      postingStatus: grn.postingStatus, qualityStatus: grn.status, version: grn.version,
      arrivedAt: iso(grn.arrivedAt), postedAt: iso(grn.postedAt), postedById: grn.postedById,
      reversedAt: iso(grn.reversedAt), reversedById: grn.reversedById, reversalReason: grn.reversalReason,
      receiver: grn.receiver, supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.name } : { id: grn.supplierId, name: grn.supplierName || po.supplierName || 'Unknown' },
      warehouse: warehouses.get(grn.warehouseId) || null, currency: grn.currency,
    },
    purchaseOrder: {
      id: po.id, workflowStatus: workflowStatusOf(po), fulfillmentStatus: fulfillmentStatus(po.lines), version: po.version,
      supplier: { id: po.supplierId, name: po.supplierName || grn.supplierName || 'Unknown' }, expectedDate: iso(po.expectedDate),
    },
    lines,
    postingSummary: { lineCount: lines.length, acceptedQuantity: receivingDecimalString(lines.reduce((sum, line) => sum + receivingDecimalUnits(line.acceptedQuantity), ZERO)), rejectedQuantity: receivingDecimalString(lines.reduce((sum, line) => sum + receivingDecimalUnits(line.rejectedQuantity), ZERO)) },
    capabilities,
    availableActions,
    limitations: ['Lot/Serial posting is not connected in this beta.', 'PO workflow and fulfillment are derived separately while the legacy status column remains mixed.'],
  }
}

export function createReceivingWorkbenchQueryService({ prisma, capabilities = {} } = {}) {
  if (!prisma) throw new Error('Prisma client is required for receiving workbench queries.')

  async function authorizedAggregate(scope, receivingDocumentId) {
    const aggregate = await loadAggregate(prisma, scope.tenantId, receivingDocumentId)
    const actor = await resolveProvisionedActor(prisma, scope.identity, { allowMissingTestActor: true })
    assertAuthorized({ actor, permission: 'receiving.read', tenantId: actor.tenantId })
    const warehouseIds = [...new Set([aggregate.receivingDocument.warehouseId, ...aggregate.receivingDocument.lines.map(line => line.warehouseId)].filter(Boolean))]
    assertWarehouseAccess(actor, warehouseIds, 'read', { maskExistence: true })
    return { aggregate, actor, warehouseIds }
  }

  async function getReceivingDetail({ receivingDocumentId }, context) {
    const scope = tenantScope(context)
    const { aggregate, actor, warehouseIds } = await authorizedAggregate(scope, receivingDocumentId)
    const { receivingDocument: grn, purchaseOrder: po } = aggregate
    const requiredPermission = grn.postingStatus === 'posted' ? 'receiving.reverse' : 'receiving.post'
    const roleAllowed = can({ actor, permission: requiredPermission, tenantId: actor.tenantId })
    const warehouseAllowed = hasWarehouseAccess(actor, warehouseIds, 'operate')
    const operation = grn.postingStatus === 'posted' ? 'reverse' : 'post'
    const capability = operation === 'reverse' ? capabilities.reversal : capabilities.posting
    const policy = operation === 'reverse'
      ? await buildReceivingReversalPlan({ prisma, tenantId: scope.tenantId, receivingDocument: grn, purchaseOrder: po })
      : await buildReceivingPostingPlan({ prisma, tenantId: scope.tenantId, receivingDocument: grn, purchaseOrder: po })
    const blockingReasonCodes = [
      ...(!capability?.enabled ? ['CAPABILITY_NOT_AVAILABLE'] : []),
      ...(!roleAllowed ? ['PERMISSION_DENIED'] : []),
      ...(!warehouseAllowed ? ['WAREHOUSE_SCOPE_DENIED'] : []),
      ...policy.blockingIssues.map((issue) => issue.code),
    ]
    const allowed = blockingReasonCodes.length === 0
    // A draft is edited and submitted before it can be posted.
    const draftOpen = grn.workflowStatus === 'draft' && grn.postingStatus === 'unposted'
      && Boolean(capabilities.posting?.enabled) && can({ actor, permission: 'receiving.prepare', tenantId: actor.tenantId }) && warehouseAllowed
    return detailModel(aggregate, capabilities, {
      canEditDraft: draftOpen,
      canSubmit: draftOpen,
      canPost: operation === 'post' && allowed,
      canReverse: operation === 'reverse' && allowed,
      canViewReversal: grn.postingStatus === 'reversed',
      primaryAction: allowed ? operation : grn.postingStatus === 'reversed' ? 'view_reversal' : null,
      blockingReasonCodes: [...new Set(blockingReasonCodes)],
    })
  }

  async function getReceivingImpactPreview({ receivingDocumentId, operation }, context) {
    const scope = tenantScope(context)
    const { aggregate } = await authorizedAggregate(scope, receivingDocumentId)
    const { receivingDocument: grn, purchaseOrder: po } = aggregate
    if (!['post', 'reverse'].includes(operation)) fail('RECEIVING_VALIDATION_FAILED', 'operation must be post or reverse.')
    const policy = operation === 'post'
      ? await buildReceivingPostingPlan({ prisma, tenantId: scope.tenantId, receivingDocument: grn, purchaseOrder: po })
      : await buildReceivingReversalPlan({ prisma, tenantId: scope.tenantId, receivingDocument: grn, purchaseOrder: po })
    const { quantityPlans: _quantityPlans, originalMovements: _originalMovements, ...preview } = policy
    return preview
  }

  async function getReceivingEvidenceTimeline({ receivingDocumentId }, context) {
    const scope = tenantScope(context)
    const { aggregate } = await authorizedAggregate(scope, receivingDocumentId)
    const [movements, audits, executions] = await Promise.all([
      prisma.inventoryMovement.findMany({ where: { tenantId: scope.tenantId, relatedGrnId: receivingDocumentId }, orderBy: { occurredAt: 'asc' } }),
      prisma.auditLog.findMany({ where: { tenantId: scope.tenantId, entityType: 'ReceivingDocument', entityId: receivingDocumentId }, orderBy: { createdAt: 'asc' } }),
      prisma.businessCommandExecution.findMany({ where: { tenantId: scope.tenantId, entityType: 'ReceivingDocument', entityId: receivingDocumentId }, orderBy: { createdAt: 'asc' } }),
    ])
    const events = [{ id: `created-${receivingDocumentId}`, type: 'business_fact', event: 'receiving_created', occurredAt: iso(aggregate.receivingDocument.createdAt), label: `Receiving ${aggregate.receivingDocument.documentNumber || receivingDocumentId} created`, postedFact: true }]
    for (const movement of movements) events.push({ id: movement.id, type: 'business_fact', event: 'inventory_movement_created', occurredAt: iso(movement.occurredAt), label: `${movement.movementType} ${movement.sku} ${decimal(add(movement.quantityIn, -receivingDecimalUnits(movement.quantityOut)))}`, actorId: movement.actorId, postedFact: true, data: { movementId: movement.id, postingBatchId: movement.postingBatchId, quantityIn: decimal(movement.quantityIn), quantityOut: decimal(movement.quantityOut), reversalOfMovementId: movement.reversalOfMovementId } })
    for (const audit of audits) {
      const metadata = audit.metadata && typeof audit.metadata === 'object' ? audit.metadata : {}
      events.push({ id: audit.id, type: 'audit', event: audit.action, occurredAt: iso(audit.createdAt), label: audit.summary, actorId: audit.actorId, postedFact: false, data: metadata })
      for (const [index, change] of (metadata.balanceChanges || []).entries()) {
        events.push({ id: `${audit.id}-balance-${index}`, type: 'business_fact', event: 'inventory_balance_changed', occurredAt: iso(audit.createdAt), label: `Inventory ${change.sku} balance ${change.before.onHandQuantity} → ${change.after.onHandQuantity}`, actorId: audit.actorId, postedFact: true, data: change })
      }
      for (const [index, change] of (metadata.purchaseOrderLineChanges || []).entries()) {
        events.push({ id: `${audit.id}-po-line-${index}`, type: 'business_fact', event: 'purchase_order_line_received_changed', occurredAt: iso(audit.createdAt), label: `PO received ${change.receivedBefore} → ${change.receivedAfter}`, actorId: audit.actorId, postedFact: true, data: change })
      }
      if (metadata.poWorkflowBefore != null && metadata.poWorkflowAfter != null && metadata.poWorkflowBefore !== metadata.poWorkflowAfter) {
        events.push({ id: `${audit.id}-po-workflow`, type: 'business_fact', event: 'purchase_order_workflow_changed', occurredAt: iso(audit.createdAt), label: `PO workflow ${metadata.poWorkflowBefore} → ${metadata.poWorkflowAfter}`, actorId: audit.actorId, postedFact: true, data: { before: metadata.poWorkflowBefore, after: metadata.poWorkflowAfter } })
      }
      if (metadata.poFulfillmentBefore != null && metadata.poFulfillmentAfter != null && metadata.poFulfillmentBefore !== metadata.poFulfillmentAfter) {
        events.push({ id: `${audit.id}-po-fulfillment`, type: 'business_fact', event: 'purchase_order_fulfillment_changed', occurredAt: iso(audit.createdAt), label: `PO fulfillment ${metadata.poFulfillmentBefore} → ${metadata.poFulfillmentAfter}`, actorId: audit.actorId, postedFact: true, data: { before: metadata.poFulfillmentBefore, after: metadata.poFulfillmentAfter } })
      } else if (metadata.poFulfillmentBefore == null && metadata.poFulfillmentAfter == null && metadata.before?.poStatus !== metadata.after?.poStatus) {
        events.push({ id: `${audit.id}-po-legacy-status`, type: 'limitation', event: 'legacy_purchase_order_status_interpretation', occurredAt: iso(audit.createdAt), label: `Legacy mixed PO status ${metadata.before?.poStatus || 'unknown'} → ${metadata.after?.poStatus || 'unknown'}; workflow and fulfillment cannot be separated.`, actorId: audit.actorId, postedFact: false })
      }
    }
    for (const execution of executions) events.push({ id: execution.id, type: 'human_activity', event: execution.commandType, occurredAt: iso(execution.completedAt || execution.createdAt), label: `${execution.commandType} command ${execution.status}`, postedFact: false, data: { idempotencyKey: execution.idempotencyKey, idempotentReplay: false } })
    events.push({ id: `lot-serial-${receivingDocumentId}`, type: 'limitation', event: 'lot_serial_unavailable', occurredAt: iso(aggregate.receivingDocument.updatedAt), label: 'Lot/Serial posting is not connected in this beta.', postedFact: false })
    return { receivingDocumentId, events: events.sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt))) }
  }

  async function getReceivingSmartLinks({ receivingDocumentId }, context) {
    const scope = tenantScope(context)
    const { aggregate } = await authorizedAggregate(scope, receivingDocumentId)
    const movements = await prisma.inventoryMovement.findMany({ where: { tenantId: scope.tenantId, relatedGrnId: receivingDocumentId } })
    const balanceKeys = [...new Map(movements.map((movement) => {
      const locationKey = receivingLocationKey(movement.locationKey || movement.location)
      const value = { sku: movement.sku, warehouseId: movement.warehouseId || null, warehouseKey: movement.warehouseId || '', locationKey }
      return [`${value.sku}\u0000${value.warehouseKey}\u0000${value.locationKey}`, value]
    })).values()]
    const [balanceCount, auditCount] = await Promise.all([
      balanceKeys.length ? prisma.inventoryBalance.count({ where: { tenantId: scope.tenantId, OR: balanceKeys.map((key) => ({ sku: key.sku, warehouseKey: key.warehouseKey, locationKey: key.locationKey })) } }) : 0,
      prisma.auditLog.count({ where: { tenantId: scope.tenantId, entityType: 'ReceivingDocument', entityId: receivingDocumentId } }),
    ])
    const reversals = movements.filter((movement) => movement.movementType === 'receipt_reversal')
    const link = (value) => ({ unavailableReason: value.enabled ? null : 'No authoritative records are available.', ...value })
    return { links: [
      link({ label: 'Purchase Order', count: 1, targetRouteId: 'procurement:order-detail', targetType: 'purchase_order', targetId: aggregate.purchaseOrder.id, filter: {}, enabled: true }),
      link({ label: 'Movements', count: movements.length, targetRouteId: 'inventory:movements', targetType: 'inventory_movement', targetId: receivingDocumentId, filter: { relatedGrnId: receivingDocumentId }, enabled: movements.length > 0 }),
      link({ label: 'Balances', count: balanceCount, targetRouteId: 'inventory:stock', targetType: 'inventory_balance', targetId: receivingDocumentId, filter: { balanceKeys }, enabled: balanceCount > 0 }),
      link({ label: 'Audit', count: auditCount, targetRouteId: 'settings:audit', targetType: 'audit', targetId: receivingDocumentId, filter: { entityType: 'ReceivingDocument', entityId: receivingDocumentId }, enabled: auditCount > 0 }),
      link({ label: 'Reversal', count: reversals.length, targetRouteId: 'inventory:movements', targetType: 'receipt_reversal', targetId: reversals[0]?.id || receivingDocumentId, filter: { relatedGrnId: receivingDocumentId, movementType: 'receipt_reversal' }, enabled: reversals.length > 0 }),
    ] }
  }

  async function getReceivingReconciliation({ receivingDocumentId }, context) {
    const scope = tenantScope(context)
    await authorizedAggregate(scope, receivingDocumentId)
    const grnMovements = await prisma.inventoryMovement.findMany({ where: { tenantId: scope.tenantId, relatedGrnId: receivingDocumentId }, orderBy: { occurredAt: 'asc' } })
    const keys = [...new Map(grnMovements.map((movement) => {
      const locationKey = receivingLocationKey(movement.locationKey || movement.location)
      const value = { sku: movement.sku, warehouseId: movement.warehouseId || null, warehouseKey: movement.warehouseId || '', locationKey }
      return [`${value.sku}\u0000${value.warehouseKey}\u0000${value.locationKey}`, value]
    })).values()]
    if (!keys.length) return { receivingDocumentId, status: 'unavailable', entries: [], reason: 'No inventory movements exist for this receiving document.' }
    const entries = await Promise.all(keys.map(async (key) => {
      const [movements, balance] = await Promise.all([
        prisma.inventoryMovement.findMany({ where: { tenantId: scope.tenantId, sku: key.sku, warehouseId: key.warehouseId, locationKey: key.locationKey, status: 'posted' }, select: { id: true, quantityIn: true, quantityOut: true, adjustmentQty: true } }),
        prisma.inventoryBalance.findUnique({ where: { tenantId_sku_warehouseKey_locationKey: { tenantId: scope.tenantId, sku: key.sku, warehouseKey: key.warehouseKey, locationKey: key.locationKey } } }),
      ])
      const calculated = movements.reduce((sum, movement) => sum + receivingDecimalUnits(movement.quantityIn) - receivingDecimalUnits(movement.quantityOut) + receivingDecimalUnits(movement.adjustmentQty), ZERO)
      if (!balance) return { ...key, status: 'unavailable', calculatedQuantity: receivingDecimalString(calculated), recordedQuantity: null, differenceQuantity: null, movementIds: movements.map((movement) => movement.id), reason: 'Inventory balance is missing.' }
      const recorded = receivingDecimalUnits(balance.onHandQuantity)
      const difference = recorded - calculated
      return { ...key, balanceId: balance.id, status: difference === ZERO ? 'matched' : 'mismatch', calculatedQuantity: receivingDecimalString(calculated), recordedQuantity: receivingDecimalString(recorded), differenceQuantity: receivingDecimalString(difference), movementIds: movements.map((movement) => movement.id), reason: difference === ZERO ? null : 'Recorded on-hand does not equal cumulative registered movements.' }
    }))
    const status = entries.some((entry) => entry.status === 'mismatch') ? 'mismatch' : entries.some((entry) => entry.status === 'unavailable') ? 'unavailable' : 'matched'
    return { receivingDocumentId, status, entries }
  }

  async function getPurchaseOrderReceivingSummary({ purchaseOrderId }, context) {
    const scope = tenantScope(context)
    const po = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, tenantId: scope.tenantId }, include: { lines: true } })
    if (!po) fail('RECEIVING_NOT_FOUND', 'Purchase order was not found.', 404)
    const receipts = await prisma.receivingDocument.findMany({ where: { tenantId: scope.tenantId, poId: purchaseOrderId }, select: { id: true, postingStatus: true } })
    const movementCount = await prisma.inventoryMovement.count({ where: { tenantId: scope.tenantId, relatedPoId: purchaseOrderId } })
    return { purchaseOrder: { id: po.id, workflowStatus: workflowStatusOf(po), fulfillmentStatus: fulfillmentStatus(po.lines) }, receiptsCount: receipts.length, postedReceiptsCount: receipts.filter((row) => row.postingStatus === 'posted').length, reversedReceiptsCount: receipts.filter((row) => row.postingStatus === 'reversed').length, movementCount, receivedQuantitySummary: receivingDecimalString(po.lines.reduce((sum, line) => sum + receivingDecimalUnits(line.receivedQuantity), ZERO)) }
  }

  return { getReceivingDetail, getReceivingImpactPreview, getReceivingEvidenceTimeline, getReceivingSmartLinks, getReceivingReconciliation, getPurchaseOrderReceivingSummary }
}
