import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20, items 15 and 31: one figure under four names,
// headings that differ from their tabs, and a raw "customer" in search.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the stock page words the reorder figure as the reorder list and the other pages do', () => {
  const page = read('src/modules/inventory/Page.tsx')
  assert.match(page, /short: \["Order now", "立即下单"\],/)
  assert.match(page, /shortCount: \["Items to reorder", "待补货物料"\],/)
  assert.equal((page.match(/<ActionableMetricCard label=\{tr\("shortCount"\)\}/g) || []).length, 2)
  assert.doesNotMatch(page, /Need replenishment/)
  // The same words elsewhere.
  assert.match(read('src/modules/inventory/reorderListCopy.ts'), /orderNow: "Order now",[\s\S]*orderNow: "立即下单",/)
  assert.match(read('src/modules/procurement/ProcurementWorkbench.tsx'), /reorder: \["Items to reorder", "待补货物料"\]/)
})

test('the invoice dashboard heading matches its tab, and the payment terms tab names only terms', () => {
  const dashboard = read('src/modules/reports/BiDashboard.tsx')
  assert.match(dashboard, /finance: \{ label: "采购发票分析",/)
  assert.match(dashboard, /"采购发票分析": "Supplier invoice analytics"/)
  assert.match(read('src/i18n/workspaceCopy.ts'), /'采购发票分析': 'Supplier invoice analytics'/)
  assert.match(read('src/i18n/workspaceCopy.ts'), /'支付方式 \/ 付款条款': 'Payment terms'/)
})

test('global search labels customers, which the server searches', () => {
  assert.match(read('server/domain/runtime-business-search.mjs'), /\['customer', 'customers',/)
  const app = read('src/app/FlowChainApp.tsx')
  assert.match(app, /customer: \{ en: "Customer", zh: "客户" \},/)
  assert.match(app, /customer: \{ en: "Customers", zh: "客户" \},/)
  assert.match(app, /const SEARCH_GROUP_ORDER = \[[^\]]*"customer",[^\]]*\];/)
})
