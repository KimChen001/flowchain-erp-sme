import test from 'node:test'
import assert from 'node:assert/strict'
import { addCalendarDays, orderSupplierChoices, planPurchaseRequestPrefill } from '../../shared/purchase-request-prefill.mjs'
import { mapItemSupplierRecord } from './master-data-commands.mjs'

const item = { itemId: 'item-1', defaultWarehouseId: 'wh-main' }
const preferred = { id: 'sup-pref', supplierCode: 'SUP-P', name: 'Preferred Supply', preferred: true, referencePrice: '4.25', currency: 'USD', leadTimeDays: 10, minimumOrderQuantity: null }
const other = { id: 'sup-other', supplierCode: 'SUP-O', name: 'Other Supply', preferred: false, referencePrice: null, currency: 'EUR', leadTimeDays: null, minimumOrderQuantity: 50 }
const base = { item, suppliers: [preferred, other], today: '2026-10-03', defaultDate: '2026-10-03' }

test('an assistant handoff fills the line from the record and master data, each field with its source', () => {
  const plan = planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', quantity: '38', reason: '12 available against a target of 50; nothing incoming covers it.', origin: 'ai_assistant' } })
  assert.equal(plan.origin, 'ai_assistant')
  assert.equal(plan.intent, null)
  assert.deepEqual(plan.values, {
    itemId: 'item-1', supplierId: 'sup-pref', quantity: '38', estimatedUnitPrice: '4.25', currency: 'USD',
    targetWarehouseId: 'wh-main', needByDate: '2026-10-13', internalLineComment: '12 available against a target of 50; nothing incoming covers it.',
  })
  assert.deepEqual(Object.fromEntries(Object.entries(plan.fields).map(([field, entry]) => [field, `${entry.source}:${entry.ref || ''}`])), {
    itemId: 'record:assistant:item',
    supplierId: 'default:item_supplier:preferred',
    quantity: 'record:assistant:gap',
    estimatedUnitPrice: 'default:item_supplier:reference_price',
    targetWarehouseId: 'default:item:default_warehouse',
    needByDate: 'default:item_supplier:lead_time',
    internalLineComment: 'template:assistant:reason',
  })
})

test('a named supplier wins, and the quantity rises to its minimum order quantity', () => {
  const plan = planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', quantity: '20', suppliers: 'SUP-O,sup-pref', origin: 'ai' } })
  assert.equal(plan.values.supplierId, 'sup-other')
  assert.deepEqual(plan.fields.supplierId, { source: 'record', ref: 'assistant:supplier', value: 'sup-other' })
  assert.equal(plan.values.quantity, '50')
  assert.deepEqual(plan.fields.quantity, { source: 'default', ref: 'item_supplier:moq', value: '50' })
  // No price and no lead time recorded for this source: those stay empty and unlabelled.
  assert.equal(plan.values.estimatedUnitPrice, '')
  assert.equal(plan.fields.estimatedUnitPrice, undefined)
  assert.equal(plan.values.needByDate, '2026-10-03')
  assert.equal(plan.fields.needByDate, undefined)
})

test('a date in the handoff is used as given; an invalid one falls back to the lead time', () => {
  assert.deepEqual(planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', due: '2026-11-02', origin: 'ai_assistant' } }).fields.needByDate, { source: 'record', ref: 'assistant:due', value: '2026-11-02' })
  assert.equal(planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', due: '2026-13-45' } }).values.needByDate, '2026-10-13')
})

test('without a quantity the line starts at 1, unlabelled, and an RFQ handoff says so', () => {
  const plan = planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', quantity: 'many', intent: 'rfq', origin: 'today_cockpit' } })
  assert.equal(plan.values.quantity, '1')
  assert.equal(plan.fields.quantity, undefined)
  assert.equal(plan.intent, 'rfq')
  // Values from outside the assistant carry no assistant reference.
  assert.deepEqual(plan.fields.itemId, { source: 'record', value: 'item-1' })
})

test('a reorder list handoff labels its shortfall, supplier and reason with the reorder list', () => {
  const plan = planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', quantity: '12.5', suppliers: 'sup-pref', reason: 'Order by 2026-10-05.', origin: 'reorder_list' } })
  assert.equal(plan.origin, 'reorder_list')
  assert.deepEqual(Object.fromEntries(Object.entries(plan.fields).map(([field, entry]) => [field, `${entry.source}:${entry.ref || ''}`])), {
    itemId: 'record:reorder_list:item',
    supplierId: 'record:reorder_list:supplier',
    quantity: 'record:reorder_list:gap',
    estimatedUnitPrice: 'default:item_supplier:reference_price',
    targetWarehouseId: 'default:item:default_warehouse',
    needByDate: 'default:item_supplier:lead_time',
    internalLineComment: 'template:reorder_list:reason',
  })
  assert.equal(plan.values.quantity, '12.5')
  // The shortfall still rises to the supplier's minimum order quantity.
  const raised = planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', quantity: '20', suppliers: 'sup-other', origin: 'reorder_list' } })
  assert.deepEqual(raised.fields.quantity, { source: 'default', ref: 'item_supplier:moq', value: '50' })
})

test('a reorder list row without a shortfall opens with the quantity empty and says to enter it', () => {
  const plan = planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', suppliers: 'sup-other', origin: 'reorder_list' } })
  assert.equal(plan.values.quantity, '')
  assert.deepEqual(plan.fields.quantity, { source: 'template', ref: 'reorder_list:enter_quantity', value: '' })
  // Elsewhere a handoff without a quantity still starts at 1, unlabelled.
  assert.equal(planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1' } }).values.quantity, '1')
})

test('a link with no lead time or minimum order quantity recorded fills neither, from the reorder list or the assistant', () => {
  // As the item supplier API returns a link saved with both fields blank.
  const link = mapItemSupplierRecord({ id: 'rel-1', payload: { itemId: 'item-1', supplierId: 'sup-blank', preferred: true, leadTimeDays: null, minimumOrderQuantity: null } })
  assert.equal(link.leadTimeDays, null)
  assert.equal(link.minimumOrderQuantity, null)
  // Older links without the keys read the same way; a recorded 0 stays 0.
  assert.equal(mapItemSupplierRecord({ payload: {} }).leadTimeDays, null)
  assert.equal(mapItemSupplierRecord({ payload: { leadTimeDays: 0, minimumOrderQuantity: 6 } }).leadTimeDays, 0)
  const suppliers = [{ ...link, id: 'sup-blank', name: 'Blank Supply' }]
  for (const origin of ['reorder_list', 'ai_assistant']) {
    const plan = planPurchaseRequestPrefill({ ...base, suppliers, query: { itemId: 'item-1', quantity: '0.5', origin } })
    assert.equal(plan.values.quantity, '0.5', origin)
    assert.equal(plan.fields.quantity.ref, `${origin === 'ai_assistant' ? 'assistant' : 'reorder_list'}:gap`)
    assert.equal(plan.fields.needByDate, undefined, origin)
    assert.equal(plan.values.needByDate, base.defaultDate)
  }
})

test('an item with no approved supplier leaves the supplier and price empty', () => {
  const plan = planPurchaseRequestPrefill({ ...base, suppliers: [], query: { itemId: 'item-1', quantity: '5' } })
  assert.equal(plan.values.supplierId, '')
  assert.equal(plan.fields.supplierId, undefined)
  assert.equal(plan.values.estimatedUnitPrice, '')
  assert.equal(plan.values.needByDate, '2026-10-03')
})

// Approved sources with none preferred, as the item supplier API returns them.
const sourceA = { id: 'sup-a', supplierCode: 'SUP-A', name: 'acme Supply', preferred: false, referencePrice: '3.10', currency: 'USD', leadTimeDays: 7, minimumOrderQuantity: 100 }
const sourceB = { id: 'sup-b', supplierCode: 'SUP-B', name: 'Bolt Parts', preferred: false, referencePrice: '2.90', currency: 'EUR', leadTimeDays: 3, minimumOrderQuantity: 40 }
const sourceC = { id: 'sup-c', supplierCode: 'SUP-C', name: 'Acme Supply', preferred: false, referencePrice: null, currency: 'USD', leadTimeDays: null, minimumOrderQuantity: null }
const sourceD = { id: 'sup-d', supplierCode: 'SUP-D', name: 'Delta Trading', preferred: false, referencePrice: '5.00', currency: 'USD', leadTimeDays: 2, minimumOrderQuantity: null }
const several = { ...base, suppliers: [sourceD, sourceB, sourceA, sourceC] }
const lastOrders = {
  'sup-b': { purchaseOrderId: 'PO-0007', orderNumber: 'PO-0007', day: '2026-08-02', dateSource: 'issue_date' },
  'sup-d': { purchaseOrderId: 'PO-0031', orderNumber: 'PO-0031', day: '2026-09-14', dateSource: 'order_date' },
}

test('the only approved source is prefilled and labelled as the only one', () => {
  const plan = planPurchaseRequestPrefill({ ...base, suppliers: [sourceB], query: { itemId: 'item-1', quantity: '10', origin: 'ai_assistant' } })
  assert.deepEqual(plan.fields.supplierId, { source: 'default', ref: 'item_supplier:only_approved', value: 'sup-b' })
  assert.equal(plan.values.supplierId, 'sup-b')
  // A supplier someone stands behind: its terms fill the line as before.
  assert.equal(plan.values.quantity, '40')
  assert.equal(plan.values.estimatedUnitPrice, '2.90')
  assert.equal(plan.values.currency, 'EUR')
  assert.equal(plan.values.needByDate, '2026-10-06')
  assert.deepEqual(plan.supplierChoices, [])
})

test('several approved sources and none preferred: the supplier stays empty and the sources are listed by last PO date', () => {
  const plan = planPurchaseRequestPrefill({ ...several, lastOrders, query: { itemId: 'item-1', quantity: '10', origin: 'ai_assistant' } })
  assert.equal(plan.values.supplierId, '')
  assert.deepEqual(plan.fields.supplierId, { source: 'template', ref: 'item_supplier:choose', value: '' })
  // Nothing of a supplier nobody chose: no price, currency, lead time or MOQ.
  assert.equal(plan.values.estimatedUnitPrice, '')
  assert.equal(plan.fields.estimatedUnitPrice, undefined)
  assert.equal(plan.values.currency, '')
  assert.equal(plan.values.quantity, '10')
  assert.deepEqual(plan.fields.quantity, { source: 'record', ref: 'assistant:gap', value: '10' })
  assert.equal(plan.values.needByDate, '2026-10-03')
  assert.equal(plan.fields.needByDate, undefined)
  // Most recent PO first, never-ordered last, ties A-Z (case-insensitive), then id.
  assert.deepEqual(plan.supplierChoices.map((row) => [row.id, row.lastOrder?.day ?? null]), [
    ['sup-d', '2026-09-14'], ['sup-b', '2026-08-02'], ['sup-a', null], ['sup-c', null],
  ])
  assert.deepEqual(plan.supplierChoices[0], { id: 'sup-d', name: 'Delta Trading', lastOrder: { purchaseOrderId: 'PO-0031', orderNumber: 'PO-0031', day: '2026-09-14', dateSource: 'order_date' } })
  assert.equal(plan.supplierChoices[2].lastOrder, null)
  // The asked-for date still wins; without a quantity the reorder list leaves it empty.
  assert.equal(planPurchaseRequestPrefill({ ...several, lastOrders, query: { itemId: 'item-1', due: '2026-11-02' } }).values.needByDate, '2026-11-02')
  assert.equal(planPurchaseRequestPrefill({ ...several, lastOrders, query: { itemId: 'item-1', origin: 'reorder_list' } }).values.quantity, '')
  assert.equal(planPurchaseRequestPrefill({ ...several, lastOrders, query: { itemId: 'item-1' } }).values.quantity, '1')
})

test('two suppliers last ordered the same day are listed A-Z, and a Map works like an object', () => {
  const sameDay = new Map([
    ['sup-b', { purchaseOrderId: 'PO-2', day: '2026-09-01', dateSource: 'issue_date' }],
    ['sup-a', { purchaseOrderId: 'PO-1', day: '2026-09-01', dateSource: 'issue_date' }],
  ])
  assert.deepEqual(orderSupplierChoices([sourceB, sourceD, sourceA], sameDay).map((row) => row.id), ['sup-a', 'sup-b', 'sup-d'])
  // The order number falls back to the PO id.
  assert.equal(orderSupplierChoices([sourceA], sameDay)[0].lastOrder.orderNumber, 'PO-1')
})

test('without PO dates the sources are listed A-Z and no date is claimed', () => {
  for (const unavailable of [null, undefined]) {
    const plan = planPurchaseRequestPrefill({ ...several, lastOrders: unavailable, query: { itemId: 'item-1' } })
    assert.deepEqual(plan.supplierChoices.map((row) => row.id), ['sup-a', 'sup-c', 'sup-b', 'sup-d'])
    assert.ok(plan.supplierChoices.every((row) => !('lastOrder' in row)))
  }
})

test('a named supplier wins among several; a named supplier that is not approved falls through', () => {
  const named = planPurchaseRequestPrefill({ ...several, lastOrders, query: { itemId: 'item-1', quantity: '10', suppliers: 'SUP-B', origin: 'reorder_list' } })
  assert.deepEqual(named.fields.supplierId, { source: 'record', ref: 'reorder_list:supplier', value: 'sup-b' })
  assert.equal(named.values.quantity, '40')
  assert.deepEqual(named.supplierChoices, [])
  const unknown = planPurchaseRequestPrefill({ ...several, lastOrders, query: { itemId: 'item-1', quantity: '10', suppliers: 'SUP-ZZ', origin: 'ai_assistant' } })
  assert.deepEqual(unknown.fields.supplierId, { source: 'template', ref: 'item_supplier:choose', value: '' })
  assert.equal(unknown.values.supplierId, '')
  // With a preferred supplier among the sources, an unapproved name falls to it.
  const toPreferred = planPurchaseRequestPrefill({ ...base, query: { itemId: 'item-1', suppliers: 'SUP-ZZ' } })
  assert.deepEqual(toPreferred.fields.supplierId, { source: 'default', ref: 'item_supplier:preferred', value: 'sup-pref' })
})

test('calendar days cross month and year ends', () => {
  assert.equal(addCalendarDays('2026-12-28', 7), '2027-01-04')
  assert.equal(addCalendarDays('2028-02-27', 2), '2028-02-29')
})
