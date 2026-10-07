import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHomeOverview, createBusinessReadContextService } from '../services/business-read-context-service.mjs'

function repositories() {
  return {
    masterData: {
      adapter: 'json-master-data-v1',
      itemRuntime: { adapter: 'durable-item-master-v1' },
      supplierRuntime: { adapter: 'durable-supplier-master-v1' },
      customerRuntime: { adapter: 'durable-customer-master-v1' },
      listManagedItems: async () => [{ itemId: 'ITEM-1', sku: 'SKU-1', itemName: 'Runtime item' }],
      listSuppliers: async () => [{ id: 'SUP-1', supplierCode: 'SUP-1', supplierName: 'Runtime supplier' }],
      listCustomers: async () => [{ id: 'CUS-1', code: 'CUS-1', name: 'Runtime customer' }],
      listAllItemSupplierRelationships: async () => [{ relationshipId: 'REL-1', itemId: 'ITEM-1', supplierId: 'SUP-1', active: true, approved: true }],
    },
    inventoryRuntime: { adapter: 'durable-inventory-runtime-v1', listItems: async () => [{ itemId: 'ITEM-1', sku: 'SKU-1', onHandQuantity: 9 }] },
    salesOrders: { adapter: 'durable-sales-order-runtime-v1', listOrders: async () => [{ salesOrderId: 'SO-1', itemId: 'ITEM-1', sku: 'SKU-1' }] },
    procurementRuntime: {
      adapter: 'durable-procurement-runtime-v2',
      snapshot: async () => ({
        purchaseRequests: [{ id: 'PR-1', status: 'submitted', totalAmount: 120, defaultCurrency: 'USD', updatedAt: '2026-07-14T01:00:00.000Z', lines: [{ supplierId: 'SUP-1' }] }],
        rfqs: [],
        purchaseOrders: [{ id: 'PO-1', status: 'draft', transmissionStatus: 'not_sent', supplierId: 'SUP-1', totalAmount: 120, updatedAt: '2026-07-14T02:00:00.000Z' }],
        receipts: [], supplierInvoices: [],
      }),
    },
  }
}

test('BusinessReadContext aggregates only runtime repositories and reports unavailable domains', async () => {
  const context = await createBusinessReadContextService({ repositories: repositories(), dataMode: 'user' }).read()
  assert.equal(context.dataMode, 'user')
  assert.equal(context.items[0].sku, 'SKU-1')
  assert.equal(context.suppliers[0].supplierCode, 'SUP-1')
  assert.equal(context.customers[0].code, 'CUS-1')
  assert.equal(context.inventoryItems[0].onHandQuantity, 9)
  assert.equal(context.salesOrders[0].salesOrderId, 'SO-1')
  assert.equal(context.purchaseRequests[0].id, 'PR-1')
  assert.equal(context.itemSupplierRelationships[0].relationshipId, 'REL-1')
  assert.equal(context.warehouses.length, 0)
  assert.ok(context.dataLimitations.includes('warehouse_runtime_not_connected'))
  assert.equal(context.runtimeAdapters.procurement, 'durable-procurement-runtime-v2')
})

test('home overview is server-derived, uses canonical routes and does not manufacture risk zero', async () => {
  const context = await createBusinessReadContextService({ repositories: repositories(), dataMode: 'user' }).read()
  const overview = buildHomeOverview(context)
  assert.equal(overview.workItems.length, 2)
  assert.equal(overview.unresolvedRisks, null)
  assert.equal(overview.counts.unresolvedRisks, null)
  assert.equal(overview.recentDocuments.length, 2)
  assert.ok(overview.recentDocuments.every(row => row.canonicalRoute.startsWith('/app/')))
  assert.ok(overview.limitations.includes('unresolved_risk_metric_not_connected'))
  // Amounts carry the document currency so the page can format them; a document
  // without a stored currency carries none rather than a guess.
  const request = overview.workItems.find(row => row.id === 'PR-1')
  assert.equal(request.amount, 120)
  assert.equal(request.currency, 'USD')
  assert.equal(overview.recentDocuments.find(row => row.id === 'PR-1').currency, 'USD')
  assert.equal(overview.recentDocuments.find(row => row.id === 'PO-1').currency, '')
})

test('BusinessReadContext carries each subject a repository cut off at its read limit', async () => {
  const repos = repositories()
  repos.salesOrders.listOrders = async ({ onTruncated }) => { onTruncated({ subject: 'sales_orders', limit: 500 }); return [] }
  repos.procurementRuntime.snapshot = async ({ onTruncated }) => {
    onTruncated({ subject: 'purchase_orders', limit: 500 })
    onTruncated({ subject: 'purchase_orders', limit: 500 })
    return { purchaseOrders: [], receipts: [], supplierInvoices: [] }
  }
  const context = await createBusinessReadContextService({ repositories: repos }).read({ tenantId: 'tenant-a' })
  assert.deepEqual(context.truncatedSubjects, [{ subject: 'sales_orders', limit: 500 }, { subject: 'purchase_orders', limit: 500 }])
  const complete = await createBusinessReadContextService({ repositories: repositories() }).read({ tenantId: 'tenant-a' })
  assert.deepEqual(complete.truncatedSubjects, [])
})

test('changes today count documents updated on the tenant day, not the UTC day', async () => {
  const context = await createBusinessReadContextService({ repositories: repositories(), dataMode: 'user' }).read()
  // Both documents were updated on Jul 14 UTC, which is still Jul 13 in New York.
  assert.equal(buildHomeOverview(context, { now: new Date('2026-07-14T03:30:00Z'), timeZone: 'America/New_York' }).todayChanges, 2)
  assert.equal(buildHomeOverview(context, { now: new Date('2026-07-14T05:00:00Z'), timeZone: 'America/New_York' }).todayChanges, 0)
  assert.equal(buildHomeOverview(context, { now: new Date('2026-07-14T05:00:00Z'), timeZone: 'UTC' }).todayChanges, 2)
})

test('recent RFQs link to the RFQ detail route, which is /app/procurement/rfq/:id', () => {
  const overview = buildHomeOverview({ purchaseRequests: [], purchaseOrders: [], rfqs: [{ id: 'RFQ-1', status: 'open', updatedAt: '2026-07-14T02:00:00.000Z' }], dataLimitations: [] })
  assert.equal(overview.recentDocuments[0].canonicalRoute, '/app/procurement/rfq/RFQ-1')
})

test('the context carries the recorded unit of every item a purchase order line names, apart from the item list', async () => {
  const repos = repositories()
  let asked = null
  repos.masterData.listRecordedItemUnits = async (filters) => { asked = filters; return [{ sku: 'ZZ-100', itemId: 'ITEM-ZZ', unit: 'pcs' }] }
  repos.procurementRuntime.snapshot = async () => ({ purchaseOrders: [{ id: 'PO-40', status: 'issued', lines: [{ sku: 'ZZ-100', itemId: 'ITEM-ZZ', unit: 'CASE' }, { sku: '', itemId: 'ITEM-Y' }] }] })
  const context = await createBusinessReadContextService({ repositories: repos }).read({ tenantId: 'tenant-1' })
  assert.deepEqual(asked.keys, ['ZZ-100', 'ITEM-ZZ', 'ITEM-Y'])
  assert.equal(asked.tenantId, 'tenant-1')
  assert.deepEqual(context.itemUnits, [{ sku: 'ZZ-100', itemId: 'ITEM-ZZ', unit: 'pcs' }])
  // Without purchase order lines nothing is read.
  repos.procurementRuntime.snapshot = async () => ({ purchaseOrders: [] })
  asked = null
  assert.deepEqual((await createBusinessReadContextService({ repositories: repos }).read({ tenantId: 'tenant-1' })).itemUnits, [])
  assert.equal(asked, null)
})
