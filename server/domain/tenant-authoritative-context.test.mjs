import test from 'node:test'
import assert from 'node:assert/strict'
import { issueLocalSessionToken, resolveRequestIdentity } from './local-signed-session.mjs'

const storeWith = (sessions = {}) => ({ resolve: async sid => sessions[sid] || null })

test('signed identity owns tenant context and ignores forged tenant headers', async () => {
  const env = { FLOWCHAIN_DEFAULT_TENANT_ID: 'tenant-server-owned' }
  const secret = 'tenant-test-secret'
  const session = { sessionId: 'sid-manager', userId: 'USR-manager', tenantId: 'tenant-server-owned', name: 'Manager', email: 'manager@example.com', role: 'manager', expiresAtMs: Date.now() + 60_000 }
  const token = issueLocalSessionToken(session, secret)
  const identity = await resolveRequestIdentity({
    headers: {
      authorization: `Bearer ${token}`,
      'x-flowchain-tenant': 'tenant-forged',
      'x-flowchain-role': 'viewer',
    },
  }, storeWith({ [session.sessionId]: session }), secret, env)

  assert.equal(identity.authenticated, true)
  assert.equal(identity.tenantId, 'tenant-server-owned')
  assert.equal(identity.role, 'manager')
})

test('test identity headers still use only the server tenant default', async () => {
  const identity = await resolveRequestIdentity({
    headers: {
      'x-flowchain-user': 'test-manager',
      'x-flowchain-role': 'manager',
      'x-flowchain-tenant': 'tenant-forged',
    },
  }, storeWith(), 'secret', {
    NODE_ENV: 'test',
    FLOWCHAIN_DEFAULT_TENANT_ID: 'tenant-test-server',
  })

  assert.equal(identity.tenantId, 'tenant-test-server')
  assert.equal(identity.userId, 'test-manager')
})
