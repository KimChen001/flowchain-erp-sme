import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCustomerInvoiceDocument, buildPurchaseOrderDocument, documentSettingsSeed, PREVIEW_CUSTOMER_INVOICE_STATUSES, PRINTABLE_CUSTOMER_INVOICE_STATUSES, PRINTABLE_PURCHASE_ORDER_STATUSES, recordedPaymentTerms } from '../../shared/business-documents.mjs'
import { createPurchaseOrderDocumentReadService } from './purchase-order-document-read-service.mjs'
import { createCustomerInvoiceDocumentReadService, customerInvoiceDocumentAccess } from './customer-invoice-document-read-service.mjs'
import { handleOperationalFinanceRoute } from '../routes/operational-finance.routes.mjs'
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
    { id: 'L1', itemId: 'ITEM-1', sku: 'VAL-10', itemName: 'Brass valve', quantity: '10.0000', orderedQuantity: '10.0000', unit: 'EA', unitPrice: '100.1234', amount: '1001.2340', requestedDate: '2026-11-01', recordedPromisedDate: '2026-11-02', promisedDate: '2026-11-02' },
    { id: 'L2', itemId: 'ITEM-2', sku: 'HOSE-2', itemName: 'Hose', quantity: '2.5000', orderedQuantity: '2.5000', unit: 'M', unitPrice: '93.3300', amount: '233.3260', requestedDate: null, recordedPromisedDate: null, promisedDate: '2026-11-03' },
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
  assert.deepEqual(document.lines.map((line) => [line.requestedDate, line.promisedDate]), [['2026-11-01', '2026-11-02'], [null, null]], 'a promised date only where the line records one, never the expected date of the PO')
  assert.equal(document.expectedDate, '2026-11-03', 'a calendar date stays the recorded day')
  assert.equal(document.issuedAt, null)
  assert.equal(build({ order: order({ status: 'issued', metadata: { issuedAt: '2026-10-02T14:05:00.000Z' } }) }).issuedAt, '2026-10-02T14:05:00.000Z')
  assert.equal(build({ order: order({ status: 'issued', issuedAt: '2026-10-02T14:05:00.000Z', metadata: {} }) }).issuedAt, '2026-10-02T14:05:00.000Z')
})

test('the PO prints the supplier\'s recorded payment terms, by their recorded name, and none when none were recorded', () => {
  assert.equal(build().paymentTerms, null, 'nothing recorded: left off, never NET30')
  const withTerms = { ...supplier, metadata: { ...supplier.metadata, paymentTermsId: 'LOCAL-DEMO-NET45' } }
  assert.equal(build({ supplier: withTerms }).paymentTerms, 'LOCAL-DEMO-NET45', 'no payment term names it: as stored')
  assert.equal(build({ supplier: withTerms, paymentTerms: [{ id: 'LOCAL-DEMO-NET45', code: 'NET45', name: 'Net 45' }] }).paymentTerms, 'Net 45')
  assert.equal(build({ supplier: { ...supplier, metadata: { paymentTerms: 'NET15' } }, paymentTerms: [{ id: 'PT-15', code: 'NET15', name: 'Net 15 days' }] }).paymentTerms, 'Net 15 days', 'by code')
  assert.equal(build({ supplier: null }).paymentTerms, null)
})

test('the PO read service looks up only the payment term the supplier records, in the PO\'s workspace', async () => {
  const calls = []
  const prisma = {
    tenant: { findUnique: async () => ({ name: 'Harbor Goods', legalName: null, operationalSettings: {} }) },
    supplier: { findFirst: async () => ({ ...supplier, metadata: { ...supplier.metadata, paymentTermsId: 'NET45' } }) },
    warehouse: { findFirst: async () => null },
    runtimeRecord: { findMany: async () => [] },
    paymentTerm: { findMany: async (args) => { calls.push(args.where); return [{ id: 'PT-45', code: 'NET45', name: 'Net 45 days' }] } },
  }
  const document = await createPurchaseOrderDocumentReadService({ prisma }).readPurchaseOrderDocument({ tenantId: 'tenant-doc', order: order(), access: { prices: true } })
  assert.deepEqual(calls, [{ tenantId: 'tenant-doc', OR: [{ id: 'NET45' }, { code: 'NET45' }] }])
  assert.equal(document.paymentTerms, 'Net 45 days')
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

// FlowChain prepares the document; a person sends it. The page has no way to
// send anything, says so, and Issue still only records the issue.
test('the document page sends nothing and says FlowChain does not send it', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const folder = new URL('../../src/modules/business-documents/', import.meta.url)
  const sources = readdirSync(folder).map((name) => [name, readFileSync(new URL(name, folder), 'utf8')])
  assert.ok(sources.some(([name]) => name === 'PurchaseOrderDocumentPage.tsx'))
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /mailto:|sendMail|\/api\/[^"'`]*(mail|send|email)|method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, name)
  }
  const i18n = readFileSync(new URL('../../src/i18n/I18n.tsx', import.meta.url), 'utf8')
  assert.match(i18n, /"documents\.sendNote": "FlowChain does not send this document\. Print or save it and send it yourself\."/)
  assert.match(sources.find(([name]) => name === 'DocumentShell.tsx')[1], /t\("documents\.sendNote"\)/)
  const actions = readFileSync(new URL('../../src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx', import.meta.url), 'utf8')
  assert.match(actions, /Print or save the PO document and send it yourself, then mark it issued\./)
  const route = readFileSync(new URL('../routes/procurement-workflow.routes.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(route.slice(route.indexOf('orderDocument'), route.indexOf('const poAction')), /mail|transmi/i)
})

test('the promised date column starts off and the requested date column on', () => {
  assert.deepEqual(documentSettingsSeed.purchaseOrder.columns, { supplierSku: true, requestedDate: true, promisedDate: false })
  assert.deepEqual(build().columns, { supplierSku: true, requestedDate: true, promisedDate: false })
})

test('the copy sent carries the recorded approval date, never today, and the issue date only once issued', () => {
  const timeline = [
    { action: 'submit', at: '2026-10-01T15:00:00.000Z' },
    { action: 'approve', at: '2026-10-02T16:30:00.000Z' },
    { action: 'issue', at: '2026-10-03T09:00:00.000Z' },
  ]
  assert.equal(build({ order: order({ approvalTimeline: timeline }) }).approvedAt, '2026-10-02T16:30:00.000Z')
  assert.equal(build({ order: order({ metadata: { approvalTimeline: timeline } }) }).approvedAt, '2026-10-02T16:30:00.000Z', 'read from the metadata as well')
  const document = build()
  assert.deepEqual([document.approvedAt, document.issuedAt], [null, null], 'no recorded approval: no date')
  assert.equal(build({ order: order({ approvalTimeline: [{ action: 'approve', at: 'not a time' }] }) }).approvedAt, null)
})

test('ship-to prints nothing when the warehouse is not found, not its raw id', () => {
  assert.deepEqual(build({ warehouse: null }).shipTo, { code: null, name: null })
  assert.equal(JSON.stringify(build({ warehouse: null })).includes('WH-1'), false)
})

test('supplier SKUs come only from active item links', () => {
  const document = build({ supplierSkus: [{ itemId: 'ITEM-1', supplierSku: 'OLD-SKU', active: false }, { itemId: 'ITEM-2', supplierSku: 'HS-HOSE', active: true }] })
  assert.deepEqual(document.lines.map((line) => line.supplierSku), [null, 'HS-HOSE'])
})

test('a stored negative zero prints as zero, and recorded digits are kept', async () => {
  const { formatDecimal, formatAmount, formatCalendarDay } = await import('../../src/modules/business-documents/documentFormat.ts')
  assert.equal(formatAmount('-0.0000', 'USD', 'en-US'), '0.00')
  assert.equal(formatDecimal('-0.0000', 'en-US'), '0')
  assert.equal(formatAmount('-12.5000', 'USD', 'en-US'), '-12.50')
  assert.equal(formatAmount('1001.2340', 'EUR', 'en-US'), '1,001.234')
  assert.equal(formatDecimal('19500.0000', 'en-US'), '19,500')
  assert.equal(formatAmount(null, 'USD', 'en-US'), '—')
  assert.equal(formatCalendarDay('2026-11-03', 'en-US'), 'Nov 3, 2026', 'a calendar day does not move a day back')
})

// ---------------------------------------------------------------- customer invoice

// The invoice document prints what the invoice records, as the detail read
// returns it: amounts and the customer name come masked (null) for a role
// that may not see them, and the receivable part is there only for a role
// that may read receivables. One invoice, one currency: one total, never
// converted; what was paid is printed only in that same currency.

const visible = (shown) => ({ visible: shown, reasonCode: shown ? null : 'FIELD_PERMISSION_DENIED' })
const invoice = (overrides = {}) => ({
  id: 'CI-9',
  invoiceNumber: 'INV-2026-0009',
  salesOrderId: 'SO-1',
  salesOrderNumber: 'SO-2026-0001',
  shipmentId: 'SHIP-1',
  shipmentNumber: 'SHIP-2026-0001',
  customerId: 'CUST-1',
  customerName: 'Bayside Retail (as invoiced)',
  invoiceDate: '2026-10-05T00:00:00.000Z',
  dueDate: '2026-11-04T00:00:00.000Z',
  subtotalAmount: '250',
  enteredTaxAmount: '20.5',
  totalAmount: '270.5',
  currency: 'EUR',
  status: 'issued',
  fieldVisibility: { subtotalAmount: visible(true), enteredTaxAmount: visible(true), totalAmount: visible(true), customerName: visible(true) },
  lines: [
    { id: 'CIL-1', lineNumber: 1, sku: 'VAL-10', itemName: 'Brass valve', quantity: '10', unit: 'EA', unitPrice: '12.5', lineAmount: '125', enteredTaxAmount: '10', totalAmount: '135' },
    { id: 'CIL-2', lineNumber: 2, sku: 'HOSE-2', itemName: 'Hose', quantity: '2.5', unit: 'M', unitPrice: '50', lineAmount: '125', enteredTaxAmount: '10.5', totalAmount: '135.5' },
  ],
  receivable: { id: 'AR-1', currency: 'EUR', originalAmount: '270.5', approvedCreditAmount: '20.5', outstandingAmount: '150', paidAmount: '100.0000', status: 'partially_settled' },
  ...overrides,
})
// The stored customer: contact details recorded, and a currency and credit
// standing that a document never prints; no payment terms recorded.
const customerRecord = { id: 'rr-1', recordKey: 'BAYSIDE', payload: { id: 'CUST-1', code: 'BAYSIDE', name: 'Bayside Retail', contact: 'Lee Park', email: 'ap@bayside.example', phone: '', address: '9 Market St, Oakland', currency: 'GBP', creditStatus: 'on_hold', creditLimit: '50000' } }
const buildInvoice = (overrides = {}) => buildCustomerInvoiceDocument({
  invoice: invoice(),
  customer: customerRecord,
  letterhead: documentSettingsSeed.letterhead,
  template: documentSettingsSeed.customerInvoice,
  workspace: { legalName: 'Harbor Goods LLC', name: 'Harbor Goods' },
  access: { amounts: true, partner: true },
  ...overrides,
})

test('invoice: missing values are null, never a default currency or payment terms', () => {
  const document = buildInvoice()
  assert.deepEqual(document.billTo, { name: 'Bayside Retail (as invoiced)', code: 'BAYSIDE', contactName: 'Lee Park', email: 'ap@bayside.example', telephone: null, address: '9 Market St, Oakland' })
  assert.equal(document.paymentTerms, null, 'no terms recorded on the customer: left off, never NET30')
  assert.deepEqual(document.seller, { companyName: 'Harbor Goods LLC', addressLines: [], phone: null, email: null, taxId: null })
  assert.deepEqual([document.invoiceDate, document.dueDate], ['2026-10-05', '2026-11-04'], 'calendar dates are the recorded UTC days')
  assert.deepEqual([document.number, document.salesOrderNumber, document.shipmentNumber, document.currency], ['INV-2026-0009', 'SO-2026-0001', 'SHIP-2026-0001', 'EUR'])
  assert.deepEqual([document.paymentInstructions, document.termsText, document.footerText, document.title], [null, null, null, null])
  const serialized = JSON.stringify(document)
  for (const invented of ['NET30', 'Net 30', '"USD"', 'GBP', 'on_hold', 'creditStatus', 'creditLimit', '50000']) assert.equal(serialized.includes(invented), false, invented)
  const bare = buildInvoice({ invoice: invoice({ invoiceDate: null, dueDate: '', salesOrderNumber: undefined }), customer: null })
  assert.deepEqual([bare.invoiceDate, bare.dueDate, bare.salesOrderNumber], [null, null, null])
  assert.deepEqual(bare.billTo, { name: 'Bayside Retail (as invoiced)', code: null, contactName: null, email: null, telephone: null, address: null }, 'no customer record: only the name recorded on the invoice')
  assert.equal(bare.paymentTerms, null)
  const withTerms = { ...customerRecord, payload: { ...customerRecord.payload, paymentTerms: 'NET45' } }
  assert.equal(buildInvoice({ customer: withTerms }).paymentTerms, 'NET45', 'a code no payment term names is printed as stored')
  assert.equal(buildInvoice({ customer: withTerms, paymentTerms: [{ id: 'PT-45', code: 'NET45', name: 'Net 45 days' }] }).paymentTerms, 'Net 45 days', 'the recorded name of the term')
  assert.equal(buildInvoice({ customer: withTerms, access: { amounts: true, partner: false } }).paymentTerms, null, 'not from a customer that may not be seen')
})

test('invoice: lines keep the recorded amount, tax and total; one total per currency; quantities never added', () => {
  const document = buildInvoice()
  assert.deepEqual(document.lines.map((line) => [line.lineNo, line.sku, line.quantity, line.unit, line.unitPrice, line.amount, line.tax, line.total]), [
    [1, 'VAL-10', '10', 'EA', '12.5', '125', '10', '135'],
    [2, 'HOSE-2', '2.5', 'M', '50', '125', '10.5', '135.5'],
  ])
  assert.deepEqual(document.totals, [{ currency: 'EUR', subtotal: '250', tax: '20.5', total: '270.5' }])
  assert.deepEqual(Object.keys(document).filter((key) => /quantit/i.test(key)), [])
  assert.equal(JSON.stringify(document).includes('totalQuantity'), false)
})

test('payment terms print the recorded name where a payment term names the stored value, else the value as stored', () => {
  const terms = [{ id: 'LOCAL-DEMO-NET30', code: 'NET30', name: 'Net 30' }, { id: 'PT-DUE', code: 'DUE', name: '' }]
  assert.equal(recordedPaymentTerms('LOCAL-DEMO-NET30', terms), 'Net 30', 'by id')
  assert.equal(recordedPaymentTerms('NET30', terms), 'Net 30', 'by code')
  assert.equal(recordedPaymentTerms('DUE', terms), 'DUE', 'a term with no recorded name prints its code')
  assert.equal(recordedPaymentTerms(' 2/10 net 30 ', []), '2/10 net 30', 'free text as recorded')
  for (const nothing of [null, undefined, '', '  ']) assert.equal(recordedPaymentTerms(nothing, terms), null)
})

test('invoice: calendar days print as the day recorded, in any time zone', async () => {
  const { formatCalendarDay } = await import('../../src/modules/business-documents/documentFormat.ts')
  // Finance due dates are stored at 00:00 UTC: in New York that instant is still the 14th.
  const document = buildInvoice({ invoice: invoice({ invoiceDate: new Date('2026-10-15T00:00:00.000Z'), dueDate: '2026-10-15T00:00:00.000Z' }) })
  assert.deepEqual([document.invoiceDate, document.dueDate], ['2026-10-15', '2026-10-15'])
  assert.equal(new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'America/Los_Angeles' }).format(new Date('2026-10-15T00:00:00.000Z')), 'Oct 14, 2026', 'read as an instant it would move a day back')
  const previous = process.env.TZ
  try {
    for (const zone of ['America/Los_Angeles', 'America/New_York', 'Asia/Shanghai', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = zone
      assert.equal(formatCalendarDay(document.dueDate, 'en-US'), 'Oct 15, 2026', zone)
      assert.equal(formatCalendarDay('2026-10-15T00:00:00.000Z', 'en-US'), 'Oct 15, 2026', `${zone}, from the stored instant`)
    }
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('invoice: the tax column is printed only when the template turns it on', () => {
  assert.deepEqual(buildInvoice().columns, { tax: false })
  assert.deepEqual(documentSettingsSeed.customerInvoice.columns, { tax: false })
  assert.deepEqual(buildInvoice({ template: { ...documentSettingsSeed.customerInvoice, columns: { tax: true } } }).columns, { tax: true })
})

test('invoice: the payment summary is printed only from a readable receivable in the invoice currency', () => {
  assert.deepEqual(buildInvoice().paymentSummary, { currency: 'EUR', amountPaid: '100.0000', creditsApplied: '20.5', balanceDue: '150' })
  assert.equal(buildInvoice({ invoice: invoice({ receivable: { ...invoice().receivable, currency: 'USD' } }) }).paymentSummary, null, 'another currency: dropped, never converted')
  assert.equal(buildInvoice({ invoice: invoice({ receivable: { ...invoice().receivable, currency: null } }) }).paymentSummary, null, 'no currency recorded: dropped')
  assert.equal(buildInvoice({ invoice: invoice({ receivable: null }) }).paymentSummary, null, 'no finance.receivable.read (or not issued): dropped')
  assert.equal(buildInvoice({ template: { ...documentSettingsSeed.customerInvoice, showPaymentSummary: false } }).paymentSummary, null, 'turned off in the template')
})

test('invoice: printable once issued (or disputed), shown but not printable when approved, blocked before', () => {
  assert.deepEqual(PRINTABLE_CUSTOMER_INVOICE_STATUSES, ['issued', 'disputed'])
  assert.deepEqual(PREVIEW_CUSTOMER_INVOICE_STATUSES, ['approved'])
  for (const status of ['issued', 'disputed']) assert.deepEqual(buildInvoice({ invoice: invoice({ status }) }).printable, { ok: true, reason: null }, status)
  assert.deepEqual(buildInvoice({ invoice: invoice({ status: 'approved', receivable: null }) }).printable, { ok: false, reason: 'not_issued' })
  for (const status of ['draft', 'submitted', 'cancelled', null]) assert.deepEqual(buildInvoice({ invoice: invoice({ status }) }).printable, { ok: false, reason: 'status' }, String(status))
})

test('invoice: hidden amounts or a hidden customer make it not printable, with nothing filled in', () => {
  const masked = invoice({
    subtotalAmount: null, enteredTaxAmount: null, totalAmount: null,
    lines: invoice().lines.map((line) => ({ ...line, unitPrice: null, lineAmount: null, enteredTaxAmount: null, totalAmount: null })),
    receivable: { ...invoice().receivable, originalAmount: null, approvedCreditAmount: null, outstandingAmount: null, paidAmount: null },
  })
  const noAmounts = buildInvoice({ invoice: masked, access: { amounts: false, partner: true } })
  assert.deepEqual(noAmounts.printable, { ok: false, reason: 'amounts_hidden' })
  assert.deepEqual(noAmounts.totals, [{ currency: 'EUR', subtotal: null, tax: null, total: null }])
  assert.deepEqual(noAmounts.lines.map((line) => [line.unitPrice, line.amount, line.tax, line.total]), [[null, null, null, null], [null, null, null, null]])
  for (const amount of ['270.5', '12.5', '135.5', '100.0000']) assert.equal(JSON.stringify(noAmounts).includes(amount), false, amount)

  const noPartner = buildInvoice({ invoice: invoice({ customerName: null }), access: { amounts: true, partner: false } })
  assert.deepEqual(noPartner.printable, { ok: false, reason: 'amounts_hidden' })
  assert.deepEqual(noPartner.billTo, { name: null, code: null, contactName: null, email: null, telephone: null, address: null }, 'a customer record passed in is not used')
  for (const value of ['Bayside', 'BAYSIDE', 'Lee Park', 'Market St']) assert.equal(JSON.stringify(noPartner).includes(value), false, value)
  assert.deepEqual(buildInvoice({ access: {} }).printable, { ok: false, reason: 'amounts_hidden' }, 'no access answer is no access')
  assert.deepEqual(buildInvoice({ invoice: invoice({ status: 'approved' }), access: { amounts: false, partner: true } }).printable, { ok: false, reason: 'amounts_hidden' })
})

test('invoice: the letterhead and template print as set', () => {
  const document = buildInvoice({
    letterhead: { companyName: null, addressLines: ['12 Pier Road'], phone: '+1 510 555 0100', email: 'billing@harbor.example', taxId: '94-1234567' },
    template: { title: 'Tax Invoice', columns: { tax: true }, showPaymentSummary: true, paymentInstructions: 'Pay by ACH to the account on your vendor form.', termsText: 'Due in 30 days.', footerText: 'Thank you.' },
    documentLanguage: 'zh-CN',
  })
  assert.equal(document.seller.companyName, 'Harbor Goods LLC', 'no letterhead name prints the legal name')
  assert.deepEqual([document.title, document.paymentInstructions, document.termsText, document.footerText, document.documentLanguage], ['Tax Invoice', 'Pay by ACH to the account on your vendor form.', 'Due in 30 days.', 'Thank you.', 'zh-CN'])
  assert.equal(buildInvoice({ documentLanguage: 'fr-FR' }).documentLanguage, 'en-US')
})

// The route: the document is read through the detail's own read, with the
// same id and request context, then the rest in the signed-in workspace.
function financeCall(path, { customerInvoiceDetail, readCustomerInvoiceDocument }) {
  const sent = []
  const ctx = {
    req: { method: 'GET' }, res: {}, url: new URL(`http://local${path}`),
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true' },
    identity: { authenticated: true, tenantId: 'tenant-doc', userId: 'user-doc', role: 'manager' },
    operationalFinancePrisma: {},
    operationalFinanceReadService: {}, operationalFinanceCommandService: {}, operationalFinanceO2cCommandService: {},
    operationalFinanceO2cReadService: { customerInvoiceDetail },
    internalSettlementReadService: {}, internalSettlementCommandService: {},
    customerInvoiceDocumentReadService: { readCustomerInvoiceDocument },
    readBody: async () => ({}),
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  return handleOperationalFinanceRoute(ctx).then((handled) => ({ handled, ctx, ...sent.at(-1) }))
}

test('the invoice document route reads the invoice exactly as the detail route does', async () => {
  const reads = []
  const customerInvoiceDetail = async (id, context) => { reads.push({ id, context }); return invoice() }
  const detail = await financeCall('/api/finance/customer-invoices/CI%2F9', { customerInvoiceDetail })
  const document = await financeCall('/api/finance/customer-invoices/CI%2F9/document', {
    customerInvoiceDetail,
    readCustomerInvoiceDocument: async ({ tenantId, invoice: read }) => ({ tenantId, invoiceId: read.id }),
  })
  assert.equal(detail.status, 200)
  assert.deepEqual(reads.map((read) => read.id), ['CI/9', 'CI/9'])
  assert.equal(reads[0].context, detail.ctx, 'the detail gets the request context')
  assert.equal(reads[1].context, document.ctx, 'the document gets the request context, nothing else')
  assert.deepEqual([document.handled, document.status, document.payload], [true, 200, { document: { tenantId: 'tenant-doc', invoiceId: 'CI-9' } }])
})

test('the invoice document route answers the detail read\'s own refusal and reads nothing else', async () => {
  const { OperationalFinanceReadError } = await import('./operational-finance-read-service.mjs')
  const refuse = (status, code) => async () => { throw new OperationalFinanceReadError(code, code, status) }
  const never = async () => assert.fail('nothing else is read')
  const notFound = await financeCall('/api/finance/customer-invoices/OTHER-TENANT/document', { customerInvoiceDetail: refuse(404, 'CUSTOMER_INVOICE_NOT_FOUND'), readCustomerInvoiceDocument: never })
  assert.deepEqual([notFound.status, notFound.payload.code], [404, 'CUSTOMER_INVOICE_NOT_FOUND'])
  const denied = await financeCall('/api/finance/customer-invoices/CI-9/document', { customerInvoiceDetail: refuse(403, 'PERMISSION_DENIED'), readCustomerInvoiceDocument: never })
  assert.deepEqual([denied.status, denied.payload.code], [403, 'PERMISSION_DENIED'])
})

test('the invoice read service looks the customer up only when the customer may be seen, in the invoice\'s workspace', async () => {
  const calls = []
  const prisma = {
    tenant: { findUnique: async (args) => { calls.push(['tenant', args.where]); return { name: 'Harbor Goods', legalName: null, operationalSettings: { documents: { documentLanguage: 'zh-CN', customerInvoice: { paymentInstructions: 'Wire transfer only.', columns: { tax: true } } } } } } },
    runtimeRecord: { findMany: async (args) => { calls.push(['customer', args.where]); return [{ id: 'rr-other', recordKey: 'CUST-1', payload: { id: 'CUST-77', code: 'CUST-1', name: 'Code clash' } }, { ...customerRecord, payload: { ...customerRecord.payload, paymentTerms: 'NET45' } }] } },
    paymentTerm: { findMany: async (args) => { calls.push(['paymentTerm', args.where]); return [{ id: 'PT-45', code: 'NET45', name: 'Net 45 days' }] } },
  }
  const service = createCustomerInvoiceDocumentReadService({ prisma })
  const document = await service.readCustomerInvoiceDocument({ tenantId: 'tenant-doc', invoice: invoice() })
  assert.deepEqual(calls.map(([name, where]) => [name, where.tenantId ?? where.id]), [['tenant', 'tenant-doc'], ['customer', 'tenant-doc'], ['paymentTerm', 'tenant-doc']])
  assert.equal(document.paymentTerms, 'Net 45 days')
  assert.equal(calls[1][1].namespace, 'master-data.customers')
  assert.deepEqual([document.billTo.code, document.billTo.address, document.documentLanguage, document.paymentInstructions, document.columns.tax, document.seller.companyName], ['BAYSIDE', '9 Market St, Oakland', 'zh-CN', 'Wire transfer only.', true, 'Harbor Goods'], 'the customer\'s own id wins over a code that matches')
  assert.deepEqual(document.printable, { ok: true, reason: null })

  calls.length = 0
  const hidden = await service.readCustomerInvoiceDocument({
    tenantId: 'tenant-doc',
    invoice: invoice({ customerName: null, fieldVisibility: { ...invoice().fieldVisibility, customerName: visible(false) } }),
  })
  assert.deepEqual(calls.map(([name]) => name), ['tenant'], 'no customer lookup when the customer is hidden')
  assert.deepEqual(hidden.printable, { ok: false, reason: 'amounts_hidden' })
  assert.equal(hidden.billTo.name, null)

  assert.deepEqual(customerInvoiceDocumentAccess(invoice({ fieldVisibility: { totalAmount: visible(false), customerName: visible(true) } })), { amounts: false, partner: true })
  assert.deepEqual(customerInvoiceDocumentAccess({}), { amounts: false, partner: false })
  await assert.rejects(service.readCustomerInvoiceDocument({ tenantId: '', invoice: invoice() }), (error) => error.status === 403)
})

test('the invoice document page sends nothing and is read through the detail read', async () => {
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../../src/modules/business-documents/CustomerInvoiceDocumentPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /mailto:|sendMail|\/api\/[^"'`]*(mail|send|email)|method:\s*["'](POST|PUT|PATCH|DELETE)["']/i)
  assert.match(page, /\/api\/finance\/customer-invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/document/)
  const route = readFileSync(new URL('../routes/operational-finance.routes.mjs', import.meta.url), 'utf8')
  const handler = route.slice(route.indexOf('customerInvoiceDocument = '), route.indexOf('const customerInvoiceMatch'))
  assert.match(handler, /o2cRead\.customerInvoiceDetail\(/)
  assert.doesNotMatch(handler, /mail|transmi|ensureCapability/i)
})
