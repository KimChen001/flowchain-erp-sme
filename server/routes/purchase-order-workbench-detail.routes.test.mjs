import test from 'node:test'
import assert from 'node:assert/strict'
import { createDbProcurementReadRepository } from '../repositories/db-procurement-read-repository.mjs'
import { aiSkillActor } from '../domain/test-fixtures/ai-skill-scenario.mjs'
import { handlePurchaseOrdersRoute } from './purchase-orders.routes.mjs'

// GET /api/purchase-orders-workbench/:id is what the PO detail page reads
// instead of the whole workbench: one order of the signed-in workspace with
// its own receipts and supplier invoices, checked and masked as the workbench
// is. Another workspace's order and an unknown id both answer 404.

const TENANT = 'tenant-po-detail'
const OTHER = 'tenant-po-detail-other'
const env = { FLOWCHAIN_PERSISTENCE_MODE: 'database', DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain' }
const at = '2026-11-02T12:00:00.000Z'

const order = (id, tenantId, extra = {}) => ({
  id, tenantId, number: `PO-202611-${id.slice(-4)}`, status: 'issued', supplierId: 'SUP-1', supplierName: 'Harbor Supply', amount: '125.00', currency: 'USD',
  expectedDate: at, createdAt: at, updatedAt: at, version: 2, sourceRequestId: 'PR-0001', sourceRfqId: null, metadata: {},
  lines: [{ id: `${id}-L1`, sku: 'SKU-1', itemName: 'Valve', orderedQuantity: '10', receivedQuantity: '4', unitPrice: '12.50', amount: '125.00', unit: 'EA', metadata: {} }],
  ...extra,
})

const rows = {
  purchaseOrder: [
    order('PO-0001', TENANT),
    order('PO-0002', TENANT, { sourceRequestId: null }),
    order('PO-0009', OTHER),
  ],
  purchaseRequest: [{ id: 'PR-0001', tenantId: TENANT, number: 'PR-202611-0001' }],
  rfq: [],
  receivingDocument: [
    { id: 'GRN-0001', tenantId: TENANT, poId: 'PO-0001', status: 'received', supplierName: 'Harbor Supply', createdAt: at, updatedAt: at, lines: [{ id: 'GRN-0001-L1', purchaseOrderLineId: 'PO-0001-L1', sku: 'SKU-1', acceptedQty: '4', rejectedQty: '0' }] },
    { id: 'GRN-0002', tenantId: TENANT, poId: 'PO-0002', status: 'received', supplierName: 'Harbor Supply', createdAt: at, updatedAt: at, lines: [{ id: 'GRN-0002-L1', purchaseOrderLineId: 'PO-0002-L1', sku: 'SKU-1', acceptedQty: '1', rejectedQty: '0' }] },
    { id: 'GRN-0009', tenantId: OTHER, poId: 'PO-0009', status: 'received', supplierName: 'Elsewhere', createdAt: at, updatedAt: at, lines: [] },
    // Another workspace's receipt for an order with the same id: never this workspace's.
    { id: 'GRN-0008', tenantId: OTHER, poId: 'PO-0001', status: 'received', supplierName: 'Elsewhere', createdAt: at, updatedAt: at, lines: [{ id: 'GRN-0008-L1', purchaseOrderLineId: 'PO-0001-L1', acceptedQty: '9', rejectedQty: '0' }] },
  ],
  supplierInvoice: [
    { id: 'INV-0001', tenantId: TENANT, relatedPoId: 'PO-0001', relatedGrnId: 'GRN-0001', supplierId: 'SUP-1', supplierName: 'Harbor Supply', amount: '50.00', subtotalAmount: '50.00', totalAmount: '50.00', currency: 'USD', status: 'submitted', createdAt: at, updatedAt: at, lines: [{ id: 'INV-0001-L1', purchaseOrderLineId: 'PO-0001-L1', sku: 'SKU-1', quantity: '4', unitPrice: '12.50', amount: '50.00' }] },
    // Names the order only on a line: still this order's invoice.
    { id: 'INV-0003', tenantId: TENANT, relatedPoId: null, supplierId: 'SUP-1', supplierName: 'Harbor Supply', amount: '12.50', currency: 'USD', status: 'submitted', createdAt: at, updatedAt: at, lines: [{ id: 'INV-0003-L1', purchaseOrderLineId: 'PO-0001-L1', sku: 'SKU-1', quantity: '1', unitPrice: '12.50', amount: '12.50' }] },
    { id: 'INV-0002', tenantId: TENANT, relatedPoId: 'PO-0002', supplierId: 'SUP-1', supplierName: 'Harbor Supply', amount: '12.50', currency: 'USD', status: 'submitted', createdAt: at, updatedAt: at, lines: [{ id: 'INV-0002-L1', purchaseOrderLineId: 'PO-0002-L1', quantity: '1', unitPrice: '12.50', amount: '12.50' }] },
  ],
  documentLink: [
    { id: 'LINK-1', tenantId: TENANT, sourceType: 'purchase_request', sourceId: 'PR-0001', targetType: 'purchase_order', targetId: 'PO-0001', relationship: 'converted_to', createdAt: at },
    { id: 'LINK-2', tenantId: TENANT, sourceType: 'purchase_request', sourceId: 'PR-0001', targetType: 'purchase_order', targetId: 'PO-0002', relationship: 'converted_to', createdAt: at },
  ],
  procurementFollowup: [
    { id: 'FU-1', tenantId: TENANT, type: 'po_overdue', documentType: 'purchase_order', documentId: 'PO-0001', title: 'Chase', status: 'open', createdAt: at },
  ],
}

// Enough of Prisma's where clause for the reads under test: equality, a
// case-insensitive equals, `in`, OR and a `some` filter on lines.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((branch) => matches(row, branch))
    if (condition && typeof condition === 'object' && 'some' in condition) return (row[key] || []).some((entry) => matches(entry, condition.some))
    if (condition && typeof condition === 'object' && 'in' in condition) return condition.in.includes(row[key])
    if (condition && typeof condition === 'object' && 'equals' in condition) {
      return condition.mode === 'insensitive' ? String(row[key] ?? '').toLowerCase() === String(condition.equals).toLowerCase() : row[key] === condition.equals
    }
    return row[key] === condition
  })
}
const prisma = new Proxy({}, {
  get(_target, model) {
    return {
      findMany: async ({ where } = {}) => structuredClone((rows[model] || []).filter((row) => matches(row, where))),
      findFirst: async ({ where } = {}) => structuredClone((rows[model] || []).find((row) => matches(row, where)) || null),
    }
  },
})

function call(path, roleKey = 'workspace-administrator', tenantId = TENANT) {
  const sent = []
  const ctx = {
    req: { method: 'GET', headers: {} }, res: {}, url: new URL(path, 'http://local'), env,
    identity: aiSkillActor(roleKey, tenantId),
    repositories: { procurementRead: createDbProcurementReadRepository({ env, prisma }) },
    send: (_res, status, payload) => { sent.push({ status, payload }); return true },
    readBody: async () => ({}),
  }
  return handlePurchaseOrdersRoute(ctx).then((handled) => ({ handled, ...sent.at(-1) }))
}

test('one order comes back with only its own receipts, invoices, links and follow-ups', async () => {
  const { handled, status, payload } = await call('/api/purchase-orders-workbench/PO-0001')
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.deepEqual(Object.keys(payload).sort(), ['documentLinks', 'procurementFollowups', 'purchaseOrder', 'receivingDocs', 'supplierInvoices'])
  assert.deepEqual([payload.purchaseOrder.po, payload.purchaseOrder.number, payload.purchaseOrder.prNumber], ['PO-0001', 'PO-202611-0001', 'PR-202611-0001'])
  assert.deepEqual(payload.purchaseOrder.lines.map((line) => [line.poLineId, line.unitPrice]), [['PO-0001-L1', 12.5]])
  assert.deepEqual(payload.receivingDocs.map((doc) => [doc.grn, doc.poNumber]), [['GRN-0001', 'PO-202611-0001']])
  assert.deepEqual(payload.supplierInvoices.map((invoice) => invoice.invoiceNumber).sort(), ['INV-0001', 'INV-0003'])
  assert.deepEqual(payload.documentLinks.map((link) => link.targetId), ['PO-0001'])
  assert.deepEqual(payload.procurementFollowups.map((item) => item.id), ['FU-1'])
  // The same order records as the full workbench.
  const full = await call('/api/purchase-orders-workbench')
  assert.deepEqual(payload.purchaseOrder, full.payload.purchaseOrders.find((row) => row.po === 'PO-0001'))
  assert.deepEqual(payload.receivingDocs[0], full.payload.receivingDocs.find((doc) => doc.grn === 'GRN-0001'))
})

test('the address may name the order by its number', async () => {
  const { status, payload } = await call(`/api/purchase-orders-workbench/${encodeURIComponent('PO-202611-0002')}`)
  assert.equal(status, 200)
  assert.equal(payload.purchaseOrder.po, 'PO-0002')
  assert.equal(payload.purchaseOrder.prNumber, undefined)
  assert.deepEqual(payload.supplierInvoices.map((invoice) => invoice.invoiceNumber), ['INV-0002'])
})

test("another workspace's order answers exactly as an unknown id: 404", async () => {
  const foreign = await call('/api/purchase-orders-workbench/PO-0009')
  const unknown = await call('/api/purchase-orders-workbench/PO-NONE')
  assert.deepEqual([foreign.status, foreign.payload.code], [404, 'PURCHASE_ORDER_NOT_FOUND'])
  assert.deepEqual(foreign.payload, unknown.payload)
  // The other workspace reads its own order, and none of this one's.
  const own = await call('/api/purchase-orders-workbench/PO-0009', 'workspace-administrator', OTHER)
  assert.equal(own.status, 200)
  assert.deepEqual(own.payload.receivingDocs.map((doc) => doc.grn), ['GRN-0009'])
  assert.deepEqual(own.payload.supplierInvoices, [])
  assert.equal((await call('/api/purchase-orders-workbench/PO-0001', 'workspace-administrator', OTHER)).status, 404)
})

test('the same checks and masking as the full workbench', async () => {
  const viewer = await call('/api/purchase-orders-workbench/PO-0001', 'read-only-viewer')
  assert.equal(viewer.status, 200)
  assert.equal(viewer.payload.purchaseOrder.lines[0].unitPrice, null)
  assert.deepEqual(viewer.payload.purchaseOrder.restrictedFields, ['amounts'])
  const full = await call('/api/purchase-orders-workbench', 'read-only-viewer')
  assert.deepEqual(viewer.payload.purchaseOrder, full.payload.purchaseOrders.find((row) => row.po === 'PO-0001'))
  assert.deepEqual(viewer.payload.supplierInvoices.map((invoice) => invoice.invoiceNumber), full.payload.supplierInvoices.filter((invoice) => ['INV-0001', 'INV-0003'].includes(invoice.invoiceNumber)).map((invoice) => invoice.invoiceNumber))
  // No PO read permission: refused before any lookup, the same for a real and a made-up order.
  const denied = await call('/api/purchase-orders-workbench/PO-0001', 'operations-specialist')
  const deniedUnknown = await call('/api/purchase-orders-workbench/PO-NONE', 'operations-specialist')
  assert.deepEqual([denied.status, denied.payload.code], [403, 'PERMISSION_DENIED'])
  assert.deepEqual(denied, deniedUnknown)
  // Signed out: no workspace to read from.
  const sent = []
  await handlePurchaseOrdersRoute({
    req: { method: 'GET', headers: {} }, res: {}, url: new URL('/api/purchase-orders-workbench/PO-0001', 'http://local'), env,
    identity: { authenticated: false }, repositories: { procurementRead: createDbProcurementReadRepository({ env, prisma }) },
    send: (_res, status, payload) => { sent.push({ status, payload }); return true },
  })
  assert.equal(sent[0].status, 401)
})

// The PO list reads ?view=list: every order header as the full workbench has
// it, on each line only what the list searches and totals, and receipts and
// invoices without their lines.
test('the list view keeps what the list reads and leaves out the lines it does not', async () => {
  const LIST_LINE_FIELDS = ['poLineId', 'sku', 'itemName', 'unit', 'quantityOrdered', 'quantityReceived', 'unitPrice', 'currency', 'status']
  for (const role of ['workspace-administrator', 'read-only-viewer']) {
    const full = await call('/api/purchase-orders-workbench', role)
    const list = await call('/api/purchase-orders-workbench?view=list', role)
    assert.equal(list.status, 200, role)
    assert.deepEqual(list.payload.summary, full.payload.summary, role)
    assert.deepEqual(list.payload.purchaseOrders.map(({ lines: _lines, ...header }) => header), full.payload.purchaseOrders.map(({ lines: _lines, ...header }) => header), role)
    assert.deepEqual(
      list.payload.purchaseOrders.map((order) => order.lines),
      full.payload.purchaseOrders.map((order) => order.lines.map((line) => Object.fromEntries(LIST_LINE_FIELDS.filter((key) => line[key] !== undefined).map((key) => [key, line[key]])))),
      role,
    )
    assert.deepEqual(list.payload.receivingDocs, full.payload.receivingDocs.map(({ lines: _lines, ...doc }) => doc), role)
    assert.deepEqual(list.payload.supplierInvoices, full.payload.supplierInvoices.map(({ lines: _lines, ...invoice }) => invoice), role)
    assert.ok(JSON.stringify(list.payload).length < JSON.stringify(full.payload).length, role)
  }
  const viewer = await call('/api/purchase-orders-workbench?view=list', 'read-only-viewer')
  assert.equal(viewer.payload.purchaseOrders[0].lines[0].unitPrice, null)
  assert.equal(viewer.payload.summary.committedValueByCurrency, null)
  const denied = await call('/api/purchase-orders-workbench?view=list', 'operations-specialist')
  assert.deepEqual([denied.status, denied.payload.code], [403, 'PERMISSION_DENIED'])
})

// UI review round 7: the detail tells the order's story to the end, so its
// read carries each invoice's own status, how its match exceptions were
// decided and what is paid on it, masked as the invoice amounts are.
test('each invoice comes with its own status, its exception decisions and its payment', async () => {
  rows.supplierInvoice.push({
    id: 'INV-0004', tenantId: TENANT, invoiceNumber: 'S21-7781', relatedPoId: 'PO-0001', supplierId: 'SUP-1', supplierName: 'Harbor Supply', amount: '90.00', varianceAmount: '6.00', currency: 'USD', status: 'approved', matchStatus: 'exception', createdAt: at, updatedAt: at,
    lines: [{ id: 'INV-0004-L1', purchaseOrderLineId: 'PO-0001-L1', receivingLineId: 'GRN-0001-L1', quantity: '4', unitPrice: '22.50', amount: '90.00' }],
    matchExceptions: [{ status: 'approved' }, { status: 'approved' }],
    payableObligation: { status: 'partially_settled', originalAmount: '90.0000', approvedCreditAmount: '0.0000', outstandingAmount: '30.0000', currency: 'USD' },
  })
  try {
    const { payload } = await call('/api/purchase-orders-workbench/PO-0001')
    const invoice = payload.supplierInvoices.find((row) => row.id === 'INV-0004')
    // The shared status reads 存在差异 while the invoice has a variance; its own status is approved.
    assert.equal(invoice.status, '存在差异')
    assert.equal(invoice.workflowStatus, 'approved')
    assert.deepEqual(invoice.matchExceptions, { count: 2, open: 0, approved: 2, rejected: 0 })
    assert.deepEqual(invoice.payment, { status: 'partially_settled', amount: 90, openAmount: 30, currency: 'USD' })
    // An invoice without a payable or exceptions says so.
    const submitted = payload.supplierInvoices.find((row) => row.id === 'INV-0001')
    assert.deepEqual([submitted.workflowStatus, submitted.payment, submitted.matchExceptions.count], ['submitted', null, 0])
    // The read-only viewer reads invoices without finance.amounts.read: it
    // sees the payment's state and the exception decisions, not the money.
    const viewer = await call('/api/purchase-orders-workbench/PO-0001', 'read-only-viewer')
    const masked = viewer.payload.supplierInvoices.find((row) => row.id === 'INV-0004')
    assert.ok(masked.restrictedFields.includes('amounts'))
    assert.deepEqual([masked.payment.status, masked.payment.amount, masked.payment.openAmount], ['partially_settled', null, null])
    assert.deepEqual(masked.matchExceptions, { count: 2, open: 0, approved: 2, rejected: 0 })
    // The list reads the invoice's own status too, to tell an approved invoice
    // from an open variance, and what it bills on each PO line, as its read
    // has no invoice lines.
    const list = await call('/api/purchase-orders-workbench?view=list')
    const listed = list.payload.supplierInvoices.find((row) => row.id === 'INV-0004')
    assert.deepEqual([listed.workflowStatus, listed.poLineQuantities, listed.lines], ['approved', { 'PO-0001-L1': 4 }, undefined])
  } finally {
    rows.supplierInvoice.pop()
  }
})

test('a malformed id is a 400, not a server error', async () => {
  const { status, payload } = await call('/api/purchase-orders-workbench/%E0%A4%A')
  assert.deepEqual([status, payload.code], [400, 'INVALID_PURCHASE_ORDER_ID'])
})
