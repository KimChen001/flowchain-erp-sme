// The business documents FlowChain prepares for a person to print or save as
// PDF and send themselves: the purchase order now, the customer invoice next.
// FlowChain never sends them; issuing a PO only records that someone did.
//
// Pure, so the server and the page share it. The server reads the records;
// this builds the document from what is recorded:
//
//   - every value is the recorded string or null, which the page prints as
//     "—". Nothing is filled in: a supplier with no recorded currency or
//     payment terms gets none, never the USD or NET30 a form would default to;
//   - amounts stay decimal strings, one total per currency, never converted
//     or added across currencies;
//   - quantities are never added up, because lines differ in SKU and unit;
//   - a supplier's tax ID and bank details are never part of a document.
//
// The workspace's document settings (letterhead and the purchase order
// template) live in Tenant.operationalSettings.documents; their shape and
// limits are defined here so the settings form checks what the server checks.

export const DOCUMENT_LANGUAGES = Object.freeze(['en-US', 'zh-CN'])

// A PO is a document to send once it is approved, and stays one afterwards.
export const PRINTABLE_PURCHASE_ORDER_STATUSES = Object.freeze(['approved', 'issued', 'partially_received', 'fully_received', 'closed'])

export const DOCUMENT_SETTINGS_LIMITS = Object.freeze({
  companyName: 200,
  addressLines: 6,
  addressLine: 120,
  phone: 60,
  email: 200,
  taxId: 60,
  title: 120,
  termsText: 4000,
  footerText: 500,
})

export const PURCHASE_ORDER_COLUMNS = Object.freeze(['supplierSku', 'requestedDate', 'promisedDate'])

// A null company name prints the workspace's legal name, or its name.
export const documentSettingsSeed = Object.freeze({
  version: 1,
  documentLanguage: 'en-US',
  letterhead: Object.freeze({ companyName: null, addressLines: Object.freeze([]), phone: null, email: null, taxId: null }),
  purchaseOrder: Object.freeze({
    title: null,
    columns: Object.freeze({ supplierSku: true, requestedDate: false, promisedDate: true }),
    termsText: '',
    footerText: '',
    signatureBlock: false,
  }),
})

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')
const recorded = (value) => {
  if (value === null || value === undefined) return null
  const next = String(value).trim()
  return next || null
}
const invalid = (code, field, message, details = {}) => Object.assign(new Error(message), { code, status: 400, details: { field, ...details } })

// The stored section with the seed under it, for reading. Values of the wrong
// type are ignored, never thrown on: what was saved passed validation.
export function normalizeDocumentSettings(value) {
  const current = isObject(value) ? value : {}
  const letterhead = isObject(current.letterhead) ? current.letterhead : {}
  const purchaseOrder = isObject(current.purchaseOrder) ? current.purchaseOrder : {}
  const columns = isObject(purchaseOrder.columns) ? purchaseOrder.columns : {}
  const seed = documentSettingsSeed
  return {
    version: 1,
    documentLanguage: DOCUMENT_LANGUAGES.includes(current.documentLanguage) ? current.documentLanguage : seed.documentLanguage,
    letterhead: {
      companyName: typeof letterhead.companyName === 'string' ? recorded(letterhead.companyName) : null,
      addressLines: Array.isArray(letterhead.addressLines) ? letterhead.addressLines.filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim()) : [],
      phone: typeof letterhead.phone === 'string' ? recorded(letterhead.phone) : null,
      email: typeof letterhead.email === 'string' ? recorded(letterhead.email) : null,
      taxId: typeof letterhead.taxId === 'string' ? recorded(letterhead.taxId) : null,
    },
    purchaseOrder: {
      title: typeof purchaseOrder.title === 'string' ? recorded(purchaseOrder.title) : null,
      columns: Object.fromEntries(PURCHASE_ORDER_COLUMNS.map((key) => [key, typeof columns[key] === 'boolean' ? columns[key] : seed.purchaseOrder.columns[key]])),
      termsText: trimmed(purchaseOrder.termsText),
      footerText: trimmed(purchaseOrder.footerText),
      signatureBlock: typeof purchaseOrder.signatureBlock === 'boolean' ? purchaseOrder.signatureBlock : seed.purchaseOrder.signatureBlock,
    },
  }
}

// A save of the section: the known fields only (anything else is dropped),
// each checked. A value over its limit is refused with the field named, not
// cut short.
export function validateDocumentSettings(value) {
  if (!isObject(value)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'documents', 'Document settings are invalid.')
  const letterhead = value.letterhead === undefined ? {} : value.letterhead
  const purchaseOrder = value.purchaseOrder === undefined ? {} : value.purchaseOrder
  if (!isObject(letterhead)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'letterhead', 'The letterhead is invalid.')
  if (!isObject(purchaseOrder)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'purchaseOrder', 'The purchase order template is invalid.')
  const columns = purchaseOrder.columns === undefined ? {} : purchaseOrder.columns
  if (!isObject(columns)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'purchaseOrder.columns', 'The purchase order columns are invalid.')

  const language = value.documentLanguage === undefined ? documentSettingsSeed.documentLanguage : value.documentLanguage
  if (!DOCUMENT_LANGUAGES.includes(language)) throw invalid('DOCUMENT_LANGUAGE_NOT_SUPPORTED', 'documentLanguage', 'Choose English (en-US) or Chinese (zh-CN) for documents.')

  const textField = (field, raw, limit, { nullable }) => {
    if (raw === undefined || raw === null) return nullable ? null : ''
    if (typeof raw !== 'string') throw invalid('DOCUMENT_SETTING_INVALID', field, `${field} must be text.`)
    const next = raw.trim()
    if (next.length > limit) throw invalid('DOCUMENT_SETTING_TOO_LONG', field, `${field} can be at most ${limit} characters.`, { limit })
    return nullable ? next || null : next
  }
  const flag = (field, raw, fallback) => {
    if (raw === undefined) return fallback
    if (typeof raw !== 'boolean') throw invalid('DOCUMENT_SETTING_INVALID', field, `${field} must be true or false.`)
    return raw
  }

  const rawLines = letterhead.addressLines === undefined || letterhead.addressLines === null ? [] : letterhead.addressLines
  if (!Array.isArray(rawLines)) throw invalid('DOCUMENT_SETTING_INVALID', 'letterhead.addressLines', 'The address must be a list of lines.')
  const addressLines = rawLines.map((line, index) => textField(`letterhead.addressLines.${index}`, line, DOCUMENT_SETTINGS_LIMITS.addressLine, { nullable: false })).filter(Boolean)
  if (addressLines.length > DOCUMENT_SETTINGS_LIMITS.addressLines) throw invalid('DOCUMENT_SETTING_TOO_MANY_LINES', 'letterhead.addressLines', `The address can have at most ${DOCUMENT_SETTINGS_LIMITS.addressLines} lines.`, { limit: DOCUMENT_SETTINGS_LIMITS.addressLines })

  const seedColumns = documentSettingsSeed.purchaseOrder.columns
  return {
    version: 1,
    documentLanguage: language,
    letterhead: {
      companyName: textField('letterhead.companyName', letterhead.companyName, DOCUMENT_SETTINGS_LIMITS.companyName, { nullable: true }),
      addressLines,
      phone: textField('letterhead.phone', letterhead.phone, DOCUMENT_SETTINGS_LIMITS.phone, { nullable: true }),
      email: textField('letterhead.email', letterhead.email, DOCUMENT_SETTINGS_LIMITS.email, { nullable: true }),
      taxId: textField('letterhead.taxId', letterhead.taxId, DOCUMENT_SETTINGS_LIMITS.taxId, { nullable: true }),
    },
    purchaseOrder: {
      title: textField('purchaseOrder.title', purchaseOrder.title, DOCUMENT_SETTINGS_LIMITS.title, { nullable: true }),
      columns: Object.fromEntries(PURCHASE_ORDER_COLUMNS.map((key) => [key, flag(`purchaseOrder.columns.${key}`, columns[key], seedColumns[key])])),
      termsText: textField('purchaseOrder.termsText', purchaseOrder.termsText, DOCUMENT_SETTINGS_LIMITS.termsText, { nullable: false }),
      footerText: textField('purchaseOrder.footerText', purchaseOrder.footerText, DOCUMENT_SETTINGS_LIMITS.footerText, { nullable: false }),
      signatureBlock: flag('purchaseOrder.signatureBlock', purchaseOrder.signatureBlock, documentSettingsSeed.purchaseOrder.signatureBlock),
    },
  }
}

// A calendar day, YYYY-MM-DD, from a Date or an ISO string; null otherwise.
// Dates are stored as UTC instants, so the UTC day is the recorded day.
function calendarDay(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

// The recorded supplier fields a document prints. Read from the stored
// record (columns and metadata), never from the master data view, which fills
// in a currency and payment terms nobody recorded. Tax and bank fields are
// not read at all.
function supplierParty(supplier, order) {
  const meta = isObject(supplier?.metadata) ? supplier.metadata : {}
  return {
    name: recorded(supplier?.name) || recorded(order?.supplierSnapshot?.supplierName),
    code: recorded(supplier?.code) || recorded(meta.supplierCode),
    contactName: recorded(meta.contactName) || recorded(meta.contact),
    email: recorded(meta.email),
    telephone: recorded(meta.telephone) || recorded(meta.phone),
    address: recorded(meta.address),
    postalCode: recorded(meta.postalCode),
  }
}

// The purchase order as a document. `order` is the PO as the detail route
// reads it (prices null without procurement.prices.read); `supplier` the
// stored supplier row; `warehouse` the PO's delivery warehouse ({ id, code,
// name }, which has no address); `supplierSkus` the supplier's item links
// ({ itemId, supplierSku }); `letterhead`, `template` and `documentLanguage`
// the workspace's document settings; `workspace` its { legalName, name };
// `access.prices` whether the reader may see prices.
export function buildPurchaseOrderDocument({ order, supplier = null, warehouse = null, supplierSkus = [], letterhead = documentSettingsSeed.letterhead, template = documentSettingsSeed.purchaseOrder, documentLanguage = documentSettingsSeed.documentLanguage, workspace = {}, access = {} }) {
  const meta = isObject(order?.metadata) ? order.metadata : {}
  const status = recorded(order?.status)
  // A role that cannot see prices gets no document to send rather than one
  // with blank prices.
  const printable = !PRINTABLE_PURCHASE_ORDER_STATUSES.includes(status)
    ? { ok: false, reason: 'status' }
    : access.prices !== true
      ? { ok: false, reason: 'prices_hidden' }
      : { ok: true, reason: null }
  const skuByItem = new Map((supplierSkus || []).filter((link) => recorded(link?.itemId) && recorded(link?.supplierSku)).map((link) => [recorded(link.itemId), recorded(link.supplierSku)]))
  const currency = recorded(order?.currency)
  const columns = Object.fromEntries(PURCHASE_ORDER_COLUMNS.map((key) => [key, template?.columns?.[key] === true]))
  return {
    kind: 'purchase_order',
    orderId: recorded(order?.id),
    number: recorded(order?.orderNumber) || recorded(order?.id),
    status,
    // The issue instant: the PO's own field where the read returns one, else
    // what the Issue action wrote to the metadata; null when never issued.
    issuedAt: recorded(order?.issuedAt) || recorded(meta.issuedAt),
    expectedDate: calendarDay(order?.expectedDate),
    documentLanguage: DOCUMENT_LANGUAGES.includes(documentLanguage) ? documentLanguage : documentSettingsSeed.documentLanguage,
    printable,
    buyer: {
      companyName: recorded(letterhead?.companyName) || recorded(workspace?.legalName) || recorded(workspace?.name),
      addressLines: Array.isArray(letterhead?.addressLines) ? letterhead.addressLines.map(recorded).filter(Boolean) : [],
      phone: recorded(letterhead?.phone),
      email: recorded(letterhead?.email),
      taxId: recorded(letterhead?.taxId),
    },
    supplier: supplierParty(supplier, order),
    // A warehouse has no address in FlowChain; the code and name are printed.
    shipTo: { code: recorded(warehouse?.code) || recorded(meta.targetWarehouseId), name: recorded(warehouse?.name) },
    currency,
    lines: (Array.isArray(order?.lines) ? order.lines : []).map((line, index) => ({
      lineNo: index + 1,
      sku: recorded(line.sku),
      supplierSku: skuByItem.get(recorded(line.itemId)) || null,
      description: recorded(line.itemName),
      quantity: recorded(line.orderedQuantity ?? line.quantity),
      unit: recorded(line.unit),
      unitPrice: recorded(line.unitPrice),
      amount: recorded(line.amount),
      requestedDate: calendarDay(line.requestedDate),
      promisedDate: calendarDay(line.promisedDate),
    })),
    // The amount recorded on the PO, in the PO's one currency.
    totals: [{ currency, amount: recorded(order?.totalAmount) }],
    title: recorded(template?.title),
    columns,
    termsText: recorded(template?.termsText),
    footerText: recorded(template?.footerText),
    signatureBlock: template?.signatureBlock === true,
  }
}
