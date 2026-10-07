import { documentSettingsSeed, normalizeDocumentSettings, validateDocumentSettings } from '../../shared/business-documents.mjs'

export const SUPPORTED_LANGUAGES = ['en-US', 'zh-CN']
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US']
export const SUPPORTED_TIMEZONES = [
  'Asia/Shanghai',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
]
export const SUPPORTED_CURRENCIES = ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD']

export const operationalSettingsSeed = {
  numbering: {
    rules: [
      ['NUM-PO', 'Purchase Order', 'PO'],
      ['NUM-GRN', 'Receiving Document', 'GRN'],
      ['NUM-RR', 'Return Request', 'RR'],
      ['NUM-RA', 'Return Authorization', 'RA'],
      ['NUM-RP', 'Return Posting', 'RP'],
      ['NUM-SI', 'Supplier Invoice', 'SI'],
      ['NUM-CI', 'Customer Invoice', 'CI'],
      ['NUM-CM', 'Credit Memo / Credit Note', 'CM'],
    ].map(([id, document, prefix]) => ({
      id, document, prefix, datePattern: 'YYYYMM', separator: '-', sequenceLength: 4, nextSequence: 1,
    })),
  },
  review: {
    policies: [
      { id: 'return-authorization', name: 'Return Authorization', enabled: true, reviewerRoles: ['admin', 'manager'] },
      { id: 'supplier-invoice-match-exception', name: 'Supplier Invoice Match Exception', enabled: true, reviewerRoles: ['admin', 'manager'] },
      { id: 'payable-approval', name: 'Payable Approval', enabled: true, reviewerRoles: ['admin', 'manager'] },
      { id: 'customer-credit-note-approval', name: 'Customer Credit Note Approval', enabled: true, reviewerRoles: ['admin', 'manager'] },
    ],
    amountThreshold: 100000,
    quantityTolerance: '0.0000',
    pricePercentageTolerance: '0.0000',
    priceAbsoluteTolerance: '0.0000',
    amountTolerance: '0.0000',
    riskLevels: ['high'],
    inventoryTolerancePercent: 5,
    reviewerRoles: ['admin', 'manager'],
    enabled: true,
  },
  modules: {
    defaultModule: 'overview',
    items: [
      ['overview', '今日工作台'], ['procurement', '采购执行'], ['inventory', '库存管理'], ['sales', '销售与需求'],
      ['finance', '结算管理'], ['reports', '报表中心'], ['master-data', '主数据'], ['settings', '系统管理'],
    ].map(([id, label], index) => ({ id, label, enabled: true, order: index + 1, roles: ['admin', 'manager'] })),
  },
  ai: {
    // Off by default: the workspace calls no model until an administrator
    // switches AI features on (ai-workspace-access.mjs).
    modelAssistEnabled: false,
    capabilities: [
      { id: 'answer', label: '业务问答与解释', level: 'allow' },
      { id: 'draft', label: '生成业务草稿', level: 'review_required' },
      { id: 'write', label: '业务数据变更', level: 'draft_only' },
      { id: 'external', label: '对外发送', level: 'deny' },
    ],
    evidenceRequired: true,
    retainDays: 90,
  },
  advanced: {
    sessionTimeoutMinutes: 60,
    exportLimit: 5000,
    dateFormat: 'YYYY-MM-DD',
    negativeInventoryBlocked: true,
    maintenanceNotice: '',
  },
  // Letterhead and templates of the documents a person prints and sends
  // (shared/business-documents.mjs).
  documents: documentSettingsSeed,
}

// The operational settings FlowChain reads today: three-way match applies the
// four invoice matching tolerances (operational-finance-policy.mjs), and the
// PO and invoice documents print the document settings
// (purchase-order-document-read-service.mjs, customer-invoice-document-read-service.mjs);
// the print-layout editor in the browser prints with the saved layouts.
// Nothing reads the other sections yet, so the settings UI shows them
// read-only as "Not in effect yet" and keeps their stored values.
export const REVIEW_TOLERANCE_FIELDS = ['quantityTolerance', 'pricePercentageTolerance', 'priceAbsoluteTolerance', 'amountTolerance']
export const OPERATIONAL_SETTINGS_IN_EFFECT = Object.freeze({ numbering: [], review: REVIEW_TOLERANCE_FIELDS, modules: [], ai: ['modelAssistEnabled'], advanced: [], documents: ['documentLanguage', 'letterhead', 'purchaseOrder', 'customerInvoice', 'layouts'] })
const TOLERANCE_PATTERN = /^\d+(\.\d{1,4})?$/

const clone = value => structuredClone(value)
const text = value => String(value ?? '').trim()

export function normalizeLanguagePreference(value) {
  const next = text(value)
  if (!next || next === 'workspace') return null
  if (!SUPPORTED_LANGUAGES.includes(next)) throw Object.assign(new Error('Unsupported interface language.'), { code: 'LANGUAGE_NOT_SUPPORTED', status: 400 })
  return next
}

export function assertSupportedLocale(value) {
  const next = text(value)
  if (!SUPPORTED_LOCALES.includes(next)) throw Object.assign(new Error('Unsupported locale.'), { code: 'LOCALE_NOT_SUPPORTED', status: 400 })
  return next
}

export function assertSupportedLanguage(value) {
  const next = text(value)
  if (!SUPPORTED_LANGUAGES.includes(next)) throw Object.assign(new Error('Unsupported interface language.'), { code: 'LANGUAGE_NOT_SUPPORTED', status: 400 })
  return next
}

export function assertSupportedTimezone(value) {
  const next = text(value)
  if (!SUPPORTED_TIMEZONES.includes(next)) throw Object.assign(new Error('Timezone must be selected from the supported IANA list.'), { code: 'TIMEZONE_NOT_SUPPORTED', status: 400 })
  return next
}

export function assertSupportedCurrency(value) {
  const next = text(value).toUpperCase()
  if (!/^[A-Z]{3}$/.test(next) || !SUPPORTED_CURRENCIES.includes(next)) throw Object.assign(new Error('Base currency must be a supported ISO 4217 code.'), { code: 'CURRENCY_NOT_SUPPORTED', status: 400 })
  return next
}

export function effectiveLanguage(user, tenant) {
  return normalizeLanguagePreference(user?.languagePreference) || (SUPPORTED_LANGUAGES.includes(tenant?.defaultLanguage) ? tenant.defaultLanguage : 'en-US')
}

export function mergeOperationalSettings(value) {
  const current = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    numbering: { ...clone(operationalSettingsSeed.numbering), ...(current.numbering || {}), rules: Array.isArray(current.numbering?.rules) ? clone(current.numbering.rules) : clone(operationalSettingsSeed.numbering.rules) },
    review: { ...clone(operationalSettingsSeed.review), ...(current.review || {}), policies: Array.isArray(current.review?.policies) ? clone(current.review.policies) : clone(operationalSettingsSeed.review.policies) },
    modules: { ...clone(operationalSettingsSeed.modules), ...(current.modules || {}), items: Array.isArray(current.modules?.items) ? clone(current.modules.items) : clone(operationalSettingsSeed.modules.items) },
    ai: { ...clone(operationalSettingsSeed.ai), ...(current.ai || {}), capabilities: Array.isArray(current.ai?.capabilities) ? clone(current.ai.capabilities) : clone(operationalSettingsSeed.ai.capabilities) },
    advanced: { ...clone(operationalSettingsSeed.advanced), ...(current.advanced || {}) },
    documents: normalizeDocumentSettings(current.documents),
  }
}

// What the audit log keeps of a section. The documents section keeps its
// print layouts as a summary (how many, their ids, names and versions), so a
// template save does not copy every layout into the log twice.
export function auditSettingsValue(section, value) {
  if (section !== 'documents' || !value || typeof value !== 'object') return clone(value)
  const layouts = Array.isArray(value.layouts) ? value.layouts : []
  const unreadable = Array.isArray(value.unreadableLayouts) ? value.unreadableLayouts : []
  return {
    ...clone(value),
    layouts: { count: layouts.length, items: layouts.map(layout => ({ id: layout?.id ?? null, name: layout?.name ?? null, documentType: layout?.documentType ?? null, version: layout?.version ?? null })) },
    unreadableLayouts: { count: unreadable.length },
  }
}

// `options.stored` is the section as stored now; the documents section checks
// its print layouts against it (shared/business-documents.mjs).
export function validateOperationalSection(section, value, options = {}) {
  if (!['numbering', 'review', 'modules', 'ai', 'advanced', 'documents'].includes(section)) throw Object.assign(new Error('Unknown settings section.'), { code: 'SETTINGS_SECTION_NOT_FOUND', status: 404 })
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Settings payload is invalid.'), { code: 'SETTINGS_VALIDATION_FAILED', status: 400 })
  // Only the known fields are kept; a value over its limit names the field.
  if (section === 'documents') return validateDocumentSettings(value, options)
  if (section === 'numbering') {
    const rules = Array.isArray(value.rules) ? value.rules : []
    const signatures = rules.map(rule => `${text(rule.prefix).toUpperCase()}|${text(rule.datePattern)}|${text(rule.separator)}`)
    if (!rules.length || new Set(signatures).size !== signatures.length) throw Object.assign(new Error('Numbering rules are empty or conflicting.'), { code: 'NUMBERING_RULE_CONFLICT', status: 409 })
  }
  if (section === 'review' && !Array.isArray(value.policies)) throw Object.assign(new Error('Review policies are required.'), { code: 'REVIEW_POLICY_VALIDATION_FAILED', status: 400 })
  if (section === 'review') {
    const next = clone(value)
    for (const field of REVIEW_TOLERANCE_FIELDS) {
      if (value[field] === undefined) continue
      const raw = text(value[field])
      if (!TOLERANCE_PATTERN.test(raw) || (field === 'pricePercentageTolerance' && Number(raw) > 100)) {
        throw Object.assign(new Error(`${field} must be a number of 0 or more with up to four decimal places.`), { code: 'REVIEW_TOLERANCE_INVALID', status: 400, details: { field } })
      }
      next[field] = raw
    }
    return next
  }
  if (section === 'ai' && value.modelAssistEnabled !== undefined && typeof value.modelAssistEnabled !== 'boolean') {
    throw Object.assign(new Error('modelAssistEnabled must be true or false.'), { code: 'AI_SETTINGS_INVALID', status: 400, details: { field: 'modelAssistEnabled' } })
  }
  if (section === 'modules') {
    const items = Array.isArray(value.items) ? value.items : []
    for (const protectedId of ['overview', 'settings']) if (!items.some(item => item.id === protectedId && item.enabled)) throw Object.assign(new Error('Overview and Settings cannot be disabled.'), { code: 'PROTECTED_MODULE_REQUIRED', status: 409 })
    if (!items.some(item => item.id === value.defaultModule && item.enabled)) throw Object.assign(new Error('Default module must be enabled.'), { code: 'DEFAULT_MODULE_DISABLED', status: 409 })
  }
  return clone(value)
}
