import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DATABASE_CONFIG_ERROR,
  getPersistenceConfig,
  isDatabasePersistenceEnabled,
  validateDatabasePersistenceConfig,
} from '../persistence/persistence-config.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('persistence config is PostgreSQL-only and requires DATABASE_URL', () => {
  assert.deepEqual(getPersistenceConfig({}), {
    mode: 'database',
    databaseConfigured: false,
    databaseUrl: '',
  })
  assert.deepEqual(getPersistenceConfig({ DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain' }), {
    mode: 'database',
    databaseConfigured: true,
    databaseUrl: 'postgresql://user:pass@localhost:5432/flowchain',
  })
  assert.throws(() => isDatabasePersistenceEnabled({}), { code: 'FLOWCHAIN_DATABASE_URL_REQUIRED' })
})

test('database configuration validates DATABASE_URL for every runtime', () => {
  assert.throws(
    () => validateDatabasePersistenceConfig({ FLOWCHAIN_PERSISTENCE_MODE: 'database' }),
    (error) => error.message === DATABASE_CONFIG_ERROR && error.code === 'FLOWCHAIN_DATABASE_URL_REQUIRED'
  )
  assert.deepEqual(validateDatabasePersistenceConfig({
    FLOWCHAIN_PERSISTENCE_MODE: 'database',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
  }), {
    mode: 'database',
    databaseConfigured: true,
    databaseUrl: 'postgresql://user:pass@localhost:5432/flowchain',
  })
})

test('Prisma client module validates config before dynamic import', async () => {
  await assert.rejects(
    () => getPrismaClient({ FLOWCHAIN_PERSISTENCE_MODE: 'database' }),
    /FLOWCHAIN_DATABASE_URL_REQUIRED/
  )

  const source = readSource('server', 'persistence', 'prisma-client.mjs')
  assert.match(source, /await import\('@prisma\/client'\)/)
  assert.ok(source.indexOf('validateDatabasePersistenceConfig') < source.indexOf("await import('@prisma/client')"))
})

test('Prisma schema contains PostgreSQL runtime foundations and read models', () => {
  const schema = readSource('prisma', 'schema.prisma')
  const config = readSource('prisma.config.ts')

  for (const model of ['Tenant', 'User', 'RuntimeRecord', 'Supplier', 'Item', 'Warehouse', 'PaymentTerm', 'TaxCode', 'ActionDraft', 'ActionDraftValidation', 'ActionDraftAuditTrail', 'AuditLog', 'AiEvidence', 'PurchaseRequest', 'PurchaseRequestLine', 'Rfq', 'RfqLine', 'SupplierQuotation', 'SupplierQuotationLine', 'PurchaseOrder', 'PurchaseOrderLine', 'ReceivingDocument', 'ReceivingLine', 'SupplierInvoice', 'SupplierInvoiceLine', 'ThreeWayMatch', 'DocumentLink', 'ProcurementFollowup', 'InventoryBalance', 'InventoryLot', 'InventorySerial', 'InventoryMovement', 'InventoryException']) {
    assert.match(schema, new RegExp(`model ${model} \\{`), model)
  }

  for (const excluded of ['PaymentExecution', 'GeneralLedgerEntry', 'TaxFiling', 'BankIntegration']) {
    assert.doesNotMatch(schema, new RegExp(`model ${excluded} \\{`), excluded)
  }

  assert.doesNotMatch(schema, /DATABASE_URL/)
  assert.match(config, /url: env\('DATABASE_URL'\)/)
})
