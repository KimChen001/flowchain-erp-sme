// Price history: what the workspace paid on its own purchase orders for one
// item, shown beside a price a person is entering or reviewing. Rules only,
// from recorded purchase order lines; nothing here fills in a price.
//
//   which lines   lines with an item and a unit price, on POs that were issued
//                 (or received without being issued). Drafts, pending,
//                 rejected and cancelled POs never count.
//   which date    the PO's issue date; without one, its order (creation) date,
//                 labelled as such: issued with the date not recorded, or
//                 received without being issued in FlowChain (received from
//                 "approved"). Days are workspace days.
//   order         date, newest first; then PO id, then line id. Each line is
//                 its own fact, also when several are on one PO.
//   what matches  the same item, the same unit (trimmed, case-insensitive)
//                 and the same currency. Prices in another unit or currency
//                 are named, never converted or compared.
//   average       quantity-weighted (sum of price x quantity / sum of
//                 quantity) over the last 3 matching lines with an ordered
//                 quantity above 0; shown only when 2 or more lines count.
//
// Every figure is a purchase order price, not a paid price: it is what was
// ordered, not what an invoice settled.

export const PRICE_HISTORY_EARLIER_LIMIT = 2
export const PRICE_HISTORY_AVERAGE_LIMIT = 3
export const PRICE_HISTORY_MAX_KEYS = 50
export const PRICE_HISTORY_STATUSES = Object.freeze(['issued', 'partially_received', 'fully_received', 'closed'])

const text = (value) => String(value ?? '').trim()
const unitKey = (value) => text(value).toLowerCase()
const currencyKey = (value) => text(value).toUpperCase()

// Prices and quantities are stored with four decimals; arithmetic runs on
// whole ten-thousandths as BigInt so nothing is lost to floating point.
const SCALE = 10000n
export function decimalUnits(value) {
  if (value === null || value === undefined || value === '') return null
  const raw = typeof value === 'object' && typeof value.toString === 'function' ? value.toString() : String(value)
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw.trim())
  if (!match) {
    const number = Number(raw)
    if (!Number.isFinite(number)) return null
    return decimalUnits(number.toFixed(4))
  }
  const [, sign, whole, fraction = ''] = match
  const digits = fraction.padEnd(5, '0')
  // Round half away from zero at the fourth decimal.
  let units = BigInt(whole) * SCALE + BigInt(digits.slice(0, 4)) + (Number(digits[4]) >= 5 ? 1n : 0n)
  if (sign) units = -units
  return units
}

export function decimalString(units) {
  if (units === null || units === undefined) return null
  const negative = units < 0n
  const absolute = negative ? -units : units
  return `${negative ? '-' : ''}${absolute / SCALE}.${String(absolute % SCALE).padStart(4, '0')}`
}

// a / b rounded half away from zero, for positive b.
const divideRounded = (a, b) => (a >= 0n ? (a * 2n + b) / (2n * b) : -((-a * 2n + b) / (2n * b)))

const instantOf = (value) => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date : null
}

// One key per item, unit and currency, as the forms send it: "itemId|unit|currency".
export function parsePriceHistoryKey(value) {
  const [itemId = '', unit = '', currency = ''] = String(value ?? '').split('|')
  return { itemId: text(itemId), unit: text(unit), currency: currencyKey(currency) }
}

export function priceHistoryKeyString({ itemId, unit, currency } = {}) {
  return `${text(itemId)}|${text(unit)}|${currencyKey(currency)}`
}

// Received straight from "approved": the PO was never issued in FlowChain.
const receivedWithoutIssue = (line) =>
  text(line.status) !== 'issued' && text(line.receivingBaseStatus).toLowerCase() === 'approved'

// A stored line as a dated fact. `dayOf` turns an instant into a workspace day.
export function priceFact(line, dayOf = (instant) => instant.toISOString().slice(0, 10)) {
  const issued = instantOf(line.issuedAt)
  const ordered = instantOf(line.createdAt)
  const instant = issued || ordered
  const dateSource = issued ? 'issue_date' : receivedWithoutIssue(line) ? 'order_date_not_issued' : 'order_date'
  return {
    purchaseOrderId: text(line.purchaseOrderId),
    orderNumber: text(line.orderNumber) || text(line.purchaseOrderId),
    lineId: text(line.lineId),
    supplierId: text(line.supplierId) || null,
    supplierName: text(line.supplierName) || null,
    unit: text(line.unit) || null,
    currency: currencyKey(line.currency) || null,
    unitPrice: decimalString(decimalUnits(line.unitPrice)),
    orderedQuantity: decimalString(decimalUnits(line.orderedQuantity)),
    date: instant ? dayOf(instant) : null,
    dateSource,
    instant: instant ? instant.toISOString() : null,
  }
}

// Newest first by issue date (or order date), then PO id, then line id.
export function comparePriceFacts(left, right) {
  const a = left.instant || ''
  const b = right.instant || ''
  if (a !== b) return a < b ? 1 : -1
  if (left.purchaseOrderId !== right.purchaseOrderId) return left.purchaseOrderId < right.purchaseOrderId ? -1 : 1
  if (left.lineId !== right.lineId) return left.lineId < right.lineId ? -1 : 1
  return 0
}

// The quantity-weighted average price of up to the last 3 lines, counting
// only lines with a price and an ordered quantity above 0. Null below 2 lines.
export function weightedAverage(facts, limit = PRICE_HISTORY_AVERAGE_LIMIT) {
  let amount = 0n
  let quantity = 0n
  let n = 0
  for (const fact of facts.slice(0, limit)) {
    const price = decimalUnits(fact.unitPrice)
    const ordered = decimalUnits(fact.orderedQuantity)
    if (price === null || ordered === null || ordered <= 0n) continue
    amount += price * ordered
    quantity += ordered
    n += 1
  }
  if (n < 2 || quantity <= 0n) return null
  return { unitPrice: decimalString(divideRounded(amount, quantity)), n }
}

// The history for one item, unit and currency from purchase order lines
// (any lines; those of other items are ignored). `itemUnit` is the unit
// recorded on the item, used when the key names none.
export function priceHistoryForKey(lines, key, { dayOf, itemUnit = '' } = {}) {
  const itemId = text(key?.itemId)
  const currency = currencyKey(key?.currency)
  const unit = text(key?.unit) || text(itemUnit)
  const itemLines = (Array.isArray(lines) ? lines : [])
    .filter((line) => text(line.itemId) === itemId && itemId && decimalUnits(line.unitPrice) !== null)
  const facts = itemLines
    .map((line) => priceFact(line, dayOf))
    .sort(comparePriceFacts)
  const sameCurrency = facts.filter((fact) => fact.currency === currency)
  const matching = unit ? sameCurrency.filter((fact) => fact.unit && unitKey(fact.unit) === unitKey(unit)) : []
  const distinct = (values) => [...new Set(values)].sort()
  // The query keeps only the latest lines of each unit, so it also carries
  // the full count of lines without a unit for the item and currency.
  const carriedUnitless = itemLines
    .filter((line) => currencyKey(line.currency) === currency)
    .map((line) => Number(line.unitNotRecordedCount))
    .filter((count) => Number.isInteger(count) && count >= 0)
  const result = {
    key: priceHistoryKeyString({ itemId, unit: text(key?.unit), currency }),
    itemId,
    unit: unit || null,
    unitSource: text(key?.unit) ? 'entered' : unit ? 'item' : 'not_recorded',
    currency: currency || null,
    status: !unit ? 'unit_not_recorded' : matching.length ? 'found' : 'none',
    latest: matching[0] || null,
    earlier: matching.slice(1, 1 + PRICE_HISTORY_EARLIER_LIMIT),
    average: weightedAverage(matching),
    // Earlier purchases named but never compared: another currency, another
    // unit in this currency, or no unit recorded.
    otherCurrencies: distinct(facts.filter((fact) => fact.currency && fact.currency !== currency).map((fact) => fact.currency)),
    otherUnits: unit ? distinct(sameCurrency.filter((fact) => fact.unit && unitKey(fact.unit) !== unitKey(unit)).map((fact) => fact.unit)) : distinct(sameCurrency.filter((fact) => fact.unit).map((fact) => fact.unit)),
    unitNotRecordedCount: Math.max(sameCurrency.filter((fact) => !fact.unit).length, ...carriedUnitless),
  }
  return result
}

// Hides every price for a reader without procurement.prices.read: dates, PO
// numbers and suppliers stay, prices and the average become null.
export function maskPriceHistory(history) {
  const hide = (fact) => (fact ? { ...fact, unitPrice: null } : fact)
  return {
    ...history,
    latest: hide(history.latest),
    earlier: history.earlier.map(hide),
    average: history.average ? { ...history.average, unitPrice: null } : null,
    restrictedFields: ['unitPrice'],
  }
}

// A quoted price set against the item's own purchase order history in the
// same currency and unit: the change from the last PO price as a signed
// percentage with one decimal, and the weighted average. Facts only: no
// judgement, ranking or action.
export function compareQuote({ unitPrice, history } = {}) {
  if (!history) return { status: 'no_earlier_po' }
  if (history.status === 'unit_not_recorded') return { status: 'not_comparable', reason: 'unit_not_recorded' }
  const quote = decimalUnits(unitPrice)
  if (!history.latest) {
    if (history.otherCurrencies.length) return { status: 'not_comparable', reason: 'currency', values: history.otherCurrencies }
    if (history.otherUnits.length) return { status: 'not_comparable', reason: 'unit', values: history.otherUnits }
    if (history.unitNotRecordedCount) return { status: 'not_comparable', reason: 'unit_not_recorded' }
    return { status: 'no_earlier_po' }
  }
  const base = decimalUnits(history.latest.unitPrice)
  const average = history.average
  // A masked PO price is hidden for the reader's role; a quote line without
  // a price simply has nothing to compare.
  if (base === null) return { status: 'hidden', lastPo: history.latest, average }
  if (quote === null) return { status: 'no_quote_price', lastPo: history.latest, average }
  if (base === 0n) return { status: 'zero_base', lastPo: history.latest, average }
  // Tenths of a percent, rounded half away from zero.
  const tenths = divideRounded((quote - base) * 1000n, base)
  const sign = tenths > 0n ? '+' : tenths < 0n ? '-' : ''
  const absolute = tenths < 0n ? -tenths : tenths
  return { status: 'compared', lastPo: history.latest, percent: `${sign}${absolute / 10n}.${absolute % 10n}`, average }
}
