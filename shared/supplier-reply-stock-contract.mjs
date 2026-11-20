// What a supplier reply's new dates do to stock: the "Stock:" line on the
// reply card (docs/supplier-reply-dates-design.md §4.6). The projection is in
// server/domain/supplier-reply-stock.mjs; the read in
// server/services/supplier-reply-stock-read-service.mjs.
//
//   GET /api/procurement/orders/:id/supplier-replies/:replyId/stock
//       ?dates=<lineId>:<YYYY-MM-DD>,...
//
// dates: the dates the card would record, per purchase order line (edited or
// answered ones included); omitted, the reply's proposed dates. Reading
// follows the reply card's (the order's read permission); the stock needs
// inventory.balance.read as well, without which the answer is
// { available: false, reason: 'inventory_hidden' } and the card shows no line.
// Errors are the reply routes' (shared/supplier-reply-contract.mjs).
import { z } from 'zod'

export const SUPPLIER_REPLY_STOCK_CONTRACT_VERSION = 1
export const SUPPLIER_REPLY_STOCK_ROUTE = '/api/procurement/orders/:id/supplier-replies/:replyId/stock'
// At most this many lines in `dates`, as a record takes (supplierReplyRecordRequestSchema).
export const SUPPLIER_REPLY_STOCK_MAX_LINES = 200

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// One SKU whose stock the new dates make worse before its new date:
//   kind      short: available stock below zero; below_reorder_point: below
//             the item's reorder point (more severe first)
//   from      the first day it is so, on the new dates (the order's dates
//             now would not have reached it by then)
//   newDate   the reply's date for the SKU's lines (the last, with several)
//   basis     the demand it was projected on: the open sales orders by the
//             day promised to the customer, the average shipped per day over
//             the last 90 days, or null when there is neither (available
//             stock against the reorder point)
export const supplierReplyStockEffectSchema = z.strictObject({
  sku: z.string().min(1),
  itemName: z.string().nullable(),
  unit: z.string().nullable(),
  kind: z.enum(['short', 'below_reorder_point']),
  from: day,
  newDate: day,
  basis: z.enum(['open_sales_orders', 'recorded_rate']).nullable(),
  reorderPoint: z.number().nullable(),
})

export const supplierReplyStockResponseSchema = z.strictObject({
  contractVersion: z.literal(SUPPLIER_REPLY_STOCK_CONTRACT_VERSION),
  asOf: day,
  available: z.boolean(),
  reason: z.enum(['inventory_hidden']).nullable(),
  effects: z.array(supplierReplyStockEffectSchema),
})

// "L1:2026-11-28,L2:2026-12-01" → [{ lineId, date }], or null when it is not
// that shape.
export function parseSupplierReplyStockDates(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  const entries = raw.split(',').map((entry) => {
    const at = entry.lastIndexOf(':')
    return at > 0 ? { lineId: entry.slice(0, at).trim(), date: entry.slice(at + 1).trim() } : null
  })
  if (entries.length > SUPPLIER_REPLY_STOCK_MAX_LINES || entries.some((entry) => !entry || !entry.lineId || entry.lineId.length > 120 || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date))) return null
  return entries
}
export const supplierReplyStockDatesParam = (lines) => lines.map((line) => `${line.purchaseOrderLineId}:${line.promisedDate}`).sort().join(',')
