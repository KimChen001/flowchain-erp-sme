import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabaseRepositoryRegistry, createRepositoryRegistry } from '../repositories/adapter-registry.mjs'
import { createDbActionDraftRepository } from '../repositories/db-action-draft-repository.mjs'
import { handleActionDraftsRoute } from '../routes/action-drafts.routes.mjs'
import { DATABASE_CONFIG_ERROR } from '../persistence/persistence-config.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createDb() {
  return {
    products: [{ sku: 'A100', name: 'Motor A100', currentStock: 4, safetyStock: 10, supplier: 'ABC Components' }],
    suppliers: [{ id: 'SUP-1', name: 'ABC Components' }],
    purchaseRequests: [],
    rfqs: [],
    purchaseOrders: [],
    receivingDocs: [],
  }
}

const signedIn = { authenticated: true, tenantId: 'tenant-draft-owner', userId: 'user-draft-owner', role: 'manager', source: 'test' }
const anonymous = { authenticated: false, tenantId: '', userId: '', role: 'viewer', source: 'anonymous' }

function databaseRepositories(writes, db = createDb()) {
  return createDatabaseRepositoryRegistry({
    db,
    env: {
      FLOWCHAIN_PERSISTENCE_MODE: 'database',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
    },
    prisma: {
      actionDraft: {
        create: async ({ data, include }) => {
          writes.push({ data, include })
          return {
            ...data,
            createdAt: new Date('2026-06-30T00:00:00.000Z'),
            updatedAt: new Date('2026-06-30T00:00:00.000Z'),
            validations: [],
            auditTrail: [],
          }
        },
      },
    },
  })
}

function createRouteContext({ method = 'POST', pathname = '/api/action-drafts', body = {}, db = createDb(), repositories, identity = signedIn } = {}) {
  let response = null
  let wrote = false
  return {
    ctx: {
      req: { method, body },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      repositories,
      identity,
      send(_res, status, payload) {
        response = { status, payload }
      },
      readBody: async (req) => req.body,
      writeDb: async () => { wrote = true },
    },
    get response() {
      return response
    },
    get wrote() {
      return wrote
    },
  }
}

function draft() {
  return {
    id: 'DRAFT-SAVE-1',
    tenantId: 'tenant-flowchain-sme',
    type: 'purchase_request_draft',
    title: 'Purchase request draft',
    status: 'preview',
    source: 'test',
    requiresConfirmation: true,
    confirmationBoundary: { previewOnly: true, submitted: false },
    originEvidence: [{ type: 'inventory_item', id: 'A100' }],
    payload: { itemIdOrSku: 'A100', quantity: 10 },
    validation: { ok: true, missingFields: [], warnings: [], errors: [] },
    auditTrail: [{ action: 'ai_draft_prepared', summary: 'Prepared draft' }],
  }
}

test('action draft preview route remains non-mutating and never calls persistDraft', async () => {
  const db = createDb()
  const before = clone(db)
  const repositories = {
    actionDrafts: {
      getSchema: () => ({}),
      previewDraft: () => ({ ok: true, draft: draft() }),
      persistDraft: async () => {
        throw new Error('persistDraft should not run for preview')
      },
    },
  }
  const route = createRouteContext({
    pathname: '/api/action-drafts/preview',
    body: { type: 'purchase_request_draft', payload: { itemIdOrSku: 'A100', quantity: 10 } },
    db,
    repositories,
  })

  assert.equal(await handleActionDraftsRoute(route.ctx), true)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.previewOnly, true)
  assert.equal(route.wrote, false)
  assert.deepEqual(db, before)
})

test('removed JSON mode fails before an action draft repository can be used', () => {
  const db = createDb()
  const before = clone(db)
  assert.throws(
    () => createRepositoryRegistry({ db, env: { FLOWCHAIN_PERSISTENCE_MODE: 'json' } }),
    { code: 'FLOWCHAIN_JSON_PERSISTENCE_REMOVED' },
  )
  assert.deepEqual(db, before)
})

test('database mode save route persists only the action draft shell', async () => {
  const writes = []
  const prisma = {
    actionDraft: {
      create: async ({ data, include }) => {
        writes.push({ data, include })
        return {
          ...data,
          createdAt: new Date('2026-06-30T00:00:00.000Z'),
          updatedAt: new Date('2026-06-30T00:00:00.000Z'),
          validations: [{ id: `${data.id}-VAL`, ok: true, missingFields: [], warnings: [], errors: [] }],
          auditTrail: [{ id: `${data.id}-AUD`, action: 'ai_draft_prepared', summary: 'Prepared draft' }],
        }
      },
    },
  }
  const db = createDb()
  const before = clone(db)
  const repositories = createDatabaseRepositoryRegistry({
    db,
    env: {
      FLOWCHAIN_PERSISTENCE_MODE: 'database',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
    },
    prisma,
  })
  const route = createRouteContext({ db, repositories, body: { draft: draft() } })

  assert.equal(await handleActionDraftsRoute(route.ctx), true)
  assert.equal(route.response.status, 201)
  assert.equal(route.response.payload.persisted, true)
  assert.equal(route.response.payload.createsBusinessDocument, false)
  assert.equal(route.response.payload.draft.id, 'DRAFT-SAVE-1')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].data.type, 'purchase_request_draft')
  assert.deepEqual(db, before)
})

test('saving an action draft requires a signed-in user and writes nothing otherwise', async () => {
  const writes = []
  for (const identity of [anonymous, { ...signedIn, tenantId: '' }, null]) {
    const route = createRouteContext({ repositories: databaseRepositories(writes), body: { draft: draft() }, identity })
    assert.equal(await handleActionDraftsRoute(route.ctx), true)
    assert.equal(route.response.status, 401)
    assert.equal(route.response.payload.code, 'AUTHENTICATION_REQUIRED')
  }
  assert.equal(writes.length, 0)
})

test('a saved action draft belongs to the signed-in tenant and user, whatever the body says', async () => {
  const writes = []
  const route = createRouteContext({
    repositories: databaseRepositories(writes),
    body: { draft: { ...draft(), tenantId: 'tenant-someone-else', createdById: 'user-someone-else' } },
  })

  assert.equal(await handleActionDraftsRoute(route.ctx), true)
  assert.equal(route.response.status, 201)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].data.tenantId, 'tenant-draft-owner')
  assert.equal(writes[0].data.createdById, 'user-draft-owner')
  assert.equal(route.response.payload.draft.tenantId, 'tenant-draft-owner')
})

test('the draft repository refuses to write or read without a tenant instead of guessing one', async () => {
  const writes = []
  const repository = databaseRepositories(writes).actionDrafts
  await assert.rejects(
    () => repository.persistDraft({ ...draft(), tenantId: '' }),
    (error) => error.status === 400 && error.code === 'FLOWCHAIN_ACTION_DRAFT_TENANT_REQUIRED',
  )
  await assert.rejects(
    () => repository.getDraft('DRAFT-SAVE-1'),
    (error) => error.code === 'FLOWCHAIN_ACTION_DRAFT_TENANT_REQUIRED',
  )
  assert.equal(writes.length, 0)
})

test('an unexpected persistence error is left to the sanitizing error boundary, not echoed', async () => {
  const repositories = createDatabaseRepositoryRegistry({
    db: createDb(),
    env: {
      FLOWCHAIN_PERSISTENCE_MODE: 'database',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
    },
    prisma: {
      actionDraft: {
        create: async () => {
          throw Object.assign(new Error('\nInvalid `prisma.actionDraft.create()` invocation:\n\nUnique constraint failed on the fields: (`id`)'), { code: 'P2002' })
        },
      },
    },
  })
  const route = createRouteContext({ repositories, body: { draft: draft() } })

  await assert.rejects(() => handleActionDraftsRoute(route.ctx), (error) => error.code === 'P2002')
  assert.equal(route.response, null)
})

test('database mode save route returns clean config error without DATABASE_URL', async () => {
  const db = createDb()
  const route = createRouteContext({
    db,
    repositories: createRepositoryRegistry({ db, env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' } }),
    body: { draft: draft() },
  })

  assert.equal(await handleActionDraftsRoute(route.ctx), true)
  assert.equal(route.response.status, 500)
  assert.deepEqual(route.response.payload, {
    error: DATABASE_CONFIG_ERROR,
    code: DATABASE_CONFIG_ERROR,
  })
  assert.doesNotMatch(JSON.stringify(route.response.payload), /stack|postgres|password/)
})

test('database mode save route rejects unsupported draft type before writing', async () => {
  const writes = []
  const db = createDb()
  const before = clone(db)
  const repositories = createDatabaseRepositoryRegistry({
    db,
    env: {
      FLOWCHAIN_PERSISTENCE_MODE: 'database',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
    },
    prisma: {
      actionDraft: {
        create: async ({ data }) => {
          writes.push(data)
          return data
        },
      },
    },
  })
  const route = createRouteContext({
    db,
    repositories,
    body: { draft: { ...draft(), type: 'real_purchase_order_create' } },
  })

  assert.equal(await handleActionDraftsRoute(route.ctx), true)
  assert.equal(route.response.status, 400)
  assert.equal(route.response.payload.code, 'FLOWCHAIN_ACTION_DRAFT_UNSUPPORTED_TYPE')
  assert.equal(writes.length, 0)
  assert.equal(route.wrote, false)
  assert.deepEqual(db, before)
})

test('database action draft repository can read saved draft shell and keeps confirm blocked', async () => {
  const db = createDb()
  const before = clone(db)
  const repository = createDbActionDraftRepository({
    db,
    env: {
      FLOWCHAIN_PERSISTENCE_MODE: 'database',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
    },
    prisma: {
      actionDraft: {
        findFirst: async ({ where, include }) => {
          assert.deepEqual(where, { id: 'DRAFT-SAVE-1', tenantId: 'tenant-flowchain-sme' })
          assert.deepEqual(include, { validations: true, auditTrail: true })
          return {
            ...draft(),
            createdAt: new Date('2026-06-30T00:00:00.000Z'),
            updatedAt: new Date('2026-06-30T00:00:00.000Z'),
            previewOnly: true,
            validations: [{ id: 'DRAFT-SAVE-1-VAL', ok: true, missingFields: [], warnings: [], errors: [] }],
            auditTrail: [{ id: 'DRAFT-SAVE-1-AUD', action: 'ai_draft_prepared', summary: 'Prepared draft' }],
          }
        },
      },
    },
  })

  const saved = await repository.getDraft('DRAFT-SAVE-1', { tenantId: 'tenant-flowchain-sme' })
  assert.equal(saved.id, 'DRAFT-SAVE-1')
  assert.equal(saved.type, 'purchase_request_draft')
  assert.equal(saved.previewOnly, true)
  assert.equal(saved.requiresConfirmation, true)
  await assert.rejects(
    () => repository.confirmDraft('DRAFT-SAVE-1'),
    (error) => error.status === 501 && error.code === 'FLOWCHAIN_ACTION_DRAFT_CONFIRM_NOT_IMPLEMENTED',
  )
  assert.deepEqual(db, before)
})

test('action draft route exposes schema preview and save only, not route-level get or confirm', async () => {
  const db = createDb()
  const repositories = createRepositoryRegistry({ db, env: {} })
  const getRoute = createRouteContext({
    method: 'GET',
    pathname: '/api/action-drafts/DRAFT-SAVE-1',
    db,
    repositories,
  })
  const confirmRoute = createRouteContext({
    method: 'POST',
    pathname: '/api/action-drafts/DRAFT-SAVE-1/confirm',
    db,
    repositories,
  })

  assert.equal(await handleActionDraftsRoute(getRoute.ctx), false)
  assert.equal(await handleActionDraftsRoute(confirmRoute.ctx), false)
})
