import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPersistenceMode } from '../repositories/adapter-registry.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'
import { handleRfqsRoute } from '../routes/rfqs.routes.mjs'
import { handleInventoryMovementsRoute } from '../routes/inventory-movements.routes.mjs'
import { handleRuntimeCapabilityRoute } from '../routes/runtime-capability.routes.mjs'
import { ROUTE_CLASSES, classifyRoute } from './route-classification.mjs'
import { runtimeRouteAuthority } from './runtime-route-authority.mjs'

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
  const source = await readFile(path.join(root, 'server', 'bootstrap', 'scm-server.mjs'), 'utf8')
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

test('all production server sources exclude legacy JSON runtime wiring', async () => {
  const serverRoot = path.join(root, 'server')
  const files = (await readdir(serverRoot, { recursive: true }))
    .filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs') && !file.includes('test-fixtures'))
  for (const file of files) {
    const source = await readFile(path.join(serverRoot, file), 'utf8')
    assert.doesNotMatch(source, /scm-demo\.json|createJsonDb|createJsonRepository|json-.*repository|runtime-file-mutex|\bwriteDb\b/, file)
  }
})

test('production frontend excludes demo business-data imports', async () => {
  const srcRoot = path.join(root, 'src')
  const files = (await readdir(srcRoot, { recursive: true }))
    .filter((file) => /\.(?:ts|tsx)$/.test(file) && !file.startsWith(`design-preview${path.sep}`))
  for (const file of files) {
    const source = await readFile(path.join(srcRoot, file), 'utf8')
    assert.doesNotMatch(source, /data\/demo-data|scm-demo\.json/, file)
  }
})

test('runtime scripts do not configure removed file-backed repositories', async () => {
  const scriptsRoot = path.join(root, 'scripts')
  const files = (await readdir(scriptsRoot, { recursive: true }))
    .filter((file) => file.endsWith('.mjs'))
  for (const file of files) {
    const source = await readFile(path.join(scriptsRoot, file), 'utf8')
    assert.doesNotMatch(
      source,
      /FLOWCHAIN_(?:INVENTORY|SALES|ITEM|SUPPLIER|CUSTOMER|PROCUREMENT|SETTINGS)_RUNTIME_FILE|FLOWCHAIN_ENABLE_LEGACY_PROCUREMENT_RUNTIME/,
      file,
    )
  }
})

function routeContext(handler, method, pathname, repositories = {}, identity = { authenticated: true, tenantId: 'tenant-empty' }) {
  let response = null
  const ctx = {
    req: { method },
    res: {},
    url: new URL(pathname, 'http://localhost'),
    repositories,
    identity,
    send(_res, status, payload) {
      response = { status, payload }
      return true
    },
  }
  return Promise.resolve(handler(ctx)).then((handled) => ({ handled, response }))
}

test('empty authoritative RFQ and inventory repositories return honest empty collections', async () => {
  const calls = []
  const repositories = {
    procurementRead: {
      listDocuments: async (filters) => {
        calls.push(['rfq', filters])
        return []
      },
    },
    inventoryRead: {
      listMovements: async (filters) => {
        calls.push(['inventory', filters])
        return []
      },
    },
  }
  const rfqs = await routeContext(handleRfqsRoute, 'GET', '/api/rfqs', repositories)
  const movements = await routeContext(handleInventoryMovementsRoute, 'GET', '/api/inventory-movements', repositories)

  assert.equal(rfqs.handled, true)
  assert.deepEqual(rfqs.response, { status: 200, payload: [] })
  assert.equal(JSON.stringify(rfqs.response).includes('RFQ-26-0042'), false)
  assert.equal(movements.handled, true)
  assert.deepEqual(movements.response, { status: 200, payload: [] })
  assert.deepEqual(calls, [
    ['rfq', { type: 'rfq', tenantId: 'tenant-empty' }],
    ['inventory', { tenantId: 'tenant-empty', q: '', status: '', warehouse: '', limit: '' }],
  ])
})

test('PostgreSQL business reads fail closed without authentication or repository authority', async () => {
  const unauthenticated = await routeContext(handleRfqsRoute, 'GET', '/api/rfqs', {}, { authenticated: false })
  const unavailableRfq = await routeContext(handleRfqsRoute, 'GET', '/api/rfqs')
  const unavailableMovement = await routeContext(handleInventoryMovementsRoute, 'GET', '/api/inventory-movements')

  assert.equal(unauthenticated.response.status, 401)
  assert.equal(unavailableRfq.response.status, 503)
  assert.equal(unavailableRfq.response.payload.code, 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE')
  assert.equal(unavailableMovement.response.status, 503)
  assert.equal(unavailableMovement.response.payload.code, 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE')
})

test('audited non-authoritative routes are explicitly classified and fail closed', async () => {
  for (const route of runtimeRouteAuthority) {
    assert.equal(classifyRoute(route.method, route.pathname).classification, ROUTE_CLASSES.capabilityDisabled, `${route.method} ${route.pathname}`)
    const result = await routeContext(handleRuntimeCapabilityRoute, route.method, route.pathname)
    assert.equal(result.handled, true)
    assert.equal(result.response.status, 501)
    assert.equal(result.response.payload.code, 'FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED')
    assert.equal(result.response.payload.capability, route.capability)
    assert.equal(typeof result.response.payload.message, 'string')
    assert.ok(result.response.payload.message.length > 0)
    assert.ok(Array.isArray(result.response.payload.limitations))
    assert.ok(result.response.payload.limitations.length > 0)
  }
})

test('known runtime fixture symbols and identifiers are absent from production source', async () => {
  const productionRoots = [path.join(root, 'server'), path.join(root, 'src')]
  const forbidden = [
    /\bdefaultRfqs\b/,
    /\bmrpProfiles\b/,
    /\bbomMaster\b/,
    /\bconst\s+supplierQuotes\b/,
    /\bconst\s+supplierCapacityCalendar\b/,
    /\bconst\s+contractPriceRules\b/,
    /\bconst\s+exchangeRatesToCny\b/,
    /\bRFQ-26-0042\b/,
  ]
  for (const productionRoot of productionRoots) {
    const files = (await readdir(productionRoot, { recursive: true }))
      .filter((file) => /\.(?:mjs|js|ts|tsx|json)$/.test(file))
      .filter((file) => !file.endsWith('.test.mjs'))
      .filter((file) => !file.includes(`test-fixtures${path.sep}`))
      .filter((file) => !file.startsWith(`design-preview${path.sep}`))
    for (const file of files) {
      const source = await readFile(path.join(productionRoot, file), 'utf8')
      for (const pattern of forbidden) assert.doesNotMatch(source, pattern, file)
    }
  }
})

test('runtime initialization modules contain no embedded business rows', async () => {
  const emptyModules = [
    'src/data/empty-business-state.ts',
    'src/data/master-data.ts',
    'src/data/settlement.ts',
    'src/modules/inventory/warningData.ts',
    'src/modules/inventory/adjustmentData.ts',
    'src/modules/sales/deliveryData.ts',
    'src/modules/sales/returnData.ts',
    'src/modules/sales/receiptData.ts',
    'src/modules/ai-assistant/ai-insights.ts',
  ]
  for (const file of emptyModules) {
    const source = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(source, /=\s*\[\s*\{/, file)
    assert.doesNotMatch(source, /:\s*\[\s*\{/, file)
  }
})

test('business fixture artifacts are confined to test-fixtures or design-preview', async () => {
  const candidates = [
    ...(await readdir(path.join(root, 'server'), { recursive: true })).map((file) => path.join('server', file)),
    ...(await readdir(path.join(root, 'src'), { recursive: true })).map((file) => path.join('src', file)),
  ].filter((file) => /(?:fixture|scenario)\.(?:json|mjs|ts|tsx)$/i.test(file))

  for (const file of candidates) {
    assert.match(file, /(?:test-fixtures|design-preview)/, file)
  }
})
