import { isCommittedPurchaseOrder, isOpenPurchaseOrder } from './open-purchase-order.mjs'

// Header figures for the Purchase orders page. They use the report
// definitions in open-purchase-order.mjs, so the page and the reports agree:
//
//   committed value   the total of committed orders (approved, issued,
//                     partially or fully received), one total per currency.
//                     Drafts, pending approvals, rejected and cancelled orders
//                     are not spend, and currencies are never added together.
//                     An order without a currency is totalled under ''.
//   open orders       committed orders that still have quantity to receive.
const units = (value) => {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 10000) : 0
}

export function purchaseOrderWorkbenchSummary(purchaseOrders = []) {
  const orders = Array.isArray(purchaseOrders) ? purchaseOrders : []
  const committed = orders.filter(isCommittedPurchaseOrder)
  const byCurrency = new Map()
  for (const order of committed) {
    const currency = String(order.currency || '').trim().toUpperCase()
    const entry = byCurrency.get(currency) || { currency, units: 0, orderCount: 0 }
    entry.units += units(order.totalAmount ?? order.amount)
    entry.orderCount += 1
    byCurrency.set(currency, entry)
  }
  const openPurchaseOrderIds = orders.filter(isOpenPurchaseOrder).map((order) => order.po || order.id)
  return {
    definition: 'committed_purchase_orders',
    committedOrderCount: committed.length,
    committedValueByCurrency: [...byCurrency.values()]
      .sort((a, b) => b.orderCount - a.orderCount || a.currency.localeCompare(b.currency))
      .map(({ currency, units: total, orderCount }) => ({ currency, amount: total / 10000, orderCount })),
    openOrderCount: openPurchaseOrderIds.length,
    openPurchaseOrderIds,
  }
}
