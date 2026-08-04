import {
  RECEIVABLE_PURCHASE_ORDER_INPUTS,
  RECEIVING_POSTABLE_WORKFLOW_INPUTS,
  isPurchaseOrderReceivable,
  isReceivingWorkflowPostable,
} from './procurement-status-authority.mjs'

const SCALE = 10_000n
const ZERO = 0n

export const RECEIVABLE_WORKFLOW_STATUSES = new Set(RECEIVING_POSTABLE_WORKFLOW_INPUTS)
export const RECEIVABLE_PO_STATUSES = new Set(RECEIVABLE_PURCHASE_ORDER_INPUTS)
export const DOWNSTREAM_MOVEMENT_TYPES = [
  'outbound_posting',
  'sales_outbound',
  'transfer_out',
  'reservation_consumption',
  'sales_allocation_consumption',
]

export const receivingText = (value = '') => String(value ?? '').trim()
export const receivingLocationKey = (value = '') => receivingText(value).toLowerCase()

export function receivingDecimalUnits(value) {
  const raw = receivingText(value ?? '0') || '0'
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw Object.assign(new Error(`Invalid decimal quantity: ${raw}`), { code: 'RECEIVING_VALIDATION_FAILED' })
  const negative = raw.startsWith('-')
  const unsigned = negative ? raw.slice(1) : raw
  const [whole, fraction = ''] = unsigned.split('.')
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4))) throw Object.assign(new Error(`Quantity exceeds four decimal places: ${raw}`), { code: 'RECEIVING_VALIDATION_FAILED' })
  const units = BigInt(whole) * SCALE + BigInt((fraction.slice(0, 4) + '0000').slice(0, 4))
  return negative ? -units : units
}

export function receivingDecimalString(units) {
  const negative = units < ZERO
  const absolute = negative ? -units : units
  return `${negative ? '-' : ''}${absolute / SCALE}.${String(absolute % SCALE).padStart(4, '0')}`
}

export function receivingFulfillmentStatus(lines = []) {
  if (!lines.length || lines.every((line) => receivingDecimalUnits(line.receivedQuantity) <= ZERO)) return 'not_received'
  if (lines.every((line) => receivingDecimalUnits(line.receivedQuantity) >= receivingDecimalUnits(line.orderedQuantity))) return 'fully_received'
  return 'partially_received'
}

export function receivingWorkflowStatus(po = {}) {
  const status = receivingText(po.status)
  return receivingText(po.receivingBaseStatus) || (!['partially_received', 'fully_received'].includes(status) ? status : 'approved')
}

const issue = (code, message, status = code === 'RECEIVING_OVER_RECEIPT' || code === 'RECEIVING_REVERSAL_NOT_SAFE' || code.startsWith('RECEIVING_ALREADY_') ? 409 : 400, details) => ({ code, message, status, ...(details ? { details } : {}) })
const balanceWhere = ({ tenantId, sku, warehouseId, locationKey }) => ({ tenantId_sku_warehouseKey_locationKey: { tenantId, sku, warehouseKey: receivingText(warehouseId), locationKey } })
const balanceKey = ({ sku, warehouseId, locationKey }) => `${sku}|${warehouseId || ''}|${locationKey || ''}`
const safeUnits = (value, blockingIssues, label) => {
  try { return receivingDecimalUnits(value) } catch (error) { blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `${label}: ${error.message}`)); return null }
}

export async function buildReceivingPostingPlan({ prisma, tenantId, receivingDocument, purchaseOrder }) {
  const blockingIssues = []
  const warnings = []
  const quantityPlans = []
  const acceptedByPoLine = new Map()
  const poLines = new Map(purchaseOrder.lines.map((line) => [line.id, line]))

  if (receivingDocument.postingStatus !== 'unposted') blockingIssues.push(issue('RECEIVING_ALREADY_POSTED', 'Receiving document is not unposted.'))
  if (!receivingDocument.lines.length) blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', 'Receiving document has no lines.'))
  if (!isReceivingWorkflowPostable(receivingDocument.workflowStatus)) blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `Workflow status ${receivingDocument.workflowStatus} does not allow posting.`))
  if (!isPurchaseOrderReceivable(purchaseOrder.status)) blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `Purchase order status ${purchaseOrder.status} does not allow receiving.`))

  for (const line of receivingDocument.lines) {
    const accepted = safeUnits(line.acceptedQty, blockingIssues, `Receiving line ${line.id} acceptedQty`)
    const rejected = safeUnits(line.rejectedQty, blockingIssues, `Receiving line ${line.id} rejectedQty`)
    if (accepted === null || rejected === null) continue
    if (accepted <= ZERO || rejected < ZERO) blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `Receiving line ${line.id} acceptedQty must be positive and rejectedQty cannot be negative.`))
    const poLine = poLines.get(line.purchaseOrderLineId)
    if (!poLine) { blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `Receiving line ${line.id} does not reference a line on the related purchase order.`)); continue }
    const sku = receivingText(line.sku)
    const itemId = receivingText(line.itemId)
    if (!sku || !itemId || sku !== receivingText(poLine.sku) || itemId !== receivingText(poLine.itemId)) {
      blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `Receiving line ${line.id} does not match its purchase order item and SKU.`))
    }
    const item = sku && itemId ? await prisma.item.findFirst({ where: { id: itemId, tenantId, sku }, select: { id: true } }) : null
    if (!item) blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `Item ${itemId} / ${sku} is not valid for this tenant.`))
    const warehouseId = receivingText(line.warehouseId || receivingDocument.warehouseId)
    const warehouse = warehouseId ? await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId, status: 'active' }, select: { id: true } }) : null
    if (!warehouse) blockingIssues.push(issue('RECEIVING_VALIDATION_FAILED', `Warehouse ${warehouseId || '(missing)'} is not active for this tenant.`))
    const ordered = safeUnits(poLine.orderedQuantity, blockingIssues, `PO line ${poLine.id} orderedQuantity`)
    const previouslyReceived = safeUnits(poLine.receivedQuantity, blockingIssues, `PO line ${poLine.id} receivedQuantity`)
    if (ordered === null || previouslyReceived === null) continue
    const acceptedInDocument = (acceptedByPoLine.get(poLine.id) || ZERO) + accepted
    acceptedByPoLine.set(poLine.id, acceptedInDocument)
    if (previouslyReceived + acceptedInDocument > ordered) blockingIssues.push(issue('RECEIVING_OVER_RECEIPT', `Receiving line ${line.id} exceeds the purchase order quantity.`))
    const location = receivingText(line.location)
    quantityPlans.push({ line, poLine, sku, itemId, warehouseId, location, locationKey: receivingLocationKey(location), accepted, rejected })
  }

  const inventoryImpacts = []
  for (const plan of quantityPlans) {
    const balance = await prisma.inventoryBalance.findUnique({ where: balanceWhere({ tenantId, ...plan }) })
    const onHandBefore = receivingDecimalUnits(balance?.onHandQuantity || 0)
    const availableBefore = receivingDecimalUnits(balance?.availableQuantity || 0)
    inventoryImpacts.push({ sku: plan.sku, warehouseId: plan.warehouseId, location: plan.location, locationKey: plan.locationKey, onHandBefore: receivingDecimalString(onHandBefore), onHandDelta: receivingDecimalString(plan.accepted), onHandAfter: receivingDecimalString(onHandBefore + plan.accepted), availableBefore: receivingDecimalString(availableBefore), availableDelta: receivingDecimalString(plan.accepted), availableAfter: receivingDecimalString(availableBefore + plan.accepted) })
  }
  const purchaseOrderImpacts = [...acceptedByPoLine.entries()].map(([poLineId, delta]) => {
    const poLine = poLines.get(poLineId)
    const before = receivingDecimalUnits(poLine.receivedQuantity)
    const ordered = receivingDecimalUnits(poLine.orderedQuantity)
    return { poLineId, receivedBefore: receivingDecimalString(before), receivedDelta: receivingDecimalString(delta), receivedAfter: receivingDecimalString(before + delta), remainingAfter: receivingDecimalString(ordered - before - delta) }
  })
  const projectedLines = purchaseOrder.lines.map((line) => ({ ...line, receivedQuantity: purchaseOrderImpacts.find((impact) => impact.poLineId === line.id)?.receivedAfter ?? line.receivedQuantity }))
  return {
    operation: 'post', allowed: blockingIssues.length === 0, blockingIssues, warnings,
    normalizedLines: quantityPlans.map((plan) => ({ id: plan.line.id, poLineId: plan.poLine.id, sku: plan.sku, itemId: plan.itemId, warehouseId: plan.warehouseId, locationKey: plan.locationKey, acceptedQuantity: receivingDecimalString(plan.accepted), rejectedQuantity: receivingDecimalString(plan.rejected) })),
    quantityPlans, inventoryImpacts, purchaseOrderImpacts,
    statusImpact: { poWorkflowStatus: receivingWorkflowStatus(purchaseOrder), poFulfillmentBefore: receivingFulfillmentStatus(purchaseOrder.lines), poFulfillmentAfter: receivingFulfillmentStatus(projectedLines), receivingPostingBefore: receivingDocument.postingStatus, receivingPostingAfter: 'posted' },
    factsToCreate: { inventoryMovementCount: quantityPlans.length, auditEventCount: 1, commandExecutionCount: 1 },
    limitations: ['Lot/Serial posting is not connected in this beta.'],
  }
}

export async function buildReceivingReversalPlan({ prisma, tenantId, receivingDocument, purchaseOrder }) {
  const blockingIssues = []
  const warnings = [{ code: 'REVERSAL_REASON_REQUIRED_ON_CONFIRM', message: 'A reversal reason is required when confirming.' }]
  if (receivingDocument.postingStatus === 'reversed') blockingIssues.push(issue('RECEIVING_ALREADY_REVERSED', 'Receiving document is already reversed.'))
  else if (receivingDocument.postingStatus !== 'posted') blockingIssues.push(issue('RECEIVING_REVERSAL_NOT_SAFE', 'Only a posted receiving document can be reversed.'))
  const originalMovements = await prisma.inventoryMovement.findMany({ where: { tenantId, relatedGrnId: receivingDocument.id, movementType: 'receipt_posting' }, orderBy: { createdAt: 'asc' } })
  if (!originalMovements.length || originalMovements.some((movement) => movement.reversedByMovementId)) blockingIssues.push(issue('RECEIVING_REVERSAL_NOT_SAFE', 'Original receipt movements are missing or already reversed.'))
  const receivingLines = new Map(receivingDocument.lines.map((line) => [line.id, line]))
  const poLines = new Map(purchaseOrder.lines.map((line) => [line.id, line]))
  const poDeltas = new Map()
  const inventoryImpacts = []

  for (const movement of originalMovements) {
    const downstream = await prisma.inventoryMovement.findFirst({ where: { tenantId, sku: movement.sku, warehouseId: movement.warehouseId, occurredAt: { gt: movement.occurredAt }, movementType: { in: DOWNSTREAM_MOVEMENT_TYPES } }, select: { id: true, movementType: true } })
    const downstreamSources = [movement.id, receivingDocument.id]
    const [consumedSerial, consumedLot] = await Promise.all([
      prisma.inventorySerial.findFirst({ where: { tenantId, sku: movement.sku, warehouseId: movement.warehouseId, sourceDocument: { in: downstreamSources }, status: { not: 'in_stock' } }, select: { id: true } }),
      prisma.inventoryLot.findFirst({ where: { tenantId, sku: movement.sku, warehouseId: movement.warehouseId, sourceDocument: { in: downstreamSources }, status: { not: 'available' } }, select: { id: true } }),
    ])
    if (downstream || consumedSerial || consumedLot) blockingIssues.push(issue('RECEIVING_REVERSAL_NOT_SAFE', 'Downstream inventory consumption makes this receiving reversal unsafe.', 409, { movementId: movement.id, downstreamMovementId: downstream?.id, consumedSerialId: consumedSerial?.id, consumedLotId: consumedLot?.id }))
    const quantity = safeUnits(movement.quantityIn, blockingIssues, `Movement ${movement.id} quantityIn`)
    if (quantity === null) continue
    const locationKey = movement.locationKey || receivingLocationKey(movement.location)
    const balance = await prisma.inventoryBalance.findUnique({ where: balanceWhere({ tenantId, sku: movement.sku, warehouseId: movement.warehouseId, locationKey }) })
    const onHandBefore = receivingDecimalUnits(balance?.onHandQuantity || 0)
    const availableBefore = receivingDecimalUnits(balance?.availableQuantity || 0)
    if (!balance || onHandBefore < quantity || availableBefore < quantity) blockingIssues.push(issue('RECEIVING_REVERSAL_NOT_SAFE', `Balance for ${movement.sku} is insufficient.`))
    inventoryImpacts.push({ sku: movement.sku, warehouseId: movement.warehouseId, location: movement.location || '', locationKey, originalMovementId: movement.id, postingBatchId: movement.postingBatchId, onHandBefore: receivingDecimalString(onHandBefore), onHandDelta: receivingDecimalString(-quantity), onHandAfter: receivingDecimalString(onHandBefore - quantity), availableBefore: receivingDecimalString(availableBefore), availableDelta: receivingDecimalString(-quantity), availableAfter: receivingDecimalString(availableBefore - quantity) })
    const receivingLine = receivingLines.get(movement.sourceDocumentLineId)
    const poLine = poLines.get(receivingLine?.purchaseOrderLineId)
    if (!poLine) blockingIssues.push(issue('RECEIVING_REVERSAL_NOT_SAFE', `Movement ${movement.id} is not linked to a purchase order line.`))
    else poDeltas.set(poLine.id, (poDeltas.get(poLine.id) || ZERO) + quantity)
  }
  const purchaseOrderImpacts = [...poDeltas.entries()].map(([poLineId, quantity]) => {
    const poLine = poLines.get(poLineId)
    const before = receivingDecimalUnits(poLine.receivedQuantity)
    if (before < quantity) blockingIssues.push(issue('RECEIVING_REVERSAL_NOT_SAFE', `PO line ${poLine.id} received quantity is insufficient.`))
    return { poLineId, receivedBefore: receivingDecimalString(before), receivedDelta: receivingDecimalString(-quantity), receivedAfter: receivingDecimalString(before - quantity), remainingAfter: receivingDecimalString(receivingDecimalUnits(poLine.orderedQuantity) - before + quantity) }
  })
  const projectedLines = purchaseOrder.lines.map((line) => ({ ...line, receivedQuantity: purchaseOrderImpacts.find((impact) => impact.poLineId === line.id)?.receivedAfter ?? line.receivedQuantity }))
  return {
    operation: 'reverse', allowed: blockingIssues.length === 0, blockingIssues, warnings,
    normalizedLines: [], quantityPlans: [], originalMovements, inventoryImpacts, purchaseOrderImpacts,
    statusImpact: { poWorkflowStatus: receivingWorkflowStatus(purchaseOrder), poFulfillmentBefore: receivingFulfillmentStatus(purchaseOrder.lines), poFulfillmentAfter: receivingFulfillmentStatus(projectedLines), receivingPostingBefore: receivingDocument.postingStatus, receivingPostingAfter: 'reversed' },
    factsToCreate: { inventoryMovementCount: originalMovements.length, auditEventCount: 1, commandExecutionCount: 1 },
    limitations: ['Lot/Serial posting is not connected in this beta.'],
  }
}
