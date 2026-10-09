import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { PRINT_LAYOUT_LIMITS, validatePrintLayout, validatePrintLayouts } from '../../shared/business-documents.mjs'
import { mergeOperationalSettings, validateOperationalSection } from './workspace-settings-contract.mjs'

// The print-layout client modules, bundled as the browser runs them, against
// an in-memory workspace that answers GET /api/settings-runtime and
// PATCH /api/settings-runtime/documents with the server's own checks.

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

// The editor copy as the interface has it, both languages (src/i18n/I18n.tsx).
function printLayoutCopy() {
  const source = readFileSync(path.join(repoRoot, 'src/i18n/I18n.tsx'), 'utf8')
  const zh = {}
  const en = {}
  for (const match of source.matchAll(/^ {2}"(printLayout\.[^"]+)": ("(?:[^"\\]|\\.)*"),$/gm)) {
    const target = match[1] in zh ? en : zh
    target[match[1]] = JSON.parse(match[2])
  }
  const translator = (dictionary) => (key, variables = {}) => {
    assert.ok(key in dictionary, `missing copy ${key}`)
    return Object.entries(variables).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
  }
  return { zh: translator(zh), en: translator(en) }
}
const copy = printLayoutCopy()

let loaded
async function modules() {
  loaded ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'print-layout-'))
    const outfile = path.join(dir, 'print-layout.mjs')
    await build({
      stdin: {
        contents: [
          'export * from "./src/modules/print-layout/printLayoutStorage.ts";',
          'export * from "./src/modules/print-layout/printLayoutBrowserImport.ts";',
          'export * from "./src/modules/print-layout/printLayoutElements.ts";',
          'export * from "./src/modules/print-layout/printLayoutPresets.ts";',
          'export * from "./src/modules/print-layout/printDataAdapters.ts";',
          'export { ApiError } from "./src/lib/api-client.ts";',
        ].join('\n'),
        resolveDir: repoRoot,
        loader: 'ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    })
    return { mod: await import(pathToFileURL(outfile).href), dir }
  })()
  return (await loaded).mod
}

test.after(async () => {
  if (loaded) await rm((await loaded).dir, { recursive: true, force: true })
})

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)) }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

// The workspace's stored documents section, served the way the settings route serves it.
function workspace(storedDocuments = null, { beforePatch } = {}) {
  const state = { stored: storedDocuments, patches: 0 }
  globalThis.localStorage = new MemoryStorage()
  globalThis.fetch = async (url, options = {}) => {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if ((options.method || 'GET') === 'GET' && url === '/api/settings-runtime') {
      return json(200, { company: { companyName: 'Harbor Goods LLC' }, documents: mergeOperationalSettings({ documents: state.stored }).documents })
    }
    if (options.method === 'PATCH' && url === '/api/settings-runtime/documents') {
      beforePatch?.(state)
      try {
        const saved = validateOperationalSection('documents', JSON.parse(options.body).settings, { stored: state.stored })
        state.stored = saved
        state.patches += 1
        return json(200, { settings: saved })
      } catch (error) {
        return json(error.status || 400, { code: error.code, message: error.message, ...(error.status === 400 && error.details ? { details: error.details } : {}) })
      }
    }
    return json(404, { code: 'NOT_FOUND' })
  }
  return state
}

const storedSection = (overrides = {}) => ({
  ...mergeOperationalSettings({}).documents,
  letterhead: { companyName: 'Harbor Goods LLC', addressLines: ['12 Pier Road'], phone: null, email: null, taxId: null },
  purchaseOrder: { title: null, columns: { supplierSku: true, requestedDate: true, promisedDate: false }, termsText: 'Net 30 from invoice.', footerText: '', signatureBlock: true },
  customerInvoice: { title: 'Tax Invoice', columns: { tax: true }, showPaymentSummary: false, paymentInstructions: 'Wire to account on file.', termsText: '', footerText: '' },
  ...overrides,
})

// A saved receive-sheet layout as the editor saves it: the built-in one with the per-print fields.
async function savedLayout(id, version = 1, language = 'en') {
  const mod = await modules()
  return validatePrintLayout({ ...mod.withInstanceFields(mod.defaultPrintTemplate('receive_sheet', copy[language]), 'receive_sheet', copy[language]), id, name: `Layout ${id}`, version })
}

test('saving a template sends the rest of the documents section back unchanged', async () => {
  const mod = await modules()
  const state = workspace(storedSection())
  const { saved } = await mod.saveNewPrintTemplate(mod.withInstanceFields(mod.defaultPrintTemplate('receive_sheet', copy.en), 'receive_sheet', copy.en))
  assert.equal(state.patches, 1)
  assert.deepEqual(state.stored.letterhead, storedSection().letterhead)
  assert.deepEqual(state.stored.purchaseOrder, storedSection().purchaseOrder)
  assert.deepEqual(state.stored.customerInvoice, storedSection().customerInvoice)
  assert.deepEqual(state.stored.layouts.map((layout) => layout.id), [saved.id])
  assert.equal(globalThis.localStorage.getItem('flowchain.print-layout.templates.v1'), null, 'nothing is written to the old browser key')
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('flowchain.print-layout.last.v1')), { receive_sheet: saved.id })
})

test('saving from a built-in template always adds a new template and never replaces one', async () => {
  const mod = await modules()
  const existing = await savedLayout('receive_sheet-custom', 4)
  const state = workspace(storedSection({ layouts: [existing] }))
  const builtIn = mod.defaultPrintTemplate('receive_sheet', copy.en)
  const first = await mod.saveNewPrintTemplate(builtIn)
  const second = await mod.saveNewPrintTemplate(builtIn)
  assert.equal(state.stored.layouts.length, 3)
  assert.deepEqual(state.stored.layouts[0], existing, 'the stored template is untouched')
  const ids = state.stored.layouts.map((layout) => layout.id)
  assert.equal(new Set(ids).size, 3)
  for (const id of [first.saved.id, second.saved.id]) {
    assert.ok(ids.includes(id))
    assert.notEqual(id, 'receive_sheet-custom')
    assert.notEqual(id, builtIn.id)
  }
  assert.equal(first.saved.version, 1)
})

test('a template changed by someone else since it was loaded is refused, not overwritten', async () => {
  const mod = await modules()
  const state = workspace(storedSection({ layouts: [await savedLayout('receive_sheet-shared', 2)] }))
  const loadedByMe = structuredClone(state.stored.layouts[0])
  const loadedByThem = structuredClone(state.stored.layouts[0])

  const theirs = await mod.saveExistingPrintTemplate({ ...loadedByThem, name: 'Their change' })
  assert.equal(theirs.saved.version, 3)
  await assert.rejects(mod.saveExistingPrintTemplate({ ...loadedByMe, name: 'My change' }), (error) => error instanceof mod.PrintLayoutChangedError && error.code === 'DOCUMENT_LAYOUT_CHANGED')
  assert.equal(state.stored.layouts[0].name, 'Their change', 'their save is kept')
  await assert.rejects(mod.deletePrintTemplate(loadedByMe), (error) => error instanceof mod.PrintLayoutChangedError)
  assert.equal(state.stored.layouts.length, 1, 'a stale delete removes nothing')

  // Someone saves between this editor's read and its PATCH: the server refuses it.
  const current = structuredClone(state.stored.layouts[0])
  workspace(state.stored, { beforePatch: (racing) => { racing.stored = { ...racing.stored, layouts: [{ ...racing.stored.layouts[0], name: 'Racing change', version: racing.stored.layouts[0].version + 1 }] } } })
  await assert.rejects(mod.saveExistingPrintTemplate({ ...current, name: 'Mine' }), (error) => error instanceof mod.ApiError && error.status === 409 && error.code === 'DOCUMENT_LAYOUT_CHANGED')

  // Loaded and saved in turn: each save is the next version, and delete removes it.
  const fresh = workspace(storedSection({ layouts: [await savedLayout('receive_sheet-shared', 2)] }))
  const once = await mod.saveExistingPrintTemplate({ ...structuredClone(fresh.stored.layouts[0]), name: 'First' })
  const twice = await mod.saveExistingPrintTemplate({ ...once.saved, name: 'Second' })
  assert.deepEqual([once.saved.version, twice.saved.version, fresh.stored.layouts[0].name], [3, 4, 'Second'])
  await mod.deletePrintTemplate(twice.saved)
  assert.deepEqual(fresh.stored.layouts, [])
})

test('a stored template that cannot be read is kept when other templates are saved', async () => {
  const mod = await modules()
  const broken = { ...(await savedLayout('receive_sheet-old')), documentType: 'retired_type' }
  const state = workspace(storedSection({ layouts: [broken] }))
  await mod.saveNewPrintTemplate(mod.defaultPrintTemplate('delivery_note', copy.en))
  assert.equal(state.stored.layouts.length, 1)
  assert.deepEqual(state.stored.unreadableLayouts, [broken])
})

test('importing templates from the browser adds copies for ids already in the workspace', async () => {
  const mod = await modules()
  const state = workspace(storedSection({ layouts: [await savedLayout('receive_sheet-custom', 3)] }))
  const browserCopy = { ...(await savedLayout('receive_sheet-custom', 7)), name: 'Browser layout' }
  const other = await savedLayout('delivery_note-1696000000000')
  const copies = mod.importCopies([browserCopy, other], state.stored.layouts, copy.en('printLayout.import.suffix'), 1)
  await mod.saveWorkspaceLayouts((current) => [...current, ...mod.importCopies([browserCopy, other], current, copy.en('printLayout.import.suffix'), 1)])
  assert.deepEqual(copies.map((layout) => [layout.id, layout.name]), [['receive_sheet-imported-1-0', 'Browser layout (imported)'], ['delivery_note-1696000000000', other.name]])
  assert.deepEqual(state.stored.layouts.map((layout) => layout.id), ['receive_sheet-custom', 'receive_sheet-imported-1-0', 'delivery_note-1696000000000'])
  assert.equal(state.stored.layouts[0].version, 3, 'the workspace template is not replaced')
})

test('Remove after an import takes only the imported templates out of the browser', async () => {
  const mod = await modules()
  const kept = await savedLayout('receive_sheet-b')
  const broken = { id: 'receive_sheet-c', name: '', elements: 'none' }
  const storage = new MemoryStorage({ 'flowchain.print-layout.templates.v1': JSON.stringify([await savedLayout('receive_sheet-a'), kept, broken]) })
  const entries = mod.readBrowserTemplates(storage)
  assert.deepEqual(entries.map((entry) => Boolean(entry.template)), [true, true, false])
  assert.equal(mod.removeImportedBrowserTemplates(entries, new Set([0]), storage), 2)
  assert.deepEqual(JSON.parse(storage.getItem('flowchain.print-layout.templates.v1')), [kept, broken], 'the unticked and the unreadable stay, as they were')
  assert.equal(mod.removeImportedBrowserTemplates(mod.readBrowserTemplates(storage), new Set([0, 1]), storage), 0)
  assert.equal(storage.getItem('flowchain.print-layout.templates.v1'), null)

  assert.equal(mod.importDecided('tenant-1', storage), false)
  mod.rememberImportDecision('tenant-1', 'dont_ask', storage)
  assert.equal(mod.importDecided('tenant-1', storage), true)
  assert.equal(mod.importDecided('tenant-2', storage), false, 'the decision is per workspace')
})

test('the built-in templates and every element the toolbar adds pass the shared check, in both languages', async () => {
  const mod = await modules()
  for (const language of ['en', 'zh']) {
    for (const type of ['receive_sheet', 'delivery_note', 'sign_receipt']) {
      const template = mod.withInstanceFields(mod.defaultPrintTemplate(type, copy[language]), type, copy[language])
      const elements = mod.NEW_PRINT_ELEMENT_TYPES.map((kind, index) => mod.createPrintElement(kind, template.elements.length + index, copy[language], 1700000000000))
      const layout = validatePrintLayout({ ...template, id: `${type}-x`, elements: [...template.elements, ...elements] })
      assert.equal(layout.elements.length, template.elements.length + mod.NEW_PRINT_ELEMENT_TYPES.length)
    }
  }
  // A built-in template is in the interface language: no Chinese in the English
  // one, its text from the copy in the Chinese one; ids and bindings are the same.
  const CJK = /[㐀-鿿]/
  for (const type of ['receive_sheet', 'delivery_note', 'sign_receipt']) {
    const en = mod.defaultPrintTemplate(type, copy.en)
    const zh = mod.defaultPrintTemplate(type, copy.zh)
    const texts = (template) => [template.name, ...template.elements.flatMap((element) => [element.title, element.value, ...(element.tableColumns || []).map((column) => column.title)])].filter(Boolean)
    assert.deepEqual(texts(en).filter((text) => CJK.test(text)), [], type)
    assert.ok(texts(zh).some((text) => CJK.test(text)), type)
    const shape = (template) => template.elements.map((element) => [element.id, element.type, element.field, (element.tableColumns || []).map((column) => column.key)])
    assert.deepEqual(shape(en), shape(zh), type)
    assert.equal(en.id, zh.id)
  }
  const receiveSheet = mod.defaultPrintTemplate('receive_sheet', copy.en)
  assert.deepEqual([receiveSheet.name, receiveSheet.elements.find((element) => element.id === 'title').value], ['Standard goods receipt', 'Goods Receipt'])
  assert.equal(mod.defaultPrintTemplate('receive_sheet', copy.zh).name, '标准入库单')

  const [text] = [mod.createPrintElement('text', 0, copy.en, 1)]
  assert.deepEqual([text.title, text.value], ['Text', 'Enter fixed text'])
  assert.deepEqual([mod.createPrintElement('text', 0, copy.zh, 1).value, mod.createPrintElement('remark', 0, copy.zh, 1).title], ['请输入固定文字', '备注'])
  assert.equal(mod.withInstanceFields(mod.defaultPrintTemplate('receive_sheet', copy.en), 'receive_sheet', copy.en).elements.find((element) => element.id === 'instance-receiving-note').placeholder, 'Receiving note (this print)')

  // A cleared font size or line height becomes the smallest allowed, which passes.
  assert.deepEqual([mod.clampLayoutNumber('', 1, 200), mod.clampLayoutNumber('0', 0.5, 5), mod.clampLayoutNumber('900', 1, 200), mod.clampLayoutNumber('14', 1, 200)], [1, 0.5, 200, 14])
})

test('20 realistic templates fit in 160 KB', async () => {
  const mod = await modules()
  const layouts = []
  for (let index = 0; index < PRINT_LAYOUT_LIMITS.templates; index += 1) {
    const type = ['receive_sheet', 'delivery_note', 'sign_receipt'][index % 3]
    const language = index % 2 ? 'zh' : 'en'
    const template = mod.withInstanceFields(mod.defaultPrintTemplate(type, copy[language]), type, copy[language])
    const added = mod.NEW_PRINT_ELEMENT_TYPES.map((kind, offset) => mod.createPrintElement(kind, template.elements.length + offset, copy[language], 1700000000000 + index))
    added[3].value = 'Goods remain the property of the seller until paid in full. '.repeat(8)
    layouts.push({ ...template, id: `${type}-${index}`, name: `Layout ${index}`, isDefault: false, version: 3, updatedAt: new Date(0).toISOString(), elements: [...template.elements, ...added] })
  }
  const saved = validatePrintLayouts(layouts)
  const bytes = new TextEncoder().encode(JSON.stringify(saved)).length
  assert.ok(bytes < PRINT_LAYOUT_LIMITS.bytes, `${bytes} bytes`)
  assert.ok(bytes > 64 * 1024, 'the old 64 KB cap would not have held them')
})

test('the receive sheet, delivery note and sign receipt print recorded values and nothing invented', async () => {
  const mod = await modules()
  const sheet = mod.adaptReceiveSheet({
    grn: 'grn-uuid-1', documentNumber: 'GRN-202610-0007', po: 'PO-202610-0003', supplier: 'Harbor Supply', arrived: '2026-10-07', dock: '', receiver: 'Dana Ruiz',
    items: 12, passed: 10, failed: 2, status: 'receiving', warehouse: 'wh-uuid-1',
    lines: [{ sku: 'SKU-1', itemName: 'Pallet wrap', receivedQty: 12, acceptedQty: 10, rejectedQty: 2, unit: 'roll', lotNumber: 'LOT-88' }, { sku: 'SKU-2', receivedQty: 4, acceptedQty: 4, rejectedQty: 0 }],
  }, { rejectedLabel: (qty) => `Rejected ${qty}`, warehouseName: (id) => (id === 'wh-uuid-1' ? 'Oakland DC' : id) })
  assert.equal(sheet.documentNo, 'GRN-202610-0007')
  assert.equal(sheet.warehouse, 'Oakland DC')
  assert.deepEqual([sheet.companyName, sheet.handler, sheet.createdBy, sheet.reviewedBy, sheet.remarks], ['', '', '', '', ''])
  assert.equal(sheet.receiver, 'Dana Ruiz')
  assert.deepEqual(sheet.lines, [
    { sku: 'SKU-1', itemName: 'Pallet wrap', quantity: 12, unit: 'roll', batchNo: 'LOT-88', remarks: 'Rejected 2' },
    { sku: 'SKU-2', itemName: '', quantity: 4, unit: '', batchNo: '', remarks: '' },
  ])
  assert.deepEqual(mod.adaptReceiveSheet({ grn: 'grn-2', po: '', supplier: '', arrived: '', dock: '', receiver: '', items: 3, passed: 3, failed: 0, status: 'receiving', warehouse: '' }, { rejectedLabel: String }).lines, [], 'no summary line is made up')

  const note = mod.adaptDeliveryNote({ deliveryNo: 'DN-1', deliveryDate: '2026-10-07', customerName: 'Acme', warehouse: 'Main', salesOrderNo: 'SO-1', createdBy: 'Lee', lines: [] })
  assert.deepEqual([note.reviewedBy, note.logisticsCompany, note.driver, note.vehicleNo, note.cartonCount], ['', '', '', '', ''])
  const receipt = mod.adaptSignReceipt({ receiptNo: 'SR-1', signDate: '2026-10-07', deliveryNo: 'DN-1', salesOrderNo: 'SO-1', customerName: 'Acme', receiverName: 'Kim', lines: [] })
  assert.deepEqual([receipt.warehouse, receipt.exceptionNote, receipt.reviewedBy, receipt.signature, receipt.handler, receipt.receiverPhone], ['', '', '', '', '', ''])
})
