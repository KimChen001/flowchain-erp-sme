import test from 'node:test'
import assert from 'node:assert/strict'
import { handleReportsAnalyticsRoute } from './reports-analytics.routes.mjs'
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { permissionCodes } from '../auth/permission-catalog.mjs'

// A reader who may see everything.
const fullReportAccess = reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-any', permissionCodes: new Set(permissionCodes) })

test('POST /api/reports/query returns the governed dashboard contract', async () => {
  let response = null
  const ctx = {
    req: { method: 'POST' }, res: {}, url: new URL('/api/reports/query', 'http://localhost'),
    db: { suppliers: [{ name: '深圳新元电气' }, { name: '华东精工机械' }], products: [], purchaseOrders: [], receivingDocs: [], rfqs: [] },
    async readBody() { return { subject: 'finance', filters: { currency: 'CNY' }, comparison: 'previous_period' } },
    reportReadAccess: fullReportAccess,
    send(_res, status, payload) { response = { status, payload } },
  }
  const handled = await handleReportsAnalyticsRoute(ctx)
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  for (const key of ['kpis', 'charts', 'details', 'columnDefinitions', 'exportRows', 'dataScope']) assert.ok(key in response.payload, `missing ${key}`)
  for (const key of ['currencyCode', 'currencyLabel', 'currencies', 'currencyAggregationStatus']) assert.ok(key in response.payload.dataScope, `missing dataScope.${key}`)
  assert.equal(response.payload.dataScope.currencyCode, 'CNY')
  assert.equal(response.payload.dataScope.currencyAggregationStatus, 'filtered_currency')
})
