import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAiRuntimeFacts } from './ai-runtime-gateway.routes.mjs'
import { handlePurchaseRequestsRoute } from './purchase-requests.routes.mjs'
import { handlePurchaseOrdersRoute } from './purchase-orders.routes.mjs'
import { handleMasterDataRoute } from './master-data.routes.mjs'

function routeContext(pathname, snapshot, authenticated = true) {
  const sent = []
  return {
    sent,
    ctx: {
      req: { method: 'GET' },
      res: {},
      url: new URL(pathname, 'http://local'),
      db: { purchaseRequests: [{ id: 'STATIC-PR' }], purchaseOrders: [{ id: 'STATIC-PO' }] },
      identity: authenticated ? { authenticated: true, tenantId: 'tenant-local' } : null,
      repositories: { procurementRead: { snapshot: async (scope) => {
        assert.equal(scope.tenantId, 'tenant-local')
        return snapshot
      } } },
      send: (_res, status, payload) => { sent.push({ status, payload }); return true },
    },
  }
}

test('legacy purchase request and order reads use tenant-scoped PostgreSQL facts', async () => {
  const snapshot = {
    purchaseRequests: [{ id: 'DB-PR-1' }],
    purchaseOrders: [{ id: 'DB-PO-1' }],
  }
  const requests = routeContext('/api/purchase-requests', snapshot)
  const orders = routeContext('/api/purchase-orders', snapshot)
  await handlePurchaseRequestsRoute(requests.ctx)
  await handlePurchaseOrdersRoute(orders.ctx)
  assert.deepEqual(requests.sent, [{ status: 200, payload: snapshot.purchaseRequests }])
  assert.deepEqual(orders.sent, [{ status: 200, payload: snapshot.purchaseOrders }])
  assert.doesNotMatch(JSON.stringify([...requests.sent, ...orders.sent]), /STATIC-/)
})

test('legacy procurement reads fail closed without authenticated tenant context', async () => {
  const requests = routeContext('/api/purchase-requests', {}, false)
  const orders = routeContext('/api/purchase-orders', {}, false)
  await handlePurchaseRequestsRoute(requests.ctx)
  await handlePurchaseOrdersRoute(orders.ctx)
  assert.equal(requests.sent[0].status, 401)
  assert.equal(orders.sent[0].status, 401)
})

test('AI runtime facts are assembled from tenant-scoped PostgreSQL repositories', async () => {
  const scopes = []
  const facts = await loadAiRuntimeFacts({
    procurementRead: { snapshot: async (scope) => {
      scopes.push(scope)
      return { purchaseRequests: [{ id: 'DB-PR-1' }], purchaseOrders: [{ id: 'DB-PO-1' }] }
    } },
    inventoryRead: { listItems: async (scope) => { scopes.push(scope); return [{ sku: 'DB-SKU-1' }] } },
    masterData: { listSuppliers: async (scope) => { scopes.push(scope); return [{ id: 'DB-SUP-1' }] } },
  }, 'tenant-local')
  assert.equal(scopes.every((scope) => scope.tenantId === 'tenant-local'), true)
  assert.equal(facts.purchaseOrders[0].id, 'DB-PO-1')
  assert.equal(facts.products[0].sku, 'DB-SKU-1')
  assert.equal(facts.suppliers[0].id, 'DB-SUP-1')
})

test('procurement selectors fall back to tenant-scoped PostgreSQL item and supplier reads', async () => {
  const calls = []
  const repositories = {
    masterData: {
      listItems: async (scope) => { calls.push(['items', scope]); return [{ id: 'ITEM-1', category: 'Controls', status: 'active' }] },
      listSuppliers: async (scope) => { calls.push(['suppliers', scope]); return [{ id: 'SUP-1', name: 'Supplier One', status: 'active' }] },
    },
  }
  for (const pathname of ['/api/master-data/commodities/select', '/api/master-data/suppliers/select']) {
    const sent = []
    await handleMasterDataRoute({
      req: { method: 'GET' },
      res: {},
      url: new URL(pathname, 'http://local'),
      identity: { authenticated: true, tenantId: 'tenant-local' },
      repositories,
      send: (_res, status, payload) => sent.push({ status, payload }),
    })
    assert.equal(sent[0].status, 200)
  }
  assert.equal(calls.every(([, scope]) => scope.tenantId === 'tenant-local'), true)
})
