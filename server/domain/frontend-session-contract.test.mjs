import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('frontend session storage migrates legacy keys and sends only the signed bearer token', async () => {
  const source = await read('src/lib/api-client.ts')
  assert.match(source, /AUTH_TOKEN_KEY = 'flowchain:auth-token'/)
  assert.match(source, /CURRENT_USER_KEY = 'flowchain:current-user'/)
  assert.match(source, /removeItem\(LEGACY_AUTH_TOKEN_KEY\)/)
  assert.match(source, /removeItem\(LEGACY_CURRENT_USER_KEY\)/)
  assert.match(source, /Authorization: `Bearer \$\{token\}`/)
  assert.doesNotMatch(source, /X-FlowChain-(?:Role|User)/i)
})

test('ApiError preserves structured workflow and optimistic-concurrency fields', async () => {
  const source = await read('src/lib/api-client.ts')
  for (const field of ['status', 'code', 'details', 'entityId', 'currentStatus', 'currentVersion', 'expectedVersion', 'payload']) {
    assert.match(source, new RegExp(`this\\.${field}\\s*=`), `ApiError must preserve ${field}`)
  }
})

test('formal entity lists use route-addressable entity links', async () => {
  const [requests, items, suppliers, orders] = await Promise.all([
    read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx'),
    read('src/modules/master-data/ItemMasterWorkbench.tsx'),
    read('src/modules/srm/Page.tsx'),
    read('src/modules/purchasing/Page.tsx'),
  ])
  assert.match(requests, /kind="purchase_request"/)
  assert.match(requests, /kind="purchase_order"/)
  assert.match(items, /kind="item"/)
  assert.match(suppliers, /kind="supplier"/)
  assert.match(suppliers, /kind="item"/)
  assert.match(orders, /entityType="purchase_order"/)
  assert.match(orders, /"procurement:requests"/)
})

test('shared navigation shell omits redundant explanatory chrome', async () => {
  const [app, shell, orders] = await Promise.all([
    read('src/app/FlowChainApp.tsx'),
    read('src/components/navigation/ModuleShell.tsx'),
    read('src/modules/purchasing/Page.tsx'),
  ])
  assert.doesNotMatch(app, /data-testid="focus-banner"/)
  assert.doesNotMatch(app, />\s*当前聚焦\s*</)
  assert.doesNotMatch(shell, /\{route\.description\}/)
  assert.doesNotMatch(shell, /\{root\.description\}/)
  assert.doesNotMatch(orders, /SectionTitle title="未开票 \/ 已收未票"/)
  assert.doesNotMatch(orders, /SectionTitle title="证据链"/)
  assert.doesNotMatch(orders, /SectionTitle title="来源 PR \/ RFQ"/)
  assert.match(orders, /data-testid="po-line-cards"/)
})

test('PostgreSQL master data views normalize optional string fields before matching', async () => {
  const [items, masterData, suppliers] = await Promise.all([
    read('src/modules/master-data/ItemMasterWorkbench.tsx'),
    read('src/modules/master-data/Page.tsx'),
    read('src/modules/srm/Page.tsx'),
  ])
  assert.match(items, /function normalizeMasterItem/)
  assert.match(items, /String\(value \|\| ""\)\.toLowerCase\(\)/)
  assert.match(masterData, /String\(value \|\| ""\)\.toLowerCase\(\)/)
  assert.match(suppliers, /function normalizeSupplier/)
})

test('master data navigation does not retain stale item detail state and hides unavailable supplier relationships', async () => {
  const [app, masterData, items] = await Promise.all([
    read('src/app/FlowChainApp.tsx'),
    read('src/modules/master-data/Page.tsx'),
    read('src/modules/master-data/ItemMasterWorkbench.tsx'),
  ])
  assert.match(app, /current\?\.source === "detailUrl" \? null : current/)
  assert.match(masterData, /initialView !== "overview" && initialView !== "items"/)
  assert.doesNotMatch(items, /可采购供应商/)
  assert.doesNotMatch(items, /SKU–供应商关系/)
  assert.doesNotMatch(items, /\/api\/master-data\/items\/.*\/suppliers/)
})

test('sales reads remain visible while write-dependent sales, returns, quarantine, and inventory-bin routes stay gated', async () => {
  const [routes, guard] = await Promise.all([
    read('src/app/routeRegistry.tsx'),
    read('src/app/capabilityRouteGuard.ts'),
  ])
  for (const capabilityId of [
    'sales-order-lifecycle',
    'sales-shipment-draft',
    'sales-shipment-posting',
    'return-request',
    'return-authorization',
    'return-posting',
    'quarantine-inventory',
    'inventory-bin-read',
  ]) {
    assert.match(routes, new RegExp(`capabilityId: "${capabilityId}"`))
  }
  const salesOrderList = routes.slice(
    routes.indexOf('id: "sales:orders"'),
    routes.indexOf('}),', routes.indexOf('id: "sales:orders"')),
  )
  assert.doesNotMatch(salesOrderList, /capabilityId:/)
  assert.match(guard, /\["inventory-bin-read", "unavailable"/)
})
