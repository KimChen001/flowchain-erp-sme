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

function fakePrisma(user) {
  const calls = []
  return {
    calls,
    user: { findFirst: async () => structuredClone(user) },
    purchaseOrder: {
      findMany: async (args) => {
        calls.push(args)
        return structuredClone(ORDERS.filter((row) => args.where.status.in.includes(row.status)))
      },
    },
  }
}

test('a receiver without purchase order access gets the issued orders with quantity to receive, in their warehouses, and the approved ones counted', async () => {
  const prisma = fakePrisma(userWith(['receiving.read', 'receiving.prepare', 'receiving.submit']))
  const result = await createReceivingDraftCommandService({ prisma }).listOrdersToReceive({ identity })
  assert.deepEqual(result.orders.map((order) => order.id), ['PO-ISSUED', 'PO-PARTIAL'])
  assert.deepEqual(result.orders[1], {
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
  // Read for the tenant only, earliest expected first, without prices.
  assert.equal(prisma.calls[0].where.tenantId, TENANT)
  assert.deepEqual(prisma.calls[0].orderBy, [{ expectedDate: 'asc' }, { id: 'asc' }])
  assert.ok(!('unitPrice' in prisma.calls[0].select.lines.select))
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
