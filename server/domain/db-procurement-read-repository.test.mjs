import test from 'node:test'
import assert from 'node:assert/strict'
import { DATABASE_CONFIG_ERROR } from '../persistence/persistence-config.mjs'
import {
  DIRECT_PROCUREMENT_DOCUMENT_TYPES,
  createDbProcurementReadRepository,
} from '../repositories/db-procurement-read-repository.mjs'

const env = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
}

const tenantId = 'tenant-a'

function selectFields(record, select = {}) {
  if (!select || !Object.keys(select).length) return record
  return Object.fromEntries(Object.entries(select).filter(([, enabled]) => enabled).map(([key]) => [key, record[key]]))
}

function matchesWhere(record, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((branch) => matchesWhere(record, branch))
    const actual = record[key]
    if (expected && typeof expected === 'object' && 'equals' in expected) {
      return expected.mode === 'insensitive'
        ? String(actual ?? '').toLowerCase() === String(expected.equals ?? '').toLowerCase()
        : actual === expected.equals
    }
    return actual === expected
  })
}

function createModel(name, records = []) {
  const calls = []
  return {
    calls,
    findFirst: async (query = {}) => {
      calls.push({ method: 'findFirst', query })
      return records.find((record) => matchesWhere(record, query.where)) || null
    },
    findMany: async (query = {}) => {
      calls.push({ method: 'findMany', query })
      if (!query.where) throw new Error(`unexpected broad procurement query: ${name}.findMany`)
      return records.filter((record) => matchesWhere(record, query.where)).map((record) => selectFields(record, query.select))
    },
  }
}

function createRecords() {
  return {
    purchaseRequests: [{
      id: 'PR-DB-1',
      tenantId,
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
      lines: [{ id: 'PRL-DB-1', sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', quantity: 10, unit: 'pcs', unitPrice: 120, amount: 1200 }],
    }],
    rfqs: [{
      id: 'RFQ-DB-1',
      tenantId,
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
      lines: [{ id: 'RFQL-DB-1', sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', quantity: 10, unit: 'pcs' }],
    }],
    supplierQuotations: [{ id: 'SQ-DB-1', tenantId, rfqId: 'RFQ-DB-1', supplierName: 'ABC Components' }],
    purchaseOrders: [{
      id: 'PO-DB-1',
      tenantId,
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
      lines: [{ id: 'POL-DB-1', sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', orderedQuantity: 10, receivedQuantity: 4, unit: 'pcs', amount: 1200 }],
    }],
    receivingDocuments: [{
      id: 'GRN-DB-1',
      tenantId,
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
      lines: [{ id: 'GRNL-DB-1', sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', acceptedQty: 4, rejectedQty: 1, unit: 'pcs' }],
    }],
    supplierInvoices: [{
      id: 'INV-DB-1',
      tenantId,
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
      lines: [{ id: 'INVL-DB-1', sku: 'A100', itemId: 'ITEM-A100', itemName: 'Motor A100', quantity: 10, unit: 'pcs', amount: 1260 }],
    }],
    documentLinks: [{ id: 'LINK-1', tenantId, sourceType: 'pr', sourceId: 'PR-DB-1', targetType: 'po', targetId: 'PO-DB-1', relationship: 'converted_po', status: 'active', metadata: {} }],
    procurementFollowups: [{ id: 'FOLLOWUP-DB-1', tenantId, type: 'invoice_variance', severity: 'high', status: 'open', owner: 'Buyer B', title: 'Invoice variance', message: 'Variance requires review', dueDate: new Date('2026-07-01T00:00:00.000Z'), supplierId: 'SUP-1', supplierName: 'ABC Components', documentType: 'invoice', documentId: 'INV-DB-1' }],
  }
}

function createPrisma(records = createRecords()) {
  return {
    purchaseRequest: createModel('purchaseRequest', records.purchaseRequests),
    rfq: createModel('rfq', records.rfqs),
    supplierQuotation: createModel('supplierQuotation', records.supplierQuotations),
    purchaseOrder: createModel('purchaseOrder', records.purchaseOrders),
    receivingDocument: createModel('receivingDocument', records.receivingDocuments),
    supplierInvoice: createModel('supplierInvoice', records.supplierInvoices),
    documentLink: createModel('documentLink', records.documentLinks),
    procurementFollowup: createModel('procurementFollowup', records.procurementFollowups),
  }
}

function allCalls(prisma) {
  return Object.entries(prisma).flatMap(([delegate, model]) => model.calls.map((call) => ({ delegate, ...call })))
}

function assertPrimaryPredicate(call, expectedId) {
  assert.equal(call.query.where.tenantId, tenantId)
  assert.deepEqual(call.query.where.id, { equals: expectedId, mode: 'insensitive' })
}

test('database procurement list and summary paths keep the bounded snapshot behavior', async () => {
  const repository = createDbProcurementReadRepository({ env, prisma: createPrisma() })
  const documents = await repository.listDocuments({ tenantId })
  const types = new Set(documents.map((item) => item.documentType))
  assert.deepEqual(types, new Set(['pr', 'rfq', 'po', 'grn', 'invoice', 'threeWayMatch']))
  assert.equal(documents.find((item) => item.documentType === 'po').receivingStatus, '部分收货')
  assert.equal(documents.find((item) => item.documentType === 'invoice').varianceAmount, 60)

  const links = await repository.listLinks({ tenantId })
  const followups = await repository.listFollowups({ tenantId })
  const summary = await repository.getSummary({ tenantId })
  assert.equal(links.some((link) => link.sourceType === 'pr' && link.targetType === 'po'), true)
  assert.equal(followups.some((item) => item.id === 'FOLLOWUP-DB-1' && item.documentType === 'invoice'), true)
  assert.equal(summary.threeWayMatchCount, 1)
})

test('direct dispatch covers every canonical type with exact bounded Prisma queries', async (t) => {
  assert.deepEqual(new Set(DIRECT_PROCUREMENT_DOCUMENT_TYPES), new Set(['pr', 'rfq', 'po', 'grn', 'invoice', 'threeWayMatch']))
  const cases = [
    { type: 'pr', id: 'PR-DB-1', primary: 'purchaseRequest', support: [] },
    { type: 'rfq', id: 'RFQ-DB-1', primary: 'rfq', support: [['supplierQuotation', 'findMany', { tenantId, rfqId: 'RFQ-DB-1' }]] },
    { type: 'po', id: 'PO-DB-1', primary: 'purchaseOrder', support: [['receivingDocument', 'findMany', { tenantId, poId: 'PO-DB-1' }]] },
    { type: 'grn', id: 'GRN-DB-1', primary: 'receivingDocument', support: [['supplierInvoice', 'findMany', { tenantId, relatedGrnId: 'GRN-DB-1' }]] },
    { type: 'invoice', id: 'INV-DB-1', primary: 'supplierInvoice', support: [] },
    { type: 'threeWayMatch', id: 'MATCH-INV-DB-1', primary: 'supplierInvoice', primaryId: 'INV-DB-1', support: [
      ['purchaseOrder', 'findFirst', { tenantId, id: { equals: 'PO-DB-1', mode: 'insensitive' } }],
      ['receivingDocument', 'findFirst', { tenantId, id: { equals: 'GRN-DB-1', mode: 'insensitive' } }],
    ] },
  ]

  for (const entry of cases) {
    await t.test(entry.type, async () => {
      const prisma = createPrisma()
      const repository = createDbProcurementReadRepository({ env, prisma })
      const document = await repository.getDocument(entry.type, entry.id, { tenantId })
      assert.equal(document.documentType, entry.type)
      const calls = allCalls(prisma)
      const primary = calls.find((call) => call.delegate === entry.primary && call.method === 'findFirst')
      assertPrimaryPredicate(primary, entry.primaryId || entry.id)
      const expectedCalls = new Set([
        `${entry.primary}.findFirst`,
        ...entry.support.map(([delegate, method]) => `${delegate}.${method}`),
      ])
      assert.equal(calls.length, expectedCalls.size)
      assert.deepEqual(new Set(calls.map((call) => `${call.delegate}.${call.method}`)), expectedCalls)
      for (const [delegate, method, where] of entry.support) {
        const supportingCall = calls.find((call) => call.delegate === delegate && call.method === method)
        assert.deepEqual(supportingCall.query.where, where)
      }
      assert.equal(calls.some((call) => call.query.take === 500), false)
      assert.equal(calls.every((call) => call.method === 'findFirst' || Boolean(call.query.where)), true)
    })
  }
})

test('direct documents preserve the former snapshot contract output', async () => {
  const snapshotRepository = createDbProcurementReadRepository({ env, prisma: createPrisma() })
  const snapshotDocuments = await snapshotRepository.listDocuments({ tenantId })
  const cases = [
    ['pr', 'PR-DB-1'],
    ['rfq', 'RFQ-DB-1'],
    ['po', 'PO-DB-1'],
    ['grn', 'GRN-DB-1'],
    ['invoice', 'INV-DB-1'],
    ['threeWayMatch', 'MATCH-INV-DB-1'],
  ]
  for (const [type, id] of cases) {
    const repository = createDbProcurementReadRepository({ env, prisma: createPrisma() })
    const direct = await repository.getDocument(type, id, { tenantId })
    assert.deepEqual(direct, snapshotDocuments.find((document) => document.documentType === type && document.id === id))
  }
})

test('historical direct lookup is independent of bounded list windows and broad collections', async () => {
  const target = createRecords().purchaseRequests[0]
  const unexpected = (delegate, method) => async () => { throw new Error(`unexpected broad procurement query: ${delegate}.${method}`) }
  const purchaseRequest = {
    calls: [],
    findFirst: async (query) => {
      purchaseRequest.calls.push(query)
      return target
    },
    findMany: unexpected('purchaseRequest', 'findMany'),
  }
  const forbidden = new Proxy({}, { get: (_target, method) => unexpected('unrelated', String(method)) })
  const prisma = {
    purchaseRequest,
    rfq: forbidden,
    supplierQuotation: forbidden,
    purchaseOrder: forbidden,
    receivingDocument: forbidden,
    supplierInvoice: forbidden,
    documentLink: forbidden,
    procurementFollowup: forbidden,
  }
  const repository = createDbProcurementReadRepository({ env, prisma })
  const document = await repository.getDocument('purchase-request', 'PR-DB-1', { tenantId })
  assert.equal(document.id, 'PR-DB-1')
  assert.equal(purchaseRequest.calls.length, 1)
  assertPrimaryPredicate({ query: purchaseRequest.calls[0] }, 'PR-DB-1')
})

test('direct lookup preserves aliases, case-insensitive IDs, one decode, and fail-closed behavior', async () => {
  const records = createRecords()
  records.supplierInvoices.push({ ...records.supplierInvoices[0], id: 'INV/ENCODED', relatedPoId: null, relatedGrnId: null })
  const prisma = createPrisma(records)
  const repository = createDbProcurementReadRepository({ env, prisma })

  assert.equal((await repository.getDocument('purchase-order', 'po-db-1', { tenantId })).id, 'PO-DB-1')
  assert.equal((await repository.getDocument('supplier-invoice', 'INV%2FENCODED', { tenantId })).id, 'INV/ENCODED')
  assert.equal(await repository.getDocument('invoice', 'UNKNOWN', { tenantId }), null)
  const callsBeforeUnsupported = allCalls(prisma).length
  assert.equal(await repository.getDocument('customer', 'CUST-1', { tenantId }), null)
  assert.equal(await repository.getDocument('threeWayMatch', 'MATCH-', { tenantId }), null)
  assert.equal(await repository.getDocument('threeWayMatch', '%E0%A4%A', { tenantId }), null)
  assert.equal(allCalls(prisma).length, callsBeforeUnsupported)
})

test('tenant-invisible records return null and tenant isolation is enforced in the query', async () => {
  const prisma = createPrisma()
  const repository = createDbProcurementReadRepository({ env, prisma })
  assert.equal(await repository.getDocument('invoice', 'INV-DB-1', { tenantId: 'tenant-b' }), null)
  assert.deepEqual(prisma.supplierInvoice.calls[0].query.where, {
    tenantId: 'tenant-b',
    id: { equals: 'INV-DB-1', mode: 'insensitive' },
  })
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
