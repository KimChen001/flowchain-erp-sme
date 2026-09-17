import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { createDbProcurementRuntimeRepository } from '../repositories/db-procurement-runtime-repository.mjs'
import { handleReportsAnalyticsRoute } from '../routes/reports-analytics.routes.mjs'

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
  const handled = await handleReportsAnalyticsRoute({ req: { method: 'GET' }, res: {}, url: new URL('http://localhost/api/reports/open-purchase-orders?export=true&currency=USD&tenantId=other'), identity: { tenantId: 'tenant-a' }, repositories: { procurementRuntime: { listForReport: async scope => { tenant = scope.tenantId; return [po('A'), po('B', { currency: 'CNY' })] } } }, send: (_res, status, payload) => { response = { status, payload } } })
  assert.equal(handled, true)
  assert.equal(tenant, 'tenant-a')
  assert.equal(response.status, 200)
  assert.equal(response.payload.exportRows.length, 1)
})
