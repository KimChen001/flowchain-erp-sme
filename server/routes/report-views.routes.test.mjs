import assert from 'node:assert/strict'
import test from 'node:test'
import { handleReportViewsRoute } from './report-views.routes.mjs'

// Requests that never reach the database. The rest of the route runs against
// PostgreSQL in tests/postgres/report-views.test.mjs.
function call(pathname, { method = 'GET', identity, headers = {} } = {}) {
  let sent = null
  const prisma = new Proxy({}, { get() { throw new Error('The database must not be touched.') } })
  const ctx = {
    req: { method, headers }, res: {}, url: new URL(`http://local${pathname}`), identity, reportViewsPrisma: prisma,
    readBody: async () => ({}), send: (_res, status, payload) => { sent = { status, payload } },
  }
  return handleReportViewsRoute(ctx).then((handled) => ({ handled, sent }))
}

test('other paths and methods fall through without resolving an actor', async () => {
  for (const [pathname, method] of [['/api/reports/catalog', 'GET'], ['/api/report-views-extra', 'GET'], ['/api/report-views', 'DELETE'], ['/api/report-views/RV-1/clone', 'GET'], ['/api/report-views/RV-1/rename', 'POST']]) {
    assert.deepEqual(await call(pathname, { method }), { handled: false, sent: null }, `${method} ${pathname}`)
  }
})

test('saved views need a signed-in workspace session; legacy role headers grant nothing', async () => {
  const headers = { 'x-flowchain-role': 'admin', 'x-flowchain-user': 'someone-else' }
  for (const identity of [undefined, { authenticated: false, tenantId: 'tenant-a', userId: 'u1' }, { authenticated: true, tenantId: ' ', userId: 'u1', role: 'admin' }]) {
    const { handled, sent } = await call('/api/report-views', { identity, headers })
    assert.equal(handled, true)
    assert.equal(sent.status, 401)
    assert.equal(sent.payload.code, 'AUTHENTICATION_REQUIRED')
  }
})
