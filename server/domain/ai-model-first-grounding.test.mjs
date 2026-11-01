import test from 'node:test'
import assert from 'node:assert/strict'
import { checkAiModelFirstGrounding } from './ai-model-first-grounding.mjs'

// The grounding check against fictional records, one case per kind of failure
// the model-on lane found (2026-10-29/30): a checker false positive it now
// accepts, and what it must keep refusing. No model is called.

const check = (answer, results = [], extra = {}) => checkAiModelFirstGrounding({ answer: { title: 'Answer', answer, records: [] }, results, today: '2026-10-30', ...extra })
const kinds = (outcome) => outcome.problems.map((row) => `${row.kind}:${row.value}`)

const policy = (excerpt) => ({ passages: [{ document: 'Example Policy', section: 'Follow-up and escalation', excerpt, ref: { type: 'document', id: 'DOC-9', label: 'Example Policy' } }] })
const orders = {
  rows: [
    { order: 'HV-PO-101', supplier: 'Harbor Valve Co', overdueDays: 8, remaining: 300, amount: 7320, currency: 'USD', ref: { type: 'purchase_order', id: 'HV-PO-101', label: 'HV-PO-101' } },
    { order: 'HV-PO-102', supplier: 'Harbor Valve Co', overdueDays: 4, remaining: 30, amount: 5000, currency: 'USD', ref: { type: 'purchase_order', id: 'HV-PO-102', label: 'HV-PO-102' } },
    { order: 'PR-PO-201', supplier: 'Pine Ridge Metals', overdueDays: 6, remaining: 50, amount: 5080, currency: 'USD', ref: { type: 'purchase_order', id: 'PR-PO-201', label: 'PR-PO-201' } },
    { order: 'PR-PO-202', supplier: 'Pine Ridge Metals', overdueDays: 2, remaining: 40, amount: 3920, currency: 'USD', ref: { type: 'purchase_order', id: 'PR-PO-202', label: 'PR-PO-202' } },
    { order: 'LK-PO-301', supplier: 'Lakeside Wire', overdueDays: 1, remaining: 900, amount: 1665, currency: 'USD', ref: { type: 'purchase_order', id: 'LK-PO-301', label: 'LK-PO-301' } },
  ],
  // All overdue orders, of every tier.
  total: 8,
  more: 3,
}

test('false positive fixed: a count a document passage writes as a word grounds the same count in figures', () => {
  const escalation = policy('Escalate when the supplier has not responded for two business days, or when a customer delivery within three business days is affected.')
  assert.deepEqual(kinds(check('政策规定，供应商两个工作日内未回复，或 3 个工作日内的客户交付受影响时，才需升级。', [escalation])), [])
  assert.deepEqual(kinds(check('Escalate after 2 business days without a reply.', [escalation])), [])
  // A Chinese document's counts too.
  assert.deepEqual(kinds(check('Follow up when a supplier has not confirmed within 3 business days.', [policy('供应商三个工作日内未确认交期时，采购员应跟进。')])), [])
})

test('still refused: a number no passage states, or one a passage only seems to state', () => {
  const escalation = policy('Escalate when a customer delivery within three business days is affected.')
  assert.deepEqual(kinds(check('Escalate within 4 business days.', [escalation])), ['number:4'])
  // "three-way match" is no count of three.
  assert.deepEqual(kinds(check('3 张发票有差异。', [policy('Use a three-way match before paying a supplier invoice.')])), ['number:3'])
  // "one" is not read: prose uses it for much else (a known limit, kept strict).
  assert.deepEqual(kinds(check('Reply within 1 business day.', [policy('Reply within one business day.')])), ['number:1'])
  // A word in a record's own fields is not a passage: it grounds nothing.
  assert.deepEqual(kinds(check('3 pallets are waiting.', [{ rows: [{ note: 'three pallets at the dock', ref: { type: 'receiving_doc', id: 'GRN-9', label: 'GRN-9' } }] }])), ['number:3'])
})

test('real gap, still refused: a count of rows the model picked out, which no tool totals', () => {
  // The Tier 1 overdue orders are 5 of the 8 overdue; no tool returns 5.
  const tier1 = '一级供应商共 5 笔逾期订单：HV-PO-101、HV-PO-102、PR-PO-201、PR-PO-202、LK-PO-301。'
  assert.deepEqual(kinds(check(tier1, [orders])), ['number:5'])
  // The same count through calculate is grounded.
  assert.deepEqual(kinds(check(tier1, [orders, { operation: 'sum', values: [1, 1, 1, 1, 1], result: 5 }])), [])
})

test('still refused: a figure carried over from an earlier turn without reading it again', () => {
  const conversation = 'HV-PO-101 为什么风险最高？ — HV-PO-101 逾期 15 天，7000 件未到货。'
  // No tool was called in this answer: the record may be named, its figures not stated.
  assert.deepEqual(kinds(check('因为 HV-PO-101 逾期 15 天，7000 件未到货。', [], { conversation })), ['number:15 天', 'number:7000'])
  assert.deepEqual(kinds(check('HV-PO-101 是逾期最久的订单。', [], { conversation })), [])
})

test('status words: a labelled state passes, and so does a state word about a named record in that state; otherwise flagged', () => {
  const receipt = (postingStatus) => ({ rows: [{ receipt: 'GRN-77', received: '2026-10-28', rejected: 500, postingStatus, purchaseOrder: 'HV-PO-101', ref: { type: 'receiving_doc', id: 'GRN-77', label: 'GRN-77' } }] })
  assert.deepEqual(kinds(check('GRN-77 拒收 500 pcs，过账状态：已过账。', [receipt('posted')])), [])
  // The owner's rule of 2026-11-01: the sentence names GRN-77, which is posted.
  assert.deepEqual(kinds(check('GRN-77（2026-10-28，已过账）拒收 500 pcs。', [receipt('posted')])), [])
  assert.deepEqual(kinds(check('GRN-77（HV-PO-101）拒收了 500 pcs，已过账。', [receipt('posted'), orders])), [])
  // Not posted, or not named in that sentence: an event, flagged.
  assert.deepEqual(kinds(check('GRN-77 拒收了 500 pcs，已过账。', [receipt('unposted')])), ['action_claim:已过账'])
  assert.deepEqual(kinds(check('GRN-77 拒收了 500 pcs。已过账。', [receipt('posted')])), ['action_claim:已过账'])
  const issued = { order: { orderNumber: 'HV-PO-101', status: 'issued', ref: { type: 'purchase_order', id: 'HV-PO-101', label: 'HV-PO-101' } } }
  const approved = { order: { orderNumber: 'HV-PO-102', status: 'approved', ref: { type: 'purchase_order', id: 'HV-PO-102', label: 'HV-PO-102' } } }
  assert.deepEqual(kinds(check('Yes, HV-PO-101 has been issued to Harbor Valve Co.', [issued])), [])
  assert.deepEqual(kinds(check('HV-PO-102 has been issued to Harbor Valve Co.', [approved])), ['action_claim:has been issued'])
  assert.deepEqual(kinds(check('HV-PO-101 and HV-PO-102 have been issued.', [issued, approved])), ['action_claim:have been issued'])
  // "I" always claims the assistant acted, whatever the record's state.
  assert.deepEqual(kinds(check('I issued HV-PO-101.', [issued])), ['action_claim:I issued'])
  assert.deepEqual(kinds(check('Harbor Valve Co 有 2 笔已下达且逾期的订单。', [orders, { rows: [{ supplier: 'Harbor Valve Co', overdue: 2 }] }])), ['action_claim:已下达'])
  assert.deepEqual(kinds(check('HV-PO-101 状态：已取消。因为订单已取消，它不计入逾期。', [orders])), ['action_claim:已取消'])
})

test('always refused: an action claim, an amount the role cannot see, an invented figure', () => {
  assert.deepEqual(kinds(check('我已付款。')), ['action_claim:已付款'])
  assert.deepEqual(kinds(check('I approved HV-PO-101.', [orders])), ['action_claim:I approved'])
  // A viewer's rows carry no amount: an amount in the answer is not from them.
  const hidden = { rows: orders.rows.map(({ amount: _amount, ...row }) => ({ ...row, amount: null })), total: 8 }
  assert.deepEqual(kinds(check('HV-PO-101 is worth 7,320 USD.', [hidden])), ['number:7,320 USD'])
  // A figure no tool returned, beside one it did.
  assert.deepEqual(kinds(check('HV-PO-101 is 8 days overdue and HV-PO-102 is 12 days overdue.', [orders])), ['number:12 days'])
})
