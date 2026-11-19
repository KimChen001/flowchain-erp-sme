import { DOCUMENT_NUMBER_TYPES } from '../../shared/document-numbering.mjs'
import { aiToolRef, defineAiTool } from './ai-read-tool-contract.mjs'
import { scopedBusiness } from './ai-read-service-tools.mjs'
import { receiptsNotInvoiced } from './ai-assistant-v2-money-tools.mjs'
import { aiSkillPurchaseOrderNotSent } from './ai-skill-signals.mjs'
import { invoiceExceptionDraft } from './invoice-exception-draft.mjs'
import { buildOpenPurchaseOrdersReport, purchaseOrderReportLine } from './open-purchase-orders-report.mjs'
import { billPaymentStatus, outstandingPayableWhere } from './operational-finance-read-service.mjs'
import { settledMatchStatus } from './procurement-read-model.mjs'
import { normalizeProcurementAuthorityStatus, PURCHASE_ORDER_STATUS, PURCHASE_REQUEST_STATUS, RFQ_STATUS } from './procurement-status-authority.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { buildRuntimeEvidenceIndex } from './runtime-evidence-graph.mjs'
import { billNextStep } from './today-work.mjs'
import { readHeldInvoiceDifferences } from './today-work-read-service.mjs'

// One document's chain in one read (owner 2026-11-18, after comparing
// FlowChain with Pallet's knowledge graph): "why is INV-SUP-22-0049 held?" or
// "what happened to PR-202611-0001?" took several tool calls, each reading
// one kind of document. trace_document_chain walks the evidence graph
// (runtime-evidence-graph.mjs, the one /api/evidence-graph serves) from the
// purchase request, RFQ, purchase order, receipt or supplier invoice named,
// and returns the linked documents in process order with their links and the
// open points the app's own rules give:
//
//   chain        the anchor, what it came from and what came of it, and for
//                each purchase order among them its request, RFQ, receipts
//                and invoices; at most CHAIN_LIMITS.depth links from the
//                anchor and CHAIN_LIMITS.nodes documents, nearest first; cut
//                says so when the walk stopped
//   states       a purchase order as the open purchase orders report reads it
//                (open, due date, days overdue, each line's remaining
//                quantity); a supplier invoice's next step as Today and the
//                bills page give it (billNextStep), its match status as the
//                procurement read model settles it (settledMatchStatus: a
//                match inside the tolerance, design audit B2, is matched),
//                its payment status as the bill list shows it
//                (billPaymentStatus), and a held invoice's differences as
//                Today's prepared step reads them (readHeldInvoiceDifferences,
//                invoiceExceptionDraft)
//   open points  derived here in code, never by the model
//
// Only what the reader may read: the business read context scoped as the
// evidence graph route scopes it (scopeBusinessContext: a collection the role
// cannot read is empty, prices, invoice amounts and invoice suppliers are null
// without their permissions), receipts only in the reader's warehouses (as
// the receipt list keeps them), payables with finance.payable.read. A document
// the reader cannot read is neither shown nor walked through; notShown names
// the kinds of document the role cannot read, whether or not the chain has
// one. The customer side (sales orders, shipments, customer invoices,
// returns) is not in the evidence graph's links and is left out.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
const day = (value) => {
  const raw = value instanceof Date ? (Number.isNaN(value.getTime()) ? '' : value.toISOString()) : text(value)
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null
}
const daysLate = (due, today) => (due && today && due < today ? Math.floor((Date.parse(today) - Date.parse(due)) / 86400000) : 0)
const can = (context, permission) => Boolean(context?.actor?.permissionCodes?.has?.(permission))

// chars: the result's budget, under the assistant's 24,000-character cap on
// a tool result (resultChars), which this tool has no limit argument to meet.
export const CHAIN_LIMITS = Object.freeze({ depth: 4, nodes: 25, lines: 10, openPoints: 15, differences: 5, chars: 20000 })
const CANDIDATES = 5

// The documents of a chain, in process order: the evidence graph's type, the
// business read context's collection, the type the result names and the
// subject a hidden collection is named by.
const KINDS = Object.freeze({
  purchase_request: { stage: 0, collection: 'purchaseRequests', type: 'purchase_request', subject: 'purchase_requests' },
  rfq: { stage: 1, collection: 'rfqs', type: 'rfq', subject: 'rfqs' },
  purchase_order: { stage: 2, collection: 'purchaseOrders', type: 'purchase_order', subject: 'purchase_orders' },
  receiving_doc: { stage: 3, collection: 'receipts', type: 'receipt', subject: 'receipts' },
  supplier_invoice: { stage: 4, collection: 'supplierInvoices', type: 'supplier_invoice', subject: 'supplier_invoices' },
})
// The evidence graph's links between documents, upstream to downstream;
// sourced_from_pr is converted_to_po read backwards.
const RELATIONS = new Set(['sourced_by_rfq', 'awarded_to_po', 'converted_to_po', 'received_by', 'invoiced_by'])
const PARTIAL_NOTE = 'Only the latest documents of these kinds were read: an older linked document may be missing.'

const numberOf = (kind, row) => text(({
  purchase_request: row.number,
  rfq: row.number,
  purchase_order: row.number || row.orderNumber,
  receiving_doc: row.documentNumber,
  supplier_invoice: row.invoiceNumber,
})[kind]) || text(row.id)

const keyOf = (kind, id) => `${kind}:${fold(id)}`

// A record number as its prefix (letters and digits before the sequence,
// without separators) and its sequence without zero padding: PO-202611-0012
// is { prefix: 'po202611', number: 12 }.
function numbered(value) {
  const match = fold(value).match(/^(.*?)(\d+)$/)
  return match ? { prefix: match[1].replace(/[\s_-]+/g, ''), number: Number(match[2]) } : null
}

// The documents the reader may see that the asked number names: by number or
// id, else by the number's end ("0049"), else by its type prefix and sequence
// without the period or zero padding ("PO-0001" or "PO-1" for PO-202611-0001);
// each step only when it finds any.
function documentsNamed(documents, query) {
  const wanted = fold(query)
  if (!wanted) return []
  const exact = documents.filter((entry) => fold(entry.number) === wanted)
  if (exact.length) return exact
  const byId = documents.filter((entry) => fold(entry.node.entityId) === wanted)
  if (byId.length) return byId
  const ending = documents.filter((entry) => fold(entry.number).endsWith(`-${wanted}`))
  if (ending.length) return ending
  const asked = numbered(wanted)
  if (!asked || !asked.prefix) return []
  return documents.filter((entry) => {
    const own = numbered(entry.number)
    return own && own.number === asked.number && own.prefix.startsWith(asked.prefix)
  })
}

// The numbering prefixes of documents this tool does not cover
// (shared/document-numbering.mjs), and AP-, the payable number it prints with
// a supplier invoice: a number with one of them is another kind of document,
// not a missing one.
const COVERED_TYPES = new Set(['purchase_request', 'rfq', 'purchase_order', 'receiving_document'])
const COVERS = 'This tool reads purchase requests, RFQs, purchase orders, receipts and supplier invoices.'
const OTHER_PREFIXES = new Map([
  ...DOCUMENT_NUMBER_TYPES.filter((row) => !COVERED_TYPES.has(row.type)).map((row) => [fold(row.prefix), `${row.prefix}- is a ${row.document.toLowerCase()} number. ${COVERS}`]),
  ['ap', 'AP- is the number of a supplier invoice\'s payable: trace that invoice.'],
])
// The detail for a number of another kind of document, or null.
function otherDocumentDetail(query) {
  const prefix = fold(query).match(/^([a-z]+)[\s_-]*\d/)?.[1]
  return prefix ? OTHER_PREFIXES.get(prefix) || null : null
}

// The documents within `depth` links of the starts, following `adjacency`;
// cut is true when a document at the last step links further.
function reach(starts, adjacency, depth) {
  const seen = new Set(starts)
  let frontier = [...starts]
  let cut = false
  for (let step = 0; step < depth && frontier.length; step += 1) {
    const next = []
    for (const key of frontier) for (const other of adjacency.get(key) || []) if (!seen.has(other)) { seen.add(other); next.push(other) }
    frontier = next
  }
  for (const key of frontier) if ((adjacency.get(key) || []).some((other) => !seen.has(other))) cut = true
  return { keys: seen, cut }
}

// The walk over the scoped business context: the anchor the number names and
// the documents of its chain, nearest first. { error, candidates? } when the
// number names none or several.
export function walkDocumentChain(business, { document, limits = CHAIN_LIMITS } = {}) {
  const index = buildRuntimeEvidenceIndex({
    purchaseRequests: business.purchaseRequests, rfqs: business.rfqs, purchaseOrders: business.purchaseOrders,
    receipts: business.receipts, supplierInvoices: business.supplierInvoices,
  })
  const documents = index.nodes.filter((node) => KINDS[node.entityType]).map((node) => ({ node, row: index.rowOf(node), number: numberOf(node.entityType, index.rowOf(node)) }))
  const named = documentsNamed(documents, document)
  if (!named.length) {
    // Another kind of document's number (a sales order, a shipment, a
    // payable): said as such, so the answer does not call it missing.
    const other = otherDocumentDetail(document)
    return other ? { error: 'not_supported', details: [other] } : { error: 'not_found' }
  }
  if (named.length > 1) {
    return {
      error: 'ambiguous',
      candidates: named.slice(0, CANDIDATES).map((entry) => ({
        type: KINDS[entry.node.entityType].type, number: entry.number, status: text(entry.row.status) || null,
        supplier: text(entry.row.supplierName || entry.row.supplierSnapshot?.supplierName) || null,
        ref: aiToolRef(entry.node.entityType, entry.node.entityId, entry.number),
      })),
      ...(named.length > CANDIDATES ? { details: [`${named.length} documents have this number; ${named.length - CANDIDATES} more are not listed. Ask for the full number.`] } : {}),
    }
  }
  const byKey = new Map(documents.map((entry) => [keyOf(entry.node.entityType, entry.node.entityId), entry]))
  const down = new Map()
  const up = new Map()
  const both = new Map()
  const links = []
  const push = (map, from, to) => { if (map.has(from)) map.get(from).push(to); else map.set(from, [to]) }
  for (const edge of index.edges) {
    if (!RELATIONS.has(edge.relation) || !KINDS[edge.fromType] || !KINDS[edge.toType]) continue
    const from = keyOf(edge.fromType, edge.from)
    const to = keyOf(edge.toType, edge.to)
    if (from === to) continue
    push(down, from, to); push(up, to, from); push(both, from, to); push(both, to, from)
    links.push({ from, to, relation: edge.relation })
  }
  const anchor = keyOf(named[0].node.entityType, named[0].node.entityId)
  // What the anchor came from and what came of it; then, for each purchase
  // order among them, its own request, RFQ, receipts and invoices, so an
  // invoice's chain has its order's other receipts and invoices.
  const sources = reach([anchor], up, limits.depth)
  const results = reach([anchor], down, limits.depth)
  const lineage = new Set([...sources.keys, ...results.keys])
  const orders = [...lineage].filter((key) => key.startsWith('purchase_order:'))
  const orderSources = reach(orders, up, limits.depth)
  const orderResults = reach(orders, down, limits.depth)
  const members = new Set([...lineage, ...orderSources.keys, ...orderResults.keys])
  // Links from the anchor within the chain, for the nearest first.
  const distance = new Map([[anchor, 0]])
  let frontier = [anchor]
  while (frontier.length) {
    const next = []
    for (const key of frontier) for (const other of both.get(key) || []) if (members.has(other) && !distance.has(other)) { distance.set(other, distance.get(key) + 1); next.push(other) }
    frontier = next
  }
  const stageOf = (key) => KINDS[byKey.get(key).node.entityType].stage
  const dateOf = (key) => text(byKey.get(key).row.createdAt || byKey.get(key).row.invoiceDate || byKey.get(key).row.arrivedAt)
  const near = [...members].filter((key) => byKey.has(key) && distance.has(key) && distance.get(key) <= limits.depth)
    .sort((a, b) => distance.get(a) - distance.get(b) || stageOf(a) - stageOf(b) || dateOf(a).localeCompare(dateOf(b)) || a.localeCompare(b))
  const kept = new Set(near.slice(0, limits.nodes))
  const leftOut = members.size - kept.size
  const cut = sources.cut || results.cut || orderSources.cut || orderResults.cut || leftOut > 0
  const ordered = [...kept].sort((a, b) => stageOf(a) - stageOf(b) || dateOf(a).localeCompare(dateOf(b)) || byKey.get(a).number.localeCompare(byKey.get(b).number))
  return {
    anchor: byKey.get(anchor),
    members: ordered.map((key) => ({ ...byKey.get(key), key, kind: byKey.get(key).node.entityType, depth: distance.get(key) })),
    links: links.filter((link) => kept.has(link.from) && kept.has(link.to)),
    ...(cut ? { cut: { maxDepth: limits.depth, maxNodes: limits.nodes, leftOut } } : {}),
  }
}

// --- describing the chain ----------------------------------------------------

// A document's lines, at most `limit`, and how many more; none when it has none.
const capped = (rows, limit = CHAIN_LIMITS.lines) => (rows.length ? { lines: rows.slice(0, limit), ...(rows.length > limit ? { moreLines: rows.length - limit } : {}) } : {})
const present = (entries) => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== null && value !== undefined && value !== ''))
const signed = (value) => (value > 0 ? `+${value}` : String(value))
const statusOf = (kind, status) => { try { return normalizeProcurementAuthorityStatus(kind, status) } catch { return text(status) } }

function requestNode(entry) {
  const row = entry.row
  return present({
    type: 'purchase_request', number: entry.number, status: text(row.status) || null,
    raised: day(row.createdAt), requiredDate: day(row.requiredDate), supplier: text(row.supplier) || null,
    ...capped(array(row.lines).map((line) => present({ sku: text(line.sku) || null, itemName: text(line.itemName) || null, quantity: num(line.quantity), unit: text(line.unit) || null }))),
    ref: aiToolRef('purchase_request', entry.node.entityId, entry.number),
  })
}

function rfqNode(entry) {
  const row = entry.row
  return present({
    type: 'rfq', number: entry.number, status: text(row.status) || null, title: text(row.title) || null,
    due: day(row.due || row.dueDate), invited: num(row.suppliers), quotes: num(row.quoted), awardedTo: text(row.bestSupplier) || null,
    ref: aiToolRef('rfq', entry.node.entityId, entry.number),
  })
}

// A purchase order as the open purchase orders report reads it (its row) and
// its lines by the report's line rules, with the price only when the reader
// sees prices (the scoped row has none otherwise). A line is late only on an
// order the report counts as open: a closed or cancelled order's unreceived
// quantity is not coming.
function orderNode(entry, report, today) {
  const row = entry.row
  const lines = array(row.lines).map((line) => {
    const read = purchaseOrderReportLine(line, row)
    return present({
      sku: read.sku || null, itemName: text(line.itemName || line.itemNameSnapshot) || null, ordered: read.ordered, received: read.received, remaining: read.remaining,
      unit: read.unit || null, promisedDate: read.due || null, ...(report?.isOpen && read.open && read.remaining > 0 ? { overdueDays: daysLate(read.due, today) } : {}), unitPrice: num(line.unitPrice),
    })
  })
  return present({
    type: 'purchase_order', number: entry.number, status: text(row.status) || null, supplier: text(report?.supplier) || null,
    orderDate: text(report?.createdDate) || null, issued: day(row.issuedAt), dueDate: text(report?.dueDate) || null,
    overdueDays: report?.isOpen ? report.overdueDays || 0 : null, open: Boolean(report?.isOpen),
    amount: num(row.totalAmount), currency: text(row.currency) || null,
    ...capped(lines),
    ref: aiToolRef('purchase_order', entry.node.entityId, entry.number),
  })
}

function receiptNode(entry) {
  const row = entry.row
  return present({
    type: 'receipt', number: entry.number, status: text(row.postingStatus || row.status) || null, supplier: text(row.supplierName) || null,
    arrived: day(row.arrivedAt), posted: day(row.postedAt),
    ...capped(array(row.lines).map((line) => present({ sku: text(line.sku) || null, itemName: text(line.itemName) || null, accepted: num(line.acceptedQty), rejected: num(line.rejectedQty), unit: text(line.unit) || null }))),
    ref: aiToolRef('receiving_doc', entry.node.entityId, entry.number),
  })
}

// A held invoice's differences as Today's prepared step gives them, without
// their ids: each with its figures and likely cause, both left out when the
// reader may not see amounts (a price difference is then named, not valued).
// The order's price, and what it can be worked out from (a price
// difference's variance and percent, a line amount's expected value and
// variance), only for a reader of prices; the order the invoice's price was
// found on only for a reader of purchase orders.
function differenceOf({ exceptionId, ...row }, access) {
  const out = { ...row }
  if (!access?.prices && ['price', 'amount'].includes(row.kind)) for (const key of ['expected', 'variance', 'percent']) delete out[key]
  if (!access?.collections?.purchaseOrders) delete out.evidenceOrder
  return present(out)
}
// The prepared step only when every difference's cause was read: without
// amounts a price difference's cause is not, and the step would differ by
// who asks.
const preparedStepOf = (draft) => (draft.differences.every((row) => row.cause) ? draft.step : null)

function invoiceNode(entry, { payable, draft, amountsVisible, access, today }) {
  const row = entry.row
  const payment = payable ? present({
    number: text(payable.obligationNumber) || null, status: text(payable.status) || null,
    outstanding: amountsVisible ? num(payable.outstandingAmount) : null, currency: text(payable.currency) || null,
    dueDate: day(payable.dueDate), overdueDays: payable.open ? daysLate(day(payable.dueDate), today) : 0,
  }) : null
  return present({
    type: 'supplier_invoice', number: entry.number,
    // As the bill list shows it: an approved bill by where its payment stands.
    status: billPaymentStatus(row.status, payable?.status) || text(row.status) || null,
    matchStatus: settledMatchStatus({ ...row, workflowStatus: row.status }, row.varianceAmount) || null,
    nextStep: billNextStep(row),
    supplier: text(row.supplierName) || null, invoiceDate: day(row.invoiceDate), dueDate: day(row.dueDate),
    amount: num(row.totalAmount ?? row.amount), variance: num(row.varianceAmount), currency: text(row.currency) || null,
    ...capped(array(row.lines).map((line) => present({ sku: text(line.sku) || null, quantity: num(line.quantity), unit: text(line.unit) || null, unitPrice: num(line.unitPrice), amount: num(line.amount) }))),
    ...(draft ? present({ differences: draft.differences.slice(0, CHAIN_LIMITS.differences).map((row) => differenceOf(row, access)), preparedStep: preparedStepOf(draft) }) : {}),
    ...(payment ? { payable: payment } : {}),
    ref: aiToolRef('supplier_invoice', entry.node.entityId, entry.number),
  })
}

// One difference in a few words: "price +3.2% on 85123A".
function differenceText(row) {
  const on = row.sku ? ` on ${row.sku}` : ''
  if (row.kind === 'price') return row.percent !== null && row.percent !== undefined ? `price ${signed(row.percent)}%${on}` : `price${on}`
  if (row.kind === 'quantity') return row.invoiced !== null && row.invoiced !== undefined && row.received !== null && row.received !== undefined ? `quantity${on}: ${row.invoiced} invoiced, ${row.received} received` : `quantity${on}`
  return `amount${on}`
}

// The open points of each document, by the app's own rules. Each names its
// document by number (never a prose field: the grounding check reads any
// figure in prose as given, and a document number holds digits) and kind,
// says it in a few words and carries its figures in their own fields, so an
// answer can cite them. "Nothing came of it" is said only when the walk and
// the reads it rests on were whole (truncated: the subjects cut at the
// repository's limit).
function openPointsOf(member, node, context) {
  const { linksFrom, today, access, walkCut, chainInvoices, truncated } = context
  const point = (kind, words, figures = {}) => ({ number: member.number, kind, text: words, ...present(figures) })
  const status = text(member.row.status)
  const points = []
  if (member.kind === 'purchase_request') {
    if (status === PURCHASE_REQUEST_STATUS.DRAFT) points.push(point('draft', 'Draft, not submitted for approval'))
    if (status === PURCHASE_REQUEST_STATUS.SUBMITTED) points.push(point('awaiting_approval', 'Waiting for approval'))
    // Approved with nothing after it: said only when the reader sees orders
    // and the walk read the whole chain.
    const followed = linksFrom.has(member.key) || text(member.row.linkedPo) || text(member.row.linkedRfq) || array(member.row.linkedPurchaseOrderIds).length
    const whole = !walkCut && !truncated.has('purchase_orders') && !truncated.has('rfqs')
    if (status === PURCHASE_REQUEST_STATUS.APPROVED && !followed && access.collections.purchaseOrders && whole) points.push(point('no_order_yet', 'Approved, no purchase order or RFQ yet'))
  }
  // An RFQ out for quotes with no order awarded from it yet.
  if (member.kind === 'rfq' && !linksFrom.has(member.key)) {
    if (status === RFQ_STATUS.DRAFT) points.push(point('draft', 'Draft, not sent to suppliers'))
    if ([RFQ_STATUS.OPEN, RFQ_STATUS.COLLECTING_QUOTES].includes(status)) {
      const quoted = node.quotes !== undefined && node.invited !== undefined ? `${node.quotes} of ${node.invited} suppliers quoted` : 'Collecting quotes'
      points.push(point('collecting_quotes', node.due ? `${quoted}, due ${node.due}` : quoted, { quotes: node.quotes, invited: node.invited, due: node.due }))
    }
  }
  if (member.kind === 'purchase_order') {
    const state = statusOf('purchaseOrder', status)
    if (state === PURCHASE_ORDER_STATUS.DRAFT) points.push(point('draft', 'Draft, not submitted for approval'))
    if (state === PURCHASE_ORDER_STATUS.PENDING_APPROVAL) points.push(point('awaiting_approval', 'Waiting for approval'))
    if (aiSkillPurchaseOrderNotSent(member.row)) points.push(point('not_issued', 'Approved, not yet issued to the supplier'))
    if (node.open) {
      for (const line of array(node.lines).filter((entry) => entry.remaining > 0)) {
        const what = `${line.remaining}${line.unit ? ` ${line.unit}` : ''}${line.sku ? ` of ${line.sku}` : ''} still to receive`
        const when = line.promisedDate ? (line.overdueDays > 0 ? `, ${line.overdueDays} days past the promised date ${line.promisedDate}` : `, promised ${line.promisedDate}`) : ''
        points.push(point(line.overdueDays > 0 ? 'late_to_receive' : 'to_receive', `${what}${when}`, { sku: line.sku, remaining: line.remaining, unit: line.unit, promisedDate: line.promisedDate, overdueDays: line.overdueDays || null }))
      }
    }
  }
  if (member.kind === 'receiving_doc') {
    const posting = text(member.row.postingStatus)
    // A reversed receipt's stock was taken back out: that is its one point,
    // not what was rejected at the door or what is still to invoice.
    if (posting === 'reversed' || member.row.reversedAt) return [point('reversed', day(member.row.reversedAt) ? `Reversed on ${day(member.row.reversedAt)}: its stock was taken back out` : 'Reversed: its stock was taken back out')]
    if (posting === 'unposted') points.push(point('not_posted', 'Not yet posted to stock'))
    for (const line of array(node.lines).filter((entry) => entry.rejected > 0)) points.push(point('rejected', `${line.rejected}${line.unit ? ` ${line.unit}` : ''}${line.sku ? ` of ${line.sku}` : ''} rejected`, { sku: line.sku, rejected: line.rejected, unit: line.unit }))
    // A posted receipt no supplier invoice covers (the payables rule,
    // receiptsNotInvoiced), said only when every invoice of the chain was read.
    if (posting === 'posted' && access.collections.supplierInvoices && !walkCut && !truncated.has('supplier_invoices') && text(member.row.poId)) {
      const linkedReceipts = new Set(chainInvoices.filter((row) => text(row.status) !== 'cancelled').map((row) => text(row.receiptId || row.relatedGrn)).filter(Boolean))
      const linkedLines = new Set(chainInvoices.filter((row) => text(row.status) !== 'cancelled').flatMap((row) => array(row.lines).map((line) => text(line.receivingLineId))).filter(Boolean))
      if (receiptsNotInvoiced([member.row], { linkedReceipts, linkedLines, orderLines: new Map(), orders: new Map(), amountsVisible: false, namesVisible: false }).length) points.push(point('not_invoiced', 'Received, no supplier invoice yet'))
    }
  }
  if (member.kind === 'supplier_invoice') {
    if (status === 'draft') points.push(point('draft', 'Draft, not submitted'))
    const step = node.nextStep
    if (step === 'bill_exception') {
      const shown = array(node.differences)
      const words = shown.length ? `Held by a match exception: ${shown.map(differenceText).join('; ')}` : 'Held by a match exception'
      const price = shown.find((row) => row.kind === 'price')
      points.push(point('held_at_match', words, { percent: price?.percent ?? null }))
    }
    if (step === 'bill_awaiting_receipt') points.push(point('awaiting_receipt', 'Waiting for the goods receipt before it can be matched'))
    if (step === 'bill_to_match') points.push(point('to_match', 'Submitted, not yet matched'))
    if (step === 'bill_to_approve') points.push(point('to_approve', node.matchStatus === 'variance_approved' ? 'Every difference approved, waiting for approval' : 'Matched, waiting for approval'))
    const payable = node.payable
    if (payable?.status === 'held') points.push(point('payment_held', 'Payment on hold'))
    if (payable && payable.overdueDays > 0) points.push(point('payment_overdue', `Not paid, ${payable.overdueDays} days past its due date ${payable.dueDate}`, { outstanding: payable.outstanding, currency: payable.currency, dueDate: payable.dueDate, overdueDays: payable.overdueDays }))
    else if (payable && (payable.outstanding > 0 || (payable.outstanding === undefined && ['approved', 'export_ready', 'partially_settled'].includes(payable.status)))) points.push(point('to_pay', payable.dueDate ? `To pay by ${payable.dueDate}` : 'To pay', { outstanding: payable.outstanding, currency: payable.currency, dueDate: payable.dueDate }))
  }
  return points
}

// The result for the reader: each document of the walk described, the links
// by document number, the open points (the anchor's first), and what the
// reader cannot see. payables: invoice id to its payable; held: the
// readHeldInvoiceDifferences result, or null.
// unread: the parts whose read failed ('payables', 'invoice_differences'),
// said so the answer does not read their absence as a fact.
export function describeDocumentChain(walk, { business = {}, access, today, now = new Date(), timeZone, payables = new Map(), held = null, payablesReadable = true, unread = [], chars = CHAIN_LIMITS.chars } = {}) {
  const amountsVisible = Boolean(access?.amounts)
  const orders = walk.members.filter((member) => member.kind === 'purchase_order').map((member) => member.row)
  const report = orders.length ? buildOpenPurchaseOrdersReport(orders, { scope: 'all', export: 'true' }, now, { timeZone }) : { exportRows: [] }
  const reportRows = new Map(array(report.exportRows).map((row) => [text(row.id), row]))
  const asOf = text(today) || text(report.asOf)
  const drafts = new Map()
  for (const invoice of array(held?.invoices)) {
    const draft = invoiceExceptionDraft({
      invoice,
      exceptions: array(held.exceptions).filter((row) => text(row.supplierInvoiceId) === text(invoice.id)),
      lines: held.lines || {},
      orderPrices: array(held.orderPrices).filter((row) => text(row.supplierId) === text(invoice.supplierId)),
      amountsVisible: held.amountsVisible !== false,
    })
    if (draft) drafts.set(text(invoice.id), draft)
  }
  const nodes = walk.members.map((member) => {
    if (member.kind === 'purchase_request') return requestNode(member)
    if (member.kind === 'rfq') return rfqNode(member)
    if (member.kind === 'purchase_order') return orderNode(member, reportRows.get(text(member.row.id)), asOf)
    if (member.kind === 'receiving_doc') return receiptNode(member)
    return invoiceNode(member, { payable: payables.get(text(member.row.id)), draft: drafts.get(text(member.row.id)), amountsVisible, access, today: asOf })
  })
  const numberByKey = new Map(walk.members.map((member) => [member.key, member.number]))
  const linksFrom = new Set(walk.links.map((link) => link.from))
  const chainInvoices = walk.members.filter((member) => member.kind === 'supplier_invoice').map((member) => member.row)
  const truncated = array(business.truncatedSubjects).filter((row) => Object.values(KINDS).some((kind) => kind.subject === row?.subject))
  const shared = { linksFrom, today: asOf, access, walkCut: Boolean(walk.cut), chainInvoices, truncated: new Set(truncated.map((row) => row.subject)) }
  const anchorKey = keyOf(walk.anchor.node.entityType, walk.anchor.node.entityId)
  const points = walk.members.flatMap((member, at) => openPointsOf(member, nodes[at], shared).map((point) => ({ point, first: member.key === anchorKey })))
  const openPoints = [...points.filter((entry) => entry.first), ...points.filter((entry) => !entry.first)].map((entry) => entry.point)
  const notShown = Object.values(KINDS).filter((kind) => !access?.collections?.[kind.collection]).map((kind) => kind.subject)
  if (!payablesReadable && access?.collections?.supplierInvoices) notShown.push('payables')
  const hidden = present({ prices: access?.prices ? null : true, invoiceAmounts: amountsVisible ? null : true, invoiceSuppliers: access?.partner ? null : true })
  // The anchor by its number and type (not "document": see openPointsOf).
  return fitChain({
    asOf,
    anchor: walk.anchor.number,
    anchorType: KINDS[walk.anchor.node.entityType].type,
    nodes,
    links: walk.links.map((link) => ({ from: numberByKey.get(link.from), to: numberByKey.get(link.to), relation: link.relation })),
    openPoints: openPoints.slice(0, CHAIN_LIMITS.openPoints),
    ...(openPoints.length > CHAIN_LIMITS.openPoints ? { moreOpenPoints: openPoints.length - CHAIN_LIMITS.openPoints } : {}),
    ...(walk.cut ? { cut: walk.cut } : {}),
    ...(notShown.length ? { notShown } : {}),
    ...(Object.keys(hidden).length ? { hidden } : {}),
    ...(Array.isArray(access?.warehouseIds) ? { receiptsInYourWarehousesOnly: true } : {}),
    ...(truncated.length ? { partial: { sources: [...new Set(truncated.map((row) => row.subject))], note: PARTIAL_NOTE } } : {}),
    ...(unread.length ? { unread } : {}),
  }, { anchorId: text(walk.anchor.node.entityId), chars })
}

// The result within its budget: lines are dropped first from the documents
// other than the one asked about, then from it, each keeping moreLines, so a
// long chain answers instead of exceeding the assistant's result cap. The
// open points were read from every line before.
const LINE_STEPS = [5, 2, 0]
export function fitChain(result, { anchorId, chars = CHAIN_LIMITS.chars } = {}) {
  const size = () => JSON.stringify(result).length
  if (size() <= chars) return result
  const trim = (node, keep) => {
    const lines = array(node.lines)
    if (lines.length <= keep) return
    node.moreLines = (node.moreLines || 0) + lines.length - keep
    if (keep) node.lines = lines.slice(0, keep)
    else delete node.lines
  }
  const isAnchor = (node) => text(node.ref?.id) === anchorId
  result.linesTrimmed = true
  for (const anchor of [false, true]) {
    for (const keep of LINE_STEPS) {
      for (const node of result.nodes) if (isAnchor(node) === anchor) trim(node, keep)
      if (size() <= chars) return result
    }
  }
  return result
}

// The receipts the reader's warehouses cover, header and lines, as the
// receipt list keeps them (hasWarehouseAccess); every one for a reader of
// every warehouse.
function inReaderWarehouses(receipts, warehouseIds) {
  if (!Array.isArray(warehouseIds)) return array(receipts)
  const readable = new Set(warehouseIds.map(text))
  return array(receipts).filter((row) => [row.warehouseId, ...array(row.lines).map((line) => line.warehouseId)].map(text).filter(Boolean).every((id) => readable.has(id)))
}

const PAYABLE_OPEN = new Set(array(outstandingPayableWhere().status?.in))

const traceDocumentChain = defineAiTool({
  name: 'trace_document_chain',
  // Short: every request carries it (the fixed prompt has little room).
  description: 'One document\'s linked PRs, RFQs, POs, receipts and supplier invoices: status, dates, lines, links, openPoints.',
  parameters: { document: { type: 'string' } },
  required: ['document'],
  available: (_facts, context) => {
    if (!context?.actor) return false
    const access = context.routeContext?.reportReadAccess || reportReadAccessFor(context.actor)
    return Object.values(KINDS).some((kind) => access.collections?.[kind.collection])
  },
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const { access, business } = await scopedBusiness(context)
    const scoped = { ...business, receipts: inReaderWarehouses(business.receipts, access.warehouseIds) }
    const walk = walkDocumentChain(scoped, { document: args.document })
    if (walk.error) {
      const truncated = array(business.truncatedSubjects).some((row) => Object.values(KINDS).some((kind) => kind.subject === row?.subject))
      return { ...walk, ...(walk.error === 'not_found' && truncated ? { details: PARTIAL_NOTE } : {}) }
    }
    const invoices = walk.members.filter((member) => member.kind === 'supplier_invoice').map((member) => member.row)
    const prisma = context.prisma
    const payablesReadable = can(context, 'finance.payable.read')
    // Each invoice's payable, and a held invoice's differences as Today reads
    // them. Either read failing leaves its part out and says so (unread); the
    // chain still answers.
    const payables = new Map()
    const unread = []
    const ids = new Set(invoices.map((row) => text(row.id)))
    if (payablesReadable && ids.size && typeof prisma?.payableObligation?.findMany === 'function') {
      try {
        const rows = array(await prisma.payableObligation.findMany({
          where: { tenantId: context.tenantId, supplierInvoiceId: { in: [...ids] } },
          select: { supplierInvoiceId: true, obligationNumber: true, status: true, outstandingAmount: true, currency: true, dueDate: true },
        }))
        for (const row of rows) if (ids.has(text(row.supplierInvoiceId))) payables.set(text(row.supplierInvoiceId), { ...row, open: PAYABLE_OPEN.has(text(row.status)) && Number(row.outstandingAmount) > 0 })
      } catch { payables.clear(); unread.push('payables') }
    }
    const heldIds = invoices.filter((row) => billNextStep(row) === 'bill_exception').map((row) => text(row.id))
    let held = null
    if (heldIds.length && typeof prisma?.financeMatchException?.findMany === 'function' && typeof prisma?.threeWayMatchLine?.findMany === 'function') {
      try { held = await readHeldInvoiceDifferences(prisma, { tenantId: context.tenantId, invoiceIds: heldIds.slice(0, CHAIN_LIMITS.nodes), amountsVisible: access.amounts }) } catch { held = null; unread.push('invoice_differences') }
    }
    return describeDocumentChain(walk, { business, access, today: context.today || facts?.today || facts?.asOf, now: context.now, timeZone: context.tenant?.timezone, payables, held, payablesReadable, unread })
  },
})

export const AI_ASSISTANT_V2_CHAIN_TOOLS = Object.freeze([traceDocumentChain])
