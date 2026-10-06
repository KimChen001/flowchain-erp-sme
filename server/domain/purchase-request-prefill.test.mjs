import test from 'node:test'
import assert from 'node:assert/strict'
import { addCalendarDays, planPurchaseRequestPrefill } from '../../shared/purchase-request-prefill.mjs'

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

test('an item with no approved supplier leaves the supplier and price empty', () => {
  const plan = planPurchaseRequestPrefill({ ...base, suppliers: [], query: { itemId: 'item-1', quantity: '5' } })
  assert.equal(plan.values.supplierId, '')
  assert.equal(plan.fields.supplierId, undefined)
  assert.equal(plan.values.estimatedUnitPrice, '')
  assert.equal(plan.values.needByDate, '2026-10-03')
})

test('calendar days cross month and year ends', () => {
  assert.equal(addCalendarDays('2026-12-28', 7), '2027-01-04')
  assert.equal(addCalendarDays('2028-02-27', 2), '2028-02-29')
})
