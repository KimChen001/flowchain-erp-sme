// A mention a case can only name once the workspace is read: the number of
// the purchase order waiting for approval, which the seed assigns when it
// runs. A mention with `orderWaitingApproval: { supplier }` also accepts the
// numbers of that supplier's orders pending approval in the workspace, beside
// the words it already accepts (the item's SKU and name). The supplier is
// matched exactly, by name or id, ignoring case and outer spaces (#421
// recheck: a substring over the row's JSON could match another supplier).
// Nothing else changes, and without such an order the mention stays as
// written.
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
const supplierOf = (row) => [row.supplierName, row.supplierId, typeof row.supplier === 'string' ? row.supplier : row.supplier?.name, row.supplier?.id]
  .filter((value) => value !== undefined && value !== null && String(value).trim())

export function withResolvedMentions(expect, orders = []) {
  if (!expect || !Array.isArray(expect.mentions) || !expect.mentions.some((entry) => entry?.orderWaitingApproval)) return expect
  const rows = Array.isArray(orders) ? orders : []
  const mentions = expect.mentions.map((entry) => {
    const wanted = entry?.orderWaitingApproval
    if (!wanted) return entry
    const numbers = rows
      .filter((row) => same(row.status, 'pending_approval'))
      .filter((row) => String(wanted.supplier ?? '').trim() && supplierOf(row).some((value) => same(value, wanted.supplier)))
      .map((row) => String(row.orderNumber || row.po || row.number || '').trim())
      .filter(Boolean)
    const { orderWaitingApproval: _resolved, ...rest } = entry
    return { ...rest, any: [...new Set([...(entry.any || []), ...numbers])] }
  })
  return { ...expect, mentions }
}
