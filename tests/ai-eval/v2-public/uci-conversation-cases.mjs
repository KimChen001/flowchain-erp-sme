// Conversation cases on the UCI walkthrough workspace (2026-11-11, the
// owner's list of what counts as a problem: a wrong or off-target answer,
// invented data, mixed Chinese and English, the wrong cards or buttons, a
// document that should have opened and did not). They check what the answer
// shows and links, not only its figures:
//   documents  an order asked for opens a filled-in request form (the user's
//              item ticked at their quantity); an item open orders cover, or
//              no item named, opens nothing ticked; a record asked for is
//              linked (the owner's decision 10 of 2026-10-04, and never pick
//              the item when none is named)
//   cards      the cards a question calls for
//   language   a switch the user asks for holds for the turns after it
//   invented   what the records do not hold is said to be missing, not made
//              up (customer names, a phone number, 2024 prices, an item that
//              does not exist, a forecast, a margin)
//   followup   a turn that leans on the one before, a correction, an edit to
//              the form already shown
// Figures come from uciFacts, as in uci-cases.mjs.
import { lastWholeMonths } from './uci-cases.mjs'

const named = (row) => ({ label: row.sku, any: [row.sku, row.name] })
// A phone number: digits in groups.
const PHONE = String.raw`\+?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}`
// What is missing, said as missing.
const MISSING_EN = String.raw`\b(?:no|not|isn't|is not|aren't|doesn't|does not|don't|do not|cannot|can't|couldn't|unable|without|only)\b`
const MISSING_ZH = String.raw`没有|未记录|无记录|不记录|找不到|查不到|不包含|不在|无法|并无|没记|未提供|只有`

export function buildUciConversationCases(facts) {
  const hero = facts.item(facts.scene.hero.sku)
  const second = facts.item(facts.scene.second.sku)
  const cake = facts.item(facts.scene.reorder.sku)
  const acme = hero.supplier
  const { last, before } = lastWholeMonths(facts.seedDay)
  const lastMonth = facts.month(last.key)
  const monthBefore = facts.month(before.key)
  const runnerUp = lastMonth.customers[1]
  const cases = []
  const add = (row) => cases.push(row)

  // Documents: an order opens a filled-in form; a record asked for is linked.
  add({ id: 'order-cakestands-en', kind: 'documents', language: 'en-US', turns: ['Order 100 cakestands'],
    expect: { ui: { has: ['pr_form'] }, formLines: [{ sku: cake.sku, quantity: 100, checked: true }] } })
  add({ id: 'order-cake-zh', kind: 'documents', language: 'zh-CN', turns: ['帮我订 60 个蛋糕架'],
    expect: { ui: { has: ['pr_form'] }, formLines: [{ sku: cake.sku, quantity: 60, checked: true }] } })
  add({ id: 'order-none-named-zh', kind: 'documents', language: 'zh-CN', turns: ['帮我下个单'], expect: { formNoneChecked: true } })
  add({ id: 'order-covered-en', kind: 'documents', language: 'en-US', turns: [`Order more ${hero.sku}`],
    expect: { formNoneChecked: true, matches: [{ label: 'says open orders cover it', pattern: String.raw`PO-\d{6}-\d{4}|\b${hero.onOrder}\b|on order|open (?:purchase )?orders?|cover` }] } })
  add({ id: 'open-late-globex-en', kind: 'documents', language: 'en-US', turns: ['Open the late Globex purchase order'],
    expect: { refs: [{ type: 'purchase_order' }], mentions: [named(second)] } })
  add({ id: 'show-supplier-en', kind: 'documents', language: 'en-US', turns: ['Which purchase orders are late?', 'Show me the supplier of the oldest one'],
    expect: { refs: [{ type: 'supplier', label: 'Acme' }] } })
  add({ id: 'approve-card-en', kind: 'documents', language: 'en-US', turns: ['Approve the purchase order that is waiting for approval'],
    expect: { ui: { has: ['record_actions'] }, notMatches: [{ label: 'claims it approved', pattern: String.raw`\b(?:I(?:'ve| have)|has been|is now|was)\s+approved\b` }] } })

  // Cards.
  add({ id: 'late-table-en', kind: 'cards', language: 'en-US', turns: ['Show the late purchase orders as a table'], expect: { ui: { has: ['table'] } } })
  add({ id: 'reorder-unticked-en', kind: 'cards', language: 'en-US', turns: ['What should I reorder this week?'], expect: { formNoneChecked: true } })

  // Language: a switch the user asks for holds.
  add({ id: 'switch-to-zh', kind: 'language', language: 'en-US', turns: ['What should I reorder this week?', '用中文说', `${second.sku} 呢？`],
    expect: { language: 'zh-CN', languages: ['en-US', 'zh-CN', 'zh-CN'] } })
  add({ id: 'switch-to-en', kind: 'language', language: 'zh-CN', turns: ['今天我应该先处理什么？', 'in English please', 'and the cakestand?'],
    expect: { language: 'en-US', languages: ['zh-CN', 'en-US', 'en-US'] } })
  add({ id: 'zh-names-only', kind: 'language', language: 'zh-CN', turns: [`${acme} 有哪些订单逾期了？`], expect: { mentions: [named(hero)] } })

  // Invented data: what the records do not hold is said to be missing.
  add({ id: 'customer-name-en', kind: 'invented', language: 'en-US', turns: ['What is the company name of customer 14096?'],
    expect: { matches: [{ label: 'says no name is recorded', pattern: MISSING_EN }], notMatches: [{ label: 'a company name', pattern: String.raw`\b(?:Ltd|Limited|LLC|Inc|GmbH|plc)\b` }] } })
  add({ id: 'supplier-phone-en', kind: 'invented', language: 'en-US', turns: [`What is the phone number for ${acme}?`],
    expect: { matches: [{ label: 'says no phone is recorded', pattern: MISSING_EN }], notMatches: [{ label: 'a phone number', pattern: PHONE }] } })
  add({ id: 'contact-phone-zh', kind: 'invented', language: 'zh-CN', turns: ['Globex 的联系电话是多少？'],
    expect: { matches: [{ label: '说没有记录', pattern: MISSING_ZH }], notMatches: [{ label: '电话号码', pattern: PHONE }] } })
  add({ id: 'price-2024-zh', kind: 'invented', language: 'zh-CN', turns: [`${hero.sku} 在 2024 年的采购价是多少？`],
    expect: { matches: [{ label: '说没有 2024 年的记录', pattern: MISSING_ZH }] } })
  add({ id: 'missing-item-en', kind: 'invented', language: 'en-US', turns: ['How many of SKU 99999 do we have in stock?'],
    expect: { matches: [{ label: 'says it is not found', pattern: String.raw`\b(?:no|not|couldn't|can't|cannot|doesn't|does not)\b` }], notMatches: [{ label: 'a stock figure for it', pattern: String.raw`99999[^.\n]{0,40}\b\d+\s*(?:pcs|units)` }] } })
  add({ id: 'forecast-en', kind: 'invented', language: 'en-US', turns: ['Forecast our sales for next quarter'],
    expect: { matches: [{ label: 'says what it is based on, or that it cannot', pattern: String.raw`\b(?:based on|at the (?:recorded|shipped|current) rate|if (?:the|demand|sales)|assum|no (?:sales )?forecast|not a forecast|(?:doesn't|does not|don't|do not) (?:hold|have|record|keep) (?:a |any )?(?:sales )?forecast|isn't something|can(?:no|')t (?:forecast|predict)|cannot (?:forecast|predict))` }] } })
  add({ id: 'margin-en', kind: 'invented', language: 'en-US', turns: [`What is our gross margin on ${hero.sku}?`],
    expect: { matches: [{ label: 'says the purchase price is assumed, or that no margin is recorded', pattern: String.raw`assum|same as|equal|not meaningful|no (?:separate |real )?(?:cost|purchase price)|proxy|no (?:gross )?margin|(?:doesn't|does not) record` }] } })

  // Follow-ups.
  add({ id: 'correction-en', kind: 'followup', language: 'en-US', turns: [`How much ${hero.sku} do we have in stock?`, `no, I meant ${second.sku}`],
    expect: { numbers: [{ label: 'on hand', value: second.onHand }], mentions: [named(second)] } })
  add({ id: 'and-september-en', kind: 'followup', language: 'en-US', turns: [`How many ${hero.sku} did we sell in ${last.en}?`, `and in ${before.en.split(' ')[0]}?`],
    expect: { numbers: [{ label: 'units sold', value: monthBefore.unitsOf(hero.sku) }] } })
  add({ id: 'second-customer-en', kind: 'followup', language: 'en-US', turns: [`Who were our top 3 customers by sales in ${last.en}?`, 'What did the second one buy the most of?'],
    expect: { mentions: [{ label: runnerUp.topItem.sku, any: [runnerUp.topItem.sku, facts.item(runnerUp.topItem.sku).name] }], numbers: [{ label: 'units', value: runnerUp.topItem.units }] } })
  add({ id: 'form-edit-en', kind: 'followup', language: 'en-US', turns: ['Order 100 cakestands', 'make it 120'],
    expect: { formLines: [{ sku: cake.sku, quantity: 120, checked: true }] } })
  add({ id: 'form-add-line-en', kind: 'followup', language: 'en-US', turns: ['Order 100 cakestands', `add 150 of ${second.sku} too`],
    expect: { formLines: [{ sku: cake.sku, quantity: 100 }, { sku: second.sku, quantity: 150 }] } })
  add({ id: 'that-one-zh', kind: 'followup', language: 'zh-CN', turns: ['有哪些采购订单逾期了？', '那张 Globex 的还差多少没到？'],
    expect: { numbers: [{ label: '还差', value: second.onOrder }] } })
  return cases
}
