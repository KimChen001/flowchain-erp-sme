import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const printBlock = (css) => {
  const start = css.indexOf('@media print {')
  assert.ok(start >= 0, 'print-layout.css has its print rules')
  let depth = 0
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(css.indexOf('{', start) + 1, index)
  }
  throw new Error('unclosed @media print block')
}

test('the print-layout print rules apply only while the editor is open', () => {
  const css = read('src/modules/print-layout/print-layout.css')
  const rules = printBlock(css).split('}').map((rule) => rule.trim()).filter(Boolean)
  assert.ok(rules.length > 0)
  for (const rule of rules) {
    const selectors = rule.slice(0, rule.indexOf('{')).split(',').map((selector) => selector.trim())
    for (const selector of selectors) assert.match(selector, /^body\.fc-print-layout-open /, `unscoped print rule: ${selector}`)
  }
  assert.match(printBlock(css), /body\.fc-print-layout-open \* \{ visibility: hidden !important; \}/)
  assert.doesNotMatch(css, /(^|[\s,}])body \* \{/, 'no hide-everything rule outside the editor scope')

  const editor = read('src/modules/print-layout/PrintLayoutEditor.tsx')
  assert.match(editor, /PRINT_LAYOUT_BODY_CLASS = "fc-print-layout-open"/)
  assert.match(editor, /document\.body\.classList\.add\(PRINT_LAYOUT_BODY_CLASS\)/)
  assert.match(editor, /return \(\) => document\.body\.classList\.remove\(PRINT_LAYOUT_BODY_CLASS\)/)
})

test('saved print templates are the workspace\'s; the browser keeps only the last-used choice', () => {
  const storage = read('src/modules/print-layout/printLayoutStorage.ts')
  assert.doesNotMatch(storage, /print-layout\.templates\.v1/, 'the old browser key is not read or written by the storage')
  assert.match(storage, /const LAST_KEY = "flowchain\.print-layout\.last\.v1"/)
  const writes = [...storage.matchAll(/localStorage\.(setItem|removeItem|clear)\(([^,)]*)/g)].map((match) => `${match[1]}(${match[2].trim()})`)
  assert.deepEqual(writes, ['setItem(LAST_KEY)'])
  assert.match(storage, /saveDocumentSettings\(validateDocumentSettings\(\{ \.\.\.documents, layouts \}\)\)/, 'templates are saved through PATCH /api/settings-runtime/documents')

  // The old copies are read for the import offer; only the decision is written,
  // and the old key is changed only by Remove after an import.
  const browserImport = read('src/modules/print-layout/printLayoutBrowserImport.ts')
  assert.doesNotMatch(browserImport, /localStorage\.(setItem|removeItem)/)
  assert.deepEqual([...browserImport.matchAll(/storage\.(setItem|removeItem)\(([^,)]*)/g)].map((match) => `${match[1]}(${match[2].trim()})`), ['setItem(decisionKey(tenantId)', 'setItem(LEGACY_TEMPLATES_KEY)', 'removeItem(LEGACY_TEMPLATES_KEY)'])
  assert.match(browserImport, /const DECISION_KEY_PREFIX = "flowchain\.print-layout\.import-decision\.v1:"/)
  const banner = read('src/modules/print-layout/PrintLayoutImportBanner.tsx')
  assert.equal([...banner.matchAll(/removeImportedBrowserTemplates\(/g)].length, 1, 'called only from Remove')
  assert.match(banner, /data-testid="print-layout-import-remove-confirm" onClick=\{\(\) => \{ removeImportedBrowserTemplates\(entries, imported\)/)
  // Not now records nothing; Don't ask again, and an import of everything, record the decision.
  assert.match(banner, /onClick=\{\(\) => setStage\("done"\)\}>\{t\("printLayout\.import\.notNow"\)\}/)
  assert.match(banner, /rememberImportDecision\(tenantId, "dont_ask"\)/)
  assert.match(banner, /if \(done\.size === entries\.length\) rememberImportDecision\(tenantId, "imported"\)/)

  // Saving and deleting need the workspace manage permission; without it the editor prints read-only.
  const editor = read('src/modules/print-layout/PrintLayoutEditor.tsx')
  assert.match(editor, /effectivePermissions\?\.includes\("settings\.workspace\.manage"\)/)
  assert.match(editor, /\{canSave && <button type="button" data-testid="print-layout-save-template"/)
  assert.match(editor, /\{canSave && isSavedTemplate && <button type="button" data-testid="print-layout-delete-template"/)
  assert.match(editor, /data-testid="print-layout-read-only">\{t\("printLayout\.readOnly"\)\}/)
  // A built-in template is saved as a new one; a saved one over itself, by version.
  assert.match(editor, /isSavedTemplate \? await saveExistingPrintTemplate\(named\) : await saveNewPrintTemplate\(named\)/)
  assert.doesNotMatch(editor, /-custom`/)
})

test('the receive sheet prints recorded values only', () => {
  const adapters = read('src/modules/print-layout/printDataAdapters.ts')
  for (const invented of ['新辰智能制造', '李婷']) assert.ok(!adapters.includes(invented), invented)
  for (const placeholder of ['"件"', '件', '待审核', '按采购订单收货', '收货汇总', 'SUMMARY', '客户收货点', '"无"', '待签名', '"—"']) {
    assert.ok(!adapters.includes(placeholder), `printDataAdapters still has ${placeholder}`)
  }
  // The receipt detail page prints the sheet from the receipt it shows.
  assert.match(read('src/modules/receiving/ReceivingPostingWorkbench.tsx'), /adaptReceivingDetailSheet\(detail, \{/)

  // The company printed is the letterhead's, else the workspace's name.
  const storage = read('src/modules/print-layout/printLayoutStorage.ts')
  assert.match(storage, /settings\.documents\?\.letterhead\?\.companyName \|\| settings\.company\?\.companyName \|\| ""/)
  const editor = read('src/modules/print-layout/PrintLayoutEditor.tsx')
  assert.match(editor, /companyName: data\.companyName \|\| companyName/)
})

test('the print-layout editor copy is in English and Chinese', () => {
  const i18n = read('src/i18n/I18n.tsx')
  const used = new Set()
  for (const file of ['src/modules/print-layout/PrintLayoutEditor.tsx', 'src/modules/print-layout/PrintLayoutImportBanner.tsx', 'src/modules/print-layout/PrintInstancePanel.tsx', 'src/modules/print-layout/printLayoutElements.ts', 'src/modules/receiving/ReceivingPostingWorkbench.tsx', 'src/modules/print-layout/printLayoutPresets.ts']) {
    for (const match of read(file).matchAll(/(?:\bt|copy)\("(printLayout\.[A-Za-z_.-]+)"/g)) used.add(match[1])
  }
  for (const type of ['receive_sheet', 'delivery_note', 'sign_receipt']) used.add(`printLayout.documentType.${type}`)
  const elements = read('src/modules/print-layout/printLayoutElements.ts')
  const instanceKeys = elements.slice(elements.indexOf('export const PRINT_INSTANCE_FIELD_KEYS'), elements.indexOf('export type PrintInstanceFieldKey'))
  for (const match of instanceKeys.matchAll(/"([a-z-]+)"/g)) used.add(`printLayout.instance.${match[1]}`)
  assert.ok(used.size > 80)
  for (const key of used) {
    const occurrences = i18n.split(`"${key}":`).length - 1
    assert.equal(occurrences, 2, `${key} needs a Chinese and an English entry`)
  }
})

// The adapters, compiled as the browser runs them (they import only types).
async function printAdapters() {
  const { code } = await transform(read('src/modules/print-layout/printDataAdapters.ts'), { loader: 'ts', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

test('the receipt detail page prints its receive sheet from the recorded receipt', async () => {
  const { adaptReceivingDetailSheet } = await printAdapters()
  const detail = {
    receivingDocument: { id: 'grn-1', documentNumber: 'GRN-0042', arrivedAt: '2026-10-08T03:30:00.000Z', receiver: 'Dock Lead', supplier: { name: 'Harbor Supply' }, warehouse: { name: 'Main Warehouse', code: 'MAIN' } },
    purchaseOrder: { id: 'PO-7' },
    lines: [
      { sku: 'VAL-1', itemName: 'Valve', documentAcceptedQuantity: '12.5000', rejectedQuantity: '0.0000', unit: 'EA' },
      { sku: 'PIPE-2', itemName: 'Pipe', documentAcceptedQuantity: '3.0000', rejectedQuantity: '1.2500', unit: 'M' },
    ],
  }
  const sheet = adaptReceivingDetailSheet(detail, {
    quantity: (value) => `q(${value})`,
    rejectedLabel: (qty) => `Rejected ${qty}`,
    day: (instant) => `day(${instant})`,
  })
  assert.deepEqual(
    [sheet.documentNo, sheet.supplier, sheet.warehouse, sheet.sourceOrderNo, sheet.receiver, sheet.receiveDate, sheet.documentDate],
    ['GRN-0042', 'Harbor Supply', 'Main Warehouse', 'PO-7', 'Dock Lead', 'day(2026-10-08T03:30:00.000Z)', 'day(2026-10-08T03:30:00.000Z)'],
  )
  // Each line in its own unit, never added up; a rejected quantity only where one was recorded.
  assert.deepEqual(sheet.lines, [
    { sku: 'VAL-1', itemName: 'Valve', quantity: 'q(12.5000)', unit: 'EA', batchNo: '', remarks: '' },
    { sku: 'PIPE-2', itemName: 'Pipe', quantity: 'q(3.0000)', unit: 'M', batchNo: '', remarks: 'Rejected q(1.2500)' },
  ])
  // Nothing the receipt does not record is filled in.
  for (const key of ['companyName', 'handler', 'createdBy', 'reviewedBy', 'remarks']) assert.equal(sheet[key], '', key)
  const bare = adaptReceivingDetailSheet({ receivingDocument: { id: 'grn-2' }, purchaseOrder: { id: 'PO-8' }, lines: [] }, { quantity: String, rejectedLabel: String, day: () => 'never' })
  assert.deepEqual([bare.documentNo, bare.supplier, bare.warehouse, bare.receiver, bare.receiveDate], ['grn-2', '', '', '', ''])
})
