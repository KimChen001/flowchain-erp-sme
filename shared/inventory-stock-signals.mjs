// The inventory pages' stock signals, set against the reorder list so the two
// never disagree. Two separate questions:
//
//   need replenishment       the reorder list's "order now": the item's stock
//                            position (on hand - reserved + every open purchase
//                            order line, late or not) is at or below its
//                            recorded reorder point (server/domain/reorder-list.mjs).
//                            Taken from the reorder list's own rows, never
//                            worked out again here.
//   below safety (on hand)   the stock on hand, available over every location
//                            shown, is under the item's safety stock, whether or
//                            not orders are coming. The shelf is low; it is
//                            "covered by open orders" when the item does not
//                            need replenishment and has stock incoming.
//
// The safety stock and reorder point are one figure for the whole item, so the
// available stock is added over every location of the item, as the reorder
// list adds it. A reader the reorder list cannot judge (it sees only some
// warehouses), or a list that could not be read, has no position: the pages
// then show the on-hand signal only and say the position is unknown.

const text = (value) => String(value ?? '').trim()
const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export const STOCK_STATES = Object.freeze(['out', 'replenish', 'below_safety', 'ok'])

// balances: the stock records shown (availableQuantity, onHandQuantity,
// safetyStock, reorderPoint per row). reorderList: the reorder list response
// ({ rows, notJudged }), or null when it could not be read.
export function inventoryStockSignals({ balances = [], reorderList = null } = {}) {
  const rows = Array.isArray(reorderList?.rows) ? reorderList.rows : null
  const reorderBySku = rows ? new Map(rows.map((row) => [text(row.sku), row])) : null
  const notJudged = new Set((Array.isArray(reorderList?.notJudged) ? reorderList.notJudged : []).map((row) => text(row.sku)))
  const signals = new Map()
  for (const balance of Array.isArray(balances) ? balances : []) {
    const sku = text(balance.sku)
    if (!sku) continue
    const signal = signals.get(sku) || { sku, available: 0, safetyStock: number(balance.safetyStock), reorderPoint: number(balance.reorderPoint) }
    signal.available += number(balance.availableQuantity ?? balance.onHandQuantity)
    signals.set(sku, signal)
  }
  for (const signal of signals.values()) {
    const row = reorderBySku?.get(signal.sku) || null
    // Known when the list was read and judged this item (a row, or no row because
    // it is above its reorder point); unknown when the list could not judge it.
    signal.positionKnown = Boolean(reorderBySku) && !notJudged.has(signal.sku)
    signal.position = row ? number(row.position) : null
    signal.incoming = row ? number(row.incoming) : null
    signal.needsReplenishment = signal.positionKnown && Boolean(row?.orderNow)
    signal.belowSafetyOnHand = signal.safetyStock > 0 && signal.available < signal.safetyStock
    signal.coveredByOpenOrders = signal.belowSafetyOnHand && signal.positionKnown && !signal.needsReplenishment && (signal.incoming ?? 0) > 0
    signal.warned = signal.needsReplenishment || signal.belowSafetyOnHand
  }
  return signals
}

// The one chip a stock row shows: nothing at this row's location, need
// replenishment (the item's position), below safety stock on hand (the item),
// or enough.
export function stockStateOf(signal, row = null) {
  const available = row ? number(row.availableQuantity ?? row.onHandQuantity) : number(signal?.available)
  const onHand = row ? number(row.onHandQuantity) : available
  if (available <= 0 && onHand <= 0) return 'out'
  if (signal?.needsReplenishment) return 'replenish'
  if (signal?.belowSafetyOnHand) return 'below_safety'
  return 'ok'
}

// The cards over the warned items: each SKU once.
export function stockSignalCounts(signals) {
  const all = [...(signals?.values?.() || [])]
  const warned = all.filter((signal) => signal.warned)
  return {
    warned: warned.length,
    needsReplenishment: all.filter((signal) => signal.needsReplenishment).length,
    belowSafetyOnHand: all.filter((signal) => signal.belowSafetyOnHand).length,
    coveredByOpenOrders: all.filter((signal) => signal.coveredByOpenOrders).length,
    noneAvailable: warned.filter((signal) => signal.available <= 0).length,
    positionUnknown: all.some((signal) => !signal.positionKnown),
  }
}
