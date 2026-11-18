import test from 'node:test'
import assert from 'node:assert/strict'
import { withItemStockThresholds } from './inventory-authoritative-read-service.mjs'

// Walkthrough 2026-10-07: items imported with a safety stock and a reorder
// point showed 0 / 0 on the stock pages, and Inventory warnings said "No
// inventory alerts" while the reorder list said "Order now".
// Design audit L3-21, L12-07: the stock record's own pair came back when the
// item had none, a reorder point set to 0 on purpose included.
test("the stock pages take the item's safety stock and reorder point, and only the item's", () => {
  const rows = [
    { id: 'B-1', itemId: 'ITEM-150', sku: 'VALVE-150', safetyStock: null, reorderPoint: null },
    { id: 'B-2', itemId: null, sku: 'FIT-300', safetyStock: '0', reorderPoint: '0' },
    { id: 'B-3', itemId: 'ITEM-OLD', sku: 'OLD-1', safetyStock: '4', reorderPoint: '9' },
    { id: 'B-4', itemId: 'ITEM-NONE', sku: 'NONE-1', safetyStock: null, reorderPoint: null },
  ]
  const items = [
    { id: 'ITEM-150', sku: 'VALVE-150', safetyStock: '10', reorderPoint: '25' },
    { id: 'ITEM-300', sku: 'FIT-300', safetyStock: null, reorderPoint: '200' },
    // An item form saves 0 for an empty field: that is not a threshold.
    { id: 'ITEM-OLD', sku: 'OLD-1', safetyStock: '0', reorderPoint: '0' },
  ]
  const result = withItemStockThresholds(rows, items)
  assert.deepEqual(result.map((row) => [row.sku, row.safetyStock, row.reorderPoint]), [
    ['VALVE-150', '10', '25'],
    // Matched by SKU when the record has no item id.
    ['FIT-300', null, '200'],
    // The record's old pair is not read: the item records none.
    ['OLD-1', null, null],
    ['NONE-1', null, null],
  ])
  assert.deepEqual(result.map((row) => row.id), ['B-1', 'B-2', 'B-3', 'B-4'])
})
