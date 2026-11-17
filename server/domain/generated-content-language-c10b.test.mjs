import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { signInEmailLanguage } from '../auth/email-link-sign-in.mjs'
import { formatCurrencyAmount, setWorkspaceNumberLocale } from '../../src/lib/format.ts'

// Design audit batch C10, part b (2026-11-17): what FlowChain generates
// (emails, exports, printed sheets, server messages) in the reader's language.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the sign-in email is in the sign-in page\'s language when the person saved none (L16)', () => {
  const user = (languagePreference, defaultLanguage = 'en-US') => ({ languagePreference, tenant: { defaultLanguage } })
  assert.equal(signInEmailLanguage(user(null), 'zh-CN'), 'zh-CN')
  assert.equal(signInEmailLanguage(user('workspace'), 'zh-CN'), 'zh-CN')
  // A saved preference wins over the page.
  assert.equal(signInEmailLanguage(user('en-US'), 'zh-CN'), 'en-US')
  // Without either, the workspace's default.
  assert.equal(signInEmailLanguage(user(null, 'zh-CN'), undefined), 'zh-CN')
  assert.equal(signInEmailLanguage(user(null), 'fr-FR'), 'en-US')
  assert.match(read('server/bootstrap/session-routes.mjs'), /emailLinks\.request\(\{ email: body\?\.email, language: body\?\.language,/)
  const page = read('src/app/SignInScreens.tsx')
  assert.match(page, /JSON\.stringify\(\{ email: address, language: pageLanguage \}\)/)
  assert.match(page, /JSON\.stringify\(\{ email: invitation\.email, language \}\)/)
})

test('an export\'s sheet, empty note and the PO list\'s columns are in the interface language (L16, U-03)', () => {
  const workbook = read('src/lib/excel/excelWorkbookService.ts')
  assert.match(workbook, /results: \["Results", "当前结果"\]/)
  assert.match(workbook, /sheetName = exportText\("results"\)/)
  assert.match(workbook, /const safeRows = rows\.length \? rows : \[\{ \[exportText\("note"\)\]: exportText\("empty"\) \}\];/)
  assert.doesNotMatch(workbook, /\{ 说明: "当前筛选范围暂无数据" \}/)
  const orders = read('src/modules/purchasing/Page.tsx')
  assert.doesNotMatch(orders, /PO编号:|来源PR:|三单匹配状态:/)
  assert.match(orders, /\[say\("Status", "状态"\)\]: statusCodeLabel\(purchaseOrderStatusCode\(order\.status\), language\) \|\| copy\(order\.status\),/)
  assert.match(orders, /\[say\("Currency", "币种"\)\]: order\.currency \|\| "",/)
  assert.match(read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx'), /\[tr\("currency"\)\]: pr\.defaultCurrency,/)
})

test('a printed sheet and its layout editor are in the interface language (L16, L6-18, L11-28)', () => {
  const canvas = read('src/modules/print-layout/PrintCanvas.tsx')
  assert.match(canvas, /pageNumber: \["Page 1 of 1", "第 1 页 \/ 共 1 页"\]/)
  assert.match(canvas, /colon: \[": ", "："\]/)
  assert.match(canvas, /\{element\.title\}\{say\("colon"\)\}/)
  const fields = read('src/modules/print-layout/printDataAdapters.ts')
  assert.match(fields, /export function printFieldOptionsFor\(documentType: PrintDocumentType, language: string\)/)
  assert.doesNotMatch(fields, /export const printFieldOptions:/)
  const inspector = read('src/modules/print-layout/PrintElementInspector.tsx')
  // Every Chinese label in the inspector is paired with its English.
  for (const line of inspector.split(/\r?\n/).filter((line) => /[一-鿿]/.test(line))) assert.match(line, /say\(/, line.trim())
})

test('a missing name or status shows what the record holds, not an invented one (L16)', () => {
  assert.match(read('src/modules/purchasing/components/POStatusPill.tsx'), /if \(!status\) return <StatusChip label="—" tone="neutral" \/>;/)
  for (const file of ['src/modules/master-data/api.ts', 'src/modules/inventory/api.ts']) assert.doesNotMatch(read(file), /物料 \$\{index \+ 1\}|供应商 \$\{index \+ 1\}/, file)
})

test('amounts follow the workspace number format (U-07)', () => {
  setWorkspaceNumberLocale('zh-CN')
  assert.equal(formatCurrencyAmount(1234.5, 'USD'), 'US$1,234.50')
  setWorkspaceNumberLocale('en-US')
  assert.equal(formatCurrencyAmount(1234.5, 'USD'), '$1,234.50')
  assert.equal(formatCurrencyAmount(null, 'USD'), '—')
  assert.match(read('src/i18n/I18n.tsx'), /useEffect\(\(\) => \{ setWorkspaceNumberLocale\(state\.locale\); \}, \[state\.locale\]\);/)
})

test('a server error reads in the interface language, never as the server\'s raw English in Chinese (L16)', () => {
  const decisions = read('src/modules/overview/DecisionCards.tsx')
  assert.doesNotMatch(decisions, /t\("failed", \{ message: error instanceof Error \? error\.message/)
  assert.match(decisions, /t\("failed", \{ message: apiErrorText\(error, t\.language, RETRY_LATER\) \}\)/)
  const finance = read('src/modules/finance/FinanceControls.tsx')
  assert.match(finance, /const failure = \(cause: ApiError\) => issueText\?\.\(cause\.code\) \|\| \(language === "en-US" \? cause\.message : apiErrorText\(cause, language, cause\.status === 409 \? \["Someone else changed this first/)
})

test('purchase request checks speak English on the server, and the page names an item with no approved supplier (L1-31)', () => {
  const workflow = read('server/domain/procurement-workflow.mjs')
  const messages = [...workflow.matchAll(/procurementError\(\s*["'][A-Z_]+["']\s*,\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2])
  assert.ok(messages.length >= 12)
  for (const message of messages) assert.doesNotMatch(message, /[一-鿿]/, message)
  const panel = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  assert.match(panel, /ITEM_HAS_NO_APPROVED_SUPPLIER: \["This item has no approved supplier yet\./)
  assert.match(panel, /<Field label=\{tr\("skuOrOther"\)\} required/)
  assert.doesNotMatch(read('src/modules/purchasing/Page.tsx'), /"件"\)/)
})

test('Today, Reports and supplier invoice analytics have one name each (L6-19)', () => {
  const registry = read('src/app/routeRegistry.tsx')
  assert.doesNotMatch(registry, /label: "今日待办"/)
  assert.match(registry, /id: "reports",\s+path: "\/app\/reports",[\s\S]{0,200}label: "报表中心",/)
  assert.match(registry, /label: "采购发票分析",/)
  assert.match(read('src/i18n/workspaceCopy.ts'), /'采购发票分析': 'Supplier invoice analytics'/)
  assert.doesNotMatch(read('index.html'), /forecasting/)
})
