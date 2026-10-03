import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGovernedReport, getReportCatalog, reportMetricCatalog } from './report-semantic-layer.mjs'
import { canChangeReportView, canSeeReportView, reportViewActor, reportViewAuditSummary, validateReportView } from '../repositories/report-view-repository.mjs'

const db = {
  salesOrders: [
    { id: 'SO-TEST-001', customer: '华南自动化设备有限公司', orderDate: '2026-06-01', amount: 120000, currency: 'CNY', status: 'confirmed' },
    { id: 'SO-TEST-002', customer: '华东精密制造有限公司', orderDate: '2026-03-01', amount: 80000, currency: 'CNY', status: 'confirmed' },
  ],
}

test('governed catalog exposes controlled subjects fields and metrics', () => {
  const catalog = getReportCatalog()
  for (const subject of ['purchase_orders', 'purchase_requests', 'rfqs', 'receiving', 'supplier_invoices', 'three_way_matches', 'sales_orders', 'deliveries', 'receipts', 'inventory_balances', 'inventory_movements', 'suppliers']) assert.ok(catalog.subjects.some((item) => item.id === subject), subject)
  // Frozen settlement and reconciliation subjects are not offered.
  for (const subject of ['reconciliation', 'settlement']) assert.ok(!catalog.subjects.some((item) => item.id === subject), subject)
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

// Persistence, tenants and audit rows are covered against PostgreSQL in
// tests/postgres/report-views.test.mjs; these are the pure rules.
test('saved report views validate fields against the governed catalog', () => {
  assert.deepEqual(validateReportView({ name: '华东逾期采购订单', subject: 'purchase_orders', sourceRoute: '/app/reports/procurement', columns: ['id', 'supplier', 'amount'], measures: ['purchase_order_amount'], visibility: 'private' }), [])
  assert.deepEqual(validateReportView({ name: '', subject: 'payroll', visibility: 'public' }), ['name is required', 'unknown report subject', 'visibility must be private or team'])
  assert.deepEqual(validateReportView({ name: 'Review', subject: 'purchase_orders', columns: 'id', filters: ['x'] }), ['columns must be a list', 'filters must be an object'])
})

test('saved report view visibility comes from ownership and the workspace permission, not legacy roles', () => {
  const actorWith = (userId, permissions = []) => reportViewActor({ authenticated: true, complete: true, tenantId: 'tenant-a', user: { id: userId, name: userId }, role: 'manager', permissionCodes: new Set(permissions), roleIds: [], permissionSourceRoleIds: new Map() })
  const owner = actorWith('owner'), member = actorWith('member'), admin = actorWith('admin', ['settings.workspace.manage'])
  assert.deepEqual([owner.canManageTeamViews, admin.canManageTeamViews], [false, true])
  const privateView = { viewId: 'RV-1', ownerId: 'owner', visibility: 'private' }
  const teamView = { viewId: 'RV-2', ownerId: 'owner', visibility: 'team' }
  assert.deepEqual([owner, member, admin].map((actor) => canSeeReportView(privateView, actor)), [true, false, false])
  assert.deepEqual([owner, member, admin].map((actor) => canSeeReportView(teamView, actor)), [true, true, true])
  assert.deepEqual([owner, member, admin].map((actor) => canChangeReportView(privateView, actor)), [true, false, false])
  assert.deepEqual([owner, member, admin].map((actor) => canChangeReportView(teamView, actor)), [true, false, true])
  assert.throws(() => reportViewActor({ authenticated: false, tenantId: 'tenant-a', user: { id: 'owner' } }), { status: 401 })
  assert.throws(() => reportViewActor({ authenticated: true, tenantId: '', user: { id: 'owner' } }), { status: 401 })
})

test('saved report view audit summaries name a private view by id only', () => {
  assert.equal(reportViewAuditSummary({ viewId: 'RV-1', name: 'Supplier exit plan', visibility: 'private' }, 'report_view_created'), 'Report view RV-1 created')
  assert.equal(reportViewAuditSummary({ viewId: 'RV-1', name: 'Supplier exit plan', visibility: 'private' }, 'report_view_unshared'), 'Report view RV-1 made private')
  assert.equal(reportViewAuditSummary({ viewId: 'RV-2', name: 'Open orders', visibility: 'team' }, 'report_view_shared'), 'Report view "Open orders" shared with the team')
})
