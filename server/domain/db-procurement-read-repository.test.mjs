import test from 'node:test'
import assert from 'node:assert/strict'
import { DATABASE_CONFIG_ERROR } from '../persistence/persistence-config.mjs'
import { createDbProcurementReadRepository } from '../repositories/db-procurement-read-repository.mjs'

const env = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
}

function createModel(records = []) {
  return {
    calls: [],
    findMany: async (query = {}) => {
      createModel.lastQuery = query
      return records
    },
  }
}

function createPrisma() {
  const purchaseRequest = createModel([{
    id: 'PR-DB-1',
    status: 'approved',
    requester: 'Buyer A',
    buyer: 'Buyer B',
    supplierId: 'SUP-1',
    supplierName: 'ABC Components',
    priority: 'high',
    requiredDate: new Date('2026-07-05T00:00:00.000Z'),
    amount: 1200,
    currency: 'CNY',
    reason: 'Low stock',
    source: 'mrp',
    linkedRfqId: 'RFQ-DB-1',
    linkedPoId: 'PO-DB-1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    metadata: {},
    lines: [{ sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', quantity: 10, unit: 'pcs', unitPrice: 120, amount: 1200 }],
  }])
  const rfq = createModel([{
    id: 'RFQ-DB-1',
    title: 'A100 RFQ',
    category: 'Motors',
    status: 'active',
    supplierCount: 3,
    respondedSupplierCount: 1,
    dueDate: new Date('2026-06-20T00:00:00.000Z'),
    bestPrice: 118,
    awardedSupplier: 'ABC Components',
    supplierId: 'SUP-1',
    sourceRequestId: 'PR-DB-1',
    linkedPoId: 'PO-DB-1',
    currency: 'CNY',
    createdAt: new Date('2026-06-03T00:00:00.000Z'),
    updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    metadata: {},
    lines: [{ sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', quantity: 10, unit: 'pcs' }],
  }])
  const supplierQuotation = createModel([{ id: 'SQ-DB-1', rfqId: 'RFQ-DB-1', supplierName: 'ABC Components' }])
  const purchaseOrder = createModel([{
    id: 'PO-DB-1',
    status: 'issued',
    supplierId: 'SUP-1',
    supplierName: 'ABC Components',
    sourceRequestId: 'PR-DB-1',
    sourceRfqId: 'RFQ-DB-1',
    expectedDate: new Date('2026-06-25T00:00:00.000Z'),
    amount: 1200,
    currency: 'CNY',
    owner: 'Buyer B',
    priority: 'high',
    createdAt: new Date('2026-06-05T00:00:00.000Z'),
    updatedAt: new Date('2026-06-06T00:00:00.000Z'),
    metadata: {},
    lines: [{ sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', orderedQuantity: 10, receivedQuantity: 4, unit: 'pcs', amount: 1200 }],
  }])
  const receivingDocument = createModel([{
    id: 'GRN-DB-1',
    poId: 'PO-DB-1',
    supplierId: 'SUP-1',
    supplierName: 'ABC Components',
    status: 'inspecting',
    arrivedAt: new Date('2026-06-26T00:00:00.000Z'),
    receiver: 'Receiver A',
    warehouseId: 'WH-MAIN',
    currency: 'CNY',
    createdAt: new Date('2026-06-26T00:00:00.000Z'),
    updatedAt: new Date('2026-06-26T00:00:00.000Z'),
    metadata: {},
    lines: [{ sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', acceptedQty: 4, rejectedQty: 1, unit: 'pcs' }],
  }])
  const supplierInvoice = createModel([{
    id: 'INV-DB-1',
    supplierId: 'SUP-1',
    supplierName: 'ABC Components',
    relatedPoId: 'PO-DB-1',
    relatedGrnId: 'GRN-DB-1',
    invoiceDate: new Date('2026-06-27T00:00:00.000Z'),
    dueDate: new Date('2026-07-27T00:00:00.000Z'),
    amount: 1260,
    currency: 'CNY',
    status: 'pending',
    matchStatus: 'variance',
    varianceAmount: 60,
    createdAt: new Date('2026-06-27T00:00:00.000Z'),
    updatedAt: new Date('2026-06-27T00:00:00.000Z'),
    metadata: {},
    lines: [{ sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', quantity: 10, unit: 'pcs', amount: 1260 }],
  }])
  const documentLink = createModel([{ id: 'LINK-1', sourceType: 'pr', sourceId: 'PR-DB-1', targetType: 'po', targetId: 'PO-DB-1', relationship: 'converted_po', status: 'active', metadata: {} }])
  const procurementFollowup = createModel([{ id: 'FOLLOWUP-DB-1', type: 'invoice_variance', severity: 'high', status: 'open', owner: 'Buyer B', title: 'Invoice variance', message: 'Variance requires review', dueDate: new Date('2026-07-01T00:00:00.000Z'), supplierId: 'SUP-1', supplierName: 'ABC Components', documentType: 'invoice', documentId: 'INV-DB-1' }])

  return { purchaseRequest, rfq, supplierQuotation, purchaseOrder, receivingDocument, supplierInvoice, documentLink, procurementFollowup }
}

test('database procurement repository maps mocked Prisma rows to read contract shapes', async () => {
  const repository = createDbProcurementReadRepository({ env, prisma: createPrisma() })

  const documents = await repository.listDocuments()
  const types = new Set(documents.map((item) => item.documentType))
  assert.deepEqual(types, new Set(['pr', 'rfq', 'po', 'grn', 'invoice', 'threeWayMatch']))
  assert.equal(documents.find((item) => item.documentType === 'po').receivingStatus, '部分收货')
  assert.equal(documents.find((item) => item.documentType === 'invoice').varianceAmount, 60)

  const pr = await repository.getDocument('purchase-request', 'PR-DB-1')
  const match = await repository.getDocument('3wm', 'MATCH-INV-DB-1')
  assert.equal(pr.documentType, 'pr')
  assert.equal(match.poId, 'PO-DB-1')
  assert.equal(match.invoiceAmount, 1260)

  const links = await repository.listLinks()
  const followups = await repository.listFollowups()
  const summary = await repository.getSummary()

  assert.equal(links.some((link) => link.sourceType === 'pr' && link.targetType === 'po'), true)
  assert.equal(followups.some((item) => item.id === 'FOLLOWUP-DB-1' && item.documentType === 'invoice'), true)
  assert.equal(summary.purchaseOrderCount, 1)
  assert.equal(summary.supplierInvoiceCount, 1)
  assert.equal(summary.threeWayMatchCount, 1)
  assert.equal(summary.followupCount >= 1, true)
})

test('database procurement repository preserves type helpers and clean missing DB config error', async () => {
  const repository = createDbProcurementReadRepository({ env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' } })

  assert.equal(repository.normalizeDocumentType('supplier-invoice'), 'invoice')
  assert.equal(repository.isDocumentType('unknown'), false)
  await assert.rejects(
    () => repository.listDocuments(),
    (error) => error.message === DATABASE_CONFIG_ERROR && error.code === DATABASE_CONFIG_ERROR
  )
})
