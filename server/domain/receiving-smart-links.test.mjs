import test from 'node:test'
import assert from 'node:assert/strict'
import { createReceivingWorkbenchQueryService } from './receiving-workbench-query-service.mjs'

// The related-records buttons on a receipt. One with nothing behind it is
// shown disabled with a reason; the reason carries a code so the page can say
// it in the interface language (a Chinese page showed the English sentence).

const TENANT = 'tenant-links'
const identity = { authenticated: true, tenantId: TENANT, userId: 'test-admin', role: 'admin', source: 'test' }

function fakePrisma({ movements = [] } = {}) {
  return {
    user: { findFirst: async () => null },
    receivingDocument: { findFirst: async () => ({ id: 'GRN-1', tenantId: TENANT, documentNumber: 'GRN-202611-0001', poId: 'PO-1', warehouseId: 'WH-1', lines: [{ id: 'L-1', warehouseId: 'WH-1' }] }) },
    purchaseOrder: { findFirst: async () => ({ id: 'PO-1', tenantId: TENANT, number: 'PO-202611-0001', lines: [] }) },
    warehouse: { findMany: async () => [{ id: 'WH-1', code: 'MAIN', name: 'Main' }] },
    supplier: { findFirst: async () => null },
    inventoryMovement: { findMany: async () => movements },
    inventoryBalance: { count: async () => 0 },
    auditLog: { count: async () => 0 },
  }
}

test('a related-records link with nothing behind it gives a reason code', async () => {
  const service = createReceivingWorkbenchQueryService({ prisma: fakePrisma() })
  const { links } = await service.getReceivingSmartLinks({ receivingDocumentId: 'GRN-1' }, { identity })
  const byLabel = Object.fromEntries(links.map((link) => [link.label, link]))
  for (const label of ['Movements', 'Balances', 'Audit', 'Reversal']) {
    assert.equal(byLabel[label].enabled, false, label)
    assert.equal(byLabel[label].unavailableReasonCode, 'NO_RECORDS', label)
    assert.equal(byLabel[label].unavailableReason, 'No authoritative records are available.', label)
  }
  // An enabled link has no reason.
  assert.deepEqual([byLabel['Purchase Order'].enabled, byLabel['Purchase Order'].unavailableReasonCode, byLabel['Purchase Order'].unavailableReason], [true, null, null])
})

test('a link with records has no reason code', async () => {
  const service = createReceivingWorkbenchQueryService({ prisma: fakePrisma({ movements: [{ id: 'M-1', movementType: 'receipt_posting', sku: 'SKU-1', warehouseId: 'WH-1', locationKey: 'a-01' }] }) })
  const { links } = await service.getReceivingSmartLinks({ receivingDocumentId: 'GRN-1' }, { identity })
  const movements = links.find((link) => link.label === 'Movements')
  assert.deepEqual([movements.enabled, movements.count, movements.unavailableReasonCode], [true, 1, null])
})
