import test from 'node:test'
import assert from 'node:assert/strict'
import { createReceivingDraftCommandService } from './receiving-draft-command-service.mjs'
import { handleReceivingRoute } from '../routes/receiving.routes.mjs'

// Product review 2026-11-20 (#402 review): New receipt read the purchase order
// list, which the default Operations Specialist role (every receiving
// permission, no purchase order read) cannot read, so its chooser was a dead
// end. The orders to receive are now read with receiving.prepare.

const TENANT = 'tenant-receive'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-ops', role: 'operator' }
const userWith = (permissions, scopes = [{ warehouseId: 'WH-1', accessLevel: 'operate' }]) => ({
  id: 'user-ops', tenantId: TENANT, role: 'operator', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: scopes,
  roleAssignments: [{ status: 'active', role: { id: 'role-ops', roleKey: 'operations-specialist', name: 'Operations Specialist', status: 'active', permissions: permissions.map((permissionCode) => ({ permissionCode })) } }],
})
const line = (ordered, received, extra = {}) => ({ sku: 'SKU-1', itemName: 'Valve', unit: 'pcs', orderedQuantity: String(ordered), receivedQuantity: String(received), unitPrice: '9.99', ...extra })
const ORDERS = [
  { id: 'PO-ISSUED', number: 'PO-202611-0001', status: 'issued', supplierName: 'Acme', expectedDate: new Date('2026-11-25T12:00:00Z'), metadata: { targetWarehouseId: 'WH-1' }, lines: [line(10, 4)] },
  { id: 'PO-PARTIAL', number: 'PO-202611-0002', status: 'partially_received', supplierName: 'Acme', expectedDate: new Date('2026-11-21T12:00:00Z'), metadata: { targetWarehouseId: 'WH-1' }, lines: [line(5, 5), line(3, 1, { sku: 'SKU-2' })] },
  // Nothing left to receive.
  { id: 'PO-DONE', number: 'PO-202611-0003', status: 'issued', supplierName: 'Acme', expectedDate: null, metadata: { targetWarehouseId: 'WH-1' }, lines: [line(2, 2)] },
  // Another warehouse the reader cannot operate.
  { id: 'PO-OTHER-WH', number: 'PO-202611-0004', status: 'issued', supplierName: 'Globex', expectedDate: null, metadata: { targetWarehouseId: 'WH-2' }, lines: [line(7, 0)] },
  // Approved, not issued: counted, not listed; one stored with a legacy status.
  { id: 'PO-APPROVED', number: 'PO-202611-0005', status: 'approved', supplierName: 'Acme', expectedDate: null, metadata: { targetWarehouseId: 'WH-1' }, lines: [line(6, 0)] },
  { id: 'PO-APPROVED-LEGACY', number: 'PO-202611-0006', status: '已批准', supplierName: 'Acme', expectedDate: null, metadata: {}, lines: [line(1, 0)] },
  { id: 'PO-APPROVED-OTHER-WH', number: 'PO-202611-0007', status: 'approved', supplierName: 'Globex', expectedDate: null, metadata: { targetWarehouseId: 'WH-2' }, lines: [line(1, 0)] },
]

function fakePrisma(user, orders = ORDERS) {
  const calls = []
  const pick = (row, select) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
  return {
    calls,
    user: { findFirst: async () => structuredClone(user) },
    purchaseOrder: {
      findMany: async (args) => {
        calls.push(args)
        const rows = args.where.id ? orders.filter((row) => args.where.id.in.includes(row.id)) : orders.filter((row) => args.where.status.in.includes(row.status))
        const sorted = args.orderBy ? [...rows].sort((a, b) => String(a.expectedDate?.toISOString() || '9999').localeCompare(String(b.expectedDate?.toISOString() || '9999')) || a.id.localeCompare(b.id)) : rows
        return structuredClone((args.take ? sorted.slice(0, args.take) : sorted).map((row) => pick(row, args.select)))
      },
    },
  }
}

test('a receiver without purchase order access gets the issued orders with quantity to receive, in their warehouses, and the approved ones counted', async () => {
  const prisma = fakePrisma(userWith(['receiving.read', 'receiving.prepare', 'receiving.submit']))
  const result = await createReceivingDraftCommandService({ prisma }).listOrdersToReceive({ identity })
  // Earliest expected arrival first.
  assert.deepEqual(result.orders.map((order) => order.id), ['PO-PARTIAL', 'PO-ISSUED'])
  assert.deepEqual(result.orders[0], {
    id: 'PO-PARTIAL', number: 'PO-202611-0002', status: 'partially_received', supplierName: 'Acme', expectedDate: '2026-11-21',
    lines: [
      { sku: 'SKU-1', itemName: 'Valve', unit: 'pcs', orderedQuantity: '5', receivedQuantity: '5' },
      { sku: 'SKU-2', itemName: 'Valve', unit: 'pcs', orderedQuantity: '3', receivedQuantity: '1' },
    ],
  })
  // No price, amount or currency leaves.
  assert.doesNotMatch(JSON.stringify(result), /9\.99|unitPrice|currency/)
  // Approved in the reader's warehouses (or with none set), whatever the stored spelling.
  assert.equal(result.notIssued, 2)
  assert.equal(result.truncated, false)
  // Read for the tenant only: first scope and order, then the shown orders' lines, without prices.
  assert.deepEqual(prisma.calls.map((call) => call.where.tenantId), [TENANT, TENANT])
  assert.deepEqual(prisma.calls[0].orderBy, [{ expectedDate: 'asc' }, { id: 'asc' }])
  assert.ok(!('lines' in prisma.calls[0].select))
  // An issued order with nothing left (PO-DONE) is read, then left out by its lines.
  assert.deepEqual(prisma.calls[1].where.id.in, ['PO-PARTIAL', 'PO-ISSUED', 'PO-DONE'])
  assert.ok(!('unitPrice' in prisma.calls[1].select.lines.select))
})

test('someone who may only read receipts cannot list orders to receive', async () => {
  const prisma = fakePrisma(userWith(['receiving.read']))
  await assert.rejects(createReceivingDraftCommandService({ prisma }).listOrdersToReceive({ identity }), { status: 403 })
  assert.equal(prisma.calls.length, 0)
})

test('GET /api/procurement/receivable-orders answers from the receiving service', async () => {
  const sent = []
  const ctx = {
    req: { method: 'GET', headers: {} }, url: new URL('http://local/api/procurement/receivable-orders'), identity, env: {}, res: {},
    receivingDraftService: { listOrdersToReceive: async (context) => ({ orders: [], notIssued: 3, truncated: false, by: context.identity.userId }) },
    send: (_res, status, body) => sent.push({ status, body }),
  }
  assert.equal(await handleReceivingRoute(ctx), true)
  assert.deepEqual(sent, [{ status: 200, body: { orders: [], notIssued: 3, truncated: false, by: 'user-ops' } }])
})

test("orders in other warehouses never hide the reader's own, however many there are", async () => {
  // 600 orders due earlier, all in a warehouse the reader cannot operate.
  const others = Array.from({ length: 600 }, (_, at) => ({ id: `PO-OTHER-${String(at).padStart(3, '0')}`, number: `PO-OTHER-${at}`, status: 'issued', supplierName: 'Globex', expectedDate: new Date(Date.UTC(2026, 9, 1) + at * 60_000), metadata: { targetWarehouseId: 'WH-2' }, lines: [line(5, 0)] }))
  const prisma = fakePrisma(userWith(['receiving.read', 'receiving.prepare']), [...others, ...ORDERS])
  const result = await createReceivingDraftCommandService({ prisma }).listOrdersToReceive({ identity })
  assert.deepEqual(result.orders.map((order) => order.id), ['PO-PARTIAL', 'PO-ISSUED'])
  assert.equal(result.notIssued, 2)
  assert.equal(result.truncated, false)
})

test('the legacy spellings the purchase order list reads as approved or issued count the same here', async () => {
  const legacy = [
    { id: 'PO-LEGACY-APPROVED', number: 'PO-L-1', status: '已审批', supplierName: 'Acme', expectedDate: null, metadata: { targetWarehouseId: 'WH-1' }, lines: [line(4, 0)] },
    { id: 'PO-LEGACY-ISSUED', number: 'PO-L-2', status: '已下达', supplierName: 'Acme', expectedDate: null, metadata: { targetWarehouseId: 'WH-1' }, lines: [line(4, 1)] },
    { id: 'PO-LEGACY-SENT', number: 'PO-L-3', status: '已发出', supplierName: 'Acme', expectedDate: null, metadata: {}, lines: [line(2, 0)] },
  ]
  const prisma = fakePrisma(userWith(['receiving.read', 'receiving.prepare']), legacy)
  const result = await createReceivingDraftCommandService({ prisma }).listOrdersToReceive({ identity })
  assert.deepEqual(result.orders.map((order) => [order.id, order.status]), [['PO-LEGACY-ISSUED', 'issued'], ['PO-LEGACY-SENT', 'issued']])
  assert.equal(result.notIssued, 1)
})
