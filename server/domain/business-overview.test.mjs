import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs';

const context = { purchaseOrders: Array.from({ length: 60 }, (_, i) => ({ id: `PO-${i}`, status: i % 2 ? 'fully_received' : 'issued', createdAt: '2026-09-10', currency: i % 2 ? 'CNY' : 'USD', totalAmount: 100, supplierName: i % 2 ? 'Beta' : 'Alpha', lines: [] })), salesOrders: [{ id: 'SO-1', createdAt: '2026-09-10', orderedQty: 4, fulfilledQty: 2, currency: 'USD', status: 'open' }], items: [], inventoryItems: [], suppliers: [], supplierInvoices: [], receipts: [], dataLimitations: [] };
test('overview charts aggregate the whole loaded scope before detail pagination, without adding currencies', () => {
  const report = buildRuntimeGovernedReport(context, { subject: 'overview', limit: 5 });
  assert.equal(report.details.length, 5);
  assert.equal(report.exportRows.length, 60);
  assert.equal(report.totalRecords, 60);
  assert.equal(report.kpis[0].value, null);
  assert.deepEqual(report.charts[0].data, [{ name: '2026-09', 'Purchase orders': 60, 'Sales orders': 1 }]);
  assert.equal(report.charts[1].data.reduce((n, row) => n + row.value, 0), 60);
  assert.equal(report.attention[0].count, 30);
  assert.equal(report.attention[2].count, 1);
});
test('overview charts and attention respect currency and date filters', () => {
  const report = buildRuntimeGovernedReport(context, { subject: 'overview', filters: { currency: 'USD', from: '2026-09-01', to: '2026-09-30' } });
  assert.equal(report.charts[0].data[0]['Purchase orders'], 30);
  assert.deepEqual(report.charts[2].data, [{ name: 'Alpha', value: 30 }]);
  assert.equal(report.attention[0].count, 30);
  const empty = buildRuntimeGovernedReport(context, { subject: 'overview', filters: { from: '2027-01-01' } });
  assert.deepEqual(empty.charts[0].data, []);
  assert.equal(empty.attention[0].count, 0);
});
test('the overview counts the reorder list\'s order-now items, and names the sales-order shortage as such', () => {
  // The 2026-10-08 walkthrough: Today and the reorder list said "order now"
  // for 4 items while the overview showed "Inventory shortages 0".
  const report = buildRuntimeGovernedReport(context, { subject: 'overview' }, { reorder: { orderNow: 4 } });
  assert.deepEqual(report.attention.map((item) => item.id), ['open_orders', 'items_to_reorder', 'inventory_shortages', 'unfulfilled_sales']);
  assert.deepEqual(report.attention[1], { id: 'items_to_reorder', label: 'Items to reorder', count: 4, path: '/app/inventory/reorder', action: 'Open reorder list' });
  assert.equal(report.attention[2].label, 'Short for sales orders');
  assert.equal(report.kpis.find((item) => item.id === 'inventory_risk_sku').label, 'SKUs short for sales orders');
  // Without the reorder list (no database, or a reader of only some warehouses) the card is left out.
  assert.equal(buildRuntimeGovernedReport(context, { subject: 'overview' }).attention.some((item) => item.id === 'items_to_reorder'), false);
  assert.equal(buildRuntimeGovernedReport(context, { subject: 'procurement' }, { reorder: { orderNow: 4 } }).attention.length, 0);
});
