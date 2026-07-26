import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCustomerDeliveryRisks,
  buildSalesDemandReadModel,
  getSalesOrderById,
  listSalesOrders,
  resolvePurchaseOrderSalesImpact,
  resolveSalesDemandEvidence,
  resolveSkuDemandImpact,
} from './sales-demand-read-model.mjs'
import { handleSalesDemandRoute } from '../routes/sales-demand.routes.mjs'

function createDb() {
  return {
    products: [
      { sku: 'SKU-00412', itemName: '高扭矩伺服电机', currentStock: 40, safetyStock: 60, reservedQuantity: 30, unit: '件', riskLevel: '高', supplier: '深圳新元电气' },
      { sku: 'SKU-OK', itemName: '稳定供货模块', currentStock: 300, safetyStock: 40, unit: '件', riskLevel: '低', supplier: '杭州精密组件' },
    ],
    purchaseOrders: [
      { po: 'PO-2026-1282', supplier: '深圳新元电气', status: '延迟', eta: '2026-07-20', sourceSku: 'SKU-00412', sourceName: '高扭矩伺服电机', amount: 120000 },
      { po: 'PO-OK', supplier: '杭州精密组件', status: '已发出', eta: '2026-07-08', sourceSku: 'SKU-OK', sourceName: '稳定供货模块', amount: 8000 },
    ],
    receivingDocs: [
      { grn: 'GRN-2026-7788', po: 'PO-2026-1282', supplier: '深圳新元电气', status: '部分收货', arrived: '2026-07-06' },
    ],
    suppliers: [
      { id: 'SUP-001', name: '深圳新元电气', risk: '高风险', status: '启用', score: 68 },
      { id: 'SUP-002', name: '杭州精密组件', risk: '低风险', status: '启用', score: 91 },
    ],
    salesOrders: [
      { salesOrderId: 'SO-HIGH', customerName: '华东精密制造', customerTier: '重点客户', sku: 'SKU-00412', itemName: '高扭矩伺服电机', orderedQty: 100, reservedQty: 20, promisedDate: '2026-07-12', status: 'shortage_risk', linkedPurchaseOrders: ['PO-2026-1282'], linkedSuppliers: ['深圳新元电气'] },
      { salesOrderId: 'SO-LOW', customerName: '杭州自动化设备', customerTier: '常规客户', sku: 'SKU-OK', itemName: '稳定供货模块', orderedQty: 30, reservedQty: 30, promisedDate: '2026-07-18', status: 'ready_to_ship' },
    ],
  }
}

function routeContext(method, path, db = createDb()) {
  let response = null
  let wrote = false
  const orders = db.salesOrders.map(row => ({ ...row, statusLabel: row.status, deliveryRiskLevel: row.status === 'shortage_risk' ? 'high' : 'low', linkedPurchaseOrders: (row.linkedPurchaseOrders || []).map(id => ({ id })) }))
  return {
    ctx: {
      req: { method },
      identity: { authenticated: true, userId: 'runtime-manager', name: 'Runtime Manager', role: 'manager' },
      res: {},
      url: new URL(path, 'http://localhost'),
      db,
      send(_res, status, payload) { response = { status, payload } },
      writeDb: async () => { wrote = true },
      readBody: async () => ({ salesOrderId: 'SO-RUNTIME-WRITE', customerName: 'Runtime customer', sku: 'SKU-OK', orderedQty: 1 }),
      repositories: { salesOrders: {
        listOrders: async (filters = {}) => orders.filter(row => !filters.sku || row.sku === filters.sku),
        getOrder: async id => orders.find(row => row.salesOrderId === id) || null,
        getSummary: async () => ({ totalOrders: orders.length }),
        upsertOrder: async input => { const row = { ...input, linkedPurchaseOrders: [], deliveryRiskLevel: 'low' }; orders.unshift(row); return row },
      } },
    },
    get response() { return response },
    get wrote() { return wrote },
  }
}

test('Sales Demand read model computes shortage risk summary and evidence', () => {
  const db = createDb()
  const model = buildSalesDemandReadModel(db)
  const high = getSalesOrderById(db, 'SO-HIGH')

  assert.equal(model.summary.totalOrders, 2)
  assert.equal(model.summary.riskOrderCount, 1)
  assert.equal(model.summary.shortageQty, 80)
  assert.equal(high.shortageQty, 80)
  assert.equal(high.deliveryRiskLevel, 'blocked')
  assert.equal(high.deliveryRiskLabel, '已阻塞')
  assert.equal(high.linkedPurchaseOrders[0].id, 'PO-2026-1282')
  assert.equal(high.linkedReceivingDocs[0].id, 'GRN-2026-7788')
  assert.equal(high.evidence.some((item) => item.type === 'sales_order'), true)
})

test('missing sales orders stay honestly empty and do not write back to db', () => {
  const db = { products: [], purchaseOrders: [], receivingDocs: [], suppliers: [] }
  const before = JSON.stringify(db)
  const model = buildSalesDemandReadModel(db)

  assert.deepEqual(model.orders, [])
  assert.equal(JSON.stringify(db), before)
  assert.equal(Object.hasOwn(db, 'salesOrders'), false)
})

test('SKU and PO impact expose affected sales orders and business data limitations', () => {
  const db = createDb()
  const skuImpact = resolveSkuDemandImpact(db, 'SKU-00412')
  const poImpact = resolvePurchaseOrderSalesImpact(db, 'PO-2026-1282')
  const evidence = resolveSalesDemandEvidence(db, 'SO-HIGH')

  assert.equal(skuImpact.orders.map((order) => order.salesOrderId).includes('SO-HIGH'), true)
  assert.equal(poImpact.orders.map((order) => order.salesOrderId).includes('SO-HIGH'), true)
  assert.equal(evidence.evidenceLinks.some((item) => item.type === 'po'), true)

  const limited = buildSalesDemandReadModel({ salesOrders: [{ salesOrderId: 'SO-MISS', sku: 'SKU-MISS', orderedQty: 5, reservedQty: 0 }] })
  assert.equal(limited.dataLimitations.includes('missing_inventory_allocation'), true)
  assert.equal(limited.dataLimitations.includes('missing_purchase_order_links'), true)
  assert.equal(limited.dataLimitations.includes('demo_data'), false)
  assert.equal(limited.dataLimitations.includes('sample_data'), false)
})

test('Sales Demand route reads and explicitly persists runtime orders while rejecting unsupported writes', async () => {
  const db = createDb()
  const listRoute = routeContext('GET', '/api/sales-demand/orders', db)
  assert.equal(await handleSalesDemandRoute(listRoute.ctx), true)
  assert.equal(listRoute.response.status, 200)
  assert.equal(listRoute.response.payload.orders.length, 2)
  assert.equal(listRoute.wrote, false)

  const detailRoute = routeContext('GET', '/api/sales-demand/orders/SO-HIGH', db)
  assert.equal(await handleSalesDemandRoute(detailRoute.ctx), true)
  assert.equal(detailRoute.response.payload.order.salesOrderId, 'SO-HIGH')

  const impactRoute = routeContext('GET', '/api/sales-demand/po-impact?poId=PO-2026-1282', db)
  assert.equal(await handleSalesDemandRoute(impactRoute.ctx), true)
  assert.equal(impactRoute.response.payload.orders[0].salesOrderId, 'SO-HIGH')

  const writeRoute = routeContext('POST', '/api/sales-demand/orders', db)
  assert.equal(await handleSalesDemandRoute(writeRoute.ctx), true)
  assert.equal(writeRoute.response.status, 201)
  assert.equal(writeRoute.response.payload.order.salesOrderId, 'SO-RUNTIME-WRITE')
  assert.equal(writeRoute.wrote, false)

  const unsupported = routeContext('PATCH', '/api/sales-demand/orders/SO-HIGH', db)
  assert.equal(await handleSalesDemandRoute(unsupported.ctx), true)
  assert.equal(unsupported.response.status, 405)

  assert.equal(listSalesOrders(db, { q: '华东' })[0].salesOrderId, 'SO-HIGH')
  assert.equal(buildCustomerDeliveryRisks(db)[0].salesOrderId, 'SO-HIGH')
})
