// A FlowChain workspace instance from public demand data, for research and
// evaluation (owner direction 2026-11-06: tune the assistant against real
// demand patterns; FlowChain is a research project). Two sources, extracted
// by the research scripts (.local/research/interactive-optimization, local
// only, git-ignored):
//   - M5 (Walmart daily unit sales, store CA_1): data/public/m5/extract.json,
//     sets m5_main (FOODS_3, steady) and m5_intermittent (HOUSEHOLD_1).
//   - UCI Online Retail II (a UK online gift retailer):
//     data/public/uci-extract.json.
// Each item keeps its 90 days of daily demand and its price [public data].
// Everything a buyer would also need is an assumption, labelled as such, with
// the research instances' rules (public_data.py), so FlowChain's answers can
// be checked against the research results:
//   lead time   14 days; review period 7 days
//   MOQ         one week of average demand, rounded up to a multiple of 10
//   on hand     average demand over the lead time (rounded); nothing on order
//   reorder pt  average demand over lead time + review period (days of cover)
//   safety      a week of average demand
//   price       the public price, used as the purchase price [proxy]
// No data file is kept in this repository; pass the extract's path.
import { readFileSync } from 'node:fs'

export const PUBLIC_DATA_ASSUMPTIONS = Object.freeze({
  leadTimeDays: 14,
  reviewDays: 7,
  holdingRatePercent: 25,
  shortageToHolding: 5,
  budgetShare: 0.6,
})

export const PUBLIC_DATA_SETS = Object.freeze({
  m5_main: { source: 'm5', label: 'M5 CA_1 FOODS_3 (steady demand)', currency: 'USD', category: 'FOODS_3' },
  m5_intermittent: { source: 'm5', label: 'M5 CA_1 HOUSEHOLD_1 (intermittent demand)', currency: 'USD', category: 'HOUSEHOLD_1' },
  uci: { source: 'uci', label: 'UCI Online Retail II (UK online gift retailer)', currency: 'GBP', category: 'Gifts' },
})

const round2 = (value) => Math.round(value * 100) / 100

// Where each set's extract sits in the research data folder
// (.local/research/interactive-optimization/data/public).
export const publicDataExtractPath = (directory, setName) => `${String(directory).replace(/[\\/]+$/, '')}/${PUBLIC_DATA_SETS[setName]?.source === 'uci' ? 'uci-extract.json' : 'm5/extract.json'}`

// The sets named in a comma-separated list, read from the research data folder.
export function readPublicDataInstances(directory, list) {
  const names = String(list || 'm5_main,m5_intermittent').split(',').map((name) => name.trim()).filter(Boolean)
  return names.map((name) => readPublicDataInstance(publicDataExtractPath(directory, name), name))
}

// One item's figures from its daily demand and price.
export function publicDataItem({ sku, name, price, daily, category }) {
  const days = daily.length
  const units = daily.reduce((total, quantity) => total + quantity, 0)
  const mean = units / days
  const { leadTimeDays: lead, reviewDays: review } = PUBLIC_DATA_ASSUMPTIONS
  return {
    sku,
    name,
    category,
    unit: 'units',
    price: round2(price),
    daily: [...daily],
    days,
    units,
    saleDays: daily.filter((quantity) => quantity > 0).length,
    averageDailyDemand: mean,
    // [assumed], the research rules (see the header).
    minimumOrderQuantity: Math.max(10, Math.ceil((7 * mean) / 10) * 10),
    onHand: Math.round(mean * lead),
    reorderPoint: Math.round(mean * (lead + review)),
    safetyStock: Math.round(mean * 7),
    leadTimeDays: lead,
  }
}

// The instance for one set, read from the extract file.
export function readPublicDataInstance(path, setName) {
  const set = PUBLIC_DATA_SETS[setName]
  if (!set) throw new Error(`Unknown public data set ${setName}; use one of ${Object.keys(PUBLIC_DATA_SETS).join(', ')}.`)
  const extract = JSON.parse(readFileSync(path, 'utf8'))
  let rows
  let window
  if (set.source === 'm5') {
    const source = extract.sets?.[setName]
    if (!source) throw new Error(`${path} has no M5 set ${setName}.`)
    rows = source.items.map((row) => ({ sku: row.item_id, name: `${row.item_id} (M5 ${extract.store})`, price: Number(row.price), daily: row.daily.map(Number) }))
    window = { first: extract.window.first_date, last: extract.window.last_date }
  } else {
    if (!Array.isArray(extract.items)) throw new Error(`${path} is not a UCI extract.`)
    rows = extract.items.map((row) => ({ sku: `UCI-${row.code}`, name: String(row.name || row.code).toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()), price: Number(row.price), daily: row.daily.map(Number) }))
    window = { first: extract.days[0], last: extract.days.at(-1) }
  }
  const items = rows.map((row) => publicDataItem({ ...row, category: set.category }))
  if (!items.length || items.some((item) => item.days !== items[0].days)) throw new Error(`${path} ${setName}: every item needs the same number of days.`)
  return { set: setName, label: set.label, currency: set.currency, window, days: items[0].days, items }
}
