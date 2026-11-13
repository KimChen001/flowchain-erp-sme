
// Analysis tool 3 (owner decision 3 of 2026-10-07): what a late purchase order
// puts at risk. "What will a delay of PO-001 affect?", "If PO-001 is late,
// which customers are hit?", PO-001 延误会影响哪些客户？, and on a purchase
// order's page "What will a delay affect?". With no order named, the overdue
// orders together: "What do the late orders put at risk?"
//
// In the inventory page's own terms (runtime-inventory-allocation-read-model):
// a SKU's available to promise is its available stock plus what open orders
// bring, less the open sales demand not yet reserved. If the late lines do not
// arrive, their remaining quantity drops out of available to promise. Where
// that leaves it below zero, the open sales orders for that SKU cannot all
// ship: the answer says by how much more they fall short, and names those
// orders, their customers and the days promised to them (readers of sales
// orders only). A named order is judged on its own; the overdue orders are
// judged together, per SKU, since two late orders for one SKU can each be
// covered alone and not together. A line in another unit than the item's
// stock unit was never counted as coming (the inventory page leaves it out
// too), so its delay changes nothing. No dates are guessed: the answer does
// not say which customer order ships first.

const LATE_LISTED = 3
const ORDERS_LISTED = 3
const array = (value) => Array.isArray(value) ? value : []

// The effect on one SKU of the lines of these orders not arriving.
function skuImpact(sku, pos, facts) {
  const row = array(facts.inventory?.rows).find((entry) => entry.sku === sku) || null
  const lines = pos.flatMap((po) => array(po.openLines).filter((line) => line.sku === sku).map((line) => ({ po, line })))
  const remaining = lines.reduce((sum, { line }) => sum + (Number(line.remaining) || 0), 0)
  const unit = lines.find(({ line }) => line.unit)?.line.unit || row?.unit || null
  const base = { sku, itemId: row?.itemId || null, pos, unit, remaining }
  if (!row || row.availableToPromise === null || row.availableToPromise === undefined) return { ...base, known: false }
  const counted = lines.filter(({ po }) => array(row.purchaseOrderIds).includes(po.id))
  const lost = counted.reduce((sum, { line }) => sum + (Number(line.remaining) || 0), 0)
  const atp = row.availableToPromise
  const without = atp - lost
  const orders = array(facts.salesOrders)
    .map((order) => ({ ...order, open: array(order.lines).filter((entry) => entry.sku === sku).reduce((sum, entry) => sum + entry.open, 0) }))
    .filter((order) => order.open > 0)
    .sort((a, b) => (a.promisedDate || '9999').localeCompare(b.promisedDate || '9999') || a.number.localeCompare(b.number))
  return { ...base, known: true, counted: counted.length > 0, lost, atp, without, added: Math.max(0, -without) - Math.max(0, -atp), orders }
}

const skusOf = (pos) => [...new Set(pos.flatMap((po) => array(po.openLines).map((line) => line.sku).filter(Boolean)))]

export function runLateOrderImpact(facts, { route = null } = {}) {
  const base = { skillId: 'late_order_impact' }
  if (!facts?.purchaseOrders || !facts?.inventory) return { ...base, hidden: true }
  const index = array(facts.purchaseOrders.index)
  const find = (id) => index.find((row) => row.id === id || row.orderNumber === id) || null
  // The orders the question names, else the purchase order of the page it is
  // asked on (the page's chip "What will a delay affect?").
  const named = array(route?.entities?.purchaseOrders).length
    ? array(route.entities.purchaseOrders).map((row) => find(row.id) || row)
    : route?.focus?.entityType === 'purchase_order' ? [find(route.focus.entityId)].filter(Boolean) : []
  const salesVisible = Array.isArray(facts.salesOrders)
  const late = index.filter((row) => row.isOpen && (row.overdueDays || 0) > 0).sort((a, b) => b.overdueDays - a.overdueDays || a.orderNumber.localeCompare(b.orderNumber))
  // Whether a group leaves out every late line of its SKU, so its figure is
  // the one for "without the late lines".
  const everyLate = (group) => {
    const lateForSku = late.filter((po) => skusOf([po]).includes(group.sku))
    return { ...group, coversEveryLateLine: lateForSku.length > 0 && lateForSku.every((po) => group.pos.some((row) => row.id === po.id)) }
  }
  if (named.length) {
    // Each named order on its own, and a SKU on more than one named order for
    // them together too (2026-11-09 on Flash: two named late orders for
    // 85123A gave two rows, 288 and 168, with nothing to say which order each
    // left out, and the answer called one "without the late lines"; without
    // both it was 48).
    const each = named.flatMap((po) => skusOf([po]).map((sku) => skuImpact(sku, [po], facts)))
    const together = skusOf(named)
      .map((sku) => ({ sku, pos: named.filter((po) => skusOf([po]).includes(sku)) }))
      .filter(({ pos }) => pos.length > 1)
      .map(({ sku, pos }) => ({ ...skuImpact(sku, pos, facts), together: true }))
    return { ...base, mode: 'named', salesVisible, groups: [...each, ...together].map(everyLate), pos: named }
  }
  // The overdue orders together, per SKU.
  const groups = skusOf(late).map((sku) => skuImpact(sku, late.filter((po) => skusOf([po]).includes(sku)), facts))
    .sort((a, b) => (b.added || 0) - (a.added || 0) || a.sku.localeCompare(b.sku))
    .map(everyLate)
  return { ...base, mode: 'late', salesVisible, groups, pos: late, more: Math.max(0, groups.length - LATE_LISTED) }
}
