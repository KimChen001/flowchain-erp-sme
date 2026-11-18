import { buildDecisionDrafts, followUpSupplierLinkKeys, openRequestsByItem } from '../domain/decision-drafts.mjs'
import { arrangeToday, closableAreas, planDecisionSync } from '../domain/decision-items.mjs'
import { ITEM_SUPPLIER_NAMESPACE, mapItemSupplierRecord } from '../domain/master-data-commands.mjs'
import { createDecisionItemRepository } from '../repositories/decision-item-repository.mjs'

// Today's decision items for one reader (docs/drafted-decisions-design.md §4.7):
// raised, reopened and closed on read from Today's rows, then arranged into
// what waits for a decision (with its draft) and what is set aside. Nothing
// calls a model. Without a database the overview carries
// { available: false } and Today shows its rows as before.

const iso = (value) => (value instanceof Date ? value.toISOString() : value || null)

// The supplier's own part number per "itemId::supplierId", from the active
// item-supplier links with these record keys, for the follow-up drafts. Only
// for the wording: when they cannot be read, the drafts name the SKU alone.
async function readSupplierSkus(prisma, tenantId, keys) {
  if (!keys.length || typeof prisma?.runtimeRecord?.findMany !== 'function') return new Map()
  try {
    const records = await prisma.runtimeRecord.findMany({ where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, recordKey: { in: keys } }, select: { id: true, payload: true } })
    return new Map(records.map((record) => mapItemSupplierRecord(record)).filter((link) => link.active && link.supplierSku).map((link) => [`${link.itemId}::${link.supplierId}`, link.supplierSku]))
  } catch {
    return new Map()
  }
}

function setAsideEntry({ key, row, item }) {
  const snapshot = item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : {}
  return {
    key,
    row,
    decision: item.decision,
    reasonCode: item.reasonCode || null,
    note: item.note || null,
    returnOn: item.returnOn || null,
    decidedAt: iso(item.decidedAt),
    decidedOn: snapshot.decidedOn || null,
    decidedBy: item.decidedBy ? { name: item.decidedBy.name } : null,
    documentType: item.documentType || null,
    documentIds: Array.isArray(snapshot.documents) ? snapshot.documents : item.documentId ? [item.documentId] : [],
    documentNumber: snapshot.documentNumber || null,
  }
}

// canDecide: whether this reader may decide some kind (DECISION_PERMISSIONS);
// the page shows a card's buttons only for the kinds the reader may decide
// (canDecideKinds, added by today-read-service.mjs).
export async function syncTodayDecisions({ prisma, tenantId, rows, today, now = new Date(), timeZone, hidden = [], limitations = [], context = {}, sources = {}, canDecide = false }) {
  const repository = createDecisionItemRepository({ prisma })
  let items = await repository.listLive(tenantId)
  const openRequests = openRequestsByItem(context.purchaseRequests)
  // Coverage counts only for a reader who may see purchase requests: for
  // anyone else the list is empty, which says nothing about coverage.
  const coverageKnown = !hidden.includes('purchasing')
  const coveredItemIds = coverageKnown ? new Set(openRequests.keys()) : null
  const plan = planDecisionSync(items, rows, { today, areas: closableAreas({ hidden, limitations }), coveredItemIds })
  if (plan.create.length || plan.reopen.length || plan.close.length) {
    await repository.applySync(tenantId, plan, { now, today })
    items = await repository.listLive(tenantId)
  }
  // An open reorder item an open purchase request already asks for is
  // recorded as covered, with that request (§4.9), unless a person reopened
  // it from covered: then it stays open for them to decide.
  const rowKeys = new Set(rows.map((row) => `${row.kind}:${row.recordId}`))
  const toCover = coveredItemIds
    ? items.filter((item) => item.state === 'open' && item.kind === 'reorder_now' && rowKeys.has(item.activeKey) && coveredItemIds.has(String(item.recordId)) && item.snapshot?.returnedFrom !== 'covered')
    : []
  if (toCover.length) {
    for (const item of toCover) await repository.markCovered(tenantId, item, openRequests.get(String(item.recordId))[0], { now, today })
    items = await repository.listLive(tenantId)
  }
  const arranged = arrangeToday(rows, items)
  const waitingRows = arranged.waiting.map((entry) => entry.row)
  const supplierSkus = await readSupplierSkus(prisma, tenantId, followUpSupplierLinkKeys(waitingRows, { context, sources }))
  const drafts = buildDecisionDrafts(waitingRows, { context, sources, now, timeZone, supplierSkus })
  return {
    available: true,
    canDecide: Boolean(canDecide),
    waiting: arranged.waiting.map(({ key, row, item }) => ({ key, row, raisedAt: iso(item?.raisedAt), returned: Boolean(item?.snapshot?.returnedOn), draft: drafts[key] || null })),
    setAside: arranged.setAside.map(setAsideEntry),
  }
}
