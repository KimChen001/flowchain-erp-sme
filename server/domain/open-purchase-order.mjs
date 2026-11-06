import { PURCHASE_ORDER_STATUS, isPurchaseOrderReceivable, normalizeProcurementAuthorityStatus } from './procurement-status-authority.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay } from './tenant-calendar-day.mjs'

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

// A calendar day in YYYY-MM-DD form, or '' when the value is not a real date.
export function reportCalendarDay(value) {
  const candidate = String(value ?? '').trim().slice(0, 10)
  const parsed = new Date(`${candidate}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : ''
}

// The business date of a purchase order in every report: its order date, or
// its creation date when no order date is recorded. Never the last update,
// which moved an old order into the current month whenever it was edited.
// The order date is a calendar day; the creation date is an instant and
// counts on its day in the workspace timezone. '' when neither is known, so a
// date range leaves the order out.
export function purchaseOrderBusinessDate(purchaseOrder, timeZone = DEFAULT_TENANT_TIMEZONE) {
  return reportCalendarDay(purchaseOrder?.orderDate) || instantCalendarDay(purchaseOrder?.createdAt, timeZone)
}

// Remaining quantity on one purchase order line, rounded to four decimals as the
// quantity columns are stored. null when either quantity is unknown.
export function purchaseOrderLineRemaining(line) {
  const ordered = quantity(line?.orderedQuantity ?? line?.quantity)
  const received = quantity(line?.receivedQuantity)
  if (ordered === null || received === null) return null
  return Math.round(Math.max(0, ordered - received) * 10000) / 10000
}

// A committed purchase order is spend the business has agreed with the
// supplier: approved, issued, partially received or fully received after alias
// normalisation. Drafts and pending approvals are not agreed yet; rejected and
// cancelled orders never will be. Committed spend totals use this, so they do
// not count 130000 of drafts and cancellations next to 1000 of real orders.
export function isCommittedPurchaseOrder(purchaseOrder) {
  if (isPurchaseOrderReceivable(purchaseOrder?.status)) return true
  try {
    return [PURCHASE_ORDER_STATUS.FULLY_RECEIVED, PURCHASE_ORDER_STATUS.CLOSED].includes(normalizeProcurementAuthorityStatus('purchaseOrder', purchaseOrder?.status))
  } catch {
    return false
  }
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
