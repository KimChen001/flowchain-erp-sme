import assert from 'node:assert/strict'
import test from 'node:test'
import { handleBusinessReadContextRoute } from './business-read-context.routes.mjs'

// Regression. The route called service.read() with no tenant, so every
// repository fell back to its own default. Those defaults disagree: master data
// and inventory fall back to a hardcoded tenant, while procurement and sales
// fall back to FLOWCHAIN_DEFAULT_TENANT_ID. Measured against a seeded local
// workspace, a signed-in user's context came back with items, suppliers,
// customers and inventory all at zero while orders were correct.

function recordingRepositories() {
  const calls = []
  const record = (name, result) => async (scope) => {
    calls.push({ name, tenantId: scope?.tenantId })
    return result
  }
  return {
    calls,
    repositories: {
      masterData: {
        listItems: record('masterData.listItems', []),
        listSuppliers: record('masterData.listSuppliers', []),
        listCustomers: record('masterData.listCustomers', []),
        listAllItemSupplierRelationships: record('masterData.listAllItemSupplierRelationships', []),
      },
      inventoryRuntime: { listItems: record('inventoryRuntime.listItems', []) },
      salesOrders: { listOrders: record('salesOrders.listOrders', []) },
      procurementRuntime: { snapshot: record('procurementRuntime.snapshot', {}) },
    },
  }
}

function routeContext(pathname, repositories, identity) {
  const sent = []
  return {
    sent,
    ctx: {
      req: { method: 'GET' },
      res: {},
      url: new URL(`http://localhost${pathname}`),
      send: (res, status, payload) => sent.push({ status, payload }),
      repositories,
      dataMode: 'user',
      identity,
    },
  }
}

const signedIn = { authenticated: true, tenantId: 'tenant-signed-in', userId: 'user-1', role: 'manager', source: 'signed-session' }
const EXPECTED_READS = [
  'masterData.listItems',
  'masterData.listSuppliers',
  'masterData.listCustomers',
  'masterData.listAllItemSupplierRelationships',
  'inventoryRuntime.listItems',
  'salesOrders.listOrders',
  'procurementRuntime.snapshot',
]

for (const pathname of ['/api/home/overview', '/api/business/read-context']) {
  test(`${pathname} reads every repository in the signed-in user's tenant`, async () => {
    const { calls, repositories } = recordingRepositories()
    const { ctx, sent } = routeContext(pathname, repositories, signedIn)

    assert.equal(await handleBusinessReadContextRoute(ctx), true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].status, 200)

    // Every read must be scoped. A single unscoped read is enough to mix tenants.
    assert.deepEqual(calls.map((call) => call.name).sort(), [...EXPECTED_READS].sort())
    for (const call of calls) {
      assert.equal(call.tenantId, 'tenant-signed-in', `${call.name} must receive the signed-in tenant`)
    }
  })
}

test('the route ignores methods and paths it does not own', async () => {
  const { repositories } = recordingRepositories()
  const post = routeContext('/api/home/overview', repositories, signedIn)
  post.ctx.req.method = 'POST'
  assert.equal(await handleBusinessReadContextRoute(post.ctx), false)
  const other = routeContext('/api/home/other', repositories, signedIn)
  assert.equal(await handleBusinessReadContextRoute(other.ctx), false)
  assert.equal(post.sent.length + other.sent.length, 0)
})
