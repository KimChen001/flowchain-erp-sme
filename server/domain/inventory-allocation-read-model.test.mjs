import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInventoryAllocationReadModel,
  buildReservationPreview,
  getSkuAvailability,
  resolvePurchaseOrderSupplyImpact,
  resolveSalesOrderAllocationImpact,
} from './inventory-allocation-read-model.mjs'
import { classifyRoute, ROUTE_CLASSES } from './route-classification.mjs'
import { handleInventoryRoute } from '../routes/inventory.routes.mjs'

const db = {
  products: [
    { sku: 'SKU-00412', itemName: '高扭矩伺服电机', currentStock: 40, reservedQuantity: 30, safetyStock: 60, reorderPoint: 70, unit: '件', riskLevel: '高', supplier: '深圳新元电气' },
  ],
  salesOrders: [
    { salesOrderId: 'SO-HIGH', customerName: '华东精密制造', customerTier: '重点客户', sku: 'SKU-00412', itemName: '高扭矩伺服电机', orderedQty: 100, reservedQty: 20, fulfilledQty: 0, promisedDate: '2026-07-12', priority: '高', linkedPurchaseOrders: ['PO-2026-1282'], linkedSuppliers: ['深圳新元电气'] },
    { salesOrderId: 'SO-MID', customerName: '宁波电子科技', customerTier: '常规客户', sku: 'SKU-00412', itemName: '高扭矩伺服电机', orderedQty: 30, reservedQty: 10, fulfilledQty: 0, promisedDate: '2026-07-18', priority: '中', linkedPurchaseOrders: ['PO-2026-1282'], linkedSuppliers: ['深圳新元电气'] },
  ],
  purchaseOrders: [
    { po: 'PO-2026-1282', supplier: '深圳新元电气', status: '已发出', eta: '2026-07-02', sourceSku: 'SKU-00412', sourceName: '高扭矩伺服电机', items: 80, received: 20 },
  ],
  receivingDocs: [
    { grn: 'GRN-2026-7788', po: 'PO-2026-1282', supplier: '深圳新元电气', status: '部分收货', items: 20 },
  ],
  suppliers: [
    { id: 'SUP-SZXY', name: '深圳新元电气', risk: '中', status: '启用' },
  ],
}

function routeContext(method, pathname, bodyDb = db) {
  const url = new URL(pathname, 'http://localhost')
  const payloads = []
  return {
    req: { method },
    res: {},
    url,
    db: structuredClone(bodyDb),
    identity: { authenticated: true, tenantId: 'tenant-test', userId: 'user-test', role: 'manager', source: 'test' },
    send: (_res, status, payload) => payloads.push({ status, payload }),
    payloads,
  }
}

test('inventory allocation calculates availability ATP incoming projected shortage and risk', () => {
  const model = buildInventoryAllocationReadModel(db, { today: '2026-07-03' })
  const item = model.availability.find((row) => row.sku === 'SKU-00412')
  assert.ok(item)
  assert.equal(item.onHandQty, 40)
  assert.equal(item.reservedQty, 30)
  assert.equal(item.salesDemandQty, 130)
  assert.equal(item.allocatedDemandQty, 30)
  assert.equal(item.availableQty, 10)
  assert.equal(item.incomingPurchaseQty, 60)
  assert.equal(item.overdueIncomingQty, 60)
  assert.equal(item.projectedAvailableQty, -30)
  assert.equal(item.shortageQty, 90)
  assert.equal(item.availableToPromiseQty, 0)
  assert.equal(item.riskLevel, 'blocked')
  assert.ok(item.affectedSalesOrders.some((order) => order.salesOrderId === 'SO-HIGH'))
  assert.ok(item.linkedPurchaseOrders.some((po) => po.poId === 'PO-2026-1282'))
})

test('reservation preview returns suggested quantity conflicts and does not mutate db', () => {
  const before = JSON.stringify(db)
  const preview = buildReservationPreview(db, { sku: 'SKU-00412', salesOrderId: 'SO-HIGH', requestedQty: 25 })
  assert.equal(preview.reservableQty, 10)
  assert.equal(preview.reservationSuggestedQty, 10)
  assert.equal(preview.reservationShortageQty, 15)
  assert.ok(preview.reservationConflictOrders.some((order) => order.salesOrderId === 'SO-MID'))
  assert.equal(JSON.stringify(db), before)
})

test('SKU and PO impact list affected orders and data limitations', () => {
  const orderImpact = resolveSalesOrderAllocationImpact(db, 'SO-HIGH')
  assert.equal(orderImpact.availability.sku, 'SKU-00412')
  assert.equal(orderImpact.reservationPreview.reservationShortageQty > 0, true)

  const poImpact = resolvePurchaseOrderSupplyImpact(db, 'PO-2026-1282')
  assert.ok(poImpact.impactedSkus.some((item) => item.sku === 'SKU-00412'))
  assert.ok(poImpact.affectedSalesOrders.some((order) => order.salesOrderId === 'SO-HIGH'))
})

test('missing records return business data limitations', () => {
  const item = getSkuAvailability({ products: [{ sku: 'SKU-LIMITED', currentStock: 2, safetyStock: 5 }] }, 'SKU-LIMITED')
  assert.ok(item.dataLimitations.includes('missing_sales_demand_records'))
  assert.ok(item.dataLimitations.includes('missing_daily_demand_history'))
})

test('inventory allocation API is read-only and route classification marks it read-only', async () => {
  const classification = classifyRoute('GET', '/api/inventory/availability')
  assert.equal(classification.classification, ROUTE_CLASSES.readOnly)
  assert.equal(classification.writesJson, false)

  const getCtx = routeContext('GET', '/api/inventory/reservation-preview?sku=SKU-00412&salesOrderId=SO-HIGH&requestedQty=25')
  assert.equal(await handleInventoryRoute(getCtx), true)
  assert.equal(getCtx.payloads[0].status, 200)
  assert.equal(getCtx.payloads[0].payload.reservationPreview.reservableQty, 10)
  assert.equal(getCtx.payloads[0].payload.availability.reserved, 30)

  const postCtx = routeContext('POST', '/api/inventory/availability')
  assert.equal(await handleInventoryRoute(postCtx), true)
  assert.equal(postCtx.payloads[0].status, 405)
})
