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
import { answerLanguage, numbersIn, scoreAnswer } from '../../tests/ai-eval/v2-public/score.mjs'

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
})
