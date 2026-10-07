import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPurchaseOrderDocument, documentSettingsSeed, PRINTABLE_PURCHASE_ORDER_STATUSES } from '../../shared/business-documents.mjs'
import { createPurchaseOrderDocumentReadService } from './purchase-order-document-read-service.mjs'
import { handleProcurementWorkflowRoute } from '../routes/procurement-workflow.routes.mjs'
import { aiSkillActor } from './test-fixtures/ai-skill-scenario.mjs'

// The PO document prints what is recorded and nothing else: a missing value
// is null (shown as "—"), never a default; amounts stay decimal strings with
// one total in the PO's currency; quantities are never added up. It is
// printable once approved, and only for a role that may see prices.

const order = (overrides = {}) => ({
  id: 'PO-77',
  orderNumber: 'PO-2026-0077',
  status: 'approved',
  supplierId: 'SUP-1',
  supplierSnapshot: { id: 'SUP-1', supplierName: 'Harbor Supply (as ordered)' },
  currency: 'EUR',
  totalAmount: '1234.5600',
  expectedDate: '2026-11-03T00:00:00.000Z',
  metadata: { orderNumber: 'PO-2026-0077', targetWarehouseId: 'WH-1' },
  lines: [
    { id: 'L1', itemId: 'ITEM-1', sku: 'VAL-10', itemName: 'Brass valve', quantity: '10.0000', orderedQuantity: '10.0000', unit: 'EA', unitPrice: '100.1234', amount: '1001.2340', requestedDate: '2026-11-01', promisedDate: '2026-11-03' },
    { id: 'L2', itemId: 'ITEM-2', sku: 'HOSE-2', itemName: 'Hose', quantity: '2.5000', orderedQuantity: '2.5000', unit: 'M', unitPrice: '93.3300', amount: '233.3260', requestedDate: null, promisedDate: null },
  ],
  ...overrides,
})
// A supplier with contact details, tax and bank details, and no recorded
// currency or payment terms.
const supplier = {
  id: 'SUP-1', code: null, name: 'Harbor Supply',
  metadata: { contactName: 'Dana Ruiz', email: 'orders@harbor.example', taxIdentificationNumber: 'TAX-998877', bankAccountNumber: '000111222333', bankName: 'Coastal Bank', creditCode: 'CC-1' },
}
const build = (overrides = {}) => buildPurchaseOrderDocument({
  order: order(),
  supplier,
  warehouse: { id: 'WH-1', code: 'OAK', name: 'Oakland DC' },
  supplierSkus: [{ itemId: 'ITEM-1', supplierSku: 'HS-VAL-10' }, { itemId: 'ITEM-2', supplierSku: '' }],
  letterhead: documentSettingsSeed.letterhead,
  template: documentSettingsSeed.purchaseOrder,
  workspace: { legalName: null, name: 'Harbor Goods' },
  access: { prices: true },
  ...overrides,
})

test('missing values are null, never a default currency, payment terms or contact', () => {
  const document = build()
  assert.deepEqual(document.supplier, { name: 'Harbor Supply', code: null, contactName: 'Dana Ruiz', email: 'orders@harbor.example', telephone: null, address: null, postalCode: null })
  assert.equal(document.buyer.companyName, 'Harbor Goods', 'no letterhead name prints the workspace name')
  assert.deepEqual([document.buyer.phone, document.buyer.email, document.buyer.taxId, document.buyer.addressLines], [null, null, null, []])
  assert.deepEqual(document.shipTo, { code: 'OAK', name: 'Oakland DC' })
  assert.equal(document.termsText, null, 'no payment terms are recorded on a PO and no template terms are set')
  const serialized = JSON.stringify(document)
  for (const invented of ['NET30', 'Net 30', '"USD"']) assert.equal(serialized.includes(invented), false, invented)
  assert.deepEqual(document.lines.map((line) => line.supplierSku), ['HS-VAL-10', null], 'an empty supplier SKU is not recorded')
  assert.deepEqual(document.lines.map((line) => [line.requestedDate, line.promisedDate]), [['2026-11-01', '2026-11-03'], [null, null]])
  assert.equal(document.expectedDate, '2026-11-03', 'a calendar date stays the recorded day')
  assert.equal(document.issuedAt, null)
  assert.equal(build({ order: order({ status: 'issued', metadata: { issuedAt: '2026-10-02T14:05:00.000Z' } }) }).issuedAt, '2026-10-02T14:05:00.000Z')
  assert.equal(build({ order: order({ status: 'issued', issuedAt: '2026-10-02T14:05:00.000Z', metadata: {} }) }).issuedAt, '2026-10-02T14:05:00.000Z')
})

test('a supplier\'s tax and bank details are never part of the document', () => {
  const serialized = JSON.stringify(build())
  for (const secret of ['TAX-998877', '000111222333', 'Coastal Bank', 'CC-1', 'taxIdentificationNumber', 'bankAccount', 'creditCode']) assert.equal(serialized.includes(secret), false, secret)
})

test('one total in the PO\'s currency, the recorded amount, and no quantity total', () => {
  const document = build()
  assert.deepEqual(document.totals, [{ currency: 'EUR', amount: '1234.5600' }])
  assert.equal(document.currency, 'EUR')
  assert.equal(JSON.stringify(document).includes('totalQuantity'), false)
  assert.deepEqual(Object.keys(document).filter((key) => /quantit/i.test(key)), [])
})

test('decimal strings are kept as recorded', () => {
  const [first, second] = build().lines
  assert.deepEqual([first.quantity, first.unitPrice, first.amount], ['10.0000', '100.1234', '1001.2340'])
  assert.deepEqual([second.quantity, second.unit, second.amount], ['2.5000', 'M', '233.3260'])
})

test('a PO is printable from approval on, and not before or after cancellation', () => {
  assert.deepEqual(PRINTABLE_PURCHASE_ORDER_STATUSES, ['approved', 'issued', 'partially_received', 'fully_received', 'closed'])
  for (const status of PRINTABLE_PURCHASE_ORDER_STATUSES) assert.deepEqual(build({ order: order({ status }) }).printable, { ok: true, reason: null }, status)
  for (const status of ['draft', 'pending_approval', 'rejected', 'cancelled']) assert.deepEqual(build({ order: order({ status }) }).printable, { ok: false, reason: 'status' }, status)
})

test('a role that cannot see prices gets a document that cannot be printed, with no prices', () => {
  const masked = order({ totalAmount: null, lines: order().lines.map((line) => ({ ...line, unitPrice: null, amount: null })) })
  const document = build({ order: masked, access: { prices: false } })
  assert.deepEqual(document.printable, { ok: false, reason: 'prices_hidden' })
  assert.deepEqual(document.totals, [{ currency: 'EUR', amount: null }])
  assert.deepEqual(document.lines.map((line) => [line.unitPrice, line.amount]), [[null, null], [null, null]])
  assert.deepEqual(build({ access: {} }).printable, { ok: false, reason: 'prices_hidden' }, 'no access answer is no prices')
})

test('the letterhead and template print as set, and the PO\'s own supplier name stands in for a missing supplier', () => {
  const document = build({
    supplier: null,
    letterhead: { companyName: 'Harbor Goods LLC', addressLines: ['12 Pier Road', 'Oakland, CA 94607'], phone: '+1 510 555 0100', email: null, taxId: '94-1234567' },
    template: { title: 'Purchase Order', columns: { supplierSku: false, requestedDate: true, promisedDate: false }, termsText: 'Net 30 from invoice.', footerText: '', signatureBlock: true },
    documentLanguage: 'zh-CN',
  })
  assert.equal(document.supplier.name, 'Harbor Supply (as ordered)')
  assert.equal(document.buyer.companyName, 'Harbor Goods LLC')
  assert.deepEqual(document.columns, { supplierSku: false, requestedDate: true, promisedDate: false })
  assert.deepEqual([document.title, document.termsText, document.footerText, document.signatureBlock, document.documentLanguage], ['Purchase Order', 'Net 30 from invoice.', null, true, 'zh-CN'])
})

// The route: the document is read with exactly the detail route's arguments,
// then the rest in the signed-in workspace.
function call(path, roleKey, { readPurchaseOrder, readPurchaseOrderDocument }) {
  let sent
  const ctx = {
    req: { method: 'GET', headers: {} }, res: {}, url: new URL(path, 'http://local'), env: {},
    identity: aiSkillActor(roleKey, 'tenant-doc'),
    repositories: { procurementAuthority: { readPurchaseOrder }, purchaseOrderDocuments: { readPurchaseOrderDocument } },
    send: (_res, status, payload) => { sent = { status, payload }; return true },
    readBody: async () => ({}),
  }
  return handleProcurementWorkflowRoute(ctx).then((handled) => ({ handled, ...sent }))
}

test('the document route reads the PO exactly as the detail route does', async () => {
  for (const [roleKey, prices] of [['workspace-administrator', true], ['read-only-viewer', false]]) {
    const reads = []
    const readPurchaseOrder = async (id, context, options) => { reads.push({ id, tenantId: context.identity.tenantId, options }); return order() }
    const detail = await call('/api/procurement/orders/PO-77', roleKey, { readPurchaseOrder })
    const document = await call('/api/procurement/orders/PO-77/document', roleKey, {
      readPurchaseOrder,
      readPurchaseOrderDocument: async ({ tenantId, order: read, access }) => ({ tenantId, orderId: read.id, prices: access.prices }),
    })
    assert.equal(detail.status, 200)
    assert.deepEqual(reads[0], reads[1], roleKey)
    assert.deepEqual(reads[1], { id: 'PO-77', tenantId: 'tenant-doc', options: { includePrices: prices, includePartner: true } })
    assert.deepEqual([document.handled, document.status, document.payload], [true, 200, { document: { tenantId: 'tenant-doc', orderId: 'PO-77', prices } }])
  }
})

test('the document route answers the read\'s own refusal', async () => {
  const refuse = (status, code) => async () => { throw Object.assign(new Error(code), { status, code }) }
  const notFound = await call('/api/procurement/orders/OTHER-TENANT-PO/document', 'workspace-administrator', { readPurchaseOrder: refuse(404, 'PURCHASE_ORDER_NOT_FOUND'), readPurchaseOrderDocument: async () => assert.fail('nothing else is read') })
  assert.deepEqual([notFound.status, notFound.payload.code], [404, 'PURCHASE_ORDER_NOT_FOUND'])
  const denied = await call('/api/procurement/orders/PO-77/document', 'finance-specialist', { readPurchaseOrder: refuse(403, 'AUTHORIZATION_PERMISSION_DENIED'), readPurchaseOrderDocument: async () => assert.fail('nothing else is read') })
  assert.deepEqual([denied.status, denied.payload.code], [403, 'AUTHORIZATION_PERMISSION_DENIED'])
})

test('the read service reads the stored supplier, links, warehouse and settings in the PO\'s workspace only', async () => {
  const calls = []
  const model = (name, row) => ({
    findUnique: async (args) => { calls.push([name, args.where]); return row },
    findFirst: async (args) => { calls.push([name, args.where]); return row },
    findMany: async (args) => { calls.push([name, args.where]); return row },
  })
  const prisma = {
    tenant: model('tenant', { name: 'Harbor Goods', legalName: 'Harbor Goods LLC', operationalSettings: { documents: { documentLanguage: 'zh-CN', purchaseOrder: { termsText: 'Net 30 from invoice.' } } } }),
    supplier: model('supplier', supplier),
    warehouse: model('warehouse', { id: 'WH-1', code: 'OAK', name: 'Oakland DC' }),
    runtimeRecord: model('runtimeRecord', [{ id: 'ISR-1', payload: { itemId: 'ITEM-1', supplierId: 'SUP-1', supplierSku: 'HS-VAL-10' } }]),
  }
  const document = await createPurchaseOrderDocumentReadService({ prisma }).readPurchaseOrderDocument({ tenantId: 'tenant-doc', order: order(), access: { prices: true } })
  assert.deepEqual(calls.map(([, where]) => where.tenantId ?? where.id), ['tenant-doc', 'tenant-doc', 'tenant-doc', 'tenant-doc'])
  assert.deepEqual([document.buyer.companyName, document.documentLanguage, document.termsText, document.lines[0].supplierSku, document.shipTo.code], ['Harbor Goods LLC', 'zh-CN', 'Net 30 from invoice.', 'HS-VAL-10', 'OAK'])
  await assert.rejects(createPurchaseOrderDocumentReadService({ prisma }).readPurchaseOrderDocument({ tenantId: '', order: order(), access: {} }), (error) => error.status === 403)
})
