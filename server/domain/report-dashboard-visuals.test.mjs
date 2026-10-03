import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { invoiceMatchOutcome } from './report-dashboard-visuals.mjs'

const context = (overrides = {}) => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [], purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [],
  itemSupplierRelationships: [], dataLimitations: [], ...overrides,
})
const line = (sku, ordered, received, unitPrice) => ({ sku, itemName: `${sku} item`, orderedQuantity: ordered, receivedQuantity: received, unitPrice, amount: ordered * unitPrice })
const po = (id, supplierName, status, lines, extra = {}) => ({ id, supplierName, status, currency: 'USD', totalAmount: lines.reduce((sum, row) => sum + row.amount, 0), createdAt: '2026-09-02T12:00:00.000Z', expectedDate: '2026-09-20T00:00:00.000Z', lines, ...extra })
const receipt = (id, poId, supplierName, arrivedAt, rejectedQty = 0) => ({ id, poId, supplierName, status: 'received', arrivedAt, lines: [{ acceptedQty: 10, rejectedQty }] })
const invoice = (id, poId, supplierName, status, matchStatus, amount, extra = {}) => ({ id, invoiceNumber: id, poId, supplierName, status, matchStatus, totalAmount: amount, amount, currency: 'USD', invoiceDate: '2026-09-15T12:00:00.000Z', lines: [{ amount }], ...extra })
const chart = (report, id) => report.charts.find(item => item.id === id)
const kpi = (report, id) => report.kpis.find(item => item.id === id)

const procurementContext = () => context({
  purchaseOrders: [
    po('PO-1', 'Acme', 'fully_received', [line('A', 10, 10, 10)]),
    po('PO-2', 'Acme', 'partially_received', [line('A', 10, 4, 10), line('B', 5, 0, 20)]),
    po('PO-3', 'Bolt', 'issued', [line('C', 2, 0, 50)], { expectedDate: '2026-09-25T00:00:00.000Z' }),
    po('PO-DRAFT', 'Bolt', 'draft', [line('C', 100, 0, 50)]),
  ],
  receipts: [
    receipt('GRN-1', 'PO-1', 'Acme', '2026-09-18T15:00:00.000Z'),
    receipt('GRN-2', 'PO-2', 'Acme', '2026-09-22T15:00:00.000Z', 2),
  ],
  supplierInvoices: [
    invoice('INV-1', 'PO-1', 'Acme', 'matched', 'matched', 100),
    invoice('INV-DRAFT', 'PO-2', 'Acme', 'draft', 'pending', 999),
  ],
})

test('the purchase order lifecycle narrows stage by stage over committed orders only', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' })
  assert.deepEqual(chart(report, 'procurement_lifecycle').data, [
    { name: 'Committed', value: 3 },
    { name: 'Receiving started', value: 2 },
    { name: 'Fully received', value: 1 },
    { name: 'Invoiced', value: 1 },
    { name: 'Invoice matched', value: 1 },
  ])
})

test('the value bridge steps from ordered to received to invoiced net line value', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' })
  const bridge = chart(report, 'procurement_value_bridge')
  // Ordered 100 + 200 + 100 = 400; received 100 + 40 = 140; invoiced 100. The draft order and invoice are left out.
  assert.deepEqual(bridge.data, [
    { name: 'Ordered', value: 400 },
    { name: 'Not yet received', value: -260 },
    { name: 'Received', value: 140 },
    { name: 'Received, not invoiced', value: -40 },
    { name: 'Invoiced', value: 100 },
  ])
  assert.deepEqual(bridge.totals, ['Ordered', 'Received', 'Invoiced'])
  assert.equal(bridge.currencyCode, 'USD')
})

test('spend concentration sorts suppliers and carries the running share', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' })
  assert.deepEqual(chart(report, 'procurement_supplier_pareto').data, [
    { name: 'Acme', value: 300, filterValue: 'Acme', 'Cumulative share': 75 },
    { name: 'Bolt', value: 100, filterValue: 'Bolt', 'Cumulative share': 100 },
  ])
  const trend = chart(report, 'procurement_spend_trend')
  assert.deepEqual(trend.data, [{ name: '2026-09', 'Committed amount': 400, 'Purchase orders': 3 }])
  assert.deepEqual(trend.measures.map(item => [item.key, item.kind, item.axis]), [['Committed amount', 'bar', 0], ['Purchase orders', 'line', 1]])
  assert.deepEqual(chart(report, 'procurement_spend_treemap').breakdown.Acme, [{ name: 'A item', value: 200 }, { name: 'B item', value: 100 }])
})

test('suppliers beyond the first twelve fold into one bar that does not filter', () => {
  const purchaseOrders = Array.from({ length: 14 }, (_, index) => po(`PO-${index}`, `Supplier ${String(index).padStart(2, '0')}`, 'issued', [line('A', 1, 0, 100 - index)]))
  const pareto = chart(buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'procurement' }), 'procurement_supplier_pareto')
  assert.equal(pareto.data.length, 13)
  assert.deepEqual(pareto.data.at(-1), { name: 'Other suppliers', value: 88 + 87, filterValue: '', 'Cumulative share': 100 })
})

test('amounts in different currencies are counted, not added', () => {
  const mixed = procurementContext()
  mixed.purchaseOrders[2].currency = 'EUR'
  const report = buildRuntimeGovernedReport(mixed, { subject: 'procurement' })
  const trend = chart(report, 'procurement_spend_trend')
  assert.deepEqual(trend.data, [{ name: '2026-09', 'Purchase orders': 3 }])
  assert.deepEqual(trend.limitations, ['multi_currency_unconverted'])
  assert.equal(chart(report, 'procurement_supplier_pareto').unit, 'number')
  assert.deepEqual(chart(report, 'procurement_value_bridge').data, [])
  assert.equal(chart(report, 'procurement_value_bridge').emptyState, 'Select a currency to compare amounts.')
  assert.equal(kpi(report, 'purchase_order_amount').trend, null)

  const usd = buildRuntimeGovernedReport(mixed, { subject: 'procurement', filters: { currency: 'USD' } })
  assert.deepEqual(chart(usd, 'procurement_spend_trend').data, [{ name: '2026-09', 'Committed amount': 300, 'Purchase orders': 2 }])
  assert.equal(chart(usd, 'procurement_value_bridge').data[0].value, 300)
})

test('a missing line price hides the value bridge instead of counting it as zero', () => {
  const data = procurementContext()
  data.purchaseOrders[1].lines[1].unitPrice = null
  const bridge = chart(buildRuntimeGovernedReport(data, { subject: 'procurement' }), 'procurement_value_bridge')
  assert.deepEqual(bridge.data, [])
  assert.deepEqual(bridge.limitations, ['amount_missing'])
})

test('on-time receipts compare the arrival day with the order expected date and follow the order filters', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' })
  // GRN-1 arrived 09-18 for a 09-20 order: on time. GRN-2 arrived 09-22: late.
  assert.equal(kpi(report, 'on_time_receipt_rate').currentValue, 50)
  assert.equal(kpi(report, 'on_time_receipt_rate').unit, 'percentage')
  const bolt = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement', filters: { supplier: 'Bolt' } })
  assert.equal(kpi(bolt, 'on_time_receipt_rate').currentValue, null)
  assert.equal(kpi(bolt, 'on_time_receipt_rate').dataStatus, 'no_records')
  assert.deepEqual(chart(report, 'procurement_receipt_calendar').data, [{ name: '2026-09-18', value: 1 }, { name: '2026-09-22', value: 1 }])
  // The receipt date range uses the arrival day, not the order date.
  const late = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement', filters: { from: '2026-09-21', to: '2026-09-30' } })
  assert.equal(kpi(late, 'on_time_receipt_rate').currentValue, 0)
})

test('overdue open purchase orders count to the workspace calendar day', () => {
  const data = procurementContext()
  // 2026-09-21 01:00 UTC is still 2026-09-20 in New York, so PO-2 (expected 09-20) is not overdue there yet.
  const now = new Date('2026-09-21T01:00:00.000Z')
  assert.equal(kpi(buildRuntimeGovernedReport(data, { subject: 'procurement' }, { now, timeZone: 'America/New_York' }), 'overdue_open_po_count').currentValue, 0)
  assert.equal(kpi(buildRuntimeGovernedReport(data, { subject: 'procurement' }, { now, timeZone: 'UTC' }), 'overdue_open_po_count').currentValue, 1)
})

test('three-way match outcomes come from the recorded match status', () => {
  assert.equal(invoiceMatchOutcome({ status: 'matched', matchStatus: 'matched' }), 'matched')
  assert.equal(invoiceMatchOutcome({ status: 'exception', matchStatus: 'exception' }), 'exception')
  assert.equal(invoiceMatchOutcome({ status: 'exception', matchStatus: 'variance' }), 'exception')
  assert.equal(invoiceMatchOutcome({ status: 'submitted', matchStatus: 'pending' }), 'pending')
  assert.equal(invoiceMatchOutcome({ status: 'approved', matchStatus: null }), 'matched')
  assert.equal(invoiceMatchOutcome({ status: 'submitted' }), 'pending')
})

test('finance visuals cover submitted invoices only and keep match counts consistent', () => {
  const data = context({
    supplierInvoices: [
      invoice('INV-1', 'PO-1', 'Acme', 'matched', 'matched', 100),
      invoice('INV-2', 'PO-2', 'Acme', 'exception', 'exception', 50, { varianceAmount: -12.5 }),
      invoice('INV-3', 'PO-3', 'Bolt', 'submitted', 'pending', 80),
      invoice('INV-4', 'PO-3', 'Bolt', 'matched', 'matched', 20),
      invoice('INV-DRAFT', 'PO-3', 'Bolt', 'draft', 'pending', 999),
    ],
  })
  const report = buildRuntimeGovernedReport(data, { subject: 'finance' })
  assert.equal(kpi(report, 'invoice_amount').currentValue, 250)
  assert.equal(kpi(report, 'invoice_match_rate').currentValue, 50)
  assert.equal(kpi(report, 'invoices_awaiting_match').currentValue, 1)
  assert.equal(kpi(report, 'invoices_with_exception').currentValue, 1)
  const gauge = chart(report, 'finance_match_rate')
  assert.deepEqual(gauge.data, [{ name: 'Invoices matched', value: 50 }])
  assert.deepEqual(gauge.detail, { count: 2, total: 4, exception: 1, pending: 1 })
  assert.deepEqual(chart(report, 'finance_match_outcome').data, [{ name: 'Matched', value: 2 }, { name: 'Match exception', value: 1 }, { name: 'Awaiting match', value: 1 }])
  const flow = chart(report, 'finance_invoice_flow')
  assert.equal(flow.links.reduce((sum, row) => sum + row.value, 0), 4)
  assert.deepEqual(flow.links.find(row => row.source === 'Acme' && row.target === 'Match exception'), { source: 'Acme', target: 'Match exception', value: 1 })
  assert.deepEqual(chart(report, 'finance_variance_by_supplier').data, [{ name: 'Acme', value: 12.5, filterValue: 'Acme' }])
  // The invoice status chart covers every invoice in range, drafts included, so it can filter them.
  assert.equal(chart(report, 'finance_invoice_status').data.reduce((sum, row) => sum + row.value, 0), 5)
})

test('sales fulfillment leaves drafts and cancellations out and adds demand only within a SKU', () => {
  const order = (id, workflowStatus, sku, orderedQty, fulfilledQty, reservedQty = 0) => ({ id, salesOrderId: id, workflowStatus, status: workflowStatus, customerName: 'Northwind', sku, orderedQty, fulfilledQty, reservedQty, totalAmount: orderedQty * 10, currency: 'USD', orderDate: '2026-09-05' })
  const data = context({ salesOrders: [order('SO-1', 'confirmed', 'A', 10, 10), order('SO-2', 'confirmed', 'A', 10, 4), order('SO-3', 'confirmed', 'B', 5, 0, 5), order('SO-4', 'confirmed', 'B', 5, 0), order('SO-D', 'draft', 'B', 50, 0), order('SO-X', 'cancelled', 'A', 50, 0)] })
  const report = buildRuntimeGovernedReport(data, { subject: 'sales' })
  assert.deepEqual(chart(report, 'sales_fulfillment').data, [
    { name: 'Active orders', value: 4 },
    { name: 'Reserved or shipped', value: 3 },
    { name: 'Shipped', value: 2 },
    { name: 'Shipped in full', value: 1 },
  ])
  assert.deepEqual(chart(report, 'sales_open_demand').data, [{ name: 'B', value: 10 }, { name: 'A', value: 6 }])
  assert.equal(kpi(report, 'order_fulfillment_rate').currentValue, 25)
  assert.equal(kpi(report, 'sales_order_amount').currentValue, 300)
})

test('inventory visuals keep each SKU in its own unit and sort short SKUs first', () => {
  const data = context({
    items: [{ sku: 'A', safetyStock: 10 }, { sku: 'B', safetyStock: 0 }, { sku: 'C', safetyStock: 0 }],
    inventoryItems: [{ sku: 'A', onHandQuantity: 4, reservedQuantity: 0, unit: 'pcs' }, { sku: 'B', onHandQuantity: 0, reservedQuantity: 0, unit: 'pcs' }, { sku: 'C', onHandQuantity: 7, reservedQuantity: 0, unit: 'pcs' }],
    salesOrders: [{ id: 'SO-1', salesOrderId: 'SO-1', workflowStatus: 'confirmed', sku: 'B', orderedQty: 3, fulfilledQty: 0, reservedQty: 0, lines: [{ sku: 'B', orderedQuantity: 3, reservedQuantity: 0, fulfilledQuantity: 0 }] }],
  })
  const report = buildRuntimeGovernedReport(data, { subject: 'inventory' })
  assert.deepEqual(chart(report, 'inventory_on_hand_by_sku').data, [{ name: 'C', value: 7 }, { name: 'A', value: 4 }, { name: 'B', value: 0 }])
  assert.equal(chart(report, 'inventory_available_to_promise').data[0].name, 'B')
  assert.ok(chart(report, 'inventory_available_to_promise').data[0].value < 0)
  assert.equal(kpi(report, 'negative_atp_sku').currentValue, 1)
  const matrix = chart(report, 'inventory_risk_matrix')
  assert.deepEqual(matrix.data, [
    { name: 'out_of_stock', high: 1, medium: 0, low: 0 },
    { name: 'below_safety_stock', high: 0, medium: 1, low: 0 },
    { name: 'ok', high: 0, medium: 0, low: 1 },
  ])
  // A SKU whose stock is not recorded is counted as unknown, not dropped.
  const unknown = buildRuntimeGovernedReport(context({ inventoryItems: [{ sku: 'X' }] }), { subject: 'inventory' })
  assert.deepEqual(chart(unknown, 'inventory_risk_matrix').data, [{ name: 'unknown', unknown: 1 }])
})

test('the supplier matrix and scorecard use only measured suppliers', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'suppliers' })
  const matrix = chart(report, 'supplier_performance_matrix')
  // Only Acme has receipts with an expected date.
  assert.deepEqual(matrix.data, [{ name: 'Acme', 'Committed amount': 300, 'On-time receipts': 50, Receipts: 2, filterValue: 'Acme' }])
  assert.deepEqual(matrix.guides, { x: 300, y: 50 })
  assert.equal(kpi(report, 'active_supplier_count').currentValue, 2)
  const scorecard = chart(report, 'supplier_scorecard')
  assert.deepEqual(scorecard.seriesKeys, ['On-time receipts', 'Lines accepted in full', 'Invoices matched', 'Share of spend'])
  assert.deepEqual(scorecard.data, [{ name: 'Acme', 'On-time receipts': 50, 'Lines accepted in full': 50, 'Invoices matched': 100, 'Share of spend': 75 }])
})

test('KPI sparklines need two dated months and a single currency', () => {
  const data = procurementContext()
  data.purchaseOrders[0].createdAt = '2026-08-12T12:00:00.000Z'
  const report = buildRuntimeGovernedReport(data, { subject: 'procurement' })
  assert.deepEqual(kpi(report, 'purchase_order_amount').trend, [{ period: '2026-08', value: 100 }, { period: '2026-09', value: 300 }])
  assert.equal(kpi(buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' }), 'purchase_order_amount').trend, null)
})

test('the overview keeps its first three charts and adds spend and lifecycle visuals', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'overview' })
  assert.deepEqual(report.charts.map(item => item.id), ['overview_activity', 'overview_status', 'overview_suppliers', 'overview_spend_trend', 'overview_lifecycle'])
})
