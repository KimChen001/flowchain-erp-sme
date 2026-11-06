import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMasterDataSeedPreview, seedMasterData } from '../persistence/seed-master-data.mjs'
import { buildMasterDataSeedRows } from '../persistence/seed-master-data-plan.mjs'
import { shouldSkipDbTests, withTestDatabase } from '../persistence/test-db-harness.mjs'
import { createDbMasterDataRepository } from '../repositories/db-master-data-repository.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createDb() {
  return {
    products: [{ sku: 'A100', name: 'Motor A100', category: 'Components', supplier: 'ABC Components', safetyStock: 50, reorderPoint: 80, unit: 'pcs', moq: 10 }],
    suppliers: [{ id: 'SUP-1', name: 'ABC Components', category: 'Components', score: 95, preferred: true }],
    warehouses: [{ id: 'WH-MAIN', name: 'Main Warehouse' }],
    paymentTerms: [{ id: 'NET30', label: 'Net 30', days: 30 }],
    taxCodes: [{ id: 'TAX-STD', label: 'Standard Tax', rate: 0.13 }],
  }
}

function upsertModel(writes) {
  return {
    upsert: async ({ where, update, create }) => {
      writes.push({ where, update, create })
      return create
    },
  }
}

test('master data seed rows are deterministic and non-mutating', () => {
  const db = createDb()
  const before = clone(db)
  const first = buildMasterDataSeedRows(db, { tenantId: 'tenant-test' })
  const second = buildMasterDataSeedRows(db, { tenantId: 'tenant-test' })
  const preview = buildMasterDataSeedPreview(db, { tenantId: 'tenant-test' })

  assert.deepEqual(first, second)
  assert.equal(first.tenant.id, 'tenant-test')
  assert.equal(first.items[0].preferredSupplierId, 'SUP-1')
  // A supplier with no recorded payment term is seeded without one, not NET30.
  assert.equal(Object.hasOwn(first.suppliers[0].metadata, 'paymentTermsId'), false)
  assert.equal(buildMasterDataSeedRows({ suppliers: [{ id: 'SUP-2', name: 'Termed', paymentTermsId: 'NET45' }] }).suppliers[0].metadata.paymentTermsId, 'NET45')
  assert.equal(preview.rowCounts.items, 1)
  assert.equal(preview.mutatesSource, false)
  assert.deepEqual(db, before)
})

test('master data seed apply uses explicit upserts with safe test env', async () => {
  const writes = []
  const prisma = {
    tenant: upsertModel(writes),
    paymentTerm: upsertModel(writes),
    taxCode: upsertModel(writes),
    supplier: upsertModel(writes),
    warehouse: upsertModel(writes),
    item: upsertModel(writes),
  }
  const result = await seedMasterData(createDb(), {
    dryRun: false,
    env: { DATABASE_URL_TEST: 'postgresql://user:pass@localhost:5432/flowchain_test' },
    prisma,
  })

  assert.equal(result.mode, 'apply')
  assert.deepEqual(result.upsertedCounts, {
    tenants: 1,
    paymentTerms: 1,
    taxCodes: 1,
    suppliers: 1,
    warehouses: 1,
    items: 1,
  })
  assert.equal(writes.length, 6)
})

test('master data DB parity skips cleanly without DATABASE_URL_TEST', async () => {
  assert.deepEqual(shouldSkipDbTests({}), {
    skip: true,
    reason: 'DATABASE_URL_TEST is not configured.',
    config: shouldSkipDbTests({}).config,
  })
  const result = await withTestDatabase({}, async ({ prisma, env }) => {
    const repository = createDbMasterDataRepository({ env, prisma })
    return repository.listItems()
  })
  assert.deepEqual(result, {
    skipped: true,
    reason: 'DATABASE_URL_TEST is not configured.',
  })
})
