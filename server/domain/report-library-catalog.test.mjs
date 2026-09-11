import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeReportCatalog } from './runtime-report-read-model.mjs';
import { createReportView, deleteReportView } from '../repositories/report-view-repository.mjs';

const actor = { id: 'catalog-reviewer', name: 'Report reviewer', role: 'manager' };
test('every published runtime field and metric can be saved in a report view', () => {
  const catalog = getRuntimeReportCatalog();
  for (const subject of ['purchase_orders', 'sales_orders', 'inventory_balances', 'supplier_invoices', 'suppliers']) {
    const result = createReportView({ name: 'Review', subject, sourceRoute: '/app/reports/procurement', columns: catalog.fields[subject].map(field => field.key), measures: catalog.metrics.filter(metric => metric.subject === subject).map(metric => metric.id) }, actor);
    assert.equal(result.status, 201, JSON.stringify(result));
    deleteReportView(result.view.viewId, actor);
  }
});
test('unregistered report fields and measures are still rejected', () => {
  const result = createReportView({ name: 'Review', subject: 'purchase_orders', columns: ['password'], measures: ['arbitrary_sql'] }, actor);
  assert.equal(result.status, 422);
  assert.equal(result.errors.length, 2);
});
