import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPersistenceMode } from '../repositories/adapter-registry.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('missing DATABASE_URL fails with stable startup code', () => {
  assert.throws(
    () => validateDatabasePersistenceConfig({}),
    (error) => error.code === 'FLOWCHAIN_DATABASE_URL_REQUIRED' && error.message === 'FLOWCHAIN_DATABASE_URL_REQUIRED',
  )
})

test('legacy json persistence mode is rejected', () => {
  assert.throws(
    () => getPersistenceMode({ FLOWCHAIN_PERSISTENCE_MODE: 'json' }),
    (error) => error.code === 'FLOWCHAIN_JSON_PERSISTENCE_REMOVED',
  )
})

test('configured runtime is always PostgreSQL', () => {
  assert.equal(getPersistenceMode({ DATABASE_URL: 'postgresql://localhost/flowchain' }), 'database')
  assert.deepEqual(
    validateDatabasePersistenceConfig({ DATABASE_URL: 'postgresql://localhost/flowchain' }),
    { mode: 'database', databaseConfigured: true, databaseUrl: 'postgresql://localhost/flowchain' },
  )
})

test('production composition root has no JSON bootstrap or write path', async () => {
  const source = await readFile(path.join(root, 'server', 'routes', 'scm-legacy.routes.mjs'), 'utf8')
  assert.doesNotMatch(source, /createJsonDb|scm-demo\.json|jsonDb|runtimeFileMutex|writeDb\s*\(/)
})

test('production route sources do not instantiate JSON repositories', async () => {
  const files = [
    'server/routes/master-data.routes.mjs',
    'server/routes/inventory.routes.mjs',
    'server/routes/procurement-read.routes.mjs',
    'server/routes/procurement-workflow.routes.mjs',
    'server/routes/action-drafts.routes.mjs',
  ]
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(source, /createJson|json-.*repository|data\/.*\.json|writeDb\s*\(/, file)
  }
})
