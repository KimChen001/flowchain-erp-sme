import test from 'node:test'
import assert from 'node:assert/strict'
import { createDbProcurementReadRepository } from '../repositories/db-procurement-read-repository.mjs'
import { aiSkillActor } from '../domain/test-fixtures/ai-skill-scenario.mjs'
import { handleProcurementWorkflowRoute } from './procurement-workflow.routes.mjs'
import { handlePurchaseOrdersRoute } from './purchase-orders.routes.mjs'
import { handleProcurementReadRoute } from './procurement-read.routes.mjs'

// Every procurement read route answers each role with what the role may
// read: no collection it lacks the read permission for, and no price,
// amount or invoice supplier it lacks the field permission for. A hidden
// value is null with restrictedFields, never 0.

const TENANT = 'tenant-proc-read'
const env = { FLOWCHAIN_PERSISTENCE_MODE: 'database', DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain' }
const at = '2026-09-20T12:00:00.000Z'

const rows = {
  purchaseRequest: [{ id: 'PR-LEAK', tenantId: TENANT, status: 'submitted', amount: '250.00', currency: 'USD', createdAt: at, updatedAt: at, lines: [{ id: 'PRL-1', sku: 'SKU-1', quantity: '10', unitPrice: '25.00', amount: '250.00', unit: 'EA' }] }],
  rfq: [],
  supplierQuotation: [],
  purchaseOrder: [{ id: 'PO-LEAK', tenantId: TENANT, status: 'issued', supplierId: 'SUP-PROBE', supplierName: 'Probe Packaging Co.', amount: '125.00', currency: 'USD', expectedDate: at, createdAt: at, updatedAt: at, version: 1, lines: [{ id: 'POL-1', sku: 'SKU-1', orderedQuantity: '10', receivedQuantity: '0', unitPrice: '12.50', amount: '125.00', unit: 'EA' }] }],
  receivingDocument: [{ id: 'GRN-LEAK', tenantId: TENANT, status: 'received', relatedPoId: 'PO-LEAK', supplierName: 'Probe Packaging Co.', createdAt: at, updatedAt: at, lines: [{ id: 'GRNL-1', sku: 'SKU-1', acceptedQty: '10', rejectedQty: '0', unitPrice: '12.50', amount: '125.00' }] }],
  supplierInvoice: [{ id: 'INV-LEAK', tenantId: TENANT, status: 'submitted', relatedPoId: 'PO-LEAK', relatedGrnId: 'GRN-LEAK', supplierId: 'SUP-PROBE', supplierName: 'Probe Packaging Co.', amount: '131.25', subtotalAmount: '125.00', enteredTaxAmount: '6.25', totalAmount: '131.25', varianceAmount: '6.25', matchStatus: 'variance', currency: 'USD', createdAt: at, updatedAt: at, lines: [{ id: 'INVL-1', sku: 'SKU-1', quantity: '10', unitPrice: '13.125', amount: '131.25' }] }],
  documentLink: [],
  procurementFollowup: [],
}

const prisma = new Proxy({}, {
  get(_target, model) {
    return {
      findMany: async ({ where } = {}) => structuredClone((rows[model] || []).filter((row) => !where?.tenantId || row.tenantId === where.tenantId)),
      findFirst: async ({ where } = {}) => structuredClone((rows[model] || []).find((row) => row.tenantId === where?.tenantId && [row.id].includes(where?.id ?? where?.OR?.[0]?.id)) || null),
    }
  },
})

function call(handler, path, roleKey) {
  const sent = []
  const actor = aiSkillActor(roleKey, TENANT)
  const ctx = {
    req: { method: 'GET', headers: {} }, res: {}, url: new URL(path, 'http://local'), env,
    identity: actor,
    repositories: {
      procurementRead: createDbProcurementReadRepository({ env, prisma }),
      procurementAuthority: { readPurchaseOrder: async (_id, _context, options = {}) => ({ id: 'PO-LEAK', totalAmount: options.includePrices === false ? null : '125.0000', lines: [{ unitPrice: options.includePrices === false ? null : '12.5000' }] }) },
    },
    send: (_res, status, payload) => { sent.push({ status, payload }); return true },
    readBody: async () => ({}),
  }
  return handler(ctx).then(() => sent.at(-1))
}

const MONEY = /"(unitPrice|amount|totalAmount|subtotal|tax|taxAmount|total|varianceAmount|lineAmount|lineTotal|lineSubtotal|estimatedAmount|estimatedUnitPrice)":(?!null)/

test('a role without procurement prices gets every order and request with prices hidden', async () => {
  for (const path of ['/api/procurement/orders', '/api/purchase-orders']) {
    const { status, payload } = await call(path.startsWith('/api/purchase-orders') ? handlePurchaseOrdersRoute : handleProcurementWorkflowRoute, path, 'read-only-viewer')
    assert.equal(status, 200, path)
    assert.equal(payload[0].id, 'PO-LEAK')
    assert.doesNotMatch(JSON.stringify(payload), MONEY, path)
    assert.deepEqual(payload[0].restrictedFields, ['amounts'])
    // Supplier on a purchase order is part of reading the order.
    assert.equal(payload[0].supplier, 'Probe Packaging Co.')
  }
  const requests = await call(handleProcurementWorkflowRoute, '/api/procurement/requests', 'read-only-viewer')
  assert.doesNotMatch(JSON.stringify(requests.payload), MONEY)
  const detail = await call(handleProcurementWorkflowRoute, '/api/procurement/orders/PO-LEAK', 'read-only-viewer')
  assert.deepEqual([detail.status, detail.payload.totalAmount, detail.payload.lines[0].unitPrice, detail.payload.restrictedFields], [200, null, null, ['amounts']])
  const workbench = await call(handlePurchaseOrdersRoute, '/api/purchase-orders-workbench', 'read-only-viewer')
  assert.equal(workbench.payload.summary.committedValueByCurrency, null)
  assert.equal(workbench.payload.summary.committedOrderCount, 1)
  assert.doesNotMatch(JSON.stringify(workbench.payload), MONEY)
})

test('a role without purchase order read gets no orders, requests or RFQs on any route', async () => {
  for (const [handler, path] of [[handleProcurementWorkflowRoute, '/api/procurement/orders'], [handleProcurementWorkflowRoute, '/api/procurement/requests'], [handleProcurementWorkflowRoute, '/api/procurement/rfqs'], [handlePurchaseOrdersRoute, '/api/purchase-orders'], [handlePurchaseOrdersRoute, '/api/purchase-orders-workbench']]) {
    const { status, payload } = await call(handler, path, 'operations-specialist')
    assert.deepEqual([status, payload.code], [403, 'PERMISSION_DENIED'], path)
  }
  const documents = await call(handleProcurementReadRoute, '/api/procurement/documents', 'operations-specialist')
  const types = [...new Set(documents.payload.documents.map((document) => document.documentType))].sort()
  assert.ok(!types.includes('po') && !types.includes('pr') && !types.includes('rfq'), types.join())
  assert.ok(types.includes('invoice') && types.includes('grn'), types.join())
  // Invoices without finance amounts or the partner snapshot: no money, no supplier.
  const invoice = documents.payload.documents.find((document) => document.documentType === 'invoice')
  assert.equal(invoice.supplier, null)
  assert.equal(invoice.supplierId, null)
  assert.doesNotMatch(JSON.stringify(documents.payload), MONEY)
  // No amount anywhere, also not inside titles, labels or reasons. The
  // supplier stays on the receipt, which receiving needs; not on invoices.
  assert.doesNotMatch(JSON.stringify(documents.payload), /125|131|12\.5|6\.25/)
  const financial = documents.payload.documents.filter((document) => ['invoice', 'threeWayMatch'].includes(document.documentType))
  assert.ok(financial.length >= 2)
  assert.doesNotMatch(JSON.stringify(financial), /Probe Packaging|SUP-PROBE/)
  // Record numbers survive the scrubbing.
  assert.ok(financial.some((document) => document.relatedPo === 'PO-LEAK' || document.poId === 'PO-LEAK'))
  // The type decides before any lookup: the same answer for a real and a made-up order.
  const real = await call(handleProcurementReadRoute, '/api/procurement/documents/po/PO-LEAK', 'operations-specialist')
  const made = await call(handleProcurementReadRoute, '/api/procurement/documents/po/PO-NONE', 'operations-specialist')
  assert.deepEqual([real.status, real.payload], [made.status, made.payload])
  assert.equal(real.status, 403)
  // A search cannot find a hidden amount.
  const search = await call(handleProcurementReadRoute, '/api/procurement/documents?q=131.25', 'operations-specialist')
  assert.deepEqual(search.payload.documents, [])
})

test('finance sees invoices with amounts and suppliers but no orders; buyers the reverse', async () => {
  const finance = await call(handleProcurementReadRoute, '/api/procurement/documents', 'finance-specialist')
  const financeTypes = new Set(finance.payload.documents.map((document) => document.documentType))
  assert.ok(financeTypes.has('invoice') && !financeTypes.has('po') && !financeTypes.has('grn'))
  const invoice = finance.payload.documents.find((document) => document.documentType === 'invoice')
  assert.equal(invoice.supplier, 'Probe Packaging Co.')
  assert.equal(invoice.amount, 131.25)
  assert.equal(invoice.restrictedFields, undefined)
  const buyer = await call(handleProcurementReadRoute, '/api/procurement/documents', 'procurement-specialist')
  const buyerTypes = new Set(buyer.payload.documents.map((document) => document.documentType))
  assert.ok(buyerTypes.has('po') && !buyerTypes.has('invoice') && !buyerTypes.has('threeWayMatch'))
  assert.equal(buyer.payload.documents.find((document) => document.documentType === 'po').amount, 125)
  // The summary's open amount mixes orders and invoices: hidden for both roles.
  for (const role of ['finance-specialist', 'procurement-specialist']) {
    const { payload } = await call(handleProcurementReadRoute, '/api/procurement/summary', role)
    assert.deepEqual([payload.summary.totalOpenAmount, payload.summary.currencyAggregationStatus], [null, 'restricted'], role)
  }
})

test('the administrator still reads everything unmasked', async () => {
  const { payload } = await call(handleProcurementReadRoute, '/api/procurement/documents', 'workspace-administrator')
  const types = new Set(payload.documents.map((document) => document.documentType))
  for (const type of ['pr', 'po', 'grn', 'invoice']) assert.ok(types.has(type), type)
  assert.ok(payload.documents.every((document) => !document.restrictedFields))
  const summary = await call(handleProcurementReadRoute, '/api/procurement/summary', 'workspace-administrator')
  assert.notEqual(summary.payload.summary.currencyAggregationStatus, 'restricted')
})
