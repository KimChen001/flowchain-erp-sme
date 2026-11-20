// Draft cases from "Don't record: wrong reading" (docs/supplier-reply-dates-design.md
// §7 "Afterwards"): each supplier reply a person dismissed as wrongly read
// becomes a draft in the case format of cases.mjs, with the expected outcome
// left empty for a person to fill. scripts/supplier-reply-draft-cases.mjs
// reads the rows from a workspace's database and calls this.
//
// Public-data workspaces only (DD-7): there the replies are written by us. A
// draft keeps what the model read and what the checks made of it under
// `draft`, which is removed when the case is moved into a batch.
import { tenantCalendarDay } from '../../../server/domain/tenant-calendar-day.mjs'
import { WRITTEN_BY } from './cases.mjs'

export const DRAFT_DATASETS = Object.freeze(['uci', 'm5'])

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const quantity = (value) => {
  const number = Number(String(value ?? ''))
  return Number.isFinite(number) ? number : null
}
const iso = (value) => (value ? new Date(value).toISOString() : null)

export const isWrongReading = (row) => row?.state === 'not_recorded' && row?.reasonCode === 'wrong_reading'

// The order as the reading saw it, as near as the database still tells it:
// every line, in the order the order read gives them (by line id), with the
// refs L1, L2, ... A line's promised date is the one the reading was given
// (the check's currentDate) when the check kept it, else the line's date now.
// What is current rather than as read goes into notes.
function orderSnapshot(order, check) {
  const notes = []
  const checked = new Map(array(check?.lines).filter((line) => line.purchaseOrderLineId).map((line) => [line.purchaseOrderLineId, line]))
  const lines = [...array(order.lines)].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((line, at) => {
    const ref = `L${at + 1}`
    const seen = checked.get(line.id)
    if (seen?.ref && seen.ref !== ref) notes.push(`The check called line ${line.id} ${seen.ref}; it is ${ref} here.`)
    const ordered = quantity(line.orderedQuantity)
    const received = quantity(line.receivedQuantity) || 0
    return {
      ref,
      purchaseOrderLineId: line.id,
      sku: text(line.sku) || null,
      supplierSku: null,
      itemName: text(line.itemName) || null,
      remaining: ordered === null ? null : Math.max(0, ordered - received),
      unit: text(line.unit) || null,
      promisedDate: seen?.currentDate || text(line.metadata?.promisedDate) || text(order.expectedDay) || null,
    }
  })
  notes.push('Remaining quantities and any promised date the check did not keep are as the order stands now; supplier SKUs are not filled.')
  return {
    snapshot: { id: order.id, number: text(order.number) || order.id, supplierName: text(order.supplierName) || null, status: text(order.status), lines },
    notes,
  }
}

// replies   SupplierReply rows (only the wrong readings are used)
// orders    Map of purchase order id -> { id, number, supplierName, status,
//           expectedDay, lines: [{ id, sku, itemName, unit, orderedQuantity,
//           receivedQuantity, metadata }] }
// dataset   'uci' or 'm5': the workspace's public-data note
// timeZone  the workspace's, for the day the reply was pasted
export function supplierReplyWrongReadingDrafts({ replies = [], orders = new Map(), dataset, timeZone } = {}) {
  if (!DRAFT_DATASETS.includes(dataset)) throw new Error('Draft cases come from public-data workspaces (UCI or M5) only.')
  return replies.filter(isWrongReading).sort((a, b) => String(a.receivedOn).localeCompare(String(b.receivedOn)) || String(a.id).localeCompare(String(b.id))).flatMap((row) => {
    const order = orders.get(row.purchaseOrderId)
    if (!order) return []
    const { snapshot, notes } = orderSnapshot(order, row.check)
    // The reply as pasted: the quote cleaning hid is put back after it, so
    // the case's cleaning runs on the same text.
    const replyText = row.quotedTextHidden && text(row.quotedText) ? `${row.text}\n\n${row.quotedText}` : row.text
    return [{
      id: `draft-${dataset}-${snapshot.number}-${String(row.id).slice(0, 8)}`,
      lang: /[㐀-鿿]/.test(row.text || '') ? 'zh' : 'en',
      workspace: dataset,
      writtenBy: WRITTEN_BY,
      // For the person: one line on what the case tests, and its tags.
      about: '',
      covers: [],
      replyDate: row.receivedOn,
      today: tenantCalendarDay(new Date(row.createdAt), timeZone),
      replyText,
      order: snapshot,
      heldOut: false,
      // For the person: the outcome the reading and its checks should give
      // (state, lines, flags), as in cases.mjs.
      expected: null,
      draft: {
        replyId: row.id,
        decidedAt: iso(row.decidedAt),
        note: row.note || null,
        readingStatus: row.readingStatus,
        provider: row.provider || null,
        model: row.model || null,
        promptVersion: row.promptVersion || null,
        reading: row.reading ?? null,
        check: row.check ?? null,
        notes,
      },
    }]
  })
}
