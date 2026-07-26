import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DATABASE_MODE_MUTATION_BLOCKED_ERROR,
  ROUTE_CLASSES,
  classifyRoute,
  databaseModeMutationBlockedPayload,
  isDatabaseModeWriteBlocked,
  isLegacyMutationRoute,
  listRouteClassifications,
} from './route-classification.mjs'

test('route classification covers read preview legacy mutation and diagnostics routes', () => {
  assert.equal(classifyRoute('GET', '/api/health').classification, ROUTE_CLASSES.diagnostics)
  assert.equal(classifyRoute('GET', '/api/procurement/documents').classification, ROUTE_CLASSES.readOnly)
  assert.equal(classifyRoute('GET', '/api/sales-demand/orders').classification, ROUTE_CLASSES.readOnly)
  assert.equal(classifyRoute('GET', '/api/evidence-graph/sku/SKU-00412').classification, ROUTE_CLASSES.readOnly)
  assert.equal(classifyRoute('GET', '/api/evidence-graph/sku/SKU-00412').writesJson, false)
  assert.equal(classifyRoute('GET', '/api/inventory/availability').classification, ROUTE_CLASSES.readOnly)
  assert.equal(classifyRoute('GET', '/api/inventory/reservation-preview').classification, ROUTE_CLASSES.readOnly)
  assert.equal(classifyRoute('POST', '/api/action-drafts/preview').classification, ROUTE_CLASSES.previewOnly)
  assert.equal(classifyRoute('POST', '/api/action-drafts').classification, ROUTE_CLASSES.controlledPersistence)
  assert.equal(classifyRoute('POST', '/api/action-drafts/save').databaseMode, 'allowed-db-persistence')
  assert.equal(classifyRoute('POST', '/api/procurement/receiving/GRN-1/post').classification, ROUTE_CLASSES.controlledPersistence)
  assert.equal(classifyRoute('POST', '/api/procurement/receiving/GRN-1/reverse').databaseMode, 'allowed-db-persistence')
  assert.equal(classifyRoute('GET', '/api/sales/orders/SO-1/outbound-state').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('POST', '/api/sales/orders/SO-1/reservations/preview').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('POST', '/api/sales/shipments/SHIP-1/post').databaseMode, 'allowed-db-persistence')
  assert.equal(classifyRoute('GET', '/api/procurement/receiving/GRN-1/reconciliation').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('GET', '/api/mrp-plan').classification, ROUTE_CLASSES.capabilityDisabled)
  assert.equal(classifyRoute('GET', '/api/mrp-plan').writesJson, false)
  assert.equal(classifyRoute('GET', '/api/sop-cycle').classification, ROUTE_CLASSES.capabilityDisabled)
  assert.equal(classifyRoute('POST', '/api/forecast-plans').classification, ROUTE_CLASSES.capabilityDisabled)
  assert.equal(classifyRoute('POST', '/api/sop-cycle').classification, ROUTE_CLASSES.capabilityDisabled)
  assert.equal(classifyRoute('POST', '/api/purchase-requests').classification, ROUTE_CLASSES.legacyMutation)
  assert.equal(classifyRoute('PATCH', '/api/receiving-docs/GRN-1').classification, ROUTE_CLASSES.legacyMutation)
  assert.equal(classifyRoute('GET', '/index.html').classification, ROUTE_CLASSES.static)
})

test('database mode blocks legacy mutation routes but allows read and preview routes', () => {
  const blocked = [
    ['POST', '/api/purchase-requests'],
    ['PATCH', '/api/purchase-requests/PR-1/status'],
    ['POST', '/api/purchase-requests/PR-1/convert-to-po'],
    ['POST', '/api/rfqs'],
    ['PATCH', '/api/rfqs/RFQ-1/status'],
    ['POST', '/api/purchase-orders'],
    ['PATCH', '/api/purchase-orders/PO-1/status'],
    ['POST', '/api/receiving-docs'],
    ['PATCH', '/api/receiving-docs/GRN-1'],
  ]

  for (const [method, pathname] of blocked) {
    assert.equal(isLegacyMutationRoute(method, pathname), true, pathname)
    assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method, pathname }), true, pathname)
    assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'json', method, pathname }), false, pathname)
  }

  for (const [method, pathname] of [
    ['GET', '/api/mrp-plan'],
    ['GET', '/api/sop-cycle'],
    ['POST', '/api/forecast-plans'],
    ['POST', '/api/sop-cycle'],
    ['POST', '/api/market-prices/refresh'],
  ]) {
    assert.equal(classifyRoute(method, pathname).classification, ROUTE_CLASSES.capabilityDisabled, pathname)
    assert.equal(isLegacyMutationRoute(method, pathname), false, pathname)
  }

  const allowed = [
    ['GET', '/api/health'],
    ['GET', '/api/master-data/items'],
    ['GET', '/api/procurement/documents'],
    ['GET', '/api/sales-demand/orders'],
    ['GET', '/api/evidence-graph/purchase-order/PO-1'],
    ['GET', '/api/inventory/items'],
    ['GET', '/api/inventory/available-to-promise'],
    ['GET', '/api/mrp-plan'],
    ['GET', '/api/sop-cycle'],
    ['POST', '/api/action-drafts/preview'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/procurement/receiving/GRN-1/post'],
    ['POST', '/api/procurement/receiving/GRN-1/reverse'],
    ['POST', '/api/ai/chat'],
  ]

  for (const [method, pathname] of allowed) {
    assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method, pathname }), false, pathname)
  }
})

test('route classification metadata includes major route groups and clean block payload', () => {
  const groups = new Set(listRouteClassifications().map((route) => route.group))

  for (const group of ['ai', 'sales-demand', 'evidence-graph', 'master-data', 'procurement-read', 'inventory-read', 'action-drafts', 'purchase-requests', 'rfqs', 'purchase-orders', 'receiving', 'forecast', 'planning', 'market', 'auth']) {
    assert.equal(groups.has(group), true, group)
  }

  assert.deepEqual(databaseModeMutationBlockedPayload(), {
    error: DATABASE_MODE_MUTATION_BLOCKED_ERROR,
  })
  assert.doesNotMatch(JSON.stringify(databaseModeMutationBlockedPayload()), /stack|trace|DATABASE_URL|OPENAI_API_KEY/)
})

test('database mode route metadata reflects migrated master data read adapter', () => {
  assert.equal(classifyRoute('GET', '/api/master-data/items').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('GET', '/api/sales-demand/orders').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('GET', '/api/evidence-graph').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('GET', '/api/procurement/documents').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('GET', '/api/inventory/items').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('GET', '/api/inventory/demand-supply-gap').databaseMode, 'allowed-db-read')
  assert.equal(classifyRoute('GET', '/api/pilot/exports/inventory_balances').group, 'pilot-exports')
  assert.equal(classifyRoute('GET', '/api/admin/pilot-diagnostics').classification, ROUTE_CLASSES.diagnostics)
})
