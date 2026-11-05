import test from 'node:test'
import assert from 'node:assert/strict'
import { createDbProcurementReadRepository } from '../repositories/db-procurement-read-repository.mjs'
import { aiSkillActor } from '../domain/test-fixtures/ai-skill-scenario.mjs'
import { classifyRoute, ROUTE_CLASSES } from '../domain/route-classification.mjs'
import { handleProcurementWorkflowRoute } from './procurement-workflow.routes.mjs'

// GET /api/procurement/document-numbers: the number each purchase order,
// purchase request and RFQ shows, by id, for the ids a page holds. Tenant
// scoped; a type the reader may not open, and an id the workspace does not
// have, are left out instead of refused.

const TENANT = 'tenant-doc-numbers'
const OTHER = 'tenant-doc-numbers-other'
const env = { FLOWCHAIN_PERSISTENCE_MODE: 'database', DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain' }

const rows = {
  purchaseOrder: [
    { id: 'PO-1A2B3C4D', tenantId: TENANT, number: 'PO-202611-0001', metadata: { orderNumber: 'PO-202611-0001' } },
    // Written outside the app: no number, so its recorded order number, then its id.
    { id: 'PO-LEGACY', tenantId: TENANT, number: null, metadata: { orderNumber: 'ACME-PO-7' } },
    { id: 'PO-BARE', tenantId: TENANT, number: null, metadata: null },
    { id: 'PO-OTHER', tenantId: OTHER, number: 'PO-202611-0001', metadata: {} },
  ],
  purchaseRequest: [
    { id: 'PR-9F8E7D6C', tenantId: TENANT, number: 'PR-202611-0003' },
    { id: 'LOCAL-DEMO-PR-001', tenantId: TENANT, number: 'LOCAL-DEMO-PR-001' },
  ],
  rfq: [{ id: 'RFQ-5A5A5A5A', tenantId: TENANT, number: 'RFQ-202611-0002' }],
}

const queries = []
const prisma = new Proxy({}, {
  get(_target, model) {
    return {
      findMany: async (args = {}) => {
        queries.push({ model, args })
        const ids = args.where?.id?.in || []
        return structuredClone((rows[model] || []).filter((row) => row.tenantId === args.where?.tenantId && ids.includes(row.id)))
      },
    }
  },
})

function call(path, roleKey, tenantId = TENANT) {
  const sent = []
  const ctx = {
    req: { method: 'GET', headers: {} }, res: {}, url: new URL(path, 'http://local'), env,
    identity: roleKey ? aiSkillActor(roleKey, tenantId) : { authenticated: false },
    repositories: { procurementRead: createDbProcurementReadRepository({ env, prisma }) },
    send: (_res, status, payload) => { sent.push({ status, payload }); return true },
  }
  return handleProcurementWorkflowRoute(ctx).then((handled) => ({ handled, ...sent.at(-1) }))
}

test('a reader gets the number of each id the workspace has, by type', async () => {
  const { handled, status, payload } = await call('/api/procurement/document-numbers?purchase_order=PO-1A2B3C4D,PO-LEGACY,PO-BARE,PO-OTHER,PO-MISSING&purchase_request=PR-9F8E7D6C&purchase_request=LOCAL-DEMO-PR-001&rfq=RFQ-5A5A5A5A', 'read-only-viewer')
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.deepEqual(payload, { numbers: {
    // Another workspace's order and an unknown id are left out.
    purchase_order: { 'PO-1A2B3C4D': 'PO-202611-0001', 'PO-LEGACY': 'ACME-PO-7', 'PO-BARE': 'PO-BARE' },
    purchase_request: { 'PR-9F8E7D6C': 'PR-202611-0003', 'LOCAL-DEMO-PR-001': 'LOCAL-DEMO-PR-001' },
    rfq: { 'RFQ-5A5A5A5A': 'RFQ-202611-0002' },
  } })
})

test('every lookup is scoped to the reader\'s workspace', async () => {
  queries.length = 0
  const { payload } = await call('/api/procurement/document-numbers?purchase_order=PO-OTHER', 'read-only-viewer')
  assert.deepEqual(payload.numbers.purchase_order, {})
  assert.ok(queries.length > 0 && queries.every(({ args }) => args.where.tenantId === TENANT))
  const other = await call('/api/procurement/document-numbers?purchase_order=PO-OTHER', 'read-only-viewer', OTHER)
  assert.deepEqual(other.payload.numbers.purchase_order, { 'PO-OTHER': 'PO-202611-0001' })
})

test('a reader without purchase order read gets omissions, not an error', async () => {
  queries.length = 0
  for (const role of ['operations-specialist', 'finance-specialist']) {
    const { status, payload } = await call('/api/procurement/document-numbers?purchase_order=PO-1A2B3C4D&purchase_request=PR-9F8E7D6C&rfq=RFQ-5A5A5A5A', role)
    assert.equal(status, 200, role)
    assert.deepEqual(payload, { numbers: { purchase_order: {}, purchase_request: {}, rfq: {} } }, role)
  }
  // Nothing was read for them.
  assert.equal(queries.length, 0)
})

test('no ids, blank ids and repeats ask the database for nothing extra', async () => {
  queries.length = 0
  const empty = await call('/api/procurement/document-numbers', 'read-only-viewer')
  assert.deepEqual([empty.status, empty.payload], [200, { numbers: { purchase_order: {}, purchase_request: {}, rfq: {} } }])
  assert.equal(queries.length, 0)
  await call('/api/procurement/document-numbers?purchase_order=PO-1A2B3C4D,,PO-1A2B3C4D,%20', 'read-only-viewer')
  assert.deepEqual(queries.map(({ model, args }) => [model, args.where.id.in]), [['purchaseOrder', ['PO-1A2B3C4D']]])
})

test('at most 200 ids per type are looked up', async () => {
  queries.length = 0
  const ids = Array.from({ length: 250 }, (_, index) => `PO-${index}`)
  await call(`/api/procurement/document-numbers?purchase_order=${ids.join(',')}`, 'read-only-viewer')
  assert.equal(queries[0].args.where.id.in.length, 200)
  assert.deepEqual(queries[0].args.where.id.in.slice(0, 2), ['PO-0', 'PO-1'])
})

test('a signed-out request is refused and the route is a read', async () => {
  const { status, payload } = await call('/api/procurement/document-numbers?purchase_order=PO-1A2B3C4D', null)
  assert.deepEqual([status, payload.code], [401, 'TENANT_CONTEXT_REQUIRED'])
  const route = classifyRoute('GET', '/api/procurement/document-numbers')
  assert.deepEqual([route.group, route.classification], ['procurement-read', ROUTE_CLASSES.readOnly])
})
