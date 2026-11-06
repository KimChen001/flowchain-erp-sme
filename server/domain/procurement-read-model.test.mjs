import { maskProcurementRecord, procurementReadAccessFor } from './procurement-read-access.mjs'
import { aiSkillActor } from './test-fixtures/ai-skill-scenario.mjs'
// These checks are about routing and tenant scope: the actor may read everything.
const fullAccess = (tenantId) => procurementReadAccessFor(aiSkillActor('workspace-administrator', tenantId))
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

// LOCAL-DEMO-PO-001 as the database repository maps it: 50 ordered at 100, 20
// received, and an invoice for those 20 at 110 (2,200 net, 181.50 tax).
function partialInvoiceFixture({ recordedVariance = true, invoiceLine = {} } = {}) {
  return {
    purchaseOrders: [{
      id: 'PO-LINE-1', po: 'PO-LINE-1', supplier: 'Acme', amount: 5000, currency: 'USD', items: 50, received: 20, totalOrderedQty: 50, totalReceivedQty: 20,
      lines: [{ poLineId: 'PO-LINE-1-L1', sku: 'LDM-001', itemName: 'Flow Controller', quantityOrdered: 50, quantityReceived: 20, unit: 'pcs', unitPrice: 100, lineAmount: 5000 }],
    }],
    receivingDocs: [{ grn: 'GRN-LINE-1', po: 'PO-LINE-1', items: 20, passed: 20, failed: 0, lines: [{ grnLineId: 'GRN-LINE-1-L1', poLineId: 'PO-LINE-1-L1', acceptedQty: 20, rejectedQty: 0 }] }],
    supplierInvoices: [{
      id: 'INV-LINE-1', invoiceNumber: 'INV-LINE-1', supplier: 'Acme', relatedPo: 'PO-LINE-1', relatedGrn: 'GRN-LINE-1',
      amount: 2381.5, subtotal: 2200, tax: 181.5, total: 2381.5, currency: 'USD',
      ...(recordedVariance ? { varianceAmount: 200, matchStatus: '差异待处理' } : {}),
      lines: [{ lineId: 'INV-LINE-1-L1', sku: 'LDM-001', poLine: 'PO-LINE-1-L1', grnLine: 'GRN-LINE-1-L1', quantity: 20, unit: 'pcs', unitPrice: 110, taxAmount: 181.5, lineSubtotal: 2200, ...invoiceLine }],
    }],
  }
}

test('three-way match compares each invoice line with its PO line, not the whole PO', () => {
  const match = getProcurementDocument(partialInvoiceFixture(), 'threeWayMatch', 'MATCH-INV-LINE-1')
  assert.equal(match.lines.length, 1)
  assert.deepEqual({ ...match.lines[0] }, {
    invoiceLineId: 'INV-LINE-1-L1',
    poLineId: 'PO-LINE-1-L1',
    grnLineId: 'GRN-LINE-1-L1',
    sku: 'LDM-001',
    itemName: 'Flow Controller',
    unit: 'pcs',
    orderedQty: 50,
    receivedQty: 20,
    invoicedQty: 20,
    receivingGapQty: 30,
    quantityVariance: 0,
    poUnitPrice: 100,
    invoiceUnitPrice: 110,
    expectedAmount: 2000,
    invoiceLineAmount: 2200,
    taxAmount: 181.5,
    priceVariance: 200,
    varianceAmount: 200,
    quantityVarianceAmount: 0,
    status: 'price_variance',
    uninvoicedReceivedQty: 0,
  })
  // The totals add up: expected 2,000 + variance 200 = invoiced net 2,200; tax apart.
  assert.equal(match.expectedAmount, 2000)
  assert.equal(match.invoiceNetAmount, 2200)
  assert.equal(match.taxAmount, 181.5)
  assert.equal(match.lineVarianceAmount, 200)
  assert.equal(match.receivingGapQty, 30)
  assert.equal(match.lineMatchStatus, 'variance')
  // Existing fields keep their meaning.
  assert.equal(match.poAmount, 5000)
  assert.equal(match.invoiceAmount, 2381.5)
  assert.equal(match.varianceAmount, 200)
  assert.equal(match.blockingReason, 'PO 金额与发票金额存在差异，需复核后处理。')
})

test('three-way match variance falls back to the line-level total when the invoice records none', () => {
  // Not |invoice total - PO total| (2,381.50 against 5,000).
  const priced = getProcurementDocument(partialInvoiceFixture({ recordedVariance: false }), 'threeWayMatch', 'MATCH-INV-LINE-1')
  assert.equal(priced.varianceAmount, 200)
  assert.equal(priced.blockingReason, 'PO 金额与发票金额存在差异，需复核后处理。')
  // The match status stays the invoice's own (not matched yet).
  assert.equal(priced.matchStatus, '待匹配')

  // Invoiced less than received at the PO price: received, not yet fully invoiced, not a variance.
  const under = getProcurementDocument(partialInvoiceFixture({ recordedVariance: false, invoiceLine: { quantity: 15, unitPrice: 100, lineSubtotal: 1500 } }), 'threeWayMatch', 'MATCH-INV-LINE-1')
  assert.equal(under.varianceAmount, 0)
  assert.equal(under.blockingReason, '')
  assert.equal(under.lineMatchStatus, 'matched')
  assert.equal(under.lines[0].status, 'matched')
  assert.equal(under.lines[0].uninvoicedReceivedQty, 5)
  assert.equal(under.lines[0].receivingGapQty, 30)

  // Invoiced more than received: a quantity variance at the PO price.
  const over = getProcurementDocument(partialInvoiceFixture({ recordedVariance: false, invoiceLine: { quantity: 25, unitPrice: 100, lineSubtotal: 2500 } }), 'threeWayMatch', 'MATCH-INV-LINE-1')
  assert.equal(over.lines[0].status, 'quantity_variance')
  assert.equal(over.lines[0].quantityVariance, 5)
  assert.equal(over.lines[0].quantityVarianceAmount, 500)
  assert.equal(over.lines[0].varianceAmount, 0)
  assert.equal(over.varianceAmount, 500)

  // Two lines on one PO line: quantity is checked across them, and offsetting
  // prices do not cancel the variance out.
  const split = partialInvoiceFixture({ recordedVariance: false })
  split.supplierInvoices[0].lines = [
    { lineId: 'A', poLine: 'PO-LINE-1-L1', quantity: 10, unitPrice: 110, lineSubtotal: 1100 },
    { lineId: 'B', poLine: 'PO-LINE-1-L1', quantity: 15, unitPrice: 90, lineSubtotal: 1350 },
  ]
  const both = getProcurementDocument(split, 'threeWayMatch', 'MATCH-INV-LINE-1')
  assert.deepEqual(both.lines.map((line) => [line.status, line.quantityVariance, line.varianceAmount]), [['price_variance', 0, 100], ['price_and_quantity_variance', 5, -150]])
  assert.equal(both.lineVarianceAmount, -50)
  assert.equal(both.varianceAmount, 750)
  assert.equal(both.receivingGapQty, 30)
})

test('three-way match lines without a PO line are not guessed, and no lines means no line totals', () => {
  const unknown = getProcurementDocument(partialInvoiceFixture({ recordedVariance: false, invoiceLine: { poLine: 'NOT-ON-PO', sku: 'OTHER' } }), 'threeWayMatch', 'MATCH-INV-LINE-1')
  assert.equal(unknown.lines[0].status, 'po_line_unavailable')
  assert.equal(unknown.lines[0].expectedAmount, null)
  assert.equal(unknown.expectedAmount, null)
  assert.equal(unknown.varianceAmount, 0)

  const match = getProcurementDocument(fixture, 'threeWayMatch', 'MATCH-INV-JS-260620')
  assert.deepEqual(match.lines, [])
  assert.equal(match.lineMatchStatus, 'no_lines')
  assert.equal(match.expectedAmount, null)
  assert.equal(match.lineVarianceAmount, null)
})

test('three-way match line amounts are hidden from a reader without finance amounts', () => {
  const match = getProcurementDocument(partialInvoiceFixture(), 'threeWayMatch', 'MATCH-INV-LINE-1')
  const masked = maskProcurementRecord(match, 'threeWayMatch', { types: { threeWayMatch: true }, prices: true, amounts: false, partner: true })
  for (const key of ['expectedAmount', 'invoiceNetAmount', 'taxAmount', 'lineVarianceAmount', 'lineVarianceTotal', 'quantityVarianceAmount']) assert.equal(masked[key], null, key)
  for (const key of ['poUnitPrice', 'invoiceUnitPrice', 'expectedAmount', 'invoiceLineAmount', 'taxAmount', 'priceVariance', 'varianceAmount', 'quantityVarianceAmount']) assert.equal(masked.lines[0][key], null, `line ${key}`)
  // Quantities are not amounts.
  assert.equal(masked.lines[0].invoicedQty, 20)
  assert.deepEqual(masked.restrictedFields, ['amounts'])
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
  // The fixture's open documents are all explicitly CNY, so the derived currency is CNY.
  assert.equal(summary.currency, 'CNY')
  assert.equal(summary.currencyAggregationStatus, 'single_currency')
  assert.equal(summary.totalOpenAmount, 426000)
})

test('procurement summary currency comes from the documents, never a hard-coded CNY', () => {
  const withCurrency = (currency) => {
    const db = clone(fixture)
    for (const key of ['purchaseRequests', 'purchaseOrders', 'supplierInvoices']) for (const row of db[key]) row.currency = currency
    return db
  }

  const usd = buildProcurementSummary(withCurrency('USD'))
  assert.equal(usd.currency, 'USD')
  assert.deepEqual(usd.currencies, ['USD'])
  assert.equal(usd.currencyAggregationStatus, 'single_currency')

  const mixed = withCurrency('USD')
  mixed.supplierInvoices[0].currency = 'CNY'
  const multi = buildProcurementSummary(mixed)
  assert.equal(multi.currency, null)
  assert.deepEqual(multi.currencies, ['CNY', 'USD'])
  assert.equal(multi.currencyAggregationStatus, 'multi_currency_unconverted')
  // Amounts in different currencies are never added together.
  assert.equal(multi.totalOpenAmount, null)

  const unknown = buildProcurementSummary(withCurrency(undefined))
  assert.equal(unknown.currency, null)
  assert.deepEqual(unknown.currencies, [])
  assert.equal(unknown.currencyAggregationStatus, 'no_currency_data')
  assert.equal(buildProcurementDocuments(withCurrency(undefined)).find((item) => item.documentType === 'po').currency, '')
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
  // No document carries a currency, so it stays unknown instead of defaulting to CNY.
  assert.equal(match.currency, '')
  assert.equal(documents.every((item) => item.currency === ''), true)
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

  const malformedId = createRouteContext('/api/procurement/documents/rfq/RFQ%ZZ001')
  await handleProcurementReadRoute(malformedId.ctx)
  assert.equal(malformedId.response.status, 400)
  assert.equal(JSON.stringify(malformedId.response.payload).includes('stack'), false)
})

test('GET /api/procurement/documents/:type/:id dispatches all canonical types without list fallback', async () => {
  const aliases = new Map([
    ['purchase-request', 'pr'],
    ['rfq', 'rfq'],
    ['purchase-order', 'po'],
    ['receiving', 'grn'],
    ['supplier-invoice', 'invoice'],
    ['3wm', 'threeWayMatch'],
  ])
  for (const [routeType, canonicalType] of aliases) {
    let response = null
    let observed = null
    const repositories = {
      procurementRead: {
        normalizeDocumentType: normalizeProcurementDocumentType,
        listDocuments: async () => { throw new Error('listDocuments must not be called') },
        getDocument: async (type, id, options) => {
          observed = { type, id, options }
          return { id, documentType: type }
        },
      },
    }
    await handleProcurementReadRoute({
      req: { method: 'GET' },
      res: {},
      url: new URL(`/api/procurement/documents/${routeType}/DOC%2F001`, 'http://localhost'),
      identity: { authenticated: true, tenantId: 'tenant-a' }, procurementReadAccess: fullAccess('tenant-a'),
      repositories,
      send(_res, status, payload) { response = { status, payload } },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.payload, { document: { id: 'DOC/001', documentType: canonicalType } })
    assert.deepEqual(observed, { type: canonicalType, id: 'DOC/001', options: { tenantId: 'tenant-a' } })
  }
})

test('GET RFQ detail preserves authoritative participation and revision DTO fields', async () => {
  const authoritativeRfq = {
    id: 'RFQ-AUTHORITY-1',
    documentType: 'rfq',
    suppliers: {
      participantCount: 2,
      invitedInternalCount: 2,
      responseRecordedCount: 1,
      noResponseCount: 1,
      participationAuthority: 'authoritative',
      invitationDeliveryAuthority: 'unavailable',
      externalSupplierIdentityAuthority: 'unavailable',
      knownParticipants: [
        { supplierId: 'SUP-RESPONSE', responseState: 'response_recorded' },
        { supplierId: 'SUP-NO-RESPONSE', responseState: 'no_response' },
      ],
    },
    quotations: [{
      id: 'QUOTE-AUTHORITY-1',
      latestRevision: { id: 'REVISION-2', revisionNumber: 2, isLatest: true },
      revisions: [
        { id: 'REVISION-2', revisionNumber: 2, isLatest: true },
        { id: 'REVISION-1', revisionNumber: 1, isLatest: false },
      ],
      historicalRevisions: [{ id: 'REVISION-1', revisionNumber: 1, isLatest: false }],
    }],
    revisionAuthority: { available: true, immutable: true, latestRule: 'maximum_revision_number' },
  }
  let response = null
  let observed = null
  await handleProcurementReadRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/procurement/documents/rfq/RFQ-AUTHORITY-1', 'http://localhost'),
    identity: { authenticated: true, tenantId: 'tenant-a' }, procurementReadAccess: fullAccess('tenant-a'),
    repositories: {
      procurementRead: {
        normalizeDocumentType: normalizeProcurementDocumentType,
        listDocuments: async () => { throw new Error('listDocuments must not be called') },
        getDocument: async (type, id, options) => {
          observed = { type, id, options }
          return authoritativeRfq
        },
      },
    },
    send(_res, status, payload) { response = { status, payload } },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(observed, { type: 'rfq', id: 'RFQ-AUTHORITY-1', options: { tenantId: 'tenant-a' } })
  assert.equal(response.payload.document.suppliers.knownParticipants[1].responseState, 'no_response')
  assert.equal(response.payload.document.quotations[0].latestRevision.revisionNumber, 2)
  assert.deepEqual(response.payload.document.quotations[0].historicalRevisions.map((revision) => revision.revisionNumber), [1])
  assert.equal(response.payload.document.revisionAuthority.latestRule, 'maximum_revision_number')
})

test('GET /api/procurement/documents/:type/:id fails before repository reads for invalid type and missing tenant context', async () => {
  let reads = 0
  const repositories = {
    procurementRead: {
      normalizeDocumentType: normalizeProcurementDocumentType,
      getDocument: async () => { reads += 1; return null },
    },
  }
  for (const identity of [
    { authenticated: false, tenantId: '' },
    { authenticated: true, tenantId: '' },
  ]) {
    let response = null
    await handleProcurementReadRoute({
      req: { method: 'GET' },
      res: {},
      url: new URL('/api/procurement/documents/po/PO-1', 'http://localhost'),
      identity,
      repositories,
      send(_res, status, payload) { response = { status, payload } },
    })
    assert.equal(response.status, 401)
  }

  let invalidResponse = null
  await handleProcurementReadRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/procurement/documents/customer/CUST-1', 'http://localhost'),
    identity: { authenticated: true, tenantId: 'tenant-a' }, procurementReadAccess: fullAccess('tenant-a'),
    repositories,
    send(_res, status, payload) { invalidResponse = { status, payload } },
  })
  assert.equal(invalidResponse.status, 400)
  assert.equal(reads, 0)
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
    identity: { authenticated: true, tenantId: 'tenant-a' }, procurementReadAccess: fullAccess('tenant-a'),
    repositories: {
      procurementRead: {
        normalizeDocumentType: normalizeProcurementDocumentType,
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
