import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTodayCockpit } from './today-cockpit-read-model.mjs'
import { buildProcurementFollowups } from './procurement-read-model.mjs'
import { handleTodayCockpitRoute } from '../routes/today-cockpit.routes.mjs'

const fixture = {
  purchaseRequests: [
    {
      pr: 'PR-2026-2400',
      sourceSku: 'SKU-00287',
      sourceName: '铝合金型材 6063',
      supplier: '江苏铝合金集团',
      requester: '张磊',
      buyer: '王志强',
      requiredDate: '2026-07-05',
      amount: 142000,
      currency: 'CNY',
      status: '已批准',
      linkedPo: 'PO-2026-1301',
    },
  ],
  rfqs: [
    {
      id: 'RFQ-26-0047',
      title: 'SKU-00287 采购询价',
      suppliers: 3,
      quoted: 1,
      due: '2026-06-20',
      status: '进行中',
      sourceRequest: 'PR-2026-2400',
      linkedPo: 'PO-2026-1301',
      bestSupplier: '江苏铝合金集团',
    },
  ],
  purchaseOrders: [
    {
      po: 'PO-2026-1301',
      supplier: '江苏铝合金集团',
      eta: '2026-06-12',
      owner: '王志强',
      amount: 142000,
      currency: 'CNY',
      items: 1000,
      received: 400,
      status: '已发出',
      sourceRequest: 'PR-2026-2400',
      sourceRfq: 'RFQ-26-0047',
    },
  ],
  receivingDocs: [
    {
      grn: 'GRN-202606-0430',
      po: 'PO-2026-1301',
      supplier: '江苏铝合金集团',
      status: '已入库',
      items: 400,
      warehouse: 'A 区',
    },
  ],
  supplierInvoices: [
    {
      invoiceNumber: 'INV-JS-260620',
      supplier: '江苏铝合金集团',
      relatedPo: 'PO-2026-1301',
      relatedGrn: 'GRN-202606-0430',
      amount: 142000,
      currency: 'CNY',
      varianceAmount: 8600,
      matchStatus: '存在差异',
    },
  ],
  products: [
    {
      sku: 'SKU-00287',
      name: '铝合金型材 6063',
      currentStock: 12,
      min: 50,
      reorderPoint: 80,
      unit: 'kg',
      warehouse: 'WH-A',
      status: '低库存',
      riskLevel: '高',
    },
  ],
  inventoryMovements: [
    {
      movementId: 'MV-2026-0001',
      movementType: 'PurchaseReceipt',
      date: '2026-06-28',
      sku: 'SKU-00287',
      itemName: '铝合金型材 6063',
      warehouse: 'WH-A',
      sourceDocument: 'GRN-202606-0430',
      quantityIn: 400,
      status: '已登记',
      unit: 'kg',
      relatedPo: 'PO-2026-1301',
      relatedGrn: 'GRN-202606-0430',
    },
  ],
  inventoryExceptions: [
    {
      id: 'IEX-2026-0001',
      type: '库存调整',
      sku: 'SKU-00287',
      itemName: '铝合金型材 6063',
      warehouse: 'WH-A',
      quantityImpact: -8,
      unit: 'kg',
      status: '待复核',
      nextAction: '复核盘点差异',
    },
  ],
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function snapshot(value) {
  return JSON.stringify(value)
}

function createRouteContext(pathname, db = clone(fixture)) {
  let response = null
  let wrote = false
  return {
    ctx: {
      req: { method: 'GET' },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      send(_res, status, payload) {
        response = { status, payload }
      },
      writeDb: async () => { wrote = true },
    },
    get response() {
      return response
    },
    get wrote() {
      return wrote
    },
  }
}

test('today cockpit returns stable top-level fields and cards', () => {
  const db = clone(fixture)
  const before = snapshot(db)
  const cockpit = buildTodayCockpit(db, { now: '2026-06-29T00:00:00Z' })
  const again = buildTodayCockpit(db, { now: '2026-06-29T00:00:00Z' })

  assert.equal(snapshot(db), before)
  assert.deepEqual(Object.keys(cockpit), ['summary', 'cards', 'followups', 'salesRisks', 'allocationRisks', 'inventoryRisks', 'recentDocuments', 'recentMovements', 'recommendedActions', 'evidence'])
  assert.deepEqual(cockpit, again)
  assert.deepEqual(cockpit.cards.map((item) => item.id), [
    'customer-delivery-risk',
    'inventory-allocation-risk',
    'available-to-promise-risk',
    'demand-supply-gap',
    'open-prs',
    'active-rfqs',
    'open-pos',
    'pending-receiving',
    'match-exceptions',
    'inventory-risk',
    'urgent-followups',
    'total-open-amount',
  ])
  assert.deepEqual(cockpit.cards.slice(3).map((item) => item.title), [
    '供需缺口',
    '待处理采购申请',
    '进行中询价',
    '未关闭采购订单',
    '待收货复核',
    '三单匹配异常',
    '库存风险',
    '紧急跟进事项',
    '未结业务金额',
  ])
  assert.equal(cockpit.cards.find((item) => item.id === 'customer-delivery-risk')?.module, 'sales')
  assert.equal(cockpit.cards.find((item) => item.id === 'total-open-amount')?.valueKind, 'currency')
  assert.equal(/Open PRs|Active RFQs|Open POs|Pending Receiving|Match Exceptions|Inventory Risks|Urgent Followups|Total Open Amount/.test(JSON.stringify(cockpit.cards)), false)
})

test('today cockpit open-amount currency is derived from documents and stays unknown without one', () => {
  const cnyCard = buildTodayCockpit(clone(fixture), { now: '2026-06-29T00:00:00Z' }).cards.find((item) => item.id === 'total-open-amount')
  assert.equal(cnyCard.currency, 'CNY')
  assert.equal(cnyCard.currencyAggregationStatus, 'single_currency')

  const unknown = clone(fixture)
  for (const rows of Object.values(unknown)) if (Array.isArray(rows)) for (const row of rows) delete row.currency
  const cockpit = buildTodayCockpit(unknown, { now: '2026-06-29T00:00:00Z' })
  const card = cockpit.cards.find((item) => item.id === 'total-open-amount')
  assert.equal(card.currency, null)
  assert.equal(card.currencyAggregationStatus, 'no_currency_data')
  assert.equal(JSON.stringify(cockpit).includes('CNY'), false)
})

test('today cockpit followups come from procurement read model', () => {
  const cockpit = buildTodayCockpit(clone(fixture), { now: '2026-06-29T00:00:00Z' })
  const followups = buildProcurementFollowups(clone(fixture), { now: '2026-06-29T00:00:00Z' })
  assert.deepEqual(new Set(cockpit.followups.map((item) => item.id)), new Set(followups.map((item) => item.id)))
  assert.equal(cockpit.followups.some((item) => item.type === 'invoice_variance'), true)
})

test('today cockpit handles missing inventory arrays safely', () => {
  const cockpit = buildTodayCockpit({ purchaseRequests: [], rfqs: [], purchaseOrders: [], receivingDocs: [], supplierInvoices: [] }, { now: '2026-06-29T00:00:00Z' })
  assert.equal(cockpit.summary.lowStockCount, 0)
  assert.deepEqual(cockpit.inventoryRisks, [])
  assert.deepEqual(cockpit.recentMovements, [])
  assert.equal(cockpit.cards.length, 12)
})

test('today cockpit recent documents include canonical procurement document types', () => {
  const cockpit = buildTodayCockpit(clone(fixture), { now: '2026-06-29T00:00:00Z' })
  assert.deepEqual(new Set(cockpit.recentDocuments.map((item) => item.type)), new Set(['pr', 'rfq', 'po', 'grn', 'invoice', 'threeWayMatch']))
  assert.equal(cockpit.recentDocuments.every((item) => item.route.startsWith('/api/procurement/documents/')), true)
})

test('today cockpit recommendations are deterministic and read-only', () => {
  const db = clone(fixture)
  const before = snapshot(db)
  const first = buildTodayCockpit(db, { now: '2026-06-29T00:00:00Z' }).recommendedActions
  const second = buildTodayCockpit(db, { now: '2026-06-29T00:00:00Z' }).recommendedActions
  assert.equal(snapshot(db), before)
  assert.deepEqual(first, second)
  assert.equal(first.every((item) => item.id && item.title && item.nextAction && item.route !== undefined), true)
})

test('today cockpit route returns 200 without writing database', async () => {
  const route = createRouteContext('/api/today-cockpit')
  const handled = await handleTodayCockpitRoute(route.ctx)

  assert.equal(handled, true)
  assert.equal(route.response.status, 200)
  assert.equal(route.wrote, false)
  assert.equal(route.response.payload.summary.openPoCount, 1)
})

test('today cockpit payload does not expose stack traces or secrets', () => {
  const payload = JSON.stringify(buildTodayCockpit(clone(fixture), { now: '2026-06-29T00:00:00Z' }))
  assert.equal(/stack|trace|token|secret|api[_-]?key/i.test(payload), false)
})
