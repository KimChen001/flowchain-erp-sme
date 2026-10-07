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

// An invoice is a document to send once it is issued (and stays one if the
// customer disputes it). An approved invoice can be looked over on screen
// before it is issued, but not printed.
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
// ({ itemId, supplierSku, active }; an inactive link is not used);
// `paymentTerms` the workspace's payment terms that the supplier's recorded
// terms name ({ id, code, name }); `letterhead`, `template` and `documentLanguage`
// the workspace's document settings; `workspace` its { legalName, name };
// `access.prices` whether the reader may see prices.
export function buildPurchaseOrderDocument({ order, supplier = null, warehouse = null, supplierSkus = [], paymentTerms = [], letterhead = documentSettingsSeed.letterhead, template = documentSettingsSeed.purchaseOrder, documentLanguage = documentSettingsSeed.documentLanguage, workspace = {}, access = {} }) {
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
  const supplierMeta = isObject(supplier?.metadata) ? supplier.metadata : {}
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
    // The supplier's recorded payment terms (from the stored row, never the
    // master data view's NET30); null, and left off, when none were recorded.
    paymentTerms: recordedPaymentTerms(recorded(supplierMeta.paymentTermsId) || recorded(supplierMeta.paymentTerms), paymentTerms),
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
// payment terms someone entered, each null when nobody did. The customer's
// currency and credit standing are not read.
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
  // may see; only in the invoice's own currency, never converted.
  const paymentSummary = template?.showPaymentSummary !== false && receivable && sameCurrency(recorded(receivable.currency), currency)
    ? { currency, amountPaid: recorded(receivable.paidAmount), creditsApplied: recorded(receivable.approvedCreditAmount), balanceDue: recorded(receivable.outstandingAmount) }
    : null
  return {
    kind: 'customer_invoice',
    invoiceId: recorded(invoice?.id),
    number: recorded(invoice?.invoiceNumber) || recorded(invoice?.id),
    status,
    invoiceDate: calendarDay(invoice?.invoiceDate),
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
