import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  assertSupportedCurrency,
  assertSupportedLanguage,
  assertSupportedLocale,
  assertSupportedTimezone,
  effectiveLanguage,
  mergeOperationalSettings,
  normalizeLanguagePreference,
  OPERATIONAL_SETTINGS_IN_EFFECT,
  REVIEW_TOLERANCE_FIELDS,
  validateOperationalSection,
} from './workspace-settings-contract.mjs'

test('workspace localization priority separates language, locale, and timezone', () => {
  const tenant = { defaultLanguage: 'en-US', locale: 'zh-CN', timezone: 'America/New_York' }
  assert.equal(effectiveLanguage({ languagePreference: 'zh-CN' }, tenant), 'zh-CN')
  assert.equal(effectiveLanguage({ languagePreference: null }, tenant), 'en-US')
  assert.equal(effectiveLanguage({}, { defaultLanguage: '' }), 'en-US')
  assert.equal(normalizeLanguagePreference('workspace'), null)
  assert.equal(tenant.locale, 'zh-CN')
  assert.equal(tenant.timezone, 'America/New_York')
})

test('workspace localization and base currency accept only governed values', () => {
  assert.equal(assertSupportedLanguage('en-US'), 'en-US')
  assert.equal(assertSupportedLocale('zh-CN'), 'zh-CN')
  assert.equal(assertSupportedTimezone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(assertSupportedCurrency('usd'), 'USD')
  assert.throws(() => assertSupportedLanguage('fr-FR'), error => error.code === 'LANGUAGE_NOT_SUPPORTED')
  assert.throws(() => assertSupportedLocale('fr-FR'), error => error.code === 'LOCALE_NOT_SUPPORTED')
  assert.throws(() => assertSupportedTimezone('free text'), error => error.code === 'TIMEZONE_NOT_SUPPORTED')
  assert.throws(() => assertSupportedCurrency('人民币'), error => error.code === 'CURRENCY_NOT_SUPPORTED')
})

test('PostgreSQL operational settings seed covers Phase 4 numbering and review policies', () => {
  const settings = mergeOperationalSettings({})
  for (const name of ['Return Request', 'Return Authorization', 'Return Posting', 'Supplier Invoice', 'Customer Invoice', 'Credit Memo / Credit Note']) {
    assert.ok(settings.numbering.rules.some(rule => rule.document === name))
  }
  for (const name of ['Return Authorization', 'Supplier Invoice Match Exception', 'Payable Approval', 'Customer Credit Note Approval']) {
    assert.ok(settings.review.policies.some(policy => policy.name === name))
  }
})

test('formal settings navigation removes legacy mixed-language entries and uses i18n keys', () => {
  const routes = readFileSync(new URL('../../src/app/routeRegistry.tsx', import.meta.url), 'utf8')
  const i18n = readFileSync(new URL('../../src/i18n/I18n.tsx', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('../../src/modules/settings/WorkspaceSettings.tsx', import.meta.url), 'utf8')
  for (const legacy of ['settings:workspace', 'settings:pilot-users', 'settings:pilot-setup', 'Pilot Users', 'Pilot Setup Status']) assert.doesNotMatch(routes, new RegExp(legacy))
  for (const key of ['settings.profile', 'settings.company', 'settings.roles', 'settings.warehouse', 'settings.readiness']) assert.match(i18n, new RegExp(`"${key.replace('.', '\\.')}"`))
  assert.match(workspace, /flowchain:localization-changed/)
  assert.match(workspace, /locale-format-preview/)
})

const serverRoot = resolve(import.meta.dirname, '..')
const serverSources = () => {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) files.push(path)
    }
  }
  walk(serverRoot)
  return files.map(path => ({ path: relative(serverRoot, path).replaceAll('\\', '/'), source: readFileSync(path, 'utf8') }))
}

test('only the four invoice matching tolerances, the AI switch and the document settings are read from the operational settings the UI edits', () => {
  assert.deepEqual(REVIEW_TOLERANCE_FIELDS, ['quantityTolerance', 'pricePercentageTolerance', 'priceAbsoluteTolerance', 'amountTolerance'])
  assert.deepEqual(OPERATIONAL_SETTINGS_IN_EFFECT, { numbering: [], review: REVIEW_TOLERANCE_FIELDS, modules: [], ai: ['modelAssistEnabled'], advanced: [], documents: ['documentLanguage', 'letterhead', 'purchaseOrder', 'customerInvoice'] })

  const sources = serverSources()
  // Every server reader of tenant.operationalSettings. The PO and invoice documents read
  // the documents section through mergeOperationalSettings. The settlement services
  // read settlementPolicy, which the settings UI never edits; Mobile Sync reads
  // module visibility but is outside the US trial capability set.
  assert.deepEqual(sources.filter(file => /operationalSettings/.test(file.source)).map(file => file.path).sort(), [
    'domain/ai-workspace-access.mjs',
    'domain/customer-invoice-document-read-service.mjs',
    'domain/internal-settlement-command-service.mjs',
    'domain/internal-settlement-read-service.mjs',
    'domain/mobile-sync-entity-policy.mjs',
    'domain/mobile-sync-service.mjs',
    'domain/operational-finance-policy.mjs',
    'domain/purchase-order-document-read-service.mjs',
    'domain/workspace-settings-contract.mjs',
    'routes/settings-runtime.routes.mjs',
  ])
  // The assistant reads only the AI switch (ai-workspace-access.mjs).
  const access = sources.find(file => file.path === 'domain/ai-workspace-access.mjs').source
  assert.deepEqual([...new Set([...access.matchAll(/\.ai\.([A-Za-z]+)/g)].map(match => match[1]))], ['modelAssistEnabled'])
  const finance = sources.find(file => file.path === 'domain/operational-finance-policy.mjs').source
  assert.deepEqual([...new Set([...finance.matchAll(/review\.([A-Za-z]+)/g)].map(match => match[1]))].sort(), [...REVIEW_TOLERANCE_FIELDS].sort())

  // Settings marked "Not in effect yet" have no reader anywhere on the server.
  for (const key of ['nextSequence', 'sequenceLength', 'amountThreshold', 'inventoryTolerancePercent', 'reviewerRoles', 'defaultModule', 'evidenceRequired', 'retainDays', 'sessionTimeoutMinutes', 'exportLimit', 'negativeInventoryBlocked', 'maintenanceNotice']) {
    const readers = sources.filter(file => file.path !== 'domain/workspace-settings-contract.mjs' && new RegExp(`\\b${key}\\b`).test(file.source)).map(file => file.path)
    assert.deepEqual(readers, [], key)
  }
})

test('invoice matching tolerances are validated and stored as decimal strings', () => {
  const review = mergeOperationalSettings({}).review
  const saved = validateOperationalSection('review', { ...review, quantityTolerance: ' 1.5 ', pricePercentageTolerance: 2, priceAbsoluteTolerance: '0.25', amountTolerance: '10.0000' })
  assert.equal(saved.quantityTolerance, '1.5')
  assert.equal(saved.pricePercentageTolerance, '2')
  assert.equal(saved.priceAbsoluteTolerance, '0.25')
  assert.equal(saved.amountTolerance, '10.0000')
  assert.equal(saved.amountThreshold, review.amountThreshold, 'stored review values outside the tolerances are kept')

  for (const [field, value] of [['quantityTolerance', '-1'], ['amountTolerance', 'abc'], ['priceAbsoluteTolerance', '0.12345'], ['pricePercentageTolerance', '100.5'], ['amountTolerance', '']]) {
    assert.throws(() => validateOperationalSection('review', { ...review, [field]: value }), error => error.code === 'REVIEW_TOLERANCE_INVALID' && error.status === 400 && error.details.field === field, `${field}=${value}`)
  }
  assert.doesNotThrow(() => validateOperationalSection('review', { policies: [] }), 'older clients that omit tolerances keep the stored defaults')
})

test('document settings default to English with nothing invented and keep only known fields', () => {
  const documents = mergeOperationalSettings({}).documents
  assert.equal(documents.documentLanguage, 'en-US')
  assert.deepEqual(documents.letterhead, { companyName: null, addressLines: [], phone: null, email: null, taxId: null })
  assert.equal(documents.purchaseOrder.termsText, '')
  assert.equal(mergeOperationalSettings({ documents: { documentLanguage: 'zh-CN', letterhead: { companyName: ' Harbor Goods LLC ' } } }).documents.letterhead.companyName, 'Harbor Goods LLC')

  const saved = validateOperationalSection('documents', {
    documentLanguage: 'zh-CN',
    surprise: 'dropped',
    letterhead: { companyName: '  Harbor Goods LLC ', addressLines: ['12 Pier Road', '  ', 'Oakland, CA 94607'], phone: '', email: 'buying@harbor.example', taxId: null, logo: 'dropped' },
    purchaseOrder: { title: '', columns: { supplierSku: false, requestedDate: true, extra: true }, termsText: ' Net 30 from invoice. ', footerText: '', signatureBlock: true, paymentTerms: 'NET30' },
  })
  assert.deepEqual(saved, {
    version: 1,
    documentLanguage: 'zh-CN',
    letterhead: { companyName: 'Harbor Goods LLC', addressLines: ['12 Pier Road', 'Oakland, CA 94607'], phone: null, email: 'buying@harbor.example', taxId: null },
    purchaseOrder: { title: null, columns: { supplierSku: false, requestedDate: true, promisedDate: false }, termsText: 'Net 30 from invoice.', footerText: '', signatureBlock: true },
    customerInvoice: { title: null, columns: { tax: false }, showPaymentSummary: true, paymentInstructions: '', termsText: '', footerText: '' },
  })
})

test('document settings over their limits are refused with the field named', () => {
  const cases = [
    [{ purchaseOrder: { termsText: 'x'.repeat(4001) } }, 'DOCUMENT_SETTING_TOO_LONG', 'purchaseOrder.termsText'],
    [{ purchaseOrder: { footerText: 'x'.repeat(501) } }, 'DOCUMENT_SETTING_TOO_LONG', 'purchaseOrder.footerText'],
    [{ letterhead: { addressLines: ['x'.repeat(121)] } }, 'DOCUMENT_SETTING_TOO_LONG', 'letterhead.addressLines.0'],
    [{ letterhead: { addressLines: ['1', '2', '3', '4', '5', '6', '7'] } }, 'DOCUMENT_SETTING_TOO_MANY_LINES', 'letterhead.addressLines'],
    [{ letterhead: { companyName: 42 } }, 'DOCUMENT_SETTING_INVALID', 'letterhead.companyName'],
    [{ purchaseOrder: { columns: { promisedDate: 'yes' } } }, 'DOCUMENT_SETTING_INVALID', 'purchaseOrder.columns.promisedDate'],
    [{ documentLanguage: 'fr-FR' }, 'DOCUMENT_LANGUAGE_NOT_SUPPORTED', 'documentLanguage'],
  ]
  for (const [value, code, field] of cases) {
    assert.throws(() => validateOperationalSection('documents', value), (error) => error.code === code && error.status === 400 && error.details.field === field, field)
  }
  assert.doesNotThrow(() => validateOperationalSection('documents', { purchaseOrder: { termsText: 'x'.repeat(4000), footerText: 'x'.repeat(500) }, letterhead: { addressLines: ['1', '2', '3', '4', '5', '6'] } }))
})

test('document settings are saved with the workspace manage permission', () => {
  const routes = readFileSync(new URL('../routes/settings-runtime.routes.mjs', import.meta.url), 'utf8')
  assert.match(routes, /documents: 'settings.workspace.manage'/)
  // A refused value names its field; other errors (a denied permission) carry no details.
  assert.ok(routes.includes('error?.status === 400 && error?.details?.field ? { details: error.details } : {}'))
})

test('the invoice template starts with no tax column and the payment summary on, and keeps only known fields', () => {
  assert.deepEqual(mergeOperationalSettings({}).documents.customerInvoice, { title: null, columns: { tax: false }, showPaymentSummary: true, paymentInstructions: '', termsText: '', footerText: '' })
  // A workspace saved before the invoice template existed reads the defaults.
  assert.deepEqual(mergeOperationalSettings({ documents: { purchaseOrder: { termsText: 'Net 30' } } }).documents.customerInvoice.columns, { tax: false })
  assert.equal(mergeOperationalSettings({ documents: { customerInvoice: { showPaymentSummary: 'no', columns: { tax: 'yes' } } } }).documents.customerInvoice.showPaymentSummary, true, 'a stored value of the wrong type is ignored')

  const saved = validateOperationalSection('documents', {
    customerInvoice: { title: '  Tax Invoice ', columns: { tax: true, discount: true }, showPaymentSummary: false, paymentInstructions: ' Wire to account on file. ', termsText: ' Due on receipt. ', footerText: '', currency: 'USD', paymentTerms: 'NET30' },
  }).customerInvoice
  assert.deepEqual(saved, { title: 'Tax Invoice', columns: { tax: true }, showPaymentSummary: false, paymentInstructions: 'Wire to account on file.', termsText: 'Due on receipt.', footerText: '' })
})

test('invoice template values over their limits are refused with the field named', () => {
  const cases = [
    [{ customerInvoice: { paymentInstructions: 'x'.repeat(2001) } }, 'DOCUMENT_SETTING_TOO_LONG', 'customerInvoice.paymentInstructions', 2000],
    [{ customerInvoice: { termsText: 'x'.repeat(4001) } }, 'DOCUMENT_SETTING_TOO_LONG', 'customerInvoice.termsText', 4000],
    [{ customerInvoice: { footerText: 'x'.repeat(501) } }, 'DOCUMENT_SETTING_TOO_LONG', 'customerInvoice.footerText', 500],
    [{ customerInvoice: { title: 'x'.repeat(121) } }, 'DOCUMENT_SETTING_TOO_LONG', 'customerInvoice.title', 120],
    [{ customerInvoice: { columns: { tax: 'yes' } } }, 'DOCUMENT_SETTING_INVALID', 'customerInvoice.columns.tax'],
    [{ customerInvoice: { showPaymentSummary: 1 } }, 'DOCUMENT_SETTING_INVALID', 'customerInvoice.showPaymentSummary'],
    [{ customerInvoice: { paymentInstructions: 7 } }, 'DOCUMENT_SETTING_INVALID', 'customerInvoice.paymentInstructions'],
    [{ customerInvoice: 'Invoice' }, 'DOCUMENT_SETTINGS_INVALID', 'customerInvoice'],
    [{ customerInvoice: { columns: [] } }, 'DOCUMENT_SETTINGS_INVALID', 'customerInvoice.columns'],
  ]
  for (const [value, code, field, limit] of cases) {
    assert.throws(() => validateOperationalSection('documents', value), (error) => error.code === code && error.status === 400 && error.details.field === field && (limit === undefined || error.details.limit === limit), field)
  }
  assert.doesNotThrow(() => validateOperationalSection('documents', { customerInvoice: { paymentInstructions: 'x'.repeat(2000), termsText: 'x'.repeat(4000), footerText: 'x'.repeat(500), title: 'x'.repeat(120) } }))
})
