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

// English-covered screens: the files on the English trial path whose copy is
// English first.
//
// What the second test proves, for these files only: every Chinese literal
// (string, template text, JSX text or regular expression; comments are not
// literals) is in one of these direct shapes, and failures are reported as
// file:line.
//   1. Translated: a key of a display dictionary (DICTIONARIES) that is the
//      first argument of a translating call (TRANSLATING_CALLS), or the value
//      of a prop the component translates (TRANSLATED_PROPS, and the label and
//      value of the items in TRANSLATED_ITEMS). The literal may reach the call
//      or prop through parentheses, `||`, `??` or a ternary branch, nothing else.
//   2. The Chinese half of a pair: the second element of a two-element
//      [English, Chinese] array whose English half reads as text (a capital letter
//      or a space, so [code, 中文] lookups do not count); the Chinese argument of a known pair function
//      (PAIR_CALLS) whose other argument is an English literal; the value of a
//      zh / zh-CN key, or of a property one object below such a key; the value
//      of an English string key (an English-to-Chinese map); or the branch an
//      "en-US" ternary takes for Chinese when that branch is the literal itself.
//   3. Allow-listed below, with the reason.
// What it does not prove: that a translating call or pair function picks the
// interface language at render time, that a Chinese value kept in state or a
// variable is translated where it is shown (those sites are allow-listed), that
// server-generated text is translated, or anything about other files. The
// browser specs (tests/browser/english-trial.spec.ts and its zh-CN smoke test)
// check the rendered pages.
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
  'src/modules/sales/OutboundWorkbench.tsx',
  'src/modules/inventory/Page.tsx',
  'src/app/FlowChainApp.tsx',
  'src/modules/procurement/ProcurementWorkbench.tsx',
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

// Calls that translate one argument through those dictionaries, with the
// index of that argument: copy() in each covered screen (useWorkspaceCopy,
// useSalesCopy, useInventoryOperationsCopy or the module-level workspaceCopy
// wrapper), the i18n t(), workspaceCopy() itself, and the inventory
// operations errorText(reason, fallback), which translates its fallback.
const TRANSLATING_CALLS = { copy: 0, t: 0, workspaceCopy: 0, errorText: 1 }

// Pair functions: the index of the Chinese argument; the other one is English.
const PAIR_CALLS = [
  { name: 'say', chinese: 1 },
  { name: 'tr', chinese: 0, file: 'src/modules/procurement/ReceivingListPage.tsx' },
]

// Props the component translates with the workspace dictionary.
const TRANSLATED_PROPS = {
  Chip: ['label'],
  SectionHeader: ['title'],
  DetailSection: ['title'],
  ActionableMetricCard: ['label', 'description'],
}
// Array props whose items' properties the component translates.
const TRANSLATED_ITEMS = {
  CompactKpiStrip: { items: ['label', 'value'] },
  DetailFieldGrid: { fields: ['label', 'value'] },
  EvidenceSummaryPanel: { groups: ['label'] },
}

// Chinese literals outside those shapes, each with its reason.
const ALLOWED = [
  // The server's Chinese status labels, matched to filter unshipped orders.
  { file: 'src/modules/sales/Page.tsx', text: '/已完成|已交付/' },
  // The read API's fallback customer name, compared before it is translated.
  { file: 'src/modules/sales/Page.tsx', text: '未命名客户', line: /order\.customerName === "未命名客户"/ },
  // Data limitation labels by code; limitationLabel() is shown through copy().
  { file: 'src/modules/sales/Page.tsx', within: 'limitationLabel' },
  // Error and warning text kept in state and shown through copy() when rendered.
  { file: 'src/modules/sales/Page.tsx', text: '当前未读取到客户订单记录，请检查工作区数据或刷新后重试。' },
  { file: 'src/modules/sales/Page.tsx', text: '当前暂未读取到完整证据链，请返回客户订单列表或切换业务对象后重试。' },
  // Request errors kept in state in their source form and shown through copy().
  { file: 'src/modules/sales/OutboundWorkbench.tsx', within: 'errorMessage' },
  // A part of the server's timeline summary, compared before it is translated.
  { file: 'src/modules/sales/OutboundWorkbench.tsx', text: '未指定仓库', line: /part === "未指定仓库"/ },
  // Legacy Chinese stored order statuses, compared to leave finished orders out.
  { file: 'src/modules/procurement/ProcurementWorkbench.tsx', line: /^\["fully_received", "completed", "closed", "cancelled", "已完成", "已关闭", "已取消"\]$/ },
  // Matchers for the server's invoice and match status text, never shown.
  { file: 'src/modules/procurement/ProcurementWorkbench.tsx', text: '/差异|variance/i' },
  { file: 'src/modules/procurement/ProcurementWorkbench.tsx', text: '/差异|异常|待处理|variance/i' },
  // The route registry's group name, compared to pick the translated heading.
  { file: 'src/app/FlowChainApp.tsx', text: '主导航', line: /^group\.label === "主导航"$/ },
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
// The English half of an [English, Chinese] array is text a person reads: it starts
// with a capital letter or has a space. A lower-case or camelCase word is a code
// (a status, a query parameter), and [code, 中文] is a lookup, not a translation.
const englishText = (node) => englishLiteral(node) && /^[A-Z]|\s/.test(ts.isTemplateExpression(node) ? templateText(node) : node.text)
const nameText = (name) => name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) ? name.text : ''
const calleeName = (call) => ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''
const isChineseKey = (property) => ts.isPropertyAssignment(property) && /^(?:zh|zh-CN)$/.test(nameText(property.name))
const ENGLISH_CONDITION = /["']en-US["']|\b(?:en|english|isEnglish|englishUi|isEn)\b/

// The expression the literal is passed as: climbs parentheses, `||` / `??`
// operands and ternary branches (not conditions).
function passedAs(literal) {
  let node = literal
  for (;;) {
    const parent = node.parent
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) node = parent
    else if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) node = parent
    else if (ts.isConditionalExpression(parent) && parent.condition !== node) node = parent
    else return node
  }
}

const jsxTagName = (attribute) => attribute.parent?.parent?.tagName?.getText() || ''

function isTranslated(literal) {
  const node = passedAs(literal)
  const parent = node.parent
  if (ts.isCallExpression(parent) && Object.hasOwn(TRANSLATING_CALLS, calleeName(parent)) && parent.arguments[TRANSLATING_CALLS[calleeName(parent)]] === node) return true
  const attribute = ts.isJsxExpression(parent) ? parent.parent : parent
  if (ts.isJsxAttribute(attribute) && (TRANSLATED_PROPS[jsxTagName(attribute)] || []).includes(nameText(attribute.name))) return true
  // { label: "…", value: "…" } items of a translating component's array prop.
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const array = parent.parent?.parent
    const expression = array?.parent
    const itemAttribute = expression && ts.isJsxExpression(expression) ? expression.parent : null
    if (ts.isArrayLiteralExpression(array) && itemAttribute && ts.isJsxAttribute(itemAttribute)) {
      const props = TRANSLATED_ITEMS[jsxTagName(itemAttribute)]?.[nameText(itemAttribute.name)] || []
      if (props.includes(nameText(parent.name))) return true
    }
  }
  return false
}

function isChineseHalf(literal, file) {
  const parent = literal.parent
  if (ts.isArrayLiteralExpression(parent) && parent.elements.length === 2 && parent.elements[1] === literal && englishText(parent.elements[0])) return true
  if (ts.isCallExpression(parent) && parent.arguments.length === 2) {
    const pair = PAIR_CALLS.find((entry) => entry.name === calleeName(parent) && (!entry.file || entry.file === file))
    if (pair && parent.arguments[pair.chinese] === literal && englishLiteral(parent.arguments[1 - pair.chinese])) return true
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === literal) {
    if (isChineseKey(parent)) return true
    if (ts.isObjectLiteralExpression(parent.parent) && isChineseKey(parent.parent.parent)) return true
    if ((ts.isStringLiteral(parent.name) || ts.isNoSubstitutionTemplateLiteral(parent.name)) && !CJK.test(parent.name.text)) return true
  }
  if (ts.isConditionalExpression(parent) && parent.whenFalse === literal && ENGLISH_CONDITION.test(parent.condition.getText())) return true
  return false
}

function isAllowed(literal, text, file) {
  return ALLOWED.some((entry) => entry.file === file
    && (!entry.text || entry.text === text)
    && (!entry.line || entry.line.test(literal.parent.getText()))
    && (!entry.within || withinFunction(literal, entry.within)))
}

function withinFunction(node, name) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name?.text === name) return true
  }
  return false
}

test('English-covered screens translate every Chinese literal they show', () => {
  const keys = dictionaryKeys()
  const failures = []
  for (const file of ENGLISH_COVERED) {
    const source = parse(file)
    walk(source, (node) => {
      let text = ''
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
      else if (ts.isTemplateExpression(node)) text = templateText(node)
      else if (ts.isJsxText(node) || ts.isRegularExpressionLiteral(node)) text = node.getText().trim()
      if (!text || !CJK.test(text)) return
      if ((keys.has(text) && isTranslated(node)) || isChineseHalf(node, file) || isAllowed(node, text, file)) return
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      failures.push(`${file}:${line + 1} ${text}`)
    })
  }
  assert.deepEqual(failures, [], `Chinese literals outside a translating call, a pair or the allow-list:\n${failures.join('\n')}`)
})

test('an [English, Chinese] pair counts, a [code, Chinese] lookup does not', () => {
  const chineseLiteral = (source) => {
    const file = ts.createSourceFile('pair.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let found = null
    walk(file, (node) => { if (!found && isLiteral(node) && CJK.test(node.text)) found = node })
    return found
  }
  assert.equal(isChineseHalf(chineseLiteral('const label = ["Movement type", "流水类型"]'), 'pair.tsx'), true)
  assert.equal(isChineseHalf(chineseLiteral('const label = ["SKU", "物料编码"]'), 'pair.tsx'), true)
  assert.equal(isChineseHalf(chineseLiteral('const filter = ["movementType", "流水类型"]'), 'pair.tsx'), false)
  assert.equal(isChineseHalf(chineseLiteral('const status = ["draft", "草稿"]'), 'pair.tsx'), false)
})
