import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRoute, ROUTE_CLASSES, isDatabaseModeWriteBlocked } from './route-classification.mjs'

test('Planning routes fail closed behind capability gates', () => {
  assert.equal(classifyRoute('GET', '/api/mrp-plan').classification, ROUTE_CLASSES.capabilityDisabled)
  assert.equal(classifyRoute('GET', '/api/mrp-plan').writesJson, false)

  for (const [method, pathname] of [
    ['POST', '/api/forecast-plans'],
    ['POST', '/api/sop-cycle'],
  ]) {
    assert.equal(classifyRoute(method, pathname).classification, ROUTE_CLASSES.capabilityDisabled, pathname)
    assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method, pathname }), false, pathname)
  }
  assert.equal(classifyRoute('POST', '/api/purchase-requests').classification, ROUTE_CLASSES.legacyMutation)
  assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method: 'POST', pathname: '/api/purchase-requests' }), true)
})
