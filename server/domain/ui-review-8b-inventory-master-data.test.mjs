import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// UI review 8 (order to cash), round 8b: the inventory document page, the
// customer page and the item page. The browser specs check the rendered
// pages (tests/browser/inventory-operations.spec.ts,
// tests/browser/master-data-related-records.spec.ts).
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const workbench = read('src/modules/inventory/InventoryOperationsWorkbench.tsx')
const detail = workbench.slice(workbench.indexOf('function OperationDetail('))

test('an inventory document has no prefilled reason box; cancel and reverse ask for one (findings 16, 23)', () => {
  assert.doesNotMatch(workbench, /useState\("Correction"\)/)
  assert.doesNotMatch(detail, /aria-label=\{copy\("操作原因"\)\}/)
  // Only a cancellation and a reversal send a reason, typed in their dialog.
  assert.match(detail, /\.\.\.\(reason \? \{ reason \} : \{\}\)/)
  for (const action of ['reverse', 'cancel']) {
    const body = detail.slice(detail.indexOf(`const ${action} = async () => {`), detail.indexOf(`if (reason !== null) await run("${action}", reason);`))
    assert.match(body, /dialog\.prompt\(\{/, action)
    assert.match(body, /field: \{ label: say\(/, action)
  }
})

test('posting is one step that shows the stock change before → after (finding 23)', () => {
  const post = detail.slice(detail.indexOf('const post = async () => {'), detail.indexOf('const reverse = async () => {'))
  // The server's preview runs inside the step; a refusal is said in words.
  assert.match(post, /const plan = await readPlan\("post"\);/)
  assert.match(post, /if \(!plan\.allowed\) \{\s*setError\(planText\(plan\)\);/)
  assert.match(post, /dialog\.confirm\(\{[\s\S]*\{stockChange\(plan\)\}[\s\S]*confirmLabel: say\("Post", "过账"\)/)
  assert.match(post, /if \(confirmed\) await run\("post"\);/)
  // Each stock record's on-hand quantity before and after, from the plan.
  assert.match(detail, /before: quantityText\(impact\.onHandBefore, unit\),\s*after: quantityText\(impact\.onHandAfter, unit\),/)
  // The old preview panel and its separate Confirm are gone.
  assert.doesNotMatch(detail, /inventory-operation-preview"|confirm-inventory-operation|预览允许执行/)
  assert.match(detail, /"operation-post"\)/)
  // A blocking code reads as a sentence, never as the code itself.
  assert.match(detail, /PLAN_ISSUES\[item\.code\] \? say\(\.\.\.PLAN_ISSUES\[item\.code\]\) : ""/)
})

test('the document page names itself in the breadcrumb, hides reconciliation before posting and turns lines into cards on a phone (finding 23)', () => {
  assert.match(detail, /useDetailCrumb\(title \|\| null\);/)
  assert.match(detail, /const posted = document\.postingStatus === "posted" \|\| document\.postingStatus === "reversed";/)
  assert.match(detail, /\{posted && \(\s*<div className="mt-4 text-sm" data-testid="inventory-reconciliation">/)
  assert.match(detail, /\{\(posted \|\| movements\.length > 0\) && \(/)
  assert.match(detail, /<div className="overflow-x-auto px-2 pb-2" ref=\{listTableCardsRef\}>/)
})

test('the customer page shows its orders, invoices and balance, offers a new order and says "Back" once (finding 13)', () => {
  const page = read('src/components/business/BusinessEntityDetailPage.tsx')
  assert.match(page, /\{customer && <CustomerRelatedRecords customer=\{customer\} \/>\}/)
  assert.match(page, /\{customer && <CustomerNewOrderAction customer=\{customer\} \/>\}/)
  assert.equal(page.split('{returnLabel}</Link>').length - 1, 2, 'one back link above the record, one on the not-found card')
  const related = read('src/components/business/CustomerRelatedRecords.tsx')
  // Read through the lists the sales and finance pages use, each only for a
  // reader who may read it; the balance also needs the amounts permission.
  assert.match(related, /const canReadOrders = may\("sales_order\.read"\);/)
  assert.match(related, /const canReadInvoices = may\("finance\.customer_invoice\.read"\);/)
  assert.match(related, /const canReadBalance = may\("finance\.receivable\.read"\) && may\("finance\.amounts\.read"\);/)
  assert.match(related, /`\/api\/sales\/orders\?customer=\$\{query\}/)
  assert.match(related, /`\/api\/finance\/customer-invoices\?search=\$\{query\}/)
  assert.match(related, /"\/api\/finance\/aging"/)
  // Name matches are kept only for this customer's id.
  assert.match(related, /row\.customerId \? row\.customerId === customer\.id :/)
  // Money per currency, never added across currencies.
  assert.match(related, /amounts\(byCurrency\(owed\.rows, \(row\) => row\.currency, outstanding\)\)/)
  // The receivables list's overdue rule: past due and not disputed.
  assert.match(related, /const OVERDUE_STATUSES = new Set\(\["open", "partially_settled", "overdue"\]\);/)
  // New sales order for an active customer, for a reader who may create one.
  assert.match(related, /permissions\?\.has\("sales_order\.create"\) \|\| !canOpenRoute\("sales:order-new"\) \|\| customer\.status !== "active"/)
  assert.match(related, /\/app\/sales\/orders\/new\?customerId=/)
})

test('the item page shows stock per warehouse, recent movements and orders still to ship, with filtered links (finding 31)', () => {
  const items = read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(items, /<ItemStockAndOrders itemId=\{selected\.itemId\} sku=\{selected\.sku\} baseUnit=\{selected\.baseUnit\} \/>/)
  const panel = read('src/modules/master-data/ItemStockAndOrders.tsx')
  assert.match(panel, /`\/api\/inventory\/balances\?sku=\$\{key\}&page=\$\{page\}&pageSize=200`/)
  assert.match(panel, /`\/api\/inventory\/movements\?sku=\$\{key\}&page=1&pageSize=\$\{RECENT\}&sort=occurredAt&direction=desc`/)
  assert.match(panel, /`\/api\/sales-demand\/orders\?sku=\$\{key\}&orderStatus=\$\{status\}&limit=\$\{RECENT\}`/)
  // The list pages' own filters.
  assert.match(panel, /`\/app\/inventory\/stock\?sku=\$\{encodeURIComponent\(sku\)\}`/)
  assert.match(panel, /`\/app\/inventory\/movements\?sku=\$\{encodeURIComponent\(sku\)\}`/)
  assert.match(panel, /`\/app\/procurement\/orders\?item=\$\{encodeURIComponent\(sku\)\}&status=open`/)
  assert.match(panel, /if \(!canReadOrders\) \{ setOrders\(\{ state: "hidden", rows: \[\] \}\); return; \}/)
})
