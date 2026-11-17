import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { closedShortReceivedValue, isClosedShortPurchaseOrder } from './report-dashboard-visuals.mjs'

// Design audit B4, part 2: the report's supplier measures.

const asOf = { now: new Date('2026-10-05T12:00:00Z'), timeZone: 'America/New_York' }
const kpi = (report, id) => report.kpis.find((item) => item.id === id)
const chart = (report, id) => report.charts.find((item) => item.id === id)
const context = (overrides = {}) => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [], purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [],
  itemSupplierRelationships: [], dataLimitations: [], ...overrides,
})
const line = (sku, orderedQuantity, receivedQuantity, unitPrice = 10) => ({ id: `${sku}-L`, sku, itemName: sku, unit: 'pcs', orderedQuantity, receivedQuantity, unitPrice, amount: orderedQuantity * unitPrice })
const po = (id, status, lines, extra = {}) => ({ id, status, supplierId: 'SUP-A', supplierName: 'Acme', currency: 'USD', totalAmount: lines.reduce((sum, row) => sum + row.amount, 0), orderDate: '2026-09-10', lines, ...extra })

// L9-07: an order closed short after a partial receipt counted at its full
// amount, and the lifecycle called it "Fully received".
test('an order closed short counts what was received of it, and has its own lifecycle stage', () => {
  const closed = po('PO-CLOSED', 'closed', [line('A', 10, 4), line('B', 6, 0)])
  assert.equal(isClosedShortPurchaseOrder(closed), true)
  assert.equal(closedShortReceivedValue(closed), 40)
  // Without a line price, the line amount pro rata; without a quantity, unknown.
  assert.equal(closedShortReceivedValue({ lines: [{ orderedQuantity: 10, receivedQuantity: 4, amount: 250 }] }), 100)
  assert.equal(closedShortReceivedValue({ lines: [{ orderedQuantity: 10, receivedQuantity: null, unitPrice: 25 }] }), null)
  // Closed with everything received is not short.
  assert.equal(isClosedShortPurchaseOrder(po('PO-DONE', 'closed', [line('A', 10, 10)])), false)

  const data = context({ purchaseOrders: [closed, po('PO-FULL', 'fully_received', [line('C', 5, 5)]), po('PO-OPEN', 'issued', [line('D', 3, 0)])] })
  const report = buildRuntimeGovernedReport(data, { subject: 'procurement' }, asOf)
  // 40 received of PO-CLOSED, 50 and 30 of the others.
  assert.equal(kpi(report, 'purchase_order_amount').currentValue, 120)
  const stages = Object.fromEntries(chart(report, 'procurement_lifecycle').data.map((row) => [row.name, row.value]))
  assert.deepEqual([stages['Fully received'], stages['Closed short']], [1, 1])
  assert.match(kpi(report, 'purchase_order_amount').description, /部分到货后关闭的订单按已收金额计/)
  // With no order closed short the stage is not drawn.
  const none = buildRuntimeGovernedReport(context({ purchaseOrders: [po('PO-FULL', 'fully_received', [line('C', 5, 5)])] }), { subject: 'procurement' }, asOf)
  assert.equal(chart(none, 'procurement_lifecycle').data.some((row) => row.name === 'Closed short'), false)
})

// L9-15: the report grouped by the name on each order, so a supplier renamed
// since its first orders showed as two suppliers.
test('a renamed supplier is one row, under its current name, and one filter value', () => {
  const data = context({
    suppliers: [{ id: 'SUP-A', supplierCode: 'SUP-A', supplierName: 'Acme Components Ltd' }],
    purchaseOrders: [
      po('PO-OLD', 'issued', [line('A', 10, 0)], { supplierName: 'Acme', supplierSnapshot: { supplierName: 'Acme' } }),
      po('PO-NEW', 'issued', [line('B', 5, 0)], { supplierName: 'Acme Components Ltd', supplierSnapshot: { supplierName: 'Acme Components Ltd' } }),
      po('PO-OTHER', 'issued', [line('C', 2, 0)], { supplierId: 'SUP-B', supplierName: 'Bolt' }),
    ],
  })
  const report = buildRuntimeGovernedReport(data, { subject: 'procurement' }, asOf)
  const treemap = chart(report, 'procurement_spend_treemap')
  assert.deepEqual(treemap.data.map((row) => [row.name, row.value]).sort(), [['Acme Components Ltd', 150], ['Bolt', 20]])
  // The filter by the current name finds both orders.
  const filtered = buildRuntimeGovernedReport(data, { subject: 'procurement', filters: { supplier: 'Acme Components Ltd' } }, asOf)
  assert.equal(kpi(filtered, 'purchase_order_amount').currentValue, 150)
  assert.deepEqual(filtered.dataScope.filterOptions.suppliers.includes('Acme'), false)
  // A supplier the master does not hold keeps the name on its order.
  assert.ok(treemap.data.some((row) => row.name === 'Bolt'))
})

// L7-27: "3 suppliers tie for the most committed purchase orders: 52 each"
// said only that the orders came on a schedule.
test('suppliers tied for the most orders are no finding', async () => {
  const { reportInsights } = await import('../../src/modules/reports/reportInsights.ts')
  const findings = (data) => reportInsights('overview', buildRuntimeGovernedReport(data, { subject: 'overview' }, asOf), { language: 'en-US', format: (value) => String(value), category: (_chart, name) => name })
  const orders = (supplierId, supplierName, count) => Array.from({ length: count }, (_, index) => po(`${supplierId}-${index}`, 'issued', [line('A', 1, 0)], { supplierId, supplierName }))
  const tied = context({ purchaseOrders: [...orders('S1', 'Acme', 3), ...orders('S2', 'Bolt', 3), ...orders('S3', 'Cora', 1)] })
  assert.equal(findings(tied).some((item) => item.id === 'busiest_supplier'), false)
  const leader = context({ purchaseOrders: [...orders('S1', 'Acme', 4), ...orders('S2', 'Bolt', 3)] })
  assert.equal(findings(leader).find((item) => item.id === 'busiest_supplier').text, 'Acme has the most committed purchase orders: 4.')
})

// L7-28: "352 business records loaded" counted purchase orders only, beside
// sales figures from 3,548 sales orders.
test('the completeness line counts each source a dashboard reads', () => {
  const data = context({
    purchaseOrders: [po('PO-1', 'issued', [line('A', 1, 0)]), po('PO-2', 'issued', [line('A', 1, 0)])],
    salesOrderGroups: [{ date: '2026-09-11', customer: 'Northwind', currency: 'USD', status: 'confirmed', count: 7, amount: 700 }],
    supplierInvoices: [{ id: 'INV-1', invoiceNumber: 'INV-1', status: 'approved', currency: 'USD', totalAmount: 10, invoiceDate: '2026-09-15', supplierName: 'Acme' }],
    items: [{ id: 'I-A', sku: 'A', itemName: 'A' }],
    inventoryItems: [{ sku: 'A', itemId: 'I-A', onHandQuantity: 5, reservedQuantity: 0, unit: 'pcs' }],
  })
  const overview = buildRuntimeGovernedReport(data, { subject: 'overview' }, asOf)
  assert.deepEqual(overview.dataScope.recordCounts, { purchase_orders: 2, sales_orders: 7, supplier_invoices: 1, inventory_balances: 1 })
  assert.deepEqual(buildRuntimeGovernedReport(data, { subject: 'finance' }, asOf).dataScope.recordCounts, { supplier_invoices: 1 })
  // A source the reader may not read is not counted.
  const hidden = buildRuntimeGovernedReport({ ...data, restrictedSubjects: ['sales_orders'] }, { subject: 'overview' }, asOf)
  assert.equal('sales_orders' in hidden.dataScope.recordCounts, false)
})
