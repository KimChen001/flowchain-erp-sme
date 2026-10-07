// The business documents FlowChain prepares for a person to print or save as
// PDF and send themselves: the purchase order and the customer invoice.
// FlowChain never sends them; issuing a PO or an invoice only records that
// someone did.
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
//   - a supplier's tax ID and bank details, and a customer's currency and
//     credit standing, are never part of a document.
//
// The workspace's document settings (letterhead, the purchase order and the
// invoice templates) live in Tenant.operationalSettings.documents; their
// shape and limits are defined here so the settings form checks what the
// server checks.

export const DOCUMENT_LANGUAGES = Object.freeze(['en-US', 'zh-CN'])

// A PO is a document to send once it is approved, and stays one afterwards.
export const PRINTABLE_PURCHASE_ORDER_STATUSES = Object.freeze(['approved', 'issued', 'partially_received', 'fully_received', 'closed'])

// An invoice is a document to send once it is issued. A customer's dispute
// is recorded on the receivable and the invoice stays issued; 'disputed' is
// listed only so that an invoice ever stored with that status stays
// printable. An approved invoice can be looked over on screen before it is
// issued, but not printed.
export const PRINTABLE_CUSTOMER_INVOICE_STATUSES = Object.freeze(['issued', 'disputed'])
export const PREVIEW_CUSTOMER_INVOICE_STATUSES = Object.freeze(['approved'])

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
  paymentInstructions: 2000,
})

export const PURCHASE_ORDER_COLUMNS = Object.freeze(['supplierSku', 'requestedDate', 'promisedDate'])
export const CUSTOMER_INVOICE_COLUMNS = Object.freeze(['tax'])

// A null company name prints the workspace's legal name, or its name. The
// requested date is the buyer's own date and is printed by default; a
// promised date is printed only where the supplier's promise was recorded on
// the line, so its column starts off. On the invoice the tax per line starts
// off (the totals always carry the invoice's tax), and what the customer has
// paid is printed when the receivable is readable in the invoice's currency.
export const documentSettingsSeed = Object.freeze({
  version: 1,
  documentLanguage: 'en-US',
  letterhead: Object.freeze({ companyName: null, addressLines: Object.freeze([]), phone: null, email: null, taxId: null }),
  purchaseOrder: Object.freeze({
    title: null,
    columns: Object.freeze({ supplierSku: true, requestedDate: true, promisedDate: false }),
    termsText: '',
    footerText: '',
    signatureBlock: false,
  }),
  customerInvoice: Object.freeze({
    title: null,
    columns: Object.freeze({ tax: false }),
    showPaymentSummary: true,
    paymentInstructions: '',
    termsText: '',
    footerText: '',
  }),
  // The workspace's saved print layouts for the receive sheet, delivery note
  // and sign receipt (src/modules/print-layout). The built-in layouts are in
  // code and never stored; none are saved until someone saves one.
  layouts: Object.freeze([]),
})

// What a saved print layout may hold. Its shape mirrors PrintLayoutTemplate
// (src/modules/print-layout/printLayoutTypes.ts); anything else is dropped.
export const PRINT_LAYOUT_DOCUMENT_TYPES = Object.freeze(['receive_sheet', 'delivery_note', 'sign_receipt'])
export const PRINT_LAYOUT_ELEMENT_TYPES = Object.freeze(['text', 'field', 'table', 'comment', 'terms', 'barcode', 'qrcode', 'signature', 'line', 'footer', 'pageNumber'])
export const PRINT_LAYOUT_LIMITS = Object.freeze({
  templates: 20,
  bytes: 64 * 1024,
  elements: 200,
  columns: 30,
  id: 100,
  name: 120,
  title: 120,
  value: 4000,
  field: 60,
  placeholder: 200,
  coordinate: 5000,
})

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')
const recorded = (value) => {
  if (value === null || value === undefined) return null
  const next = String(value).trim()
  return next || null
}
const invalid = (code, field, message, details = {}) => Object.assign(new Error(message), { code, status: 400, details: { field, ...details } })

const LAYOUT_ID = /^[A-Za-z0-9._:-]+$/
const ALIGNMENTS = ['left', 'center', 'right']
const layoutInvalid = (field, message) => invalid('DOCUMENT_LAYOUT_INVALID', field, message)

function layoutText(field, raw, limit, { required = false, optional = false, pattern = null } = {}) {
  if (raw === undefined || raw === null) {
    if (required) throw layoutInvalid(field, `${field} is required.`)
    return optional ? undefined : ''
  }
  if (typeof raw !== 'string') throw layoutInvalid(field, `${field} must be text.`)
  const next = raw.trim()
  if (required && !next) throw layoutInvalid(field, `${field} is required.`)
  if (next.length > limit) throw invalid('DOCUMENT_SETTING_TOO_LONG', field, `${field} can be at most ${limit} characters.`, { limit })
  if (pattern && !pattern.test(next)) throw layoutInvalid(field, `${field} has characters that are not allowed.`)
  return next
}

function layoutNumber(field, raw, { min, max, optional = false, fallback = undefined }) {
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback
    if (optional) return undefined
    throw layoutInvalid(field, `${field} is required.`)
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) throw layoutInvalid(field, `${field} must be a number from ${min} to ${max}.`)
  return raw
}

// A true/false value; `fallback` when it is not given (undefined leaves it out).
function layoutFlag(field, raw, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'boolean') throw layoutInvalid(field, `${field} must be true or false.`)
  return raw
}

function layoutChoice(field, raw, choices, { optional = false } = {}) {
  if ((raw === undefined || raw === null) && optional) return undefined
  if (!choices.includes(raw)) throw layoutInvalid(field, `${field} must be one of ${choices.join(', ')}.`)
  return raw
}

// Only the defined keys, in a fixed order, so a layout saved twice is stored
// the same way.
const defined = (entries) => Object.fromEntries(entries.filter(([, value]) => value !== undefined))

function validateLayoutStyle(field, raw) {
  if (raw === undefined || raw === null) return undefined
  if (!isObject(raw)) throw layoutInvalid(field, `${field} is invalid.`)
  return defined([
    ['fontSize', layoutNumber(`${field}.fontSize`, raw.fontSize, { min: 1, max: 200, optional: true })],
    ['fontWeight', layoutNumber(`${field}.fontWeight`, raw.fontWeight, { min: 100, max: 1000, optional: true })],
    ['bold', layoutFlag(`${field}.bold`, raw.bold, undefined)],
    ['align', layoutChoice(`${field}.align`, raw.align, ALIGNMENTS, { optional: true })],
    ['bordered', layoutFlag(`${field}.bordered`, raw.bordered, undefined)],
    ['borderWidth', layoutNumber(`${field}.borderWidth`, raw.borderWidth, { min: 0, max: 50, optional: true })],
    ['lineHeight', layoutNumber(`${field}.lineHeight`, raw.lineHeight, { min: 0.5, max: 5, optional: true })],
  ])
}

function validateLayoutColumns(field, raw) {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw layoutInvalid(field, `${field} must be a list.`)
  if (raw.length > PRINT_LAYOUT_LIMITS.columns) throw layoutInvalid(field, `${field} can have at most ${PRINT_LAYOUT_LIMITS.columns} columns.`)
  return raw.map((column, index) => {
    const path = `${field}.${index}`
    if (!isObject(column)) throw layoutInvalid(path, `${path} is invalid.`)
    return defined([
      ['key', layoutText(`${path}.key`, column.key, PRINT_LAYOUT_LIMITS.field, { required: true, pattern: LAYOUT_ID })],
      ['title', layoutText(`${path}.title`, column.title, PRINT_LAYOUT_LIMITS.title)],
      ['visible', layoutFlag(`${path}.visible`, column.visible, true)],
      ['width', layoutNumber(`${path}.width`, column.width, { min: 0, max: PRINT_LAYOUT_LIMITS.coordinate, optional: true })],
      ['align', layoutChoice(`${path}.align`, column.align, ALIGNMENTS, { optional: true })],
    ])
  })
}

function validateLayoutElement(field, raw) {
  if (!isObject(raw)) throw layoutInvalid(field, `${field} is invalid.`)
  const coordinate = PRINT_LAYOUT_LIMITS.coordinate
  return defined([
    ['id', layoutText(`${field}.id`, raw.id, PRINT_LAYOUT_LIMITS.id, { required: true, pattern: LAYOUT_ID })],
    ['type', layoutChoice(`${field}.type`, raw.type, PRINT_LAYOUT_ELEMENT_TYPES)],
    ['title', layoutText(`${field}.title`, raw.title, PRINT_LAYOUT_LIMITS.title)],
    ['value', layoutText(`${field}.value`, raw.value, PRINT_LAYOUT_LIMITS.value, { optional: true })],
    ['field', layoutText(`${field}.field`, raw.field, PRINT_LAYOUT_LIMITS.field, { optional: true })],
    ['placeholder', layoutText(`${field}.placeholder`, raw.placeholder, PRINT_LAYOUT_LIMITS.placeholder, { optional: true })],
    ['contentMode', layoutChoice(`${field}.contentMode`, raw.contentMode, ['static', 'field', 'instance'], { optional: true })],
    ['x', layoutNumber(`${field}.x`, raw.x, { min: -coordinate, max: coordinate })],
    ['y', layoutNumber(`${field}.y`, raw.y, { min: -coordinate, max: coordinate })],
    ['width', layoutNumber(`${field}.width`, raw.width, { min: 0, max: coordinate })],
    ['height', layoutNumber(`${field}.height`, raw.height, { min: 0, max: coordinate })],
    ['visible', layoutFlag(`${field}.visible`, raw.visible, true)],
    ['draggable', layoutFlag(`${field}.draggable`, raw.draggable, true)],
    ['resizable', layoutFlag(`${field}.resizable`, raw.resizable, true)],
    ['required', layoutFlag(`${field}.required`, raw.required, undefined)],
    ['style', validateLayoutStyle(`${field}.style`, raw.style)],
    ['tableColumns', validateLayoutColumns(`${field}.tableColumns`, raw.tableColumns)],
  ])
}

// One saved print layout, checked field by field; unknown keys are dropped.
// Whether it was a built-in layout is not stored: the built-in ones are in code.
export function validatePrintLayout(raw, field = 'layout') {
  if (!isObject(raw)) throw layoutInvalid(field, `${field} is invalid.`)
  const page = raw.page
  if (!isObject(page)) throw layoutInvalid(`${field}.page`, `${field}.page is invalid.`)
  if (!Array.isArray(raw.elements)) throw layoutInvalid(`${field}.elements`, `${field}.elements must be a list.`)
  if (raw.elements.length > PRINT_LAYOUT_LIMITS.elements) throw layoutInvalid(`${field}.elements`, `${field}.elements can have at most ${PRINT_LAYOUT_LIMITS.elements} elements.`)
  const id = layoutText(`${field}.id`, raw.id, PRINT_LAYOUT_LIMITS.id, { required: true, pattern: LAYOUT_ID })
  const name = layoutText(`${field}.name`, raw.name, PRINT_LAYOUT_LIMITS.name, { required: true })
  const documentType = layoutChoice(`${field}.documentType`, raw.documentType, PRINT_LAYOUT_DOCUMENT_TYPES)
  const version = layoutNumber(`${field}.version`, raw.version, { min: 0, max: 1_000_000_000, fallback: 1 })
  const updatedAt = layoutText(`${field}.updatedAt`, raw.updatedAt, 40, { optional: true })
  if (updatedAt && !Number.isFinite(Date.parse(updatedAt))) throw layoutInvalid(`${field}.updatedAt`, `${field}.updatedAt must be a date and time.`)
  const elements = raw.elements.map((element, index) => validateLayoutElement(`${field}.elements.${index}`, element))
  const elementIds = elements.map((element) => element.id)
  const repeated = elementIds.findIndex((elementId, index) => elementIds.indexOf(elementId) !== index)
  if (repeated >= 0) throw layoutInvalid(`${field}.elements.${repeated}.id`, `${field}.elements.${repeated}.id is used twice.`)
  return defined([
    ['id', id],
    ['name', name],
    ['documentType', documentType],
    ['version', version],
    ['page', {
      paper: layoutChoice(`${field}.page.paper`, page.paper, ['A4']),
      orientation: layoutChoice(`${field}.page.orientation`, page.orientation, ['portrait', 'landscape']),
      width: layoutNumber(`${field}.page.width`, page.width, { min: 1, max: PRINT_LAYOUT_LIMITS.coordinate }),
      height: layoutNumber(`${field}.page.height`, page.height, { min: 1, max: PRINT_LAYOUT_LIMITS.coordinate }),
      margin: layoutNumber(`${field}.page.margin`, page.margin, { min: 0, max: 1000 }),
    }],
    ['elements', elements],
    ['updatedAt', updatedAt || undefined],
  ])
}

const utf8Bytes = (value) => new TextEncoder().encode(value).length

// The workspace's saved print layouts: at most 20, each checked, ids unique,
// and at most 64 KB stored in all. Over a limit the save is refused with the
// field named, never cut short.
export function validatePrintLayouts(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw layoutInvalid('layouts', 'Print layouts must be a list.')
  if (raw.length > PRINT_LAYOUT_LIMITS.templates) throw invalid('DOCUMENT_LAYOUTS_TOO_MANY', 'layouts', `A workspace can save at most ${PRINT_LAYOUT_LIMITS.templates} print layouts.`, { limit: PRINT_LAYOUT_LIMITS.templates })
  const layouts = raw.map((layout, index) => validatePrintLayout(layout, `layouts.${index}`))
  const ids = layouts.map((layout) => layout.id)
  const repeated = ids.findIndex((id, index) => ids.indexOf(id) !== index)
  if (repeated >= 0) throw layoutInvalid(`layouts.${repeated}.id`, `layouts.${repeated}.id is used by another print layout.`)
  if (utf8Bytes(JSON.stringify(layouts)) > PRINT_LAYOUT_LIMITS.bytes) throw invalid('DOCUMENT_LAYOUTS_TOO_LARGE', 'layouts', `Print layouts can take at most ${PRINT_LAYOUT_LIMITS.bytes} bytes in all.`, { limit: PRINT_LAYOUT_LIMITS.bytes })
  return layouts
}

// The stored layouts for reading: one that does not pass the check is
// skipped, never thrown on.
function normalizePrintLayouts(raw) {
  if (!Array.isArray(raw)) return []
  const layouts = []
  for (const [index, layout] of raw.entries()) {
    if (layouts.length === PRINT_LAYOUT_LIMITS.templates) break
    try {
      const next = validatePrintLayout(layout, `layouts.${index}`)
      if (!layouts.some((item) => item.id === next.id)) layouts.push(next)
    } catch { /* skipped */ }
  }
  return layouts
}

// The stored section with the seed under it, for reading. Values of the wrong
// type are ignored, never thrown on: what was saved passed validation.
export function normalizeDocumentSettings(value) {
  const current = isObject(value) ? value : {}
  const letterhead = isObject(current.letterhead) ? current.letterhead : {}
  const purchaseOrder = isObject(current.purchaseOrder) ? current.purchaseOrder : {}
  const columns = isObject(purchaseOrder.columns) ? purchaseOrder.columns : {}
  const customerInvoice = isObject(current.customerInvoice) ? current.customerInvoice : {}
  const invoiceColumns = isObject(customerInvoice.columns) ? customerInvoice.columns : {}
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
    customerInvoice: {
      title: typeof customerInvoice.title === 'string' ? recorded(customerInvoice.title) : null,
      columns: Object.fromEntries(CUSTOMER_INVOICE_COLUMNS.map((key) => [key, typeof invoiceColumns[key] === 'boolean' ? invoiceColumns[key] : seed.customerInvoice.columns[key]])),
      showPaymentSummary: typeof customerInvoice.showPaymentSummary === 'boolean' ? customerInvoice.showPaymentSummary : seed.customerInvoice.showPaymentSummary,
      paymentInstructions: trimmed(customerInvoice.paymentInstructions),
      termsText: trimmed(customerInvoice.termsText),
      footerText: trimmed(customerInvoice.footerText),
    },
    layouts: normalizePrintLayouts(current.layouts),
  }
}

// A save of the section: the known fields only (anything else is dropped),
// each checked. A value over its limit is refused with the field named, not
// cut short.
export function validateDocumentSettings(value) {
  if (!isObject(value)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'documents', 'Document settings are invalid.')
  const letterhead = value.letterhead === undefined ? {} : value.letterhead
  const purchaseOrder = value.purchaseOrder === undefined ? {} : value.purchaseOrder
  const customerInvoice = value.customerInvoice === undefined ? {} : value.customerInvoice
  if (!isObject(letterhead)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'letterhead', 'The letterhead is invalid.')
  if (!isObject(purchaseOrder)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'purchaseOrder', 'The purchase order template is invalid.')
  const columns = purchaseOrder.columns === undefined ? {} : purchaseOrder.columns
  if (!isObject(columns)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'purchaseOrder.columns', 'The purchase order columns are invalid.')
  if (!isObject(customerInvoice)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'customerInvoice', 'The invoice template is invalid.')
  const invoiceColumns = customerInvoice.columns === undefined ? {} : customerInvoice.columns
  if (!isObject(invoiceColumns)) throw invalid('DOCUMENT_SETTINGS_INVALID', 'customerInvoice.columns', 'The invoice columns are invalid.')

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
  const seedInvoice = documentSettingsSeed.customerInvoice
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
    customerInvoice: {
      title: textField('customerInvoice.title', customerInvoice.title, DOCUMENT_SETTINGS_LIMITS.title, { nullable: true }),
      columns: Object.fromEntries(CUSTOMER_INVOICE_COLUMNS.map((key) => [key, flag(`customerInvoice.columns.${key}`, invoiceColumns[key], seedInvoice.columns[key])])),
      showPaymentSummary: flag('customerInvoice.showPaymentSummary', customerInvoice.showPaymentSummary, seedInvoice.showPaymentSummary),
      paymentInstructions: textField('customerInvoice.paymentInstructions', customerInvoice.paymentInstructions, DOCUMENT_SETTINGS_LIMITS.paymentInstructions, { nullable: false }),
      termsText: textField('customerInvoice.termsText', customerInvoice.termsText, DOCUMENT_SETTINGS_LIMITS.termsText, { nullable: false }),
      footerText: textField('customerInvoice.footerText', customerInvoice.footerText, DOCUMENT_SETTINGS_LIMITS.footerText, { nullable: false }),
    },
    layouts: validatePrintLayouts(value.layouts),
  }
}

// The invoice date: the invoice form stores the moment it was created, so it
// is printed as the day that moment falls on in the workspace timezone
// (`instant`); a value stored at exactly 00:00:00.000Z (or as a bare date) is
// a calendar day and stays that day (`day`). One of the two, or neither.
export function recordedDayOrInstant(value) {
  if (value === null || value === undefined || value === '') return { day: null, instant: null }
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value).trim())
  if (!Number.isFinite(time)) return { day: null, instant: null }
  const iso = new Date(time).toISOString()
  const bareDate = !(value instanceof Date) && /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())
  return bareDate || iso.endsWith('T00:00:00.000Z') ? { day: iso.slice(0, 10), instant: null } : { day: null, instant: iso }
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

// When the PO was last approved: the latest approve step the PO's approval
// timeline records; null when none was recorded (a PO seeded or imported as
// approved). Never today's date.
function approvedInstant(order) {
  const timeline = Array.isArray(order?.approvalTimeline) ? order.approvalTimeline : Array.isArray(order?.metadata?.approvalTimeline) ? order.metadata.approvalTimeline : []
  const approvals = timeline.filter((step) => step?.action === 'approve' && recorded(step.at) && Number.isFinite(Date.parse(step.at)))
  return approvals.length ? recorded(approvals[approvals.length - 1].at) : null
}

// The purchase order as a document. `order` is the PO as the detail route
// reads it (prices null without procurement.prices.read); `supplier` the
// stored supplier row; `warehouse` the PO's delivery warehouse ({ id, code,
// name }, which has no address); `supplierSkus` the supplier's item links
// ({ itemId, supplierSku, active }; an inactive link is not used); `letterhead`, `template` and `documentLanguage`
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
  const skuByItem = new Map((supplierSkus || []).filter((link) => link?.active !== false && recorded(link?.itemId) && recorded(link?.supplierSku)).map((link) => [recorded(link.itemId), recorded(link.supplierSku)]))
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
    // A PO is printed and sent before it is marked issued, so the copy sent
    // carries the recorded approval time.
    approvedAt: approvedInstant(order),
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
    // A warehouse has no address in FlowChain; the code and name are printed,
    // and nothing when the warehouse is not found.
    shipTo: { code: recorded(warehouse?.code), name: recorded(warehouse?.name) },
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
      // Only the date the supplier's promise recorded on the line; never the
      // PO's expected date, which is the buyer's own.
      promisedDate: calendarDay(line.recordedPromisedDate),
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

// Payment terms as recorded on a supplier or customer: the stored value is a
// payment term's id or code, or free text. Where the workspace's payment terms
// (PaymentTerm rows { id, code, name }) name it, the recorded name is printed;
// otherwise the value as stored. Null when nothing was recorded, never NET30.
export function recordedPaymentTerms(value, terms = []) {
  const stored = recorded(value)
  if (!stored) return null
  const rows = Array.isArray(terms) ? terms : []
  const match = rows.find((term) => recorded(term?.id) === stored) || rows.find((term) => recorded(term?.code) === stored)
  return recorded(match?.name) || stored
}

// The recorded customer fields an invoice prints, from the stored customer
// record (RuntimeRecord payload): the code, contact, phone, email, address and
// payment terms someone entered, each null when nobody did. A customer's
// payment terms are stored only when someone enters them (no form, import,
// view or seed fills them in), unlike a supplier's paymentTermsId, which
// defaults to NET30 and so is never printed. The customer's currency and
// credit standing are not read.
function customerParty(customer) {
  const payload = isObject(customer?.payload) ? customer.payload : {}
  return {
    code: recorded(payload.code) || recorded(customer?.recordKey),
    name: recorded(payload.name),
    contactName: recorded(payload.contact),
    email: recorded(payload.email),
    telephone: recorded(payload.phone),
    address: recorded(payload.address),
    paymentTerms: recorded(payload.paymentTerms),
  }
}

const sameCurrency = (left, right) => Boolean(left && right && left.toUpperCase() === right.toUpperCase())

// The customer invoice as a document. `invoice` is the invoice as the detail
// route reads it (amounts null without finance.amounts.read, the customer
// name null without finance.partner_snapshot.read, `receivable` null without
// finance.receivable.read or before issue); `customer` the stored customer
// record ({ id, recordKey, payload }), looked up only when the customer name
// came back visible; `paymentTerms` the workspace's payment terms that the
// customer's recorded terms name ({ id, code, name }); `letterhead`,
// `template` and `documentLanguage` the
// workspace's document settings; `workspace` its { legalName, name };
// `access.amounts` and `access.partner` whether the reader may see amounts
// and the customer.
export function buildCustomerInvoiceDocument({ invoice, customer = null, paymentTerms = [], letterhead = documentSettingsSeed.letterhead, template = documentSettingsSeed.customerInvoice, documentLanguage = documentSettingsSeed.documentLanguage, workspace = {}, access = {} }) {
  const status = recorded(invoice?.status)
  const partnerVisible = access.partner === true
  // Sending needs an issued invoice with its amounts and its customer: a role
  // that cannot see them gets no document to send rather than one with
  // blanks. An approved invoice is shown to be checked, never printed.
  const sendable = PRINTABLE_CUSTOMER_INVOICE_STATUSES.includes(status) || PREVIEW_CUSTOMER_INVOICE_STATUSES.includes(status)
  const printable = !sendable
    ? { ok: false, reason: 'status' }
    : access.amounts !== true || !partnerVisible
      ? { ok: false, reason: 'amounts_hidden' }
      : PREVIEW_CUSTOMER_INVOICE_STATUSES.includes(status)
        ? { ok: false, reason: 'not_issued' }
        : { ok: true, reason: null }
  // The customer master is used only when the customer may be seen; the name
  // printed is the one recorded on the invoice.
  const party = partnerVisible ? customerParty(customer) : customerParty(null)
  const currency = recorded(invoice?.currency)
  const receivable = isObject(invoice?.receivable) ? invoice.receivable : null
  // What was paid, credited and is still owed, from the receivable the reader
  // may see, with its amounts; only in the invoice's own currency, never
  // converted. Left off, not printed blank, when the amounts are hidden.
  const paymentSummary = template?.showPaymentSummary !== false && access.amounts === true && receivable && sameCurrency(recorded(receivable.currency), currency)
    ? { currency, amountPaid: recorded(receivable.paidAmount), creditsApplied: recorded(receivable.approvedCreditAmount), balanceDue: recorded(receivable.outstandingAmount) }
    : null
  return {
    kind: 'customer_invoice',
    invoiceId: recorded(invoice?.id),
    // The invoice number as recorded; never the internal id in its place.
    number: recorded(invoice?.invoiceNumber),
    status,
    invoiceDate: recordedDayOrInstant(invoice?.invoiceDate),
    dueDate: calendarDay(invoice?.dueDate),
    salesOrderNumber: recorded(invoice?.salesOrderNumber),
    shipmentNumber: recorded(invoice?.shipmentNumber),
    documentLanguage: DOCUMENT_LANGUAGES.includes(documentLanguage) ? documentLanguage : documentSettingsSeed.documentLanguage,
    printable,
    seller: {
      companyName: recorded(letterhead?.companyName) || recorded(workspace?.legalName) || recorded(workspace?.name),
      addressLines: Array.isArray(letterhead?.addressLines) ? letterhead.addressLines.map(recorded).filter(Boolean) : [],
      phone: recorded(letterhead?.phone),
      email: recorded(letterhead?.email),
      taxId: recorded(letterhead?.taxId),
    },
    billTo: {
      name: partnerVisible ? recorded(invoice?.customerName) || party.name : null,
      code: party.code,
      contactName: party.contactName,
      email: party.email,
      telephone: party.telephone,
      address: party.address,
    },
    // The customer's recorded payment terms; null (left off) when none were
    // recorded or the customer may not be seen.
    paymentTerms: recordedPaymentTerms(party.paymentTerms, paymentTerms),
    currency,
    lines: (Array.isArray(invoice?.lines) ? invoice.lines : []).map((line, index) => ({
      lineNo: Number.isInteger(line?.lineNumber) ? line.lineNumber : index + 1,
      sku: recorded(line?.sku),
      description: recorded(line?.itemName),
      quantity: recorded(line?.quantity),
      unit: recorded(line?.unit),
      unitPrice: recorded(line?.unitPrice),
      amount: recorded(line?.lineAmount),
      tax: recorded(line?.enteredTaxAmount),
      total: recorded(line?.totalAmount),
    })),
    // The amounts recorded on the invoice, in its one currency.
    totals: [{ currency, subtotal: recorded(invoice?.subtotalAmount), tax: recorded(invoice?.enteredTaxAmount), total: recorded(invoice?.totalAmount) }],
    paymentSummary,
    title: recorded(template?.title),
    columns: Object.fromEntries(CUSTOMER_INVOICE_COLUMNS.map((key) => [key, template?.columns?.[key] === true])),
    paymentInstructions: recorded(template?.paymentInstructions),
    termsText: recorded(template?.termsText),
    footerText: recorded(template?.footerText),
  }
}
