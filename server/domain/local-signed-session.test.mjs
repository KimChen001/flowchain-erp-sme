import test from 'node:test'
import assert from 'node:assert/strict'
import { issueLocalSessionToken, normalizedRole, resolveRequestIdentity, verifyLocalSessionToken } from './local-signed-session.mjs'

// Stands in for the database-backed store in server/auth/workspace-sessions.mjs.
const storeWith = (sessions = {}) => ({ resolve: async sid => sessions[sid] || null })
const storedSession = { sessionId: 'sid-1', userId: 'USR-owner', tenantId: 'tenant-a', name: 'Owner', email: 'owner@example.com', role: 'manager', expiresAtMs: Date.now() + 60_000 }

test('local session token is signed, expires, and resolves the stored session role', async () => {
  const secret = 'test-secret'; const now = Date.now()
  const token = issueLocalSessionToken({ sessionId: 'sid-1' }, secret, { now, ttlSeconds: 60 })
  assert.equal(verifyLocalSessionToken(token, secret, { now }).valid, true)
  assert.equal(verifyLocalSessionToken(`${token}x`, secret, { now }).reason, 'invalid_signature')
  assert.equal(verifyLocalSessionToken(token, secret, { now: now + 61_000 }).reason, 'expired_token')
  const identity = await resolveRequestIdentity({ headers: { authorization: `Bearer ${token}`, 'x-flowchain-role': 'admin' } }, storeWith({ 'sid-1': storedSession }), secret, {})
  assert.equal(identity.role, 'manager')
  assert.equal(identity.source, 'local_signed_session')
  assert.equal(identity.userId, 'USR-owner')
})

test('a validly signed token without a live stored session is not signed in', async () => {
  const token = issueLocalSessionToken({ sessionId: 'sid-revoked' }, 'secret')
  const identity = await resolveRequestIdentity({ headers: { authorization: `Bearer ${token}` } }, storeWith(), 'secret', {})
  assert.equal(identity.authenticated, false)
  assert.equal(identity.source, 'invalid_session')
})

test('an unsigned request never reaches the session store', async () => {
  const store = { resolve: async () => { throw new Error('store must not be read') } }
  assert.equal((await resolveRequestIdentity({ headers: {} }, store, 'secret', {})).source, 'anonymous')
  assert.equal((await resolveRequestIdentity({ headers: { authorization: 'Bearer forged.token' } }, store, 'secret', {})).source, 'invalid_session')
})

test('identity headers are rejected by default and accepted only in explicit test mode', async () => {
  const req = { headers: { 'x-flowchain-user': 'forged', 'x-flowchain-role': 'admin' } }
  assert.equal((await resolveRequestIdentity(req, storeWith(), 'secret', {})).role, 'viewer')
  assert.equal((await resolveRequestIdentity(req, storeWith(), 'secret', { FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: 'true' })).role, 'admin')
})

test('authoritative specialist roles survive signed-session normalization', () => {
  assert.equal(normalizedRole('finance-specialist'), 'finance-specialist')
  assert.equal(normalizedRole('business-specialist'), 'business-specialist')
  assert.equal(normalizedRole('buyer'), 'buyer')
})
