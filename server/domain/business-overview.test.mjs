import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs';

const chart = (report, id) => report.charts.find((item) => item.id === id);
const kpi = (report, id) => report.kpis.find((item) => item.id === id);

const context = { purchaseOrders: Array.from({ length: 60 }, (_, i) => ({ id: `PO-${i}`, status: i % 2 ? 'fully_received' : 'issued', createdAt: '2026-09-10', currency: i % 2 ? 'CNY' : 'USD', totalAmount: 100, supplierName: i % 2 ? 'Beta' : 'Alpha', lines: [] })), salesOrders: [{ id: 'SO-1', createdAt: '2026-09-10', orderedQty: 4, fulfilledQty: 2, currency: 'USD', status: 'open' }], items: [], inventoryItems: [], suppliers: [], supplierInvoices: [], receipts: [], dataLimitations: [] };
test('overview charts aggregate the whole loaded scope before detail pagination, without adding currencies', () => {
  const report = buildRuntimeGovernedReport(context, { subject: 'overview', limit: 5 });
  assert.equal(report.details.length, 5);
  assert.equal(report.exportRows.length, 60);
  assert.equal(report.totalRecords, 60);
  assert.equal(report.kpis[0].value, null);
  assert.deepEqual(chart(report, 'overview_activity').data, [{ name: '2026-09', 'Purchase orders': 60, 'Sales orders': 1 }]);
  assert.equal(chart(report, 'overview_suppliers').data.reduce((n, row) => n + row.value, 0), 60);
  // Purchases in two currencies are not set beside sales in one.
  assert.deepEqual(chart(report, 'overview_purchases_and_sales').data, []);
  assert.equal(chart(report, 'overview_purchases_and_sales').emptyState, 'Select a currency to compare amounts.');
  assert.equal(report.attention[0].count, 30);
  assert.equal(report.attention[2].count, 1);
});
test('overview charts and attention respect currency and date filters', () => {
  const report = buildRuntimeGovernedReport(context, { subject: 'overview', filters: { currency: 'USD', from: '2026-09-01', to: '2026-09-30' } });
  assert.equal(chart(report, 'overview_activity').data[0]['Purchase orders'], 30);
  assert.deepEqual(chart(report, 'overview_suppliers').data, [{ name: 'Alpha', value: 30 }]);
  // One currency: purchases and sales side by side; the sales order has no amount, and the chart says so.
  const money = chart(report, 'overview_purchases_and_sales');
  assert.deepEqual(money.data, [{ name: '2026-09', 'Committed PO amount': 3000, 'Sales order amount': 0 }]);
  assert.deepEqual([money.unit, money.currencyCode, money.seriesKeys, money.limitations], ['currency', 'USD', ['Committed PO amount', 'Sales order amount'], ['amount_missing']]);
  assert.equal(report.attention[0].count, 30);
  const empty = buildRuntimeGovernedReport(context, { subject: 'overview', filters: { from: '2027-01-01' } });
  assert.deepEqual(chart(empty, 'overview_activity').data, []);
  assert.equal(empty.attention[0].count, 0);
});
test('the overview counts the reorder list\'s order-now items, and names the sales-order shortage as such', () => {
  // The 2026-10-08 walkthrough: Today and the reorder list said "order now"
  // for 4 items while the overview showed "Inventory shortages 0".
  const report = buildRuntimeGovernedReport(context, { subject: 'overview' }, { reorder: { orderNow: 4 } });
  assert.deepEqual(report.attention.map((item) => item.id), ['open_orders', 'items_to_reorder', 'inventory_shortages', 'unfulfilled_sales']);
  assert.deepEqual(report.attention[1], { id: 'items_to_reorder', label: 'Items to reorder', count: 4, path: '/app/inventory/reorder', action: 'Open reorder list' });
  assert.equal(report.attention[2].label, 'Short for sales orders');
  // The shortage is a Needs attention card, not a KPI that is almost always 0 (round 8).
  assert.equal(kpi(report, 'inventory_risk_sku'), undefined);
  // Without the reorder list (no database, or a reader of only some warehouses) the card is left out.
  assert.equal(buildRuntimeGovernedReport(context, { subject: 'overview' }).attention.some((item) => item.id === 'items_to_reorder'), false);
  assert.equal(buildRuntimeGovernedReport(context, { subject: 'procurement' }, { reorder: { orderNow: 4 } }).attention.length, 0);
});

// Round 8 (owner review: the overview was mostly purchasing): one figure and
// one chart per area, each opening its analytics tab.
const item = (sku, safetyStock, reorderPoint) => ({ id: `ITEM-${sku}`, itemId: `ITEM-${sku}`, sku, itemName: sku, safetyStock, reorderPoint });
const stock = (sku, onHandQuantity) => ({ sku, itemId: `ITEM-${sku}`, onHandQuantity, reservedQuantity: 0, unit: 'pcs' });
const business = () => ({
  purchaseOrders: [
    { id: 'PO-1', status: 'issued', orderDate: '2026-08-10', currency: 'GBP', totalAmount: 500, supplierName: 'Acme', lines: [] },
    { id: 'PO-2', status: 'fully_received', orderDate: '2026-09-10', currency: 'GBP', totalAmount: 300, supplierName: 'Acme', lines: [] },
    { id: 'PO-3', status: 'issued', orderDate: '2026-09-12', currency: 'GBP', totalAmount: 200, supplierName: 'Bolt', lines: [] },
    { id: 'PO-DRAFT', status: 'draft', orderDate: '2026-09-12', currency: 'GBP', totalAmount: 9000, supplierName: 'Bolt', lines: [] },
  ],
  salesOrders: [
    { id: 'SO-1', status: 'confirmed', orderDate: '2026-08-11', currency: 'GBP', totalAmount: 700, customerName: 'Northwind', lines: [{ sku: 'D', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 1 }] },
    { id: 'SO-2', status: 'confirmed', orderDate: '2026-09-11', currency: 'GBP', totalAmount: 400, customerName: 'Contoso', lines: [{ sku: 'D', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 1 }] },
    { id: 'SO-DRAFT', status: 'draft', orderDate: '2026-09-11', currency: 'GBP', totalAmount: 8000, customerName: 'Contoso', lines: [{ sku: 'D', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 0 }] },
  ],
  // A out of stock, B below its safety stock, C at its reorder point, D in stock.
  items: [item('A', 10, 20), item('B', 10, 20), item('C', 5, 10), item('D', 5, 10)],
  inventoryItems: [stock('A', 0), stock('B', 8), stock('C', 10), stock('D', 50)],
  supplierInvoices: [{ id: 'INV-1', invoiceNumber: 'INV-1', status: 'approved', currency: 'GBP', totalAmount: 120, invoiceDate: '2026-09-15', supplierName: 'Acme' }],
  suppliers: [], customers: [], receipts: [], dataLimitations: [],
});
const asOf = { now: new Date('2026-10-05T12:00:00Z'), timeZone: 'Europe/London' };

test('the overview has one figure per area, and each opens its analytics tab', () => {
  const report = buildRuntimeGovernedReport(business(), { subject: 'overview' }, asOf);
  assert.deepEqual(report.kpis.map((row) => [row.id, row.currentValue, row.drilldownPath]), [
    ['purchase_order_amount', 1000, '/app/reports/procurement?view=analytics'],
    ['sales_order_amount', 1100, '/app/reports/sales'],
    ['low_stock_sku', 3, '/app/reports/inventory'],
    ['invoice_amount', 120, '/app/reports/finance'],
  ]);
  assert.deepEqual(report.drilldowns.map((row) => row.path), report.kpis.map((row) => row.drilldownPath));
  // Elsewhere a figure still opens its records.
  assert.equal(kpi(buildRuntimeGovernedReport(business(), { subject: 'procurement' }, asOf), 'purchase_order_amount').drilldownPath, '/app/procurement/orders');
  // Purchases, sales, stock and suppliers, each chart opening its tab and keeping its filter.
  assert.deepEqual(report.charts.map((row) => [row.id, row.type, row.drilldownPath, row.crossFilter]), [
    ['overview_purchases_and_sales', 'bar', '/app/reports/sales', 'period'],
    ['overview_stock_status', 'donut', '/app/reports/inventory', null],
    ['overview_activity', 'bar', '/app/reports/procurement?view=analytics', 'period'],
    ['overview_suppliers', 'horizontal_bar', '/app/reports/procurement?view=analytics', 'supplier'],
  ]);
  // Committed purchases and confirmed sales by month, never added; drafts left out.
  assert.deepEqual(chart(report, 'overview_purchases_and_sales').data, [
    { name: '2026-08', 'Committed PO amount': 500, 'Sales order amount': 700 },
    { name: '2026-09', 'Committed PO amount': 500, 'Sales order amount': 400 },
  ]);
  assert.equal(chart(report, 'overview_purchases_and_sales').currencyCode, 'GBP');
  // The low-stock figure is the stock status chart's slices other than in stock.
  const statuses = Object.fromEntries(chart(report, 'overview_stock_status').data.map((row) => [row.name, row.value]));
  assert.deepEqual(statuses, { below_reorder_point: 1, below_safety_stock: 1, ok: 1, out_of_stock: 1 });
  assert.equal(chart(report, 'overview_stock_status').statusLabels, true);
});

test('at most one overview chart repeats a chart of another analytics tab', () => {
  const overview = buildRuntimeGovernedReport(business(), { subject: 'overview' }, asOf);
  const others = ['procurement', 'sales', 'inventory', 'finance', 'suppliers'].flatMap((subject) => buildRuntimeGovernedReport(business(), { subject }, asOf).charts);
  const same = (a, b) => a.type === b.type && JSON.stringify(a.data) === JSON.stringify(b.data) && JSON.stringify(a.seriesKeys || null) === JSON.stringify(b.seriesKeys || null);
  const repeats = overview.charts.filter((row) => others.some((other) => same(row, other))).map((row) => row.id);
  assert.deepEqual(repeats, ['overview_stock_status']);
  for (const row of overview.charts) assert.ok(!others.some((other) => other.title === row.title), `${row.id} shares a title with another tab`);
});

test('a reader who may not read a subject sees neither its figure, its chart, its series nor its card', () => {
  const restricted = (subjects, amounts = {}) => buildRuntimeGovernedReport({ ...business(), restrictedSubjects: subjects, restrictedAmounts: amounts }, { subject: 'overview' }, asOf);
  const buyer = restricted(['sales_orders', 'inventory_balances', 'supplier_invoices']);
  for (const id of ['sales_order_amount', 'low_stock_sku', 'invoice_amount']) assert.deepEqual([kpi(buyer, id).currentValue, kpi(buyer, id).dataStatus], [null, 'restricted'], id);
  assert.deepEqual(chart(buyer, 'overview_activity').seriesKeys, ['Purchase orders']);
  assert.deepEqual(chart(buyer, 'overview_purchases_and_sales').seriesKeys, ['Committed PO amount']);
  assert.ok(chart(buyer, 'overview_purchases_and_sales').data.every((row) => !Object.hasOwn(row, 'Sales order amount')));
  assert.deepEqual([chart(buyer, 'overview_stock_status').data, chart(buyer, 'overview_stock_status').emptyState], [[], 'Your role cannot view inventory.']);
  assert.deepEqual(buyer.attention.map((row) => row.id), ['open_orders']);

  const seller = restricted(['purchase_orders']);
  assert.equal(kpi(seller, 'purchase_order_amount').dataStatus, 'restricted');
  assert.deepEqual(chart(seller, 'overview_activity').seriesKeys, ['Sales orders']);
  assert.deepEqual([chart(seller, 'overview_suppliers').data, chart(seller, 'overview_suppliers').emptyState], [[], 'Your role cannot view purchase orders.']);
  assert.deepEqual(chart(seller, 'overview_purchases_and_sales').seriesKeys, ['Sales order amount']);
  assert.ok(!seller.attention.some((row) => row.id === 'open_orders'));

  // Neither orders readable: the monthly charts say so instead of drawing zeros.
  const neither = restricted(['purchase_orders', 'sales_orders']);
  for (const id of ['overview_activity', 'overview_purchases_and_sales']) assert.deepEqual([chart(neither, id).data, chart(neither, id).emptyState], [[], 'Your role cannot view these records.'], id);

  // Without prices the purchase amounts are left out of the chart as from the KPI.
  const viewer = restricted([], { purchase_orders: true });
  assert.equal(kpi(viewer, 'purchase_order_amount').dataStatus, 'restricted');
  assert.deepEqual(chart(viewer, 'overview_purchases_and_sales').seriesKeys, ['Sales order amount']);
  assert.ok(!JSON.stringify(chart(viewer, 'overview_purchases_and_sales')).includes('Committed PO amount'));
});

test('saved views and links that name the old overview charts still load', async () => {
  // Chart ids a saved view names that the report no longer has are ignored:
  // they hide nothing, do not count against "keep one chart visible", and are not saved again.
  const source = await readFile(new URL('../../src/modules/reports/BiDashboard.tsx', import.meta.url), 'utf8');
  assert.match(source, /const hiddenChartIds = useMemo\(\(\) => knownChartIds\(\(params\.get\("hiddenCharts"\) \|\| ""\)\.split\(","\)\.filter\(Boolean\), report\?\.charts\), \[params, report\]\);/);
  assert.match(source, /const knownChartIds = \(ids: string\[\], charts: Array<\{ id: string \}> \| undefined\) => charts \? ids\.filter\(\(id\) => charts\.some\(\(chart\) => chart\.id === id\)\) : ids;/);
  // Chart order sorts unknown ids last and keeps only the charts shown.
  assert.match(source, /return \(ai < 0 \? Number\.MAX_SAFE_INTEGER : ai\) - \(bi < 0 \? Number\.MAX_SAFE_INTEGER : bi\);/);
  // A saved overview view keeps the KPIs it was saved with: they are still governed metrics.
  const old = buildRuntimeGovernedReport(business(), { subject: 'overview', measures: ['purchase_order_amount', 'open_po_count', 'inventory_risk_sku', 'sales_order_count'] }, asOf);
  assert.deepEqual(old.kpis.map((row) => row.id), ['purchase_order_amount', 'open_po_count', 'inventory_risk_sku', 'sales_order_count']);
});

test('the overview\'s key findings cover sales, purchasing and stock, from the figures on the page', async () => {
  const { reportInsights } = await import('../../src/modules/reports/reportInsights.ts');
  const format = (value, unit, currency) => unit === 'currency' ? `${currency} ${value}` : String(value);
  const findings = (report, language = 'en-US') => reportInsights('overview', report, { language, format, category: (_chart, name) => name });
  const report = buildRuntimeGovernedReport(business(), { subject: 'overview' }, asOf);
  assert.deepEqual(findings(report).map((item) => [item.id, item.figure, item.text, item.path]), [
    ['overview_last_month', 'GBP 400', '2026-09, the last whole month: GBP 400 in sales orders and GBP 500 in committed purchases.', '/app/reports/sales'],
    ['stock', '3', '3 of 4 SKUs are low on stock: 1 out of stock, 1 below safety stock and 1 below reorder point.', '/app/reports/inventory'],
    ['busiest_supplier', '2', 'Acme has the most committed purchase orders: 2.', '/app/reports/procurement?view=analytics'],
  ]);
  assert.deepEqual(findings(report, 'zh-CN').map((item) => item.text), [
    '2026-09（最近一个完整月份）：销售订单 GBP 400，已承诺采购 GBP 500。',
    '4 个 SKU 中有 3 个库存偏低：缺货 1 个、低于安全库存 1 个、低于再订货点 1 个。',
    'Acme 的已承诺采购订单最多：2 张。',
  ]);
  // A date range adds the largest change against the previous period first.
  const ranged = buildRuntimeGovernedReport(business(), { subject: 'overview', filters: { from: '2026-09-01', to: '2026-09-30' }, comparison: 'previous_period' }, asOf);
  assert.equal(findings(ranged)[0].id, 'change_sales_order_amount');
  assert.match(findings(ranged)[0].text, /^Sales order amount fell 42\.9% against the previous period/);
  // Stock with nothing low reads as such; a reader who may not read inventory gets no stock finding.
  const healthy = { ...business(), inventoryItems: [stock('A', 50), stock('B', 50), stock('C', 50), stock('D', 50)] };
  assert.equal(findings(buildRuntimeGovernedReport(healthy, { subject: 'overview' }, asOf)).find((item) => item.id === 'stock').text, 'No SKU is out of stock or below its safety stock or reorder point.');
  assert.equal(findings(buildRuntimeGovernedReport({ ...business(), restrictedSubjects: ['inventory_balances'] }, { subject: 'overview' }, asOf)).some((item) => item.id === 'stock'), false);
  // Suppliers tied at the top of every bar have no leader.
  const tied = { ...business(), purchaseOrders: business().purchaseOrders.filter((row) => row.id !== 'PO-2') };
  assert.equal(findings(buildRuntimeGovernedReport(tied, { subject: 'overview' }, asOf)).some((item) => item.id === 'busiest_supplier'), false);
});
