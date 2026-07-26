import test from 'node:test'
import assert from 'node:assert/strict'
import { handleMasterDataRoute } from '../routes/master-data.routes.mjs'
import { handleCapabilitiesRoute } from '../routes/capabilities.routes.mjs'

const repository = {
  listManagedItems: async () => [
    { itemId: 'I-1', category: '原材料', status: 'active' },
    { itemId: 'I-2', category: '停用品类', status: 'inactive' },
  ],
  listWarehouses: async () => [
    { id: 'W-1', warehouseCode: 'WH-1', warehouseName: '一号仓', status: 'active', bin: 'A-01' },
    { id: 'W-2', warehouseCode: 'WH-2', warehouseName: '停用仓', status: 'inactive' },
  ],
  listPaymentTerms: async () => [{ id: 'NET30', code: 'NET30', label: '30 天', status: 'active' }],
  listTaxCodes: async () => [{ id: 'VAT13', code: 'VAT13', label: '增值税 13%', rate: 0.13, status: 'active' }],
}

async function call(handler, path, extra = {}) {
  let response
  const ctx = { req: { method: 'GET', headers: {} }, res: {}, url: new URL(path, 'http://local'), repositories: { masterData: repository }, db: {}, ...extra, send(_res, status, payload) { response = { status, payload } } }
  assert.equal(await handler(ctx), true)
  return response
}

test('formal selector APIs return active minimal options', async () => {
  for (const name of ['departments', 'currencies', 'units', 'commodities', 'warehouses', 'payment-terms', 'tax-codes']) {
    const response = await call(handleMasterDataRoute, `/api/master-data/${name}/select`)
    assert.equal(response.status, 200)
    assert.ok(response.payload.options.length > 0, `${name} selector should have an active option`)
    for (const option of response.payload.options) assert.deepEqual(Object.keys(option).filter(key => !['id', 'code', 'label', 'metadata'].includes(key)), [])
  }
  const warehouses = await call(handleMasterDataRoute, '/api/master-data/warehouses/select')
  assert.deepEqual(warehouses.payload.options.map(row => row.code), ['WH-1'])
})

test('capability registry hides preview and unavailable modules by default', async () => {
  const response = await call(handleCapabilitiesRoute, '/api/capabilities')
  const byId = Object.fromEntries(response.payload.capabilities.map(row => [row.id, row]))
  assert.equal(byId.procurement.maturity, 'stable')
  assert.equal(byId.imports.maturity, 'unavailable')
  assert.equal(byId.imports.enabled, false)
  assert.equal(byId.imports.readReady, false)
  assert.equal(byId.imports.writeReady, false)
  assert.equal(byId.imports.businessCommitReady, false)
  assert.equal(byId['universal-intake'].enabled, false)
  assert.equal(byId['universal-intake'].maturity, 'preview')
  assert.equal(byId['universal-intake'].businessCommitReady, false)
  assert.equal(byId.forecast.enabled, false)
  assert.equal(byId.finance.enabled, false)
  assert.equal(byId['receiving-posting'].enabled, false)
  assert.equal(byId['receiving-posting'].databaseOnly, true)
  for (const id of ['sales-reservation', 'sales-shipment-draft', 'sales-shipment-posting', 'sales-shipment-reversal']) {
    assert.equal(byId[id].maturity, 'beta')
    assert.equal(byId[id].databaseOnly, true)
    assert.equal(byId[id].enabled, false)
  }
  for (const id of ['stock-transfer', 'cycle-count', 'inventory-adjustment-document']) {
    assert.equal(byId[id].maturity, 'beta')
    assert.equal(byId[id].databaseOnly, true)
    assert.equal(byId[id].enabled, false)
  }
  for (const id of ['quarantine-inventory', 'return-request', 'return-authorization', 'return-posting']) {
    assert.equal(byId[id].maturity, 'beta')
    assert.equal(byId[id].databaseOnly, true)
    assert.equal(byId[id].enabled, false)
  }
  assert.equal(byId['quarantine-inventory'].readReady, true)
  assert.equal(byId['return-request'].readReady, true)
  assert.equal(byId['return-request'].writeReady, true)
  assert.equal(byId['return-authorization'].readReady, true)
  assert.equal(byId['return-authorization'].writeReady, true)
  assert.equal(byId['return-posting'].readReady, true)
  assert.equal(byId['return-posting'].writeReady, true)

  const intakeEnabled = await call(handleCapabilitiesRoute, '/api/capabilities', { env: { FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: 'true' } })
  const intakeById = Object.fromEntries(intakeEnabled.payload.capabilities.map(row => [row.id, row]))
  assert.equal(intakeById['universal-intake'].enabled, true)
  assert.equal(intakeById['universal-intake'].writeReady, true)
  assert.equal(intakeById['universal-intake'].businessCommitReady, false)
  assert.equal(intakeById.imports.enabled, false)

  const databaseEnabled = await call(handleCapabilitiesRoute, '/api/capabilities', { env: { FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: 'true' } })
  const enabledById = Object.fromEntries(databaseEnabled.payload.capabilities.map(row => [row.id, row]))
  assert.equal(enabledById['receiving-posting'].enabled, true)
  assert.equal(enabledById['receiving-reversal'].enabled, true)

  const outboundEnabled = await call(handleCapabilitiesRoute, '/api/capabilities', { env: { FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true' } })
  const outboundById = Object.fromEntries(outboundEnabled.payload.capabilities.map(row => [row.id, row]))
  for (const id of ['sales-reservation', 'sales-shipment-draft', 'sales-shipment-posting', 'sales-shipment-reversal']) assert.equal(outboundById[id].enabled, true)

  const inventoryOperationsEnabled = await call(handleCapabilitiesRoute, '/api/capabilities', { env: { FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true' } })
  const inventoryOperationsById = Object.fromEntries(inventoryOperationsEnabled.payload.capabilities.map(row => [row.id, row]))
  for (const id of ['stock-transfer', 'cycle-count', 'inventory-adjustment-document']) assert.equal(inventoryOperationsById[id].enabled, true)

  const returnsEnabled = await call(handleCapabilitiesRoute, '/api/capabilities', { env: { FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE: 'true' } })
  const returnsById = Object.fromEntries(returnsEnabled.payload.capabilities.map(row => [row.id, row]))
  for (const id of ['quarantine-inventory', 'return-request', 'return-authorization', 'return-posting']) assert.equal(returnsById[id].enabled, true)

  const returnsWithoutLegacyMode = await call(handleCapabilitiesRoute, '/api/capabilities', { env: { FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE: 'true' } })
  const returnsWithoutLegacyModeById = Object.fromEntries(returnsWithoutLegacyMode.payload.capabilities.map(row => [row.id, row]))
  for (const id of ['quarantine-inventory', 'return-request', 'return-authorization', 'return-posting']) assert.equal(returnsWithoutLegacyModeById[id].enabled, true)
})
