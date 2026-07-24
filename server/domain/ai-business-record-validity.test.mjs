import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyBusinessRecord,
  partitionBusinessRecords,
  resultStateForValidity,
} from './ai-business-record-validity.mjs'

test('empty objects and placeholder ids never become valid business counts', () => {
  const result = partitionBusinessRecords('purchase_order', [
    {},
    { tenantId: 't1', id: 'PO-0001', supplierId: 's1', status: 'open' },
    { tenantId: 't1', id: 'PO-1001', supplierId: 's1', status: 'open' },
  ])
  assert.equal(result.validRecords.length, 1)
  assert.equal(result.recordValiditySummary.invalidCount, 2)
  assert.equal(result.validRecords[0].id, 'PO-1001')
})

test('incomplete records are separate from invalid and valid records', () => {
  const result = partitionBusinessRecords('payable_obligation', [
    { tenantId: 't1', id: 'pay-1', supplierId: 's1', currency: 'CNY', outstandingAmount: '12.50', dueDate: '2026-07-24', status: 'approved' },
    { tenantId: 't1', id: 'pay-2', supplierId: 's1', currency: 'CNY', outstandingAmount: '3', status: 'approved' },
  ])
  assert.equal(result.recordValiditySummary.validCount, 1)
  assert.equal(result.recordValiditySummary.incompleteCount, 1)
  assert.deepEqual(result.incompleteRecords[0].validity.missingFields, ['dueDate'])
  assert.equal(resultStateForValidity(result.recordValiditySummary, 0), 'incomplete')
})

test('hidden and unavailable are not confirmed zero', () => {
  const hidden = partitionBusinessRecords('supplier_invoice', [{ id: 'invoice-1' }], { visible: false })
  const unavailable = partitionBusinessRecords('supplier_invoice', [], { available: false })
  assert.equal(resultStateForValidity(hidden.recordValiditySummary, 0), 'hidden')
  assert.equal(resultStateForValidity(unavailable.recordValiditySummary, 0), 'unavailable')
})

test('receiving fallback identifiers are invalid evidence', () => {
  assert.equal(classifyBusinessRecord('receiving_document', { tenantId: 't1', grn: 'GRN-0001', poId: 'PO-1', status: 'posted' }).state, 'invalid')
})
