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
  auditSettingsValue,
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

test('only the four invoice matching tolerances, PO approval from an approved request, the AI switch and the document settings are read from the operational settings the UI edits', () => {
  assert.deepEqual(REVIEW_TOLERANCE_FIELDS, ['quantityTolerance', 'pricePercentageTolerance', 'priceAbsoluteTolerance', 'amountTolerance'])
  assert.deepEqual(OPERATIONAL_SETTINGS_IN_EFFECT, { numbering: [], review: [...REVIEW_TOLERANCE_FIELDS, 'approvedRequestApprovesPurchaseOrder'], modules: [], ai: ['modelAssistEnabled'], advanced: [], documents: ['documentLanguage', 'letterhead', 'purchaseOrder', 'customerInvoice', 'layouts'] })

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
    'services/procurement-request-command-service.mjs',
  ])
  // The assistant reads only the AI switch (ai-workspace-access.mjs).
  const access = sources.find(file => file.path === 'domain/ai-workspace-access.mjs').source
  assert.deepEqual([...new Set([...access.matchAll(/\.ai\.([A-Za-z]+)/g)].map(match => match[1]))], ['modelAssistEnabled'])
  const finance = sources.find(file => file.path === 'domain/operational-finance-policy.mjs').source
  assert.deepEqual([...new Set([...finance.matchAll(/review\.([A-Za-z]+)/g)].map(match => match[1]))].sort(), [...REVIEW_TOLERANCE_FIELDS].sort())
  // Converting an approved purchase request reads only the PO approval switch (owner decision D3).
  const conversion = sources.find(file => file.path === 'services/procurement-request-command-service.mjs').source
  assert.deepEqual([...new Set([...conversion.matchAll(/review\.([A-Za-z]+)/g)].map(match => match[1]))], ['approvedRequestApprovesPurchaseOrder'])

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
    layouts: [],
    unreadableLayouts: [],
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

// A saved receive-sheet layout as the print-layout editor builds it.
const receiveLayout = (overrides = {}) => ({
  id: 'receive_sheet-custom',
  name: '  Dock receipt  ',
  documentType: 'receive_sheet',
  isDefault: false,
  version: 2,
  updatedAt: '2026-10-07T08:00:00.000Z',
  page: { paper: 'A4', orientation: 'portrait', width: 794, height: 1123, margin: 52, bleed: 3 },
  elements: [
    { id: 'company', type: 'field', title: 'Company', field: 'companyName', x: 52, y: 42, width: 690, height: 30, visible: true, draggable: true, resizable: true, required: true, style: { fontSize: 14, bold: true, align: 'center', color: 'red' }, onClick: 'dropped' },
    { id: 'lines', type: 'table', title: 'Lines', field: 'lines', x: 52, y: 320, width: 690, height: 330, visible: true, draggable: true, resizable: true, style: { fontSize: 11, bordered: true }, tableColumns: [{ key: 'sku', title: 'SKU', visible: true, width: 95, extra: 1 }, { key: 'quantity', title: 'Qty', visible: true, align: 'right' }] },
    { id: 'instance-receiving-note', type: 'comment', title: 'Receiving note', placeholder: 'Receiving note (this print)', contentMode: 'instance', x: 52, y: 858, width: 690, height: 46, visible: true, draggable: true, resizable: true },
  ],
  ...overrides,
})

test('print layouts are saved in the documents section with their shape checked and unknown keys dropped', () => {
  assert.deepEqual(mergeOperationalSettings({}).documents.layouts, [], 'no layout is stored until someone saves one')
  const saved = validateOperationalSection('documents', { layouts: [receiveLayout()] }).layouts
  assert.equal(saved.length, 1)
  const [layout] = saved
  assert.deepEqual(Object.keys(layout), ['id', 'name', 'documentType', 'version', 'page', 'elements', 'updatedAt'])
  assert.equal(layout.name, 'Dock receipt')
  assert.equal('isDefault' in layout, false, 'the built-in layouts live in code; whether one was built in is not stored')
  assert.deepEqual(layout.page, { paper: 'A4', orientation: 'portrait', width: 794, height: 1123, margin: 52 })
  assert.deepEqual(layout.elements[0], { id: 'company', type: 'field', title: 'Company', field: 'companyName', x: 52, y: 42, width: 690, height: 30, visible: true, draggable: true, resizable: true, required: true, style: { fontSize: 14, bold: true, align: 'center' } })
  assert.deepEqual(layout.elements[1].tableColumns, [{ key: 'sku', title: 'SKU', visible: true, width: 95 }, { key: 'quantity', title: 'Qty', visible: true, align: 'right' }])
  assert.equal(layout.elements[2].contentMode, 'instance')
  assert.equal('value' in layout.elements[2], false, 'what is typed for one print is not part of the layout')

  // Saving what was read stores the same thing, so the settings form sees no change.
  assert.deepEqual(validateOperationalSection('documents', { layouts: saved }).layouts, saved)
  assert.deepEqual(mergeOperationalSettings({ documents: { layouts: saved } }).documents.layouts, saved)
  // The letterhead form sends the layouts back as it read them.
  const documents = mergeOperationalSettings({ documents: { layouts: saved } }).documents
  assert.deepEqual(validateOperationalSection('documents', { ...documents, letterhead: { ...documents.letterhead, companyName: 'Harbor Goods LLC' } }).layouts, saved)
})

test('print layouts with a wrong shape are refused with the field named', () => {
  const element = receiveLayout().elements[0]
  const cases = [
    [{ layouts: 'all' }, 'DOCUMENT_LAYOUT_INVALID', 'layouts'],
    [{ layouts: [null] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0'],
    [{ layouts: [receiveLayout({ documentType: 'purchase_order' })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.documentType'],
    [{ layouts: [receiveLayout({ id: '' })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.id'],
    [{ layouts: [receiveLayout({ id: 'a b<script>' })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.id'],
    [{ layouts: [receiveLayout({ name: '   ' })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.name'],
    [{ layouts: [receiveLayout({ name: 'x'.repeat(121) })] }, 'DOCUMENT_SETTING_TOO_LONG', 'layouts.0.name'],
    [{ layouts: [receiveLayout({ page: { paper: 'Letter', orientation: 'portrait', width: 794, height: 1123, margin: 52 } })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.page.paper'],
    [{ layouts: [receiveLayout({ page: { paper: 'A4', orientation: 'sideways', width: 794, height: 1123, margin: 52 } })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.page.orientation'],
    [{ layouts: [receiveLayout({ elements: 'none' })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.elements'],
    [{ layouts: [receiveLayout({ elements: [{ ...element, type: 'script' }] })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.elements.0.type'],
    [{ layouts: [receiveLayout({ elements: [{ ...element, x: '52' }] })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.elements.0.x'],
    [{ layouts: [receiveLayout({ elements: [{ ...element, width: Number.NaN }] })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.elements.0.width'],
    [{ layouts: [receiveLayout({ elements: [{ ...element, visible: 'yes' }] })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.elements.0.visible'],
    [{ layouts: [receiveLayout({ elements: [{ ...element, value: 'x'.repeat(4001) }] })] }, 'DOCUMENT_SETTING_TOO_LONG', 'layouts.0.elements.0.value'],
    [{ layouts: [receiveLayout({ elements: [element, element] })] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.0.elements.1.id'],
    [{ layouts: [receiveLayout(), receiveLayout()] }, 'DOCUMENT_LAYOUT_INVALID', 'layouts.1.id'],
  ]
  for (const [value, code, field] of cases) {
    assert.throws(() => validateOperationalSection('documents', value), (error) => error.code === code && error.status === 400 && error.details.field === field, field)
  }
})

test('a workspace saves at most 20 print layouts and 160 KB of them', () => {
  const many = (count) => Array.from({ length: count }, (_, index) => receiveLayout({ id: `receive_sheet-${index}` }))
  assert.equal(validateOperationalSection('documents', { layouts: many(20) }).layouts.length, 20)
  assert.throws(() => validateOperationalSection('documents', { layouts: many(21) }), (error) => error.code === 'DOCUMENT_LAYOUTS_TOO_MANY' && error.status === 400 && error.details.field === 'layouts' && error.details.limit === 20)

  // Long fixed text in every layout: each passes on its own, all of them together are over 160 KB.
  const termsElement = (id) => ({ id, type: 'terms', title: 'Terms', value: 'x'.repeat(4000), x: 52, y: 700, width: 690, height: 110, visible: true, draggable: true, resizable: true })
  const terms = (index) => receiveLayout({ id: `receive_sheet-terms-${index}`, elements: [termsElement('terms-1'), termsElement('terms-2'), termsElement('terms-3')] })
  assert.doesNotThrow(() => validateOperationalSection('documents', { layouts: Array.from({ length: 12 }, (_, index) => terms(index)) }))
  assert.throws(() => validateOperationalSection('documents', { layouts: Array.from({ length: 14 }, (_, index) => terms(index)) }), (error) => error.code === 'DOCUMENT_LAYOUTS_TOO_LARGE' && error.details.field === 'layouts' && error.details.limit === 160 * 1024)
})

test('a stored layout that no longer passes the check is kept as stored, never dropped', () => {
  const broken = { ...receiveLayout({ id: 'receive_sheet-old' }), documentType: 'unknown' }
  const read = mergeOperationalSettings({ documents: { layouts: [broken, receiveLayout()] } }).documents
  assert.deepEqual(read.layouts.map((layout) => layout.id), ['receive_sheet-custom'])
  assert.deepEqual(read.unreadableLayouts, [broken], 'shown as unreadable, exactly as stored')

  // Saving the other layouts sends it back unchanged, and it is kept.
  const stored = { layouts: [broken, receiveLayout()] }
  const saved = validateOperationalSection('documents', { ...read, layouts: [] }, { stored })
  assert.deepEqual(saved.unreadableLayouts, [broken])
  assert.deepEqual(mergeOperationalSettings({ documents: saved }).documents.unreadableLayouts, [broken], 'read back the same way')
  // Key order does not matter (PostgreSQL reorders keys); any change does.
  const reordered = Object.fromEntries(Object.entries(broken).reverse())
  assert.deepEqual(validateOperationalSection('documents', { ...read, unreadableLayouts: [reordered] }, { stored }).unreadableLayouts, [reordered])
  assert.throws(() => validateOperationalSection('documents', { ...read, unreadableLayouts: [{ ...broken, name: 'Edited' }] }, { stored }), (error) => error.code === 'DOCUMENT_LAYOUT_INVALID' && error.details.field === 'unreadableLayouts.0')
  assert.throws(() => validateOperationalSection('documents', { ...read, unreadableLayouts: [{ anything: true }] }, { stored: null }), (error) => error.details.field === 'unreadableLayouts.0', 'nothing new can be stored as unreadable')
  // They count toward the 20.
  const nineteen = Array.from({ length: 19 }, (_, index) => receiveLayout({ id: `receive_sheet-${index}` }))
  assert.throws(() => validateOperationalSection('documents', { layouts: nineteen, unreadableLayouts: [broken, broken] }, { stored: { layouts: [broken] } }), (error) => error.code === 'DOCUMENT_LAYOUTS_TOO_MANY')
})

test('a stored layout changed by someone else is refused instead of overwritten', () => {
  const stored = { layouts: [receiveLayout({ version: 3 })] }
  const mine = receiveLayout({ version: 3, name: 'My change' })
  // Sent unchanged, or as the next version: saved.
  assert.doesNotThrow(() => validateOperationalSection('documents', { layouts: [receiveLayout({ version: 3 })] }, { stored }))
  assert.equal(validateOperationalSection('documents', { layouts: [{ ...mine, version: 4 }] }, { stored }).layouts[0].name, 'My change')
  // Changed from an older copy (someone saved version 3 after this editor loaded 2), or without a new version: refused.
  for (const version of [2, 3, 5]) {
    assert.throws(() => validateOperationalSection('documents', { layouts: [{ ...mine, version }] }, { stored }), (error) => error.code === 'DOCUMENT_LAYOUT_CHANGED' && error.status === 409 && error.details.id === 'receive_sheet-custom', `version ${version}`)
  }
  // A new id and a removed layout need no version.
  assert.deepEqual(validateOperationalSection('documents', { layouts: [receiveLayout({ id: 'receive_sheet-new', version: 1 })] }, { stored }).layouts.map((layout) => layout.id), ['receive_sheet-new'])
})

test('the audit log keeps the print layouts as a summary', () => {
  const documents = validateOperationalSection('documents', { layouts: [receiveLayout()] })
  const audit = auditSettingsValue('documents', documents)
  assert.deepEqual(audit.layouts, { count: 1, items: [{ id: 'receive_sheet-custom', name: 'Dock receipt', documentType: 'receive_sheet', version: 2 }] })
  assert.deepEqual(audit.unreadableLayouts, { count: 0 })
  assert.deepEqual(audit.letterhead, documents.letterhead, 'the rest of the section is kept as it is')
  const review = mergeOperationalSettings({}).review
  assert.deepEqual(auditSettingsValue('review', review), review, 'other sections are unchanged')

  const routes = readFileSync(new URL('../routes/settings-runtime.routes.mjs', import.meta.url), 'utf8')
  assert.match(routes, /validateOperationalSection\(section, next, \{ stored \}\)/)
  assert.match(routes, /before, after: auditAfter \}/)
})
