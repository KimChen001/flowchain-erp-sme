import { instantCalendarDay } from './tenant-calendar-day.mjs'

// The days an item ended with nothing on hand, over a window of past days,
// worked back from the stock on hand now through the inventory movements
// posted since. The stock at the end of a day is the stock now less every
// movement after that day (quantity in minus quantity out). A transfer
// between warehouses moves stock out of one and into another, so it cancels
// out; an adjustment or a count records its change as quantity in or out.
//
// Why (2026-11-08): the order plan takes shipped quantities as demand. On a
// day with no stock nothing ships, however many customers asked, so the
// history understates the demand of an item that ran out. The plan says so;
// it does not guess the demand that was lost.
//
//   onHandNow     the item's on-hand quantity now, in its stock unit
//   movements     { day, quantityIn, quantityOut }, day a workspace calendar day
//   days          the window's days, oldest first, consecutive
//   firstDay      the item's first movement day ever: earlier window days are
//                 not counted, since its stock was not tracked yet
//
// stockoutDays counts the tracked window days whose end-of-day stock is 0 or
// less. It is null, with a reason, when the history cannot be used:
//   stock_not_tracked           the item has no movement at all
//   stock_history_inconsistent  working back gives a negative stock on a
//                               tracked day, so the movements and the balance
//                               disagree
export const STOCK_HISTORY_REASONS = Object.freeze({
  notTracked: 'stock_not_tracked',
  inconsistent: 'stock_history_inconsistent',
})

const TOLERANCE = 1e-6

export function stockoutDays({ onHandNow, movements = [], days = [], firstDay = null } = {}) {
  if (!firstDay) return { stockoutDays: null, trackedDays: 0, reason: STOCK_HISTORY_REASONS.notTracked }
  const net = new Map()
  for (const movement of movements) {
    if (!movement?.day) continue
    const change = (Number(movement.quantityIn) || 0) - (Number(movement.quantityOut) || 0)
    net.set(movement.day, (net.get(movement.day) || 0) + change)
  }
  const last = days.at(-1)
  // The stock at the end of the window's last day: now, less what moved after it.
  let stock = Number(onHandNow) || 0
  for (const [day, change] of net) if (last !== undefined && day > last) stock -= change
  let count = 0
  let tracked = 0
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index]
    if (day >= firstDay) {
      if (stock < -TOLERANCE) return { stockoutDays: null, trackedDays: 0, reason: STOCK_HISTORY_REASONS.inconsistent }
      tracked += 1
      if (stock <= TOLERANCE) count += 1
    }
    // The end of the day before: less what moved on this day.
    stock -= net.get(day) || 0
  }
  return { stockoutDays: count, trackedDays: tracked, reason: null }
}

// A movement's workspace day: its business date when it has one, else when it
// was recorded.
export function movementDay(row, timeZone) {
  const at = row?.movementDate || row?.occurredAt
  return at ? instantCalendarDay(at, timeZone) || null : null
}
