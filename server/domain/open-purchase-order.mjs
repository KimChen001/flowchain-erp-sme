import { isPurchaseOrderReceivable } from './procurement-status-authority.mjs'

// The single definition of an open purchase order in FlowChain reporting:
// a purchase order that has been committed to the supplier and still has
// quantity to receive.
//
//   committed      status is approved, issued or partially_received after alias
//                  normalisation, i.e. isPurchaseOrderReceivable. A draft or a
//                  purchase order pending approval is not yet a commitment to the
//                  supplier. Rejected, cancelled and fully received orders are
//                  finished.
//   still to       at least one line has remaining quantity. A line whose ordered
//   receive        or received quantity is unknown counts as open, so incomplete
//                  data is surfaced by the report instead of silently dropped. A
//                  committed order with no lines is open, because nothing shows
//                  that it has been received.
//
// Every open purchase order count and total uses this: the overview card, the
// open purchase orders report and its amount totals, the analytics KPI, the
// supplier risk table and saved report views. They previously carried six
// separate copies, and several counted drafts, pending approvals or fully
// received orders as open.

const quantity = (value) => (
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
)

// Remaining quantity on one purchase order line, rounded to four decimals as the
// quantity columns are stored. null when either quantity is unknown.
export function purchaseOrderLineRemaining(line) {
  const ordered = quantity(line?.orderedQuantity ?? line?.quantity)
  const received = quantity(line?.receivedQuantity)
  if (ordered === null || received === null) return null
  return Math.round(Math.max(0, ordered - received) * 10000) / 10000
}

export function isOpenPurchaseOrder(purchaseOrder) {
  if (!isPurchaseOrderReceivable(purchaseOrder?.status)) return false
  const lines = Array.isArray(purchaseOrder?.lines) ? purchaseOrder.lines : []
  if (!lines.length) return true
  return lines.some((line) => {
    const remaining = purchaseOrderLineRemaining(line)
    return remaining === null || remaining > 0
  })
}
