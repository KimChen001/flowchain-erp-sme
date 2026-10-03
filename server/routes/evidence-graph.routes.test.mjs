import test from 'node:test'
import assert from 'node:assert/strict'
import { handleEvidenceGraphRoute } from './evidence-graph.routes.mjs'
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { defaultRoleTemplates, permissionCodes } from '../auth/permission-catalog.mjs'

const roleAccess = (roleKey, warehouseIds = null) => ({
  ...reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-g', permissionCodes: new Set(roleKey === '*' ? permissionCodes : defaultRoleTemplates.find(role => role.roleKey === roleKey).permissions) }),
  warehouseIds,
})

function createDb() {
  return {
    __dataMode: 'workspace',
    products: [{ sku: 'SKU-00412', name: '高扭矩伺服电机', currentStock: 34, reservedQuantity: 36, safetyStock: 50, supplier: '深圳新元电气', status: '低库存', riskLevel: '高' }],
    suppliers: [{ id: 'SUP-SZXY', name: '深圳新元电气', status: 'active', risk: 'medium' }],
    salesOrders: [{ salesOrderId: 'SO-2026-0412-A', customerName: '华东精密制造', sku: 'SKU-00412', itemName: '高扭矩伺服电机', orderedQty: 120, reservedQty: 36, promisedDate: '2026-07-12', priority: '高', linkedPurchaseOrders: ['PO-2026-1282'], linkedSuppliers: ['深圳新元电气'], status: 'shortage_risk' }],
    purchaseRequests: [{ pr: 'PR-2026-2401', sourceSku: 'SKU-00412', supplier: '深圳新元电气', quantity: 120, status: '已批准' }],
    rfqs: [{ id: 'RFQ-26-0046', sourceRequest: 'PR-2026-2401', sourceSku: 'SKU-00412', bestSupplier: '深圳新元电气', status: '进行中' }],
    purchaseOrders: [{ po: 'PO-2026-1282', sourceSku: 'SKU-00412', sourceRequest: 'PR-2026-2401', sourceRfq: 'RFQ-26-0046', supplier: '深圳新元电气', eta: '2026-07-10', items: 120, received: 20, status: '部分到货' }],
    receivingDocs: [{ grn: 'GRN-202605-0418', po: 'PO-2026-1282', supplier: '深圳新元电气', status: '待质检' }],
    supplierInvoices: [{ invoiceNumber: 'INV-SZ-260601', supplier: '深圳新元电气', relatedPo: 'PO-2026-1282', relatedGrn: 'GRN-202605-0418', amount: 82000, varianceAmount: 1200, matchStatus: '存在差异' }],
  }
}

function createRoute(method, path, db = createDb(), access = roleAccess('*')) {
  let response = null
  return {
    ctx: {
      req: { method },
      res: {},
      url: new URL(path, 'http://localhost'),
      db,
      reportReadAccess: access,
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

test('GET /api/evidence-graph builds read-only graph by query anchor', async () => {
  const route = createRoute('GET', '/api/evidence-graph?entityType=sales_order&entityId=SO-2026-0412-A&depth=2')
  const handled = await handleEvidenceGraphRoute(route.ctx)

  assert.equal(handled, true)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.anchor.id, 'SO-2026-0412-A')
  assert.equal(route.response.payload.nodes.some((node) => node.id === 'SKU-00412'), true)
  assert.equal(route.response.payload.edges.some((edge) => edge.relation === 'references_item'), true)
  assert.ok(route.response.payload.nodes.every((node) => node.entityType && node.entityId && node.canonicalRoute && node.sourceRepository))
})

test('evidence graph shortcut routes return expected related records', async () => {
  const route = createRoute('GET', '/api/evidence-graph/purchase-order/PO-2026-1282')
  await handleEvidenceGraphRoute(route.ctx)

  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.relatedRecords.purchaseRequests.some((item) => item.id === 'PR-2026-2401'), true)
  assert.equal(route.response.payload.relatedRecords.receivingDocs.some((item) => item.id === 'GRN-202605-0418'), true)
})

test('GET /api/evidence-graph/related returns compact related records', async () => {
  const route = createRoute('GET', '/api/evidence-graph/related?entityType=sku&entityId=SKU-00412')
  await handleEvidenceGraphRoute(route.ctx)

  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.relatedRecords.salesOrders.some((item) => item.id === 'SO-2026-0412-A'), true)
  assert.equal(route.response.payload.relatedRecords.inventoryItems.some((item) => item.id === 'SKU-00412'), true)
  assert.ok(Array.isArray(route.response.payload.nodes))
})

test('evidence graph missing anchor returns 404 with business limitation', async () => {
  const route = createRoute('GET', '/api/evidence-graph/sku/SKU-NOT-FOUND')
  await handleEvidenceGraphRoute(route.ctx)

  assert.equal(route.response.status, 404)
  assert.deepEqual(route.response.payload.dataLimitations, ['record_not_found'])
  assert.doesNotMatch(JSON.stringify(route.response.payload), /stack|trace|DATABASE_URL/)
})

test('evidence graph routes are GET-only and non-mutating', async () => {
  const db = createDb()
  const before = JSON.stringify(db)
  const route = createRoute('POST', '/api/evidence-graph', db)
  const handled = await handleEvidenceGraphRoute(route.ctx)

  assert.equal(handled, true)
  assert.equal(route.response.status, 405)
  assert.equal(JSON.stringify(db), before)
})

// The graph is built from the business read context as the reader may see it.
// The production read path: repositories behind the business read context
// service, with an inventory repository that honours the warehouse ids.
function scopedRepositories(seen) {
  const balances = [
    { sku: 'SKU-1', itemName: 'Valve', warehouseId: 'WH-EAST', onHandQuantity: 150 },
    { sku: 'SKU-2', itemName: 'Gasket', warehouseId: 'WH-WEST', onHandQuantity: 999 },
  ]
  return {
    masterData: {
      listItems: async () => [{ id: 'SKU-1', sku: 'SKU-1', name: 'Valve' }, { id: 'SKU-2', sku: 'SKU-2', name: 'Gasket' }],
      listSuppliers: async () => [{ id: 'SUP-1', name: 'Harbor Supply', bankAccountNumber: '000123456789' }],
      listCustomers: async () => [],
      listAllItemSupplierRelationships: async () => [{ itemId: 'SKU-1', supplierId: 'SUP-1', referencePrice: 4812.5 }],
    },
    inventoryRuntime: { listItems: async (scope) => { seen.warehouseIds = scope?.warehouseIds ?? null; return scope?.warehouseIds ? balances.filter(row => scope.warehouseIds.includes(row.warehouseId)) : balances } },
    salesOrders: { listOrders: async () => [{ id: 'SO-1', salesOrderId: 'SO-1', customerName: 'Redwood Retail', sku: 'SKU-1', orderedQty: 4, status: 'confirmed', totalAmount: 720 }] },
    procurementRuntime: { snapshot: async () => ({
      purchaseRequests: [{ id: 'PR-1', status: 'approved', totalAmount: 48125 }],
      rfqs: [],
      purchaseOrders: [{ id: 'PO-1', sourcePrId: 'PR-1', status: 'approved', supplierId: 'SUP-1', totalAmount: 48125, lines: [{ sku: 'SKU-1', unitPrice: 4812.5, amount: 48125 }] }],
      receipts: [{ id: 'GRN-1', poId: 'PO-1', status: 'posted' }],
      supplierInvoices: [{ id: 'INV-1', invoiceNumber: 'INV-1', supplierName: 'Harbor Supply', poId: 'PO-1', receiptId: 'GRN-1', totalAmount: 37950, varianceAmount: 1200 }],
    }) },
  }
}

async function scopedGraph(path, access) {
  let response
  const seen = {}
  const handled = await handleEvidenceGraphRoute({
    req: { method: 'GET' }, res: {}, url: new URL(path, 'http://localhost'),
    repositories: scopedRepositories(seen), dataMode: 'user', identity: { authenticated: true, tenantId: 'tenant-g' }, reportReadAccess: access,
    send: (_res, status, payload) => { response = { status, payload: JSON.parse(JSON.stringify(payload)) } },
  })
  assert.equal(handled, true)
  return { ...response, seen }
}
const nodeIds = (payload) => payload.nodes.map(node => node.entityId).sort()

test('a reader with every permission sees the invoice and its supplier in the graph', async () => {
  const { status, payload } = await scopedGraph('/api/evidence-graph/purchase-order/PO-1', roleAccess('*'))
  assert.equal(status, 200)
  assert.deepEqual(nodeIds(payload), ['GRN-1', 'INV-1', 'PO-1', 'PR-1'])
  assert.equal(payload.nodes.find(node => node.entityId === 'INV-1').label, 'Harbor Supply')
  assert.deepEqual(payload.restrictedSubjects, [])
})

test('the read-only viewer gets no purchase order or invoice amounts from the evidence graph', async () => {
  const viewer = roleAccess('read-only-viewer')
  for (const path of ['/api/evidence-graph/purchase-order/PO-1', '/api/evidence-graph/invoice/INV-1', '/api/evidence-graph/sku/SKU-1', '/api/evidence-graph/related?entityType=po&entityId=PO-1']) {
    const { status, payload } = await scopedGraph(path, viewer)
    assert.equal(status, 200, path)
    const text = JSON.stringify(payload)
    for (const secret of ['48125', '4812.5', '37950', '1200', '000123456789']) assert.equal(text.includes(secret), false, `${path} leaks ${secret}`)
  }
  // The invoice stays linked, but its supplier needs finance.partner_snapshot.read.
  const { payload } = await scopedGraph('/api/evidence-graph/purchase-order/PO-1', viewer)
  assert.ok(nodeIds(payload).includes('INV-1'))
  assert.equal(payload.nodes.find(node => node.entityId === 'INV-1').label, 'INV-1')
  assert.equal(JSON.stringify(payload).includes('Harbor Supply'), false)
})

test('the procurement specialist gets no supplier invoices or sales orders from the evidence graph', async () => {
  const buyer = roleAccess('procurement-specialist')
  const order = await scopedGraph('/api/evidence-graph/purchase-order/PO-1', buyer)
  assert.equal(order.status, 200)
  assert.deepEqual(nodeIds(order.payload), ['GRN-1', 'PO-1', 'PR-1'])
  assert.deepEqual(order.payload.relatedRecords.supplierInvoices, [])
  assert.ok(order.payload.restrictedSubjects.includes('supplier_invoices'))
  const item = await scopedGraph('/api/evidence-graph/related?entityType=sku&entityId=SKU-1', buyer)
  assert.equal(item.status, 200)
  assert.deepEqual(item.payload.relatedRecords.salesOrders, [])
  assert.equal(JSON.stringify(item.payload).includes('Redwood'), false)
  // An anchor of a type the role cannot read is refused by type, whether or
  // not the record exists.
  for (const path of ['/api/evidence-graph/invoice/INV-1', '/api/evidence-graph/invoice/INV-MISSING', '/api/evidence-graph/sales-order/SO-1', '/api/evidence-graph?entityType=customer_order&entityId=SO-1']) {
    const { status, payload } = await scopedGraph(path, buyer)
    assert.equal(status, 403, path)
    assert.equal(payload.code, 'AUTHORIZATION_PERMISSION_DENIED', path)
    assert.equal(JSON.stringify(payload).includes('Redwood'), false, path)
    assert.equal(payload.nodes, undefined, path)
  }
})

test("the evidence graph reads inventory from the reader's warehouses only", async () => {
  const east = roleAccess('operations-specialist', ['WH-EAST'])
  const inside = await scopedGraph('/api/evidence-graph?entityType=inventory_item&entityId=SKU-1', east)
  assert.deepEqual(inside.seen.warehouseIds, ['WH-EAST'])
  assert.equal(inside.status, 200)
  assert.equal(inside.payload.anchor.entityType, 'inventory_item')
  // West stock is not in the reader's context, so the graph falls back to
  // the item master record and shows no West balance.
  const outside = await scopedGraph('/api/evidence-graph?entityType=inventory_item&entityId=SKU-2', east)
  assert.equal(outside.payload.anchor.entityType, 'item')
  assert.ok(!outside.payload.nodes.some(node => node.entityType === 'inventory_item'))
  assert.equal(JSON.stringify(outside.payload).includes('999'), false)
})
