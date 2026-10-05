import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { isCommittedPurchaseOrder } from './open-purchase-order.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { analyticsCopy } from '../../src/modules/reports/analyticsCopy.ts'
import { reportWorkbook } from '../../src/modules/reports/reportWorkbook.ts'

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

test('different currencies are never added together', () => {
  const purchaseOrders = [po('PO-USD-1', 'issued', 600), po('PO-USD-2', 'approved', 400), po('PO-EUR', 'issued', 500, { currency: 'EUR' })]
  const report = buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'overview' })
  const amount = kpi(report, 'purchase_order_amount')
  assert.equal(amount.currentValue, null)
  assert.equal(amount.currencyAggregationStatus, 'multi_currency_unconverted')
  assert.deepEqual(amount.currencyAmounts.map(item => [item.currencyCode, item.amount]), [['EUR', 500], ['USD', 1000]])
  assert.ok(report.limitations.includes('multi_currency_unconverted'))
  const usd = kpi(buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'overview', filters: { currency: 'USD' } }), 'purchase_order_amount')
  assert.equal(usd.currentValue, 1000)
  assert.equal(usd.currencyCode, 'USD')
})

test('each money metric takes its currency from its own rows, not from the dashboard subject', () => {
  // A sales dashboard in USD showing a purchase order amount that is all EUR.
  const sales = buildRuntimeGovernedReport(context({
    salesOrders: [{ id: 'SO-1', orderedQty: 1, fulfilledQty: 0, currency: 'USD', totalAmount: 90, status: 'confirmed' }],
    purchaseOrders: [po('PO-EUR', 'issued', 300, { currency: 'EUR' })],
  }), { subject: 'sales', measures: ['sales_order_count', 'purchase_order_amount'] })
  assert.equal(sales.dataScope.currencyCode, 'USD')
  const eur = kpi(sales, 'purchase_order_amount')
  assert.equal(eur.currencyCode, 'EUR')
  assert.equal(eur.currencyAggregationStatus, 'single_currency')
  assert.equal(eur.currentValue, 300)

  // An overview whose purchase orders are all USD must not label a USD + EUR
  // invoice total as USD.
  const overview = buildRuntimeGovernedReport(context({
    purchaseOrders: [po('PO-USD', 'issued', 1000)],
    supplierInvoices: [invoice('INV-USD', 'approved', 100), invoice('INV-EUR', 'approved', 200, { currency: 'EUR' })],
  }), { subject: 'overview', measures: ['purchase_order_amount', 'invoice_amount'] })
  assert.equal(overview.dataScope.currencyCode, 'USD')
  assert.equal(kpi(overview, 'purchase_order_amount').currentValue, 1000)
  const invoices = kpi(overview, 'invoice_amount')
  assert.equal(invoices.currentValue, null)
  assert.equal(invoices.currencyCode, null)
  assert.equal(invoices.currencyAggregationStatus, 'multi_currency_unconverted')
  assert.ok(overview.limitations.includes('multi_currency_unconverted'))
})

test('missing and invalid currency codes form their own group and block the total', () => {
  const purchaseOrders = [po('PO-USD', 'issued', 100), po('PO-BLANK', 'issued', 50, { currency: '' }), po('PO-BAD', 'approved', 25, { currency: 'US$' })]
  const report = buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'procurement' })
  const amount = kpi(report, 'purchase_order_amount')
  assert.equal(amount.currentValue, null)
  assert.equal(amount.dataStatus, 'incomplete')
  assert.equal(amount.currencyCode, null)
  assert.equal(amount.currencyAggregationStatus, 'currency_unknown')
  assert.deepEqual(amount.currencyAmounts.map(item => [item.currencyCode, item.amount]), [['USD', 100], [null, 75]])
  assert.ok(amount.limitations.includes('currency_missing_or_invalid'))
  assert.ok(report.limitations.includes('currency_missing_or_invalid'))
  assert.equal(report.dataScope.currencyAggregationStatus, 'currency_unknown')
  // Only unknown codes: still no total, and no guessed currency.
  const blank = buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-BLANK', 'issued', 50, { currency: '' })] }), { subject: 'procurement' })
  assert.equal(kpi(blank, 'purchase_order_amount').currentValue, null)
  assert.equal(blank.dataScope.currencyCode, null)
  assert.doesNotMatch(JSON.stringify(blank.dataScope), /CNY|人民币/)
})

test('workbook metric summary formats each money metric in its own currency', () => {
  const report = buildRuntimeGovernedReport(context({
    salesOrders: [{ id: 'SO-1', orderedQty: 1, fulfilledQty: 0, currency: 'USD', totalAmount: 90, status: 'confirmed' }],
    purchaseOrders: [po('PO-EUR', 'issued', 300, { currency: 'EUR' })],
  }), { subject: 'sales', measures: ['sales_order_count', 'purchase_order_amount'] })
  const copy = value => analyticsCopy(value, 'en-US')
  const summary = reportWorkbook(report, {}, copy, [], { locale: 'en-US', language: 'en-US' })[0].rows
  const row = summary.find(item => item.Metric === 'Committed PO amount')
  assert.match(String(row['Current value']), /€300/)
  assert.equal(row['Currency code'], 'EUR')
})

test('workbook metric summary reads each KPI as the dashboard shows it', () => {
  const copy = value => analyticsCopy(value, 'en-US')
  const valueOf = (salesOrders, language = 'en-US') => {
    const report = buildRuntimeGovernedReport(context({ salesOrders }), { subject: 'sales', measures: ['open_sales_demand'] })
    const tr = value => analyticsCopy(value, language)
    return reportWorkbook(report, {}, tr, [], { locale: language, language })[0].rows[0][tr('Current value')]
  }
  const order = (id, lines) => ({ id, status: 'confirmed', currency: 'USD', totalAmount: 10, lines })
  // One SKU in one unit: the total carries its unit, as on the KPI card.
  assert.equal(valueOf([order('SO-1', [{ sku: 'A', unit: 'pcs', orderedQuantity: 14, fulfilledQuantity: 0 }])]), '14 pcs')
  // Two units, or two SKUs: no total, and the reason instead of a blank.
  assert.equal(valueOf([order('SO-2', [{ sku: 'A', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 0 }, { sku: 'B', unit: 'ft', orderedQuantity: 5, fulfilledQuantity: 0 }])]), copy('Mixed units'))
  assert.equal(valueOf([order('SO-3', [{ sku: 'A', unit: 'pcs', orderedQuantity: 9, fulfilledQuantity: 0 }, { sku: 'B', unit: 'pcs', orderedQuantity: 5, fulfilledQuantity: 0 }])]), 'Multiple SKUs')
  assert.equal(valueOf([order('SO-4', [{ sku: 'A', unit: 'pcs', orderedQuantity: 9, fulfilledQuantity: 0 }, { sku: 'B', unit: 'pcs', orderedQuantity: 5, fulfilledQuantity: 0 }])], 'zh-CN'), '多个 SKU')
  // Too few promised lines for an on-time rate.
  const line = id => ({ id, sku: 'A', unit: 'pcs', orderedQuantity: 1, receivedQuantity: 0, originalPromisedDate: '2026-09-10' })
  const onTime = buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-1', 'issued', 10, { lines: [line('L1'), line('L2')] })] }), { subject: 'procurement', measures: ['on_time_receipt_rate'] }, { now: new Date('2026-10-05T16:00:00.000Z') })
  assert.equal(reportWorkbook(onTime, {}, copy, [], { locale: 'en-US', language: 'en-US' })[0].rows[0]['Current value'], 'Fewer than 5 lines')
})

// Filters and business dates.
const filterContext = () => context({
  purchaseOrders: [
    po('PO-ACME-1', 'issued', 100, { supplierName: 'Acme' }), po('PO-ACME-2', 'approved', 200, { supplierName: 'Acme' }),
    po('PO-BETA', 'issued', 300, { supplierName: 'Beta' }),
  ],
  salesOrders: [
    { id: 'SO-NORTH', customerName: 'Northwind', sku: 'SKU-1', orderedQty: 8, fulfilledQty: 0, currency: 'USD', totalAmount: 80, status: 'confirmed', createdAt: '2026-09-04' },
    { id: 'SO-CONTOSO', customerName: 'Contoso', sku: 'SKU-1', orderedQty: 4, fulfilledQty: 0, currency: 'USD', totalAmount: 40, status: 'confirmed', createdAt: '2026-09-05' },
  ],
  inventoryItems: [{ sku: 'SKU-1', onHandQuantity: 5, reservedQuantity: 0 }],
  supplierInvoices: [invoice('INV-ACME', 'approved', 70, { supplierName: 'Acme' }), invoice('INV-BETA', 'approved', 30, { supplierName: 'Beta' })],
})

test('a supplier filter narrows supplier subjects and leaves sales orders and inventory alone', () => {
  const report = buildRuntimeGovernedReport(filterContext(), { subject: 'overview', filters: { supplier: 'Acme' } })
  assert.equal(kpi(report, 'purchase_order_amount').currentValue, 300)
  assert.equal(kpi(report, 'sales_order_count').currentValue, 2)
  assert.equal(kpi(report, 'inventory_risk_sku').currentValue, 1)
  assert.equal(report.attention.find(item => item.id === 'inventory_shortages').count, 1)
  assert.equal(report.attention.find(item => item.id === 'unfulfilled_sales').count, 2)
  const finance = buildRuntimeGovernedReport(filterContext(), { subject: 'finance', filters: { supplier: 'Acme' } })
  assert.equal(kpi(finance, 'invoice_amount').currentValue, 70)
})

test('a customer filter narrows sales orders and leaves purchase order amount alone', () => {
  const report = buildRuntimeGovernedReport(filterContext(), { subject: 'overview', filters: { customer: 'Northwind' } })
  assert.equal(kpi(report, 'purchase_order_amount').currentValue, 600)
  assert.equal(kpi(report, 'open_po_count').currentValue, 3)
  assert.equal(kpi(report, 'sales_order_count').currentValue, 1)
})

test('a status filter from the purchase order status chart does not zero out sales orders', () => {
  const report = buildRuntimeGovernedReport(filterContext(), { subject: 'overview', filters: { status: 'issued' } })
  assert.equal(kpi(report, 'purchase_order_amount').currentValue, 400)
  assert.equal(kpi(report, 'sales_order_count').currentValue, 2)
  const sales = buildRuntimeGovernedReport(filterContext(), { subject: 'sales', filters: { status: 'confirmed' } })
  assert.equal(kpi(sales, 'sales_order_count').currentValue, 2)
})

test('metrics list only the filters their subject can apply', () => {
  const report = buildRuntimeGovernedReport(filterContext(), { subject: 'overview' })
  assert.deepEqual(kpi(report, 'purchase_order_amount').applicableFilters, ['from', 'to', 'supplier', 'currency', 'status'])
  assert.deepEqual(kpi(report, 'sales_order_count').applicableFilters, ['from', 'to', 'customer', 'currency'])
  assert.deepEqual(kpi(report, 'inventory_risk_sku').applicableFilters, [])
})

test('purchase orders use the order date, then the creation date, never the last update', () => {
  const purchaseOrders = [
    po('PO-OLD-EDITED', 'issued', 100, { createdAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-09-20T09:00:00.000Z' }),
    po('PO-ORDER-DATE', 'issued', 200, { orderDate: '2026-09-03', createdAt: '2026-08-30T09:00:00.000Z' }),
    po('PO-SEPTEMBER', 'approved', 400, { createdAt: '2026-09-10T09:00:00.000Z' }),
  ]
  const september = buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'overview', filters: { from: '2026-09-01', to: '2026-09-30' } })
  assert.equal(kpi(september, 'purchase_order_amount').currentValue, 600)
  assert.deepEqual(september.details.map(row => row.id).sort(), ['PO-ORDER-DATE', 'PO-SEPTEMBER'])
  const all = buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'overview' })
  assert.deepEqual(all.charts[0].data.map(row => [row.name, row['Purchase orders']]), [['2026-08', 1], ['2026-09', 2]])
})

test('records without a business date are left out of date-filtered totals', () => {
  const purchaseOrders = [po('PO-DATED', 'issued', 100), po('PO-UNDATED', 'issued', 900, { createdAt: null })]
  const salesOrders = [{ id: 'SO-UNDATED', orderedQty: 1, fulfilledQty: 0, currency: 'USD', status: 'confirmed' }]
  const supplierInvoices = [invoice('INV-UNDATED', 'approved', 50, { invoiceDate: null })]
  const filters = { from: '2026-09-01', to: '2026-09-30' }
  const overview = buildRuntimeGovernedReport(context({ purchaseOrders, salesOrders }), { subject: 'overview', filters })
  assert.equal(kpi(overview, 'purchase_order_amount').currentValue, 100)
  assert.equal(kpi(overview, 'sales_order_count').currentValue, 0)
  assert.equal(overview.attention.find(item => item.id === 'open_orders').count, 1)
  assert.equal(kpi(buildRuntimeGovernedReport(context({ supplierInvoices }), { subject: 'finance', filters }), 'invoice_amount').currentValue, 0)
  // Without a date range the undated order still counts.
  assert.equal(kpi(buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'overview' }), 'purchase_order_amount').currentValue, 1000)
})

test('the overview and the open purchase orders report pick the same orders for a date range', () => {
  const lines = [{ quantity: 5, receivedQuantity: 0, unit: 'pcs' }]
  const purchaseOrders = [
    po('PO-OLD-EDITED', 'issued', 100, { createdAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-09-20T09:00:00.000Z', lines }),
    po('PO-ORDER-DATE', 'issued', 200, { orderDate: '2026-09-03', createdAt: '2026-08-30T09:00:00.000Z', lines }),
    po('PO-UNDATED', 'issued', 300, { createdAt: null, lines }),
  ]
  const filters = { from: '2026-09-01', to: '2026-09-30' }
  const overview = buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'overview', filters })
  const openReport = buildOpenPurchaseOrdersReport(purchaseOrders, filters, new Date('2026-09-29T12:00:00Z'))
  assert.deepEqual(openReport.rows.map(row => row.id), ['PO-ORDER-DATE'])
  assert.equal(openReport.rows[0].createdDate, '2026-09-03')
  assert.equal(overview.attention.find(item => item.id === 'open_orders').count, openReport.summary.open)
})

test('the activity chart explains the business date in both languages', () => {
  const english = "Activity uses each order's order date, falling back to its creation date. Counts are orders, not revenue."
  assert.equal(analyticsCopy(english, 'zh-CN'), '活动按订单日期统计，缺失时使用创建日期。数量表示订单数，并非收入。')
  assert.equal(analyticsCopy(analyticsCopy(english, 'zh-CN'), 'en-US'), english)
})

test('a sales order without an amount is missing, not zero', () => {
  const sales = (id, totalAmount) => ({ id, salesOrderId: id, workflowStatus: 'confirmed', status: 'confirmed', customerName: 'Northwind', currency: 'USD', orderDate: '2026-09-05', totalAmount, lines: [{ sku: 'A', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 0 }] })
  const report = buildRuntimeGovernedReport(context({ salesOrders: [sales('SO-1', 120), sales('SO-2', null)] }), { subject: 'sales' })
  assert.equal(kpi(report, 'sales_order_amount').currentValue, null)
  assert.equal(kpi(report, 'sales_order_amount').dataStatus, 'incomplete')
  assert.ok(kpi(report, 'sales_order_amount').limitations.includes('amount_missing'))
  assert.ok(report.limitations.includes('amount_missing'))
  assert.deepEqual(report.details.map(row => row.amount), [120, null])
})

test('a purchase order quantity is totalled only within one unit', () => {
  const lines = (...units) => units.map(unit => ({ sku: `SKU-${unit}`, orderedQuantity: 10, receivedQuantity: 0, unit }))
  const report = buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-PCS', 'issued', 1, { lines: lines('pcs', 'pcs') }), po('PO-MIXED', 'issued', 1, { lines: lines('pcs', 'ft') }), po('PO-NO-UNIT', 'issued', 1, { lines: lines('') })] }), { subject: 'procurement' })
  assert.deepEqual(report.details.map(row => [row.id, row.quantity, row.unit]), [['PO-PCS', 20, 'pcs'], ['PO-MIXED', null, 'mixed'], ['PO-NO-UNIT', null, '']])
  assert.ok(report.columnDefinitions.some(column => column.key === 'unit' && column.label === '单位'))
})
