import test from 'node:test'
import assert from 'node:assert/strict'
import { ITEM_SUPPLIER_LINK_PAGE, itemSupplierLinkOptions, itemSupplierLinkPage, joinItemSupplierLinks } from './item-supplier-links.mjs'

const link = (itemId, supplierId, extra = {}) => ({ relationshipId: `ISR-${itemId}-${supplierId}`, itemId, supplierId, supplierSku: '', active: true, approved: true, preferred: false, leadTimeDays: null, minimumOrderQuantity: null, referencePrice: null, currency: 'USD', version: 1, source: 'item_supplier_relationship', ...extra })
const items = [{ id: 'I-1', sku: 'VALVE-10', name: 'Brass valve', status: 'active' }, { id: 'I-2', sku: 'BOLT-04', name: 'Hex bolt', status: 'inactive' }]
const suppliers = [{ id: 'S-1', code: 'SUP-ACME', name: 'Acme Fittings', status: 'active' }, { id: 'S-2', code: 'SUP-BIRCH', name: 'Birch Metals', status: 'active' }]

test('each link carries its item and supplier, and keeps its ids when either left the master', () => {
  const [row, orphan] = joinItemSupplierLinks([link('I-1', 'S-2', { referencePrice: 4.25 }), link('I-9', 'S-9')], { items, suppliers })
  assert.deepEqual(row.item, { itemId: 'I-1', sku: 'VALVE-10', itemName: 'Brass valve', status: 'active' })
  assert.deepEqual(row.supplier, { supplierId: 'S-2', supplierCode: 'SUP-BIRCH', supplierName: 'Birch Metals', status: 'active' })
  assert.equal(row.referencePrice, 4.25)
  assert.deepEqual([orphan.item.sku, orphan.item.itemName, orphan.supplier.supplierCode, orphan.supplier.supplierName], ['I-9', '', 'S-9', 'S-9'])
})

test('links are searched over item, supplier and supplier SKU, ordered by SKU then supplier, and paged', () => {
  const rows = joinItemSupplierLinks([
    link('I-1', 'S-2'), link('I-1', 'S-1', { supplierSku: 'AC-7731' }), link('I-2', 'S-2'),
  ], { items, suppliers })
  assert.deepEqual(itemSupplierLinkPage(rows).rows.map((row) => `${row.item.sku}/${row.supplier.supplierCode}`), ['BOLT-04/SUP-BIRCH', 'VALVE-10/SUP-ACME', 'VALVE-10/SUP-BIRCH'])
  const search = (query) => itemSupplierLinkPage(rows, { query }).rows.map((row) => row.relationshipId)
  assert.deepEqual(search('brass'), ['ISR-I-1-S-1', 'ISR-I-1-S-2'])
  assert.deepEqual(search('sup-acme'), ['ISR-I-1-S-1'])
  assert.deepEqual(search('7731'), ['ISR-I-1-S-1'])
  assert.deepEqual(search('Birch'), ['ISR-I-2-S-2', 'ISR-I-1-S-2'])
  assert.deepEqual(search('nothing like it'), [])
  const page = itemSupplierLinkPage(rows, { limit: '2', offset: '1' })
  assert.deepEqual([page.total, page.limit, page.offset, page.rows.length], [3, 2, 1, 2])
  // A limit out of range is held to the page bounds; a bad one falls back.
  assert.equal(itemSupplierLinkPage(rows, { limit: 100000 }).limit, ITEM_SUPPLIER_LINK_PAGE.max)
  assert.equal(itemSupplierLinkPage(rows, { limit: 'all', offset: -3 }).limit, ITEM_SUPPLIER_LINK_PAGE.limit)
  assert.equal(itemSupplierLinkPage(rows, { offset: -3 }).offset, 0)
})

test('the filter options are the items and suppliers that have links', () => {
  const rows = joinItemSupplierLinks([link('I-1', 'S-2'), link('I-1', 'S-1'), link('I-2', 'S-2')], { items, suppliers })
  assert.deepEqual(itemSupplierLinkOptions(rows), {
    items: [{ id: 'I-2', sku: 'BOLT-04', itemName: 'Hex bolt' }, { id: 'I-1', sku: 'VALVE-10', itemName: 'Brass valve' }],
    suppliers: [{ id: 'S-1', supplierCode: 'SUP-ACME', supplierName: 'Acme Fittings' }, { id: 'S-2', supplierCode: 'SUP-BIRCH', supplierName: 'Birch Metals' }],
  })
})
