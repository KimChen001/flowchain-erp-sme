// A mention a case can only name once the workspace is read: the number of
// the purchase order waiting for approval, which the seed assigns when it
// runs. A mention with `orderWaitingApproval: { supplier }` also accepts the
// numbers of that supplier's orders pending approval in the workspace, beside
// the words it already accepts (the item's SKU and name). Nothing else
// changes, and without such an order the mention stays as written.
export function withResolvedMentions(expect, orders = []) {
  if (!expect || !Array.isArray(expect.mentions) || !expect.mentions.some((entry) => entry?.orderWaitingApproval)) return expect
  const rows = Array.isArray(orders) ? orders : []
  const mentions = expect.mentions.map((entry) => {
    const wanted = entry?.orderWaitingApproval
    if (!wanted) return entry
    const supplier = String(wanted.supplier || '').toLowerCase()
    const numbers = rows
      .filter((row) => String(row.status || '').toLowerCase() === 'pending_approval')
      .filter((row) => supplier && JSON.stringify([row.supplierName, row.supplier]).toLowerCase().includes(supplier))
      .map((row) => String(row.orderNumber || row.po || row.number || '').trim())
      .filter(Boolean)
    const { orderWaitingApproval: _resolved, ...rest } = entry
    return { ...rest, any: [...new Set([...(entry.any || []), ...numbers])] }
  })
  return { ...expect, mentions }
}
