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
