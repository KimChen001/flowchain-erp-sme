import { createHash, randomUUID } from 'node:crypto'
import { sanitizeSuggestionTrail } from '../../shared/prefill-suggestions.mjs'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { assertWarehouseAccess, hasWarehouseAccess, resolveProvisionedActor } from './pilot-identity.mjs'
import { ReceivingCommandError } from './receiving-posting-command-service.mjs'
import { isPurchaseOrderReceivable, RECEIVABLE_PURCHASE_ORDER_INPUTS, RECEIVING_POSTING_STATUS, RECEIVING_WORKFLOW_STATUS } from './procurement-status-authority.mjs'
import { receivingDecimalString, receivingDecimalUnits } from './receiving-transaction-policy.mjs'

// The receiving draft commands (create, revise, submit) that both the desktop
// receiving routes and the mobile receiving facade call. A channel only names
// the command types recorded for idempotency, the audit source, the extra
// permission the channel needs and the channel fields kept on the document;
// the checks and the rows written are the same. Posting stays in
// receiving-posting-command-service.
export const RECEIVING_DRAFT_CHANNELS = Object.freeze({
  desktop: Object.freeze({
    commandPrefix: 'receiving',
    source: 'receiving_desktop',
    permissions: [],
    requireReviseKey: true,
    metadata: () => ({}),
  }),
  mobile: Object.freeze({
    commandPrefix: 'mobile.receiving',
    source: 'mobile_receiving_facade',
    permissions: ['mobile.receiving.prepare'],
    requireReviseKey: false,
    metadata: (input) => ({ clientMutationId: text(input.clientMutationId), sourceDeviceId: text(input.sourceDeviceId) }),
  }),
})

const text = (value) => String(value ?? '').trim()
const fail = (code, message, status = 400, details) => { throw new ReceivingCommandError(code, message, status, details) }
const serial = (value) => value?.toISOString?.() || value || null
const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const decimal = (value) => receivingDecimalString(receivingDecimalUnits(value || 0))
const quantityUnits = (value, label) => {
  try { return receivingDecimalUnits(value || 0) } catch (error) { fail('RECEIVING_VALIDATION_FAILED', `${label}: ${error.message}`, 422) }
}
const remainingUnits = (poLine) => quantityUnits(poLine.orderedQuantity, 'orderedQuantity') - quantityUnits(poLine.receivedQuantity, 'receivedQuantity')
const expectedVersionOf = (value) => {
  const parsed = Number(value)
  if (value === undefined || value === null || value === '' || !Number.isInteger(parsed) || parsed < 0) fail('RECEIVING_VERSION_REQUIRED', 'expectedVersion must be a non-negative integer.', 422)
  return parsed
}

function documentSummary(row) {
  return { id: row.id, documentNumber: row.documentNumber, poId: row.poId, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, version: row.version }
}

function receivableLine(line) {
  return {
    id: line.id,
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    orderedQuantity: decimal(line.orderedQuantity),
    receivedQuantity: decimal(line.receivedQuantity),
    remainingQuantity: receivingDecimalString(remainingUnits(line)),
    unit: line.unit,
  }
}

// Validates the requested lines against the PO. Accepted quantity is what goes
// to stock; rejected quantity stays out of stock and needs a reason. The
// accepted total per PO line may not exceed what is still open on it.
function buildLines(po, inputLines, warehouseId, idFactory) {
  const poLines = new Map(po.lines.map((line) => [line.id, line]))
  const acceptedByPoLine = new Map()
  const lines = []
  for (const value of Array.isArray(inputLines) ? inputLines : []) {
    const source = poLines.get(text(value.purchaseOrderLineId))
    if (!source) fail('RECEIVING_LINE_INVALID', 'Each receiving line must reference the selected PO.', 422)
    const accepted = quantityUnits(value.acceptedQuantity ?? value.acceptedQty, 'acceptedQuantity')
    const rejected = quantityUnits(value.rejectedQuantity ?? value.rejectedQty, 'rejectedQuantity')
    const damaged = quantityUnits(value.damagedQuantity, 'damagedQuantity')
    if (accepted <= 0n) fail('RECEIVING_VALIDATION_FAILED', 'Accepted quantity must be greater than zero.', 422, { purchaseOrderLineId: source.id })
    if (rejected < 0n || damaged < 0n) fail('RECEIVING_VALIDATION_FAILED', 'Rejected and damaged quantities cannot be negative.', 422, { purchaseOrderLineId: source.id })
    const rejectionReason = text(value.rejectionReason)
    if (rejected > 0n && !rejectionReason) fail('RECEIVING_REJECTION_REASON_REQUIRED', 'A reason is required for rejected quantity.', 422, { purchaseOrderLineId: source.id })
    const acceptedOnLine = (acceptedByPoLine.get(source.id) || 0n) + accepted
    acceptedByPoLine.set(source.id, acceptedOnLine)
    const remaining = remainingUnits(source)
    if (acceptedOnLine > remaining) fail('RECEIVING_OVER_RECEIPT', 'Accepted quantity exceeds the PO remaining quantity.', 409, { purchaseOrderLineId: source.id, remainingQuantity: receivingDecimalString(remaining) })
    const location = text(value.location)
    lines.push({
      id: idFactory(), purchaseOrderLineId: source.id, itemId: source.itemId, sku: source.sku, itemName: source.itemName,
      acceptedQty: receivingDecimalString(accepted), rejectedQty: receivingDecimalString(rejected), unit: source.unit,
      warehouseId: text(value.warehouseId) || warehouseId, location, locationKey: location.toLowerCase(),
      metadata: { damagedQuantity: receivingDecimalString(damaged), note: text(value.note), ...(rejectionReason ? { rejectionReason } : {}) },
    })
  }
  if (!lines.length) fail('RECEIVING_LINES_REQUIRED', 'At least one receiving line is required.', 422)
  return lines
}

function arrivalTime(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) fail('RECEIVING_VALIDATION_FAILED', 'arrivedAt must be a valid date and time.', 422)
  return parsed
}

export function createReceivingDraftCommandService({ prisma, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error('prisma is required')

  async function authorizedActor(client, context, channel, permission = 'receiving.prepare') {
    const actor = await resolveProvisionedActor(client, context?.identity || context)
    for (const code of channel.permissions) assertAuthorized({ actor, permission: code, tenantId: actor.tenantId })
    assertAuthorized({ actor, permission, tenantId: actor.tenantId })
    return actor
  }

  async function assertActiveWarehouses(tx, tenantId, warehouseIds) {
    const found = await tx.warehouse.count({ where: { tenantId, id: { in: warehouseIds }, status: 'active' } })
    if (found !== warehouseIds.length) fail('RECEIVING_WAREHOUSE_INVALID', 'Every receiving warehouse must be an active warehouse of this workspace.', 422)
  }

  // Replays a completed command, refuses a reused key with another payload,
  // and records the new command in the same transaction as its effects.
  async function idempotent({ tenantId, commandType, key, requestHash, entityId }, work) {
    const where = { tenantId_commandType_idempotencyKey: { tenantId, commandType, idempotencyKey: key } }
    const replay = (row) => {
      if (!row) return null
      if (row.requestHash !== requestHash) fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'The idempotency key was reused with another payload.', 409)
      if (row.status !== 'completed' || !row.resultPayload) fail('RECEIVING_COMMAND_IN_PROGRESS', 'The command is already in progress.', 409)
      return { ...row.resultPayload, idempotentReplay: true }
    }
    const prior = replay(await prisma.businessCommandExecution.findUnique({ where }))
    if (prior) return prior
    try {
      return await prisma.$transaction(async (tx) => {
        const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId, commandType, idempotencyKey: key, requestHash, status: 'pending', entityType: 'ReceivingDocument', entityId: entityId || null } })
        const { result, entityId: resultEntityId } = await work(tx, execution)
        await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: 'completed', entityId: resultEntityId, resultPayload: result, completedAt: now() } })
        return { ...result, idempotentReplay: false }
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (error?.code === 'P2002') {
        const committed = replay(await prisma.businessCommandExecution.findUnique({ where }))
        if (committed) return committed
      }
      if (error?.code === 'P2034') fail('RECEIVING_CONCURRENT_POSTING_CONFLICT', 'Receiving was changed by another transaction.', 409)
      throw error
    }
  }

  async function lockDraft(tx, actor, id) {
    await tx.$queryRawUnsafe('SELECT "id" FROM "ReceivingDocument" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, text(id))
    const row = await tx.receivingDocument.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { lines: true } })
    if (!row) fail('RECEIVING_NOT_FOUND', 'Receiving draft was not found.', 404)
    return row
  }

  const changeFeed = (tx, actor, channel, row, requestId) => tx.domainChangeFeed.create({ data: {
    tenantId: actor.tenantId, entityType: 'ReceivingDocument', entityId: row.id, operation: 'upsert', entityVersion: row.version,
    actorId: actor.user.id, source: channel.source, requestId: requestId || null, payloadHash: digest({ id: row.id, version: row.version }),
    sensitivityGroups: [], moduleKey: 'receiving', authorizationClass: 'receiving.read', scopeWarehouseIds: [row.warehouseId].filter(Boolean), resourceTenantId: actor.tenantId,
  } })

  const audit = (tx, actor, channel, row, action, summary, metadata) => tx.auditLog.create({ data: {
    id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: channel.source, module: 'procurement_receiving',
    action, entityType: 'ReceivingDocument', entityId: row.id, summary, metadata,
  } })

  // A receipt starts from a PO that is approved, issued or partially received.
  async function createDraft(input = {}, context, channel = RECEIVING_DRAFT_CHANNELS.desktop) {
    const actor = await authorizedActor(prisma, context, channel)
    const warehouseId = text(input.warehouseId)
    // Which prefilled values the user kept: codes only, for the audit row.
    const suggestions = sanitizeSuggestionTrail(input.suggestionTrail)
    if (!warehouseId) fail('RECEIVING_WAREHOUSE_REQUIRED', 'A receiving warehouse is required.', 422)
    const warehouseIds = [...new Set([warehouseId, ...(input.lines || []).map((line) => text(line.warehouseId) || warehouseId)])]
    assertWarehouseAccess(actor, warehouseIds, 'operate')
    const key = text(input.idempotencyKey)
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required.', 422)
    const commandType = `${channel.commandPrefix}.create`
    return idempotent({ tenantId: actor.tenantId, commandType, key, requestHash: digest(input) }, async (tx, execution) => {
      const po = await tx.purchaseOrder.findFirst({ where: { id: text(input.poId), tenantId: actor.tenantId }, include: { lines: true } })
      if (!po) fail('PURCHASE_ORDER_NOT_FOUND', 'Purchase order was not found.', 404)
      if (!isPurchaseOrderReceivable(po.status)) fail('RECEIVING_PURCHASE_ORDER_NOT_RECEIVABLE', `A ${po.status} purchase order cannot be received.`, 409, { purchaseOrderId: po.id, currentStatus: po.status })
      await assertActiveWarehouses(tx, actor.tenantId, warehouseIds)
      const lines = buildLines(po, input.lines, warehouseId, idFactory)
      const document = await tx.receivingDocument.create({ data: {
        id: idFactory(), tenantId: actor.tenantId, documentNumber: text(input.documentNumber) || `GRN-${now().getTime()}`,
        poId: po.id, supplierId: po.supplierId, supplierName: po.supplierName, status: 'receiving',
        workflowStatus: RECEIVING_WORKFLOW_STATUS.DRAFT, postingStatus: RECEIVING_POSTING_STATUS.UNPOSTED,
        warehouseId, receiver: actor.user.name, arrivedAt: arrivalTime(input.arrivedAt, now()), currency: po.currency,
        metadata: { note: text(input.note), ...channel.metadata(input) }, lines: { create: lines },
      } })
      const result = { entityId: document.id, receivingDocument: documentSummary(document), pendingSync: false }
      await audit(tx, actor, channel, document, 'receiving_draft_created', `Created receiving draft ${document.documentNumber}.`, { commandExecutionId: execution.id, commandType, idempotencyKey: key, poId: po.id, lineCount: lines.length, ...(suggestions ? { suggestions } : {}) })
      await changeFeed(tx, actor, channel, document, key)
      return { result, entityId: document.id }
    })
  }

  // Replaces the lines of a draft. Only an unposted draft at the expected
  // version can change.
  async function reviseDraft(id, input = {}, context, channel = RECEIVING_DRAFT_CHANNELS.desktop) {
    const actor = await authorizedActor(prisma, context, channel)
    const expected = expectedVersionOf(input.expectedVersion)
    const key = text(input.idempotencyKey)
    if (!key && channel.requireReviseKey) fail('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required.', 422)
    const work = async (tx, execution) => {
      const row = await lockDraft(tx, actor, id)
      if (row.version !== expected) fail('SYNC_VERSION_CONFLICT', 'Receiving draft changed concurrently.', 409, { entityId: row.id, expectedVersion: expected, currentVersion: row.version })
      if (row.workflowStatus !== RECEIVING_WORKFLOW_STATUS.DRAFT || row.postingStatus !== RECEIVING_POSTING_STATUS.UNPOSTED) fail('RECEIVING_IMMUTABLE', 'Submitted or posted receiving documents cannot be revised.', 409)
      const warehouseId = text(input.warehouseId) || row.warehouseId
      const warehouseIds = [...new Set([warehouseId, ...row.lines.map((line) => line.warehouseId), ...(input.lines || []).map((line) => text(line.warehouseId) || warehouseId)].filter(Boolean))]
      assertWarehouseAccess(actor, warehouseIds, 'operate')
      await assertActiveWarehouses(tx, actor.tenantId, warehouseIds)
      const po = await tx.purchaseOrder.findFirst({ where: { id: row.poId, tenantId: actor.tenantId }, include: { lines: true } })
      if (!po) fail('PURCHASE_ORDER_NOT_FOUND', 'Purchase order was not found.', 404)
      const lines = buildLines(po, input.lines, warehouseId, idFactory)
      await tx.receivingLine.deleteMany({ where: { receivingDocumentId: row.id } })
      await tx.receivingLine.createMany({ data: lines.map((line) => ({ ...line, receivingDocumentId: row.id })) })
      const updated = await tx.receivingDocument.update({ where: { id: row.id }, data: {
        warehouseId, arrivedAt: arrivalTime(input.arrivedAt, row.arrivedAt),
        metadata: { ...(row.metadata || {}), note: text(input.note), ...channel.metadata(input) }, version: { increment: 1 },
      } })
      const result = { entityId: row.id, receivingDocument: documentSummary(updated), pendingSync: false }
      await audit(tx, actor, channel, updated, 'receiving_draft_revised', `Revised receiving draft ${row.documentNumber}.`, { commandExecutionId: execution?.id || null, idempotencyKey: key || null, expectedVersion: expected, lineCount: lines.length })
      await changeFeed(tx, actor, channel, updated, key || text(input.clientMutationId))
      return { result, entityId: row.id }
    }
    if (!key) return prisma.$transaction(async (tx) => (await work(tx, null)).result, { isolationLevel: 'Serializable' })
    return idempotent({ tenantId: actor.tenantId, commandType: `${channel.commandPrefix}.revise`, key, requestHash: digest({ id: text(id), ...input, idempotencyKey: undefined }), entityId: text(id) }, work)
  }

  // Moves a draft to ready_for_receiving, the state posting accepts.
  async function submitDraft(id, input = {}, context, channel = RECEIVING_DRAFT_CHANNELS.desktop) {
    const actor = await authorizedActor(prisma, context, channel)
    const expected = expectedVersionOf(input.expectedVersion)
    const key = text(input.idempotencyKey)
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required.', 422)
    const commandType = `${channel.commandPrefix}.submit`
    return idempotent({ tenantId: actor.tenantId, commandType, key, requestHash: digest({ id: text(id), expectedVersion: expected }), entityId: text(id) }, async (tx, execution) => {
      const row = await lockDraft(tx, actor, id)
      assertWarehouseAccess(actor, [...new Set([row.warehouseId, ...row.lines.map((line) => line.warehouseId)].filter(Boolean))], 'operate')
      if (row.version !== expected) fail('SYNC_VERSION_CONFLICT', 'Receiving draft changed concurrently.', 409, { entityId: row.id, expectedVersion: expected, currentVersion: row.version, conflictFields: ['workflowStatus'], availableActions: ['reload'], serverTime: serial(now()) })
      if (row.workflowStatus !== RECEIVING_WORKFLOW_STATUS.DRAFT || row.postingStatus !== RECEIVING_POSTING_STATUS.UNPOSTED) fail('RECEIVING_WORKFLOW_CONFLICT', 'Only a draft may be submitted.', 409)
      const updated = await tx.receivingDocument.update({ where: { id: row.id }, data: { workflowStatus: RECEIVING_WORKFLOW_STATUS.READY_FOR_RECEIVING, version: { increment: 1 } } })
      const result = { entityId: row.id, receivingDocument: documentSummary(updated), pendingSync: false }
      await audit(tx, actor, channel, updated, 'receiving_submitted', `Submitted receiving ${row.documentNumber}.`, { commandExecutionId: execution.id, commandType, idempotencyKey: key, expectedVersion: expected, ...channel.metadata(input) })
      await changeFeed(tx, actor, channel, updated, key)
      return { result, entityId: row.id }
    })
  }

  // Cancels a receipt that was never posted: a draft or one ready for posting.
  // It keeps its lines for the record, holds no quantity and can no longer be
  // revised, submitted or posted, so the PO can be cancelled or closed.
  async function cancelDraft(id, input = {}, context, channel = RECEIVING_DRAFT_CHANNELS.desktop) {
    const actor = await authorizedActor(prisma, context, channel)
    const expected = expectedVersionOf(input.expectedVersion)
    const key = text(input.idempotencyKey)
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required.', 422)
    const reason = text(input.reason)
    if (!reason) fail('RECEIVING_CANCEL_REASON_REQUIRED', 'Give a reason for cancelling the receipt.', 422, [{ field: 'reason' }])
    const commandType = `${channel.commandPrefix}.cancel`
    return idempotent({ tenantId: actor.tenantId, commandType, key, requestHash: digest({ id: text(id), expectedVersion: expected, reason }), entityId: text(id) }, async (tx, execution) => {
      const row = await lockDraft(tx, actor, id)
      assertWarehouseAccess(actor, [...new Set([row.warehouseId, ...row.lines.map((line) => line.warehouseId)].filter(Boolean))], 'operate')
      if (row.version !== expected) fail('SYNC_VERSION_CONFLICT', 'Receiving draft changed concurrently.', 409, { entityId: row.id, expectedVersion: expected, currentVersion: row.version, conflictFields: ['workflowStatus'], availableActions: ['reload'], serverTime: serial(now()) })
      if (row.postingStatus !== RECEIVING_POSTING_STATUS.UNPOSTED || ![RECEIVING_WORKFLOW_STATUS.DRAFT, RECEIVING_WORKFLOW_STATUS.READY_FOR_RECEIVING].includes(row.workflowStatus)) fail('RECEIVING_WORKFLOW_CONFLICT', 'Only a receipt that was never posted may be cancelled. Reverse a posted receipt instead.', 409)
      const updated = await tx.receivingDocument.update({ where: { id: row.id }, data: { workflowStatus: RECEIVING_WORKFLOW_STATUS.CANCELLED, version: { increment: 1 }, metadata: { ...(row.metadata || {}), cancelledAt: serial(now()), cancelledById: actor.user.id, cancelReason: reason } } })
      const result = { entityId: row.id, receivingDocument: documentSummary(updated), pendingSync: false }
      await audit(tx, actor, channel, updated, 'receiving_cancelled', `Cancelled receipt ${row.documentNumber}.`, { commandExecutionId: execution.id, commandType, idempotencyKey: key, expectedVersion: expected, reason, previousWorkflowStatus: row.workflowStatus })
      await changeFeed(tx, actor, channel, updated, key)
      return { result, entityId: row.id }
    })
  }

  // Open receivable POs with their remaining quantities and the warehouses the
  // actor may receive into.
  async function listReceivablePurchaseOrders({ search = '', purchaseOrderId = '' } = {}, context, channel = RECEIVING_DRAFT_CHANNELS.desktop) {
    const actor = await resolveProvisionedActor(prisma, context?.identity || context)
    assertAuthorized({ actor, permission: 'receiving.read', tenantId: actor.tenantId })
    const value = text(search), id = text(purchaseOrderId)
    const rows = await prisma.purchaseOrder.findMany({
      where: { tenantId: actor.tenantId, ...(id ? { id } : { status: { in: [...RECEIVABLE_PURCHASE_ORDER_INPUTS] } }), ...(value ? { id: { contains: value, mode: 'insensitive' } } : {}) },
      include: { lines: true }, take: 50, orderBy: { updatedAt: 'desc' },
    })
    const warehouses = await prisma.warehouse.findMany({
      where: actor.allWarehouses ? { tenantId: actor.tenantId, status: 'active' } : { tenantId: actor.tenantId, status: 'active', id: { in: [...(actor.operateWarehouseIds || [])] } },
      orderBy: { code: 'asc' }, select: { id: true, code: true, name: true },
    })
    const showSupplier = actor.permissionCodes.has('finance.partner_snapshot.read') || channel === RECEIVING_DRAFT_CHANNELS.desktop
    const items = rows.map((po) => ({
      id: po.id, status: po.status, version: po.version, receivable: isPurchaseOrderReceivable(po.status),
      supplierName: showSupplier ? po.supplierName : null, currency: po.currency, defaultWarehouseId: text(po.metadata?.targetWarehouseId) || null,
      lines: po.lines.map(receivableLine),
    }))
    return { items, total: items.length, warehouses }
  }

  // Receipts of the workspace the actor may read, newest first.
  async function listReceivingDocuments({ purchaseOrderId = '' } = {}, context) {
    const actor = await resolveProvisionedActor(prisma, context?.identity || context)
    assertAuthorized({ actor, permission: 'receiving.read', tenantId: actor.tenantId })
    const rows = await prisma.receivingDocument.findMany({
      where: { tenantId: actor.tenantId, ...(text(purchaseOrderId) ? { poId: text(purchaseOrderId) } : {}) },
      include: { lines: true }, orderBy: [{ createdAt: 'desc' }], take: 200,
    })
    const visible = rows.filter((row) => hasWarehouseAccess(actor, [row.warehouseId, ...row.lines.map((line) => line.warehouseId)].filter(Boolean), 'read'))
    const warehouseIds = [...new Set(visible.map((row) => row.warehouseId).filter(Boolean))]
    const warehouses = new Map((warehouseIds.length ? await prisma.warehouse.findMany({ where: { tenantId: actor.tenantId, id: { in: warehouseIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
    const sum = (lines, field) => receivingDecimalString(lines.reduce((total, line) => total + receivingDecimalUnits(line[field] || 0), 0n))
    const items = visible.map((row) => ({
      ...documentSummary(row), supplierName: row.supplierName, receiver: row.receiver, currency: row.currency,
      warehouse: warehouses.get(row.warehouseId) || (row.warehouseId ? { id: row.warehouseId, code: row.warehouseId, name: row.warehouseId } : null),
      arrivedAt: serial(row.arrivedAt), postedAt: serial(row.postedAt), createdAt: serial(row.createdAt), updatedAt: serial(row.updatedAt),
      lineCount: row.lines.length, acceptedQuantity: sum(row.lines, 'acceptedQty'), rejectedQuantity: sum(row.lines, 'rejectedQty'),
    }))
    return { items, total: items.length }
  }

  return { createDraft, reviseDraft, submitDraft, cancelDraft, listReceivablePurchaseOrders, listReceivingDocuments }
}
