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

// 2026-11-07: "$0.71 unspent" read the solver's budgetLeft and was flagged.
test('a budget left over is money', () => {
  const problems = checkAiModelFirstGrounding({ answer: { title: 'Plan', answer: 'It leaves $0.71 unspent; the reorder list leaves about $148.', records: [] }, results: [{ plans: [{ plan: 'optimal', spend: 599.29, budgetLeft: 0.71 }, { plan: 'reorder_list', spend: 451.9, budgetLeft: 148.1 }] }], today: '2026-11-07' }).problems
  assert.deepEqual(problems, [])
})

// 2026-11-07: a top-customers answer had every customer's number flagged
// ("Customer 14096 (United Kingdom)", in Chinese "Customer 14096（英国）").
test('a number inside a name a result gives is part of the name, not a figure', () => {
  const results = [{ rows: [{ customer: 'Customer 14096 (United Kingdom)', amount: 7508.14, sharePercent: 9.9 }, { itemName: '72 Sweetheart Fairy Cake Cases', amount: 35.75 }] }]
  const check = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems
  assert.deepEqual(check('Customer 14096 (United Kingdom) bought £7,508.14, 9.9% of the total; 72 Sweetheart Fairy Cake Cases sold £35.75.'), [])
  assert.deepEqual(check('Customer 14096（英国）：£7,508.14，占 9.9%。'), [])
  // The figures beside the name are still checked.
  assert.deepEqual(check('Customer 14096 (United Kingdom) bought £9,999.00.'), [{ kind: 'number', value: '£9,999.00' }])
})

// 2026-11-08 on DeepSeek: "Customer 16,684" for Customer 16684.
test('a number inside a name is part of the name when the answer groups its digits', () => {
  const results = [{ rows: [{ customer: 'Customer 16684 (United Kingdom)', amount: 10230.24 }] }]
  const check = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems
  assert.deepEqual(check('排名第一的 Customer 16,684 只占 9.8% 以内，金额 £10,230.24。').filter((row) => row.value.includes('16,684')), [])
  assert.deepEqual(check('Customer 16,684 (United Kingdom) bought £10,230.24.'), [])
})

// 2026-11-08 on DeepSeek: "85123A 'Famous Paint Your Own…' style item".
test('a name written beside a SKU must be that SKU\'s item name; a Chinese name is left alone', () => {
  const facts = { inventory: { rows: [{ sku: '85123A', itemName: 'White Hanging Heart T-Light Holder' }, { sku: '22423', itemName: 'Regency Cakestand 3 Tier' }], masterOnly: [] } }
  const results = [{ rows: [{ sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', available: 48 }, { sku: '22423', itemName: 'Regency Cakestand 3 Tier' }] }]
  const pairs = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results, facts }).problems.filter((row) => row.kind === 'item_name')
  assert.deepEqual(pairs("85123A 'Famous Paint Your Own…' style item is low."), [{ kind: 'item_name', value: 'Famous Paint Your Own…', expected: 'White Hanging Heart T-Light Holder', sku: '85123a' }])
  // Another item's name for this SKU.
  assert.equal(pairs('22423 "White Hanging Heart T-Light Holder" is low.')[0].expected, 'Regency Cakestand 3 Tier')
  // The right name, shortened, before or after; figures in brackets; Chinese.
  assert.deepEqual(pairs('85123A (White Hanging Heart T-Light Holder) and 22423 (Regency Cakestand) are low.'), [])
  assert.deepEqual(pairs("'White Hanging Heart' (85123A) is low."), [])
  assert.deepEqual(pairs('85123A (48 pcs available) is low.'), [])
  assert.deepEqual(pairs('85123A（白色心形烛台）库存偏低。'), [])
})

// 2026-11-08 on DeepSeek: "stays at 168 pcs available to promise" (48 + 120).
test('a figure written as available comes from an available field', () => {
  const results = [{ rows: [{ sku: '85123A', available: 48, availableToPromise: 408, incoming: 360 }], other: { quantity: 168 } }]
  const numbers = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  assert.deepEqual(numbers('85123A stays at 168 pcs available to promise.'), ['168'])
  assert.deepEqual(numbers('Available to promise is 168 for 85123A.'), ['168'])
  assert.deepEqual(numbers('85123A has 48 pcs available now and 408 available to promise.'), [])
  // 168 not written as available is checked as before.
  assert.deepEqual(numbers('A quantity of 168 is recorded.'), [])
})

// 2026-11-08 on DeepSeek, a chase email's commentary: "即便这两批货都不来，可用量也
// 够用（从不计入这两批货的 168 件，到计入后的 408 件）". 168 is 48 plus one of
// the two late orders (408 − 240); without both it is 48.
test('a stock figure written for none of the late orders arriving is today\'s available stock', () => {
  const results = [
    { sku: '85123A', availableToday: 48, safetyStock: 119, availableIfLateLinesArrive: 408, availableIfNoLateLinesArrive: 48, notPlacedInAWeek: { incomingPastPromisedDate: [{ orderNumber: 'PO-202610-0024', quantity: 240 }, { orderNumber: 'PO-202610-0031', quantity: 120 }] }, recordedDemand: { averageDailyDemand: 17.1 }, runsOutIfNothingArrives: { days: 2.8 }, weeksAhead: 4, lateLines: 2, lateLinesQuantity: 360, reorderPoint: 358 },
    { calculations: [{ label: 'without PO-202610-0024', result: 168 }, { label: 'short of safety stock', result: 71 }, { label: 'a week', result: 120 }] },
  ]
  const numbers = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  assert.deepEqual(numbers('即便这两批货都不来，可用量也够用（从不计入这两批货的 168 件，到计入后的 408 件）。'), ['168'])
  assert.deepEqual(numbers('Even if neither order arrives, 168 pcs stay available.'), ['168'])
  assert.deepEqual(numbers('Without both orders it would be 168 pcs.'), ['168'])
  assert.deepEqual(numbers('85123A has 168 pcs if neither arrives.'), ['168'])
  assert.deepEqual(numbers('85123A 有 168 件（两批都不来时）。'), ['168'])
  // A later Flash run: "两批未到的 360 件一旦全不到，可用库存就是 0".
  assert.deepEqual(numbers('两批未到的 360 件一旦全不到，可用库存就是 0。'), ['0'])
  // The right figure passes, in either language.
  assert.deepEqual(numbers('Without both orders it would be 48 pcs, below safety stock of 119.'), [])
  assert.deepEqual(numbers('如果两批货都不来，可用量只有 48 件，低于安全库存 119 件。'), [])
  assert.deepEqual(numbers('Even if neither order arrives, 48 pcs are available today; once both arrive, 408.'), [])
  // A figure without one named order is not read as this scenario.
  assert.deepEqual(numbers('Without PO-202610-0024 it is 168 pcs.'), [])
  // Nor a measure named after the figure, or the other case after a colon or
  // "都到的话" (later Flash runs).
  assert.deepEqual(numbers('**这两单没到之前就补一批**：现有在途和申请都覆盖不到 358 件的再订货点。'), [])
  assert.deepEqual(numbers('- **两单都到 vs 都不来：** 都到的话可用量是 408 件，够覆盖 358 件的再订货点；都不来就只剩 48 件。'), [])
  assert.deepEqual(numbers('- **两单都到 vs 都不来：** 都到的话可用量是 408 件，够覆盖 358 件的再订货点；都不来就只剩 168 件。'), ['168'])
  // Nor an order's state, its own quantity, or the next sentence (saved
  // answers replayed on 2026-11-08).
  assert.deepEqual(numbers('PO-202610-0024 is overdue with nothing received yet, so all 240 pcs are outstanding.'), [])
  assert.deepEqual(numbers('可供承诺量会从 408 件降到 48 件（去掉这两单的 360 件）。'), [])
  assert.deepEqual(numbers('PO-202610-0024（逾期 3 天，240 件全部未到），两张合计剩余 360 件。'), [])
  assert.deepEqual(numbers('85123A 现有可用 48 件，两批未到的 360 件一旦全不到，可用库存就是 0。'), ['0'])
  assert.deepEqual(numbers('If both late orders arrive, available to promise is 408 pcs. If neither arrives, it is 48 pcs.'), [])
  assert.deepEqual(numbers('85123A 有 168 件，如果两批都不来。'), ['168'])
  // The last Flash round: a figure without one order, a measure in the next
  // clause.
  assert.deepEqual(numbers('**销售订单**：这两张单都不来，可承诺量是 288 件，仍高于安全库存 119 件。'), ['288'])
  // A wrong figure for each order missing alone, written as both missing.
  assert.deepEqual(numbers('即使这两张订单都不到货，仍有 168 件。'), ['168'])
  // Nor is an order's own quantity named as what does not arrive.
  assert.deepEqual(numbers('如果 PO-202610-0031 的剩余 120 件和 PO-202610-0024 的 240 件都不来，85123A 现在只有 48 件可用。'), [])
  // A shortfall, demand, safety stock or a time written in the scenario is
  // another measure, checked as before.
  assert.deepEqual(numbers('If neither order arrives, you would be 71 pcs short of safety stock.'), [])
  assert.deepEqual(numbers('如果两批都不来，缺口是 71 件。'), [])
  assert.deepEqual(numbers('如果两批都不到，安全库存 119 件会被击穿。'), [])
  assert.deepEqual(numbers('Even if neither arrives, demand of 120 pcs a week keeps going.'), [])
  assert.deepEqual(numbers('If neither arrives, 85123A runs out in 2.8 days.'), [])
  assert.deepEqual(numbers('If neither order arrives, stock stays below safety stock for 4 weeks.'), [])
  // A count is left alone.
  assert.deepEqual(numbers('If none of the 2 orders is late, nothing changes.'), [])
})

// 2026-11-08 on DeepSeek: "本周内（Nov 9–15, 2026）", a week stock_projection
// gave, was read as Nov 9 and the number 15.
test('a range of days in one month checks both days', () => {
  const results = [{ weeks: [{ from: '2026-11-09', to: '2026-11-15', endAvailable: -72 }] }]
  const problems = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems.map((row) => `${row.kind}:${row.value}`)
  assert.deepEqual(problems('本周内（Nov 9–15, 2026）就会用完。'), [])
  assert.deepEqual(problems('In the week of Nov 9-15 it runs short.'), [])
  assert.deepEqual(problems('Between Nov 9 – 16, 2026 it runs short.'), ['date:Nov 9 – 16, 2026'])
  // Two separate dates are read as before.
  assert.deepEqual(problems('From Nov 9, 2026 to Nov 15, 2026.'), [])
})

// 2026-11-09 on Flash, today's priorities: "available to promise for 85123A
// is 408 pcs with these late lines counted (288 without)". 288 leaves out one
// of the two late orders; late_order_impact now gives withoutEveryLateLine 48.
test('a figure "without the late lines" comes from the row that leaves out every late line', () => {
  const results = [{ skus: [
    { sku: '85123A', judgedOrders: ['PO-202610-0022'], availableToPromise: 408, withoutTheseLines: 288 },
    { sku: '85123A', judgedOrders: ['PO-202610-0024'], availableToPromise: 408, withoutTheseLines: 168 },
    { sku: '85123A', judgedOrders: ['PO-202610-0022', 'PO-202610-0024'], together: true, stillToReceive: 360, availableToPromise: 408, withoutTheseLines: 48, withoutEveryLateLine: 48 },
  ] }]
  const numbers = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  assert.deepEqual(numbers('Available to promise for 85123A is 408 pcs with these late lines counted (288 without).'), ['288'])
  assert.deepEqual(numbers('Available to promise for 85123A is 408 pcs with these late lines counted (48 without).'), [])
  assert.deepEqual(numbers('Without the late lines it is 168 pcs.'), ['168'])
  assert.deepEqual(numbers('Without them, 85123A has 48 pcs.'), [])
  // A figure without one named order is read as before.
  assert.deepEqual(numbers('Without PO-202610-0022 it is 288 pcs, and without PO-202610-0024 it is 168 pcs.'), [])
  assert.deepEqual(numbers('85123A has 288 pcs without PO-202610-0022.'), [])
  // A difference named after the figure is another measure (a later step-2
  // run: "drops to 48 pcs if neither arrives — a 360 pcs difference").
  assert.deepEqual(numbers('Available to promise is 408 pcs with both late lines counted, but drops to 48 pcs if neither arrives — a 360 pcs difference.'), [])
  // The figure a change starts from is not the scenario's ("从 408 件降到 48 件").
  assert.deepEqual(numbers('PO-202610-0022 和 PO-202610-0024 涉及的 85123A 全部不到货，可承诺量会从 408 件降到 48 件。'), [])
  assert.deepEqual(numbers('If neither arrives, it drops from 408 pcs to 48 pcs.'), [])
  assert.deepEqual(numbers('如果两批都不来，可承诺量会从 408 件降到 168 件。'), ['168'])
  // A figure written as available to promise may come from these rows.
  assert.deepEqual(numbers('单不来时：PO-202610-0022 不来，可承诺量 288 件；PO-202610-0024 不来，只剩 168 件。'), [])
})

// 2026-11-09 on Flash, the UCI walkthrough answers: right figures the answer worked
// out from its own figures were flagged (360 pcs, roughly 18 days, about 43%).
test('a figure worked out from the answer\'s own figures is grounded; wrong arithmetic and available figures are not', () => {
  const numbers = (answer, results) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  const late = [{ rows: [{ order: 'HV-PO-101', remaining: 120 }, { order: 'HV-PO-102', remaining: 240 }] }]
  assert.deepEqual(numbers('HV-PO-101 has 120 pcs outstanding and HV-PO-102 has 240 pcs. That leaves 360 pcs still to arrive across the two orders.', late), [])
  assert.deepEqual(numbers('HV-PO-101 has 120 pcs outstanding and HV-PO-102 has 240 pcs. That leaves 350 pcs still to arrive.', late), ['350'])
  // Only from figures the answer writes: 360 alone is not worked out. (Here
  // it is the whole list's remaining, a total the results hold; from a list
  // cut at its limit it is neither.)
  assert.deepEqual(numbers('360 pcs are still to arrive.', late), [])
  assert.deepEqual(numbers('360 pcs are still to arrive.', [{ ...late[0], more: 4 }]), ['360'])
  const cover = [{ sku: 'HV-1', onHand: 132, averageDailyDemand: 7.2 }]
  assert.deepEqual(numbers('Stock on hand is 132 pcs. At the recorded average of 7.2 pcs a day it would cover roughly 18 days.', cover), [])
  assert.deepEqual(numbers('Stock on hand is 132 pcs. At 7.2 pcs a day it would cover roughly 25 days.', cover), ['25 days'])
  const spend = [{ supplier: 'Harbor Valve Co', committedSpend: 39929.35, currency: 'GBP', items: [{ sku: 'HV-1', spend: 17142.45, currency: 'GBP' }] }]
  assert.deepEqual(numbers('Committed spend is £39,929.35. HV-1 alone accounts for £17,142.45, about 43% of it.', spend), [])
  // Three figures, and a run of one kind (a table's top three) with its share.
  const owed = [{ total: 1000, currency: 'GBP', rows: [{ customer: 'Customer 1', amount: 300, currency: 'GBP' }, { customer: 'Customer 2', amount: 150, currency: 'GBP' }, { customer: 'Customer 3', amount: 50.5, currency: 'GBP' }] }]
  assert.deepEqual(numbers('Receivables total £1,000.00. | Customer 1 | £300.00 | | Customer 2 | £150.00 | | Customer 3 | £50.50 | The top three hold £500.50, about 50% of it.', owed), [])
  // An available figure must come from its own field, even when it is a sum.
  const stock = [{ sku: 'HV-1', available: 48, onOrder: [{ order: 'HV-PO-101', remaining: 120 }] }]
  assert.deepEqual(numbers('HV-1 has 48 pcs available today and 120 pcs on HV-PO-101. If neither order arrives, HV-1 has 168 pcs available.', stock), ['168'])
  // A whole number under 10 is not worked out.
  assert.deepEqual(numbers('HV-PO-101 has 120 pcs outstanding and HV-PO-102 has 240 pcs, 2 orders with 3 more to come.', late), ['3'])
})

test('"SKU-" before a SKU the results hold is that SKU; before any other it is still refused', () => {
  const problems = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results: [{ rows: [{ sku: '85123A', order: 'HV-PO-101' }] }] }).problems.map((row) => `${row.kind}:${row.value}`)
  assert.deepEqual(problems('Two orders for SKU-85123A are late.'), [])
  assert.deepEqual(problems('Two orders for SKU-99999X are late.'), ['record:SKU-99999X'])
})

// 2026-11-09 on Flash, the UCI walkthrough question set: totals of
// list_purchase_orders' rows the answer did not add up in writing.
test('a whole list\'s totals, over every row and the rows sharing a value, are grounded; never available stock', () => {
  const lateOrders = [{ rows: [
    { orderNumber: 'PO-202610-0022', supplier: 'Acme Home Goods', status: 'partially_received', skus: ['85123A'], overdueDays: 5, ordered: 240, received: 120, remaining: 120, unit: 'pcs', amount: 708, currency: 'GBP' },
    { orderNumber: 'PO-202610-0023', supplier: 'Globex Party Supplies', status: 'issued', skus: ['84879'], overdueDays: 4, ordered: 450, received: 0, remaining: 450, unit: 'pcs', amount: 760.5, currency: 'GBP' },
    { orderNumber: 'PO-202610-0024', supplier: 'Acme Home Goods', status: 'issued', skus: ['85123A'], overdueDays: 3, ordered: 240, received: 0, remaining: 240, unit: 'pcs', amount: 708, currency: 'GBP' },
  ], total: 3, more: 0 }]
  const numbers = (answer, results = lateOrders) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  assert.deepEqual(numbers('共有 3 张采购订单逾期。这 3 张订单合计待收货 810 件，涉及 2 家供应商。'), [])
  assert.deepEqual(numbers('Acme Home Goods accounts for 2 of them, both for 85123A: 360 pcs are still to receive across the two orders.'), [])
  assert.deepEqual(numbers('The late orders are worth £2,176.50, £1,416.00 of it with Acme Home Goods.'), [])
  // A total no rows add up to is still refused, and so is a cut list's.
  assert.deepEqual(numbers('360 of the 810 pcs are 84879.'), [])
  assert.deepEqual(numbers('There are 900 pcs still to receive.'), ['900'])
  assert.deepEqual(numbers('There are 810 pcs still to receive.', [{ ...lateOrders[0], more: 2 }]), ['810'])
  // Rows in two currencies give no amount total.
  const mixed = [{ rows: [{ supplier: 'A', amount: 100, currency: 'GBP' }, { supplier: 'B', amount: 50, currency: 'USD' }] }]
  assert.deepEqual(numbers('The two orders come to £150.00.', mixed), ['£150.00'])
  // Several items' available stock together is no item's available stock.
  const stock = [{ rows: [{ sku: '85123A', available: 48 }, { sku: '84879', available: 98 }] }]
  assert.deepEqual(numbers('85123A has 146 pcs available.', stock), ['146'])
})

// 2026-11-09 on Flash, the question set: "If only the remaining 120 pcs on
// PO-202610-0022 arrive, 85123A would have 168 pcs available — your 48 pcs
// available now plus those 120 pcs." Right, and flagged: no field held 168.
test('a figure for only some of an item\'s open orders arriving is its stock today plus what those orders still bring', () => {
  const results = [
    { rows: [{ sku: '85123A', available: 48, availableToPromise: 408, incomingOnPurchaseOrders: 360 }] },
    { rows: [
      { orderNumber: 'PO-202610-0022', supplier: 'Acme Home Goods', skus: ['85123A'], ordered: 240, received: 120, remaining: 120 },
      { orderNumber: 'PO-202610-0024', supplier: 'Acme Home Goods', skus: ['85123A'], ordered: 240, received: 0, remaining: 240 },
      { orderNumber: 'PO-202610-0023', supplier: 'Globex Party Supplies', skus: ['84879'], ordered: 450, received: 0, remaining: 450 },
    ] },
  ]
  const numbers = (answer, given = results) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results: given }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  assert.deepEqual(numbers('If only the remaining 120 pcs on PO-202610-0022 arrive, 85123A would have **168 pcs available** — your 48 pcs available now plus those 120 pcs.'), [])
  assert.deepEqual(numbers('如果只有 PO-202610-0024（240 件，一件都还没收到）到货，85123A 的可用量会是 **288 件**。'), [])
  assert.deepEqual(numbers('With only PO-202610-0024 in, 85123A has 288 pcs available.'), [])
  assert.deepEqual(numbers('85123A would have 168 pcs available if only PO-202610-0022 arrives.'), [])
  // Not in that scenario, an available figure still comes from its own field.
  assert.deepEqual(numbers('85123A stays at 168 pcs available to promise.'), ['168'])
  assert.deepEqual(numbers('If neither order arrives, 85123A has 168 pcs available.'), ['168'])
  // Another SKU's order, an order counted twice, or a figure no subset makes
  // is refused.
  assert.deepEqual(numbers('If only PO-202610-0023 arrives, 85123A would have 498 pcs available.'), ['498'])
  assert.deepEqual(numbers('If only PO-202610-0022 arrives, 85123A would have 200 pcs available.'), ['200'])
  // stock_projection's late lines tie to the SKU too, read once with the orders.
  const projection = [{ sku: '85123A', availableToday: 48, notPlacedInAWeek: { incomingPastPromisedDate: [{ orderNumber: 'PO-202610-0022', quantity: 120 }, { orderNumber: 'PO-202610-0024', quantity: 240 }] } }, results[1]]
  assert.deepEqual(numbers('If only PO-202610-0022 arrives, 85123A would have 168 pcs available.', projection), [])
  assert.deepEqual(numbers('If only PO-202610-0022 arrives, 85123A would have 288 pcs available.', [projection[0]]), [])
  assert.deepEqual(numbers('If only one order arrives, 85123A would have 528 pcs available.', projection), ['528'])
})

test('aging bucket labels are no figures in an answer about overdue or aged amounts', () => {
  const numbers = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results: [{ total: 78984.01, currency: 'GBP' }] }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  assert.deepEqual(numbers('Aging: current £78,984.01; nothing in the 1–30, 31–60, 61–90 or over-90-day overdue buckets.'), [])
  assert.deepEqual(numbers('账龄：当前 £78,984.01，逾期 1–30 天、31–60 天、61–90 天和 90 天以上都没有。'), [])
  // Without an aging cue the same figures are read as figures.
  assert.deepEqual(numbers('Order 31–60 units next month.'), ['31', '60'])
})

// 2026-11-10 on Flash: "To put a number on that top-10 share" was marked as
// a record no result holds.
test('top-10 and the like are words, not record numbers; their number is checked as a figure, and an unknown record still is', () => {
  const customers = Array.from({ length: 10 }, (_, index) => ({ customer: `Customer ${14090 + index} (United Kingdom)`, amount: 1000 - index * 10, currency: 'GBP' }))
  const problems = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results: [{ rows: customers, total: 10, share: 0.331 }] }).problems.map((row) => `${row.kind}:${row.value}`)
  assert.deepEqual(problems('That top-10 share is 33.1% of the month.'), [])
  assert.deepEqual(problems('That top-12 share is 33.1% of the month.'), ['number:12'])
  assert.deepEqual(problems('PO-202611-9999 is late.'), ['record:PO-202611-9999'])
})

// 2026-11-11 on Flash, the UCI question set a day after its seed day: right
// answers flagged for the aging buckets, a top 10 and "a week" in days.
test('aging bucket amounts and labels, the top N of a list, and a week the question names are grounded', () => {
  const numbers = (answer, results, question = '') => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results, question }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  const aging = [{ aging: [{ currency: 'GBP', current: '74505.50', '1_30': '4478.51', '31_60': '0.00', '61_90': '0.00', '90_plus': '0.00', total: '78984.01', count: 542 }] }]
  assert.deepEqual(numbers('按期划分：未到期 £74,505.50，逾期 1–30 天 £4,478.51，逾期 31 天以上没有。', aging), [])
  assert.deepEqual(numbers('£74,505.50 of that is not yet due and £4,478.51 is overdue; nothing is more than 30 days past due.', aging), [])
  assert.deepEqual(numbers('£4,500.00 is overdue.', aging), ['£4,500.00'])
  // The top N of a list cut at its limit: only right after top / first / 前.
  const items = [{ rows: Array.from({ length: 10 }, (_, index) => ({ sku: `S-${index}`, value: 100 - index })), total: 200, more: 190 }]
  assert.deepEqual(numbers('The top 10 items together hold about 28% of the stock value.', items), ['28%'])
  assert.deepEqual(numbers('前 10 个物料。', items), [])
  assert.deepEqual(numbers('There are 10 items in stock.', items), ['10'])
  assert.deepEqual(numbers('The top 12 items.', items), ['12'])
  // "再晚一周": 7 days is the user's week.
  const stock = [{ sku: '84879', available: 98, averageDailyDemand: 20.5 }]
  assert.deepEqual(numbers('7 天约需 143.5 件。', stock, '如果 Globex 再晚一周，84879 会缺货吗？'), ['143.5'])
  assert.deepEqual(numbers('7 天约需 143.5 件。', stock, '84879 会缺货吗？'), ['7 天', '143.5'])
  assert.deepEqual(numbers('Over 14 days it needs 287 pcs.', stock, 'What if Acme is two weeks late?'), ['287'])
})

// 2026-11-11 on Flash, the UCI workspace's SKUs are digits: "450 件 84879 未到".
test('a SKU of digits the workspace holds is a name, found in a result\'s words; one no result names is still refused', () => {
  const facts = { inventory: { rows: [{ sku: '84879', itemName: 'Assorted Colour Bird Ornament' }, { sku: '22423', itemName: 'Regency Cakestand 3 Tier' }] } }
  const problems = (answer, results) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results, facts }).problems.map((row) => `${row.kind}:${row.value}`)
  const titled = [{ rows: [{ title: 'PO-202610-0023: 450 pcs of 84879 still to receive', remaining: 450 }] }]
  assert.deepEqual(problems('450 件 84879 未到。', titled), [])
  assert.deepEqual(problems('450 件 84879 未到，22423 也要补。', titled), ['name:22423'])
  // A quantity under four digits is never read as a SKU.
  assert.deepEqual(problems('450 pcs are still to come.', [{ rows: [{ remaining: 120 }] }]), ['number:450'])
})

// 2026-11-10 on Flash: "Acme 是几级供应商？为什么？" quoted the buyer's reason.
test('figures in a tier reason count as the words of the person who wrote it', () => {
  const reason = 'Tier 1: sole source of our White Hanging Heart T-Light Holder (No. 2 of 200 products by sales value over the last 12 months) and of 4 other 85xxx lines; 7% of purchase spend over the last 12 months.'
  const numbers = (answer, results) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results }).problems.filter((row) => row.kind === 'number').map((row) => row.value)
  const answer = 'Acme 是 1 级供应商：按过去 12 个月的销售价值在 200 个产品中排第 2，另有 4 个 85xxx 物料，占采购支出的 7%。'
  assert.deepEqual(numbers(answer, [{ rows: [{ name: 'Acme Home Goods', tier: 1, tierReason: reason }] }]), [])
  assert.deepEqual(numbers(answer, [{ rows: [{ name: 'Acme Home Goods', tier: 1, note: reason }] }]).sort(), ['12', '2', '200', '4', '7%'].sort())
})
