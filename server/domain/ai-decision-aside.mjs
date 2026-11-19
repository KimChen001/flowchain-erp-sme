// What the user decided on Today, for the assistant's tools that list the
// same records (docs/drafted-decisions-design.md §4.5): an overdue order
// chased or set aside, an item's reorder set aside or covered, an approved
// purchase request set aside, a held supplier invoice set aside or its
// supplier contacted. Keyed by `${entityType}:${recordId}`; empty without
// the decision items table (no database) or when it cannot be read.
//
// Design audit 2026-11-15 (L5-09 = L11-11): only the first two kinds were
// read, so an invoice or a request the user had set aside came back in the
// assistant's answers as something new to do.

export const DECISION_ENTITY = Object.freeze({
  purchase_order_overdue: 'purchase_order',
  reorder_now: 'item',
  purchase_request_to_convert: 'purchase_request',
  bill_exception: 'supplier_invoice',
})

export async function decisionsSetAside(context) {
  const model = context?.prisma?.decisionItem
  if (!model || typeof model.findMany !== 'function' || !context.tenantId) return new Map()
  try {
    const items = await model.findMany({
      where: { tenantId: context.tenantId, state: 'decided', activeKey: { not: null } },
      select: { kind: true, recordId: true, decision: true, reasonCode: true, note: true, returnOn: true, snapshot: true },
    })
    return new Map(items.filter((item) => DECISION_ENTITY[item.kind]).map((item) => [`${DECISION_ENTITY[item.kind]}:${item.recordId}`, {
      decision: item.decision,
      ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
      decidedOn: item.snapshot?.decidedOn || null,
      ...(item.returnOn ? { returnOn: item.returnOn } : {}),
      ...(item.decision === 'chased' && item.note === 'email' ? { emailed: true } : {}),
    }]))
  } catch {
    return new Map()
  }
}

export const asideFor = (aside, entityType, recordId) => (recordId === undefined || recordId === null ? null : aside.get(`${entityType}:${recordId}`) || null)
