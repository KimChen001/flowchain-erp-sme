import test from 'node:test'
import assert from 'node:assert/strict'
import { safeParsePartProps } from '../../shared/assistant-protocol.mjs'
import { decisionItemsResult } from './ai-assistant-v2-decision-tools.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS } from './ai-assistant-v2-ui-tools.mjs'

const row = (kind, recordId, fields = {}) => ({ id: `${kind}:${recordId}`, kind, entityType: fields.entityType || 'item', recordId, label: fields.label || recordId, name: fields.name || null, date: fields.date || '2026-11-12', dateKind: fields.dateKind || 'due', overdueDays: fields.overdueDays || 0, detail: {} })

const decisions = {
  available: true,
  canDecide: true,
  supplierEmail: { enabled: true, canSend: true, outbox: true },
  waiting: [
    {
      key: 'purchase_order_overdue:PO-1', returned: true,
      row: row('purchase_order_overdue', 'PO-1', { entityType: 'purchase_order', label: 'PO-202610-0021', name: 'Acme Home Goods', date: '2026-11-06', overdueDays: 6 }),
      draft: { type: 'supplier_follow_up', orderNumber: 'PO-202610-0021', dueDate: '2026-11-06', overdueDays: 6, supplier: { id: 'SUP-1', name: 'Acme Home Goods', contactName: 'Acme order desk', email: 'orders@acme-homegoods.example' }, lines: [{ sku: '85123A', remaining: 120, unit: 'pcs', promisedDate: '2026-11-06' }], moreLines: 0 },
    },
    {
      key: 'reorder_now:ITEM-1',
      row: row('reorder_now', 'ITEM-1', { label: '22065', name: 'Christmas Pudding Trinket Pot', dateKind: 'order_by' }),
      draft: { type: 'purchase_request', itemId: 'ITEM-1', sku: '22065', unit: 'pcs', quantity: 80, raisedToMinimum: true, shortfall: 47, position: 191, reorderPoint: 238, orderByDate: '2026-11-12', supplier: { id: 'SUP-2', name: 'Supplier of 22xxx codes', minimumOrderQuantity: 80, leadTimeDays: 14 }, openRequests: [] },
    },
  ],
  setAside: [
    { key: 'reorder_now:ITEM-2', row: row('reorder_now', 'ITEM-2', { label: '22423' }), decision: 'not_needed', reasonCode: 'seasonal', note: null, returnOn: null, decidedOn: '2026-11-11', decidedBy: { name: 'Sam' }, documentType: null, documentIds: [], documentNumber: null },
  ],
}

test('the assistant reads the same decisions as Today, without any email address or contact name', () => {
  const result = decisionItemsResult(decisions, { include: 'all' })
  assert.equal(result.waitingTotal, 2)
  assert.equal(result.setAsideTotal, 1)
  assert.equal(result.canDecide, true)
  assert.equal(result.supplierEmailOn, true)
  const followUp = result.waiting[0]
  assert.equal(followUp.key, 'purchase_order_overdue:PO-1')
  assert.equal(followUp.returned, true)
  assert.deepEqual(followUp.prepared, {
    type: 'supplier_follow_up', orderNumber: 'PO-202610-0021', supplier: 'Acme Home Goods', dueDate: '2026-11-06', overdueDays: 6, linesStillToReceive: 1,
    lines: [{ sku: '85123A', remaining: 120, unit: 'pcs', promisedDate: '2026-11-06' }], emailOnRecord: true,
  })
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('@'), 'no email address reaches the model')
  assert.ok(!serialized.includes('order desk'), 'no contact name reaches the model')
  assert.deepEqual(result.waiting[1].prepared, {
    type: 'purchase_request', quantity: 80, unit: 'pcs', supplier: 'Supplier of 22xxx codes', raisedToMinimum: true, minimumOrderQuantity: 80, leadTimeDays: 14,
    shortfall: 47, position: 191, reorderPoint: 238, orderByDate: '2026-11-12', openRequests: [],
  })
  assert.deepEqual(result.setAside[0], {
    key: 'reorder_now:ITEM-2', kind: 'reorder_now', label: '22423', name: null, date: '2026-11-12', dateKind: 'due', overdueDays: 0,
    ref: result.setAside[0].ref, decision: 'not_needed', reasonCode: 'seasonal', note: null, returnOn: null, decidedOn: '2026-11-11', decidedBy: 'Sam', documentNumber: null,
  })
})

test('a reorder says when an order placed today would arrive, by the recorded lead time', () => {
  const prepared = decisionItemsResult(decisions, {}, { today: '2026-11-12' }).waiting[1].prepared
  assert.equal(prepared.arrivesIfOrderedToday, '2026-11-26')
  assert.equal(decisionItemsResult(decisions).waiting[1].prepared.arrivesIfOrderedToday, undefined, 'no day without today')
})

test('waiting by default, and a limit', () => {
  const waitingOnly = decisionItemsResult(decisions)
  assert.equal(waitingOnly.setAside, undefined)
  assert.equal(waitingOnly.waiting.length, 2)
  assert.equal(decisionItemsResult(decisions, { limit: 1 }).waiting.length, 1)
  assert.equal(decisionItemsResult(decisions, { include: 'set_aside' }).waiting, undefined)
})

const showDecisions = AI_ASSISTANT_V2_UI_TOOLS.find((tool) => tool.name === 'show_decisions')
const ctxWith = (output, tool = 'decision_items') => ({ results: new Map([['toolu_1', { tool, output }]]) })

test('show_decisions shows the waiting items of a decision_items result as cards', () => {
  const output = decisionItemsResult(decisions)
  const all = showDecisions.build({ source: 'toolu_1' }, ctxWith(output))
  assert.equal(all.component, 'decisions')
  assert.deepEqual(all.props.keys, ['purchase_order_overdue:PO-1', 'reorder_now:ITEM-1'])
  assert.equal(all.props.more, 0)
  const one = showDecisions.build({ source: 'toolu_1', keys: ['reorder_now:ITEM-1'] }, ctxWith(output))
  assert.deepEqual(one.props.keys, ['reorder_now:ITEM-1'])
  assert.equal(one.props.more, 1)
  assert.equal(showDecisions.build({ source: 'toolu_1', keys: ['reorder_now:ITEM-9'] }, ctxWith(output)).error.code, 'unknown_key')
  assert.equal(showDecisions.build({ source: 'toolu_1' }, ctxWith(output, 'attention_list')).error.code, 'wrong_source')
  assert.equal(showDecisions.build({ source: 'toolu_1' }, ctxWith({ ...output, waiting: [] })).error.code, 'nothing_waiting')
})

test('the decisions part carries keys of the drafted kinds only', () => {
  assert.equal(safeParsePartProps('decisions', { keys: ['purchase_order_overdue:UCI-PO-00331'], more: 2 }).success, true)
  assert.equal(safeParsePartProps('decisions', { keys: ['bill_exception:B-1'] }).success, false)
  assert.equal(safeParsePartProps('decisions', { keys: [] }).success, false)
  assert.equal(safeParsePartProps('decisions', { keys: Array.from({ length: 6 }, (_, i) => `reorder_now:I-${i}`) }).success, false)
})
