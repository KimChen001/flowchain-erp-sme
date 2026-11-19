import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { STATUS_CHART_COLORS, STATUS_TONE_CODES, STATUS_TONE_COLORS, STATUS_TONE_SHADES, knownStatusTone, mostSeriousTone, statusToneOf } from '../../src/components/ui/statusTones.ts'
import { statusCodeLabel } from '../../src/i18n/statusLabels.ts'

// Design audit batch C10a (2026-11-17): one status code has one label and
// one colour on every page (L6-08, L6-14, L6-17, U-05, U-06).
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

// The snapshot: every status code the app colours, with its tone and its
// English and Chinese label. A change here is a decision about the whole app.
const SNAPSHOT = {
  draft: ['neutral', 'Draft', '草稿'],
  submitted: ['warning', 'Submitted', '已提交'],
  pending: ['warning', 'Pending', '待处理'],
  pending_approval: ['warning', 'Pending approval', '待审批'],
  approved: ['success', 'Approved', '已批准'],
  rejected: ['danger', 'Rejected', '已驳回'],
  cancelled: ['neutral', 'Cancelled', '已取消'],
  issued: ['info', 'Issued', '已下达'],
  partially_received: ['info', 'Partially received', '部分收货'],
  fully_received: ['success', 'Fully received', '全部收货'],
  received: ['success', 'Received', '已收货'],
  closed: ['neutral', 'Closed', '已关闭'],
  completed: ['success', 'Completed', '已完成'],
  posted: ['success', 'Posted', '已过账'],
  unposted: ['warning', 'Not posted', '未过账'],
  matched: ['success', 'Matched', '已匹配'],
  variance: ['danger', 'Variance', '有差异'],
  variance_approved: ['success', 'Variance approved', '差异已批准'],
  exception: ['danger', 'Exception', '异常'],
  held: ['warning', 'Held', '已暂停'],
  on_hold: ['warning', 'On hold', '已暂停'],
  overdue: ['danger', 'Overdue', '已逾期'],
  to_pay: ['info', 'To pay', '待付款'],
  to_be_paid: ['info', 'To be paid', '待收款'],
  partially_settled: ['info', 'Partly paid', '部分付款'],
  settled: ['success', 'Paid', '已结清'],
  fulfilled: ['success', 'Fulfilled', '已履约'],
  partially_fulfilled: ['info', 'Partially fulfilled', '部分履约'],
  partial: ['info', 'Partial', '部分'],
  out_of_stock: ['danger', 'Out of stock', '缺货'],
  below_safety_stock: ['warning', 'Below safety stock', '低于安全库存'],
  below_reorder_point: ['warning', 'Below reorder point', '低于再订货点'],
  ok: ['success', 'In stock', '库存正常'],
  shortage_risk: ['danger', 'Shortage risk', '缺货风险'],
  high: ['danger', 'High', '高'],
  medium: ['warning', 'Medium', '中'],
  low: ['success', 'Low', '低'],
  active: ['success', 'Active', '启用'],
  inactive: ['neutral', 'Inactive', '停用'],
}

test('each status code has one tone and one label in each language (snapshot)', () => {
  for (const [code, [tone, english, chinese]] of Object.entries(SNAPSHOT)) {
    assert.equal(statusToneOf(code), tone, `${code} tone`)
    assert.equal(statusCodeLabel(code, 'en-US'), english, `${code} en`)
    assert.equal(statusCodeLabel(code, 'zh-CN'), chinese, `${code} zh`)
  }
  // The owner's rules (2026-10-03): closed is gray, received is done.
  assert.equal(statusToneOf('closed'), 'neutral')
  assert.equal(statusToneOf('received'), 'success')
  // The reports read the same table: no 有差异 for exception, 已暂挂 for held.
  assert.match(read('src/modules/reports/analyticsCopy.ts'), /export function reportStatusCopy\(value: string, language: string\) \{\n\s+return statusCodeLabel\(value, language\) \?\? analyticsCopy\(value, language\);/)
  assert.match(read('src/modules/reports/charts/chartOptions.ts'), /\.\.\.STATUS_CHART_COLORS,/)
  // Unknown codes stay neutral.
  assert.equal(statusToneOf('something_new'), 'neutral')
  assert.equal(knownStatusTone('something_new'), undefined)
})

test('a chart colours a status in its tone\'s family, the same in every chart', () => {
  for (const code of STATUS_TONE_CODES.filter((code) => /^[a-z_]+$/.test(code))) {
    assert.ok(STATUS_TONE_SHADES[statusToneOf(code)].includes(STATUS_CHART_COLORS[code]), code)
  }
  // The statuses of one PO chart stay apart.
  const poChart = ['draft', 'pending_approval', 'approved', 'issued', 'partially_received', 'fully_received', 'closed', 'cancelled', 'rejected']
  assert.equal(new Set(poChart.map((code) => STATUS_CHART_COLORS[code])).size, poChart.length)
  const stockChart = ['ok', 'below_reorder_point', 'below_safety_stock', 'out_of_stock', 'unknown']
  assert.equal(new Set(stockChart.map((code) => STATUS_CHART_COLORS[code])).size, stockChart.length)
})

test('no page keeps its own status colour table (L6-08, U-05, U-06, L6-17)', () => {
  // The list chips read statusTones.ts.
  const layout = read('src/components/ui/listLayout.tsx')
  assert.match(layout, /export \{ statusToneOf, type StatusTone \} from "\.\/statusTones";/)
  assert.doesNotMatch(layout, /const TONES:/)
  // The PO pill, the assistant, the charts, finance, Today and the document header.
  assert.match(read('src/modules/purchasing/components/POStatusPill.tsx'), /return statusToneOf\(poStatusCodeOf\[value\] \|\| value\);/)
  assert.doesNotMatch(read('src/modules/purchasing/components/POStatusPill.tsx'), /const poStatusTone:/)
  const part = read('src/modules/ai-assistant/v2/parts/partKit.tsx')
  assert.match(part, /return status\.tone \|\| knownStatusTone\(status\.code\) \|\| "info";/)
  assert.doesNotMatch(part, /const CODE_TONE/)
  assert.match(read('src/modules/reports/charts/chartOptions.ts'), /\.\.\.STATUS_CHART_COLORS,/)
  assert.match(read('src/modules/finance/FinanceControls.tsx'), /export const financeStatusTone = \(status: string\): StatusTone => statusToneOf\(status\);/)
  assert.match(read('src/modules/overview/Page.tsx'), /const documentTone = \(status: string\) => statusToneOf\(status\);/)
  const shell = read('src/components/document/DocumentShell.tsx')
  assert.doesNotMatch(shell, /export function statusTone\(/)
  assert.match(shell, /<StatusChip label=\{copy\(status\)\} tone=\{chipTone\} testId="document-status" \/>/)
  // Contracts and suppliers draw the list chip's colours.
  assert.match(read('src/modules/contracts/contractShared.tsx'), /STATUS_TONE_COLORS\[\(STATE_TONE\[state\] \|\| "neutral"\) as StatusTone\]/)
  assert.match(read('src/modules/srm/Page.tsx'), /<StatusChip label=\{copy\(statusLabel\[row\.status\]\)\} tone=\{statusToneOf\(row\.status\)\} \/>/)
  // The evidence graph colours by codes: variance, overdue and pending
  // approval were green, 质检中 orange for its 中.
  assert.doesNotMatch(read('src/components/evidence/EvidenceGraphPanel.tsx'), /\/medium\|中\|关注\|待\|缺\//)
  assert.equal(mostSeriousTone('variance'), 'danger')
  assert.equal(mostSeriousTone('overdue'), 'danger')
  assert.equal(mostSeriousTone('pending_approval'), 'warning')
  assert.equal(mostSeriousTone('质检中'), 'info')
  assert.equal(mostSeriousTone('low 阻塞'), 'danger')
  assert.equal(mostSeriousTone(''), 'neutral')
  assert.deepEqual(Object.keys(STATUS_TONE_COLORS).sort(), ['danger', 'info', 'neutral', 'success', 'warning'])
})

test('Today and the finance pages word a status as the shared table does (L6-14)', () => {
  const today = read('src/modules/overview/todayCopy.ts')
  assert.doesNotMatch(today, /const EXTRA_STATUS/)
  // Finance keeps its own keys; each says what the shared table says, except
  // a customer invoice's "issued" (已开具, documentStatusLabel).
  // I18n.tsx holds the Chinese dictionary first, then the English one.
  const i18n = read('src/i18n/I18n.tsx')
  const zh = {}
  const en = {}
  for (const match of i18n.matchAll(/"finance\.status\.(\w+)": "([^"]+)"/g)) (match[1] in zh ? en : zh)[match[1]] = match[2]
  assert.ok(Object.keys(en).length >= 20, 'both dictionaries read')
  for (const code of Object.keys(en)) {
    if (code === 'issued') continue
    assert.equal(en[code], statusCodeLabel(code, 'en-US'), `finance en ${code}`)
    assert.equal(zh[code], statusCodeLabel(code, 'zh-CN'), `finance zh ${code}`)
  }
})

test('each detail page puts its status beside its number, and cancels in red in a dialog (U-17)', () => {
  const rfq = read('src/modules/procurement/CanonicalRfqDetailPage.tsx')
  assert.match(rfq, /<h1 className="fc-page-title">\{record\.title \|\| rfqNumber\}<\/h1>\n\s+<StatusChip [^\n]*testId="rfq-status" \/>/)
  assert.match(rfq, /className=\{listButtonClass\.danger\} data-testid="rfq-cancel-button"/)
  const receipt = read('src/modules/receiving/ReceivingPostingWorkbench.tsx')
  assert.match(receipt, /<h1 className="fc-page-title">\{grn\.documentNumber\}<\/h1><StatusChip label=\{statusText\(headerStatus\)\} tone=\{statusToneOf\(headerStatus\)\} testId="receipt-status" \/>/)
  const invoice = read('src/modules/finance/SupplierInvoiceScreens.tsx')
  assert.match(invoice, /<h1 className="fc-page-title" style=\{\{ color: A\.label \}\}>\{data\.invoiceNumber\}<\/h1>\n\s+<span data-testid="supplier-invoice-status">/)
  assert.match(invoice, /\{actions\.includes\("cancel"\) && <CancelSupplierInvoice /)
  assert.match(invoice, /testId: "invoice-cancel-dialog",/)
  assert.doesNotMatch(invoice, /testId="invoice-cancel" tone="secondary"/)
})
