import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { inventoryStockSignals, stockSignalCounts, stockStateOf } from '../../shared/inventory-stock-signals.mjs'

// Design audit B4 (L6-05): a KPI's drilldown landed on another set of records
// (the inventory page ignored ?risk=high, the old three-way-match route
// replaced the whole query with status=exception, the open PO count opened
// every PO). Each count KPI now opens the rows it counts, so the rows shown
// are the KPI's value.

const kpi = (report, id) => report.kpis.find((item) => item.id === id)
const asOf = { now: new Date('2026-10-05T12:00:00Z'), timeZone: 'Europe/London' }
const item = (sku, safetyStock, reorderPoint) => ({ id: `ITEM-${sku}`, itemId: `ITEM-${sku}`, sku, itemName: sku, safetyStock, reorderPoint })
const balance = (sku, onHandQuantity, reservedQuantity = 0) => ({ sku, itemId: `ITEM-${sku}`, onHandQuantity, reservedQuantity, unit: 'pcs' })
const line = (sku, orderedQuantity, receivedQuantity = 0) => ({ id: `${sku}-${orderedQuantity}`, sku, unit: 'pcs', orderedQuantity, receivedQuantity, unitPrice: 1, amount: orderedQuantity })
const invoice = (id, status, matchStatus, invoiceDate = '2026-09-15') => ({ id, invoiceNumber: id, status, matchStatus, currency: 'GBP', totalAmount: 100, invoiceDate, supplierName: 'Acme' })

// A out of stock; B short for a sales order; C short even after its incoming
// order; D below safety stock on hand; E fine.
const business = () => ({
  purchaseOrders: [
    { id: 'PO-1', status: 'issued', orderDate: '2026-09-10', currency: 'GBP', totalAmount: 30, supplierName: 'Acme', lines: [line('C', 10)] },
    { id: 'PO-2', status: 'partially_received', orderDate: '2026-09-12', currency: 'GBP', totalAmount: 20, supplierName: 'Acme', lines: [line('E', 20, 5)] },
    { id: 'PO-3', status: 'fully_received', orderDate: '2026-09-14', currency: 'GBP', totalAmount: 20, supplierName: 'Acme', lines: [line('E', 20, 20)] },
    { id: 'PO-4', status: 'draft', orderDate: '2026-09-14', currency: 'GBP', totalAmount: 20, supplierName: 'Acme', lines: [line('E', 20)] },
  ],
  salesOrders: [
    { id: 'SO-1', status: 'confirmed', orderDate: '2026-09-11', currency: 'GBP', totalAmount: 50, customerName: 'Northwind', lines: [{ sku: 'B', unit: 'pcs', orderedQuantity: 30, fulfilledQuantity: 0 }, { sku: 'C', unit: 'pcs', orderedQuantity: 40, fulfilledQuantity: 0 }] },
  ],
  items: [item('A', 10, 20), item('B', 5, 10), item('C', 5, 10), item('D', 50, 80), item('E', 5, 10)],
  inventoryItems: [balance('A', 0), balance('B', 20), balance('C', 20), balance('D', 30), balance('E', 100)],
  supplierInvoices: [
    invoice('INV-MATCHED', 'approved', 'matched'), invoice('INV-EXCEPTION', 'exception', 'exception'), invoice('INV-VARIANCE', 'submitted', 'variance'),
    invoice('INV-PENDING-1', 'submitted', null), invoice('INV-PENDING-2', 'matching', 'pending'), invoice('INV-DRAFT', 'draft', null),
    invoice('INV-AUGUST', 'submitted', null, '2026-08-01'),
  ],
  suppliers: [], customers: [], receipts: [], dataLimitations: [],
})

// The report a drilldown path opens: its tab's subject and its own filters,
// over the dashboard's filters when the link carries none of its own.
function opened(path, filters = {}) {
  const url = new URL(path, 'https://flowchain.test')
  assert.match(url.pathname, /^\/app\/reports\/[a-z]+$/, path)
  const subject = url.pathname.split('/').at(-1)
  return buildRuntimeGovernedReport(business(), { subject, filters: { ...filters, ...Object.fromEntries(url.searchParams) } }, asOf)
}

test('each inventory count opens the report rows it counts', () => {
  const report = buildRuntimeGovernedReport(business(), { subject: 'inventory' }, asOf)
  for (const [id, path, skus] of [
    ['inventory_risk_sku', '/app/reports/inventory?stock=short_for_sales', ['B', 'C']],
    ['out_of_stock_sku', '/app/reports/inventory?stock=out_of_stock', ['A']],
    ['negative_atp_sku', '/app/reports/inventory?stock=short_after_incoming', ['B', 'C']],
  ]) {
    const figure = kpi(report, id)
    assert.equal(figure.drilldownPath, path, id)
    const drilled = opened(path)
    assert.equal(drilled.totalRecords, figure.currentValue, id)
    assert.deepEqual(drilled.details.map((row) => row.id).sort(), skus, id)
    // On the drilled page the KPI itself reads the same.
    assert.equal(kpi(drilled, id).currentValue, figure.currentValue, id)
  }
  // An unknown value is ignored rather than emptying the page.
  assert.equal(opened('/app/reports/inventory?stock=everything').totalRecords, report.totalRecords)
  // The overview's "Short for sales orders" card opens the same rows.
  const overview = buildRuntimeGovernedReport(business(), { subject: 'overview' }, asOf)
  const shortages = overview.attention.find((card) => card.id === 'inventory_shortages')
  assert.equal(opened(shortages.path).totalRecords, shortages.count)
})

test('each invoice count opens the submitted invoices in range it counts, by their match outcome', () => {
  const september = { from: '2026-09-01', to: '2026-09-30' }
  const report = buildRuntimeGovernedReport(business(), { subject: 'finance', filters: september }, asOf)
  for (const [id, path, ids] of [
    ['invoices_awaiting_match', '/app/reports/finance?match=pending', ['INV-PENDING-1', 'INV-PENDING-2']],
    ['invoices_with_exception', '/app/reports/finance?match=exception', ['INV-EXCEPTION', 'INV-VARIANCE']],
  ]) {
    const figure = kpi(report, id)
    assert.equal(figure.drilldownPath, path, id)
    const drilled = opened(path, september)
    assert.equal(drilled.totalRecords, figure.currentValue, id)
    assert.deepEqual(drilled.exportRows.map((row) => row.id).sort(), ids, id)
  }
  // The amount and the match rate open every submitted invoice in range: the
  // rate's denominator. Drafts and August are not among them.
  assert.equal(kpi(report, 'invoice_match_rate').drilldownPath, '/app/reports/finance?match=submitted')
  const submitted = opened('/app/reports/finance?match=submitted', september)
  assert.deepEqual(submitted.exportRows.map((row) => row.id).sort(), ['INV-EXCEPTION', 'INV-MATCHED', 'INV-PENDING-1', 'INV-PENDING-2', 'INV-VARIANCE'])
  assert.equal(kpi(report, 'invoice_match_rate').currentValue, 20)
  // The match outcome is a filter, not a column of the table.
  assert.equal(submitted.columnDefinitions.some((column) => column.key === 'match'), false)
  // No report or chart sends anyone to the old three-way-match route, which
  // replaced the whole query with status=exception.
  assert.equal(JSON.stringify([report.kpis, report.charts]).includes('three-way-match'), false)
})

test('the open purchase order count opens the open purchase orders report, which counts the same orders', () => {
  const report = buildRuntimeGovernedReport(business(), { subject: 'procurement' }, asOf)
  const figure = kpi(report, 'open_po_count')
  assert.equal(figure.drilldownPath, '/app/reports/procurement?status=open')
  // The report that link opens (scope open), over the same orders.
  const rows = buildOpenPurchaseOrdersReport(business().purchaseOrders, { export: 'true' }, asOf.now, { timeZone: asOf.timeZone }).exportRows.filter((row) => row.isOpen)
  assert.equal(rows.length, figure.currentValue)
  assert.deepEqual(rows.map((row) => row.id).sort(), ['PO-1', 'PO-2'])
})

test('below safety stock on the overview is the inventory warnings count, apart from the items to reorder', () => {
  // The reorder list judged every item: C and E have stock incoming; only A orders now.
  const reorder = { orderNow: 1, rows: [{ sku: 'A', position: 0, incoming: 0, orderNow: true }, { sku: 'C', position: 30, incoming: 10, orderNow: false }, { sku: 'D', position: 90, incoming: 60, orderNow: false }], notJudged: [] }
  const report = buildRuntimeGovernedReport(business(), { subject: 'overview' }, { ...asOf, reorder })
  const figure = kpi(report, 'low_stock_sku')
  assert.equal(figure.label, 'Below safety stock (on hand)')
  // A (none on hand) and D (30 under 50); B and C are under their reorder
  // points but above safety stock. D's open order covers it.
  assert.deepEqual([figure.currentValue, figure.detail], [2, { coveredByOpenOrders: 1 }])
  assert.deepEqual(report.stockSignals, { needsReplenishment: 1, belowSafetyOnHand: 2, coveredByOpenOrders: 1 })
  // The same signals over the same stock, as the inventory warnings view
  // computes them, give the same counts.
  const warnings = stockSignalCounts(inventoryStockSignals({ balances: business().inventoryItems.map((row) => ({ ...row, availableQuantity: row.onHandQuantity, ...business().items.find((entry) => entry.sku === row.sku) })), reorderList: reorder }))
  assert.deepEqual([warnings.belowSafetyOnHand, warnings.coveredByOpenOrders], [2, 1])
  // The items to reorder stay a card of their own, as on Today.
  assert.equal(report.attention.find((card) => card.id === 'items_to_reorder').count, 1)
})

test('the overview stock finding names the two signals apart, and says how many open orders cover', async () => {
  const { reportInsights } = await import('../../src/modules/reports/reportInsights.ts')
  const format = (value) => String(value)
  const finding = (report, language = 'en-US') => reportInsights('overview', report, { language, format, category: (_chart, name) => name }).find((item) => item.id === 'stock')
  const reorder = { orderNow: 1, rows: [{ sku: 'A', position: 0, incoming: 0, orderNow: true }, { sku: 'C', position: 30, incoming: 10, orderNow: false }, { sku: 'D', position: 90, incoming: 60, orderNow: false }], notJudged: [] }
  const report = buildRuntimeGovernedReport(business(), { subject: 'overview' }, { ...asOf, reorder })
  // L7-19: "22 below safety stock and 4 below reorder point" read as two parts
  // of one whole. W-03: the low shelf did not say open orders cover it.
  assert.deepEqual([finding(report).text, finding(report).path, finding(report).tone], ['1 item needs reordering by stock position; 2 items are below safety stock on hand, 1 of them covered by open orders.', '/app/inventory/warnings?signal=replenish', 'attention'])
  assert.equal(finding(report, 'zh-CN').text, '1 个物料按库存头寸需要补货；2 个物料的现有库存低于安全库存，其中 1 个已有在途采购覆盖。')
  // Every low shelf covered and nothing to order: said so, not as a warning.
  const covered = { orderNow: 0, rows: [{ sku: 'A', position: 40, incoming: 40, orderNow: false }, { sku: 'D', position: 90, incoming: 60, orderNow: false }], notJudged: [] }
  const calm = finding(buildRuntimeGovernedReport(business(), { subject: 'overview' }, { ...asOf, reorder: covered }))
  assert.deepEqual([calm.text, calm.tone], ['0 items need reordering by stock position; 2 items are below safety stock on hand, all covered by open orders.', 'neutral'])
})

test('the inventory warnings view takes the signal a link asks for, and on-order stock is not called sufficient', () => {
  const page = readFileSync(new URL('../../src/modules/inventory/Page.tsx', import.meta.url), 'utf8')
  assert.ok(page.includes('stockSignalMatches(signals.get(item.sku), signalFilter)'))
  // L7-22: on hand under the reorder point, covered by open orders.
  const signals = inventoryStockSignals({ balances: [{ sku: 'X', availableQuantity: 26, onHandQuantity: 26, safetyStock: 26, reorderPoint: 77 }], reorderList: { rows: [{ sku: 'X', position: 126, incoming: 100, orderNow: false }], notJudged: [] } })
  assert.equal(stockStateOf(signals.get('X')), 'on_order')
  assert.ok(page.includes('onOrder: ["On order", "已有在途采购"]'))
})
