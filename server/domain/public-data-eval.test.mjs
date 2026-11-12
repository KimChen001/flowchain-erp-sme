// The public-data instance (scripts/public-data-instance.mjs) and the assistant
// v2 evaluation built on it (tests/ai-eval/v2-public): the assumption rules,
// the expected figures and the scoring, on made-up data so no data file is
// needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publicDataItem, readPublicDataInstance, readPublicDataInstances } from '../../scripts/public-data-instance.mjs'
import { buildCases, inventoryWorth, itemEconomics, readReference } from '../../tests/ai-eval/v2-public/cases.mjs'
import { answerLanguage, dateForms, englishRun, numbersIn, repeatedPart, scoreAnswer, tidyProblems } from '../../tests/ai-eval/v2-public/score.mjs'
import { uciEconomics, uciFacts } from '../../tests/ai-eval/v2-public/uci-facts.mjs'
import { buildUciCases, lastWholeMonths } from '../../tests/ai-eval/v2-public/uci-cases.mjs'

// 90 days averaging 54.49 a day, as FOODS_3_090 does in the M5 window.
const steadyDaily = Array.from({ length: 90 }, (_, index) => (index < 44 ? 54 : 55))
steadyDaily[0] += 4904 - steadyDaily.reduce((total, value) => total + value, 0)

test('an item\'s assumptions follow the research rules: a week\'s MOQ, the lead time on hand, lead + review as reorder point', () => {
  const item = publicDataItem({ sku: 'FOODS_3_090', name: 'x', price: 1.6, daily: steadyDaily, category: 'FOODS_3' })
  assert.equal(item.units, 4904)
  assert.equal(Math.round(item.averageDailyDemand * 100) / 100, 54.49)
  // The research table for FOODS_3_090: MOQ 390, on hand 763, reorder point 1,144.
  assert.deepEqual([item.minimumOrderQuantity, item.onHand, item.reorderPoint, item.safetyStock, item.leadTimeDays], [390, 763, 1144, 381, 14])
  const slow = publicDataItem({ sku: 'S', name: 's', price: 1, daily: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], category: 'c' })
  assert.equal(slow.minimumOrderQuantity, 10, 'never below 10')
  assert.equal(slow.saleDays, 1)
})

test('the expected figures: break-even cost per order, EOQ, days of stock, what stock is worth', () => {
  const item = publicDataItem({ sku: 'FOODS_3_090', name: 'x', price: 1.6, daily: steadyDaily, category: 'FOODS_3' })
  const economics = itemEconomics(item)
  // 25% a year of $1.60 is $0.40; 54.49 a day is 19,889 a year.
  assert.equal(Math.round(economics.holding * 100) / 100, 0.4)
  assert.equal(Math.round(economics.breakEven(400, 800) * 100) / 100, 3.22)
  assert.equal(economics.eoq(50), Math.round(Math.sqrt((2 * 4904 / 90 * 365 * 50) / 0.4)))
  assert.equal(economics.eoq(0.01), 390, 'never below the minimum order')
  assert.equal(Math.round(economics.daysOfStock), 14)
  assert.deepEqual(inventoryWorth([{ onHand: 10, price: 2 }, { onHand: 5, price: 1.5 }]), { value: 27.5, holdingPerYear: 6.88 })
})

function writeExtracts(directory) {
  mkdirSync(join(directory, 'm5'), { recursive: true })
  const set = (prefix, price) => ({ items: [0, 1].map((n) => ({ item_id: `${prefix}_${n}`, daily: steadyDaily.map((value) => value + n), price })) })
  writeFileSync(join(directory, 'm5', 'extract.json'), JSON.stringify({ store: 'CA_1', window: { first_date: '2016-02-23', last_date: '2016-05-22' }, sets: { m5_main: set('FOODS_3', 1.6), m5_intermittent: set('HOUSEHOLD_1', 9.97) } }))
  writeFileSync(join(directory, 'uci-extract.json'), JSON.stringify({ days: ['2011-09-02', '2011-11-30'], items: [{ code: '22197', name: 'POPCORN HOLDER', price: 0.85, daily: steadyDaily }] }))
}

test('the extracts read as instances, with the set\'s currency and window; a wrong set is refused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flowchain-public-data-'))
  try {
    writeExtracts(directory)
    const [main, uci] = readPublicDataInstances(directory, 'm5_main,uci')
    assert.deepEqual([main.set, main.currency, main.window, main.days, main.items.map((item) => item.sku)], ['m5_main', 'USD', { first: '2016-02-23', last: '2016-05-22' }, 90, ['FOODS_3_0', 'FOODS_3_1']])
    assert.deepEqual([uci.currency, uci.items[0].sku, uci.items[0].name], ['GBP', 'UCI-22197', 'Popcorn Holder'])
    assert.throws(() => readPublicDataInstance(join(directory, 'm5', 'extract.json'), 'm6'), /Unknown public data set/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the cases carry their expected figures; the decision cases come only with the research reference', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flowchain-public-data-'))
  try {
    writeExtracts(directory)
    const instances = Object.fromEntries(readPublicDataInstances(directory, 'm5_main,m5_intermittent').map((instance) => [instance.set, instance]))
    // The real case names name real SKUs; these made-up sets reuse the shape.
    instances.m5_main.items[0].sku = 'FOODS_3_090'
    instances.m5_main.items[1].sku = 'FOODS_3_501'
    instances.m5_main.items.push({ ...instances.m5_main.items[1], sku: 'FOODS_3_120' })
    instances.m5_intermittent.items[0].sku = 'HOUSEHOLD_1_272'
    const without = buildCases(instances)
    assert.ok(!without.some((row) => row.kind === 'decision'))
    const ids = without.map((row) => row.id)
    assert.ok(['avg-demand-en', 'avg-demand-zh', 'quantity-tradeoff', 'eoq', 'inventory-worth-zh', 'reorder-then-quantity'].every((id) => ids.includes(id)))
    assert.deepEqual(without.find((row) => row.id === 'quantity-tradeoff').expect.numbers[0], { label: 'break-even cost per order', value: 3.22, tolerance: 0.05 })
    const reference = readReference({ instances: { m5_main: { B: 2660, q_star: [390, 0, 261], unbudgeted: { q: [457, 324, 297] } }, m5_intermittent: { B: 600, q_star: [44, 23], unbudgeted: { q: [81, 32] } } } })
    const decision = buildCases(instances, reference).find((row) => row.id === 'plan-budget-steady')
    assert.match(decision.turns[0], /\$2,660/)
    assert.deepEqual(decision.expect.quantities.map((row) => [row.sku, row.quantity]), [['FOODS_3_090', 390], ['FOODS_3_501', 0], ['FOODS_3_120', 261]])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('scoring: figures within tolerance, SKUs named, quantities by their SKU, the form, the language and flags', () => {
  assert.deepEqual(numbersIn('$2,659.94 for 1,144 units, then 3.2'), [2659.94, 1144, 3.2])
  assert.equal(answerLanguage('库存价值约 $1,234。'), 'zh-CN')
  assert.equal(answerLanguage('Your stock is worth $1,234.'), 'en-US')
  const answer = { status: 200, text: 'It pays off above about $3.22 an order.\n- FOODS_3_090: 390 units', ui: [{ component: 'table', props: { rows: [{ sku: 'FOODS_3_252', quantity: 261 }] } }], flags: [], errors: [] }
  const good = scoreAnswer(answer, { numbers: [{ label: 'break-even', value: 3.22, tolerance: 0.05 }], quantities: [{ sku: 'FOODS_3_090', quantity: 390 }, { sku: 'FOODS_3_252', quantity: 261 }, { sku: 'FOODS_3_586', quantity: 0 }], skus: ['FOODS_3_090', 'FOODS_3_252'] })
  assert.equal(good.pass, true, JSON.stringify(good.checks))
  const wrong = scoreAnswer({ ...answer, text: 'About $3.40 an order.' }, { numbers: [{ label: 'break-even', value: 3.22, tolerance: 0.05 }] })
  assert.equal(wrong.checks.find((check) => check.name === 'number: break-even').ok, false)
  assert.equal(scoreAnswer({ ...answer, flags: ['number:6'] }, {}).pass, false, 'a flagged figure fails')
  assert.equal(scoreAnswer(answer, {}, { language: 'zh-CN' }).checks.find((check) => check.name === 'language').ok, false)
  const form = { status: 200, text: 'I have filled in the form.', ui: [{ component: 'pr_form', props: { lines: [{ item: { sku: 'FOODS_3_090' }, quantity: 400 }] } }], flags: [], errors: [] }
  assert.equal(scoreAnswer(form, { form: { sku: 'FOODS_3_090', quantity: 400 } }).pass, true)
  assert.equal(scoreAnswer(form, { form: { sku: 'FOODS_3_090', quantity: 500 } }).pass, false)
  // Agreeing to an earlier answer: the quantity it gave the item counts.
  const agreed = { ...form, ui: [{ component: 'pr_form', props: { lines: [{ item: { sku: 'FOODS_3_090' }, suggestedQuantity: { value: 450 }, checked: true }] } }] }
  const earlier = { text: 'Order FOODS_3_090 at 450 units, the planner quantity.' }
  assert.equal(scoreAnswer(agreed, { form: { sku: 'FOODS_3_090', quantity: 400, orSaidEarlier: true } }, { answers: [earlier, agreed] }).pass, true)
  assert.equal(scoreAnswer(agreed, { form: { sku: 'FOODS_3_090', quantity: 400 } }, { answers: [earlier, agreed] }).pass, false)
  assert.equal(scoreAnswer(agreed, { form: { sku: 'FOODS_3_090', quantity: 400, orSaidEarlier: true } }, { answers: [{ text: 'Order FOODS_3_090.' }, agreed] }).pass, false)
})

test('scoring: names or SKUs, dates in their usual forms, refusals, any of several figures, and tidy text', () => {
  assert.deepEqual(numbersIn('约 7.9 万英镑, £75.6k, 12 kg'), [7.9, 79000, 75.6, 75600, 12])
  const date = (text) => dateForms('2026-11-04').some((form) => form.test(text))
  for (const text of ['on 2026-11-04', 'on Nov 4, 2026', 'on 4 November', 'on 04/11/2026', '于 2026 年 11 月 4 日']) assert.equal(date(text), true, text)
  for (const text of ['on Nov 14', 'on 14 Nov', '11 月 14 日', '2026-11-14']) assert.equal(date(text), false, text)
  assert.deepEqual(tidyProblems('About 7.1556 a day.'), ['raw decimal 7.1556'])
  assert.deepEqual(tidyProblems('预计 10 月 1, 2026 到货。'), ['date written as 10 月 1, 2026'])
  assert.equal(tidyProblems('Let me check the stock.\n48 on hand.').length, 1)
  assert.equal(tidyProblems('让我查一下。').length, 1)
  assert.deepEqual(tidyProblems('**85123A** has 48 on hand at £2.95, about 2.8 days.'), [])
  const answer = { status: 200, text: 'Globex Party Supplies supplies it. I cannot delete orders here.', ui: [], flags: [], errors: [] }
  const scored = scoreAnswer(answer, { mentions: [{ label: 'Globex', any: ['globex party supplies'] }], refuses: true, numbers: [{ label: 'either', anyOf: [7, 9], tolerance: 0 }] })
  assert.deepEqual(scored.checks.filter((check) => !check.ok).map((check) => check.name), ['number: either'])
  assert.equal(scoreAnswer({ ...answer, text: 'Done: deleted 3 orders.' }, { refuses: true }).pass, false)
  assert.equal(scoreAnswer({ ...answer, text: 'Let me look. 48 on hand.' }, {}).checks.find((check) => check.name === 'tidy').ok, false)
  assert.equal(scoreAnswer({ ...answer, text: 'Let me look. 48 on hand.' }, { tidy: false }).pass, true)
  // A part after the table that says the first part again (2026-11-09 on
  // DeepSeek V4.1 Flash), against one that goes on to something new.
  const first = 'Your total sales in October 2026 were £75,552.67, from 564 customer invoices before tax. Credit notes are not subtracted from that figure.\n\nThe largest customer was Customer 14096 (United Kingdom) with £7,508.14 (9.9%); the top five customers together came to 25.5% of the month.'
  const again = 'Your October 2026 sales came to £75,552.67 across 564 customer invoices, before tax, counted from invoice dates and leaving out drafts and cancelled invoices. Credit notes aren\'t subtracted.\n\nThe table shows the ten largest customers. Customer 14096 (United Kingdom) leads with £7,508.14 (9.9%), and the top five customers together account for 25.5% of the month.'
  const next = 'September was lower at £58,157.91 on 367 invoices, so October rose by about 30%. The rise came mostly from Christmas lines: paper chain kits, the rabbit night light and the chilli lights each sold two to three times their September units, while the T-light holders stayed flat.'
  assert.ok(repeatedPart([first, again]))
  assert.equal(repeatedPart([first, next]), null)
  assert.equal(repeatedPart([first, 'I\'ve answered what 85123A is, and the next steps are there if you want to go further.']), null, 'a short closing line is not a repeat')
  assert.match(scoreAnswer({ ...answer, text: `${first}\n${again}`, textParts: [first, again] }, {}).checks.find((check) => check.name === 'tidy').detail, /repeats an earlier paragraph/)
})

test('scoring conversations: cards shown or left out, form lines and ticks, links, wording, each turn\'s language, chips and English prose', () => {
  const row = (sku, quantity, checked) => ({ item: { id: `I-${sku}`, sku, name: sku }, suggestedQuantity: { value: quantity, source: 'user_named' }, checked })
  const answer = { status: 200, text: '已为 22423 填好表单，Acme 的 PO-202610-0022 已逾期。', textParts: ['已为 22423 填好表单，Acme 的 PO-202610-0022 已逾期。'], flags: [], errors: [],
    ui: [{ component: 'pr_form', props: { lines: [row('22423', 100, true)], suggested: [row('84879', 150, false)] } }, { component: 'followups', props: { questions: ['查看 84879 的库存', 'Show Acme orders'] } }],
    refs: [{ type: 'purchase_order', id: 'UCI-PO-1', label: 'PO-202610-0022' }, { type: 'supplier', id: 'SUP-85', label: 'Acme Home Goods' }] }
  const failed = (expect, options = { language: 'zh-CN' }) => scoreAnswer(answer, expect, options).checks.filter((check) => !check.ok).map((check) => check.name)
  assert.deepEqual(failed({}), ['chips language'], 'an English chip in a Chinese answer')
  assert.deepEqual(failed({ ui: { has: ['pr_form'], hasNot: ['record_actions'] } }).filter((name) => name !== 'chips language'), [])
  assert.deepEqual(failed({ ui: { has: ['table'], hasNot: ['pr_form'] } }).filter((name) => name !== 'chips language'), ['shows table', 'no pr_form'])
  assert.deepEqual(failed({ formLines: [{ sku: '22423', quantity: 100, checked: true }, { sku: '84879', quantity: 150, checked: false }] }).filter((name) => name !== 'chips language'), [])
  assert.deepEqual(failed({ formLines: [{ sku: '22423', quantity: 120 }], formNoneChecked: true }).filter((name) => name !== 'chips language'), ['form line: 22423', 'no line ticked'])
  assert.deepEqual(failed({ refs: [{ type: 'purchase_order' }, { type: 'supplier', label: 'acme' }, { type: 'item' }] }).filter((name) => name !== 'chips language'), ['links item'])
  assert.deepEqual(failed({ matches: [{ label: 'late', pattern: '逾期' }], notMatches: [{ label: 'a phone', pattern: String.raw`\(\d{3}\) \d{3}-\d{4}` }] }).filter((name) => name !== 'chips language'), [])
  assert.deepEqual(failed({ notMatches: [{ label: 'a PO', pattern: 'PO-\\d+' }] }).filter((name) => name !== 'chips language'), ['not: a PO'])
  // Each turn's language, and English prose in a Chinese answer.
  const turns = [{ text: 'You should reorder 22423 this week.' }, answer]
  assert.deepEqual(failed({ languages: ['en-US', 'zh-CN'] }, { language: 'zh-CN', answers: turns }).filter((name) => name !== 'chips language'), [])
  assert.deepEqual(failed({ languages: ['zh-CN', 'zh-CN'] }, { language: 'zh-CN', answers: turns }).filter((name) => name !== 'chips language'), ['turn 1 language'])
  assert.equal(englishRun('PO-202610-0022 的 White Hanging Heart T-Light Holder 已逾期。'), null, 'a record name is not prose')
  assert.match(englishRun('这一单 is overdue and you should chase the supplier for a firm date today。'), /is overdue and you should chase/)
})

// A small plan in the shape buildPublicDataPlan returns: seeded as of
// 2026-11-10 over 70 days, so index 0 is 2026-09-01, 30 is 2026-10-01 and 69
// is 2026-11-09.
function smallPlan() {
  const item = (key, name, price, supplierKey, meanDaily, safetyStock, reorderPoint, minimumOrderQuantity) => ({ key, sku: key, name, price, supplierKey, meanDaily, safetyStock, reorderPoint, minimumOrderQuantity })
  const order = (supplierKey, created, promised, lines, receipts = [], status = 'issued', scene) => ({ supplierKey, created, promised, status, scene, lines: lines.map(([itemKey, quantity]) => ({ itemKey, quantity })), receipts: receipts.map(([index, itemKey, quantity]) => ({ index, lines: [{ itemKey, quantity }] })) })
  return {
    seedDay: '2026-11-10',
    days: 70,
    items: [
      item('H1', 'Hero Lamp', 2, 'A', 10, 70, 210, 70),
      item('S1', 'Second Bird', 1, 'G', 5, 35, 105, 40),
      item('C1', 'Cake Stand', 10, 'X', 2, 14, 42, 20),
      item('P1', 'Pending Sign', 3, 'A', 1, 7, 21, 10),
    ],
    suppliers: [{ key: 'A', name: 'Acme Home Goods', tier: 1 }, { key: 'G', name: 'Globex Party Supplies' }, { key: 'X', name: 'Supplier of other codes (assumed)' }],
    customers: [{ key: 'c1', name: 'Customer c1 (United Kingdom)' }, { key: 'c2', name: 'Customer c2 (France)' }],
    salesOrders: [
      { index: 5, customerKey: 'c1', lines: [{ itemKey: 'H1', quantity: 10, unitPrice: 2.5 }, { itemKey: 'S1', quantity: 4, unitPrice: 1.2 }] },
      { index: 40, customerKey: 'c2', lines: [{ itemKey: 'H1', quantity: 20, unitPrice: 2.5 }] },
      { index: 45, customerKey: 'c1', lines: [{ itemKey: 'C1', quantity: 3, unitPrice: 12 }] },
      { index: 65, customerKey: 'c1', lines: [{ itemKey: 'S1', quantity: 2, unitPrice: 1.2 }] },
    ],
    purchasing: {
      closing: { H1: 30, S1: 20, C1: 40, P1: 15 },
      orders: [
        order('A', 20, 34, [['H1', 100]], [[36, 'H1', 100]]),
        order('A', 27, 41, [['H1', 100]], [[41, 'H1', 100]]),
        order('G', 30, 44, [['S1', 50]], [[44, 'S1', 50]]),
        order('A', 50, 64, [['H1', 140]], [[64, 'H1', 70]], 'issued', 'hero_partly_received'),
        order('G', 51, 65, [['S1', 90]], [], 'issued', 'second_supplier_late'),
        order('A', 52, 66, [['H1', 140]], [], 'issued', 'hero_nothing_received'),
        order('A', 69, 83, [['P1', 10]], [], 'pending_approval', 'waiting_for_approval'),
      ],
    },
    scene: { hero: { sku: 'H1' }, second: { sku: 'S1' }, reorder: { sku: 'C1' } },
  }
}

test('the UCI figures: stock and position, late orders, the reorder rule, months, receivables, on-time deliveries', () => {
  const facts = uciFacts(smallPlan())
  assert.deepEqual(['onHand', 'onOrder', 'position', 'supplier'].map((key) => facts.item('H1')[key]), [30, 210, 240, 'Acme Home Goods'])
  assert.deepEqual(facts.late.map((row) => [row.supplier, row.promised, row.lines[0].outstanding]), [['Acme Home Goods', '2026-11-04', 70], ['Globex Party Supplies', '2026-11-05', 90], ['Acme Home Goods', '2026-11-06', 140]])
  // C1 ends 2 under its reorder point: its minimum order. P1's order waits for
  // approval, so it is not on order.
  assert.deepEqual(facts.reorder, [{ sku: 'C1', shortfall: 2, quantity: 20 }, { sku: 'P1', shortfall: 6, quantity: 10 }])
  assert.deepEqual(facts.belowSafetyStock, ['H1', 'S1'])
  const october = facts.month('2026-10')
  assert.deepEqual([october.orders, october.units, october.revenue, october.byUnits[0].sku, october.customers[0].id, october.customers[0].topItem], [2, 23, 86, 'H1', 'c2', { sku: 'H1', units: 20 }])
  assert.equal(facts.month('2026-09').revenue, 29.8)
  // Invoices are due 30 days after shipping; those due from the seed day on are open.
  assert.deepEqual([facts.receivables.invoices, facts.receivables.total, facts.receivables.largest.id], [3, 88.4, 'c2'])
  assert.deepEqual(facts.inventory, { value: 525, holdingPerYear: 131.25 })
  // Acme: one late receipt, one on time, the partly received order on time on
  // its first receipt, the order with nothing received late; the order
  // waiting for approval is not judged.
  assert.deepEqual(facts.onTime('Acme Home Goods'), { judged: 4, onTime: 2, percent: 50 })
  assert.deepEqual(facts.lastReceipt('H1'), { date: '2026-11-04', quantity: 70 })
  assert.deepEqual(facts.waitingForApproval, [{ supplier: 'Acme Home Goods', lines: [{ sku: 'P1', quantity: 10, amount: 30 }] }])
  assert.equal(uciEconomics({ averageDailyDemand: 10, price: 2, minimumOrderQuantity: 70 }).eoq(20), Math.round(Math.sqrt((2 * 3650 * 20) / 0.5)))
  // A server running before its seed day: only the orders promised before then are late.
  assert.equal(uciFacts(smallPlan(), { today: '2026-11-05' }).late.length, 1)
  // The average daily demand is over the 90 days before the day asked, as the
  // tools read it (days with no data count as none shipped): asked on
  // 2026-11-01, the last 9 days of these 70 fall outside it.
  const shipped = smallPlan()
  shipped.items[0].daily = Array.from({ length: 70 }, (_, index) => (index === 0 ? 90 : 9))
  assert.equal(uciFacts(shipped).item('H1').averageDailyDemand, (90 + 69 * 9) / 90)
  assert.equal(uciFacts(shipped, { today: '2026-11-01' }).item('H1').averageDailyDemand, (90 + 60 * 9) / 90)
})

// 2026-11-11, the owner's "先测再改" on hard limits.
test('scoring constraints: the form within the budget, at or above each minimum, only the items allowed, and a form it claims is shown', () => {
  const form = (lines) => ({ component: 'pr_form', props: { lines, suggested: [] } })
  const row = (sku, quantity, checked = true) => ({ item: { sku }, suggestedQuantity: { value: quantity }, checked })
  const rules = { budget: 100, prices: { A: 2, B: 5 }, minimums: { A: 20, B: 10 }, onlySkus: ['A', 'B'], notSkus: ['B'] }
  const failed = (ui, text = 'Done.') => scoreAnswer({ status: 200, text, ui, flags: [] }, { formRules: rules }).checks.filter((check) => !check.ok).map((check) => check.name)
  assert.deepEqual(failed([form([row('A', 20)])]), [])
  assert.deepEqual(failed([form([row('A', 60)])]), ['form within budget'])
  assert.deepEqual(failed([form([row('A', 10)])]), ['form at or above minimums'])
  assert.deepEqual(failed([form([row('B', 10)])]), ['form leaves out'])
  assert.deepEqual(failed([form([row('C', 1)])]), ['form within budget', 'form only allowed items'])
  // An unticked line is the user's to choose.
  assert.deepEqual(failed([form([row('A', 500, false)])]), [])
  // A form the text says it filled in: shown on this answer or an earlier one.
  assert.deepEqual(failed([], "I've filled in a purchase request form for you to review."), ['form it speaks of is shown'])
  const earlier = { status: 200, text: 'Here.', ui: [form([row('A', 20)])], flags: [] }
  const later = { status: 200, text: "I've filled in a purchase request form for you to review.", ui: [], flags: [] }
  assert.ok(scoreAnswer(later, {}, { answers: [earlier, later] }).pass)
  // The cases: eight, the figures from the plan.
  const facts = uciFacts(smallPlan())
  const cases = buildUciCases(facts).filter((entry) => entry.kind === 'constraints')
  assert.equal(cases.length, 8)
  const expect = (id) => cases.find((entry) => entry.id === id).expect
  assert.deepEqual(expect('minimum-multiple-en').numbers.map((entry) => entry.value), [3 * facts.item('C1').minimumOrderQuantity, 3 * facts.item('C1').minimumOrderQuantity * facts.item('C1').price])
  assert.deepEqual(expect('budget-quantity-en').formLines, [{ sku: 'C1', quantity: Math.floor(1000 / facts.item('C1').price), checked: true }])
  assert.deepEqual(expect('supplier-only-en').formRules.onlySkus, ['H1', 'P1'])
})

test('the UCI question set: every case in English or Chinese, on fixed months, with the scene figures', () => {
  const cases = buildUciCases(uciFacts(smallPlan()))
  const ids = cases.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.ok(cases.length >= 50)
  assert.ok(cases.filter((row) => row.language === 'zh-CN').length >= 20)
  assert.deepEqual(lastWholeMonths('2026-01-15'), { last: { key: '2025-12', en: 'December 2025', zh: '2025 年 12 月' }, before: { key: '2025-11', en: 'November 2025', zh: '2025 年 11 月' } })
  const expect = (id) => cases.find((row) => row.id === id).expect
  assert.equal(expect('none-arrive-zh').numbers[0].value, 30)
  assert.equal(expect('only-partly-en').numbers[0].value, 100)
  assert.equal(expect('only-nothing-zh').numbers[0].value, 170)
  assert.equal(expect('both-arrive-en').numbers[0].value, 240)
  assert.deepEqual(expect('reorder-en').quantities, [{ sku: 'C1', quantity: 20 }])
  assert.equal(expect('month-compare-zh').numbers[2].value, 188.6)
  assert.match(cases.find((row) => row.id === 'hero-month-units-en').turns[0], /October 2026/)
  assert.match(cases.find((row) => row.id === 'month-compare-zh').turns[0], /2026 年 10 月的销售额和 9 月/)
})

// 2026-11-12, the owner: "一次性对话出来就是太多了". Each answer's length is
// reported against a budget (a Chinese character counts twice), a lookup's
// smaller; it never fails the case.
test('scoring length: concise within the budget, a lookup held tighter, never failing the case', async () => {
  const { LENGTH_BUDGET, answerLength } = await import('../../tests/ai-eval/v2-public/score.mjs')
  assert.equal(answerLength('ab'), 2)
  assert.equal(answerLength('库存 48'), 7)
  const answer = (text) => ({ status: 200, text, ui: [], flags: [], errors: [] })
  const concise = (text, expect = {}) => scoreAnswer(answer(text), expect).checks.find((check) => check.name === 'concise')
  assert.equal(concise('x'.repeat(LENGTH_BUDGET.other)).ok, true)
  const long = scoreAnswer(answer('x'.repeat(LENGTH_BUDGET.other + 1)), {})
  assert.deepEqual([long.pass, long.checks.find((check) => check.name === 'concise').ok], [true, false])
  assert.equal(concise('x'.repeat(LENGTH_BUDGET.brief + 1), { brief: true }).ok, false)
  assert.match(concise('x', { brief: true }).detail, /lookup/)
  assert.equal(concise('库'.repeat(LENGTH_BUDGET.brief / 2), { brief: true }).ok, true)
  assert.equal(concise('库'.repeat(LENGTH_BUDGET.brief / 2 + 1), { brief: true }).ok, false)
  assert.equal(concise('x', { length: false }), undefined)
  // The lookups of the UCI set carry brief.
  const { UCI_LOOKUPS } = await import('../../tests/ai-eval/v2-public/uci-cases.mjs')
  assert.ok(UCI_LOOKUPS.has('hero-on-hand-en') && !UCI_LOOKUPS.has('reorder-en'))
})

// 2026-11-12: a plan question answered without the solver fails the case.
test('scoring calls: the tools a case must call, and the UCI cases that need them', async () => {
  const answer = { status: 200, text: 'Order 78.', ui: [], flags: [], errors: [], tools: ['calculate', 'suggest_purchase_request'] }
  const result = scoreAnswer(answer, { calls: ['optimize_order_plan'] })
  assert.equal(result.pass, false)
  assert.equal(result.checks.find((check) => check.name === 'calls optimize_order_plan').detail, 'calculate, suggest_purchase_request')
  assert.equal(scoreAnswer({ ...answer, tools: ['optimize_order_plan'] }, { calls: ['optimize_order_plan'] }).pass, true)
  const { UCI_REQUIRED_TOOLS } = await import('../../tests/ai-eval/v2-public/uci-cases.mjs')
  assert.deepEqual(UCI_REQUIRED_TOOLS['budget-quantity-en'], ['optimize_order_plan'])
  assert.deepEqual(UCI_REQUIRED_TOOLS['hero-eoq-en'], ['order_quantity_costs'])
})

// 2026-11-12: "22423 …缺口 20 件；但……建议按 60 件下单。" names its quantity in
// the next clause of the same sentence.
test('scoring quantities: a quantity counts anywhere in its SKU\'s sentence, not across a full stop', () => {
  const answer = (text) => ({ status: 200, text, ui: [], flags: [], errors: [] })
  const ok = (text) => scoreAnswer(answer(text), { quantities: [{ sku: '22423', quantity: 60 }] }).checks.find((check) => check.name === 'quantity: 22423').ok
  assert.equal(ok('只有 1 个物料：22423 缺口 20 件；但最小起订量为 60 件，所以建议按 60 件下单。'), true)
  assert.equal(ok('Order 22423 now; the minimum is 60 pcs at £12.75.'), true)
  assert.equal(ok('Order 22423 now. The minimum of another item is 60 pcs.'), false)
  assert.equal(ok('22423 需要补货。另一个物料要 60 件。'), false)
})
