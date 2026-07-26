import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDatabaseRepositoryRegistry,
  createRepositoryRegistry,
  getPersistenceMode,
  PERSISTENCE_MODES,
} from '../repositories/adapter-registry.mjs'

const env = { DATABASE_URL: 'postgresql://localhost/flowchain' }

test('repository registry is PostgreSQL-only', () => {
  const registry = createRepositoryRegistry({ env, prisma: {} })
  assert.equal(registry.mode, PERSISTENCE_MODES.database)
  assert.match(registry.masterData.adapter, /^db-/)
  assert.match(registry.inventoryRead.adapter, /^db-/)
  assert.match(registry.procurementRead.adapter, /^db-/)
  assert.match(registry.auditLog.adapter, /^db-/)
  assert.match(registry.actionDrafts.adapter, /^db-/)
  assert.match(registry.exceptionCases.adapter, /^db-/)
  assert.match(registry.userConfirmedActions.adapter, /^db-/)
  assert.equal(registry.userDataRuntime.adapter, 'disabled-user-data-runtime-v1')
  assert.equal(registry.aiConversation.mode, 'transient-session-context')
})

test('database registry and generic registry have the same authority', () => {
  assert.equal(createDatabaseRepositoryRegistry({ env, prisma: {} }).mode, 'database')
  assert.equal(getPersistenceMode(env), 'database')
})

test('json and unknown persistence modes are rejected', () => {
  assert.throws(() => getPersistenceMode({ FLOWCHAIN_PERSISTENCE_MODE: 'json' }), { code: 'FLOWCHAIN_JSON_PERSISTENCE_REMOVED' })
  assert.throws(() => getPersistenceMode({ FLOWCHAIN_PERSISTENCE_MODE: 'sqlite' }), { code: 'FLOWCHAIN_PERSISTENCE_MODE_UNSUPPORTED' })
})
