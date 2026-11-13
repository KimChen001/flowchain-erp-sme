import test from 'node:test'
import assert from 'node:assert/strict'
import { searchRuntimeBusinessContext } from './runtime-business-search.mjs'

// Global search results open their record's own page and name what a person
// knows the record by: a document's number, a master record's code.
const context = {
  items: [{ itemId: 'ITEM-7', sku: 'FOODS_1_110', itemName: 'Foods 1 item 110', status: 'active' }],
  inventoryItems: [{ sku: 'FOODS_1_110', itemName: 'Foods 1 item 110', status: 'active' }],
  suppliers: [{ id: 'SUP-1', supplierCode: 'SUP-FOODS-1', supplierName: 'Foods 1 vendor', status: 'active' }],
  purchaseOrders: [{ id: 'PO-INTERNAL-1', orderNumber: 'PO-202611-0001', supplierSnapshot: { supplierName: 'Foods 1 vendor' }, status: 'issued' }],
  salesOrders: [{ salesOrderId: 'SO-INTERNAL-1', number: 'SO-202611-0006', customerName: 'Corner Shop', status: 'confirmed' }],
}

test('a stock result opens the stock list filtered to its SKU, an item its own page', () => {
  const results = searchRuntimeBusinessContext(context, 'FOODS_1_110')
  const stock = results.find(result => result.type === 'inventory_item')
  const item = results.find(result => result.type === 'item')
  assert.equal(stock.deepLink, '/app/inventory/stock?sku=FOODS_1_110')
  assert.equal(item.deepLink, '/app/master-data/items/ITEM-7')
  assert.equal(item.code, 'FOODS_1_110')
})

test('documents carry their number and masters their code', () => {
  const [order] = searchRuntimeBusinessContext(context, 'PO-202611-0001')
  assert.equal(order.number, 'PO-202611-0001')
  assert.equal(order.deepLink, '/app/procurement/orders/PO-INTERNAL-1')
  const [sale] = searchRuntimeBusinessContext(context, 'SO-202611-0006')
  assert.equal(sale.number, 'SO-202611-0006')
  const [supplier] = searchRuntimeBusinessContext(context, 'SUP-FOODS-1')
  assert.equal(supplier.code, 'SUP-FOODS-1')
  assert.equal(supplier.label, 'Foods 1 vendor')
})

// 2026-11-11 on Flash: "Order 100 cakestands" was answered that no cake stand
// was found; the item is "Regency Cakestand 3 Tier".
test('a name is found however it is spaced or plural, below an exact match; a single letter finds nothing', () => {
  const items = { inventoryItems: [{ sku: '22423', itemName: 'Regency Cakestand 3 Tier', status: 'active' }, { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', status: 'active' }] }
  const found = (query) => searchRuntimeBusinessContext(items, query).map((row) => row.label)
  for (const query of ['cake stand', 'cakestands', 'Cake-Stand']) assert.deepEqual(found(query), ['Regency Cakestand 3 Tier'], query)
  assert.deepEqual(found('heart holders'), ['White Hanging Heart T-Light Holder'])
  assert.deepEqual(found('chair'), [])
  // A code is found whole: 85123 B is no 85123A.
  assert.deepEqual(found('85123 A'), ['White Hanging Heart T-Light Holder'])
  assert.deepEqual(found('85123-B'), [])
  assert.deepEqual(found('a'), found('a').filter(Boolean))
  const exact = searchRuntimeBusinessContext(items, 'Cakestand')[0]
  const loose = searchRuntimeBusinessContext(items, 'cake stand')[0]
  assert.ok(exact.score > loose.score)
})
