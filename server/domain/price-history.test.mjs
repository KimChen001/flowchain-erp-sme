import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareQuote,
  decimalUnits,
  maskPriceHistory,
  parsePriceHistoryKey,
  priceHistoryForKey,
  weightedAverage,
} from '../../shared/price-history.mjs'
import { createPriceHistoryReadService, parsePriceHistoryKeys } from './price-history-read-service.mjs'
import { instantCalendarDay } from './tenant-calendar-day.mjs'

// Purchase order lines as the price history query returns them.
let sequence = 0
const line = (overrides = {}) => {
  sequence += 1
  return {
    lineId: `L${String(sequence).padStart(3, '0')}`,
    purchaseOrderId: `PO-${String(sequence).padStart(4, '0')}`,
    orderNumber: null,
    supplierId: 'SUP-ACME',
    supplierName: 'Acme',
    itemId: 'ITEM-1',
    unit: 'pcs',
    currency: 'USD',
    unitPrice: '4.2000',
    orderedQuantity: '10.0000',
    issuedAt: '2026-09-14T15:00:00.000Z',
    createdAt: '2026-09-10T15:00:00.000Z',
    ...overrides,
  }
}
const newYork = (instant) => instantCalendarDay(instant, 'America/New_York')
const key = { itemId: 'ITEM-1', unit: 'pcs', currency: 'USD' }

test('the latest line in the same item, unit and currency comes first, with up to 2 earlier ones', () => {
  const lines = [
    line({ purchaseOrderId: 'PO-0031', unitPrice: '4.2', issuedAt: '2026-09-14T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-0020', unitPrice: '4.0', issuedAt: '2026-08-01T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-0025', unitPrice: '4.1', issuedAt: '2026-08-20T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-0010', unitPrice: '3.9', issuedAt: '2026-07-01T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-0040', itemId: 'ITEM-2', unitPrice: '9.9', issuedAt: '2026-10-01T15:00:00Z' }),
  ]
  const history = priceHistoryForKey(lines, key, { dayOf: newYork })
  assert.equal(history.status, 'found')
  assert.deepEqual([history.latest.purchaseOrderId, history.latest.unitPrice, history.latest.date, history.latest.dateSource, history.latest.supplierName], ['PO-0031', '4.2000', '2026-09-14', 'issue_date', 'Acme'])
  assert.deepEqual(history.earlier.map((fact) => [fact.purchaseOrderId, fact.unitPrice]), [['PO-0025', '4.1000'], ['PO-0020', '4.0000']])
  assert.equal(history.latest.orderNumber, 'PO-0031', 'the PO id stands in for a missing order number')
})

test('another currency or unit is named and never compared; unit case and spaces do not matter', () => {
  const lines = [
    line({ purchaseOrderId: 'PO-1', unit: ' PCS ', unitPrice: '4.00', issuedAt: '2026-09-01T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-2', currency: 'EUR', unitPrice: '3.00', issuedAt: '2026-09-20T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-3', unit: 'CASE', unitPrice: '40.00', issuedAt: '2026-09-21T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-4', unit: null, unitPrice: '1.00', issuedAt: '2026-09-22T15:00:00Z' }),
  ]
  const history = priceHistoryForKey(lines, key, { dayOf: newYork })
  assert.equal(history.latest.purchaseOrderId, 'PO-1')
  assert.deepEqual(history.earlier, [])
  assert.deepEqual(history.otherCurrencies, ['EUR'])
  assert.deepEqual(history.otherUnits, ['CASE'])
  assert.equal(history.unitNotRecordedCount, 1)

  const onlyElsewhere = priceHistoryForKey(lines.slice(1), key, { dayOf: newYork })
  assert.equal(onlyElsewhere.status, 'none')
  assert.equal(onlyElsewhere.latest, null)
  assert.deepEqual(compareQuote({ unitPrice: '4.5', history: onlyElsewhere }), { status: 'not_comparable', reason: 'currency', values: ['EUR'] })
  const onlyCase = priceHistoryForKey(lines.slice(2, 3), key)
  assert.deepEqual(compareQuote({ unitPrice: '4.5', history: onlyCase }), { status: 'not_comparable', reason: 'unit', values: ['CASE'] })
  const onlyUnrecorded = priceHistoryForKey(lines.slice(3), key)
  assert.deepEqual(compareQuote({ unitPrice: '4.5', history: onlyUnrecorded }), { status: 'not_comparable', reason: 'unit_not_recorded' })
  assert.deepEqual(compareQuote({ unitPrice: '4.5', history: priceHistoryForKey([], key) }), { status: 'no_earlier_po' })
})

test('without a unit in the key the item unit is used; without either nothing is compared', () => {
  const lines = [line({ unit: 'pcs' }), line({ unit: 'box', unitPrice: '50' })]
  const fromItem = priceHistoryForKey(lines, { itemId: 'ITEM-1', currency: 'usd' }, { itemUnit: 'PCS' })
  assert.deepEqual([fromItem.status, fromItem.unit, fromItem.unitSource, fromItem.currency], ['found', 'PCS', 'item', 'USD'])
  assert.deepEqual(fromItem.otherUnits, ['box'])
  const none = priceHistoryForKey(lines, { itemId: 'ITEM-1', currency: 'USD' })
  assert.deepEqual([none.status, none.unitSource, none.latest], ['unit_not_recorded', 'not_recorded', null])
  assert.deepEqual(none.otherUnits, ['box', 'pcs'])
  assert.deepEqual(compareQuote({ unitPrice: '4', history: none }), { status: 'not_comparable', reason: 'unit_not_recorded' })
})

test('lines are dated by issue date, else by order date with its label, in the workspace timezone', () => {
  const lines = [
    // Issued at 01:30 UTC on Sep 15 is Sep 14 in New York.
    line({ purchaseOrderId: 'PO-A', issuedAt: '2026-09-15T01:30:00Z', createdAt: '2026-09-01T12:00:00Z' }),
    line({ purchaseOrderId: 'PO-B', issuedAt: null, createdAt: '2026-09-16T12:00:00Z' }),
    line({ purchaseOrderId: 'PO-C', issuedAt: null, createdAt: null }),
  ]
  const history = priceHistoryForKey(lines, key, { dayOf: newYork })
  assert.deepEqual([history.latest.purchaseOrderId, history.latest.date, history.latest.dateSource], ['PO-B', '2026-09-16', 'order_date'])
  assert.deepEqual(history.earlier.map((fact) => [fact.purchaseOrderId, fact.date, fact.dateSource]), [['PO-A', '2026-09-14', 'issue_date'], ['PO-C', null, 'order_date']])
})

test('ties on the date are broken by PO id, then line id; every line is its own fact', () => {
  const at = '2026-09-14T15:00:00Z'
  const lines = [
    line({ purchaseOrderId: 'PO-B', lineId: 'L1', issuedAt: at, unitPrice: '1' }),
    line({ purchaseOrderId: 'PO-A', lineId: 'L2', issuedAt: at, unitPrice: '2' }),
    line({ purchaseOrderId: 'PO-A', lineId: 'L1', issuedAt: at, unitPrice: '3' }),
  ]
  const history = priceHistoryForKey(lines, key)
  assert.deepEqual([history.latest, ...history.earlier].map((fact) => `${fact.purchaseOrderId}/${fact.lineId}`), ['PO-A/L1', 'PO-A/L2', 'PO-B/L1'])
})

test('lines without an item or a price are left out', () => {
  const lines = [line({ itemId: null }), line({ unitPrice: null, issuedAt: '2026-10-01T00:00:00Z' }), line({ purchaseOrderId: 'PO-KEEP' })]
  const history = priceHistoryForKey(lines, key)
  assert.equal(history.latest.purchaseOrderId, 'PO-KEEP')
  assert.deepEqual(history.earlier, [])
  assert.equal(priceHistoryForKey(lines, { itemId: '', unit: 'pcs', currency: 'USD' }).latest, null)
})

test('the average weights the last 3 lines by quantity, skips zero quantities and needs 2 lines', () => {
  const facts = (rows) => rows.map(([unitPrice, orderedQuantity]) => ({ unitPrice, orderedQuantity }))
  // (4.20 x 10 + 4.50 x 30 + 4.00 x 10) / 50 = 4.34
  assert.deepEqual(weightedAverage(facts([['4.20', '10'], ['4.50', '30'], ['4.00', '10'], ['99', '1000']])), { unitPrice: '4.3400', n: 3 })
  assert.deepEqual(weightedAverage(facts([['4.20', '10'], ['4.50', '30']])), { unitPrice: '4.4250', n: 2 })
  assert.deepEqual(weightedAverage(facts([['4.20', '10'], ['4.50', '0'], ['4.00', '10']])), { unitPrice: '4.1000', n: 2 })
  assert.equal(weightedAverage(facts([['4.20', '10'], ['4.50', null], ['4.00', '0']])), null)
  assert.equal(weightedAverage(facts([['4.20', '10']])), null)
  // 1 x 1 + 2 x 2 = 5 / 3 = 1.66666 -> 1.6667
  assert.deepEqual(weightedAverage(facts([['1', '1'], ['2', '2']])), { unitPrice: '1.6667', n: 2 })
  assert.equal(decimalUnits('0.1') + decimalUnits('0.2'), decimalUnits('0.3'))
})

test('the average is never taken across currencies or units', () => {
  const lines = [
    line({ unitPrice: '4', orderedQuantity: '10', issuedAt: '2026-09-03T15:00:00Z' }),
    line({ unitPrice: '100', currency: 'EUR', orderedQuantity: '10', issuedAt: '2026-09-02T15:00:00Z' }),
    line({ unitPrice: '50', unit: 'case', orderedQuantity: '10', issuedAt: '2026-09-02T15:00:00Z' }),
    line({ unitPrice: '5', orderedQuantity: '30', issuedAt: '2026-09-01T15:00:00Z' }),
  ]
  assert.deepEqual(priceHistoryForKey(lines, key).average, { unitPrice: '4.7500', n: 2 })
  assert.equal(priceHistoryForKey(lines, { ...key, currency: 'EUR' }).average, null)
})

test('a quote is compared with the last PO price as a signed percentage with one decimal', () => {
  const history = priceHistoryForKey([
    line({ purchaseOrderId: 'PO-0031', unitPrice: '4.20', orderedQuantity: '10', issuedAt: '2026-09-14T15:00:00Z' }),
    line({ purchaseOrderId: 'PO-0025', unitPrice: '4.40', orderedQuantity: '10', issuedAt: '2026-08-14T15:00:00Z' }),
  ], key)
  const up = compareQuote({ unitPrice: '4.50', history })
  assert.deepEqual([up.status, up.percent, up.lastPo.purchaseOrderId, up.average.unitPrice, up.average.n], ['compared', '+7.1', 'PO-0031', '4.3000', 2])
  assert.equal(compareQuote({ unitPrice: '4.00', history }).percent, '-4.8')
  assert.equal(compareQuote({ unitPrice: '4.2', history }).percent, '0.0')
  // 0.05% rounds away from zero to 0.1.
  assert.equal(compareQuote({ unitPrice: '4.2021', history }).percent, '+0.1')
  const zero = priceHistoryForKey([line({ unitPrice: '0' })], key)
  assert.equal(compareQuote({ unitPrice: '1', history: zero }).status, 'zero_base')
})

test('masking hides every price, the average and the percentage, and keeps the facts around them', () => {
  const history = priceHistoryForKey([line({ purchaseOrderId: 'PO-1' }), line({ purchaseOrderId: 'PO-2', issuedAt: '2026-08-01T00:00:00Z' })], key, { dayOf: newYork })
  const masked = maskPriceHistory(history)
  assert.equal(masked.latest.unitPrice, null)
  assert.deepEqual(masked.earlier.map((fact) => fact.unitPrice), [null])
  assert.equal(masked.average.unitPrice, null)
  assert.deepEqual(masked.restrictedFields, ['unitPrice'])
  assert.deepEqual([masked.latest.purchaseOrderId, masked.latest.date, masked.latest.supplierName], ['PO-1', '2026-09-14', 'Acme'])
  const compared = compareQuote({ unitPrice: '5', history: masked })
  assert.equal(compared.status, 'hidden')
  assert.equal(compared.percent, undefined)
})

test('keys are itemId|unit|currency; at most 50 and each needs an item and a currency', () => {
  assert.deepEqual(parsePriceHistoryKey('ITEM-1| pcs |usd'), { itemId: 'ITEM-1', unit: 'pcs', currency: 'USD' })
  assert.deepEqual(parsePriceHistoryKeys(['ITEM-1||USD']), [{ itemId: 'ITEM-1', unit: '', currency: 'USD' }])
  assert.throws(() => parsePriceHistoryKeys([]), (error) => error.code === 'PRICE_HISTORY_KEY_REQUIRED' && error.status === 422)
  assert.throws(() => parsePriceHistoryKeys(['|pcs|USD']), (error) => error.code === 'PRICE_HISTORY_KEY_INVALID')
  assert.throws(() => parsePriceHistoryKeys(['ITEM-1|pcs|']), (error) => error.code === 'PRICE_HISTORY_KEY_INVALID')
  assert.throws(() => parsePriceHistoryKeys(Array.from({ length: 51 }, (_, index) => `ITEM-${index}|pcs|USD`)), (error) => error.code === 'PRICE_HISTORY_TOO_MANY_KEYS')
})

// The read service against a recording database: one query for every key,
// scoped to the reader's workspace, and prices only with procurement.prices.read.
function fakeDatabase(rows) {
  const calls = []
  return {
    calls,
    prisma: {
      $queryRawUnsafe: async (sql, ...params) => { calls.push({ sql, params }); return rows },
      item: { findMany: async (args) => { calls.push({ items: args }); return [{ id: 'ITEM-2', unit: 'kg' }] } },
      tenant: { findUnique: async () => ({ timezone: 'America/New_York' }) },
    },
  }
}
const actorWith = (...permissionCodes) => async () => ({ tenantId: 'tenant-a', authenticated: true, complete: true, user: { id: 'u1' }, permissionCodes: new Set(permissionCodes) })

test('the read service asks once for every key, in the reader\'s workspace only', async () => {
  const database = fakeDatabase([line({ purchaseOrderId: 'PO-1' }), line({ purchaseOrderId: 'PO-2', itemId: 'ITEM-2', unit: 'KG', currency: 'USD' })])
  const service = createPriceHistoryReadService({ prisma: database.prisma, resolveActor: actorWith('procurement.purchase_order.read', 'procurement.prices.read') })
  const result = await service.read(['ITEM-1|pcs|USD', 'ITEM-2||USD', 'ITEM-1|pcs|USD'], { identity: { authenticated: true, tenantId: 'spoofed' } })
  const queries = database.calls.filter((call) => call.sql)
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].params.slice(0, 2), ['tenant-a', ['ITEM-1', 'ITEM-2']])
  assert.match(queries[0].sql, /po\."tenantId" = \$1/)
  assert.deepEqual(database.calls.find((call) => call.items).items.where, { tenantId: 'tenant-a', id: { in: ['ITEM-1', 'ITEM-2'] } })
  assert.deepEqual(result.histories.map((history) => [history.key, history.status, history.latest?.purchaseOrderId, history.latest?.unitPrice]), [
    ['ITEM-1|pcs|USD', 'found', 'PO-1', '4.2000'],
    ['ITEM-2||USD', 'found', 'PO-2', '4.2000'],
    ['ITEM-1|pcs|USD', 'found', 'PO-1', '4.2000'],
  ])
  assert.equal(result.restrictedFields, undefined)
  assert.equal(result.priceLabel, 'purchase_order_price')
})

test('a reader without price rights gets dates, PO numbers and suppliers, never prices', async () => {
  const database = fakeDatabase([line({ purchaseOrderId: 'PO-1' }), line({ purchaseOrderId: 'PO-2', issuedAt: '2026-08-01T00:00:00Z' })])
  const service = createPriceHistoryReadService({ prisma: database.prisma, resolveActor: actorWith('procurement.purchase_order.read') })
  const result = await service.read(['ITEM-1|pcs|USD'], { identity: { authenticated: true } })
  const [history] = result.histories
  assert.deepEqual(result.restrictedFields, ['unitPrice'])
  assert.deepEqual([history.latest.unitPrice, history.earlier[0].unitPrice, history.average.unitPrice], [null, null, null])
  assert.deepEqual([history.latest.purchaseOrderId, history.latest.supplierName, history.latest.date], ['PO-1', 'Acme', '2026-09-14'])
  assert.doesNotMatch(JSON.stringify(result), /4\.2/)
})

test('a reader without purchase order rights is refused before anything is read', async () => {
  const database = fakeDatabase([])
  const service = createPriceHistoryReadService({ prisma: database.prisma, resolveActor: actorWith('procurement.prices.read') })
  await assert.rejects(service.read(['ITEM-1|pcs|USD'], { identity: { authenticated: true } }), (error) => error.name === 'AuthorizationError' && error.status === 403)
  assert.deepEqual(database.calls, [])
})
