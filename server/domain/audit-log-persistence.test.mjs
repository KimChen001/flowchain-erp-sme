import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabaseRepositoryRegistry } from '../repositories/adapter-registry.mjs'
import { createDbAuditLogRepository } from '../repositories/db-audit-log-repository.mjs'
import { DATABASE_CONFIG_ERROR } from '../persistence/persistence-config.mjs'
import { handleAuditLogRoute } from '../routes/audit-log.routes.mjs'
import {
  legacyMutationBlockedAuditEntry,
  recordDatabaseAuditBestEffort,
} from './audit-policy.mjs'

function createDb() {
  return {
    products: [{ sku: 'A100', name: 'Motor A100', currentStock: 4, safetyStock: 10, supplier: 'ABC Components' }],
    suppliers: [{ id: 'SUP-001', name: 'ABC Components', risk: '中', onTimeRate: 90, qualityRate: 96 }],
    purchaseRequests: [{ pr: 'PR-1001', status: '待审批', sourceSku: 'A100', amount: 12000 }],
    purchaseOrders: [{ po: 'PO-1001', supplier: 'ABC Components', status: '已发出', eta: '2026-07-10' }],
    rfqs: [{ id: 'RFQ-1001', status: '进行中', suppliers: 3, quoted: 1 }],
    receivingDocs: [],
    inventoryMovements: [],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
    events: [],
    auditLog: [],
  }
}

function createAiRoute({ repositories } = {}) {
  const db = createDb()
  let response = null
  return {
    ctx: {
      req: { method: 'POST', body: { message: 'supplier SUP-001 status' }, headers: { authorization: 'Bearer user-token' } },
      res: {},
      url: new URL('/api/ai/chat', 'http://localhost'),
      db,
      repositories,
      send(_res, status, payload) {
        response = { status, payload }
      },
      readBody: async (req) => req.body,
      writeDb: async () => {
        throw new Error('JSON audit should not be used in database mode')
      },
      event: () => {
        throw new Error('JSON event should not be used in database mode')
      },
      ensurePurchaseRequests: (nextDb) => nextDb.purchaseRequests || [],
      ensureInventoryMovements: (nextDb) => nextDb.inventoryMovements || [],
      ensureRfqs: (nextDb) => nextDb.rfqs || [],
      supplierPerformance: () => [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 0,
      openaiDispatcher: { dispatch() { throw new Error('provider should not be reached') } },
      arkDispatcher: { dispatch() { throw new Error('ark should not be reached') } },
      aiMaxTokens: 120,
    },
    get response() {
      return response
    },
  }
}

function createAuditRoute({ method = 'GET', path = '/api/audit-log', repositories, db = createDb(), env } = {}) {
  let response = null
  return {
    ctx: {
      req: { method },
      res: {},
      url: new URL(path, 'http://localhost'),
      db,
      env,
      identity: {
        authenticated: true,
        complete: true,
        tenantId: 'tenant-flowchain-sme',
        userId: 'audit-reader',
        roleIds: ['audit-reader-role'],
        permissionCodes: new Set(['audit.read', 'audit.read_sensitive']),
        permissionSourceRoleIds: new Map(),
        readWarehouseIds: new Set(),
        operateWarehouseIds: new Set(),
      },
      repositories,
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

test('legacy mutation blocked audit omits request body and redacts secrets', async () => {
  const writes = []
  const repositories = {
    auditLog: {
      mode: 'database',
      recordAuditEntry: async (entry) => {
        writes.push(entry)
        return entry
      },
    },
  }

  const result = await recordDatabaseAuditBestEffort(
    { repositories },
    legacyMutationBlockedAuditEntry({ method: 'POST', pathname: '/api/purchase-requests' }),
  )

  assert.equal(result.ok, true)
  assert.equal(writes[0].action, 'legacy_mutation_blocked')
  assert.equal(writes[0].entity.id, 'POST /api/purchase-requests')
  assert.doesNotMatch(JSON.stringify(writes), /sourceSku|quantity|authorization|Bearer|DATABASE_URL/)
})

test('best-effort audit entries are attributed to the signed-in tenant and user', async () => {
  const writes = []
  const repositories = {
    auditLog: {
      mode: 'database',
      recordAuditEntry: async (entry) => {
        writes.push(entry)
        return entry
      },
    },
  }
  const identity = { authenticated: true, tenantId: 'tenant-audit', userId: 'user-audit', role: 'manager', email: 'buyer@example.com' }

  await recordDatabaseAuditBestEffort({ repositories, identity }, { module: 'action-drafts', action: 'draft_saved', tenantId: 'tenant-other' })
  await recordDatabaseAuditBestEffort({ repositories, identity: { authenticated: false, tenantId: '', userId: '' } }, { module: 'action-drafts', action: 'draft_previewed' })

  assert.equal(writes[0].tenantId, 'tenant-audit')
  assert.equal(writes[0].actorId, 'user-audit')
  assert.deepEqual(writes[0].actor, { type: 'user', id: 'user-audit', role: 'manager' })
  assert.doesNotMatch(JSON.stringify(writes[0]), /buyer@example\.com/)
  assert.equal('tenantId' in writes[1], false)
  assert.equal('actorId' in writes[1], false)
})

test('audit log read route uses injected repository filters without mutating JSON data', async () => {
  const db = createDb()
  const before = JSON.stringify(db)
  const calls = []
  const repositories = {
    auditLog: {
      listAuditEntries: async (filters) => {
        calls.push(filters)
        return [{ id: 'AUD-ROUTE-1', entityType: filters.entityType, entityId: filters.entityId }]
      },
    },
    settingsRuntime: {
      listSettingsAuditEntries: async () => [],
    },
  }
  const route = createAuditRoute({
    db,
    repositories,
    path: '/api/audit-log?entityType=actionDraft&entityId=DRAFT-AUDIT-1&limit=5',
  })

  assert.equal(await handleAuditLogRoute(route.ctx), true)
  assert.equal(route.response.status, 200)
  assert.deepEqual(calls, [{ tenantId: 'tenant-flowchain-sme', entityType: 'actionDraft', entityId: 'DRAFT-AUDIT-1', limit: 5 }])
  assert.deepEqual(route.response.payload, [{ id: 'AUD-ROUTE-1', entityType: 'actionDraft', entityId: 'DRAFT-AUDIT-1' }])
  assert.equal(JSON.stringify(db), before)
})

test('database audit adapter backs read and write methods with sanitized records', async () => {
  const findCalls = []
  const createCalls = []
  const repositories = createDatabaseRepositoryRegistry({
    db: createDb(),
    env: {
      FLOWCHAIN_PERSISTENCE_MODE: 'database',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
    },
    prisma: {
      auditLog: {
        findMany: async (args) => {
          findCalls.push(args)
          return [{
            id: 'AUD-DB-1',
            tenantId: 'tenant-flowchain-sme',
            source: 'system',
            module: 'action-drafts',
            action: 'draft_saved',
            entityType: 'actionDraft',
            entityId: 'DRAFT-AUDIT-1',
            actorId: null,
            summary: 'Read from DB audit table',
            metadata: { metadata: { safe: true } },
            createdAt: new Date('2026-06-30T00:00:00.000Z'),
          }]
        },
        create: async ({ data }) => {
          createCalls.push(data)
          return { ...data, createdAt: data.createdAt || new Date('2026-06-30T00:00:00.000Z') }
        },
      },
    },
  })
  const route = createAuditRoute({
    repositories: {
      ...repositories,
      settingsRuntime: { listSettingsAuditEntries: async () => [] },
    },
    path: '/api/audit-log?entityType=actionDraft&entityId=DRAFT-AUDIT-1&limit=2',
  })

  assert.equal(await handleAuditLogRoute(route.ctx), true)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload[0].id, 'AUD-DB-1')
  // The entity type matches whatever its case (design audit L16).
  assert.deepEqual(findCalls[0].where, {
    tenantId: 'tenant-flowchain-sme',
    entityType: { equals: 'actionDraft', mode: 'insensitive' },
    entityId: 'DRAFT-AUDIT-1',
  })
  assert.deepEqual(findCalls[0].orderBy, { createdAt: 'desc' })
  assert.equal(findCalls[0].take, 2)

  const record = await repositories.auditLog.recordAuditEntry({
    module: 'action-drafts',
    action: 'draft_saved',
    entity: { type: 'actionDraft', id: 'DRAFT-AUDIT-1' },
    summary: 'Saved with token Bearer secret.token and DATABASE_URL=postgresql://user:pass@db/app',
    metadata: { token: 'Bearer secret.token', nested: { apiKey: 'sk-secret' } },
  })
  const payload = JSON.stringify({ record, createCalls })
  assert.equal(createCalls.length, 1)
  assert.equal(createCalls[0].entityType, 'actionDraft')
  assert.doesNotMatch(payload, /Bearer secret|sk-secret|postgresql:\/\/user:pass|DATABASE_URL=/)
})

test('database audit adapter missing config fails cleanly and best-effort AI audit does not throw', async () => {
  const repository = createDbAuditLogRepository({
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
  })

  await assert.rejects(
    () => repository.listAuditEntries({ entityType: 'actionDraft' }),
    (error) => error.code === DATABASE_CONFIG_ERROR && !/postgresql:\/\/|password|stack/i.test(error.message),
  )
  await assert.rejects(
    () => repository.recordAuditEntry({ action: 'draft_saved', entity: { type: 'actionDraft', id: 'DRAFT-AUDIT-1' } }),
    (error) => error.code === DATABASE_CONFIG_ERROR && !/postgresql:\/\/|password|stack/i.test(error.message),
  )

  const bestEffort = await repository.recordAiEventBestEffort({
    action: 'ai_chat_status_query',
    entity: { type: 'ai', id: 'supplier_status_query' },
    summary: 'Should not throw',
  })
  assert.deepEqual(bestEffort, { ok: false, errorCode: DATABASE_CONFIG_ERROR })
})

test('audit log route is read-only and does not expose route-level audit creation', async () => {
  const route = createAuditRoute({ method: 'POST', path: '/api/audit-log', repositories: {} })

  assert.equal(await handleAuditLogRoute(route.ctx), false)
  assert.equal(route.response, null)
})
