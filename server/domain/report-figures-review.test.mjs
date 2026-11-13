import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { partialMonths } from './report-dashboard-visuals.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { createDbSalesOrderReadRepository } from '../repositories/db-sales-order-read-repository.mjs'
import { buildHomeOverview } from '../services/business-read-context-service.mjs'
import { handleReportsAnalyticsRoute } from '../routes/reports-analytics.routes.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { permissionCodes } from '../auth/permission-catalog.mjs'

// Figures the 2026-11-10 screenshot review found wrong or misleading: sales
// figures over only the latest 500 orders, the lifecycle's last stage, the
// current month drawn as a whole month, notes and truncation notices on pages
// they do not concern, the detail table order and the overdue supplier chart.

const context = (overrides = {}) => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [], purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [],
  itemSupplierRelationships: [], dataLimitations: [], truncatedSubjects: [], ...overrides,
})
const kpi = (report, id) => report.kpis.find(item => item.id === id)
const chart = (report, id) => report.charts.find(item => item.id === id)
const now = new Date('2026-11-10T12:00:00Z')

// The two latest orders, as the read context returns them (newest first).
const order = (id, day, customer, amount) => ({ id, salesOrderId: id, orderNumber: id, workflowStatus: 'confirmed', status: 'fulfilled', customerName: customer, currency: 'GBP', createdAt: `${day}T10:00:00.000Z`, totalAmount: amount, reservedQty: 0, lines: [{ sku: 'A', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 1 }] })
const latest = [order('SO-0003', '2026-11-06', 'Customer 2', 30), order('SO-0002', '2026-10-20', 'Customer 1', 20)]
// The database's totals over every order: 1,000 orders back to 2025-11.
const groups = [
  { date: '2025-11-08', currency: 'GBP', customer: 'Customer 1', status: 'fulfilled', count: 600, amount: 6000, reserved: false, shipped: true, shippedInFull: true },
  { date: '2026-10-20', currency: 'GBP', customer: 'Customer 1', status: 'fulfilled', count: 1, amount: 20, reserved: false, shipped: true, shippedInFull: true },
  { date: '2026-11-06', currency: 'GBP', customer: 'Customer 2', status: 'fulfilled', count: 399, amount: 3990, reserved: false, shipped: true, shippedInFull: true },
]
const truncatedSales = { subject: 'sales_orders', limit: 2, openDemandComplete: true }

test('sales figures count every order from the database totals while the table lists the orders read', () => {
  const data = context({ salesOrders: latest, salesOrderGroups: groups, truncatedSubjects: [truncatedSales, { subject: 'customers', limit: 200 }] })
  const report = buildRuntimeGovernedReport(data, { subject: 'sales' }, { now, timeZone: 'Europe/London' })
  assert.equal(kpi(report, 'sales_order_count').currentValue, 1000)
  assert.equal(kpi(report, 'sales_order_amount').currentValue, 10010)
  assert.deepEqual(kpi(report, 'sales_order_amount').currencyAmounts.map(row => [row.currencyCode, row.amount, row.recordCount]), [['GBP', 10010, 1000]])
  assert.equal(kpi(report, 'order_fulfillment_rate').currentValue, 100)
  assert.deepEqual(chart(report, 'sales_order_trend').data.map(row => [row.name, row['Sales orders'], row['Order amount']]), [['2025-11', 600, 6000], ['2026-10', 1, 20], ['2026-11', 399, 3990]])
  assert.deepEqual(chart(report, 'sales_customer_pareto').data.map(row => [row.name, row.value]), [['Customer 1', 6020], ['Customer 2', 3990]])
  assert.equal(chart(report, 'sales_customer_pareto').measures[0].label, 'Order amount')
  assert.deepEqual(chart(report, 'sales_order_status').data.map(row => [row.name, row.value]), [['fulfilled', 1000]])
  assert.deepEqual(chart(report, 'sales_fulfillment').data.map(row => row.value), [1000, 1000, 1000, 1000])
  // The table lists the orders read, newest first, and says how many there are.
  assert.deepEqual(report.details.map(row => row.id), ['SO-0003', 'SO-0002'])
  assert.equal(report.totalRecords, 1000)
  // The notice says the figures are whole and only the table is cut; the
  // customer list cut changes no figure, so it is not named.
  assert.deepEqual(report.truncatedSubjects, [{ subject: 'sales_orders', limit: 2, figuresComplete: true, openDemandComplete: true, total: 1000 }])
  // Filters still apply to the totals.
  const filtered = buildRuntimeGovernedReport(data, { subject: 'sales', filters: { from: '2026-10-01', customer: 'Customer 2' } }, { now, timeZone: 'Europe/London' })
  assert.equal(kpi(filtered, 'sales_order_count').currentValue, 399)
  // The customer filter offers every customer on an order.
  assert.deepEqual(report.dataScope.filterOptions.customers, ['Customer 1', 'Customer 2'])
})

test('without the database totals, sales figures count the orders read and the notice says they are cut', () => {
  const report = buildRuntimeGovernedReport(context({ salesOrders: latest, truncatedSubjects: [truncatedSales] }), { subject: 'sales' }, { now, timeZone: 'Europe/London' })
  assert.equal(kpi(report, 'sales_order_count').currentValue, 2)
  assert.equal(kpi(report, 'sales_order_amount').currentValue, 50)
  assert.deepEqual(report.truncatedSubjects, [{ subject: 'sales_orders', limit: 2 }])
})

test('the overview counts every sales order by month, and needs no sales note when the totals are whole', () => {
  const report = buildRuntimeGovernedReport(context({ salesOrders: latest, salesOrderGroups: groups, truncatedSubjects: [truncatedSales, { subject: 'purchase_orders', limit: 500 }] }), { subject: 'overview' }, { now, timeZone: 'Europe/London' })
  assert.equal(kpi(report, 'sales_order_count').currentValue, 1000)
  assert.deepEqual(chart(report, 'overview_activity').data.map(row => [row.name, row['Sales orders']]), [['2025-11', 600], ['2026-10', 1], ['2026-11', 399]])
  assert.deepEqual(report.truncatedSubjects, [{ subject: 'purchase_orders', limit: 500 }])
})

test('a cut-off subject is named only on the dashboards whose figures read it', () => {
  const cut = ['purchase_orders', 'receipts', 'supplier_invoices', 'sales_orders', 'purchase_requests', 'rfqs', 'suppliers', 'items', 'customers', 'inventory_items'].map(subject => ({ subject, limit: 500 }))
  const named = subject => buildRuntimeGovernedReport(context({ truncatedSubjects: cut }), { subject }, { now }).truncatedSubjects.map(entry => entry.subject).sort()
  assert.deepEqual(named('finance'), ['supplier_invoices'])
  assert.deepEqual(named('sales'), ['sales_orders'])
  assert.deepEqual(named('procurement'), ['purchase_orders', 'receipts', 'supplier_invoices'])
  assert.deepEqual(named('suppliers'), ['purchase_orders', 'receipts', 'supplier_invoices', 'suppliers'])
  assert.deepEqual(named('inventory'), ['inventory_items', 'items', 'purchase_orders', 'sales_orders'])
  for (const subject of ['overview', 'procurement', 'sales', 'inventory', 'finance', 'suppliers']) {
    assert.ok(!named(subject).includes('customers'), subject)
    assert.ok(!named(subject).includes('rfqs'), subject)
  }
})

test('the invoice note shows only on the invoice dashboard', () => {
  const data = context({ dataLimitations: ['invoice_runtime_has_no_records', 'receipt_runtime_has_no_records'] })
  const notes = subject => buildRuntimeGovernedReport(data, { subject }, { now }).limitations
  assert.ok(notes('finance').includes('invoice_runtime_has_no_records'))
  for (const subject of ['overview', 'procurement', 'sales', 'inventory', 'suppliers']) assert.ok(!notes(subject).includes('invoice_runtime_has_no_records'), subject)
  assert.ok(notes('procurement').includes('receipt_runtime_has_no_records'))
  assert.ok(!notes('sales').includes('receipt_runtime_has_no_records'))
})

test('invoice analytics with no invoices says there are no records, not to pick a currency', () => {
  const report = buildRuntimeGovernedReport(context({ purchaseOrders: [{ id: 'PO-1', status: 'issued', currency: 'USD', totalAmount: 5, createdAt: '2026-11-02T00:00:00Z', lines: [] }] }), { subject: 'finance' }, { now })
  assert.equal(report.totalRecords, 0)
  assert.equal(chart(report, 'finance_variance_by_supplier').emptyState, 'No records in the selected range.')
})

test('the month of today and months a range cuts short are partial', () => {
  assert.deepEqual([...partialMonths({ today: '2026-11-10' })], [['2026-11', 'to_date']])
  assert.deepEqual([...partialMonths({ today: '2026-11-10', from: '2026-08-15', to: '2026-10-20' })], [['2026-08', 'range'], ['2026-10', 'range']])
  assert.deepEqual([...partialMonths({ today: '2026-11-10', from: '2026-08-01', to: '2026-10-31' })], [])
  assert.deepEqual([...partialMonths({ today: '2026-11-10', from: '2026-11-01', to: '2026-11-30' })], [['2026-11', 'to_date']])
})

test('the running month is marked on monthly charts and left out of KPI sparklines', () => {
  const po = (id, day, amount) => ({ id, supplierName: 'Acme', status: 'issued', currency: 'USD', totalAmount: amount, createdAt: `${day}T12:00:00.000Z`, expectedDate: '2026-12-01', lines: [{ sku: 'A', unit: 'pcs', orderedQuantity: 1, receivedQuantity: 0, unitPrice: amount, amount }] })
  const data = context({ purchaseOrders: [po('PO-1', '2026-09-10', 100), po('PO-2', '2026-10-10', 120), po('PO-3', '2026-11-03', 15)] })
  const report = buildRuntimeGovernedReport(data, { subject: 'procurement' }, { now, timeZone: 'UTC' })
  assert.deepEqual(chart(report, 'procurement_spend_trend').partialPeriods, [{ period: '2026-11', reason: 'to_date' }])
  assert.deepEqual(kpi(report, 'purchase_order_amount').trend, [{ period: '2026-09', value: 100 }, { period: '2026-10', value: 120 }])
  const overview = buildRuntimeGovernedReport(data, { subject: 'overview' }, { now, timeZone: 'UTC' })
  assert.deepEqual(chart(overview, 'overview_spend_trend').partialPeriods, [{ period: '2026-11', reason: 'to_date' }])
  assert.deepEqual(chart(overview, 'overview_activity').partialPeriods, [{ period: '2026-11', reason: 'to_date' }])
  // A past range ending on a month's last day has no partial month.
  const past = buildRuntimeGovernedReport(data, { subject: 'procurement', filters: { from: '2026-09-01', to: '2026-10-31' } }, { now, timeZone: 'UTC' })
  assert.deepEqual(chart(past, 'procurement_spend_trend').partialPeriods, [])
})

test('purchase order details list the newest business date first, not the last edit', () => {
  // Read in last-updated order: the oldest order was edited last.
  const po = (id, day) => ({ id, number: id, supplierName: 'Acme', status: 'issued', currency: 'USD', totalAmount: 1, createdAt: `${day}T12:00:00.000Z`, lines: [] })
  const data = context({ purchaseOrders: [po('PO-OLD', '2026-03-01'), po('PO-UNDATED', ''), po('PO-NEW', '2026-11-02'), po('PO-MID', '2026-07-15')] })
  const report = buildRuntimeGovernedReport(data, { subject: 'procurement' }, { now })
  assert.deepEqual(report.details.map(row => row.id), ['PO-NEW', 'PO-MID', 'PO-OLD', 'PO-UNDATED'])
  assert.deepEqual(report.exportRows.map(row => row.id), ['PO-NEW', 'PO-MID', 'PO-OLD', 'PO-UNDATED'])
})

test('the overdue supplier chart shows five suppliers and says what the rest hold', () => {
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((supplier, index) => ({ id: `PO-${supplier}`, supplierName: `Supplier ${supplier}`, createdAt: '2026-09-01', expectedDate: '2026-09-09', status: 'issued', currency: 'USD', totalAmount: 10, lines: [{ quantity: 10, receivedQuantity: 0, unit: 'pcs' }, ...(index === 6 ? [{ quantity: 1, receivedQuantity: 0, unit: 'pcs' }] : [])] }))
  rows.push({ ...rows[0], id: 'PO-A2' })
  const result = buildOpenPurchaseOrdersReport(rows, {}, new Date('2026-09-11T10:00:00Z'))
  assert.equal(result.summary.overdue, 8)
  assert.equal(result.overdueSuppliers.length, 5)
  assert.equal(result.overdueSuppliers[0].supplier, 'Supplier A')
  assert.equal(result.overdueSupplierTotal, 7)
  assert.equal(result.overdueOrdersNotShown, 2)
  assert.equal(result.overdueSuppliers.reduce((total, row) => total + row.count, 0) + result.overdueOrdersNotShown, result.summary.overdue)
  // An order of several lines says how many are still to receive.
  const multi = result.rows.find(row => row.id === 'PO-G')
  assert.deepEqual([multi.openLines, multi.lineCount], [2, 2])
})

test('summarizeOrdersForReport groups every order in the database by day, currency, customer and status', async () => {
  let query = null
  const prisma = { $queryRaw: async (strings, ...values) => { query = { sql: strings.join('?'), values }; return [
    { day: '2026-11-06', currency: 'GBP', customer: 'Customer 2', status: 'fulfilled', reserved: false, shipped: true, shipped_in_full: true, amount_missing: false, orders: 399, amount: '3990.1250' },
    { day: '2026-11-06', currency: 'GBP', customer: '', status: 'fulfilled', reserved: false, shipped: true, shipped_in_full: true, amount_missing: true, orders: 2, amount: null },
  ] } }
  const repository = createDbSalesOrderReadRepository({ env: { DATABASE_URL: 'postgresql://flowchain:test@127.0.0.1:5432/flowchain_test' }, prisma })
  const rows = await repository.summarizeOrdersForReport({ tenantId: 'tenant-a', timeZone: 'Europe/London' })
  assert.deepEqual(query.values, ['tenant-a', 'Europe/London', 'tenant-a'])
  assert.match(query.sql, /AT TIME ZONE/)
  assert.match(query.sql, /GROUP BY day, currency, customer, status/)
  assert.deepEqual(rows, [
    { date: '2026-11-06', currency: 'GBP', customer: 'Customer 2', status: 'fulfilled', count: 399, amount: 3990.125, reserved: false, shipped: true, shippedInFull: true },
    { date: '2026-11-06', currency: 'GBP', customer: '未命名客户', status: 'fulfilled', count: 2, amount: null, reserved: false, shipped: true, shippedInFull: true },
  ])
  await assert.rejects(() => repository.summarizeOrdersForReport({}), { code: 'TENANT_CONTEXT_REQUIRED' })
})

test('the sales dashboard route reads the database totals only when the sales orders were cut off', async () => {
  const fullReportAccess = reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-a', permissionCodes: new Set(permissionCodes) })
  const run = async ({ truncated, subject = 'sales' }) => {
    let summaries = 0
    let response = null
    const repositories = {
      salesOrders: {
        listOrders: async ({ onTruncated }) => { if (truncated) onTruncated({ subject: 'sales_orders', limit: 2 }); return latest },
        countOrdersWithOpenDemand: async () => 0,
        summarizeOrdersForReport: async ({ tenantId, timeZone }) => { summaries += 1; assert.deepEqual([tenantId, timeZone], ['tenant-a', 'Europe/London']); return groups },
      },
      procurementRuntime: { snapshot: async () => ({}) },
    }
    await handleReportsAnalyticsRoute({ req: { method: 'POST' }, res: {}, url: new URL('http://localhost/api/reports/query'), identity: { tenantId: 'tenant-a' }, tenantTimezone: 'Europe/London', reportNow: now, reportReadAccess: fullReportAccess, repositories, readBody: async () => ({ subject, filters: {} }), send: (_res, status, payload) => { response = { status, payload } } })
    return { summaries, response }
  }
  const cut = await run({ truncated: true })
  assert.equal(cut.response.status, 200)
  assert.equal(cut.summaries, 1)
  assert.equal(kpi(cut.response.payload, 'sales_order_count').currentValue, 1000)
  const whole = await run({ truncated: false })
  assert.equal(whole.summaries, 0)
  assert.equal(kpi(whole.response.payload, 'sales_order_count').currentValue, 2)
  const finance = await run({ truncated: true, subject: 'finance' })
  assert.equal(finance.summaries, 0)
})

test('Today shows a shipped sales order with the status the sales report shows', () => {
  const sales = (id, workflowStatus, status, fulfillmentStatus) => ({ id, orderNumber: id, workflowStatus, status, fulfillmentStatus, customerName: 'Northwind', currency: 'USD', totalAmount: 10, updatedAt: '2026-11-06T10:00:00Z' })
  const overview = buildHomeOverview(context({ salesOrders: [
    sales('SO-SHIPPED', 'confirmed', 'fulfilled', 'fully_fulfilled'),
    sales('SO-PART', 'confirmed', 'partially_fulfilled', 'partially_fulfilled'),
    sales('SO-OPEN', 'confirmed', 'shortage_risk', 'not_fulfilled'),
    sales('SO-GONE', 'cancelled', 'cancelled', 'not_fulfilled'),
  ] }), { now })
  const status = Object.fromEntries(overview.recentDocuments.map(row => [row.id, row.status]))
  assert.deepEqual(status, { 'SO-SHIPPED': 'fully_fulfilled', 'SO-PART': 'partially_fulfilled', 'SO-OPEN': 'confirmed', 'SO-GONE': 'cancelled' })
})

test('a key finding says when suppliers tie for the highest or lowest on-time share', async () => {
  const { reportInsights } = await import('../../src/modules/reports/reportInsights.ts')
  const format = (value, unit) => unit === 'percentage' ? `${value}%` : String(value)
  const report = (data, total = data.length) => ({ kpis: [], dataScope: { currencyCode: null }, truncatedSubjects: [], charts: [{ id: 'supplier_on_time', type: 'horizontal_bar', title: 'On-time deliveries by supplier', drilldownPath: '/app/procurement/receiving', data, total }] })
  const spread = (data, total, language = 'en-US') => reportInsights('suppliers', report(data, total), { language, format, category: (_chart, name) => name }).find(item => item.id === 'spread')
  const row = (name, value) => ({ name, value })
  const fiveTie = ['Foods 1', 'Foods 2', 'Foods 3', 'Hobbies 1', 'Hobbies 2'].map(name => row(name, 92.3))
  assert.equal(spread([...fiveTie, row('Household 1', 80)]).text, '5 suppliers tie for the highest share of deliveries on time (92.3%); Household 1 the lowest (80%).')
  assert.equal(spread([row('Acme', 95), ...fiveTie.slice(0, 2)]).text, 'Acme has the highest share of deliveries on time (95%); 2 suppliers tie for the lowest (92.3%).')
  assert.equal(spread([row('Acme', 95), row('Bolt', 70)], 2, 'zh-CN').text, 'Acme 的准时交付占比最高（95%），Bolt 最低（70%）。')
  // Every supplier at one share: no highest or lowest.
  assert.equal(spread(fiveTie), undefined)
  // The ranking kept its first rows only: its last bar is not the lowest.
  assert.equal(spread([row('Acme', 95), row('Bolt', 90)], 14).text, 'Acme has the highest share of deliveries on time (95%).')
})

test('the last-month finding skips the month to date, and customer shares wait for whole sales figures', async () => {
  const { reportInsights } = await import('../../src/modules/reports/reportInsights.ts')
  const format = (value, unit) => unit === 'currency' ? `$${value}` : unit === 'percentage' ? `${value}%` : String(value)
  const overview = { kpis: [], dataScope: { currencyCode: 'USD' }, truncatedSubjects: [], charts: [{ id: 'overview_spend_trend', type: 'combo', unit: 'currency', currencyCode: 'USD', title: '', drilldownPath: '/x', data: [{ name: '2026-10', 'Committed amount': 4000, 'Purchase orders': 21 }, { name: '2026-11', 'Committed amount': 900, 'Purchase orders': 7 }], partialPeriods: [{ period: '2026-11', reason: 'to_date' }] }] }
  const last = reportInsights('overview', overview, { language: 'en-US', format, category: (_chart, name) => name }).find(item => item.id === 'overview_last_month')
  assert.equal(last.text, '2026-10: $4000 committed across 21 purchase orders.')
  const pareto = { id: 'sales_customer_pareto', type: 'pareto', unit: 'currency', title: '', drilldownPath: '/x', data: [{ name: 'Customer 14096', value: 10, filterValue: 'Customer 14096', 'Cumulative share': 11.1 }] }
  const sales = (truncatedSubjects) => reportInsights('sales', { kpis: [], dataScope: { currencyCode: 'GBP' }, truncatedSubjects, charts: [pareto] }, { language: 'en-US', format, category: (_chart, name) => name }).map(item => item.id)
  assert.deepEqual(sales([{ subject: 'sales_orders', limit: 500 }]), [])
  assert.deepEqual(sales([{ subject: 'sales_orders', limit: 500, figuresComplete: true, total: 3548 }]), ['sales_customer_pareto'])
})

test('a partner name that already says what it is is not prefixed again on Today', async () => {
  const { nameSaysRole } = await import('../../src/modules/overview/partnerName.ts')
  assert.equal(nameSaysRole('customer', 'Customer 18236 (United Kingdom)'), true)
  assert.equal(nameSaysRole('customer', '客户 18236'), true)
  assert.equal(nameSaysRole('supplier', 'Foods 1 vendor (assumed)'), true)
  assert.equal(nameSaysRole('supplier', 'Supplier 7'), true)
  assert.equal(nameSaysRole('supplier', 'Acme Components'), false)
  assert.equal(nameSaysRole('customer', 'Northwind'), false)
  // A vendor word only names a supplier.
  assert.equal(nameSaysRole('customer', 'Vendor Supply Co'), false)
})
