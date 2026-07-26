import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGovernedReport, getReportCatalog, reportMetricCatalog } from './report-semantic-layer.mjs'
import { cloneReportView, createReportView, deleteReportView, listReportViews, updateReportView } from '../repositories/report-view-repository.mjs'

const db = {
  salesOrders: [
    { id: 'SO-TEST-001', customer: '华南自动化设备有限公司', orderDate: '2026-06-01', amount: 120000, currency: 'CNY', status: 'confirmed' },
    { id: 'SO-TEST-002', customer: '华东精密制造有限公司', orderDate: '2026-03-01', amount: 80000, currency: 'CNY', status: 'confirmed' },
  ],
}
const analyst = { id: 'analyst-1', name: '分析员', role: 'analyst' }
const manager = { id: 'manager-1', name: '经理', role: 'manager' }

test('governed catalog exposes controlled subjects fields and metrics', () => {
  const catalog = getReportCatalog()
  for (const subject of ['purchase_orders', 'purchase_requests', 'rfqs', 'receiving', 'supplier_invoices', 'three_way_matches', 'reconciliation', 'settlement', 'sales_orders', 'deliveries', 'receipts', 'inventory_balances', 'inventory_movements', 'suppliers']) assert.ok(catalog.subjects.some((item) => item.id === subject), subject)
  assert.ok(catalog.fields.purchase_orders.every((field) => field.enabledForReporting && field.exportable))
  assert.ok(reportMetricCatalog.every((metric) => metric.version && metric.drilldownPath && metric.applicableFilters.length))
})
test('filters change KPI chart details and export through one query path', () => {
  const all = buildGovernedReport(db, { subject: 'sales', filters: { from: '2026-01-01', to: '2026-07-11', currency: 'CNY' } })
  const filtered = buildGovernedReport(db, { subject: 'sales', filters: { from: '2026-05-01', to: '2026-07-11', customer: '华南自动化设备有限公司', currency: 'CNY' } })
  assert.notEqual(all.kpis.find((item) => item.id === 'sales_order_amount').value, filtered.kpis.find((item) => item.id === 'sales_order_amount').value)
  assert.ok(filtered.charts.some((chart) => (chart.data || chart.series || []).length > 0))
  assert.ok(filtered.charts.every((chart) => (chart.data || chart.series || []).length > 0 || chart.emptyState))
  assert.equal(filtered.details.length, filtered.exportRows.length)
  assert.ok(filtered.details.every((row) => row.date >= '2026-05-01' && row.customer === '华南自动化设备有限公司'))
})

test('saved report views validate fields and enforce sharing permissions', () => {
  const created = createReportView({ name: '华东逾期采购订单', subject: 'purchase_orders', sourceRoute: '/app/reports/procurement', columns: ['id', 'supplier', 'amount'], measures: ['purchase_order_amount'], visibility: 'private' }, analyst)
  assert.equal(created.ok, true)
  assert.equal(updateReportView(created.view.viewId, { visibility: 'team' }, analyst).status, 403)
  assert.equal(updateReportView(created.view.viewId, { visibility: 'team' }, manager).ok, true)
  const cloned = cloneReportView(created.view.viewId, {}, analyst)
  assert.equal(cloned.view.visibility, 'private')
  assert.ok(listReportViews(analyst).some((view) => view.viewId === created.view.viewId))
  assert.equal(deleteReportView(cloned.view.viewId, analyst).deleted, true)
})
