import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

test('every Chinese route and primary-navigation label has an English display mapping', () => {
  const registry = readFileSync(new URL('../../src/app/routeRegistry.tsx', import.meta.url), 'utf8')
  const manifest = readFileSync(new URL('../../src/app/routes/route-manifest.ts', import.meta.url), 'utf8')
  const dictionary = readFileSync(new URL('../../src/i18n/workspaceCopy.ts', import.meta.url), 'utf8')
  const labels = [...`${registry}\n${manifest}`.matchAll(/(?:label|moduleLabel|navigationLabel):\s*"([^"]*[㐀-鿿][^"]*)"/g)].map(match => match[1])
  const missing = [...new Set(labels)].filter(label => !dictionary.includes(`'${label}':`)).sort()
  assert.deepEqual(missing, [], `Missing English route labels: ${missing.join(', ')}`)
})

// Screens on the English trial path whose copy is English first. Every Chinese
// literal left in them (comments are not literals) must be translated: a key of
// a display dictionary, or the Chinese half of an English/Chinese pair.
const ENGLISH_COVERED = [
  'src/modules/finance/OperationalFinanceO2cWorkbench.tsx',
  'src/modules/finance/OperationalFinanceP2pWorkbench.tsx',
  'src/modules/finance/SupplierInvoiceScreens.tsx',
  'src/modules/finance/PaymentRecords.tsx',
  'src/modules/finance/FinanceControls.tsx',
  'src/modules/inventory/InventoryOperationsWorkbench.tsx',
  'src/modules/inventory/ReorderListPage.tsx',
  'src/modules/procurement/ProcurementDocumentDetailPage.tsx',
  'src/modules/procurement/ThreeWayMatchListPage.tsx',
  'src/modules/procurement/ReceivingListPage.tsx',
  'src/modules/overview/AiSuggestionsPage.tsx',
  'src/modules/sales/Page.tsx',
  'src/components/business/BusinessObjectDetail.tsx',
]

// Display dictionaries, read as text: their Chinese property names are the
// Chinese labels they translate.
const DICTIONARIES = [
  'src/i18n/workspaceCopy.ts',
  'src/i18n/operationsCopy.ts',
  'src/i18n/statusLabels.ts',
  'src/components/business/businessEntityCopy.ts',
  'src/modules/inventory/inventoryOperationsCopyMaps.ts',
  'src/modules/inventory/reorderListCopy.ts',
  'src/modules/inventory/returnsCopyData.ts',
  'src/modules/sales/outboundCopy.ts',
  'src/modules/sales/salesDemandCopy.ts',
]

// Chinese literals that are not display copy: comparisons with values the
// server stores or sends, which stay as stored.
const ALLOWED = [
  // The server's Chinese status labels, matched to filter unshipped orders.
  { file: 'src/modules/sales/Page.tsx', text: '/已完成|已交付/' },
]

const CJK = /[㐀-鿿]/
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const parse = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function dictionaryKeys() {
  const keys = new Set()
  for (const file of DICTIONARIES) {
    walk(parse(file), (node) => {
      if (ts.isPropertyAssignment(node) && (ts.isStringLiteral(node.name) || ts.isNoSubstitutionTemplateLiteral(node.name)) && CJK.test(node.name.text)) keys.add(node.name.text)
    })
  }
  return keys
}

// A template's own text, without the expressions it embeds (a copy("…") call
// inside a template is checked as its own literal).
const templateText = (node) => [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('${…}')
const isLiteral = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
const englishLiteral = (node) => isLiteral(node) && !CJK.test(ts.isTemplateExpression(node) ? templateText(node) : node.text)
const propertyName = (node) => ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : ''
const ENGLISH_CONDITION = /["']en-US["']|\b(?:en|english|isEnglish|englishUi|isEn)\b/
const CHINESE_CONDITION = /["']zh-CN["']/

// True when the literal is the Chinese half of an English/Chinese pair: under a
// zh key, the value of an English key (or the key of an English value), one of
// two arguments or array elements next to English text, or the branch an
// "en-US" ternary takes for Chinese.
function isChineseHalf(literal) {
  for (let child = literal, parent = literal.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isPropertyAssignment(parent)) {
      if (/^(?:zh|zh-CN|zhCN|chinese)$/.test(propertyName(parent))) return true
      if (child === literal && parent.initializer === literal && (ts.isStringLiteral(parent.name) || ts.isNoSubstitutionTemplateLiteral(parent.name)) && !CJK.test(parent.name.text)) return true
      if (child === literal && parent.name === literal && englishLiteral(parent.initializer)) return true
    }
    if (child === literal && ts.isCallExpression(parent) && parent.arguments.length === 2 && parent.arguments.includes(literal)
      && englishLiteral(parent.arguments.find((argument) => argument !== literal))) return true
    if (child === literal && ts.isArrayLiteralExpression(parent) && parent.elements.length === 2 && parent.elements.includes(literal)
      && englishLiteral(parent.elements.find((element) => element !== literal))) return true
    if (ts.isConditionalExpression(parent)) {
      const condition = parent.condition.getText()
      if (child === parent.whenFalse && ENGLISH_CONDITION.test(condition)) return true
      if (child === parent.whenTrue && CHINESE_CONDITION.test(condition)) return true
    }
  }
  return false
}

test('English-covered screens translate every Chinese literal they show', () => {
  const keys = dictionaryKeys()
  const failures = []
  for (const file of ENGLISH_COVERED) {
    const source = parse(file)
    const allowed = new Set(ALLOWED.filter((entry) => entry.file === file).map((entry) => entry.text))
    walk(source, (node) => {
      let text = ''
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
      else if (ts.isTemplateExpression(node)) text = templateText(node)
      else if (ts.isJsxText(node) || ts.isRegularExpressionLiteral(node)) text = node.getText().trim()
      if (!text || !CJK.test(text)) return
      if (keys.has(text.trim()) || allowed.has(text) || isChineseHalf(node)) return
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      failures.push(`${file}:${line + 1} ${text}`)
    })
  }
  assert.deepEqual(failures, [], `Chinese literals without an English translation:\n${failures.join('\n')}`)
})
