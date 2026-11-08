import test from 'node:test'
import assert from 'node:assert/strict'
import { createReceivingDraftCommandService } from './receiving-draft-command-service.mjs'

// The receipt list (/app/procurement/receiving) reads every receipt the user
// may see. It used to read the newest 200 and report them as the total, so a
// workspace with 350 receipts showed "200 total" and no way to the rest.

const TENANT = 'tenant-receipts'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const user = {
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [{ warehouseId: 'WH-1', accessLevel: 'operate' }],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'receiver', name: 'Receiver', status: 'active', permissions: [{ permissionCode: 'receiving.read' }] } }],
}

// 350 receipts in WH-1, newest first, and one in a warehouse the user cannot read.
const receipts = [
  ...Array.from({ length: 350 }, (_, index) => ({
    id: `GRN-${String(index + 1).padStart(3, '0')}`, tenantId: TENANT, documentNumber: `GRN-202611-${String(index + 1).padStart(4, '0')}`,
    poId: 'PO-1', supplierName: 'Acme', receiver: 'Kim', currency: 'USD', warehouseId: 'WH-1',
    workflowStatus: 'received', postingStatus: index % 7 === 0 ? 'unposted' : 'posted', version: 1,
    arrivedAt: new Date(Date.UTC(2026, 9, 1) + index * 3600e3), postedAt: null, createdAt: new Date(Date.UTC(2026, 9, 1) + index * 3600e3), updatedAt: new Date(Date.UTC(2026, 9, 1)),
    lines: [{ warehouseId: 'WH-1', acceptedQty: '4.5', rejectedQty: index === 0 ? '1' : '0' }, { warehouseId: 'WH-1', acceptedQty: '2', rejectedQty: '0' }],
  })),
  { id: 'GRN-HIDDEN', tenantId: TENANT, documentNumber: 'GRN-HIDDEN', poId: 'PO-2', warehouseId: 'WH-2', workflowStatus: 'received', postingStatus: 'posted', version: 1, createdAt: new Date(Date.UTC(2026, 11, 1)), updatedAt: new Date(Date.UTC(2026, 11, 1)), lines: [{ warehouseId: 'WH-2', acceptedQty: '1', rejectedQty: '0' }] },
].reverse()

function fakePrisma() {
  const calls = []
  return {
    calls,
    user: { findFirst: async () => structuredClone(user) },
    receivingDocument: {
      findMany: async (args) => {
        calls.push(args)
        const rows = receipts.filter((row) => row.tenantId === args.where.tenantId && (!args.where.poId || row.poId === args.where.poId))
        return structuredClone(args.take ? rows.slice(0, args.take) : rows)
      },
    },
    warehouse: { findMany: async () => [{ id: 'WH-1', code: 'MAIN', name: 'Main warehouse' }] },
    purchaseOrder: { findMany: async () => [{ id: 'PO-1', number: 'PO-202611-0001', metadata: null }] },
  }
}

test('the receipt list returns every readable receipt and its true total', async () => {
  const prisma = fakePrisma()
  const service = createReceivingDraftCommandService({ prisma })
  const result = await service.listReceivingDocuments({}, { identity })
  assert.equal(result.total, 350)
  assert.equal(result.items.length, 350)
  assert.equal(prisma.calls[0].take, undefined, 'no cap on the number of receipts')
  // Lines are read only for what the list shows.
  assert.deepEqual(prisma.calls[0].include, { lines: { select: { warehouseId: true, acceptedQty: true, rejectedQty: true } } })
  assert.ok(!result.items.some((item) => item.id === 'GRN-HIDDEN'), 'a receipt in an unreadable warehouse stays out')
  // Newest first, and the oldest is reachable.
  assert.equal(result.items[0].id, 'GRN-350')
  assert.equal(result.items.at(-1).id, 'GRN-001')
  const oldest = result.items.at(-1)
  assert.deepEqual([oldest.documentNumber, oldest.poNumber, oldest.acceptedQuantity, oldest.rejectedQuantity, oldest.lineCount, oldest.warehouse.name], ['GRN-202611-0001', 'PO-202611-0001', '6.5000', '1.0000', 2, 'Main warehouse'])
})

test('the receipt list of one purchase order is filtered on the server', async () => {
  const prisma = fakePrisma()
  const service = createReceivingDraftCommandService({ prisma })
  const result = await service.listReceivingDocuments({ purchaseOrderId: 'PO-2' }, { identity })
  assert.equal(prisma.calls[0].where.poId, 'PO-2')
  assert.deepEqual([result.total, result.items.length], [0, 0])
})
