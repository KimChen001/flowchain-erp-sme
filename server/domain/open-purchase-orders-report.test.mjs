import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { createDbProcurementRuntimeRepository } from '../repositories/db-procurement-runtime-repository.mjs'
import { handleReportsAnalyticsRoute } from '../routes/reports-analytics.routes.mjs'
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { permissionCodes } from '../auth/permission-catalog.mjs'

// A reader who may see everything.
const fullReportAccess = reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-any', permissionCodes: new Set(permissionCodes) })

const now = new Date('2026-09-11T10:00:00Z')
const po = (id, extra = {}) => ({ id, supplierName: 'Acme', createdAt: '2026-09-01', expectedDate: '2026-09-09', status: 'issued', currency: 'USD', totalAmount: 125.5, lines: [{ quantity: 10, receivedQuantity: 2, unit: 'pcs' }], ...extra })
const report = (rows, filters = {}) => buildOpenPurchaseOrdersReport(rows, filters, now)

test('invalid filter dates fail explicitly and invalid promise dates remain unknown', () => {
  assert.throws(() => report([], { from: '2026-02-30' }), { status: 422 })
  assert.throws(() => report([], { from: '2026-09-11', to: '2026-09-01' }), { status: 422 })
  const result = report([po('A', { expectedDate: '2026-02-30' })])
  assert.equal(result.rows[0].overdueDays, null)
  assert.equal(result.summary.incomplete, 1)
})

test('pagination, totals, supplier ranking and export cover all 601 matching orders', () => {
  const rows = Array.from({ length: 601 }, (_, index) => po(`PO-${String(index).padStart(4, '0')}`))
  const first = report(rows)
  const last = report(rows, { page: '25', export: 'true' })
  assert.equal(first.rows.length, 25)
  assert.equal(first.total, 601)
  assert.equal(first.summary.open, 601)
  assert.equal(first.summary.totals[0].amount, 601 * 125.5)
  assert.equal(first.overdueSuppliers[0].count, 601)
  assert.equal(last.rows.length, 1)
  assert.equal(last.exportRows.length, 601)
  assert.deepEqual(first.summary, last.summary)
  assert.equal(last.rows[0].id, 'PO-0600')
})

test('overdue uses outstanding line promises, excludes terminal orders and preserves unknowns', () => {
  const result = report([
    po('PO-PARTIAL', { lines: [{ quantity: 10, receivedQuantity: 10, unit: 'pcs', promisedDate: '2026-08-01' }, { quantity: 10, receivedQuantity: 2, unit: 'pcs', promisedDate: '2026-09-10' }] }),
    po('PO-MISSING', { expectedDate: null, lines: [{ quantity: 10, receivedQuantity: null, unit: 'pcs' }] }),
    po('PO-CANCELLED', { status: 'cancelled' }), po('PO-REJECTED', { status: 'rejected' }),
    po('PO-DONE', { lines: [{ quantity: 10, receivedQuantity: 10, unit: 'pcs' }] }),
  ])
  assert.equal(result.total, 2)
  assert.equal(result.rows[0].overdueDays, 1)
  assert.equal(result.rows[0].remaining, 8)
  const missing = result.rows.find(row => row.id === 'PO-MISSING')
  assert.equal(missing.received, null)
  assert.equal(missing.remaining, null)
  assert.equal(missing.overdueDays, null)
  assert.equal(result.summary.incomplete, 1)
})

test('mixed units and currencies are never added together; zero remains a known value', () => {
  const result = report([po('A', { totalAmount: 0 }), po('B', { currency: 'CNY', lines: [{ quantity: 10, receivedQuantity: 1, unit: 'pcs' }, { quantity: 3, receivedQuantity: 0, unit: 'box' }] })])
  assert.deepEqual(result.summary.totals, [{ currency: 'CNY', amount: 125.5 }, { currency: 'USD', amount: 0 }])
  assert.equal(result.rows.find(row => row.id === 'B').remaining, null)
  assert.equal(result.rows.find(row => row.id === 'B').unit, 'mixed')
})

test('filters and sorting apply before paging, ranking and export', () => {
  const rows = [po('A'), po('B', { supplierName: 'Summit', currency: 'CNY' }), po('C', { createdAt: '2026-08-01' }), po('D', { owner: 'Alex', expectedDate: '2026-09-01' })]
  const result = report(rows, { currency: 'USD', supplier: 'Acme', from: '2026-09-01', scope: 'overdue', search: 'Alex', export: 'true' })
  assert.equal(result.total, 1)
  assert.equal(result.rows[0].id, 'D')
  assert.deepEqual(result.rows, result.exportRows)
  assert.equal(result.summary.totals[0].amount, 125.5)
  assert.equal(report(rows, { sort: 'overdueDays', direction: 'desc' }).rows[0].id, 'D')
  assert.equal(report(rows, { page: '999', search: 'nothing' }).page, 1)
})

test('report repository requires tenant scope, retains report fields and has no snapshot row cap', async () => {
  let query
  const repository = createDbProcurementRuntimeRepository({ prisma: { purchaseOrder: { findMany: async input => { query = input; return [{ id: 'P', owner: 'Alex', createdAt: new Date('2026-09-01'), lines: [{ metadata: { promisedDate: '2026-09-10' } }] }] } } } })
  await assert.rejects(repository.listForReport({}), { status: 403 })
  const rows = await repository.listForReport({ tenantId: 'tenant-a' })
  assert.deepEqual(query.where, { tenantId: 'tenant-a' })
  assert.equal(query.take, undefined)
  assert.equal(rows[0].owner, 'Alex')
  assert.equal(rows[0].createdAt, '2026-09-01T00:00:00.000Z')
  assert.equal(rows[0].lines[0].promisedDate, '2026-09-10')
})

test('report route uses authenticated tenant identity and forwards export filters', async () => {
  let response, tenant
  const handled = await handleReportsAnalyticsRoute({ req: { method: 'GET' }, res: {}, url: new URL('http://localhost/api/reports/open-purchase-orders?export=true&currency=USD&tenantId=other'), identity: { tenantId: 'tenant-a' }, reportReadAccess: fullReportAccess, repositories: { procurementRuntime: { listForReport: async scope => { tenant = scope.tenantId; return [po('A'), po('B', { currency: 'CNY' })] } } }, send: (_res, status, payload) => { response = { status, payload } } })
  assert.equal(handled, true)
  assert.equal(tenant, 'tenant-a')
  assert.equal(response.status, 200)
  assert.equal(response.payload.exportRows.length, 1)
})

test('only committed orders with quantity still to receive are open, and only they count toward totals', () => {
  // Regression for the open definition. The report used to treat anything not
  // on a list of closed words as open, so drafts and orders pending approval
  // were counted, their amounts were added to the open total, and a draft past
  // its date produced a phantom overdue supplier. Measured on the seeded
  // reporting workspace this was 18 open orders, of which 8 were drafts or
  // pending approval.
  const rows = [
    po('ISSUED', { supplierName: 'Committed Supplier', totalAmount: 100 }),
    po('DRAFT', { status: 'draft', supplierName: 'Draft Supplier', totalAmount: 1000 }),
    po('PENDING', { status: 'pending_approval', supplierName: 'Pending Supplier', totalAmount: 2000 }),
    po('STALE', { status: 'issued', supplierName: 'Stale Supplier', totalAmount: 4000, lines: [{ quantity: 10, receivedQuantity: 10, unit: 'pcs' }] }),
    po('CANCELLED', { status: 'cancelled', supplierName: 'Cancelled Supplier', totalAmount: 8000 }),
  ]
  const result = report(rows)

  assert.equal(result.summary.open, 1)
  assert.deepEqual(result.rows.map((row) => row.id), ['ISSUED'])
  assert.deepEqual(result.summary.totals, [{ currency: 'USD', amount: 100 }], 'uncommitted and finished amounts are excluded')
  assert.deepEqual(result.overdueSuppliers.map((row) => row.supplier), ['Committed Supplier'], 'a draft past its date is not overdue')

  // Excluded orders are still reachable, just not counted as open.
  const all = report(rows, { scope: 'all' })
  assert.equal(all.total, 5)
  assert.deepEqual(Object.fromEntries(all.rows.map((row) => [row.id, row.isOpen])), { ISSUED: true, DRAFT: false, PENDING: false, STALE: false, CANCELLED: false })
})

test('overdue days count to the tenant calendar day, not the UTC day', () => {
  const due = [po('PO-DUE', { expectedDate: '2026-09-29', lines: [{ quantity: 10, receivedQuantity: 0, unit: 'pcs', promisedDate: '2026-09-29' }] })]
  // 21:30 on Sep 29 in New York is already Sep 30 in UTC: the order is due today, not late.
  const evening = buildOpenPurchaseOrdersReport(due, {}, new Date('2026-09-30T01:30:00Z'), { timeZone: 'America/New_York' })
  assert.equal(evening.asOf, '2026-09-29')
  assert.equal(evening.rows[0].overdueDays, 0)
  assert.equal(evening.summary.overdue, 0)
  // One minute before and after midnight in New York (04:00 UTC during daylight time).
  assert.equal(buildOpenPurchaseOrdersReport(due, {}, new Date('2026-09-30T03:59:00Z'), { timeZone: 'America/New_York' }).rows[0].overdueDays, 0)
  const midnight = buildOpenPurchaseOrdersReport(due, {}, new Date('2026-09-30T04:00:00Z'), { timeZone: 'America/New_York' })
  assert.equal(midnight.asOf, '2026-09-30')
  assert.equal(midnight.rows[0].overdueDays, 1)
  // A tenant on UTC is already a day late at 01:30 UTC.
  assert.equal(buildOpenPurchaseOrdersReport(due, {}, new Date('2026-09-30T01:30:00Z'), { timeZone: 'UTC' }).rows[0].overdueDays, 1)
  // Without a stored timezone the workspace default (America/New_York) applies.
  assert.equal(buildOpenPurchaseOrdersReport(due, {}, new Date('2026-09-30T01:30:00Z')).asOf, '2026-09-29')
})

test('the open purchase orders route counts overdue to the tenant timezone', async () => {
  let response
  await handleReportsAnalyticsRoute({ req: { method: 'GET' }, res: {}, url: new URL('http://localhost/api/reports/open-purchase-orders'), identity: { tenantId: 'tenant-a' }, reportReadAccess: fullReportAccess, reportNow: new Date('2026-09-30T01:30:00Z'), tenantTimezone: 'Asia/Shanghai', repositories: { procurementRuntime: { listForReport: async () => [] } }, send: (_res, status, payload) => { response = { status, payload } } })
  assert.equal(response.status, 200)
  assert.equal(response.payload.asOf, '2026-09-30')
  assert.equal(response.payload.timezone, 'Asia/Shanghai')
})
