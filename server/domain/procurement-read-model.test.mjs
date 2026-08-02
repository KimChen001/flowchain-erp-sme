import test from 'node:test'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'
import assert from 'node:assert/strict'
import { handleProcurementReadRoute } from '../routes/procurement-read.routes.mjs'
import {
  buildProcurementDocumentLinks,
  buildProcurementDocuments,
  buildProcurementEvidenceItem,
  buildProcurementFollowups,
  buildProcurementSummary,
  filterProcurementRows,
  getProcurementDocument,
  normalizeProcurementDocumentType,
} from './procurement-read-model.mjs'

const fixture = {
  purchaseRequests: [
    {
      pr: 'PR-2026-2400',
      sourceSku: 'SKU-00287',
      sourceName: '铝合金型材 6063',
      supplier: '江苏铝合金集团',
      requester: '张磊',
      buyer: '王志强',
      requiredDate: '2026-07-05',
      quantity: 1000,
      unitPrice: 142,
      amount: 142000,
      currency: 'CNY',
      status: '已批准',
      linkedPo: 'PO-2026-1301',
    },
  ],
  rfqs: [
    {
      id: 'RFQ-26-0047',
      title: 'SKU-00287 采购询价',
      suppliers: 3,
      quoted: 1,
      due: '2026-06-20',
      status: '进行中',
      sourceRequest: 'PR-2026-2400',
      linkedPo: 'PO-2026-1301',
      bestSupplier: '江苏铝合金集团',
    },
  ],
  purchaseOrders: [
    {
      po: 'PO-2026-1301',
      supplier: '江苏铝合金集团',
      eta: '2026-06-12',
      owner: '王志强',
      amount: 142000,
      currency: 'CNY',
      items: 1000,
      received: 400,
      status: '已发出',
      sourceRequest: 'PR-2026-2400',
      sourceRfq: 'RFQ-26-0047',
    },
  ],
  receivingDocs: [
    {
      grn: 'GRN-202606-0430',
      po: 'PO-2026-1301',
      supplier: '江苏铝合金集团',
      status: '已入库',
      items: 400,
      passed: 390,
      failed: 10,
      warehouse: 'A 区',
    },
  ],
  supplierInvoices: [
    {
      invoiceNumber: 'INV-JS-260620',
      supplier: '江苏铝合金集团',
      relatedPo: 'PO-2026-1301',
      relatedGrn: 'GRN-202606-0430',
      amount: 142000,
      currency: 'CNY',
      varianceAmount: 8600,
      matchStatus: '存在差异',
    },
  ],
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function snapshot(value) {
  return JSON.stringify(value)
}

function createRouteContext(pathname, db = clone(fixture)) {
  let response = null
  let wrote = false
  return {
    ctx: {
      req: { method: 'GET' },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      repositories: createTestRepositoryRegistry(db),
      send(_res, status, payload) {
        response = { status, payload }
      },
      writeDb: async () => { wrote = true },
    },
    get response() {
      return response
    },
    get wrote() {
      return wrote
    },
  }
}

test('procurement document type normalization supports canonical types and safe aliases', () => {
  assert.equal(normalizeProcurementDocumentType('pr'), 'pr')
  assert.equal(normalizeProcurementDocumentType('purchase-request'), 'pr')
  assert.equal(normalizeProcurementDocumentType('purchase_order'), 'po')
  assert.equal(normalizeProcurementDocumentType('receiving'), 'grn')
  assert.equal(normalizeProcurementDocumentType('supplier-invoice'), 'invoice')
  assert.equal(normalizeProcurementDocumentType('3wm'), 'threeWayMatch')
  assert.equal(normalizeProcurementDocumentType('unknown'), '')
})

test('procurement read model builds stable document rows without mutating source data', () => {
  const db = clone(fixture)
  const before = snapshot(db)
  const documents = buildProcurementDocuments(db)

  assert.equal(snapshot(db), before)
  assert.deepEqual(new Set(documents.map((row) => row.documentType)), new Set(['pr', 'rfq', 'po', 'grn', 'invoice', 'threeWayMatch']))
  const po = documents.find((row) => row.documentType === 'po')
  assert.equal(po.id, 'PO-2026-1301')
  assert.equal(po.amount, 142000)
  assert.equal(po.currency, 'CNY')
  assert.equal(po.receivingStatus, '部分收货')
  assert.equal(po.relatedDocuments.some((item) => item.type === 'grn' && item.id === 'GRN-202606-0430'), true)
})

test('procurement detail lookup supports canonical types and aliases', () => {
  assert.equal(getProcurementDocument(fixture, 'pr', 'PR-2026-2400')?.documentType, 'pr')
  assert.equal(getProcurementDocument(fixture, 'purchase-order', 'PO-2026-1301')?.documentType, 'po')
  assert.equal(getProcurementDocument(fixture, 'receiving', 'GRN-202606-0430')?.documentType, 'grn')
  assert.equal(getProcurementDocument(fixture, 'supplier_invoice', 'INV-JS-260620')?.documentType, 'invoice')
  assert.equal(getProcurementDocument(fixture, '3wm', 'MATCH-INV-JS-260620')?.documentType, 'threeWayMatch')
  assert.equal(getProcurementDocument(fixture, 'unknown', 'PO-2026-1301'), null)
})

test('three-way match clarifies amount, variance, currency, and related ids', () => {
  const match = getProcurementDocument(fixture, 'threeWayMatch', 'MATCH-INV-JS-260620')
  assert.equal(match.poId, 'PO-2026-1301')
  assert.equal(match.grnId, 'GRN-202606-0430')
  assert.equal(match.invoiceId, 'INV-JS-260620')
  assert.equal(match.poAmount, 142000)
  assert.equal(match.invoiceAmount, 142000)
  assert.equal(match.varianceAmount, 8600)
  assert.equal(match.varianceRate, 0.0606)
  assert.equal(match.currency, 'CNY')
  assert.equal(match.matchStatus, '存在差异')
  assert.equal(typeof match.receivedQuantity, 'number')
  assert.equal(match.receivedAmount, null)
})

test('procurement document links are deterministic and omit broken empty ids', () => {
  const db = clone(fixture)
  const before = snapshot(db)
  const links = buildProcurementDocumentLinks(db)
  const again = buildProcurementDocumentLinks(db)

  assert.equal(snapshot(db), before)
  assert.deepEqual(links, again)
  assert.equal(links.every((link) => link.sourceType && link.sourceId && link.targetType && link.targetId && link.relationship), true)
  assert.equal(links.some((link) => link.sourceType === 'pr' && link.targetType === 'po' && link.relationship === 'converted_po'), true)
  assert.equal(links.some((link) => link.sourceType === 'invoice' && link.targetType === 'threeWayMatch'), true)
})

test('procurement followups include stable ids, document references, severity, status, and evidence', () => {
  const db = clone(fixture)
  const before = snapshot(db)
  const followups = buildProcurementFollowups(db, { now: '2026-06-29T00:00:00Z' })

  assert.equal(snapshot(db), before)
  assert.equal(followups.every((item) => item.id.startsWith('FOLLOWUP-')), true)
  assert.equal(followups.every((item) => ['high', 'medium', 'low'].includes(item.severity)), true)
  assert.equal(followups.every((item) => item.status === 'open' && item.documentType && item.documentId && item.evidence), true)
  assert.equal(followups.some((item) => item.type === 'invoice_variance' && item.documentType === 'invoice'), true)
})

test('procurement summary is deterministic and aligns with document lists', () => {
  const db = clone(fixture)
  const documents = buildProcurementDocuments(db)
  const summary = buildProcurementSummary(db)

  assert.equal(summary.documentCount, documents.length)
  assert.equal(summary.purchaseRequestCount, 1)
  assert.equal(summary.rfqCount, 1)
  assert.equal(summary.purchaseOrderCount, 1)
  assert.equal(summary.receivingDocCount, 1)
  assert.equal(summary.supplierInvoiceCount, 1)
  assert.equal(summary.threeWayMatchCount, 1)
  assert.equal(summary.invoiceExceptionCount, 1)
  assert.equal(summary.threeWayMatchExceptionCount, 1)
  assert.equal(summary.currency, 'CNY')
  assert.equal(summary.totalOpenAmount, 426000)
})

test('procurement evidence boundary returns compact non-secret evidence items', () => {
  const evidence = buildProcurementEvidenceItem({
    documentType: 'po',
    type: 'po',
    id: 'PO-2026-1301',
    status: '已发出',
    supplierName: '江苏铝合金集团',
    amount: 142000,
    currency: 'CNY',
  })

  assert.deepEqual(evidence, {
    type: 'po',
    id: 'PO-2026-1301',
    label: 'PO-2026-1301',
    status: '已发出',
    supplierName: '江苏铝合金集团',
    amount: 142000,
    currency: 'CNY',
    source: '',
    route: '/api/procurement/documents/po/PO-2026-1301',
  })
})

test('procurement filters support canonical type filters and safe empty behavior', () => {
  const documents = buildProcurementDocuments(fixture)
  assert.equal(filterProcurementRows(documents, { type: 'purchase-request' }).length, 1)
  assert.equal(filterProcurementRows(documents, { type: 'po', q: 'SKU-00287' }).length, 0)
  assert.equal(filterProcurementRows(documents, { type: 'unknown' }).length, documents.length)
  assert.equal(filterProcurementRows([], { q: 'anything' }).length, 0)
})

test('missing and partial data does not crash or invent unsupported values', () => {
  const partial = {
    purchaseRequests: [{ pr: 'PR-MISSING', status: '待审批' }],
    purchaseOrders: [{ po: 'PO-MISSING', status: '待审批' }],
    supplierInvoices: [{ invoiceNumber: 'INV-MISSING', relatedPo: 'PO-MISSING' }],
  }
  const documents = buildProcurementDocuments(partial)
  const match = documents.find((item) => item.documentType === 'threeWayMatch')

  assert.equal(documents.length, 4)
  assert.equal(match.poAmount, 0)
  assert.equal(match.invoiceAmount, 0)
  assert.equal(match.varianceAmount, 0)
  assert.equal(match.varianceRate, null)
  assert.equal(match.currency, 'CNY')
})

test('GET /api/procurement/documents contract returns stable fields and does not mutate', async () => {
  const db = clone(fixture)
  const before = snapshot(db)
  const route = createRouteContext('/api/procurement/documents?type=po', db)
  const handled = await handleProcurementReadRoute(route.ctx)

  assert.equal(handled, true)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.documents.length, 1)
  assert.equal(route.response.payload.documents[0].documentType, 'po')
  assert.equal(route.wrote, false)
  assert.equal(snapshot(db), before)
})

test('GET /api/procurement/documents/:type/:id contract handles found, missing, alias, and invalid type', async () => {
  const found = createRouteContext('/api/procurement/documents/purchase-order/PO-2026-1301')
  await handleProcurementReadRoute(found.ctx)
  assert.equal(found.response.status, 200)
  assert.equal(found.response.payload.document.documentType, 'po')

  const missing = createRouteContext('/api/procurement/documents/po/PO-MISSING')
  await handleProcurementReadRoute(missing.ctx)
  assert.equal(missing.response.status, 404)
  assert.equal(JSON.stringify(missing.response.payload).includes('stack'), false)

  const invalid = createRouteContext('/api/procurement/documents/customer/CUST-001')
  await handleProcurementReadRoute(invalid.ctx)
  assert.equal(invalid.response.status, 400)
  assert.equal(JSON.stringify(invalid.response.payload).includes('stack'), false)
})

test('GET /api/procurement/documents/:type/:id requires authentication and keeps tenant-invisible records hidden', async () => {
  let unauthorizedResponse = null
  const unauthorized = {
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/procurement/documents/invoice/INV-TENANT-B', 'http://localhost'),
    identity: { authenticated: false, tenantId: '' },
    send(_res, status, payload) { unauthorizedResponse = { status, payload } },
  }
  await handleProcurementReadRoute(unauthorized)
  assert.equal(unauthorizedResponse.status, 401)

  let scopedResponse = null
  let observedScope = null
  const tenantScoped = {
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/procurement/documents/invoice/INV-TENANT-B', 'http://localhost'),
    identity: { authenticated: true, tenantId: 'tenant-a' },
    repositories: {
      procurementRead: {
        isDocumentType: (type) => type === 'invoice',
        getDocument: async (_type, _id, options) => {
          observedScope = options
          return options.tenantId === 'tenant-b'
            ? { id: 'INV-TENANT-B', documentType: 'invoice' }
            : null
        },
      },
    },
    send(_res, status, payload) { scopedResponse = { status, payload } },
  }
  await handleProcurementReadRoute(tenantScoped)
  assert.deepEqual(observedScope, { tenantId: 'tenant-a' })
  assert.equal(scopedResponse.status, 404)
  assert.equal(scopedResponse.payload.error, 'Procurement document not found')
})

test('procurement route contracts cover links, followups, summary, repeated calls, and no mutation', async () => {
  const db = clone(fixture)
  const before = snapshot(db)
  for (const [path, key] of [
    ['/api/procurement/links', 'links'],
    ['/api/procurement/followups', 'followups'],
    ['/api/procurement/summary', 'summary'],
  ]) {
    const route = createRouteContext(path, db)
    const repeat = createRouteContext(path, db)
    await handleProcurementReadRoute(route.ctx)
    await handleProcurementReadRoute(repeat.ctx)
    assert.equal(route.response.status, 200)
    assert.deepEqual(route.response.payload, repeat.response.payload)
    assert.equal(route.response.payload[key] !== undefined, true)
    assert.equal(JSON.stringify(route.response.payload).includes('secret'), false)
  }
  assert.equal(snapshot(db), before)
})
