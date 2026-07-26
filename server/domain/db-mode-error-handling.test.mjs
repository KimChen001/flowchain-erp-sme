import test from 'node:test'
import assert from 'node:assert/strict'
import { createRepositoryRegistry, getPersistenceMode } from '../repositories/adapter-registry.mjs'
import { DATABASE_CONFIG_ERROR } from '../persistence/persistence-config.mjs'
import { buildAiReadContext } from './ai-read-context.mjs'

function createDb() {
  return {
    products: [{ sku: 'JSON-ONLY', name: 'JSON Only Item', currentStock: 100, safetyStock: 1, unit: 'pcs' }],
    suppliers: [{ id: 'SUP-JSON', name: 'JSON Only Supplier' }],
    purchaseRequests: [{ pr: 'PR-JSON-1', status: '待审批', sourceSku: 'JSON-ONLY', supplier: 'JSON Only Supplier' }],
    rfqs: [],
    purchaseOrders: [{ po: 'PO-JSON-1', status: '待审批', supplier: 'JSON Only Supplier', sourceSku: 'JSON-ONLY' }],
    receivingDocs: [],
    supplierInvoices: [],
    inventoryMovements: [],
    auditLog: [],
  }
}

function draft() {
  return {
    id: 'DRAFT-DB-ERROR-1',
    tenantId: 'tenant-flowchain-sme',
    type: 'purchase_request_draft',
    title: 'Purchase request draft',
    status: 'preview',
    source: 'test',
    requiresConfirmation: true,
    confirmationBoundary: { previewOnly: true, submitted: false },
    payload: { itemIdOrSku: 'JSON-ONLY', quantity: 2 },
    validation: { ok: true, missingFields: [], warnings: [], errors: [] },
    auditTrail: [],
  }
}

function assertDatabaseConfigError(error) {
  assert.equal(error.message, DATABASE_CONFIG_ERROR)
  assert.equal(error.code, DATABASE_CONFIG_ERROR)
  assert.doesNotMatch(JSON.stringify({ message: error.message, code: error.code }), /password|postgres|stack|OPENAI_API_KEY|Bearer/i)
  return true
}

test('PostgreSQL mode is the only runtime and is selected by default', () => {
  const db = createDb()
  const registry = createRepositoryRegistry({ db, env: {} })

  assert.equal(getPersistenceMode({}), 'database')
  assert.equal(registry.mode, 'database')
  assert.equal(registry.masterData.adapter, 'db-master-data-v1')
  assert.equal(registry.procurementRead.adapter, 'db-procurement-read-v1')
  assert.equal(registry.inventoryRead.adapter, 'db-inventory-read-v1')
  assert.equal(registry.actionDrafts.previewDraft({ type: 'purchase_request_draft', payload: { itemIdOrSku: 'JSON-ONLY', quantity: 2 } }).ok, true)
})

test('removed and unsupported persistence modes fail closed', () => {
  assert.throws(
    () => createRepositoryRegistry({ db: createDb(), env: { FLOWCHAIN_PERSISTENCE_MODE: 'json' } }),
    (error) => error.code === 'FLOWCHAIN_JSON_PERSISTENCE_REMOVED',
  )
  assert.throws(
    () => createRepositoryRegistry({ db: createDb(), env: { FLOWCHAIN_PERSISTENCE_MODE: 'sqlite' } }),
    (error) => error.code === 'FLOWCHAIN_PERSISTENCE_MODE_UNSUPPORTED',
  )
})

test('explicit DB mode selects DB adapters even without DATABASE_URL', () => {
  const registry = createRepositoryRegistry({
    db: createDb(),
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
  })

  assert.equal(registry.mode, 'database')
  assert.equal(registry.masterData.adapter, 'db-master-data-v1')
  assert.equal(registry.procurementRead.adapter, 'db-procurement-read-v1')
  assert.equal(registry.inventoryRead.adapter, 'db-inventory-read-v1')
  assert.equal(registry.actionDrafts.adapter, 'db-action-draft-v1')
  assert.equal(registry.auditLog.adapter, 'db-audit-log-v1')
})

test('DB-backed modules fail cleanly instead of falling back to stale JSON when DATABASE_URL is missing', async () => {
  const db = createDb()
  const registry = createRepositoryRegistry({
    db,
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
  })

  await assert.rejects(() => registry.masterData.listItems(), assertDatabaseConfigError)
  await assert.rejects(() => registry.procurementRead.listDocuments(), assertDatabaseConfigError)
  await assert.rejects(() => registry.inventoryRead.listItems(), assertDatabaseConfigError)
  await assert.rejects(() => registry.actionDrafts.persistDraft(draft()), assertDatabaseConfigError)
  await assert.rejects(() => registry.auditLog.listAuditEntries(), assertDatabaseConfigError)
  await assert.rejects(() => registry.auditLog.recordAuditEntry({ action: 'test', entity: { type: 'system', id: 'db-mode' } }), assertDatabaseConfigError)
  await assert.rejects(() => buildAiReadContext(db, { repositories: registry }), assertDatabaseConfigError)
})

test('preview-only action draft fallback is intentional and remains non-mutating in misconfigured DB mode', () => {
  const db = createDb()
  const before = JSON.stringify(db)
  const registry = createRepositoryRegistry({
    db,
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
  })
  const result = registry.actionDrafts.previewDraft({
    type: 'purchase_request_draft',
    payload: { itemIdOrSku: 'JSON-ONLY', quantity: 2 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.draft.confirmationBoundary.previewOnly, true)
  assert.equal(result.draft.payload.itemIdOrSku, 'JSON-ONLY')
  assert.equal(JSON.stringify(db), before)
})
