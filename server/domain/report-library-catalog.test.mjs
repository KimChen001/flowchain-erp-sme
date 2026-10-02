import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeReportCatalog } from './runtime-report-read-model.mjs';
import { validateReportView } from '../repositories/report-view-repository.mjs';

test('every published runtime field and metric can be saved in a report view', () => {
  const catalog = getRuntimeReportCatalog();
  for (const subject of ['purchase_orders', 'sales_orders', 'inventory_balances', 'supplier_invoices', 'suppliers']) {
    const errors = validateReportView({ name: 'Review', subject, sourceRoute: '/app/reports/procurement', columns: catalog.fields[subject].map(field => field.key), measures: catalog.metrics.filter(metric => metric.subject === subject).map(metric => metric.id) });
    assert.deepEqual(errors, [], subject);
  }
});
test('unregistered report fields and measures are still rejected', () => {
  const errors = validateReportView({ name: 'Review', subject: 'purchase_orders', columns: ['password'], measures: ['arbitrary_sql'] });
  assert.equal(errors.length, 2);
});
