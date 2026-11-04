// Document numbers (owner decisions 2026-11-04): PREFIX-YYYYMM-NNNN, the
// sequence per workspace, document type and month, restarting each month.
// The server assigns the number when the document is created; nobody types
// or edits it. The month is the workspace's (its timezone), and the sequence
// grows past four digits instead of wrapping. Supplier invoices keep the
// supplier's own invoice number and are not numbered here. Documents brought
// in by a history import get a new number too, with the old one in their
// notes and a mapping list for the user.
//
// `applied` marks the document types whose creation path assigns these
// numbers now. Purchase requests, RFQs and purchase orders follow once they
// have a per-workspace number field (their id is global today); returns and
// credit notes follow with phase 2. Existing documents keep their numbers.

export const DOCUMENT_NUMBER_TYPES = Object.freeze([
  { type: 'purchase_request', ruleId: 'NUM-PR', prefix: 'PR', document: 'Purchase Request', zh: '采购申请', applied: false },
  { type: 'rfq', ruleId: 'NUM-RFQ', prefix: 'RFQ', document: 'Request for Quotation', zh: '询价单', applied: false },
  { type: 'purchase_order', ruleId: 'NUM-PO', prefix: 'PO', document: 'Purchase Order', zh: '采购订单', applied: false },
  { type: 'receiving_document', ruleId: 'NUM-GRN', prefix: 'GRN', document: 'Receiving Document', zh: '收货单', applied: true },
  { type: 'sales_order', ruleId: 'NUM-SO', prefix: 'SO', document: 'Sales Order', zh: '销售订单', applied: true },
  { type: 'shipment', ruleId: 'NUM-DN', prefix: 'DN', document: 'Shipment', zh: '发货单', applied: true },
  { type: 'customer_invoice', ruleId: 'NUM-CI', prefix: 'CI', document: 'Customer Invoice', zh: '销售发票', applied: true },
  { type: 'contract', ruleId: 'NUM-CT', prefix: 'CT', document: 'Contract', zh: '合同', applied: true },
  { type: 'stock_transfer', ruleId: 'NUM-TR', prefix: 'TR', document: 'Inventory Transfer', zh: '库存调拨', applied: true },
  { type: 'cycle_count', ruleId: 'NUM-CC', prefix: 'CC', document: 'Cycle Count', zh: '循环盘点', applied: true },
  { type: 'inventory_adjustment', ruleId: 'NUM-ADJ', prefix: 'ADJ', document: 'Inventory Adjustment', zh: '库存调整', applied: true },
  { type: 'return_request', ruleId: 'NUM-RR', prefix: 'RR', document: 'Return Request', zh: '退货申请', applied: false },
  { type: 'return_authorization', ruleId: 'NUM-RA', prefix: 'RA', document: 'Return Authorization', zh: '退货授权', applied: false },
  { type: 'return_posting', ruleId: 'NUM-RP', prefix: 'RP', document: 'Return Posting', zh: '退货过账', applied: false },
  { type: 'credit_note', ruleId: 'NUM-CM', prefix: 'CM', document: 'Credit Memo / Credit Note', zh: '贷项通知单', applied: false },
].map((entry) => Object.freeze(entry)))

export const DOCUMENT_NUMBER_SEPARATOR = '-'
export const DOCUMENT_NUMBER_DATE_PATTERN = 'YYYYMM'
export const DOCUMENT_NUMBER_SEQUENCE_LENGTH = 4
export const DOCUMENT_NUMBER_PREFIX_PATTERN = /^[A-Z0-9]{1,8}$/
const DEFAULT_TIME_ZONE = 'America/New_York'

export function documentNumberType(type) {
  return DOCUMENT_NUMBER_TYPES.find((entry) => entry.type === type) || null
}

// The workspace month a moment falls in, as YYYYMM. An unknown timezone falls
// back to the default workspace timezone rather than UTC.
export function numberingPeriod(at = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const moment = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(moment.getTime())) throw Object.assign(new Error('A valid date is required for a document number.'), { code: 'DOCUMENT_NUMBER_DATE_INVALID' })
  const parts = (zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit' }).formatToParts(moment)
  let found
  try { found = parts(timeZone || DEFAULT_TIME_ZONE) } catch { found = parts(DEFAULT_TIME_ZONE) }
  const year = found.find((part) => part.type === 'year')?.value
  const month = found.find((part) => part.type === 'month')?.value
  return `${year}${month}`
}

export function formatDocumentNumber(prefix, period, sequence) {
  const value = Number(sequence)
  if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error('A document sequence starts at 1.'), { code: 'DOCUMENT_NUMBER_SEQUENCE_INVALID' })
  return [prefix, period, String(value).padStart(DOCUMENT_NUMBER_SEQUENCE_LENGTH, '0')].join(DOCUMENT_NUMBER_SEPARATOR)
}

// The prefix for a document type: the workspace's saved rule when it is a
// valid prefix, otherwise the default. A changed prefix applies to new
// documents only; the sequence (kept per type) carries on.
export function documentNumberPrefix(numberingSettings, type) {
  const entry = documentNumberType(type)
  if (!entry) throw Object.assign(new Error(`Unknown document type for numbering: ${type}`), { code: 'DOCUMENT_NUMBER_TYPE_UNKNOWN' })
  const rules = Array.isArray(numberingSettings?.rules) ? numberingSettings.rules : []
  const saved = String(rules.find((rule) => rule?.id === entry.ruleId)?.prefix ?? '').trim().toUpperCase()
  return DOCUMENT_NUMBER_PREFIX_PATTERN.test(saved) ? saved : entry.prefix
}

// The default numbering rules a workspace starts with, one per document type.
export function defaultNumberingRules() {
  return DOCUMENT_NUMBER_TYPES.map((entry) => ({
    id: entry.ruleId,
    document: entry.document,
    prefix: entry.prefix,
    datePattern: DOCUMENT_NUMBER_DATE_PATTERN,
    separator: DOCUMENT_NUMBER_SEPARATOR,
    sequenceLength: DOCUMENT_NUMBER_SEQUENCE_LENGTH,
  }))
}
