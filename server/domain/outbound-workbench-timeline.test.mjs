import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutboundWorkbenchReadService } from './outbound-workbench-read-service.mjs'

// The order timeline puts every event on the business clock. The public data
// import replays an order's reserve, draft and post commands at the time it
// imports (here Nov 7, 13:50 UTC) and writes the records a day later (Nov 8,
// 06:21): the shipment's postedAt, its stock movements and the commands'
// completion times carry the business time; the reservation events, the audit
// records and the movement rows' createdAt carry the import run. Ordered by
// those creation times, "Stock shipped out" came first, a day before the
// shipment was created.

const TENANT = 'tenant-a'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const user = {
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [{ warehouseId: 'WH-1', accessLevel: 'operate' }],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'sales', name: 'Sales', status: 'active', permissions: ['sales_order.read', 'shipment.read'].map((permissionCode) => ({ permissionCode })) } }],
}

const BUSINESS = new Date('2026-11-07T13:50:00.000Z')
// The import run, a few milliseconds apart in the order the records were written.
const run = (ms) => new Date(Date.UTC(2026, 10, 8, 6, 21, 49, ms))

const order = {
  id: 'SO-1', tenantId: TENANT, orderNumber: 'SO-202611-0107', customerId: 'CUS-1', customerName: 'Customer 12680',
  currency: 'GBP', workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'fully_fulfilled',
  promisedDate: new Date('2026-11-07T12:00:00Z'), version: 3, createdAt: new Date('2026-11-07T12:50:00Z'), updatedAt: run(778),
  lines: [{ id: 'L1', itemId: 'ITEM-1', sku: 'SKU-1', itemName: 'Item 1', orderedQuantity: '12', reservedQuantity: '0', fulfilledQuantity: '12', unit: 'pcs', unitPrice: '1.65', version: 2 }],
  reservations: [{ id: 'R1', salesOrderId: 'SO-1', salesOrderLineId: 'L1', itemId: 'ITEM-1', sku: 'SKU-1', warehouseId: 'WH-1', location: 'A-01', locationKey: 'a-01', reservedQuantity: '12', allocatedQuantity: '0', consumedQuantity: '12', releasedQuantity: '0', status: 'consumed', version: 3 }],
  shipments: [{
    id: 'SH-1', shipmentNumber: 'DN-202611-0107', salesOrderId: 'SO-1', workflowStatus: 'ready', postingStatus: 'posted', version: 1,
    postedAt: BUSINESS, reversedAt: null, createdAt: run(701), updatedAt: run(779),
    lines: [{ id: 'SHL-1', salesOrderLineId: 'L1', allocations: [{ id: 'AL-1', warehouseId: 'WH-1', location: 'A-01', quantity: '12', status: 'consumed' }] }],
  }],
}

const execution = (id, commandType, key, entityType, entityId) => ({ id, commandType, idempotencyKey: key, entityType, entityId, completedAt: BUSINESS })
const reserve = execution('EX-R', 'reserve_sales_order_inventory', 'import:reserve:SO-1', 'SalesOrder', 'SO-1')
const draft = execution('EX-D', 'create_shipment_draft', 'import:draft:SO-1', 'ShipmentDocument', 'SH-1')
const post = execution('EX-P', 'post_sales_shipment', 'import:post:SO-1', 'ShipmentDocument', 'SH-1')

const audit = (id, action, entityType, entityId, ex, ms, metadata = {}) => ({
  id, tenantId: TENANT, action, entityType, entityId, createdAt: run(ms), summary: '', actor: null,
  metadata: { commandType: ex.commandType, idempotencyKey: ex.idempotencyKey, ...metadata },
})
const event = (id, eventType, ex, ms) => ({ id, tenantId: TENANT, reservationId: 'R1', eventType, quantity: '12', commandType: ex.commandType, commandExecutionId: ex.id, commandExecution: ex, actor: null, createdAt: run(ms) })

function fakePrisma({ audits, events, movements, executions = [] }) {
  const calls = []
  return {
    calls,
    user: { findFirst: async () => user },
    salesOrder: { findFirst: async () => order },
    inventoryBalance: { findMany: async () => [] },
    auditLog: { findMany: async () => audits },
    inventoryReservationEvent: { findMany: async () => events },
    inventoryMovement: { findMany: async () => movements },
    businessCommandExecution: {
      findMany: async (args) => {
        calls.push(args)
        return executions
      },
    },
  }
}

const importedOrder = () => fakePrisma({
  // As the database returns them: audits and events by createdAt, movements by occurredAt.
  audits: [
    audit('A-R', 'sales_inventory_reserved', 'SalesOrder', 'SO-1', reserve, 681, { reservationIds: ['R1'] }),
    audit('A-D', 'shipment_draft_created', 'ShipmentDocument', 'SH-1', draft, 713),
    audit('A-P', 'sales_shipment_posted', 'ShipmentDocument', 'SH-1', post, 780),
  ],
  events: [event('E-R', 'reserved', reserve, 675), event('E-A', 'allocated', draft, 707), event('E-C', 'consumed', post, 768)],
  movements: [{ id: 'M-1', movementType: 'shipment_posting', sku: 'SKU-1', itemName: 'Item 1', warehouseId: 'WH-1', location: 'A-01', quantityIn: '0', quantityOut: '12', sourceDocumentId: 'SH-1', occurredAt: BUSINESS, createdAt: run(745) }],
})

test('an imported order reads in the order it happened, every event at the business time', async () => {
  const prisma = importedOrder()
  const workbench = await createOutboundWorkbenchReadService({ prisma }).orderWorkbench('SO-1', { identity })
  assert.deepEqual(workbench.evidence.map((row) => row.eventType), [
    'reservation_reserved', 'sales_inventory_reserved',
    'reservation_allocated', 'shipment_draft_created',
    'shipment_posting', 'reservation_consumed', 'sales_shipment_posted',
  ])
  // One clock: the shipment posted when its stock left, and so did everything before it.
  for (const row of workbench.evidence) assert.equal(row.occurredAt, BUSINESS.toISOString(), row.eventType)
  const posted = workbench.evidence.find((row) => row.eventType === 'sales_shipment_posted')
  const shippedOut = workbench.evidence.find((row) => row.eventType === 'shipment_posting')
  assert.equal(posted.occurredAt, shippedOut.occurredAt)
  assert.equal(posted.occurredAt, workbench.shipments[0].postedAt)
  // When each record was written stays readable.
  assert.equal(posted.recordedAt, run(780).toISOString())
  // Every audit's command was known from the reservation events: no extra read.
  assert.equal(prisma.calls.length, 0)
})

test('a posting reads at the shipment postedAt even when its command completed later', async () => {
  // Live use: the posting command stamps the shipment and its movements first
  // and completes a few milliseconds later.
  const late = { ...post, completedAt: new Date(BUSINESS.getTime() + 40) }
  const prisma = fakePrisma({
    audits: [audit('A-P', 'sales_shipment_posted', 'ShipmentDocument', 'SH-1', late, 780)],
    events: [event('E-C', 'consumed', late, 768)],
    movements: [{ id: 'M-1', movementType: 'shipment_posting', sku: 'SKU-1', warehouseId: 'WH-1', quantityIn: '0', quantityOut: '12', sourceDocumentId: 'SH-1', occurredAt: BUSINESS, createdAt: run(745) }],
  })
  const { evidence } = await createOutboundWorkbenchReadService({ prisma }).orderWorkbench('SO-1', { identity })
  assert.deepEqual(evidence.map((row) => row.eventType), ['shipment_posting', 'reservation_consumed', 'sales_shipment_posted'])
  assert.ok(evidence.every((row) => row.occurredAt === BUSINESS.toISOString()))
})

test("an order command's audit reads at its command's completion time, looked up once", async () => {
  // An order confirmed by a command run on a business clock: its audit record
  // names the execution, which the reservation events do not.
  const confirm = { id: 'EX-C', commandType: 'confirm_sales_order', idempotencyKey: 'import:confirm:SO-1', entityType: 'SalesOrder', entityId: 'SO-1', completedAt: new Date('2026-11-07T13:00:00Z') }
  const prisma = fakePrisma({
    audits: [
      { ...audit('A-C', 'confirm_sales_order', 'SalesOrder', 'SO-1', confirm, 600), metadata: { commandType: 'confirm_sales_order', commandExecutionId: 'EX-C', idempotencyKey: 'import:confirm:SO-1' } },
      audit('A-P', 'sales_shipment_posted', 'ShipmentDocument', 'SH-1', post, 780),
    ],
    events: [event('E-C', 'consumed', post, 768)],
    movements: [],
    executions: [confirm],
  })
  const { evidence } = await createOutboundWorkbenchReadService({ prisma }).orderWorkbench('SO-1', { identity })
  assert.deepEqual(evidence.map((row) => [row.eventType, row.occurredAt]), [
    ['confirm_sales_order', '2026-11-07T13:00:00.000Z'],
    ['reservation_consumed', BUSINESS.toISOString()],
    ['sales_shipment_posted', BUSINESS.toISOString()],
  ])
  assert.equal(prisma.calls.length, 1)
  assert.equal(prisma.calls[0].where.tenantId, TENANT)
  assert.deepEqual(prisma.calls[0].where.OR, [{ id: { in: ['EX-C'] } }, { idempotencyKey: { in: ['import:confirm:SO-1'] } }])
})

test('an event with no business time keeps the time it was recorded', async () => {
  const prisma = fakePrisma({
    audits: [{ id: 'A-X', tenantId: TENANT, action: 'hold_sales_order', entityType: 'SalesOrder', entityId: 'SO-1', createdAt: run(100), summary: '', actor: null, metadata: {} }],
    events: [],
    movements: [],
  })
  const { evidence } = await createOutboundWorkbenchReadService({ prisma }).orderWorkbench('SO-1', { identity })
  assert.deepEqual(evidence.map((row) => [row.eventType, row.occurredAt, row.recordedAt]), [['hold_sales_order', run(100).toISOString(), run(100).toISOString()]])
  assert.equal(prisma.calls.length, 0)
})
