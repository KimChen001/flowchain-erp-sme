// A mention a case can only name once the workspace is read: the number of
// the purchase order waiting for approval, which the seed assigns when it
// runs. A mention with `orderWaitingApproval: { supplier }` also accepts the
// numbers of that supplier's orders pending approval in the workspace, beside
// the words it already accepts (the item's SKU and name). The supplier is
// matched exactly, by name or id, ignoring case and outer spaces (#421
// recheck: a substring over the row's JSON could match another supplier).
// Nothing else changes, and without such an order the mention stays as
// written.
// A mention with `lateOrderOf: { supplier }` also accepts the numbers of
// that supplier's late orders: issued, an open line due before the day the
// case is asked (dueDay < today), and not cancelled or closed (2026-11-21
// today-en: a decision card named Globex's late order, not its item).
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
const supplierOf = (row) => [row.supplierName, row.supplierId, typeof row.supplier === 'string' ? row.supplier : row.supplier?.name, row.supplier?.id]
  .filter((value) => value !== undefined && value !== null && String(value).trim())

const NOT_ISSUED = new Set(['draft', 'pending_approval', 'rejected', 'cancelled', 'closed'])
export const needsWorkspace = (expect) => Array.isArray(expect?.mentions) && expect.mentions.some((entry) => entry?.orderWaitingApproval || entry?.lateOrderOf)

export function withResolvedMentions(expect, orders = [], { today = null } = {}) {
  if (!needsWorkspace(expect)) return expect
  const rows = Array.isArray(orders) ? orders : []
  const mentions = expect.mentions.map((entry) => {
    const wanted = entry?.orderWaitingApproval || entry?.lateOrderOf
    if (!wanted) return entry
    const late = (row) => /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(row.dueDay || '')) && row.dueDay < today && !NOT_ISSUED.has(String(row.status ?? '').trim().toLowerCase())
    const numbers = rows
      .filter((row) => (entry.orderWaitingApproval ? same(row.status, 'pending_approval') : late(row)))
      .filter((row) => String(wanted.supplier ?? '').trim() && supplierOf(row).some((value) => same(value, wanted.supplier)))
      .map((row) => String(row.orderNumber || row.po || row.number || '').trim())
      .filter(Boolean)
    const { orderWaitingApproval: _resolved, lateOrderOf: _late, ...rest } = entry
    return { ...rest, any: [...new Set([...(entry.any || []), ...numbers])] }
  })
  return { ...expect, mentions }
}
