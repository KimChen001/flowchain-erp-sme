import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
  assert.match(storage, /saveDocumentSettings\(next\)/, 'templates are saved through PATCH /api/settings-runtime/documents')
  assert.match(storage, /fetchWorkspacePrintSettings\(\)/)

  // The old copies are read for the import offer and removed only on the person's Remove.
  const browserImport = read('src/modules/print-layout/printLayoutBrowserImport.ts')
  const browserWrites = [...browserImport.matchAll(/localStorage\.setItem\(([^,]*),/g)].map((match) => match[1].trim())
  assert.deepEqual(browserWrites, ['decisionKey(tenantId)'], 'only the import decision is written')
  assert.deepEqual([...browserImport.matchAll(/localStorage\.removeItem\(([^)]*)\)/g)].map((match) => match[1]), ['LEGACY_TEMPLATES_KEY'])
  assert.match(browserImport, /export function removeBrowserTemplates\(\) \{\n  try \{ localStorage\.removeItem\(LEGACY_TEMPLATES_KEY\)/)
  assert.match(browserImport, /const DECISION_KEY_PREFIX = "flowchain\.print-layout\.import-decision\.v1:"/)
  const banner = read('src/modules/print-layout/PrintLayoutImportBanner.tsx')
  assert.equal([...banner.matchAll(/removeBrowserTemplates\(\)/g)].length, 1)
  assert.match(banner, /data-testid="print-layout-import-remove-confirm" onClick=\{\(\) => \{ removeBrowserTemplates\(\)/)
  // Not now records nothing; Don't ask again and a finished import record the decision.
  assert.match(banner, /onClick=\{\(\) => setStage\("done"\)\}>\{t\("printLayout\.import\.notNow"\)\}/)
  assert.match(banner, /rememberImportDecision\(tenantId, "dont_ask"\)/)
  assert.match(banner, /rememberImportDecision\(tenantId, "imported"\)/)

  // Saving needs the workspace manage permission; without it the editor prints read-only.
  const editor = read('src/modules/print-layout/PrintLayoutEditor.tsx')
  assert.match(editor, /effectivePermissions\?\.includes\("settings\.workspace\.manage"\)/)
  assert.match(editor, /\{canSave && <button type="button" data-testid="print-layout-save-template"/)
  assert.match(editor, /data-testid="print-layout-read-only">\{t\("printLayout\.readOnly"\)\}/)
})

test('the receive sheet prints recorded values only', () => {
  const adapters = read('src/modules/print-layout/printDataAdapters.ts')
  for (const invented of ['新辰智能制造', '李婷']) assert.ok(!adapters.includes(invented), invented)
  const start = adapters.indexOf('export function adaptReceiveSheet')
  const receiveSheet = adapters.slice(start, adapters.indexOf('\nexport function', start + 1))
  for (const placeholder of ['"件"', '件', '待审核', '按采购订单收货', '收货汇总', 'SUMMARY', '"—"']) {
    assert.ok(!receiveSheet.includes(placeholder), `adaptReceiveSheet still has ${placeholder}`)
  }
  assert.match(receiveSheet, /unit: line\.unit \|\| ""/)
  assert.match(receiveSheet, /receiver: grn\.receiver \|\| ""/)
  assert.match(receiveSheet, /reviewedBy: ""/)

  // The company printed is the letterhead's, else the workspace's name.
  const storage = read('src/modules/print-layout/printLayoutStorage.ts')
  assert.match(storage, /settings\.documents\?\.letterhead\?\.companyName \|\| settings\.company\?\.companyName \|\| ""/)
  const editor = read('src/modules/print-layout/PrintLayoutEditor.tsx')
  assert.match(editor, /companyName: data\.companyName \|\| companyName/)
})

test('the print-layout editor copy is in English and Chinese', () => {
  const i18n = read('src/i18n/I18n.tsx')
  const used = new Set()
  for (const file of ['src/modules/print-layout/PrintLayoutEditor.tsx', 'src/modules/print-layout/PrintLayoutImportBanner.tsx', 'src/modules/receiving/Page.tsx']) {
    for (const match of read(file).matchAll(/t\("(printLayout\.[A-Za-z_.]+)"/g)) used.add(match[1])
  }
  for (const type of ['receive_sheet', 'delivery_note', 'sign_receipt']) used.add(`printLayout.documentType.${type}`)
  assert.ok(used.size > 40)
  for (const key of used) {
    const occurrences = i18n.split(`"${key}":`).length - 1
    assert.equal(occurrences, 2, `${key} needs a Chinese and an English entry`)
  }
})
