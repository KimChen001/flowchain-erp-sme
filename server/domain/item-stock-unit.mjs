// The unit an item's stock is kept in, and how two units are compared.
//
// FlowChain records no conversion between units ("12 pcs to a box"), so a
// quantity in one unit can never be turned into another. Every line that
// orders or moves an item's stock is therefore in the item's stock unit:
// purchase request and purchase order lines, receipts and the stock balance.
// A request line is built in the stock unit whatever the item's purchase unit
// says; a line that names another unit is refused, never relabelled, so
// 10 boxes are never booked as 10 pieces.

import { itemStockUnit } from './reorder-list.mjs'

const text = (value) => String(value ?? '').trim()

// The stock unit someone recorded for an Item row; '' when none is.
export { itemStockUnit }

// Units compare by their recorded code, ignoring case and outer spaces.
export const sameUnit = (left, right) => text(left).toLowerCase() === text(right).toLowerCase()

// The first recorded unit among `units` that is not the stock unit, or ''.
// Nothing is judged when the stock unit is not recorded.
export function unitOtherThanStock(stockUnit, units = []) {
  if (!text(stockUnit)) return ''
  return units.map(text).find((unit) => unit && !sameUnit(unit, stockUnit)) || ''
}

// The unit a purchase request line for an item, as the master data repository
// maps it (recordedUnit: the stock unit, '' when none is recorded), is placed
// in: the stock unit, since no conversion from a purchase unit is recorded.
// An item without a recorded stock unit keeps its purchase unit, as before.
export function itemRequestUnit(item) {
  const stockUnit = text(item && Object.hasOwn(item, 'recordedUnit') ? item.recordedUnit : item?.baseUnit)
  return { stockUnit, unit: stockUnit || text(item?.purchaseUnit) || text(item?.baseUnit) }
}
