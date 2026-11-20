// The promise revisions recorded supplier replies wrote, read the one way the
// reliability measure and record_history's read-back both use (#400 review):
// by the reply's revisionIds, else by the revision audit rows whose origin is
// the reply, as the reply service finds a record already written. Each row
// comes with its reply's id (replyId); supplierReplyRecordedDates
// (supplier-reply-outcome.mjs) turns a reply's rows into its dates by line.
// replies: SupplierReply rows with { id, state, revisionIds }, of one tenant.
const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])

export async function readRecordedReplyRevisions(prisma, tenantId, replies) {
  const recorded = array(replies).filter((reply) => text(reply.state) === 'recorded')
  if (!recorded.length) return []
  const owner = new Map()
  for (const reply of recorded) for (const id of array(reply.revisionIds).map(text).filter(Boolean)) owner.set(id, text(reply.id))
  const unknown = recorded.filter((reply) => !array(reply.revisionIds).length).map((reply) => text(reply.id))
  if (unknown.length) {
    const rows = await prisma.auditLog.findMany({ where: { tenantId, action: 'purchase_order_promise_revised', OR: unknown.map((id) => ({ metadata: { path: ['origin', 'id'], equals: id } })) }, select: { metadata: true } })
    for (const row of array(rows)) if (text(row.metadata?.revisionId) && unknown.includes(text(row.metadata?.origin?.id))) owner.set(text(row.metadata.revisionId), text(row.metadata.origin.id))
  }
  if (!owner.size) return []
  const rows = await prisma.purchaseOrderPromiseRevision.findMany({ where: { tenantId, id: { in: [...owner.keys()] } }, select: { id: true, purchaseOrderLineId: true, newDate: true, createdAt: true } })
  return array(rows).map((row) => ({ ...row, replyId: owner.get(text(row.id)) }))
}
