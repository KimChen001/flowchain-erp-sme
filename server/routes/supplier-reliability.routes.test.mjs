import test from 'node:test'
import assert from 'node:assert/strict'
import { supplierReliabilityErrorSchema } from '../../shared/supplier-reliability-contract.mjs'
import { handleSupplierReliabilityRoute } from './supplier-reliability.routes.mjs'

function call({ method = 'GET', path = '/api/master-data/supplier-reliability', identity = { authenticated: true, tenantId: 't1', userId: 'u1' }, service } = {}) {
  const sent = []
  const ctx = { req: { method }, res: {}, url: new URL(`http://local${path}`), identity, send: (_res, status, body) => sent.push({ status, body }), supplierReliabilityService: service }
  return handleSupplierReliabilityRoute(ctx).then((handled) => ({ handled, sent }))
}

test('the reliability route answers for the signed-in reader with what the service read', async () => {
  let asked
  const { handled, sent } = await call({ service: { read: async (context) => { asked = context; return { suppliers: {} } } } })
  assert.equal(handled, true)
  assert.deepEqual(sent, [{ status: 200, body: { suppliers: {} } }])
  assert.deepEqual(asked, { identity: { authenticated: true, tenantId: 't1', userId: 'u1' } })
})

test('signed out is 401, and a failure is a flat unavailable error without its detail', async () => {
  const signedOut = await call({ identity: { authenticated: false } })
  assert.equal(signedOut.sent[0].status, 401)
  assert.ok(supplierReliabilityErrorSchema.safeParse(signedOut.sent[0].body).success)
  const failed = await call({ service: { read: async () => { throw new Error('connection refused at 10.0.0.4') } } })
  assert.equal(failed.sent[0].status, 500)
  assert.equal(failed.sent[0].body.code, 'SUPPLIER_RELIABILITY_UNAVAILABLE')
  assert.equal(JSON.stringify(failed.sent[0].body).includes('10.0.0.4'), false)
})

test('other paths and methods are left to the next route', async () => {
  assert.equal((await call({ method: 'POST' })).handled, false)
  assert.equal((await call({ path: '/api/master-data/supplier-insights' })).handled, false)
})
