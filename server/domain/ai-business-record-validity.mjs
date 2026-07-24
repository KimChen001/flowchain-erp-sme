export const BUSINESS_RECORD_VALIDITY = Object.freeze({
  valid: 'valid',
  incomplete: 'incomplete',
  invalid: 'invalid',
  hidden: 'hidden',
  unavailable: 'unavailable',
})

export const BUSINESS_RESULT_STATES = Object.freeze([
  'confirmed',
  'confirmed_zero',
  'incomplete',
  'hidden',
  'unavailable',
])

const ENTITY_ALIASES = Object.freeze({
  supplier: 'supplier',
  payable: 'payable_obligation',
  payableobligation: 'payable_obligation',
  payable_obligation: 'payable_obligation',
  supplierinvoice: 'supplier_invoice',
  supplier_invoice: 'supplier_invoice',
  purchaseorder: 'purchase_order',
  purchase_order: 'purchase_order',
  receivingdocument: 'receiving_document',
  receiving_document: 'receiving_document',
  settlementdocument: 'settlement_document',
  settlement_document: 'settlement_document',
  bank_reconciliation: 'bank_reconciliation',
})

const PLACEHOLDER_ID = /^(?:unknown|n\/?a|none|null|undefined|placeholder|fallback|temp(?:orary)?|draft|po-0{3,}\d*|grn-0{3,}\d*)$/i
const GENERATED_FALLBACK_ID = /^(?:PO|GRN)-0{3,}\d+$/i

const text = (value) => String(value ?? '').trim()
const value = (record, keys) => keys.map((key) => record?.[key]).find((item) => item !== undefined && item !== null && text(item) !== '')

export function isAuthoritativeBusinessId(input) {
  const id = text(input)
  return Boolean(id) && !PLACEHOLDER_ID.test(id) && !GENERATED_FALLBACK_ID.test(id)
}

function required(record, key, aliases = []) {
  return value(record, [key, ...aliases])
}

function requiredId(record, aliases = []) {
  const candidate = required(record, 'id', aliases)
  return isAuthoritativeBusinessId(candidate) ? candidate : null
}

function finiteAmount(input) {
  if (input === '' || input === null || input === undefined) return false
  const parsed = typeof input?.toNumber === 'function' ? input.toNumber() : Number(input)
  return Number.isFinite(parsed)
}

const policies = Object.freeze({
  supplier(record) {
    const missing = []
    if (!required(record, 'tenantId')) missing.push('tenantId')
    if (!requiredId(record, ['supplierId'])) missing.push('supplierId')
    if (!required(record, 'name', ['supplierName', 'code', 'supplierCode'])) missing.push('name_or_code')
    return missing
  },
  payable_obligation(record) {
    const missing = []
    if (!required(record, 'tenantId')) missing.push('tenantId')
    if (!requiredId(record, ['obligationId'])) missing.push('id')
    if (!required(record, 'supplierId') && !required(record?.supplierInvoice || {}, 'supplierId')) missing.push('supplierId')
    if (!required(record, 'currency')) missing.push('currency')
    if (!finiteAmount(required(record, 'outstandingAmount'))) missing.push('outstandingAmount')
    const explicitNoDueDate = ['no_due_date', 'not_applicable'].includes(text(record?.dueDateState).toLowerCase())
    if (!required(record, 'dueDate') && !explicitNoDueDate) missing.push('dueDate')
    if (!required(record, 'status')) missing.push('status')
    return missing
  },
  supplier_invoice(record) {
    const missing = []
    if (!required(record, 'tenantId')) missing.push('tenantId')
    if (!requiredId(record, ['invoiceId'])) missing.push('id')
    if (!required(record, 'supplierId')) missing.push('supplierId')
    if (!required(record, 'invoiceNumber')) missing.push('invoiceNumber')
    if (!finiteAmount(required(record, 'amount', ['totalAmount']))) missing.push('amount')
    if (!required(record, 'status')) missing.push('status')
    return missing
  },
  purchase_order(record) {
    const missing = []
    if (!required(record, 'tenantId')) missing.push('tenantId')
    if (!requiredId(record, ['orderNumber', 'po'])) missing.push('id_or_orderNumber')
    if (!required(record, 'supplierId')) missing.push('supplierId')
    if (!required(record, 'status')) missing.push('status')
    return missing
  },
  receiving_document(record) {
    const missing = []
    if (!required(record, 'tenantId')) missing.push('tenantId')
    if (!requiredId(record, ['documentNumber', 'grn'])) missing.push('id_or_documentNumber')
    if (!required(record, 'poId', ['po'])) missing.push('poId')
    if (!required(record, 'status')) missing.push('status')
    return missing
  },
  settlement_document(record) {
    const missing = []
    if (!required(record, 'tenantId')) missing.push('tenantId')
    if (!requiredId(record, ['settlementNumber'])) missing.push('id')
    if (!required(record, 'counterpartyId', ['counterpartyName', 'counterpartyNameSnapshot', 'counterparty'])) missing.push('counterparty')
    if (!finiteAmount(required(record, 'amount'))) missing.push('amount')
    if (!required(record, 'postingStatus')) missing.push('postingStatus')
    return missing
  },
  bank_reconciliation(record) {
    if (record?.safeDto !== true && record?.projection !== 'bank_ai_context_safe_v1') return ['safeDto']
    return []
  },
})

export function classifyBusinessRecord(entityType, record, options = {}) {
  if (options.available === false) return { state: BUSINESS_RECORD_VALIDITY.unavailable, missingFields: [], reason: options.reason || 'source_unavailable' }
  if (options.visible === false) return { state: BUSINESS_RECORD_VALIDITY.hidden, missingFields: [], reason: options.reason || 'permission_denied' }
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length === 0) {
    return { state: BUSINESS_RECORD_VALIDITY.invalid, missingFields: [], reason: 'empty_record' }
  }
  const normalizedType = ENTITY_ALIASES[text(entityType).toLowerCase()]
  const policy = policies[normalizedType]
  if (!policy) return { state: BUSINESS_RECORD_VALIDITY.invalid, missingFields: [], reason: 'unknown_entity_type' }
  const missingFields = policy(record)
  const identifierKeys = ['id', 'supplierId', 'invoiceId', 'obligationId', 'orderNumber', 'po', 'documentNumber', 'grn', 'settlementNumber']
  const presentIdentifier = value(record, identifierKeys)
  if (presentIdentifier && !isAuthoritativeBusinessId(presentIdentifier)) {
    return { state: BUSINESS_RECORD_VALIDITY.invalid, missingFields, reason: 'placeholder_identifier' }
  }
  if (missingFields.length) return { state: BUSINESS_RECORD_VALIDITY.incomplete, missingFields, reason: 'required_fields_missing' }
  return { state: BUSINESS_RECORD_VALIDITY.valid, missingFields: [], reason: null }
}

export function partitionBusinessRecords(entityType, records, options = {}) {
  if (options.available === false) {
    return { validRecords: [], incompleteRecords: [], invalidRecords: [], hiddenRecords: [], unavailable: true, recordValiditySummary: validitySummary({ unavailable: true }) }
  }
  if (options.visible === false) {
    const hiddenRecords = Array.isArray(records) ? records : []
    return { validRecords: [], incompleteRecords: [], invalidRecords: [], hiddenRecords, unavailable: false, recordValiditySummary: validitySummary({ hiddenCount: hiddenRecords.length }) }
  }
  const output = { validRecords: [], incompleteRecords: [], invalidRecords: [], hiddenRecords: [], unavailable: false }
  for (const record of Array.isArray(records) ? records : []) {
    const classification = classifyBusinessRecord(entityType, record, options)
    const item = { record, validity: classification }
    if (classification.state === 'valid') output.validRecords.push(record)
    else if (classification.state === 'incomplete') output.incompleteRecords.push(item)
    else if (classification.state === 'hidden') output.hiddenRecords.push(record)
    else output.invalidRecords.push(item)
  }
  return { ...output, recordValiditySummary: validitySummary({
    validCount: output.validRecords.length,
    incompleteCount: output.incompleteRecords.length,
    invalidCount: output.invalidRecords.length,
    hiddenCount: output.hiddenRecords.length,
  }) }
}

export function validitySummary(input = {}) {
  return {
    validCount: Number(input.validCount || 0),
    incompleteCount: Number(input.incompleteCount || 0),
    invalidCount: Number(input.invalidCount || 0),
    hiddenCount: Number(input.hiddenCount || 0),
    unavailable: Boolean(input.unavailable),
  }
}

export function resultStateForValidity(summary, confirmedCount = 0) {
  if (summary?.unavailable) return 'unavailable'
  if (Number(summary?.hiddenCount || 0) > 0 && Number(summary?.validCount || 0) === 0) return 'hidden'
  if (Number(confirmedCount) > 0) return 'confirmed'
  if (Number(summary?.incompleteCount || 0) > 0) return 'incomplete'
  return 'confirmed_zero'
}
