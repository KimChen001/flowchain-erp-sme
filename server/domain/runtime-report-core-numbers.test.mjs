import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { isCommittedPurchaseOrder } from './open-purchase-order.mjs'
import { analyticsCopy } from '../../src/modules/reports/analyticsCopy.ts'

const context = (extra = {}) => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [], purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [],
  itemSupplierRelationships: [], dataLimitations: [], ...extra,
})
const po = (id, status, totalAmount, extra = {}) => ({ id, status, totalAmount, currency: 'USD', createdAt: '2026-09-02T12:00:00.000Z', supplierName: 'Acme', lines: [], ...extra })
const invoice = (id, status, totalAmount, extra = {}) => ({ id, status, totalAmount, currency: 'USD', invoiceDate: '2026-09-03', supplierName: 'Acme', ...extra })
const kpi = (report, id) => report.kpis.find(item => item.id === id)

// The reviewer's case: 1000 of committed spend sat next to 129000 of drafts,
// pending approvals, rejections and cancellations, and the card showed 130000.
const reviewerOrders = [
  po('PO-APPROVED', 'approved', 400), po('PO-ISSUED', 'issued', 300),
  po('PO-PARTIAL', 'partially_received', 200), po('PO-RECEIVED', 'fully_received', 100),
  po('PO-DRAFT', 'draft', 50000), po('PO-PENDING', 'pending_approval', 40000),
  po('PO-CANCELLED', 'cancelled', 20000), po('PO-REJECTED', 'rejected', 19000),
]

test('purchase order amount counts only committed orders', () => {
  const report = buildRuntimeGovernedReport(context({ purchaseOrders: reviewerOrders }), { subject: 'overview' })
  const amount = kpi(report, 'purchase_order_amount')
  assert.equal(amount.currentValue, 1000)
  assert.equal(amount.dataStatus, 'complete')
  assert.deepEqual(report.dataScope.currencyAmounts.map(item => [item.currencyCode, item.amount]), [['USD', 1000]])
  // The detail table still lists every order in scope; only the amount is committed spend.
  assert.equal(report.totalRecords, 8)
})

test('committed purchase orders follow the shared status vocabulary and its aliases', () => {
  for (const status of ['approved', 'issued', 'partially_received', 'fully_received', 'open', 'completed', '已下发']) assert.equal(isCommittedPurchaseOrder({ status }), true, status)
  for (const status of ['draft', 'pending_approval', 'rejected', 'cancelled', '', 'unknown']) assert.equal(isCommittedPurchaseOrder({ status }), false, status)
})

test('supplier invoice amount counts only submitted, matched, approved or held invoices', () => {
  const supplierInvoices = [
    invoice('INV-SUBMITTED', 'submitted', 100), invoice('INV-MATCHING', 'matching', 50), invoice('INV-EXCEPTION', 'exception', 25),
    invoice('INV-MATCHED', 'matched', 200), invoice('INV-APPROVED', 'approved', 300), invoice('INV-HELD', 'held', 25),
    invoice('INV-DRAFT', 'draft', 5000), invoice('INV-REJECTED', 'rejected', 7000), invoice('INV-CANCELLED', 'cancelled', 9000),
  ]
  const report = buildRuntimeGovernedReport(context({ supplierInvoices }), { subject: 'finance' })
  assert.equal(kpi(report, 'invoice_amount').currentValue, 700)
  assert.deepEqual(report.dataScope.currencyAmounts.map(item => [item.currencyCode, item.amount]), [['USD', 700]])
})

test('a committed document without an amount makes the total incomplete instead of counting it as zero', () => {
  const purchaseOrders = [po('PO-A', 'issued', 400), po('PO-B', 'approved', null), po('PO-DRAFT', 'draft', null)]
  const amount = kpi(buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'procurement' }), 'purchase_order_amount')
  assert.equal(amount.currentValue, null)
  assert.equal(amount.dataStatus, 'incomplete')
  assert.ok(amount.limitations.includes('amount_missing'))

  // A draft without an amount is not committed spend, so it does not block the total.
  const complete = kpi(buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-A', 'issued', 400), po('PO-DRAFT', 'draft', null)] }), { subject: 'procurement' }), 'purchase_order_amount')
  assert.equal(complete.currentValue, 400)
  assert.equal(complete.dataStatus, 'complete')

  const invoices = kpi(buildRuntimeGovernedReport(context({ supplierInvoices: [invoice('INV-A', 'approved', 120), invoice('INV-B', 'submitted', '')] }), { subject: 'finance' }), 'invoice_amount')
  assert.equal(invoices.currentValue, null)
  assert.equal(invoices.dataStatus, 'incomplete')
})

test('an explicit zero amount is a known value, not missing data', () => {
  const amount = kpi(buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-A', 'issued', 0), po('PO-B', 'approved', '250.50')] }), { subject: 'procurement' }), 'purchase_order_amount')
  assert.equal(amount.currentValue, 250.5)
  assert.equal(amount.dataStatus, 'complete')
})

test('metric definitions describe committed amounts', () => {
  const report = buildRuntimeGovernedReport(context({ purchaseOrders: reviewerOrders }), { subject: 'overview' })
  assert.match(kpi(report, 'purchase_order_amount').description, /已批准、已下达、部分收货或全部收货/)
  const finance = buildRuntimeGovernedReport(context(), { subject: 'finance' })
  assert.match(kpi(finance, 'invoice_amount').description, /不含草稿、驳回和取消/)
  for (const description of [kpi(report, 'purchase_order_amount').description, kpi(finance, 'invoice_amount').description]) {
    const english = analyticsCopy(description, 'en-US')
    assert.doesNotMatch(english, /[㐀-鿿]/)
    assert.match(english, /Drafts/)
    assert.equal(analyticsCopy(english, 'zh-CN'), description)
  }
  assert.doesNotMatch(analyticsCopy('部分已承诺单据缺少金额，因此不显示合计。', 'en-US'), /[㐀-鿿]/)
})

test('a missing committed amount is reported as a data-scope limitation', () => {
  const report = buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-A', 'issued', null)] }), { subject: 'overview' })
  assert.ok(report.limitations.includes('amount_missing'))
  assert.ok(!buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-A', 'issued', 5)] }), { subject: 'overview' }).limitations.includes('amount_missing'))
})
