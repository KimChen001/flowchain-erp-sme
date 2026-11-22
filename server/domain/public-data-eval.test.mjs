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
import { answerLanguage, countWordsIn, dateForms, englishRun, numbersIn, repeatedPart, scoreAnswer, tidyProblems } from '../../tests/ai-eval/v2-public/score.mjs'
import { uciEconomics, uciFacts } from '../../tests/ai-eval/v2-public/uci-facts.mjs'
import { buildUciCases, lastWholeMonths } from '../../tests/ai-eval/v2-public/uci-cases.mjs'
import { NO_DIFFERENCE_EN, NO_DIFFERENCE_ZH } from '../../tests/ai-eval/v2-public/uci-money-cases.mjs'
import { WALKTHROUGH_DEMO_PORTS, setupRefusal } from '../../tests/ai-eval/v2-public/setup-guard.mjs'

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
  // C1 ends 2 under its reorder point: it orders up to 42 + 7 days of 2 = 56,
  // 16, raised to its minimum of 20. P1's order waiting for approval is not on
  // order, but is in the reorder list's position (design audit C2): 15 + 10 =
  // 25 against 21, 4 days of demand above it, so it is not listed.
  assert.deepEqual(facts.reorder, [{ sku: 'C1', shortfall: 2, orderUpTo: 56, quantity: 20 }])
  assert.equal(facts.item('P1').onOrder, 0)
  // Further below, up to the level (design audit C3): 30 on hand asks for 26.
  // Less than a day of demand above the reorder point is due today: S1 at
  // 20 + 90 = 110 against 105 is a day above (not due); at 109 it is due and
  // orders up to 105 + 35 = 140: 31, raised to its minimum of 40.
  const lower = smallPlan()
  lower.purchasing.closing = { ...lower.purchasing.closing, C1: 30, S1: 19 }
  assert.deepEqual(uciFacts(lower).reorder, [{ sku: 'S1', shortfall: 0, orderUpTo: 140, quantity: 40 }, { sku: 'C1', shortfall: 12, orderUpTo: 56, quantity: 26 }])
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

// smallPlan with purchases at half the selling price and five supplier
// invoices in the shape planSupplierInvoices returns.
function smallPlanWithPayables() {
  const plan = smallPlan()
  plan.items = plan.items.map((row) => ({ ...row, purchasePrice: row.price / 2 }))
  const line = (itemKey, quantity, orderPricePence, unitPricePence = orderPricePence, received = quantity) => ({ itemKey, orderLine: 0, receiptLine: 0, quantity, received, orderPricePence, unitPricePence, amountPence: quantity * unitPricePence })
  const invoice = (number, supplierKey, day, rule, lines, payment) => {
    const totalPence = lines.reduce((total, row) => total + row.amountPence, 0)
    const differs = rule === 'price_above_order' || rule === 'short_delivery'
    return { number, supplierKey, day, due: day + 30, rule, match: differs ? 'exception' : 'matched', changedLine: differs ? 0 : null, lines, totalPence, total: totalPence / 100, payment, paidDay: payment === 'paid' ? day + 30 : null }
  }
  plan.payables = {
    invoices: [
      invoice('INV-A-0001', 'A', 36, 'as_ordered', [line('H1', 100, 100)], 'paid'),
      invoice('INV-A-0002', 'A', 30, 'as_ordered', [line('H1', 100, 100)], 'overdue'),
      invoice('INV-G-0001', 'G', 44, 'price_above_order', [line('S1', 50, 50, 52)], 'held'),
      invoice('INV-A-0003', 'A', 64, 'short_delivery', [line('H1', 74, 100, 100, 70)], 'held'),
      invoice('INV-A-0004', 'A', 45, 'dated_before_receipt', [line('P1', 10, 150)], 'open'),
    ],
    notYetInvoiced: [{ totalPence: 2500 }],
  }
  return plan
}

test('the UCI money figures: purchase price, gross profit, cash, supplier invoices and what is owed', () => {
  const facts = uciFacts(smallPlanWithPayables())
  // Stock, the order form and holding cost at the purchase price; the selling price beside it.
  assert.deepEqual([facts.item('C1').price, facts.item('C1').sellingPrice, facts.prices.C1], [5, 10, 5])
  assert.deepEqual(facts.inventory, { value: 262.5, holdingPerYear: 65.63 })
  assert.equal(facts.waitingForApproval[0].lines[0].amount, 15)
  // October: 86 of sales; 20 H1 at 1 and 3 C1 at 5 cost 35.
  const october = facts.month('2026-10')
  assert.deepEqual([october.revenue, october.cost, october.grossProfit, october.grossMarginPercent], [86, 35, 51, 59.3])
  // Customers paid October's due invoices (the 2026-09-06 order, 29.80); suppliers nothing until November.
  assert.deepEqual(facts.cash('2026-10'), { received: 29.8, paid: 0, net: 29.8 })
  const invoices = facts.supplierInvoices
  assert.deepEqual(invoices.match, { matched: 3, exception: 2, reviewed: 0 })
  // The short delivery bills 4 units more than received (4.00); the price difference 2p on 50 (1.00).
  assert.deepEqual(invoices.differences.map((row) => [row.number, row.kind, row.over]), [['INV-A-0003', 'quantity', 4], ['INV-G-0001', 'price', 1]])
  assert.deepEqual([invoices.owed, invoices.open, invoices.held], [{ count: 2, total: 115 }, { count: 1, total: 15 }, { count: 2, total: 100 }])
  assert.deepEqual([invoices.overdue.count, invoices.overdue.total, invoices.overdue.invoices[0].due], [1, 100, '2026-10-31'])
  assert.equal(invoices.paidIn('2026-11'), 100)
  assert.deepEqual(invoices.notInvoiced, { count: 1, total: 25 })
  assert.deepEqual(invoices.datedBeforeReceipt.map((row) => row.number), ['INV-A-0004'])
  // Asked after its due day, an invoice still unpaid is overdue.
  assert.equal(uciFacts(smallPlanWithPayables(), { today: '2026-11-20' }).supplierInvoices.overdue.count, 2)
  // The cases carry the figures.
  const cases = buildUciCases(facts)
  const expect = (id) => cases.find((row) => row.id === id).expect
  assert.deepEqual(expect('invoice-match-en').numbers.map((entry) => entry.value), [3, 2])
  assert.equal(expect('payables-owed-en').numbers[0].value, 115)
  assert.deepEqual(expect('invoice-quantity-en').mentions, [{ label: 'INV-A-0003', any: ['INV-A-0003'] }])
  assert.deepEqual(expect('payables-overdue-zh').mentions.map((entry) => entry.label), ['INV-A-0002'])
  assert.equal(expect('gross-profit-en').numbers[0].value, 51)
  assert.deepEqual(expect('cash-month-en').numbers.map((entry) => entry.value), [29.8, 0])
  assert.equal(cases.filter((row) => row.kind === 'payables').length, 8)
  // Without payables in the plan there are no payables cases.
  assert.equal(buildUciCases(uciFacts(smallPlan())).filter((row) => row.kind === 'payables').length, 0)
})

// Design audit C12: the seed's purchase requests, its UCI orders still being
// filled and its reviewed invoice differences move the expected figures.
test('the UCI figures with purchase requests, orders still being filled and reviewed differences', () => {
  const plan = smallPlanWithPayables()
  plan.requests = [
    { key: 'draft-1', state: 'draft', itemKey: 'C1', supplierKey: 'X', quantity: 20, day: 66, needBy: 80 },
    { key: 'converted-1', state: 'converted', itemKey: 'S1', supplierKey: 'G', quantity: 40, day: 67, needBy: 81 },
    { key: 'rejected-1', state: 'rejected', itemKey: 'H1', supplierKey: 'A', quantity: 70, day: 68, needBy: 82 },
  ]
  // The newest order (2 S1 for c1) is reserved and not shipped yet.
  plan.openSales = [{ position: 3, state: 'reserved', shipLines: [] }]
  // The short delivery was reviewed: accepted at the 70 received.
  const short = plan.payables.invoices.find((row) => row.number === 'INV-A-0003')
  Object.assign(short, { resolution: { day: 68, decision: 'accept_received' }, approvedDay: 68, payablePence: 7000, payment: 'open' })
  const facts = uciFacts(plan)
  // S1: the unshipped 2 are still on hand and reserved; the converted
  // request's 40 is on order; the position is as if they had shipped.
  assert.deepEqual(['onHand', 'reserved', 'available', 'onOrder', 'position'].map((key) => facts.item('S1')[key]), [22, 2, 20, 130, 150])
  // The draft request for C1 (20) lifts it above its reorder point: off the list.
  assert.equal(facts.reorder.find((row) => row.sku === 'C1'), undefined)
  // The rejected request counts for nothing; the converted one is not late.
  assert.equal(facts.item('H1').position, uciFacts(smallPlanWithPayables()).item('H1').position)
  assert.equal(facts.late.length, uciFacts(smallPlanWithPayables()).late.length)
  // The unshipped order has no invoice yet.
  assert.deepEqual([facts.receivables.invoices, facts.receivables.total], [2, 86])
  // The reviewed invoice is owed at what was received; the price difference is still held.
  const invoices = facts.supplierInvoices
  assert.deepEqual(invoices.match, { matched: 3, exception: 1, reviewed: 1 })
  assert.deepEqual(invoices.differences.map((row) => row.number), ['INV-G-0001'])
  assert.deepEqual([invoices.owed, invoices.open, invoices.held], [{ count: 3, total: 185 }, { count: 2, total: 85 }, { count: 1, total: 26 }])
  // The reviewed difference, the requests by state, the order being filled
  // and the tiers, for the records cases.
  assert.deepEqual(invoices.reviewedDifferences.map((row) => [row.number, row.kind, row.decision, row.reviewed, row.payable]), [['INV-A-0003', 'quantity', 'accept_received', '2026-11-08', 70]])
  assert.deepEqual(Object.fromEntries(Object.entries(facts.purchaseRequests.byState).map(([state, rows]) => [state, rows.map((row) => [row.sku, row.quantity, row.reason ?? null])])),
    { draft: [['C1', 20, null]], submitted: [], approved: [], converted: [['S1', 40, null]], rejected: [['H1', 70, 'not needed now']], cancelled: [] })
  assert.deepEqual(facts.ordersBeingFilled, [{ state: 'reserved', customerId: 'c1', customer: 'Customer c1 (United Kingdom)', ordered: '2026-11-05', toShip: [{ sku: 'S1', quantity: 2 }], shipped: [] }])
  assert.deepEqual(facts.tiers.map((row) => [row.name, row.tier]), [['Acme Home Goods', 1], ['Globex Party Supplies', null], ['Supplier of other codes (assumed)', null]])
  // The cases: with no quantity difference left open, the answer should say
  // there is none; the records cases come last, asked by the manager. (The
  // draft request is moved to P1, so the cakestand the reorder cases ask
  // about stays on the list.)
  plan.requests = plan.requests.map((row) => (row.state === 'draft' ? { ...row, itemKey: 'P1', supplierKey: 'A' } : row))
  const cases = buildUciCases(uciFacts(plan))
  const byId = Object.fromEntries(cases.map((row) => [row.id, row]))
  // Said in words, on the text only, with the count kept (#421 review).
  assert.deepEqual(byId['invoice-quantity-en'].expect.numbers.map((entry) => [entry.value, Boolean(entry.inWords)]), [[0, true]])
  assert.deepEqual(byId['invoice-price-en'].expect.mentions, [{ label: 'INV-G-0001', any: ['INV-G-0001'] }])
  // The supplier reply cases follow the records cases (#363 §4.10).
  const records = cases.slice(cases.findIndex((row) => row.id === 'requests-rejected-en'), cases.findIndex((row) => row.id === 'reply-said-en'))
  // No request waits for approval or is approved here, and the one order
  // being filled is reserved, so those cases are left out.
  assert.deepEqual(records.map((row) => row.id), ['requests-rejected-en', 'requests-draft-zh', 'open-sales-en', 'reviewed-differences-en', 'tier-one-en'])
  assert.ok(records.every((row) => row.asUser === 'kim@example.com'))
  assert.deepEqual(byId['requests-rejected-en'].expect.mentions, [{ label: 'H1', any: ['H1', 'Hero Lamp'] }])
  assert.deepEqual(byId['requests-draft-zh'].expect, { mentions: [{ label: 'P1', any: ['P1', 'Pending Sign'] }], numbers: [{ label: '草稿张数', value: 1 }] })
  assert.deepEqual(byId['open-sales-en'].expect, { numbers: [{ label: 'orders still to ship', value: 1 }], mentions: [{ label: 'Customer c1 (United Kingdom)', any: ['c1'] }] })
  assert.deepEqual(byId['reviewed-differences-en'].expect, { numbers: [{ label: 'reviewed', value: 1 }], mentions: [{ label: 'INV-A-0003', any: ['INV-A-0003'] }] })
  assert.deepEqual(byId['tier-one-en'].expect.mentions, [{ label: 'Acme Home Goods', any: ['Acme Home Goods'] }])
  // Without the C12 documents in the plan there are no records cases.
  assert.equal(buildUciCases(uciFacts(smallPlan())).filter((row) => row.kind === 'records').length, 0)
})

// #363 §4.10: a supplier reply read back from the order's history. The
// reply cases come last, asked by the manager; the reply is pasted first
// (setup) and names a day 14 days after the day asked.
test('the supplier reply cases follow the records cases: the reply pasted first, its day, and an order with none', () => {
  const facts = uciFacts(smallPlan(), { today: '2026-11-20' })
  const cases = buildUciCases(facts)
  const start = cases.findIndex((row) => row.id === 'reply-said-en')
  const replies = cases.slice(start, start + 3)
  assert.deepEqual(replies.map((row) => row.id), ['reply-said-en', 'reply-said-zh', 'reply-none-en'])
  assert.ok(replies.every((row) => row.asUser === 'kim@example.com' && row.setup))
  const [en, zh, none] = replies
  assert.equal(en.setup.supplierReply, zh.setup.supplierReply)
  assert.deepEqual([en.setup.supplierReply.receivedOn, en.expect.dates], ['2026-11-20', [{ label: 'the day the reply names', date: '2026-12-04' }]])
  assert.match(en.setup.supplierReply.text, /\{order\}.*will ship on 4 December 2026/s)
  assert.ok(en.setup.supplierReply.text.includes(facts.scene.hero.sku))
  assert.deepEqual(en.setup.supplierReply.dismiss, { reason: 'supplier_will_confirm' })
  assert.deepEqual(en.turns, [{ text: 'What did Acme say about {order}?', order: { supplier: 'Acme', late: true } }])
  assert.equal(zh.language, 'zh-CN')
  assert.deepEqual(none.setup, { noSupplierReply: { supplier: 'Globex', late: true } })
  assert.ok(none.expect.notMatches.length && !none.expect.dates)
  // The checks read what they should: "not recorded" passes, a made-up reply fails.
  const said = new RegExp(en.expect.matches[0].pattern, 'i')
  assert.ok(said.test('Acme said 85123A will ship on 4 December; it was not recorded, as the supplier will confirm.'))
  const noReply = new RegExp(none.expect.matches[0].pattern, 'i')
  const invented = new RegExp(none.expect.notMatches[0].pattern, 'i')
  assert.ok(noReply.test('No supplier reply is recorded on PO-202610-0031.'))
  assert.equal(noReply.test('The order is not late.'), false)
  assert.ok(invented.test('Globex said it will ship on 2 December.'))
})

// --setup writes a supplier reply, so it is refused on the walkthrough people
// use, whichever of its ports is passed; a test instance's ports pass.
test('the runner refuses --setup against the walkthrough\'s app and API ports', () => {
  assert.deepEqual(WALKTHROUGH_DEMO_PORTS, [15231, 15232, 18831, 18832])
  for (const port of [15231, 15232, 18831, 18832, '18831']) assert.match(setupRefusal({ setup: true, port }), /does not run against the walkthrough/)
  // The port as the runner's base URL reads it, whatever follows it.
  for (const port of ['15231/', '15231#', '15231?x', '18832/api', '15232#top']) assert.match(setupRefusal({ setup: true, port }), /does not run against the walkthrough/, port)
  assert.match(setupRefusal({ setup: true, port: 'not a port' }), /is not one/)
  for (const port of [18801, 18802, 18941]) assert.equal(setupRefusal({ setup: true, port }), null)
  // Without --setup nothing is written, so any port may be read.
  assert.equal(setupRefusal({ setup: undefined, port: 18831 }), null)
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
  assert.deepEqual(expect('budget-quantity-en').formLines, [{ sku: 'C1', quantity: Math.min(100, Math.floor(1000 / facts.item('C1').price)), checked: true }])
  // "The minimum does not fit" is asked only of a budget the minimum order
  // costs more than.
  const minimumCost = facts.item('C1').minimumOrderQuantity * facts.item('C1').price
  for (const [id, budget] of [['budget-500-en', 500], ['budget-300-zh', 300]]) assert.equal(Boolean(expect(id).matches), minimumCost > budget, id)
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
  assert.deepEqual(expect('reorder-en').listed, { rows: [{ sku: 'C1', quantity: 20 }], atLeast: 1 })
  assert.deepEqual(expect('reorder-en').numbers, [{ label: 'items to order now', value: 1 }])
  assert.deepEqual(expect('conv-reorder-form-en').formAt, { rows: [{ sku: 'C1', quantity: 20 }] })
  // A rise or fall in either sign, the words saying which (2026-11-20).
  assert.deepEqual(expect('month-compare-zh').numbers[2].anyOf, [188.6, 188.6])
  assert.equal(expect('month-compare-zh').matches[0].label, '说增长')
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
// 2026-11-22: a reorder question that names no item is scored on items due
// at the reorder list's quantity, any of them, and the form on its items.
test('scoring listed items and a form at their quantities', () => {
  const rows = [{ sku: '23309', quantity: 570 }, { sku: '22961', quantity: 503 }, { sku: '22423', quantity: 112 }, { sku: '84077', quantity: 665 }]
  const check = (answer, expect, name, answers) => scoreAnswer({ status: 200, ui: [], flags: [], errors: [], ...answer }, expect, answers ? { answers } : {}).checks.find((entry) => entry.name === name)
  const listed = (answer) => check(answer, { listed: { rows, atLeast: 3 } }, 'lists items at their quantity')
  // Three named at their quantity, in sentences or table rows.
  assert.equal(listed({ text: 'Order 570 of 23309 and 503 of 22961. 22423: 112 pcs.' }).ok, true)
  assert.equal(listed({ text: 'Order 570 of 23309.', ui: [{ component: 'table', props: { rows: [{ item: { label: '22961' }, request_quantity: 503 }, { item: { label: '84077' }, request_quantity: 665 }] } }] }).ok, true)
  // The solver's quantities, or items without one, are not the list's.
  assert.equal(listed({ text: 'Order 617 of 23309, 650 of 22961 and 140 of 22423.' }).ok, false)
  assert.equal(listed({ text: '23309, 22961 and 22423 are the most short.' }).detail, '0 of 4, 3 wanted')
  const formAt = (lines, earlier = []) => check({ text: 'I\'ve filled in a request form.', ui: [{ component: 'pr_form', props: { lines } }] }, { formAt: { rows } }, 'form at their quantities', [...earlier, { text: '' }])
  const line = (sku, value) => ({ item: { sku }, suggestedQuantity: { value } })
  assert.equal(formAt([line('23309', 570), line('99999', 10)]).ok, true)
  assert.deepEqual([formAt([line('23309', 570), line('22961', 650)]).ok, formAt([line('23309', 570), line('22961', 650)]).detail], [false, '22961 at 650, not 503'])
  // At a quantity an earlier answer gave, the user agreed to it.
  assert.equal(formAt([line('22961', 650)], [{ text: 'I recommend 650 of 22961.' }]).ok, true)
  assert.deepEqual([formAt([line('99999', 10)]).ok, formAt([line('99999', 10)]).detail], [false, 'none of the items on the form'])
  assert.equal(check({ text: 'No form.' }, { formAt: { rows } }, 'form at their quantities').detail, 'no form')
})

test('scoring quantities: a quantity counts anywhere in its SKU\'s sentence, not across a full stop', () => {
  const answer = (text) => ({ status: 200, text, ui: [], flags: [], errors: [] })
  const ok = (text) => scoreAnswer(answer(text), { quantities: [{ sku: '22423', quantity: 60 }] }).checks.find((check) => check.name === 'quantity: 22423').ok
  assert.equal(ok('只有 1 个物料：22423 缺口 20 件；但最小起订量为 60 件，所以建议按 60 件下单。'), true)
  assert.equal(ok('Order 22423 now; the minimum is 60 pcs at £12.75.'), true)
  assert.equal(ok('Order 22423 now. The minimum of another item is 60 pcs.'), false)
  assert.equal(ok('22423 需要补货。另一个物料要 60 件。'), false)
})

// Design audit 2026-11-15, L5-16 and L5-18: figures in any card's props, calls
// that failed, and the asking user by the case's place in the list.
test('scoring is on the answer\'s words, on calls that ran, and the UCI cases say who asks', () => {
  // A figure only in a card's props is not the answer's (a lead time of 14
  // sat in every supplier table).
  const answer = { status: 200, text: '22423 is bought from Acme.', ui: [{ component: 'table', props: { rows: [{ sku: '22423', supplier: 'Acme', leadTimeDays: 14 }] } }], flags: [], errors: [], tools: [] }
  assert.equal(scoreAnswer(answer, { numbers: [{ label: 'lead time', value: 14 }] }).checks.find((check) => check.name === 'number: lead time').ok, false)
  assert.equal(scoreAnswer({ ...answer, text: '22423 takes 14 days from Acme.' }, { numbers: [{ label: 'lead time', value: 14 }] }).checks.find((check) => check.name === 'number: lead time').ok, true)
  // A count written as a word is the answer's (not-invoiced-en: "Four posted receipts").
  const receipts = { ...answer, text: 'Four posted receipts have no supplier invoice against them yet.' }
  assert.equal(scoreAnswer(receipts, { numbers: [{ label: 'receipts', value: 4 }] }).checks.find((check) => check.name === 'number: receipts').ok, true)
  assert.deepEqual(countWordsIn('One of the orders is late; two suppliers, 两张订单，十二张发票，三家供应商。'), [2, 2, 3])
  // A figure the role may not see fails the case wherever it shows.
  assert.equal(scoreAnswer(answer, { numbersAbsent: [{ label: 'lead time', value: 14 }] }).checks.find((check) => check.name === 'no number: lead time').ok, false)
  // A call that failed is not a call.
  const failed = scoreAnswer({ ...answer, tools: [], toolErrors: ['optimize_order_plan'] }, { calls: ['optimize_order_plan'] }).checks.find((check) => check.name === 'calls optimize_order_plan')
  assert.deepEqual([failed.ok, failed.detail], [false, 'no tools; failed: optimize_order_plan'])
  // Who asks: the cases that need the manager's view name it, and the path cases name theirs.
  const facts = uciFacts(smallPlanWithPayables())
  const cases = buildUciCases(facts)
  const byId = Object.fromEntries(cases.map((row) => [row.id, row]))
  for (const row of cases.filter((entry) => ['finance', 'payables', 'sales'].includes(entry.kind))) assert.equal(row.asUser, 'kim@example.com', row.id)
  assert.equal(byId['margin-en'].asUser, 'kim@example.com')
  // The walkthrough's buyer has the manager's role and may see margins, so
  // the hidden-margin case is asked by a member with the buyer role, whom
  // --setup invites (#421 review).
  assert.equal(byId['buyer-margin-en'].asUser, 'eval-buyer@flowchain.local')
  assert.deepEqual(byId['buyer-margin-en'].setup, { member: { email: 'eval-buyer@flowchain.local', role: 'buyer' } })
  assert.deepEqual(byId['buyer-margin-en'].expect.numbersAbsent.map((row) => row.value), [facts.month(lastWholeMonths(facts.seedDay).last.key).grossMarginPercent])
  assert.equal(byId['english-panel-zh'].turns[0].interfaceLanguage, 'en-US')
  assert.equal(byId['open-order-zh'].turns[0].activeContext.entityType, 'purchase_order')
  assert.equal(byId['unconfirmed-click-en'].turns[1].formResults[0].purchaseRequestId, 'PR-EVAL-NOT-CREATED')
  // The lead time comes from the seed's terms, not a number written in the case.
  assert.equal(byId['cake-terms-zh'].expect.numbers[0].value, facts.item(facts.scene.reorder.sku).leadTimeDays)
})

// #421 review: "none has a difference" is scored on the answer's words, with
// the count kept; the SME decline and approval patterns read straight and
// curly apostrophes, and only a claim of having approved fails.
test('scoring "none" on the words, and the SME decline and approval wording', () => {
  const said = (text, entry, ui = []) => scoreAnswer({ status: 200, errors: [], notices: [], text, ui, refs: [], tools: [] }, { numbers: [entry] }, { language: /[一-鿿]/.test(text) ? 'zh-CN' : 'en-US' }).checks.find((check) => check.name === `number: ${entry.label}`).ok
  const facts = uciFacts(smallPlanWithPayables())
  const cases = buildUciCases(facts)
  const byId = Object.fromEntries(cases.map((row) => [row.id, row]))
  // The words of a zero count, as the money cases use them.
  const en = { label: 'with differences', value: 0, inWords: NO_DIFFERENCE_EN }
  for (const text of ['No invoices have differences.', '48 matched, 0 with differences.', 'None of the supplier invoices bill for more than we received.', 'All 48 supplier invoices passed the three-way match.']) assert.equal(said(text, en), true, text)
  // A "no" or a 0 elsewhere, in a record number, or only in a card, is not it.
  const card = [{ component: 'table', props: { rows: [{ differences: 0, note: 'no' }] } }]
  for (const text of ['48 invoices are on file.', 'INV-202611-0004 is priced above the order by £2.10.', 'Not all invoices passed: 3 have differences.', 'INV-202611-0010 has a difference of £0.40.', 'All but 3 matched; 3 have differences.', 'All except 2 passed the match.']) assert.equal(said(text, en, card), false, text)
  const zh = { label: '有差异的发票数', value: 0, inWords: NO_DIFFERENCE_ZH }
  for (const text of ['目前没有任何供应商发票存在差异。', '有差异的发票为 0 张。', '所有发票都已匹配，无差异。']) assert.equal(said(text, zh), true, text)
  for (const text of ['以下发票有差异：INV-202611-0004 单价高于订单。', '并非全部一致。']) assert.equal(said(text, zh), false, text)
  // textOnly matches read the words, not a card.
  const textOnly = (text) => scoreAnswer({ status: 200, errors: [], notices: [], text, ui: [{ component: 'table', props: { rows: [{ note: 'none' }] } }], refs: [], tools: [] }, { matches: [{ label: 'none', pattern: 'none', textOnly: true }] }).checks.find((check) => check.name === 'says: none').ok
  assert.deepEqual([textOnly('None.'), textOnly('Three.')], [true, false])
  // Decline wording, straight or curly; a claim of having merged fails.
  const merge = byId['sme-merge-orders-en']
  const declines = new RegExp(merge.expect.matches[0].pattern, 'i')
  for (const text of ['I can’t merge orders.', "I can't merge them.", 'I’m unable to merge purchase orders.', 'I won’t merge them.', 'Merging orders isn’t possible here.', 'FlowChain doesn’t support merging orders.']) assert.equal(declines.test(text), true, text)
  assert.equal(new RegExp(merge.expect.notMatches[0].pattern, 'i').test('I’ve merged the two orders.'), true)
  // Whole words only (#421 review: "significant" read as "can't").
  assert.equal(declines.test('That is a significant delay on both orders.'), false)
  const approve = byId['sme-approve-all-zh']
  assert.equal(new RegExp(approve.expect.matches[0].pattern, 'i').test('这个我做不到，需要你逐张批准。'), true)
  const claims = new RegExp(approve.expect.notMatches[0].pattern, 'i')
  for (const text of ['我已经批准了所有挂起的发票。', '已为你全部批准。', '我已批准这 3 张发票。', '好的，批准了所有挂起的发票。']) assert.equal(claims.test(text), true, text)
  for (const text of ['目前没有挂起的发票，其余发票都已批准。', '这些发票已批准付款，无需操作。', '已通过三单匹配的发票会自动进入待付款。', '我无法替您批准这些发票。', '我不能帮你批准，需要你在发票页面操作。', '我不会直接帮您全部批准。']) assert.equal(claims.test(text), false, text)
})

// 2026-11-21: sme-waiting-approval-en failed right answers that named the
// order waiting for approval (PO-202611-0023) rather than its item (85152).
// The order is accepted only as the seed's pending order of that supplier,
// looked up in the workspace; the item stays accepted.
test('the approval case accepts the seed\'s pending order by number, and still the item', async () => {
  const { withResolvedMentions } = await import('../../tests/ai-eval/v2-public/resolve-mentions.mjs')
  const facts = uciFacts(smallPlanWithPayables())
  const cases = buildUciCases(facts)
  const approval = cases.find((row) => row.id === 'sme-waiting-approval-en')
  assert.ok(approval, 'the small plan has an order waiting for approval')
  const [mention] = approval.expect.mentions
  assert.equal(mention.orderWaitingApproval.supplier, facts.waitingForApproval[0].supplier)
  const orders = [
    { orderNumber: 'PO-202611-0023', status: 'pending_approval', supplierName: facts.waitingForApproval[0].supplier },
    { orderNumber: 'PO-202611-0024', status: 'issued', supplierName: facts.waitingForApproval[0].supplier },
    { orderNumber: 'PO-202611-0099', status: 'pending_approval', supplierName: 'Someone Else Ltd' },
    // A supplier whose name only contains the wanted one is another supplier.
    { orderNumber: 'PO-202611-0098', status: 'pending_approval', supplierName: `${facts.waitingForApproval[0].supplier} Holdings` },
  ]
  const resolved = withResolvedMentions(approval.expect, orders).mentions[0]
  assert.ok(resolved.any.includes('PO-202611-0023'))
  assert.ok(!resolved.any.includes('PO-202611-0024') && !resolved.any.includes('PO-202611-0099') && !resolved.any.includes('PO-202611-0098'))
  for (const word of mention.any) assert.ok(resolved.any.includes(word), word)
  assert.equal('orderWaitingApproval' in resolved, false)
  // Without a pending order, the mention is as written.
  assert.deepEqual(withResolvedMentions(approval.expect, []).mentions[0].any, mention.any)
})
