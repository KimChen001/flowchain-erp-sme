// The unit an item's stock is kept in, and how two units are compared.
//
// FlowChain records no conversion between units ("12 pcs to a box"), so a
// quantity in one unit can never be turned into another. Every line that
// orders or moves an item's stock is therefore in the item's stock unit:
// purchase request and purchase order lines, receipts and the stock balance.
// An item bought in another unit is refused until a conversion can be
// recorded, rather than booking 10 boxes as 10 pieces.

const text = (value) => String(value ?? '').trim()
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// The stock unit someone recorded for an Item row; '' when none is. The same
// reading as recordedItemUnit in db-master-data-repository.mjs.
export function itemStockUnit(item) {
  const meta = isObject(item?.metadata) ? item.metadata : {}
  return text(item?.unit || meta.baseUom || meta.uom)
}

// Units compare by their recorded code, ignoring case and outer spaces.
export const sameUnit = (left, right) => text(left).toLowerCase() === text(right).toLowerCase()

// The first recorded unit among `units` that is not the stock unit, or ''.
// Nothing is judged when the stock unit is not recorded.
export function unitOtherThanStock(stockUnit, units = []) {
  if (!text(stockUnit)) return ''
  return units.map(text).find((unit) => unit && !sameUnit(unit, stockUnit)) || ''
}
