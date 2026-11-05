import test from 'node:test'
import assert from 'node:assert/strict'
import { DOCUMENT_NUMBER_TYPES, procurementDocumentNumber } from '../../shared/document-numbering.mjs'
import { mapPurchaseOrder, mapPurchaseRequest, mapRfq } from '../repositories/db-procurement-read-repository.mjs'
import { buildProcurementDocumentLinks, buildProcurementDocuments, buildProcurementFollowups } from './procurement-read-model.mjs'
import { searchRuntimeBusinessContext } from './runtime-business-search.mjs'

// Purchase requests, RFQs and purchase orders keep a global internal id and
// show a workspace number (PR-202611-0001); documents created before
// numbering show their id. Reads carry `number`, references carry prNumber,
// rfqNumber or poNumber when the document is loaded, and search finds a
// document by its number.

test('purchase requests, RFQs and purchase orders are numbered on creation now', () => {
  const applied = Object.fromEntries(DOCUMENT_NUMBER_TYPES.map((entry) => [entry.type, entry.applied]))
  assert.deepEqual([applied.purchase_request, applied.rfq, applied.purchase_order], [true, true, true])
})

test('the number shown: the number, else a recorded order number, else the id', () => {
  assert.equal(procurementDocumentNumber({ id: 'PO-1A2B3C4D', number: 'PO-202611-0001', metadata: { orderNumber: 'PO-1A2B3C4D' } }), 'PO-202611-0001')
  assert.equal(procurementDocumentNumber({ id: 'PO-LEGACY', number: null, metadata: { orderNumber: 'ACME-PO-7' } }), 'ACME-PO-7')
  assert.equal(procurementDocumentNumber({ id: 'PR-9F8E7D6C', number: '  ' }), 'PR-9F8E7D6C')
  assert.equal(procurementDocumentNumber(null), '')
})

test('the read mappers carry the number beside the id', () => {
  const po = mapPurchaseOrder({ id: 'PO-1A2B3C4D', number: 'PO-202611-0001', status: 'approved', metadata: { orderNumber: 'PO-202611-0001' }, lines: [] })
  assert.deepEqual([po.id, po.po, po.number, po.orderNumber], ['PO-1A2B3C4D', 'PO-1A2B3C4D', 'PO-202611-0001', 'PO-202611-0001'])
  // An order from before numbering shows its id, whatever else it recorded.
  assert.equal(mapPurchaseOrder({ id: 'LOCAL-DEMO-PO-001', number: 'LOCAL-DEMO-PO-001', metadata: {} }).number, 'LOCAL-DEMO-PO-001')
  const pr = mapPurchaseRequest({ id: 'PR-9F8E7D6C', number: 'PR-202611-0003', lines: [] })
  assert.deepEqual([pr.id, pr.pr, pr.number], ['PR-9F8E7D6C', 'PR-9F8E7D6C', 'PR-202611-0003'])
  assert.equal(mapPurchaseRequest({ id: 'PR-OLD', lines: [] }).number, 'PR-OLD')
  const rfq = mapRfq({ id: 'RFQ-5A5A5A5A', number: 'RFQ-202611-0002', title: 'Valves', lines: [] })
  assert.deepEqual([rfq.id, rfq.number, rfq.title], ['RFQ-5A5A5A5A', 'RFQ-202611-0002', 'Valves'])
})

const data = {
  purchaseRequests: [
    { id: 'PR-9F8E7D6C', number: 'PR-202611-0003', status: 'converted', linkedPo: 'PO-1A2B3C4D', linkedRfq: 'RFQ-5A5A5A5A' },
    { id: 'PR-OLD', status: 'submitted', linkedPo: 'PO-NOT-LOADED' },
  ],
  rfqs: [{ id: 'RFQ-5A5A5A5A', number: 'RFQ-202611-0002', title: '', sourceRequest: 'PR-9F8E7D6C', suppliers: 2, quoted: 1, status: 'open' }],
  purchaseOrders: [
    { id: 'PO-1A2B3C4D', number: 'PO-202611-0001', orderNumber: 'PO-202611-0001', status: 'approved', sourceRequest: 'PR-9F8E7D6C', sourceRfq: 'RFQ-5A5A5A5A', eta: '2026-01-01', supplier: 'Harbor Supply', lines: [] },
    { id: 'PO-LEGACY', status: 'issued', supplier: 'Harbor Supply', lines: [] },
  ],
  receivingDocs: [{ grn: 'GRN-1', po: 'PO-1A2B3C4D', lines: [] }, { grn: 'GRN-2', po: 'PO-LEGACY', lines: [] }],
  supplierInvoices: [{ invoiceNumber: 'INV-1', relatedPo: 'PO-1A2B3C4D', relatedGrn: 'GRN-1', amount: 10, lines: [] }],
}

test('procurement documents name themselves and what they refer to by number', () => {
  const documents = buildProcurementDocuments(data)
  const byId = (type, id) => documents.find((row) => row.documentType === type && row.id === id)
  const pr = byId('pr', 'PR-9F8E7D6C')
  assert.deepEqual([pr.number, pr.label, pr.poNumber, pr.rfqNumber], ['PR-202611-0003', 'PR-202611-0003', 'PO-202611-0001', 'RFQ-202611-0002'])
  assert.ok(pr.title.startsWith('PR-202611-0003'))
  assert.deepEqual(pr.relatedDocuments.map((row) => [row.type, row.id, row.label]), [['rfq', 'RFQ-5A5A5A5A', 'RFQ-202611-0002'], ['po', 'PO-1A2B3C4D', 'PO-202611-0001']])
  // A reference whose document is not loaded carries no number; the page looks it up.
  const oldPr = byId('pr', 'PR-OLD')
  assert.equal(oldPr.number, 'PR-OLD')
  assert.equal('poNumber' in oldPr, false)
  const rfq = byId('rfq', 'RFQ-5A5A5A5A')
  assert.deepEqual([rfq.number, rfq.title, rfq.prNumber], ['RFQ-202611-0002', 'RFQ-202611-0002', 'PR-202611-0003'])
  const po = byId('po', 'PO-1A2B3C4D')
  assert.deepEqual([po.number, po.label, po.prNumber, po.rfqNumber], ['PO-202611-0001', 'PO-202611-0001', 'PR-202611-0003', 'RFQ-202611-0002'])
  assert.equal(byId('po', 'PO-LEGACY').number, 'PO-LEGACY')
  assert.deepEqual([byId('grn', 'GRN-1').poNumber, byId('grn', 'GRN-1').po, byId('grn', 'GRN-2').poNumber], ['PO-202611-0001', 'PO-1A2B3C4D', 'PO-LEGACY'])
  const invoice = byId('invoice', 'INV-1')
  assert.deepEqual([invoice.poId, invoice.poNumber], ['PO-1A2B3C4D', 'PO-202611-0001'])
  const match = byId('threeWayMatch', 'MATCH-INV-1')
  assert.deepEqual([match.poId, match.poNumber, match.prNumber, match.rfqNumber], ['PO-1A2B3C4D', 'PO-202611-0001', 'PR-202611-0003', 'RFQ-202611-0002'])
})

test('links and follow-ups name requests, RFQs and orders by number and keep their ids', () => {
  const links = buildProcurementDocumentLinks(data)
  const converted = links.find((link) => link.relationship === 'converted_po')
  assert.deepEqual([converted.sourceId, converted.targetId, converted.label], ['PR-9F8E7D6C', 'PO-1A2B3C4D', 'PR-202611-0003 -> PO-202611-0001'])
  const overdue = buildProcurementFollowups(data, { now: '2026-02-01T00:00:00Z' }).find((item) => item.documentId === 'PO-1A2B3C4D')
  assert.equal(overdue.documentNumber, 'PO-202611-0001')
  assert.ok(overdue.title.startsWith('PO-202611-0001'))
})

test('search finds a request, RFQ or order by its number as well as its id', () => {
  const context = {
    purchaseRequests: [{ id: 'PR-9F8E7D6C', number: 'PR-202611-0003', status: 'draft' }],
    rfqs: [{ id: 'RFQ-5A5A5A5A', number: 'RFQ-202611-0002', title: 'Valves', status: 'open' }],
    purchaseOrders: [{ id: 'PO-1A2B3C4D', number: 'PO-202611-0001', orderNumber: 'PO-202611-0001', status: 'approved', supplierSnapshot: { supplierName: 'Harbor Supply' } }],
  }
  const [order] = searchRuntimeBusinessContext(context, 'po-202611-0001')
  assert.deepEqual([order.entityType, order.entityId, order.number, order.score, order.matchedFields], ['purchase_order', 'PO-1A2B3C4D', 'PO-202611-0001', 120, ['number']])
  assert.equal(order.canonicalRoute, '/app/procurement/orders/PO-1A2B3C4D')
  const [request] = searchRuntimeBusinessContext(context, 'PR-202611-0003')
  assert.deepEqual([request.entityId, request.label, request.number], ['PR-9F8E7D6C', 'PR-202611-0003', 'PR-202611-0003'])
  assert.equal(searchRuntimeBusinessContext(context, 'RFQ-202611-0002')[0].entityId, 'RFQ-5A5A5A5A')
  // The id still finds it.
  assert.equal(searchRuntimeBusinessContext(context, 'PO-1A2B3C4D')[0].number, 'PO-202611-0001')
  // Part of a number finds every document that shows it.
  assert.deepEqual(searchRuntimeBusinessContext(context, '202611').map((row) => row.entityType).sort(), ['purchase_order', 'purchase_request', 'rfq'])
})
