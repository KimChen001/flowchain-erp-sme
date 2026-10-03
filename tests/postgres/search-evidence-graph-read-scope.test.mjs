import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { handleEvidenceGraphRoute } from '../../server/routes/evidence-graph.routes.mjs'
import { handleSearchRoute } from '../../server/routes/search.routes.mjs'

// Search and the evidence graph read the business read context as the
// signed-in reader may see it: the read-only viewer gets no purchase order or
// invoice amounts, the procurement specialist gets no supplier invoices or
// sales orders, stock comes from the reader's warehouses, and a reader who
// cannot be resolved gets the identity error.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/search-evidence-graph-read-scope.test.mjs

const tenantId = 'tenant-search-graph-scope'
const users = {
  admin: { id: 'sg-admin', role: 'admin' },
  viewer: { id: 'sg-viewer', role: 'viewer' },
  buyer: { id: 'sg-buyer', role: 'buyer' },
  east: { id: 'sg-east', role: 'business-specialist' },
}

test('search and the evidence graph are scoped to the signed-in reader', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', NODE_ENV: 'test' }
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const [code, name] of [['SG-EAST', 'East'], ['SG-WEST', 'West']]) await prisma.warehouse.create({ data: { id: code, tenantId, code, name, status: 'active' } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@search-graph-scope.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
    await prisma.userWarehouseScope.create({ data: { id: 'sg-east-scope', tenantId, userId: users.east.id, warehouseId: 'SG-EAST', accessLevel: 'read' } })
    await prisma.supplier.create({ data: { id: 'SG-SUP', tenantId, code: 'SG-SUP', name: 'Harbor Supply' } })
    await prisma.item.create({ data: { id: 'SG-ITEM', tenantId, sku: 'SG-SKU', name: 'Valve', unit: 'EA' } })
    await prisma.purchaseOrder.create({ data: {
      id: 'SG-PO', tenantId, supplierId: 'SG-SUP', supplierName: 'Harbor Supply', status: 'issued', currency: 'USD', amount: '48125.0000',
      lines: { create: [{ id: 'SG-PO-L1', sku: 'SG-SKU', itemName: 'Valve', orderedQuantity: '10.0000', receivedQuantity: '0.0000', unitPrice: '4812.5000', amount: '48125.0000', unit: 'EA' }] },
    } })
    await prisma.receivingDocument.create({ data: { id: 'SG-GRN', tenantId, documentNumber: 'SG-GRN', poId: 'SG-PO', supplierId: 'SG-SUP', currency: 'USD' } })
    await prisma.supplierInvoice.create({ data: { id: 'SG-INV', tenantId, invoiceNumber: 'SG-INV', supplierId: 'SG-SUP', supplierName: 'Harbor Supply', amount: '37950.0000', totalAmount: '37950.0000', currency: 'USD', relatedPoId: 'SG-PO' } })
    await prisma.salesOrder.create({ data: {
      id: 'SG-SO', tenantId, orderNumber: 'SG-SO', customerName: 'Redwood Retail', workflowStatus: 'confirmed', currency: 'USD',
      lines: { create: [{ id: 'SG-SO-L1', itemId: 'SG-ITEM', sku: 'SG-SKU', itemName: 'Valve', orderedQuantity: '3.0000', unit: 'EA' }] },
    } })
    for (const [warehouseId, onHand] of [['SG-EAST', '150.0000'], ['SG-WEST', '999.0000']]) {
      await prisma.inventoryBalance.create({ data: { id: `sg-balance-${warehouseId}`, tenantId, itemId: 'SG-ITEM', sku: 'SG-SKU', itemName: 'Valve', warehouseId, warehouseKey: warehouseId, location: 'A-01', locationKey: 'a-01', onHandQuantity: onHand, reservedQuantity: '0', availableQuantity: onHand, unit: 'EA', status: 'available' } })
    }
    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const call = async (handler, identity, path) => {
      let sent
      const ctx = {
        url: new URL(`http://local${path}`), req: { method: 'GET', headers: {} }, res: {}, env, repositories, dataMode: 'user', inventoryPrisma: prisma, identity,
        send: (_res, status, payload) => { sent = { status, body: JSON.parse(JSON.stringify(payload ?? null)) } },
      }
      assert.equal(await handler(ctx), true, path)
      assert.ok(sent, path)
      return sent
    }
    const signedIn = (key) => ({ authenticated: true, tenantId, userId: users[key].id, role: users[key].role, source: 'signed-session' })
    const search = (key, q) => call(handleSearchRoute, signedIn(key), `/api/search?q=${encodeURIComponent(q)}&limit=50`)
    const graph = (key, path) => call(handleEvidenceGraphRoute, signedIn(key), path)
    const types = (body) => body.results.map((row) => row.type)
    const nodeIds = (body) => body.nodes.map((node) => node.entityId).sort()

    // The administrator reads everything, amounts included.
    assert.deepEqual(types((await search('admin', '48125')).body), ['purchase_order'])
    assert.ok(types((await search('admin', 'SG-SO')).body).includes('sales_order'))
    const adminGraph = await graph('admin', '/api/evidence-graph/purchase-order/SG-PO')
    assert.equal(adminGraph.status, 200)
    assert.ok(nodeIds(adminGraph.body).includes('SG-INV'))
    assert.equal(adminGraph.body.nodes.find((node) => node.entityId === 'SG-INV').label, 'Harbor Supply')

    // The read-only viewer: no purchase order or invoice amounts.
    for (const amount of ['48125', '4812.5', '37950']) {
      const found = await search('viewer', amount)
      assert.equal(found.status, 200)
      assert.deepEqual(found.body.results, [], amount)
    }
    const viewerOrder = await search('viewer', 'SG-PO')
    assert.ok(types(viewerOrder.body).includes('purchase_order'))
    assert.equal(JSON.stringify(viewerOrder.body).includes('48125'), false)
    for (const path of ['/api/evidence-graph/purchase-order/SG-PO', '/api/evidence-graph/invoice/SG-INV']) {
      const viewerGraph = await graph('viewer', path)
      assert.equal(viewerGraph.status, 200, path)
      const text = JSON.stringify(viewerGraph.body)
      for (const secret of ['48125', '4812.5', '37950', 'Harbor Supply']) assert.equal(text.includes(secret), false, `${path} leaks ${secret}`)
    }

    // The procurement specialist: no supplier invoices or sales orders.
    for (const query of ['SG-SO', 'Redwood', 'SG-INV']) {
      const found = await search('buyer', query)
      assert.equal(found.status, 200)
      assert.ok(!types(found.body).includes('sales_order'), query)
      assert.ok(!types(found.body).includes('supplier_invoice'), query)
    }
    assert.ok((await search('buyer', 'SG-SO')).body.restrictedSubjects.includes('sales_orders'))
    const buyerGraph = await graph('buyer', '/api/evidence-graph/purchase-order/SG-PO')
    assert.equal(buyerGraph.status, 200)
    assert.ok(!nodeIds(buyerGraph.body).includes('SG-INV'))
    assert.ok(buyerGraph.body.restrictedSubjects.includes('supplier_invoices'))
    for (const path of ['/api/evidence-graph/invoice/SG-INV', '/api/evidence-graph/sales-order/SG-SO']) {
      const denied = await graph('buyer', path)
      assert.equal(denied.status, 403, path)
      assert.equal(JSON.stringify(denied.body).includes('Redwood'), false, path)
    }

    // The East reader's graph and search hold East stock only.
    const eastGraph = await graph('east', '/api/evidence-graph?entityType=inventory_item&entityId=SG-SKU')
    assert.equal(eastGraph.status, 200)
    assert.equal(JSON.stringify(eastGraph.body).includes('SG-WEST'), false)
    assert.ok(types((await search('east', 'SG-SKU')).body).includes('inventory_item'))
    assert.deepEqual(types((await search('east', 'SG-WEST')).body).filter((type) => type === 'inventory_item'), [])

    // A reader who cannot be resolved gets the identity error, not a 500.
    const signedOut = { authenticated: false }
    assert.equal((await call(handleSearchRoute, signedOut, '/api/search?q=SG')).status, 401)
    assert.equal((await call(handleEvidenceGraphRoute, signedOut, '/api/evidence-graph/purchase-order/SG-PO')).status, 401)
    const stranger = { authenticated: true, tenantId, userId: 'sg-not-provisioned', role: 'admin', source: 'signed-session' }
    const strangerSearch = await call(handleSearchRoute, stranger, '/api/search?q=SG')
    assert.equal(strangerSearch.status, 403)
    assert.equal(strangerSearch.body.code, 'ACTOR_NOT_PROVISIONED')
    assert.equal((await call(handleEvidenceGraphRoute, stranger, '/api/evidence-graph/purchase-order/SG-PO')).status, 403)
  } finally {
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
