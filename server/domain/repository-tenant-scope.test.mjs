import test from 'node:test'
import assert from 'node:assert/strict'
import { createDbAuditLogRepository } from '../repositories/db-audit-log-repository.mjs'
import { createDbInventoryReadRepository } from '../repositories/db-inventory-read-repository.mjs'
import { createDbMasterDataRepository } from '../repositories/db-master-data-repository.mjs'
import { createDbProcurementReadRepository } from '../repositories/db-procurement-read-repository.mjs'
import { createDbProcurementRuntimeRepository } from '../repositories/db-procurement-runtime-repository.mjs'
import { createDbSalesOrderReadRepository } from '../repositories/db-sales-order-read-repository.mjs'
import { findManyWithinLimit } from '../repositories/repository-read-scope.mjs'
import { handleProcurementWorkflowRoute } from '../routes/procurement-workflow.routes.mjs'
import { sendInternalServerError } from '../utils/safe-errors.mjs'

// A configured default tenant must not be used as a fallback.
const env = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
  FLOWCHAIN_DEFAULT_TENANT_ID: 'tenant-configured-default',
}

// Any table read at all is a failure: the tenant check must come first.
function untouchablePrisma(reads) {
  return new Proxy({}, {
    get(_target, model) {
      return new Proxy({}, {
        get(_inner, method) {
          return async (args) => {
            reads.push({ model: String(model), method: String(method), args })
            return []
          }
        },
      })
    },
  })
}

const tenantRequired = (error) => error.status === 403 && error.code === 'TENANT_CONTEXT_REQUIRED'

test('database read repositories refuse to read without an explicit tenant', async () => {
  const reads = []
  const prisma = untouchablePrisma(reads)
  const masterData = createDbMasterDataRepository({ env, prisma })
  const inventory = createDbInventoryReadRepository({ env, prisma })
  const procurementRead = createDbProcurementReadRepository({ env, prisma })
  const procurementRuntime = createDbProcurementRuntimeRepository({ env, prisma })
  const salesOrders = createDbSalesOrderReadRepository({ env, prisma })
  const auditLog = createDbAuditLogRepository({ env, prisma })

  const calls = {
    'masterData.listItems': () => masterData.listItems(),
    'masterData.getItem': () => masterData.getItem('ITEM-1'),
    'masterData.listSuppliers': () => masterData.listSuppliers({ tenantId: '  ' }),
    'masterData.getSupplier': () => masterData.getSupplier('SUP-1'),
    'masterData.listCustomers': () => masterData.listCustomers(),
    'masterData.listWarehouses': () => masterData.listWarehouses(),
    'masterData.listPaymentTerms': () => masterData.listPaymentTerms(),
    'masterData.listTaxCodes': () => masterData.listTaxCodes(),
    'inventory.listItems': () => inventory.listItems(),
    'inventory.getItem': () => inventory.getItem('SKU-1'),
    'inventory.getSummary': () => inventory.getSummary({}),
    'procurementRead.snapshot': () => procurementRead.snapshot(),
    'procurementRead.listDocuments': () => procurementRead.listDocuments(),
    'procurementRead.getDocument': () => procurementRead.getDocument('po', 'PO-1'),
    'procurementRead.getSummary': () => procurementRead.getSummary(),
    'procurementRuntime.snapshot': () => procurementRuntime.snapshot(),
    'procurementRuntime.listForReport': () => procurementRuntime.listForReport(),
    'salesOrders.listOrders': () => salesOrders.listOrders(),
    'salesOrders.getSummary': () => salesOrders.getSummary({ tenantId: null }),
    'auditLog.listAuditEntries': () => auditLog.listAuditEntries(),
    'auditLog.listAuditEvents': () => auditLog.listAuditEvents(),
  }
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call, tenantRequired, `${name} must require a tenant`)
  }
  assert.deepEqual(reads, [])
})

test('database read repositories scope every query to the tenant they are given', async () => {
  const reads = []
  const prisma = untouchablePrisma(reads)
  const scope = { tenantId: 'tenant-signed-in' }
  await createDbMasterDataRepository({ env, prisma }).listSuppliers(scope)
  await createDbInventoryReadRepository({ env, prisma }).listItems(scope)
  await createDbProcurementReadRepository({ env, prisma }).snapshot(scope)
  await createDbProcurementRuntimeRepository({ env, prisma }).snapshot(scope)
  await createDbSalesOrderReadRepository({ env, prisma }).listOrders(scope)
  await createDbAuditLogRepository({ env, prisma }).listAuditEntries(scope)
  assert.ok(reads.length > 10)
  for (const read of reads) assert.equal(read.args?.where?.tenantId, 'tenant-signed-in', `${read.model}.${read.method}`)
})

test('a tenant-less repository read that escapes a route is answered as 403, not 500', async () => {
  let sent = null
  const error = await createDbSalesOrderReadRepository({ env, prisma: untouchablePrisma([]) }).listOrders().catch(reason => reason)
  sendInternalServerError({}, (_res, status, body) => { sent = { status, body } }, error, { logger: { error() {} } })
  assert.equal(sent.status, 403)
  assert.equal(sent.body.code, 'TENANT_CONTEXT_REQUIRED')
})

test('purchase request item and supplier checks read the signed-in workspace master data', async () => {
  const lookups = []
  const masterData = {
    getItem: async (id, options) => { lookups.push(['item', id, options?.tenantId]); return { itemId: id, sku: id, itemName: 'Widget', baseUom: 'EA', status: 'active', purchasable: true } },
    getSupplier: async (id, options) => { lookups.push(['supplier', id, options?.tenantId]); return { id, supplierName: 'Acme Supply', status: 'active' } },
  }
  let response = null
  await handleProcurementWorkflowRoute({
    req: { method: 'POST' },
    res: {},
    url: new URL('/api/procurement/requests', 'http://localhost'),
    identity: { authenticated: true, tenantId: 'tenant-signed-in', userId: 'buyer-1', role: 'manager' },
    repositories: {
      masterData,
      procurementRuntime: { transact: async () => { throw Object.assign(new Error('read-only'), { status: 409, code: 'PROCUREMENT_DATABASE_COMMAND_REQUIRED' }) } },
    },
    readBody: async () => ({ title: 'Widgets', lines: [{ itemId: 'ITEM-1', supplierId: 'SUP-1', quantity: 2, estimatedUnitPrice: 5 }] }),
    send: (_res, status, payload) => { response = { status, payload } },
  })
  assert.ok(response, 'the route answered')
  assert.ok(lookups.some(([kind]) => kind === 'supplier'))
  assert.ok(lookups.every(([, , tenantId]) => tenantId === 'tenant-signed-in'), JSON.stringify(lookups))
})

test('bounded reads ask for one extra row and report the subject only when it exists', async () => {
  const reported = []
  const onTruncated = (entry) => reported.push(entry)
  const table = (count) => ({ findMany: async ({ take }) => Array.from({ length: Math.min(count, take) }, (_, index) => ({ id: index })) })
  assert.equal((await findManyWithinLimit(table(3), {}, { limit: 3, subject: 'suppliers', onTruncated })).length, 3)
  assert.deepEqual(reported, [])
  assert.equal((await findManyWithinLimit(table(10), {}, { limit: 3, subject: 'suppliers', onTruncated })).length, 3)
  assert.deepEqual(reported, [{ subject: 'suppliers', limit: 3 }])
})
