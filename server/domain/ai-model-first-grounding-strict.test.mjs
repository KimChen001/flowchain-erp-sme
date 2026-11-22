import test from 'node:test'
import assert from 'node:assert/strict'
import { checkAiModelFirstGrounding } from './ai-model-first-grounding.mjs'

// The strict pass of the grounding check can only add problems (2026-11-22,
// the probe review of #455). Every probe line of that review, with its
// fixture: the problems with strict on hold every problem with strict off,
// and the review's correct answers gain none. With strict off the check runs
// as it did before the pass.

const ref = (type, id, label) => ({ type, id, label })
const kindsOf = (outcome) => outcome.problems.map((row) => `${row.kind}:${row.value}`)
const run = (answer, { results, facts, today = null, locale = 'en-GB', strict }) => kindsOf(checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results, facts, today, locale, strict }))
const added = (answer, fixture) => {
  const loose = run(answer, { ...fixture, strict: false })
  const strict = run(answer, { ...fixture, strict: true })
  assert.deepEqual(loose.filter((row) => !strict.includes(row)), [], `strict dropped a problem: ${answer}`)
  return strict.filter((row) => !loose.includes(row))
}

const FACTS = {
  inventory: { rows: [
    { sku: '21137', itemName: 'Black Record Cover Frame' }, { sku: '21498', itemName: 'Red Retrospot Wrap' }, { sku: '22178', itemName: 'Victorian Glass Hanging T-Light' },
    { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder' }, { sku: '84879', itemName: 'Assorted Colour Bird Ornament' }, { sku: 'LDM-001', itemName: 'Steel Bracket' }, { sku: 'LDM-002', itemName: 'Copper Pipe' },
  ] },
  suppliers: [{ name: 'Acme Home Goods', code: 'SUP-ACME' }, { name: 'Supplier of 85xxx codes (assumed)', code: 'SUP-85' }, { name: 'Supplier of 21xxx codes (assumed)', code: 'SUP-21' }, { name: '2Go Packaging', code: 'SUP-2GO' }],
}
const RESULTS = [
  { items: [
    { sku: '21137', itemName: 'Black Record Cover Frame', onHand: 12, available: 12, safetyStock: 40 }, { sku: '21498', itemName: 'Red Retrospot Wrap', onHand: 5, available: 5, safetyStock: 30 },
    { sku: '22178', itemName: 'Victorian Glass Hanging T-Light', onHand: 21, available: 21, safetyStock: 50 }, { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', onHand: 48, available: 48, safetyStock: 60 },
  ], total: 4, more: 0 },
  { rows: [
    { orderNumber: 'PO-202610-0028', supplier: 'Acme Home Goods', remaining: 120, promisedDate: '2026-10-14', ref: ref('purchase_order', 'UCI-PO-329', 'PO-202610-0028') },
    { orderNumber: 'PO-202611-0009', supplier: 'Supplier of 85xxx codes (assumed)', remaining: 240, promisedDate: '2026-11-30', ref: ref('purchase_order', 'UCI-PO-338', 'PO-202611-0009') },
    { orderNumber: 'PO-202611-0012', supplier: '2Go Packaging', remaining: 30, promisedDate: '2026-11-21', ref: ref('purchase_order', 'UCI-PO-340', 'PO-202611-0012') },
  ], total: 3, more: 0 },
  { request: { number: 'PR-202611-0001', quantity: 11, ref: ref('purchase_request', 'PR-45C73E67', 'PR-202611-0001') } },
  { customers: [{ customer: 'Customer 14096 (United Kingdom)', code: 'CUST-14096' }, { customer: 'Customer 12748 (United Kingdom)', code: 'CUST-12748' }] },
  { lines: [{ sku: 'LDM-001', quantity: 7 }, { sku: 'LDM-002', quantity: 9 }] },
]
// The same records with no small counts in them (a count met only by its line).
const LIST = [
  { items: [
    { sku: '21137', itemName: 'Black Record Cover Frame', onHand: 12, safetyStock: 40 }, { sku: '21498', itemName: 'Red Retrospot Wrap', onHand: 15, safetyStock: 30 },
    { sku: '22178', itemName: 'Victorian Glass Hanging T-Light', onHand: 17, safetyStock: 50 }, { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', onHand: 48, safetyStock: 60 },
  ] },
  { rows: [
    { orderNumber: 'PO-202610-0028', supplier: 'Acme Home Goods', remaining: 120, promisedDate: '2026-10-14', ref: ref('purchase_order', 'UCI-PO-329', 'PO-202610-0028') },
    { orderNumber: 'PO-202611-0009', supplier: 'Supplier of 85xxx codes (assumed)', remaining: 240, promisedDate: '2026-11-30', ref: ref('purchase_order', 'UCI-PO-338', 'PO-202611-0009') },
    { orderNumber: 'PO-202611-0012', supplier: '2Go Packaging', remaining: 360, promisedDate: '2026-11-28', ref: ref('purchase_order', 'UCI-PO-340', 'PO-202611-0012') },
  ] },
  { request: { number: 'PR-202611-0001', quantity: 77, ref: ref('purchase_request', 'PR-45C73E67', 'PR-202611-0001') } },
  { customers: [{ customer: 'Customer 14096 (United Kingdom)', code: 'CUST-14096' }, { customer: 'Customer 12748 (United Kingdom)', code: 'CUST-12748' }] },
  { lines: [{ sku: 'LDM-001', quantity: 70 }, { sku: 'LDM-002', quantity: 90 }] },
]

const COUNTS = [
  '3 items are below safety stock: 21137, 21498 and 22178.', '3 items: 21137, 21498 and Customer 14096.', '2 items are short: 21137 and 21498.\n2 orders are late: PO-202610-0028 and PO-202611-0009.',
  '3 items are short: 21137 and 21498.\n3 orders are late: PO-202610-0028 and PO-202611-0009 and 22178.', '2 items are short: 21137 and 21498.\n3 orders are late: PO-202610-0028 and PO-202611-0009.',
  '3 张逾期订单：PO-202610-0028、PO-202611-0009、PO-202611-0012。', '3 张逾期订单：PO-202610-0028、PO-202611-0009、Acme Home Goods。', '2 家供应商：Acme Home Goods、2Go Packaging。', '共有 2 个供应商：Acme Home Goods 和 2Go Packaging。',
  '2 家供应商：Acme Home Goods、PO-202611-0012。', '2 笔待收货：PO-202610-0028、PO-202611-0009。', '2 笔待收货：Acme Home Goods、2Go Packaging。', '3 个物料低于安全库存：21137、21498、22178。',
  '3 种物料：Black Record Cover Frame、Red Retrospot Wrap、Victorian Glass Hanging T-Light。', '2 条记录：Acme Home Goods、2Go Packaging。',
  'Two items are short: 21137 and 21498; three orders: PO-202610-0028, PO-202611-0009, PO-202611-0012.', '4 orders: PO-202610-0028, PO-202611-0009, Acme Home Goods and 21137.',
  '2 approved requests: PR-202611-0001 and PO-202611-0009.', '2 approved requests: PR-202611-0001 and PO-202611-0009 from Acme Home Goods.', '2 orders: PO-202610-0028, PO-202611-0009 (Acme Home Goods).',
  '3 items are short. They are 21137, 21498 and 22178.', '3 items are short. 21137, 21498 and 22178.', '1 order is late: PO-202610-0028.', '2 order: PO-202610-0028 and PO-202611-0009.',
  '2 lines: LDM-001 and LDM-002.', '2 order lines are short: LDM-001 and LDM-002.', '2 purchase order lines: 21137 and 21498.', '2 PO lines: 21137 and 21498.', '2 lines: PO-202610-0028 and PO-202611-0009.',
  '2 lines: Acme Home Goods and 2Go Packaging.', '3 records: 21137, PO-202610-0028 and Customer 14096.', 'Late (3): PO-202610-0028, PO-202611-0009, Acme Home Goods.', '共 3 项：21137、21498、PO-202610-0028。',
  '3 个物料：21137、21498、Acme Home Goods。', '2 suppliers: 2Go Packaging and Supplier of 85xxx codes (assumed).', '2 suppliers: SUP-85 and SUP-21.', '2 customers: Customer 14096 and Customer 12748.',
  '2 customers: CUST-14096 and CUST-12748.', '2 items: Black Record Cover Frame and Red Retrospot Wrap.', '2 items: 21137 (Black Record Cover Frame) and 21498 (Red Retrospot Wrap).',
  '2 late Acme orders: PO-202610-0028 and PO-202611-0009.', "2 suppliers' orders are late: PO-202610-0028 and PO-202611-0009.", '2 customer orders: PO-202610-0028 and PO-202611-0009.',
  '2 items on order: 21137 and 21498.', '2 products: 21137 and 21498.', '2 SKUs: 21137 and 21498.', '2 items and 2 orders: 21137, 21498, PO-202610-0028, PO-202611-0009.', '4 items: 21137, 21498, PO-202610-0028, PO-202611-0009.',
]
const DATES = [
  'PO-202611-0012 is due 21 November.', 'PO-202611-0012 is due November 21.', 'PO-202611-0012 is due Nov. 21.', 'PO-202611-0012 is due 11/21.', 'PO-202611-0012 11月21日到货。',
  'PO-202611-0012 is due 22 November.', 'PO-202611-0012 is due November 22.', 'PO-202611-0012 11月22日到货。', 'In November Acme Home Goods shipped 21 units.', 'PO-202611-0009 arrives November PO-202611-0009 21.',
  'Due November PO-202611-0009 30.', '11月 PO-202611-0009 21日到货。', '11月PO-202611-0009 30日到货。', '11 月 Acme Home Goods 30 日交货。', 'Arrives Nov Acme Home Goods 21, 2026.', '21 Acme Home Goods November',
  'November, Acme Home Goods 21 units.', 'November Acme Home Goods 5–21.', 'November Acme Home Goods 12-21', 'Nov 12 PO-202611-0009 – 21', 'Between 14 Oct PO-202611-0009 2026.', 'October 2026-10-14 30',
]
const DOTS = [
  'PO-202610-0028 has 120 pcs to come.5 more arrive tomorrow.', 'No.5 warehouse holds 21137.', 'Use v2.5 of the plan.', 'Cut-off is 9.30 today.', 'Shipped from the U.K.5 pallets.', 'Boxes, tape etc.5 items.',
  'Cover is 7.5.', 'Cover is approx.5 days.', 'Due Nov.21.', 'Due Nov.22.', 'Order Mr.12 units.', '22178 has 21 on hand and more to come.5 units arrive Monday, so 26 in total.',
  '22178 has 21 on hand and more to come.5 units arrive Monday, so 105 in total.', '22178 has 21 on hand and more to come.5 units arrive Monday, so 4.2 in total.', 'Price approx.5 USD 120 pcs to come.',
  'Price is low.5 GBP 240 more.', 'PO-202610-0028 has more.1,234 pcs to come.', 'PO-202610-0028 has more.1,120 pcs to come.', 'Cover is now.7.5 days.', '还有 120 件未到.5 件明天到。', '还有 120 件未到.21 件明天到。',
]
// The review's chosen fixtures for dates and figures after a full stop.
const ORDER = [{ rows: [{ orderNumber: 'PO-202611-0009', supplier: 'Acme Home Goods', remaining: 21, ordered: 11, leadTimeDays: 21, promisedDate: '2026-11-30', ref: ref('purchase_order', 'UCI-PO-338', 'PO-202611-0009') }] }]
const STOCK = [{ sku: '22178', onHand: 21, remaining: 5 }]
const CHOSEN = [
  ...['In November Acme Home Goods shipped 21 units.', 'Acme Home Goods delivers November PO-202611-0009 21.', 'Arrives November PO-202611-0009 21, 2026.', 'PO-202611-0009 预计 11月 PO-202611-0009 21日到货。',
    '11 月 Acme Home Goods 21 日交货。', 'Delivery window November Acme Home Goods 11–21.', 'November Acme Home Goods 11-21', 'October 2026-11-30 21', '21 PO-202611-0009 November', 'PO-202611-0009 arrives 21 November.',
    'PO-202611-0009 arrives November 21.', 'PO-202611-0009 11月21日到货。', 'November: PO-202611-0009, 21 units.', 'Nov PO-202611-0009 21 units remain.'].map((answer) => [answer, ORDER]),
  ...['22178 has 21 on hand and more to come.5 units arrive Monday, so 26 in total.', '22178 has 21 on hand and more to come.5 units arrive Monday, so 105 in total.', '22178 has 21 on hand and more to come.5 units arrive Monday, so 4.2 in total.',
    '22178 has 21 on hand and more to come. 5 units arrive Monday, so 105 in total.', '还有 21 件未到.5 件明天到。'].map((answer) => [answer, STOCK]),
  ['Unit price approx.5 USD 120 pcs still to come.', [{ sku: '22178', unitPrice: 5, currency: 'USD', remaining: 120 }]], ['Unit price is low.5 GBP 120 pcs to come.', [{ sku: '22178', unitPrice: 5, currency: 'GBP', remaining: 120 }]],
  ['Unit price approx. 5 USD; 120 pcs still to come.', [{ sku: '22178', unitPrice: 5, currency: 'USD', remaining: 120 }]], ['PO-202611-0009 has more.1,234 pcs to come.', [{ orderNumber: 'PO-202611-0009', remaining: 1234 }]],
  ['PO-202611-0009 has more.1,234 pcs to come.', [{ orderNumber: 'PO-202611-0009', remaining: 234 }]], ['Cover is approx.5 days.', [{ sku: '22178', coverDays: 5 }]], ['Bin No.5 holds 22178.', [{ sku: '22178', onHand: 21 }]],
  ['PO-202611-0009 is due Nov.21.', [{ orderNumber: 'PO-202611-0009', promisedDate: '2026-11-21' }]], ['PO-202611-0009 is due Sept.30.', [{ orderNumber: 'PO-202611-0009', promisedDate: '2026-09-30' }]],
  ['Ships from the U.K.5 pallets left.', [{ sku: '22178', onHand: 21 }]], ['Tape, boxes etc.5 lines open.', [{ sku: '22178', onHand: 21 }]], ['Total: 5.3 days of cover.', [{ sku: '22178', coverDays: 5.3 }]],
  ['Plan v2.5 has 21 units.', [{ sku: '22178', onHand: 21 }]], ['Cut-off at 9.30 for 21 units.', [{ sku: '22178', onHand: 21 }]], ['Cover is 7.5.', [{ sku: '22178', coverDays: 7.5 }]], ['Cover is 7.6.', [{ sku: '22178', coverDays: 7.5 }]],
]
// The review's correct answers: none gains a problem.
const CORRECT_RESULTS = [
  { items: [
    { sku: '21137', itemName: 'Black Record Cover Frame', onHand: 12, safetyStock: 40, supplier: 'Supplier of 21xxx codes (assumed)' }, { sku: '21498', itemName: 'Red Retrospot Wrap', onHand: 15, safetyStock: 30, supplier: 'Acme Home Goods' },
    { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', onHand: 48, safetyStock: 60, supplier: 'Supplier of 85xxx codes (assumed)' },
  ] },
  { rows: [
    { orderNumber: 'PO-202611-0009', supplier: 'Supplier of 85xxx codes (assumed)', remaining: 240, overdueDays: 6, promisedDate: '2026-11-16', ref: ref('purchase_order', 'UCI-PO-338', 'PO-202611-0009') },
    { orderNumber: 'PO-202611-0012', supplier: '2Go Packaging', remaining: 360, overdueDays: 8, promisedDate: '2026-11-14', ref: ref('purchase_order', 'UCI-PO-340', 'PO-202611-0012') },
    { orderNumber: 'PO-202611-0015', supplier: 'Acme Home Goods', remaining: 120, overdueDays: 0, promisedDate: '2026-11-21', ref: ref('purchase_order', 'UCI-PO-342', 'PO-202611-0015') },
  ] },
]
const CORRECT = [
  ...['2 suppliers have late orders: Supplier of 85xxx codes and 2Go Packaging.', '2 late orders: PO-202611-0009 (Supplier of 85xxx codes, 240 pcs) and PO-202611-0012 (2Go Packaging, 360 pcs).',
    '2 items from Supplier of 21xxx codes are below safety stock: 21137 and 21498.', '3 items are below safety stock: 21137 (Black Record Cover Frame), 21498 (Red Retrospot Wrap) and 85123A (White Hanging Heart T-Light Holder).',
    'Below safety stock (3): 21137, 21498, 85123A.', '2 late orders:\n- PO-202611-0009, 6 days late\n- PO-202611-0012, 8 days late', 'There are 2 late orders: PO-202611-0009 and PO-202611-0012, both from different suppliers.',
    '2 order lines are late: 21137 and 21498.', '2 open purchase order lines for 85123A: PO-202611-0009 and PO-202611-0015.', "2 suppliers' orders are late: PO-202611-0009 and PO-202611-0012.", '2 suppliers are behind (PO-202611-0009 and PO-202611-0012).',
    '有 2 张逾期订单：PO-202611-0009（240 件）和 PO-202611-0012（360 件）。', '3 个物料低于安全库存：21137、21498、85123A。', '2 家供应商有逾期订单：Supplier of 85xxx codes、2Go Packaging。', '共 2 笔逾期采购：PO-202611-0009、PO-202611-0012。',
    '共 2 笔逾期采购：2Go Packaging 和 Supplier of 85xxx codes。', '2 条采购订单行逾期：21137、21498。', '2 条逾期订单：PO-202611-0009、PO-202611-0012。', '2 个供应商：2Go Packaging、Acme Home Goods。', '以下 2 项需要处理：PO-202611-0009、21137。',
    'PO-202611-0015 is due on 21 November.', 'PO-202611-0015 is due November 21 (Acme Home Goods).', 'Due November 21: PO-202611-0015 (Acme Home Goods).', 'PO-202611-0015 (Acme Home Goods) – 21 Nov, 120 pcs.', '21 Nov PO-202611-0015 arrives with 120 pcs.',
    'November 21 PO-202611-0015 arrives.', 'PO-202611-0015, 21 Nov 2026.', 'PO-202611-0015 2026-11-21 到货。', 'PO-202611-0015（Acme Home Goods）11月21日到货。', 'PO-202611-0015 预计 11 月 21 日到货。', '11 月 Acme Home Goods 21 日交货（PO-202611-0015）。',
    'Nov. 21 for PO-202611-0015.', 'Acme Home Goods promised Nov.21 for PO-202611-0015.', 'In November PO-202611-0015 arrives on the 21st.', 'November: PO-202611-0015 arrives 21 Nov.', 'PO-202611-0015 Nov 21, PO-202611-0009 Nov 16.',
    'PO-202611-0009 was promised for 16 Nov and is 6 days late.', 'Promised dates: 14 Nov (PO-202611-0012), 16 Nov (PO-202611-0009) and 21 Nov (PO-202611-0015).', 'Promised 14–21 November across PO-202611-0012 and PO-202611-0015.',
    'PO-202611-0009 has 240 pcs to come.6 days late.', 'It is approx.8 days late.', 'See Fig.2 below.', 'Plan v2.1 keeps 240 pcs on order.', 'Order by Thu.21 Nov.'].map((answer) => [answer, { results: CORRECT_RESULTS, facts: FACTS }]),
  ['PO-202611-0015 on 11/21.', { results: CORRECT_RESULTS, facts: FACTS, locale: 'en-US' }], ['Total: 5.3 days.', { results: [{ coverDays: 5.3 }], facts: FACTS }],
  ['Order No.12 is open.', { results: [{ orderNumber: 'PO-202611-0012', remaining: 360 }], facts: FACTS }], ['Lead time is approx.5 days.', { results: [{ leadTimeDays: 5 }], facts: FACTS }],
]

test('the strict pass never drops a problem: every probe line of the #455 review', () => {
  for (const answer of [...COUNTS, ...DATES, ...DOTS]) {
    added(answer, { results: RESULTS, facts: FACTS })
    added(answer, { results: LIST, facts: FACTS })
  }
  for (const answer of COUNTS) for (const facts of [null, { suppliers: FACTS.suppliers }]) added(answer, { results: LIST, facts })
  for (const [answer, results] of CHOSEN) added(answer, { results, facts: FACTS })
})

test('the strict pass adds nothing to the #455 review\'s correct answers', () => {
  for (const [answer, fixture] of CORRECT) assert.deepEqual(added(answer, fixture), [], answer)
})
