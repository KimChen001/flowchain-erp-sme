import { can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

// What the signed-in actor may read from the procurement read model, and the
// masking that goes with it. The procurement list, workbench, documents and
// summary routes all answer through this, so a role sees the same thing on
// every route that the desktop detail and the mobile pages already show:
//
//   purchase requests, RFQs, purchase orders   procurement.purchase_order.read
//   receipts                                   receiving.read
//   supplier invoices                          finance.supplier_invoice.read
//   three-way matches                          finance.three_way_match.read
//
// A collection the actor cannot read is left out. Inside a readable record,
// prices and amounts on procurement documents need procurement.prices.read,
// amounts on invoices and matches need finance.amounts.read, and the supplier
// on an invoice needs finance.partner_snapshot.read. A hidden value is null
// with a `restrictedFields` list on the record, never 0.

const DOCUMENT_PERMISSION = Object.freeze({
  pr: 'procurement.purchase_order.read',
  rfq: 'procurement.purchase_order.read',
  po: 'procurement.purchase_order.read',
  grn: 'receiving.read',
  invoice: 'finance.supplier_invoice.read',
  threeWayMatch: 'finance.three_way_match.read',
})

const SNAPSHOT_TYPES = Object.freeze({
  purchaseRequests: 'pr',
  rfqs: 'rfq',
  purchaseOrders: 'po',
  receivingDocs: 'grn',
  supplierInvoices: 'invoice',
})

// Every money field the procurement read model returns, on headers and lines.
const MONEY_KEYS = new Set([
  'unitPrice', 'estimatedUnitPrice', 'amount', 'estimatedAmount', 'totalAmount', 'subtotal', 'taxAmount', 'tax', 'total',
  'lineAmount', 'lineSubtotal', 'lineTotal', 'bestPrice', 'amountSummary', 'varianceAmount', 'lineVarianceAmount', 'price',
  'budget', 'budgetAmount', 'invoiceAmount', 'poAmount', 'receivedAmount', 'matchedAmount', 'openAmount', 'invoiceTotal',
  'poUnitPrice', 'invoiceUnitPrice', 'priceVariance', 'amountVariance',
])
const PARTNER_KEYS = new Set(['supplier', 'supplierName', 'supplierSnapshot', 'supplierId'])

const text = (value) => String(value ?? '').trim()

export function procurementReadAccessFor(actor) {
  const allowed = (permission) => Boolean(actor?.tenantId) && can({ actor, permission, tenantId: actor.tenantId })
  const types = Object.fromEntries(Object.entries(DOCUMENT_PERMISSION).map(([type, permission]) => [type, allowed(permission)]))
  return {
    types,
    prices: allowed('procurement.prices.read'),
    amounts: allowed('finance.amounts.read'),
    partner: allowed('finance.partner_snapshot.read'),
  }
}

// The actor of the request: the session identity when it already carries a
// resolved authorization context, else the provisioned workspace user.
export async function procurementReadAccess(ctx) {
  if (ctx.procurementReadAccess) return ctx.procurementReadAccess
  const identity = ctx.identity
  const actor = identity?.authenticated && identity.complete && identity.permissionCodes
    ? identity
    : await resolveProvisionedActor(await getPrismaClient(ctx.env || process.env), identity)
  return procurementReadAccessFor(actor)
}

export function canReadProcurementDocument(type, access) {
  return Boolean(access?.types?.[type])
}

// Which kinds of field a document of this type hides from this actor.
function hiddenKinds(type, access) {
  if (type === 'invoice' || type === 'threeWayMatch') return { money: !access.amounts, partner: !access.partner }
  return { money: !access.prices, partner: false }
}

// The hidden values of a record, so that derived text can be scrubbed too:
// the read model builds titles, evidence labels and exception reasons such
// as "INV-001 131.25" or "差异金额 6.25" from the same fields.
function collectHidden(value, hidden, out = { money: new Set(), names: new Set() }) {
  if (Array.isArray(value)) { for (const entry of value) collectHidden(entry, hidden, out); return out }
  if (!value || typeof value !== 'object' || value instanceof Date) return out
  for (const [key, entry] of Object.entries(value)) {
    if (hidden.money && MONEY_KEYS.has(key) && entry !== null && entry !== undefined && typeof entry !== 'object') {
      const number = Number(entry)
      if (Number.isFinite(number) && number !== 0) for (const form of [String(number), number.toFixed(2), number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })]) out.money.add(form)
    } else if (hidden.partner && PARTNER_KEYS.has(key) && typeof entry === 'string' && entry.trim().length >= 2) {
      out.names.add(entry.trim())
    } else {
      collectHidden(entry, hidden, out)
    }
  }
  return out
}

// Record numbers, SKUs, routes and codes are never scrubbed.
const ID_KEY = /^(id|po|pr|rfq|grn|invoice|sku|route|type|documentType|currency|status|relatedPo|relatedGrn)$|Id$|Ids$|Number$/
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function scrubber(values) {
  const money = [...values.money].sort((a, b) => b.length - a.length).map(escapeRegExp)
  const names = [...values.names].sort((a, b) => b.length - a.length).map(escapeRegExp)
  // A standalone amount ("131.25", "$131.25"), not part of a number like "PO-125".
  const moneyPattern = money.length ? new RegExp(`(?<![\\w.,-])(?:${money.join('|')})(?![\\w-]|[.,]\\d)`, 'g') : null
  const namePattern = names.length ? new RegExp(names.join('|'), 'g') : null
  return (text) => {
    let next = text
    if (moneyPattern) next = next.replace(moneyPattern, '—')
    if (namePattern) next = next.replace(namePattern, '').replace(/\s{2,}/g, ' ').trim()
    return next
  }
}

function maskValue(value, hidden, found, scrub) {
  if (typeof value === 'string') {
    const next = scrub(value)
    if (next !== value) found.add('text')
    return next
  }
  if (Array.isArray(value)) return value.map((entry) => maskValue(entry, hidden, found, scrub))
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (hidden.money && MONEY_KEYS.has(key) && entry !== null && entry !== undefined) { out[key] = null; found.add('amounts'); continue }
    if (hidden.partner && PARTNER_KEYS.has(key) && entry !== null && entry !== undefined && entry !== '') { out[key] = null; found.add('supplier'); continue }
    out[key] = typeof entry === 'string' && ID_KEY.test(key) ? entry : maskValue(entry, hidden, found, scrub)
  }
  return out
}

export function maskProcurementRecord(record, type, access) {
  const hidden = hiddenKinds(type, access)
  if (!hidden.money && !hidden.partner) return record
  const found = new Set()
  const masked = maskValue(record, hidden, found, scrubber(collectHidden(record, hidden)))
  found.delete('text')
  return found.size ? { ...masked, restrictedFields: [...found] } : masked
}

const linkReadable = (link, access) => {
  const ends = [text(link.sourceType), text(link.targetType)].filter(Boolean)
  return ends.every((type) => !DOCUMENT_PERMISSION[type] || canReadProcurementDocument(type, access))
}

// The snapshot with unreadable collections emptied, before masking. Counts
// and summaries are computed from this, then their money is masked.
export function readableProcurementSnapshot(snapshot = {}, access) {
  const out = { ...snapshot }
  for (const [key, type] of Object.entries(SNAPSHOT_TYPES)) out[key] = canReadProcurementDocument(type, access) ? (snapshot[key] || []) : []
  out.documentLinks = (snapshot.documentLinks || []).filter((link) => linkReadable(link, access))
  out.procurementFollowups = (snapshot.procurementFollowups || []).filter((item) => !DOCUMENT_PERMISSION[text(item.documentType)] || canReadProcurementDocument(text(item.documentType), access))
  return out
}

export function maskProcurementSnapshot(snapshot = {}, access) {
  const readable = readableProcurementSnapshot(snapshot, access)
  const out = { ...readable }
  for (const [key, type] of Object.entries(SNAPSHOT_TYPES)) out[key] = readable[key].map((record) => maskProcurementRecord(record, type, access))
  return out
}

export function maskProcurementDocuments(documents = [], access) {
  return documents
    .filter((document) => canReadProcurementDocument(text(document.documentType), access))
    .map((document) => maskProcurementRecord(document, text(document.documentType), access))
}

export function readableProcurementRows(rows = [], access) {
  return rows.filter((row) => {
    if (row.sourceType || row.targetType) return linkReadable(row, access)
    const type = text(row.documentType)
    return !DOCUMENT_PERMISSION[type] || canReadProcurementDocument(type, access)
  })
}

// The open amount in the procurement summary adds requests, orders and
// invoices; with any of their amounts hidden it is not shown at all.
export function maskProcurementSummary(summary = {}, access) {
  if (access.prices && access.amounts) return summary
  return { ...summary, totalOpenAmount: null, currency: null, currencies: [], currencyAggregationStatus: 'restricted', restrictedFields: ['amounts'] }
}
