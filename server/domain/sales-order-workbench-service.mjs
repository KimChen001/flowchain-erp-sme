import { randomUUID } from 'node:crypto'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { outboundRequestHash } from './outbound-posting-command-service.mjs'
import { outboundDecimalString as fixed, outboundDecimalUnits as units } from './outbound-transaction-policy.mjs'

export class SalesWorkbenchError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.name = 'SalesWorkbenchError'; this.code = code; this.status = status; this.details = details }
}
const fail = (code, message, status = 400, details) => { throw new SalesWorkbenchError(code, message, status, details) }
const text = (value) => String(value ?? '').trim()
const iso = (value) => value ? new Date(value).toISOString() : null
const quantity = (value) => { try { const result = units(value); if (result <= 0n) throw new Error(); return fixed(result) } catch { fail('SALES_ORDER_VALIDATION_FAILED', 'Line quantity must be positive with at most four decimal places.', 422) } }
const price = (value) => {
  if (value === null || value === undefined || text(value) === '') return null
  try {
    const result = units(value)
    if (result < 0n) throw new Error()
    return fixed(result)
  } catch {
    fail('SALES_ORDER_VALIDATION_FAILED', 'Line unit price must be non-negative with at most four decimal places.', 422)
  }
}
const amount = (quantityValue, priceValue) => {
  if (priceValue === null) return null
  const product = units(quantityValue) * units(priceValue)
  return fixed((product + 5_000n) / 10_000n)
}
const commandPermission = (commandType) => commandType === 'create_sales_order_draft' ? 'sales_order.create' : commandType === 'revise_sales_order_draft' ? 'sales_order.revise' : commandType === 'hold_sales_order' ? 'sales_order.cancel' : 'sales_order.submit'

async function actorFor(prisma, context) { return resolveProvisionedActor(prisma, context?.identity || context) }
async function authoritativeLines(prisma, tenantId, lines) {
  if (!Array.isArray(lines) || !lines.length) fail('SALES_ORDER_VALIDATION_FAILED', 'At least one sales order line is required.', 422)
  const normalized = lines.map((line) => {
    const orderedQuantity = quantity(line.quantity ?? line.orderedQuantity)
    const unitPrice = price(line.unitPrice)
    return { itemId: text(line.itemId), orderedQuantity, unitPrice, amount: amount(orderedQuantity, unitPrice) }
  })
  if (normalized.some((line) => !line.itemId)) fail('SALES_ORDER_VALIDATION_FAILED', 'Every line requires an item.', 422)
  const items = await prisma.item.findMany({ where: { tenantId, id: { in: [...new Set(normalized.map((line) => line.itemId))] }, status: 'active' } })
  const map = new Map(items.map((item) => [item.id, item]))
  if (normalized.some((line) => !map.has(line.itemId))) fail('SALES_ORDER_ITEM_INVALID', 'Every line must reference an active item in this workspace.', 422)
  return normalized.map((line) => { const item = map.get(line.itemId); return { id: randomUUID(), itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: line.orderedQuantity, unit: text(item.unit) || 'EA', unitPrice: line.unitPrice, amount: line.amount } })
}

function publicOrder(order) {
  return {
    id: order.id, orderNumber: order.orderNumber, customerId: order.customerId, customerName: order.customerName,
    promisedDate: iso(order.promisedDate), currency: order.currency, workflowStatus: order.workflowStatus,
    reservationStatus: order.reservationStatus, fulfillmentStatus: order.fulfillmentStatus, version: order.version,
    createdAt: iso(order.createdAt), updatedAt: iso(order.updatedAt),
    lines: (order.lines || []).map((line) => ({ id: line.id, itemId: line.itemId, sku: line.sku, itemName: line.itemName, orderedQuantity: fixed(units(line.orderedQuantity)), reservedQuantity: fixed(units(line.reservedQuantity)), fulfilledQuantity: fixed(units(line.fulfilledQuantity)), unit: line.unit, unitPrice: line.unitPrice === null || line.unitPrice === undefined ? null : fixed(units(line.unitPrice)), amount: line.amount === null || line.amount === undefined ? null : fixed(units(line.amount)), version: line.version })),
  }
}

export function createSalesOrderWorkbenchService({ prisma, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error('prisma is required')

  async function execute(commandType, idempotencyKey, payload, context, work) {
    const actor = await actorFor(prisma, context)
    assertAuthorized({ actor, permission: commandPermission(commandType), tenantId: actor.tenantId })
    const key = text(idempotencyKey)
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required.', 400)
    const requestHash = outboundRequestHash(payload)
    const where = { tenantId_commandType_idempotencyKey: { tenantId: actor.tenantId, commandType, idempotencyKey: key } }
    const replay = (row) => {
      if (!row) return null
      if (row.requestHash !== requestHash) fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'The idempotency key was used with a different request.', 409)
      if (row.status !== 'completed' || !row.resultPayload) fail('COMMAND_EXECUTION_IN_PROGRESS', 'The command is already in progress.', 409)
      return { ...row.resultPayload, idempotentReplay: true }
    }
    const existing = replay(await prisma.businessCommandExecution.findUnique({ where })); if (existing) return existing
    try {
      return await prisma.$transaction(async (tx) => {
        const inside = replay(await tx.businessCommandExecution.findUnique({ where })); if (inside) return inside
        const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey: key, requestHash, status: 'pending' } })
        const result = await work(tx, actor, execution)
        await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: 'sales_order_workbench', module: 'sales_outbound', action: commandType, entityType: 'SalesOrder', entityId: result.order.id, summary: result.summary, metadata: { commandType, commandExecutionId: execution.id, idempotencyKey: key } } })
        const response = { entityType: 'SalesOrder', entityId: result.order.id, order: publicOrder(result.order), commandExecutionId: execution.id }
        await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: 'completed', entityType: 'SalesOrder', entityId: result.order.id, resultPayload: response, completedAt: now() } })
        return { ...response, idempotentReplay: false }
      }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 })
    } catch (error) {
      if (error instanceof SalesWorkbenchError || error?.name === 'PilotIdentityError') throw error
      if (error?.code === 'P2002') {
        const concurrent = replay(await prisma.businessCommandExecution.findUnique({ where })); if (concurrent) return concurrent
        if (/orderNumber|SalesOrder_tenantId_orderNumber/i.test(JSON.stringify(error?.meta || error))) fail('SALES_ORDER_NUMBER_CONFLICT', 'Sales order number is already in use for this workspace.', 409)
      }
      if (error?.code === 'P2034' || /serialization|deadlock/i.test(text(error?.message))) fail('OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT', 'Sales order changed in another transaction. Refresh and retry.', 409)
      throw error
    }
  }

  async function createOrder(input, context) {
    const payload = { orderNumber: text(input.orderNumber), customerName: text(input.customerName), customerId: text(input.customerId) || null, promisedDate: input.promisedDate || null, currency: text(input.currency).toUpperCase(), lines: input.lines || [] }
    if (!payload.orderNumber || !payload.customerName || !/^[A-Z]{3}$/.test(payload.currency)) fail('SALES_ORDER_VALIDATION_FAILED', 'Order number, customer, and a three-letter currency code are required.', 422)
    return execute('create_sales_order_draft', input.idempotencyKey, payload, context, async (tx, actor) => {
      if (await tx.salesOrder.findFirst({ where: { tenantId: actor.tenantId, orderNumber: payload.orderNumber }, select: { id: true } })) fail('SALES_ORDER_NUMBER_CONFLICT', 'Sales order number is already in use for this workspace.', 409)
      const lines = await authoritativeLines(tx, actor.tenantId, payload.lines)
      const order = await tx.salesOrder.create({ data: { id: idFactory(), tenantId: actor.tenantId, orderNumber: payload.orderNumber, customerName: payload.customerName, customerId: payload.customerId, promisedDate: payload.promisedDate ? new Date(payload.promisedDate) : null, currency: payload.currency, workflowStatus: 'draft', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', lines: { create: lines } }, include: { lines: { orderBy: { id: 'asc' } } } })
      return { order, summary: `Sales order ${order.orderNumber} draft created.` }
    })
  }

  async function reviseOrder(id, input, context) {
    const payload = { id: text(id), expectedOrderVersion: Number(input.expectedOrderVersion), revisionMode: text(input.revisionMode), expectedLineIds: Array.isArray(input.expectedLineIds) ? input.expectedLineIds.map(text) : [], header: input.header || {}, lines: input.lines || [] }
    if (!Number.isInteger(payload.expectedOrderVersion) || payload.expectedOrderVersion < 0) fail('SALES_ORDER_VALIDATION_FAILED', 'expectedOrderVersion is required.', 422)
    return execute('revise_sales_order_draft', input.idempotencyKey, payload, context, async (tx, actor) => {
      const current = await tx.salesOrder.findFirst({ where: { id: payload.id, tenantId: actor.tenantId }, include: { lines: { orderBy: { id: 'asc' } }, reservations: true, shipments: true } })
      if (!current) fail('SALES_ORDER_NOT_FOUND', 'Sales order was not found.', 404)
      if (current.workflowStatus !== 'draft') fail('SALES_ORDER_INVALID_STATE', 'Only draft sales orders can be edited.', 409)
      if (current.version !== payload.expectedOrderVersion) fail('SALES_ORDER_VERSION_CONFLICT', 'Sales order version does not match.', 409)
      if (current.reservations.length || current.shipments.length) fail('SALES_ORDER_INVALID_STATE', 'Lines cannot be edited after fulfillment activity exists.', 409)
      const expectedIds = [...payload.expectedLineIds].sort(), currentIds = current.lines.map((line) => line.id).sort()
      if (payload.revisionMode !== 'replace_all' || expectedIds.length !== currentIds.length || expectedIds.some((id, index) => id !== currentIds[index])) fail('SALES_ORDER_DRAFT_REVISION_INCOMPLETE', 'Sales order lines changed and an incomplete draft replacement was blocked. Refresh before editing again.', 409)
      const lines = await authoritativeLines(tx, actor.tenantId, payload.lines)
      const currency = text(payload.header.currency || current.currency).toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) fail('SALES_ORDER_VALIDATION_FAILED', 'Currency must be a three-letter code.', 422)
      await tx.salesOrderLine.deleteMany({ where: { salesOrderId: current.id } })
      const order = await tx.salesOrder.update({ where: { id: current.id }, data: { customerName: text(payload.header.customerName || current.customerName), customerId: text(payload.header.customerId) || null, promisedDate: payload.header.promisedDate ? new Date(payload.header.promisedDate) : null, currency, version: { increment: 1 }, lines: { create: lines } }, include: { lines: { orderBy: { id: 'asc' } } } })
      return { order, summary: `Sales order ${order.orderNumber} draft revised.` }
    })
  }

  async function transition(id, action, input, context) {
    const definitions = { confirm: ['draft', 'confirmed'], hold: ['confirmed', 'on_hold'], resume: ['on_hold', 'confirmed'] }
    const definition = definitions[action]; if (!definition) fail('SALES_ORDER_INVALID_STATE', 'Unsupported sales order transition.', 409)
    const payload = { id: text(id), expectedOrderVersion: Number(input.expectedOrderVersion), action }
    if (!Number.isInteger(payload.expectedOrderVersion) || payload.expectedOrderVersion < 0) fail('SALES_ORDER_VALIDATION_FAILED', 'expectedOrderVersion is required.', 422)
    return execute(`${action}_sales_order`, input.idempotencyKey, payload, context, async (tx, actor) => {
      const current = await tx.salesOrder.findFirst({ where: { id: payload.id, tenantId: actor.tenantId }, include: { lines: true } })
      if (!current) fail('SALES_ORDER_NOT_FOUND', 'Sales order was not found.', 404)
      if (current.version !== payload.expectedOrderVersion) fail('SALES_ORDER_VERSION_CONFLICT', 'Sales order version does not match.', 409)
      if (current.workflowStatus !== definition[0]) fail('SALES_ORDER_INVALID_STATE', `Sales order cannot ${action} from its current state.`, 409)
      if (!current.lines.length) fail('SALES_ORDER_VALIDATION_FAILED', 'Sales order requires at least one line.', 422)
      await authoritativeLines(tx, actor.tenantId, current.lines.map((line) => ({ itemId: line.itemId, quantity: fixed(units(line.orderedQuantity)), unitPrice: line.unitPrice === null || line.unitPrice === undefined ? null : fixed(units(line.unitPrice)) })))
      const order = await tx.salesOrder.update({ where: { id: current.id }, data: { workflowStatus: definition[1], version: { increment: 1 } }, include: { lines: { orderBy: { id: 'asc' } } } })
      return { order, summary: `Sales order ${order.orderNumber} ${action} completed.` }
    })
  }

  return { createOrder, reviseOrder, confirmOrder: (id, input, context) => transition(id, 'confirm', input, context), holdOrder: (id, input, context) => transition(id, 'hold', input, context), resumeOrder: (id, input, context) => transition(id, 'resume', input, context) }
}

export function createSalesOrderReadService({ prisma, lifecycleCapability = { enabled: false } } = {}) {
  if (!prisma) throw new Error('prisma is required')
  async function listOrders(query, context) {
    const actor = await actorFor(prisma, context)
    assertAuthorized({ actor, permission: 'sales_order.read', tenantId: actor.tenantId })
    const page = Math.max(1, Number(query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20))
    const where = { tenantId: actor.tenantId }
    const search = text(query.search); if (search) where.OR = [{ orderNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }]
    for (const key of ['workflowStatus', 'reservationStatus', 'fulfillmentStatus', 'currency']) if (text(query[key])) where[key] = text(query[key])
    if (text(query.customer)) where.customerName = { contains: text(query.customer), mode: 'insensitive' }
    const sort = ['promisedDate', 'orderNumber'].includes(query.sort) ? query.sort : 'updatedAt', direction = query.direction === 'asc' ? 'asc' : 'desc'
    const [total, rows] = await Promise.all([prisma.salesOrder.count({ where }), prisma.salesOrder.findMany({ where, include: { lines: true }, orderBy: [{ [sort]: direction }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize } )])
    return { dataSource: 'Authoritative PostgreSQL', page, pageSize, total, capabilities: { salesOrderLifecycle: lifecycleCapability }, orders: rows.map((row) => { const order = publicOrder(row); return { ...order, totalLines: row.lines.length, orderedQuantity: fixed(row.lines.reduce((sum, line) => sum + units(line.orderedQuantity), 0n)), reservedQuantity: fixed(row.lines.reduce((sum, line) => sum + units(line.reservedQuantity), 0n)), fulfilledQuantity: fixed(row.lines.reduce((sum, line) => sum + units(line.fulfilledQuantity), 0n)) } }) }
  }
  async function entryData(context) {
    const actor = await actorFor(prisma, context)
    assertAuthorized({ actor, permission: 'sales_order.read', tenantId: actor.tenantId })
    const items = await prisma.item.findMany({ where: { tenantId: actor.tenantId, status: 'active' }, select: { id: true, sku: true, name: true, unit: true }, orderBy: { sku: 'asc' }, take: 200 })
    return { dataSource: 'Authoritative PostgreSQL', capabilities: { salesOrderLifecycle: lifecycleCapability }, items: lifecycleCapability.enabled ? items : [] }
  }
  return { listOrders, entryData }
}
