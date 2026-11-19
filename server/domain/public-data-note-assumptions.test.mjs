import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PUBLIC_DATA_PURCHASE_REQUEST_RULES, PUBLIC_DATA_OPEN_SALES_RULES, PUBLIC_DATA_SUPPLIER_INVOICE_RULES, PUBLIC_DATA_TIER_RULES, PUBLIC_DATA_WORKSPACE_ASSUMPTIONS, PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA, buildPublicDataPlan, minimumOrderQuantity } from '../../scripts/public-data/plan.mjs'
import { mergeOperationalSettings } from './workspace-settings-contract.mjs'

// Design audit B7, rewritten for C12: the public data note's "What is
// assumed" names every assumption of the seed (L14, L7-15 no VAT, L7-23 /
// L3-15 / L3-16 what the seeded reorder point and safety stock mean, and
// since C12 the calibration period, whole-week dates, purchase requests,
// orders still being filled, reviewed invoice differences and supplier
// tiers), in English and Chinese, and each line is true of scripts/public-data/.
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

// The lines B7 added or rewrote, and those C12 added.
const NOTE_KEYS = [
  'groupData', 'm5Items', 'uciItems', 'weekdays', 'weekdaysKept', 'weekdayNames', 'dates', 'uciOpenSales',
  'groupStock', 'm5Suppliers', 'uciSuppliers', 'tiers', 'deliveries', 'deliveriesExceptions', 'thresholds', 'lookAhead', 'belowSuggestion', 'history', 'requests', 'reviewDay', 'appRule',
  'groupMoney', 'uciPurchasePrice', 'm5PurchasePrice', 'noTax', 'uciAssumed', 'uciSupplierInvoices', 'uciSupplierPayments', 'scene',
].map((key) => `publicData.${key}`)

test('every line of the public data note is in both languages, with the same figures', async () => {
  const { zh, en, note } = await noteCopy()
  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort())
  for (const key of NOTE_KEYS) {
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
  // Tiers by spend before the tier day (L7-37).
  says('tiers', /set by the buyer \{daysBefore\} days ago from each supplier's share of purchase spend over the year before; the suppliers that make up the first \{tier1Percent\}% are Tier 1, the next up to \{tier2Percent\}% Tier 2, the rest Tier 3/, /由买手在 \{daysBefore\} 天前按此前一年各供应商的采购额占比设定；采购额累计前 \{tier1Percent\}% 的供应商为 1 级，其后到 \{tier2Percent\}% 的为 2 级，其余为 3 级/)
  // Fixed lead time, on time and in full, nothing rejected, one location, pcs.
  says('deliveries', /a fixed \{leadTimeDays\}-day lead time\. Every order due by \{last\} arrived on time and in full, in one delivery, with nothing rejected, into location A-01, in pcs/, /交货期固定 \{leadTimeDays\} 天。\{last\} 及之前到期的订单都准时足额、一次到齐、无拒收，收进库位 A-01，单位都是 pcs/)
  says('deliveriesExceptions', /walkthrough scene and the short deliveries/, /演练场景，以及下面供应商发票里的少送/)
  // The app's own suggestion and order-up-to default (W-01, C3), the safety
  // stock and minimum order (L3-15).
  says('thresholds', /Reorder point: the reorder list's own suggestion, enough for \{cover\} days \(lead time plus review\) in 5 of 6 past stretches of the 90 days before\. Order-up-to level: the app's default, the reorder point plus \{reviewDays\} days of average demand\. Safety stock: \{reviewDays\} days of average demand\. Minimum order: \{reviewDays\} days of the average over the data's first \{calibrationDays\} days, rounded up to a multiple of 10 \(at least 10\)/, /再订货点：补货清单自己的建议值，即之前 90 天里 6 段中有 5 段够用 \{cover\} 天（交货期加检查周期）的量。补货目标库存：应用的默认值，再订货点加 \{reviewDays\} 天平均需求。安全库存：\{reviewDays\} 天平均需求。最小订货量：数据前 \{calibrationDays\} 天平均需求的 \{reviewDays\} 天，向上取整到 10 的倍数（至少 10）/)
  // No look-ahead (L14): each review from the days before it; the calibration period.
  says('lookAhead', /set again at each Monday review from the 90 days before it only, so no order was sized with later demand\. The data's first \{calibrationDays\} days are the calibration period/, /每周一检查时只按之前 90 天重新计算，所以没有订单是按之后的需求定量的。数据的前 \{calibrationDays\} 天是校准期/)
  // The line B7 wrote (nearly every item below the suggestion) no longer holds.
  says('belowSuggestion', /^Each item records the figures of its latest review, so the reorder list marks a reorder point below its suggestion only where demand has risen sharply since\.$/, /每个商品记录的是最近一次检查的数，所以只有之后需求明显上升的商品，补货清单才会标出再订货点低于建议值/)
  for (const language of [en, zh]) assert.doesNotMatch(language.get('publicData.belowSuggestion'), /nearly every|几乎每个/)
  // The history by the list's own rule; the opening stock; the after-the-fact raise.
  says('history', /an item due by the reorder list's own rule \(stock plus open orders at or below its reorder point, or above it by less than a day of demand\) was ordered up to its order-up-to level, at least its minimum order; opening stock was the calibration period's order-up-to level\..*more was bought after the fact/, /按补货清单自己的规则到了该订的商品（在库加在途不超过再订货点，或高出不到一天的需求），补到补货目标库存，至少一个最小订货量；期初库存是校准期的补货目标库存。.*事后补买/)
  says('requests', /two in each state \(draft, submitted, approved, converted to a purchase order, rejected, cancelled\), raised by the buyer in the last 14 days for items picked by a fixed hash, each for the item's minimum order; a second person approved or rejected them/, /每种状态各两张（草稿、已提交、已批准、已转采购订单、已驳回、已取消），由买手在最近 14 天内为按固定哈希挑选的商品提出，数量都是该商品的最小订货量；由第二个人批准或驳回/)
  // Whole weeks (L14): the same history on any seed day.
  says('reviewDay', /Dates move by whole weeks, so reviews fall on the data's Mondays and every seed day gives the same history; the data's last days that would fall on or after the seed day \(at most six\) are left out/, /日期按整周平移，所以检查日落在数据里的周一，不论哪天灌数据，采购历史都一样；数据最后几天中会落在灌数据当天或之后的（最多 6 天）不收录/)
  // How the app reads the same figures (L3-16).
  says('appRule', /same rule: the reorder point alone, without the safety stock/, /同一条规则：只看再订货点，不加安全库存/)
  // UCI orders still being filled (L4-34 = L7-24).
  says('uciOpenSales', /the six newest orders without a walkthrough item\. Two are not reserved yet, two are reserved, and two are partly shipped \(the first half of their lines shipped and invoiced\)/, /最新的、不含演练商品的 6 张订单。两张尚未预留，两张已预留，两张部分发货（前一半的行已发货并开票）/)
  // One cost share for every item; how each dataset's price is taken.
  says('uciPurchasePrice', /^Purchase prices: \{percent\}% of each product's median selling price for the year, so they never change\. One share for every product, so gross profit ranks products much as sales do\.$/, /^采购价：每个商品全年售价中位数的 \{percent\}%，全年不变。所有商品同一比例，所以按毛利排序和按销售额排序大致相同。$/)
  says('m5PurchasePrice', /^Purchase prices: \{percent\}% of the store's price on the day of the order, so they fall when the shelf price is cut\. One share for every item/, /^采购价：下单当天门店价的 \{percent\}%，门店降价时采购价也随之下降。所有商品同一比例/)
  // Differences by the match tolerance (B2), reviewed by a second person
  // within 14 days (L7-14, C4); picked by hash.
  says('uciSupplierInvoices', /held at the three-way match only when over its tolerance \(by default the larger of 2% of the line and 1 currency unit\).*picked by a fixed hash, not by supplier\. A second person reviews a held invoice \{resolveFrom\}–\{resolveTo\} days after the match \(a price difference approved, a quantity difference accepted at the received quantity\) and approves it; those held in the last \{resolveTo\} days may still wait/, /只有超过三单匹配的容差（默认取该行金额的 2% 和 1 个货币单位中较大的一个）才会被扣住.*按固定哈希挑选，与供应商无关。被扣住的发票在匹配后 \{resolveFrom\}–\{resolveTo\} 天由第二个人复核（价差批准，数量差按实收数量接受）并批准；最近 \{resolveTo\} 天内被扣住的可能还在等待/)
  for (const language of [en, zh]) assert.doesNotMatch(language.get('publicData.uciSupplierInvoices'), /resolves none|都不处理/)
  says('uciSupplierPayments', /^Approved supplier invoices due by \{last\} were paid on the due date, except \{unpaidPercent\}% of those due in the \{unpaidWithinDays\} days up to \{last\}, left overdue; every older one is paid/, /^已批准、\{last\} 及之前到期的供应商发票在到期日付款，只有截至 \{last\} 的 \{unpaidWithinDays\} 天内到期的有 \{unpaidPercent\}% 未付、已逾期；更早的全部已付/)
  says('uciAssumed', /Those due by \{last\} were paid on the due date; later ones stay open/, /\{last\} 及之前到期的都在到期日收款；之后到期的保持未结/)
  // Item sampling and the moved calendar.
  says('m5Items', /each department's best sellers, so slow sellers are left out/, /各部门的畅销品，慢销商品不在其中/)
  says('uciItems', /sold on at least 30 days, so slow sellers are left out/, /至少 30 天有销售的，慢销商品不在其中/)
  says('weekdays', /^Weekdays and seasons move with the dates: a Saturday in the data is a \{weekday\} here\.$/, /^星期和季节随日期一起平移：数据里的星期六，在这里是\{weekday\}。$/)
  says('weekdaysKept', /weekdays match the data, but holidays and seasons move with the dates/i, /星期与数据一致，但节假日和季节随日期平移/)
  says('scene', /Acme's Tier 1 and the buyer Daniel are an assumed scene for the walkthrough, outside the delivery and purchase history rules above/, /Acme 的 1 级，以及买手 Daniel，都是为演练设定的假设场景，不受上面交货和采购历史规则的约束/)
})

test('the note groups its lines and works out its figures from the note and the seed', async () => {
  const { note } = await noteCopy()
  for (const id of ['public-data-note-data', 'public-data-note-stock', 'public-data-note-money', 'public-data-note-weekdays', 'public-data-note-no-tax', 'public-data-note-supplier-invoices', 'public-data-note-tiers', 'public-data-note-requests', 'public-data-note-open-sales']) assert.ok(note.includes(`"${id}"`), id)
  assert.ok(note.includes('{note.dataset === "uci" && <li data-testid="public-data-note-no-tax">{t("publicData.noTax")}</li>}'))
  assert.ok(note.includes('{note.dataset === "uci" && <li data-testid="public-data-note-open-sales">{t("publicData.uciOpenSales")}</li>}'))
  // Weekdays move by the shift modulo 7; Saturday is the anchor.
  assert.ok(note.includes('const weekdayShift = ((note.shiftDays % 7) + 7) % 7;'))
  assert.ok(note.includes('t("publicData.weekdayNames").split("|")[(SATURDAY + weekdayShift) % 7]'))
  // The suggestion covers lead time + review; the calibration period from the note.
  assert.ok(note.includes('const cover = leadTimeDays + reviewDays;'))
  assert.ok(note.includes('const calibrationDays = note.assumptions.calibrationDays ?? CALIBRATION_DAYS;'))
  // The note's fallbacks are the seed's rules.
  assert.match(note, new RegExp(`^const CALIBRATION_DAYS = ${PUBLIC_DATA_WORKSPACE_ASSUMPTIONS.calibrationDays};$`, 'm'))
  const { daysBefore, tier1Percent, tier2Percent } = PUBLIC_DATA_TIER_RULES
  assert.match(note, new RegExp(`^const TIER_RULES = \\{ daysBefore: ${daysBefore}, tier1Percent: ${tier1Percent}, tier2Percent: ${tier2Percent} \\};$`, 'm'))
  const defaults = Object.fromEntries([...note.matchAll(/(\w+): (\d+)/g)].filter(([, key]) => key in PUBLIC_DATA_SUPPLIER_INVOICE_RULES).map(([, key, value]) => [key, Number(value)]))
  assert.deepEqual(defaults, { ...PUBLIC_DATA_SUPPLIER_INVOICE_RULES })
  // Two requests in each of six states, raised in the last 14 days; six UCI
  // orders still being filled, two of each kind.
  assert.deepEqual({ ...PUBLIC_DATA_PURCHASE_REQUEST_RULES, states: [...PUBLIC_DATA_PURCHASE_REQUEST_RULES.states] }, { states: ['draft', 'submitted', 'approved', 'converted', 'rejected', 'cancelled'], perState: 2, withinDays: 14 })
  assert.deepEqual({ ...PUBLIC_DATA_OPEN_SALES_RULES }, { notReserved: 2, reserved: 2, partlyShipped: 2 })
  // The tolerance the note names is the app's default (design audit B2).
  const review = mergeOperationalSettings().review
  assert.deepEqual([review.pricePercentageTolerance, review.amountTolerance, review.priceAbsoluteTolerance], ['2.0000', '1.0000', '0.0000'])
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
  const { leadTimeDays, reviewDays, reviewWeekday, calibrationDays } = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS
  assert.deepEqual({ leadTimeDays, reviewDays, reviewWeekday, calibrationDays }, { leadTimeDays: 14, reviewDays: 7, reviewWeekday: 1, calibrationDays: 90 })
  // Minimum order rounded up to a multiple of 10, at least 10.
  for (const mean of [0, 0.4, 3.3, 11.68, 40]) {
    const moq = minimumOrderQuantity(mean)
    assert.equal(moq % 10, 0)
    assert.ok(moq >= 10 && moq >= mean * reviewDays)
  }
  // A year whose first 120 days sell 100 a day and the rest 2: the
  // calibration period gives the minimum order, the latest review the
  // recorded figures (the 90 days before it only).
  const daily = Array.from({ length: 364 }, (_, index) => (index < 120 ? 100 : 2))
  const plan = buildPublicDataPlan(m5Extract(daily), 'm5', { seedDay: '2026-11-13' })
  const [item] = plan.items
  assert.equal(item.minimumOrderQuantity, minimumOrderQuantity(100))
  assert.deepEqual({ safetyStock: item.safetyStock, reorderPoint: item.reorderPoint }, { safetyStock: 14, reorderPoint: 42 })
  assert.equal(item.schedule.calibration.reorderPoint, 2100)
  // The shift is whole weeks, so weekdays match the data.
  const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay()
  assert.equal(plan.shiftDays % 7, 0)
  assert.equal(weekday(plan.window.last), weekday(plan.sourceWindow.last))
  // Every order due by the last day arrived on its promised day, in one full delivery.
  for (const order of plan.purchasing.orders.filter((row) => row.promised < plan.days)) {
    assert.equal(order.receipts.length, 1)
    assert.equal(order.receipts[0].index, order.promised)
    assert.deepEqual(order.receipts[0].lines, order.lines.map((line) => ({ itemKey: line.itemKey, quantity: line.quantity })))
  }
  // Opening stock is the calibration period's order-up-to level.
  assert.equal(plan.purchasing.opening[item.key], Math.ceil(item.schedule.calibration.orderUpTo))
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

test('the seed closes a short-delivered order before its match and reviews differences as a second person', async () => {
  const payables = await read('scripts/public-data/seed-payables.mjs')
  // Close (10:30) comes before link and match, never after (design audit B2's close guard).
  const close = payables.indexOf("step('closed', invoice.day, '10:30')")
  assert.ok(close > 0 && close < payables.indexOf("step('matched'"))
  assert.match(payables, /finance\.reviewMatchException\(exception\.id, \{[\s\S]*?\}, reviewerContext\)\)/)
  assert.match(payables, /payable = \(await approve\(finance, id, version, \{ prisma, key, context: approverContext/)
  const seed = await read('scripts/public-data/seed.mjs')
  assert.match(seed, /reviewer: await scenarioApprover\(prisma, tenantId, financeActor, 'finance\.match_exception\.review'\)/)
  assert.match(seed, /approvedById: invoiceApprover\.userId/)
  const requests = await read('scripts/public-data/seed-requests.mjs')
  assert.match(requests, /move\('decide', 'approve', asApprover\)/)
  assert.match(requests, /move\('decide', 'reject', asApprover, REASONS\.rejected\)/)
})
