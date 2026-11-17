import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PUBLIC_DATA_WORKSPACE_ASSUMPTIONS, PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA, buildPublicDataPlan, itemThresholds, simulatePurchasing } from '../../scripts/public-data/plan.mjs'

// Design audit B7: the public data note's "What is assumed" names every
// assumption of the seed (L14, L7-15 no VAT, L7-23 reorder point = 3 x safety
// stock, L3-15 / L3-16 what the seeded reorder point and safety stock mean),
// in English and Chinese, and each line is true of scripts/public-data/.
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
const CJK = /[一-鿿]/

// The publicData.* strings of one language's dictionary in src/i18n/I18n.tsx.
function publicDataStrings(i18n, from, to) {
  const block = i18n.slice(i18n.indexOf(from), i18n.indexOf(to))
  return new Map([...block.matchAll(/^\s*"(publicData\.[^"]+)": "((?:[^"\\]|\\.)*)",$/gm)].map((match) => [match[1], match[2]]))
}

async function noteCopy() {
  const i18n = await read('src/i18n/I18n.tsx')
  return {
    zh: publicDataStrings(i18n, 'const zh = {', 'const en: Record'),
    en: publicDataStrings(i18n, 'const en: Record', 'export type TranslationKey'),
    note: await read('src/app/PublicDataNote.tsx'),
  }
}

const placeholders = (value) => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).sort()

// The lines B7 added or rewrote.
const B7_KEYS = [
  'groupData', 'm5Items', 'uciItems', 'weekdays', 'weekdaysKept', 'weekdayNames', 'dates',
  'groupStock', 'm5Suppliers', 'uciSuppliers', 'deliveries', 'deliveriesExceptions', 'thresholds', 'lookAhead', 'belowSuggestion', 'history', 'reviewDay', 'appRule',
  'groupMoney', 'uciPurchasePrice', 'm5PurchasePrice', 'noTax', 'uciAssumed', 'uciSupplierInvoices', 'uciSupplierPayments', 'scene',
].map((key) => `publicData.${key}`)

test('every line of the public data note is in both languages, with the same figures', async () => {
  const { zh, en, note } = await noteCopy()
  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort())
  for (const key of B7_KEYS) {
    assert.ok(en.has(key) && zh.has(key), `${key} needs English and Chinese`)
    assert.doesNotMatch(en.get(key), CJK, `${key} English has no Chinese`)
    assert.match(zh.get(key), CJK, `${key} has a Chinese translation`)
    assert.deepEqual(placeholders(zh.get(key)), placeholders(en.get(key)), `${key} fills the same figures in both languages`)
    assert.ok(note.includes(`"${key}"`), `${key} is shown by the note`)
  }
  // Nothing in the note is written in one language only.
  for (const [, key] of note.matchAll(/"(publicData\.[A-Za-z0-9]+)"/g)) assert.ok(en.has(key) && zh.has(key), key)
  assert.doesNotMatch(note.replace(/\/\/.*$/gm, ''), CJK)
  assert.equal(en.get('publicData.weekdayNames').split('|').length, 7)
  assert.equal(zh.get('publicData.weekdayNames').split('|').length, 7)
  // publicData.assumed was split into the groups below.
  assert.ok(!en.has('publicData.assumed'))
})

test('the note states each assumption of the seed, in both languages', async () => {
  const { zh, en } = await noteCopy()
  const says = (key, english, chinese) => {
    assert.match(en.get(`publicData.${key}`), english, `${key} (English)`)
    assert.match(zh.get(`publicData.${key}`), chinese, `${key} (Chinese)`)
  }
  // Public data with no VAT (L7-15; FIX-PLAN, accounting depth).
  says('noTax', /^No VAT or other tax: every customer and supplier invoice has tax 0\.$/, /^不含增值税或其他税：所有销售发票和供应商发票的税额都是 0。$/)
  // Supplier mapping, one supplier per item.
  says('m5Suppliers', /^Suppliers: one per department; each item has a single supplier\.$/, /^供应商：每个部门一家；每个商品只有一家供应商。$/)
  says('uciSuppliers', /one per StockCode family \(the first two digits; families of under five products share one\); each product has a single supplier/, /每个 StockCode 系列（前两位数字）一家，商品不足 5 个的系列合用一家；每个商品只有一家供应商/)
  // Fixed lead time, on time and in full, nothing rejected, one location, pcs.
  says('deliveries', /a fixed \{leadTimeDays\}-day lead time\. Every order due by \{last\} arrived on time and in full, in one delivery, with nothing rejected, into location A-01, in pcs/, /交货期固定 \{leadTimeDays\} 天。\{last\} 及之前到期的订单都准时足额、一次到齐、无拒收，收进库位 A-01，单位都是 pcs/)
  says('deliveriesExceptions', /walkthrough scene and the short deliveries/, /演练场景，以及下面供应商发票里的少送/)
  // Safety stock, reorder point = 3 x safety stock with no margin (L7-23, L3-15), minimum order.
  says('thresholds', /Safety stock: \{reviewDays\} days of average demand\. Reorder point: \{cover\} days \(lead time plus review\), with no safety margin, so about \{times\} times the safety stock\. Minimum order: \{reviewDays\} days, rounded up to a multiple of 10 \(at least 10\)/, /安全库存：\{reviewDays\} 天平均需求。再订货点：\{cover\} 天（交货期加检查周期），不含安全量，所以约为安全库存的 \{times\} 倍。最小订货量：\{reviewDays\} 天，向上取整到 10 的倍数（至少 10）/)
  says('belowSuggestion', /seeded reorder point is below the reorder list's suggestion for nearly every item/, /几乎每个商品的种子再订货点都低于补货清单的建议值/)
  // The averaging window, and the look-ahead it gives the history (L14).
  says('lookAhead', /last \{window\} days of the data and apply to the whole year, so earlier orders were sized with later demand/, /数据最后 \{window\} 天，却用于全年，所以较早的订单是按之后的需求定量的/)
  // The history's 28-day trigger plus the minimum order, the opening stock, the after-the-fact raise.
  says('history', /at or below \{base\} days of average demand \(reorder point plus safety stock\) was ordered up to that level plus its minimum order; opening stock was that level plus the minimum\..*more was bought after the fact/, /不超过 \{base\} 天平均需求（再订货点加安全库存）的商品，补到这个水平再加一个最小订货量；期初库存也是这个水平加一个最小订货量。.*事后补买/)
  says('reviewDay', /a seed on another weekday gives a different history/, /换一个星期几灌数据，采购历史就会不同/)
  // How the app reads the same figures (L3-16).
  says('appRule', /reorder point alone, without the safety stock/, /只看再订货点，不加安全库存/)
  // One cost share for every item; how each dataset's price is taken.
  says('uciPurchasePrice', /^Purchase prices: \{percent\}% of each product's median selling price for the year, so they never change\. One share for every product, so gross profit ranks products much as sales do\.$/, /^采购价：每个商品全年售价中位数的 \{percent\}%，全年不变。所有商品同一比例，所以按毛利排序和按销售额排序大致相同。$/)
  says('m5PurchasePrice', /^Purchase prices: \{percent\}% of the store's price on the day of the order, so they fall when the shelf price is cut\. One share for every item/, /^采购价：下单当天门店价的 \{percent\}%，门店降价时采购价也随之下降。所有商品同一比例/)
  // Held invoices are never resolved; picked by hash; older invoices paid by construction.
  says('uciSupplierInvoices', /picked by a fixed hash, not by supplier\. .*the seed resolves none, however old/, /按固定哈希挑选，与供应商无关。.*不论多久，种子数据都不处理/)
  says('uciSupplierPayments', /due by \{last\} were paid on the due date, except \{unpaidPercent\}% of those due in the \{unpaidWithinDays\} days up to \{last\}, left overdue; every older one is paid/, /\{last\} 及之前到期的供应商发票在到期日付款，只有截至 \{last\} 的 \{unpaidWithinDays\} 天内到期的有 \{unpaidPercent\}% 未付、已逾期；更早的全部已付/)
  says('uciAssumed', /Those due by \{last\} were paid on the due date; later ones stay open/, /\{last\} 及之前到期的都在到期日收款；之后到期的保持未结/)
  // Item sampling and the moved calendar.
  says('m5Items', /each department's best sellers, so slow sellers are left out/, /各部门的畅销品，慢销商品不在其中/)
  says('uciItems', /sold on at least 30 days, so slow sellers are left out/, /至少 30 天有销售的，慢销商品不在其中/)
  says('weekdays', /^Weekdays and seasons move with the dates: a Saturday in the data is a \{weekday\} here\.$/, /^星期和季节随日期一起平移：数据里的星期六，在这里是\{weekday\}。$/)
  says('weekdaysKept', /weekdays match the data, but holidays and seasons move with the dates/i, /星期与数据一致，但节假日和季节随日期平移/)
  says('scene', /outside the delivery and purchase history rules above/, /不受上面交货和采购历史规则的约束/)
})

test('the note groups its lines and works out its figures from the note', async () => {
  const { note } = await noteCopy()
  for (const id of ['public-data-note-data', 'public-data-note-stock', 'public-data-note-money', 'public-data-note-weekdays', 'public-data-note-no-tax', 'public-data-note-supplier-invoices']) assert.ok(note.includes(`"${id}"`), id)
  assert.ok(note.includes('{note.dataset === "uci" && <li data-testid="public-data-note-no-tax">{t("publicData.noTax")}</li>}'))
  // Weekdays move by the shift modulo 7; Saturday is the anchor.
  assert.ok(note.includes('const weekdayShift = ((note.shiftDays % 7) + 7) % 7;'))
  assert.ok(note.includes('t("publicData.weekdayNames").split("|")[(SATURDAY + weekdayShift) % 7]'))
  // Reorder point = lead time + review; the history's level adds the safety stock (review days).
  assert.ok(note.includes('const cover = leadTimeDays + reviewDays;'))
  assert.ok(note.includes('base: cover + reviewDays, window: THRESHOLD_WINDOW_DAYS'))
  // The same averaging window as the seed.
  const plan = await read('scripts/public-data/plan.mjs')
  assert.match(plan, /^const THRESHOLD_WINDOW_DAYS = 90$/m)
  assert.match(note, /^const THRESHOLD_WINDOW_DAYS = 90;$/m)
})

// The seed does what the note says.
function m5Extract(daily) {
  const days = daily.length
  const dates = Array.from({ length: days }, (_, index) => new Date(Date.UTC(2015, 4, 24 + index)).toISOString().slice(0, 10))
  return {
    schema: PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA,
    m5: { source: { dataset: 'M5' }, rules: [], store: 'ST_1', window: { first: dates[0], last: dates.at(-1), days }, dates, events: {}, items: [{ id: 'DEPT_A_001', department: 'DEPT_A', category: 'DEPT', daily, prices: daily.map(() => 2) }] },
    uci: { products: [{ code: '10001', name: 'X', price: 1 }] },
  }
}

test("the note's stock rules are the seed's", () => {
  const { leadTimeDays, reviewDays, reviewWeekday } = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS
  assert.deepEqual({ leadTimeDays, reviewDays, reviewWeekday }, { leadTimeDays: 14, reviewDays: 7, reviewWeekday: 1 })
  // Safety stock = review days, reorder point = lead time + review days of
  // average demand, so three times the safety stock; minimum order rounded
  // up to a multiple of 10, at least 10.
  for (const mean of [0, 0.4, 3.3, 11.68, 40]) {
    const thresholds = itemThresholds(mean)
    assert.equal(thresholds.safetyStock, Math.round(mean * reviewDays))
    assert.equal(thresholds.reorderPoint, Math.round(mean * (leadTimeDays + reviewDays)))
    assert.equal(thresholds.minimumOrderQuantity % 10, 0)
    assert.ok(thresholds.minimumOrderQuantity >= 10 && thresholds.minimumOrderQuantity >= mean * reviewDays)
  }
  assert.equal(itemThresholds(40).reorderPoint, 3 * itemThresholds(40).safetyStock)
  // The averages are of the last 90 days, and apply to the whole year.
  const daily = Array.from({ length: 120 }, (_, index) => (index < 30 ? 100 : 2))
  const plan = buildPublicDataPlan(m5Extract(daily), 'm5', { seedDay: '2026-11-13' })
  assert.equal(plan.items[0].meanDaily, 2)
  assert.deepEqual({ safetyStock: plan.items[0].safetyStock, reorderPoint: plan.items[0].reorderPoint }, { safetyStock: 14, reorderPoint: 42 })
  // Weekdays move by the shift modulo 7.
  const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay()
  assert.equal(weekday(plan.window.last), (weekday(plan.sourceWindow.last) + (((plan.shiftDays % 7) + 7) % 7)) % 7)
  // Every order due by the last day arrived on its promised day, in one full delivery.
  for (const order of plan.purchasing.orders.filter((row) => row.promised < plan.days)) {
    assert.equal(order.receipts.length, 1)
    assert.equal(order.receipts[0].index, order.promised)
    assert.deepEqual(order.receipts[0].lines, order.lines.map((line) => ({ itemKey: line.itemKey, quantity: line.quantity })))
  }
})

test('the history orders up to reorder point plus safety stock plus the minimum, from an opening stock at that level', () => {
  const item = { key: 'A', supplierKey: 'S', daily: Array.from({ length: 70 }, () => 4), ...itemThresholds(4) }
  const level = item.reorderPoint + item.safetyStock
  const reviewIndexes = [0, 7, 14, 21, 28, 35, 42, 49, 56, 63]
  const result = simulatePurchasing({ days: 70, items: [item], reviewIndexes, leadTimeDays: 14 })
  assert.equal(result.opening.A, level + item.minimumOrderQuantity)
  assert.equal(result.raisedDays, 0)
  // Replay: an order is placed exactly when stock plus open orders is at or below the level.
  let onHand = result.opening.A
  for (let day = 0; day < 70; day += 1) {
    for (const order of result.orders) if (order.arrival === day) onHand += order.lines[0].quantity
    if (reviewIndexes.includes(day)) {
      const onOrder = result.orders.filter((order) => order.review < day && order.arrival > day).reduce((total, order) => total + order.lines[0].quantity, 0)
      const placed = result.orders.find((order) => order.review === day)
      if (onHand + onOrder <= level) assert.equal(placed?.lines[0].quantity, level + item.minimumOrderQuantity - onHand - onOrder, `day ${day}`)
      else assert.equal(placed, undefined, `day ${day}`)
    }
    onHand -= item.daily[day]
  }
  assert.ok(result.orders.length > 0)
})

test('the seed records no tax on customer or supplier invoices', async () => {
  const seed = await read('scripts/public-data/seed.mjs')
  // The customer invoice line and header.
  assert.equal(seed.match(/enteredTaxAmount: 0,/g)?.length, 2)
  assert.doesNotMatch(seed, /enteredTaxAmount: (?!0,)/)
  const payables = await read('scripts/public-data/seed-payables.mjs')
  assert.equal(payables.match(/enteredTaxAmount: '0',/g)?.length, 1)
  assert.doesNotMatch(payables, /enteredTaxAmount: (?!'0',)/)
})
