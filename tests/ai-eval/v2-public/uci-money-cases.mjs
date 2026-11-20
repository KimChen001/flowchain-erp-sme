// Money cases on the UCI walkthrough workspace (2026-11-12): sales less the
// cost of what was sold, the month's cash, and the supplier invoices with
// their three-way match, payables and payments. The purchase price and the
// supplier invoices are assumed by the seed's stated rules
// (docs/public-data-workspaces.md); every figure comes from uciFacts.
//
// They come last in the question set: the runner picks the asking user by a
// case's place in the list, so cases added earlier would move every later
// case to the other user.

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places
// Money within 0.1% (at least 1), as in uci-cases.mjs.
const money = (value, label) => ({ label, value, tolerance: round(Math.max(1, value * 0.001)) })

// "None has a difference" in the answer's words, near the word for one
// (#421 review: a bare "no" or "0" anywhere, or in a card, is not it). A 0
// inside a record number (INV-202611-0004) is not one.
const DIFFERENCE_EN = String.raw`(?:differences?|discrepanc(?:y|ies)|mismatch(?:es)?|exceptions?|overcharg\w*|over-?bill\w*|bill(?:s|ed|ing)? (?:for )?more|charg(?:e|es|ed|ing) (?:more|above)|priced above|above the order)`
const ZERO = String.raw`(?<![\w.£$-])0(?![\w.,-])`
export const NO_DIFFERENCE_EN = String.raw`\b(?:no|none|zero|not any|nothing)\b[^.\n]{0,60}${DIFFERENCE_EN}|${ZERO}[^.\n]{0,20}${DIFFERENCE_EN}|${DIFFERENCE_EN}[^.\n]{0,30}(?:\b(?:none|zero)\b|${ZERO})|(?<!\bnot )\ball\b[^.\n]{0,40}\b(?:passed|matched|clean|clear)\b`
export const NO_DIFFERENCE_ZH = String.raw`(?:没有|无|不存在)(?:任何)?[^。\n]{0,12}(?:差异|不一致|超收|多开|高于订单)|差异[^。\n]{0,10}?(?:为|是|有)?\s*(?:${ZERO}|零)\s*(?:张|份|笔)?|(?<![不非未并])(?:全部|都|均)(?!不|没|未)[^。\n]{0,8}(?:匹配|一致|通过)`

// last: the last whole calendar month before the seed day ({ key, en, zh },
// lastWholeMonths in uci-cases.mjs).
export function buildUciMoneyCases(facts, { last }) {
  const cases = []
  const add = (row) => cases.push(row)
  const lastMonth = facts.month(last.key)

  // Sales less the cost of what was sold (units at the assumed purchase
  // price), and the month's cash in and out.
  add({ id: 'gross-profit-en', kind: 'finance', language: 'en-US', turns: [`What was our gross profit in ${last.en}?`],
    expect: { numbers: [money(lastMonth.grossProfit, 'gross profit')] } })
  add({ id: 'gross-margin-zh', kind: 'finance', language: 'zh-CN', turns: [`${last.zh}的毛利率是多少？`],
    expect: { numbers: [{ label: '毛利率 %', value: lastMonth.grossMarginPercent, tolerance: 0.5 }] } })
  const lastCash = facts.cash(last.key)
  add({ id: 'cash-month-en', kind: 'finance', language: 'en-US', turns: [`How much cash came in from customers and went out to suppliers in ${last.en}?`],
    expect: { numbers: [money(lastCash.received, 'from customers'), money(lastCash.paid, 'to suppliers')] } })

  // Supplier invoices and payables.
  const invoices = facts.supplierInvoices
  if (!invoices) return cases
  const invoiceNamed = (row) => ({ label: row.number, any: [row.number] })
  // None with a difference is said as "none" as often as "0" (2026-11-20).
  add({ id: 'invoice-match-en', kind: 'payables', language: 'en-US', turns: ['How many supplier invoices passed the three-way match, and how many have differences?'],
    expect: invoices.match.exception
      ? { numbers: [{ label: 'matched', value: invoices.match.matched }, { label: 'with differences', value: invoices.match.exception }] }
      : { numbers: [{ label: 'matched', value: invoices.match.matched }, { label: 'with differences', value: 0, inWords: NO_DIFFERENCE_EN }] } })
  // With no difference open (the C12 seed reviews them), the answer says
  // there is none rather than giving reasons (2026-11-20).
  if (!invoices.differences.length) {
    add({ id: 'invoice-differences-zh', kind: 'payables', language: 'zh-CN', turns: ['哪些供应商发票有差异？是什么原因？'],
      expect: { numbers: [{ label: '有差异的发票数', value: 0, inWords: NO_DIFFERENCE_ZH }] } })
  } else {
    add({ id: 'invoice-differences-zh', kind: 'payables', language: 'zh-CN', turns: ['哪些供应商发票有差异？是什么原因？'],
      expect: {
        numbers: [{ label: '有差异的发票数', value: invoices.differences.length }],
        matches: [{ label: '说到价格高于订单', pattern: '单价|价格|价差|高于订单' }, { label: '说到开票数量多于收货', pattern: '数量|少送|短缺|多于收货|超出收货|未收到' }],
      } })
  }
  // A kind with no difference left open (the C12 seed reviews most of them,
  // design audit C12) expects the answer to say there is none.
  const none = { numbers: [{ label: 'invoices with that difference', value: 0, inWords: NO_DIFFERENCE_EN }] }
  add({ id: 'invoice-price-en', kind: 'payables', language: 'en-US', turns: ['Which supplier invoices charge more than the order price?'],
    expect: invoices.priceDifferences.length ? { mentions: [invoiceNamed(invoices.priceDifferences[0])], numbers: [{ label: 'invoices priced above the order', value: invoices.priceDifferences.length }] } : none })
  add({ id: 'invoice-quantity-en', kind: 'payables', language: 'en-US', turns: ['Which supplier invoices bill for more than we received?'],
    expect: invoices.quantityDifferences.length ? { mentions: [invoiceNamed(invoices.quantityDifferences[0])], numbers: [{ label: 'invoices billing more than received', value: invoices.quantityDifferences.length }] } : none })
  add({ id: 'payables-owed-en', kind: 'payables', language: 'en-US', turns: ['How much do we owe our suppliers right now?'],
    expect: { numbers: [money(invoices.owed.total, 'owed to suppliers')] } })
  add({ id: 'payables-overdue-zh', kind: 'payables', language: 'zh-CN', turns: ['有哪些供应商发票已经逾期没付？一共多少钱？'],
    expect: { mentions: invoices.overdue.invoices.map(invoiceNamed), numbers: [{ label: '逾期张数', value: invoices.overdue.count }, money(invoices.overdue.total, '逾期金额')] } })
  add({ id: 'supplier-paid-month-en', kind: 'payables', language: 'en-US', turns: [`How much did we pay suppliers in ${last.en}?`],
    expect: { numbers: [money(invoices.paidIn(last.key), 'paid to suppliers')] } })
  add({ id: 'not-invoiced-en', kind: 'payables', language: 'en-US', turns: ['Which deliveries have we received but not been invoiced for yet?'],
    expect: { numbers: [{ label: 'receipts not invoiced', value: invoices.notInvoiced.count }] } })
  return cases
}
