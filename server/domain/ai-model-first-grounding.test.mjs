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

test('a count of rows the model picked out: grounded beside the list it counts, refused alone or miscounted', () => {
  // The Tier 1 overdue orders are 5 of the 8 overdue; no tool returns 5. Since
  // 2026-11-07 a count written beside the records it counts, on one line, is
  // grounded by that list (each record is checked on its own).
  assert.deepEqual(kinds(check('一级供应商共 5 笔逾期订单：HV-PO-101、HV-PO-102、PR-PO-201、PR-PO-202、LK-PO-301。', [orders])), [])
  assert.deepEqual(kinds(check('一级供应商共 7 笔逾期订单：HV-PO-101、HV-PO-102、PR-PO-201、PR-PO-202、LK-PO-301。', [orders])), ['number:7'])
  // Alone, with the list on another line, or not a count of the list: refused.
  assert.deepEqual(kinds(check('一级供应商共 5 笔逾期订单。', [orders])), ['number:5'])
  assert.deepEqual(kinds(check('Tier 1 has 5 overdue orders.\nHV-PO-101, HV-PO-102, PR-PO-201, PR-PO-202 and LK-PO-301.', [orders])), ['number:5'])
  // Through calculate it is grounded too.
  assert.deepEqual(kinds(check('一级供应商共 5 笔逾期订单。', [orders, { operation: 'sum', values: [1, 1, 1, 1, 1], result: 5 }])), [])
})

// 2026-11-07 (the v2 evaluation on public data): "FOODS_3 items (6): …" and
// "for 10 of the 12 items the quantity is the minimum order" were flagged,
// though the reorder list held both counts in its rows.
test('the counts a whole list holds: rows sharing a value or a flag; not from a list cut at the limit', () => {
  const item = (sku, supplier, raisedToMinimum) => ({ sku, supplier, raisedToMinimum, ref: { type: 'item', id: sku, label: sku } })
  const list = { rows: [item('A-1', 'North Foods', true), item('A-2', 'North Foods', true), item('A-3', 'North Foods', false), item('B-1', 'South Home', true)], total: 4, more: 0 }
  assert.deepEqual(kinds(check('3 of the 4 items come from North Foods.', [list])), [])
  assert.deepEqual(kinds(check('For 3 of them the quantity was raised to the minimum order; 1 was not.', [list])), [])
  assert.deepEqual(kinds(check('North Foods supplies 5 of them.', [list])), ['number:5'])
  // Harbor Valve Co has 2 of the 3 orders shown, but 9 are overdue in all.
  const shown = (more) => ({ rows: [{ order: 'X-1', supplier: 'Harbor Valve Co' }, { order: 'X-2', supplier: 'Harbor Valve Co' }, { order: 'X-3', supplier: 'Lakeside Wire' }], total: 3 + more, more })
  assert.deepEqual(kinds(check('Harbor Valve Co has 2 overdue orders.', [shown(6)])), ['number:2'])
  assert.deepEqual(kinds(check('Harbor Valve Co has 2 overdue orders.', [shown(0)])), [])
})

test('a count beside its list: in brackets or before what it counts, one item by SKU or name', () => {
  const facts = { inventory: { rows: [{ sku: 'FOODS_3_064', itemName: 'Canned Beans' }, { sku: 'FOODS_3_090', itemName: 'Rice' }, { sku: 'HOUSEHOLD_1_019', itemName: 'Detergent' }] } }
  const results = [{ rows: facts.inventory.rows, total: 3 }]
  assert.deepEqual(kinds(check('- **FOODS_3 items (2):** FOODS_3_064 and FOODS_3_090.', results, { facts })), [])
  assert.deepEqual(kinds(check('2 FOODS_3 items are short: FOODS_3_064 (Canned Beans) and FOODS_3_090.', results, { facts })), [])
  assert.deepEqual(kinds(check('2 个 FOODS_3 物料低于再订货点：FOODS_3_064、FOODS_3_090。', results, { facts })), [])
  assert.deepEqual(kinds(check('- **FOODS_3 items (4):** FOODS_3_064 and FOODS_3_090.', results, { facts })), ['number:4'])
  // A quantity beside the same names is no count of them.
  assert.deepEqual(kinds(check('Order 2 cases of FOODS_3_064 and FOODS_3_090.', results, { facts })), ['number:2'])
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

// 2026-11-06 (the v2 evaluation on public data): the solver writes a plan's
// lines as text, "HOUSEHOLD_1_272 81, ...". Its quantities back an answer that
// quotes them; the digits of a SKU do not, and a quantity is not an amount.
test('the quantities in a plan\'s lines back the answer; a SKU\'s digits and amounts do not', () => {
  const results = [{ plans: [{ plan: 'without_budget_limit', lines: 'HOUSEHOLD_1_272 81, HOUSEHOLD_1_019 32', spend: 1002.23 }] }]
  assert.equal(check('Without a cap, HOUSEHOLD_1_272 would go to 81 units and HOUSEHOLD_1_019 to 32.', results).ok, true)
  assert.equal(check('That is 272 units.', results).ok, false)
  assert.equal(check('It would cost $81.', results).ok, false)
})

// 2026-11-07 (15231): "200 个的年持有成本是 $2,500，100 个是 $1,250" was flagged
// as $2,500,100, NFKC having turned the Chinese comma into ",".
test('a Chinese comma between two figures keeps them apart, in the answer, the question and a passage', () => {
  const costs = [{ comparisons: [{ quantity: 100, holdingCostPerYear: 1250 }, { quantity: 200, holdingCostPerYear: 2500 }] }]
  assert.deepEqual(kinds(check('200 个的年持有成本是 $2,500，100 个是 $1,250。', costs)), [])
  assert.deepEqual(kinds(check('200 个的年持有成本是 $2,500，100 个是 $1,350。', costs)), ['number:$1,350'])
  // A figure written with its own thousands comma is still one figure.
  assert.deepEqual(kinds(check('年持有成本合计 $3,750。', [...costs, { operation: 'sum', values: [1250, 2500], result: 3750 }])), [])
  assert.deepEqual(kinds(check('订 50 或 100 都可以。', [], { question: '订 50，100 还是 200？' })), [])
  assert.deepEqual(kinds(check('供应商 3 个工作日内回复。', [policy('供应商应在 3，5 个工作日内回复。')])), [])
})

// 2026-11-07 new-user test: words that are no figure about the records were
// flagged, and a rounded figure the prompt allows.
test('a quoted draft\'s list numbers, payment terms and the answer\'s own steps are no figures; a marked rounding may round', () => {
  const answerOf = (answer, results = []) => checkAiModelFirstGrounding({ answer: { title: 'Answer', answer, records: [] }, results, today: '2026-11-07' }).problems
  // A follow-up drafted for the user, its questions numbered inside the quote.
  assert.deepEqual(answerOf('> Could you confirm:\n> 1. The new date.\n> 2. The quantity.\n> 3. The reason for the delay.'), [])
  // Payment terms, in an example or as terms.
  assert.deepEqual(answerOf('Paste them, for example "Acme Packaging, contact Jane, Net 30". Terms such as 2/10 net 30 or 月结 30 天 work too.'), [])
  // Steps of the answer's own list; a step it does not have is still a figure.
  assert.deepEqual(answerOf('1. Add suppliers.\n2. Add items.\n3. Raise a request.\n\nWe can do steps 1 and 2 now, then 第 3 步.'), [])
  assert.deepEqual(answerOf('1. Add suppliers.\n2. Add items.\n\nThen do step 5.'), [{ kind: 'number', value: '5' }])
  // A figure marked as rounded may be off by half the place of its last
  // non-zero digit; an unmarked one may not.
  const amounts = [{ rows: [{ amount: 7320, currency: 'USD' }, { amount: 17.05, currency: 'USD' }] }]
  assert.deepEqual(answerOf('The largest is about $7,300 and the smallest about $17.', amounts), [])
  assert.deepEqual(answerOf('金额 7,300 美元左右，约 $7,000。', amounts), [])
  assert.deepEqual(answerOf('The largest is $7,300.', amounts), [{ kind: 'number', value: '$7,300' }])
  assert.deepEqual(answerOf('The largest is about $7,250.', amounts), [{ kind: 'number', value: '$7,250' }])
})
