import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { billPaymentStatus } from './operational-finance-read-service.mjs'

// Design audit batch C13 (2026-11-16): the purchase request pages follow the
// purchase order's, and the procurement lists share their controls.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const panel = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
const orders = read('src/modules/purchasing/Page.tsx')

test('a purchase request opens by its id or its number, and an unknown one says so (U-08)', () => {
  assert.ok(panel.includes('rows.find((row) => row.id === focusKey || (row.number || "").toLowerCase() === focusKey.toLowerCase())'))
  assert.match(panel, /if \(focusKey && loaded && !selected && !formOpen\) \{/)
  assert.match(panel, /data-testid="pr-not-found">\{tr\("notFound"\)\}/)
  assert.match(panel, /notFound: \["Purchase request not found\.", "未找到采购申请。"\]/)
})

test('a purchase request\'s detail uses the PO\'s header, overview and change history (U-09)', () => {
  // The PO's header card and overview grid, now shared.
  assert.match(panel, /<DocumentShell\s+title=\{numberOf\(selected\)\}\s+moduleLabel=\{tr\("moduleLabel"\)\}/)
  assert.match(panel, /moduleLabel: \["Purchase request", "采购申请"\]/)
  assert.match(panel, /<OverviewFields testId="pr-overview" fields=\{\[/)
  for (const key of ['estimatedTotal', 'department', 'currency', 'defaultNeedBy']) assert.match(panel, new RegExp(`label: tr\\("${key}"\\)`), key)
  assert.match(orders, /OverviewFields,\n\s+type OverviewField,/)
  assert.doesNotMatch(orders, /^function OverviewFields/m)
  assert.match(read('src/components/document/DocumentShell.tsx'), /export function OverviewFields\(\{ fields, testId = "po-overview" \}/)
  // The change history the request's commands write (entityType PurchaseRequest,
  // matched in any case since batch B1), with a label for each action.
  assert.match(panel, /<DocumentHistoryPanel\s+entityType="purchaseRequest"\s+entityId=\{selected\.id\}/)
  const ui = read('src/components/ui/index.tsx')
  for (const action of ['created', 'updated', 'submit', 'approve', 'reject', 'withdraw', 'cancel', 'converted_to_purchase_orders']) {
    assert.match(ui, new RegExp(`  purchase_request_${action}: \\["[^"]+", "[^"]+"\\],`), action)
  }
  const service = read('server/services/procurement-request-command-service.mjs')
  assert.match(service, /action: "purchase_request_created"/)
  assert.match(service, /action: "purchase_request_updated"/)
  assert.match(service, /action: `purchase_request_\$\{action\}`/)
  assert.match(service, /action: "purchase_request_converted_to_purchase_orders"/)
  // The shared back link knows the request list.
  assert.match(panel, /<BackToListLink list="requests" \/>/)
  assert.match(read('src/modules/procurement/BackToListLink.tsx'), /requests: \{ to: "\/app\/procurement\/requests", label: \["Back to purchase requests", "返回采购申请列表"\] \}/)
})

test('a request row has one blue View and a More menu with the detail page\'s step names (U-10)', () => {
  assert.doesNotMatch(panel, /ROW_ACTION_TONE/)
  assert.match(panel, /<EntityLink kind="purchase_request" id=\{pr\.id\} className=\{`\$\{rowActionClass\.primary\} !font-medium !no-underline`\}>\{tr\("view"\)\}<\/EntityLink>/)
  assert.match(panel, /<RowMenu label=\{tr\("more"\)\} testId=\{`pr-row-more-\$\{pr\.id\}`\}>/)
  // "Submit for approval" on the row too, as on the detail page and the PO.
  const menu = panel.slice(panel.indexOf('<RowMenu label={tr("more")}'), panel.indexOf('</RowMenu>'))
  assert.match(menu, /\{action === "submit" \? tr\("submitForApproval"\) : actionLabel\(action\)\}/)
})

test('both detail headers put the main step first and reject or cancel in one red style (U-17)', () => {
  assert.match(panel, /sort\(\(a, b\) => Number\(DETAIL_PRIMARY\.has\(b\)\) - Number\(DETAIL_PRIMARY\.has\(a\)\)\)/)
  assert.match(panel, /action === "reject" \? listButtonClass\.danger : listButtonClass\.secondary/)
  assert.match(read('src/components/ui/listLayout.tsx'), /danger: `inline-flex h-8 items-center gap-1\.5 rounded-lg bg-red-50 px-3/)
  const po = read('src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx')
  assert.match(po, /const DANGER_ACTIONS = new Set<WorkflowAction>\(\["reject", "cancel"\]\)/)
  assert.match(po, /DANGER_ACTIONS\.has\(action\) \? listButtonClass\.danger : poSecondaryButtonClass/)
})

test('one word per idea: Need by, Buyer and Source PR (U-12)', () => {
  assert.match(read('src/i18n/workspaceCopy.ts'), /'需求日期': 'Need by',/)
  const operations = read('src/i18n/operationsCopy.ts')
  assert.match(operations, /'默认需求日期': 'Default need by',/)
  assert.doesNotMatch(operations, /[Rr]equired date/)
  assert.match(panel, /needByDate: \["Choose a need-by date\.", "请选择需求日期。"\]/)
  const rfq = read('src/modules/procurement/CanonicalRfqDetailPage.tsx')
  assert.doesNotMatch(rfq, /Required date|Source purchase request/)
  assert.match(rfq, /tr\("来源采购申请", "Source PR"\)/)
  // The PO list's filter is named as its column is.
  assert.match(orders, /<Field label=\{copy\("采购负责人"\)\}>\s+<input value=\{filters\.owner\}/)
  assert.doesNotMatch(orders, /<Field label=\{copy\("负责人"\)\}>/)
})

test('"New purchase request" gives the form its own address, and Back closes it (U-13)', () => {
  assert.match(panel, /if \(!opensForm\(searchParams\)\) setSearchParams\(\{ mode: "create" \}\);/)
  assert.match(panel, /else if \(formOpen && !editing && !detailEdit\.current\) \{\s+reset\(\);\s+setFormOpen\(false\);/)
})

test('the request list pages like the PO list, counts what the filters match and refreshes (U-14, U-15)', () => {
  assert.match(panel, /const PR_LIST_PAGE_SIZE = 50;/)
  assert.match(panel, /const paged = usePagedRows\(shownRows, PR_LIST_PAGE_SIZE, JSON\.stringify\(\[filters, statusFilter\]\)\);/)
  assert.match(panel, /<ListCard title=\{tr\("listTitle"\)\} total=\{loaded \? shownRows\.length : undefined\} shown=\{paged\.pageRows\.length\}/)
  assert.match(panel, /<ListPager page=\{paged\.page\} pageSize=\{PR_LIST_PAGE_SIZE\} total=\{shownRows\.length\}/)
  assert.match(panel, /<RefreshButton onClick=\{reload\} \/>/)
  // "—" until the requests load, never a 0 that is not yet true.
  assert.match(panel, /const count = \(status: string\) => \(loaded \? String\(rows\.filter\(\(row\) => row\.status === status\)\.length\) : "—"\);/)
})

test('the PO list keeps its page on Refresh and tells an empty workspace from an empty filter (U-15)', () => {
  assert.match(orders, /if \(!loadedForAddress\) \{\n\s+return <Card className="p-12 text-center text-sm" data-testid="po-loading-state">/)
  assert.doesNotMatch(orders, /if \(loading \|\| !loadedForAddress\)/)
  assert.match(orders, /\{filtered\.length === 0 && \(orders\.length === 0\n\s+\? <ListStateRow colSpan=\{8\} state="empty" title=\{say\("No purchase orders yet", "暂无采购订单"\)\}/)
})

test('"View three-way match" opens that order\'s matches, Match review the matches that differ, and each match has View (U-20)', () => {
  assert.match(orders, /routerNavigate\(`\/app\/procurement\/three-way-match\?q=\$\{encodeURIComponent\(purchaseOrderNumber\(order\)\)\}`\)/)
  assert.match(orders, /to="\/app\/procurement\/three-way-match\?result=variance" icon=\{ShieldCheck\}/)
  assert.doesNotMatch(orders, /bills\?status=exception/)
  const match = read('src/modules/procurement/ThreeWayMatchListPage.tsx')
  assert.match(match, /const \[query, setQuery\] = useState\(\(\) => searchParams\.get\("q"\) \|\| ""\);/)
  assert.match(match, /<Link to=\{`\/app\/procurement\/three-way-match\/\$\{encodeURIComponent\(row\.id \|\| ""\)\}`\} className=\{rowActionClass\.primary\} data-testid="three-way-match-view">\{tr\("view"\)\}<\/Link>/)
})

test('a supplier\'s invoices read as the invoice list reads them: To pay, Partly paid, Paid (U-22)', () => {
  const activity = read('src/modules/srm/supplierActivity.tsx')
  assert.match(activity, /const shown = shownBillStatus\(row\); return <StatusChip label=\{billStatusLabel\(shown\)\} tone=\{financeStatusTone\(shown\)\} \/>;/)
  const insights = read('server/domain/supplier-insights.mjs')
  assert.match(insights, /payableObligation: \{ select: \{ status: true \} \}/)
  assert.match(insights, /paymentStatus: billPaymentStatus\(row\.status, row\.payableObligation\?\.status\),/)
  // The rule the invoice list uses.
  assert.equal(billPaymentStatus('approved', 'open'), null)
  assert.equal(billPaymentStatus('approved', 'approved'), 'to_pay')
  assert.equal(billPaymentStatus('approved', 'partially_settled'), 'partially_settled')
  assert.equal(billPaymentStatus('approved', 'settled'), 'settled')
  assert.equal(billPaymentStatus('submitted', 'approved'), null)
})

test('on a phone a metric card is its number and name, and a form keeps the assistant\'s corner free (W-05, W-06)', () => {
  const card = read('src/components/cards/ActionableMetricCard.tsx')
  assert.match(card, /<div className="flex items-center justify-between max-sm:hidden">/)
  assert.match(card, /<div className="fc-caption mt-1 max-sm:hidden"/)
  // The description is still read out in the card's label.
  assert.match(card, /aria-label=\{`\$\{copy\(label\)\}: \$\{value\}, \$\{copy\(description\)\}`\}/)
  // The assistant's button is 48 px, 12 px from the corner (Panel.tsx).
  assert.match(read('src/modules/ai-assistant/Panel.tsx'), /fixed bottom-3 right-3 z-40 flex h-12 w-12/)
  assert.match(read('src/components/ui/formLayout.tsx'), /sticky bottom-0 z-10 [^"]*max-sm:pr-16/)
})

test('every list counts what its filters match, says out of how many, and pages (U-14, W-04)', () => {
  const layout = read('src/components/ui/listLayout.tsx')
  assert.match(layout, /matching: \["\{total\} of \{all\} match the filters, \{shown\} shown", "\{all\} 条中 \{total\} 条符合筛选，当前显示 \{shown\} 条"\]/)
  assert.match(layout, /all !== undefined && all !== total \? say\("matching", \{ total, all, shown: shown \?\? total \}\) : say\("shown"/)
  for (const [file, pager] of [
    ['src/modules/procurement/RfqListPage.tsx', 'rfq-list-pager'],
    ['src/modules/procurement/ThreeWayMatchListPage.tsx', 'three-way-match-pager'],
    ['src/modules/procurement/ProcurementWorkbench.tsx', 'procurement-work-pager'],
  ]) {
    const source = read(file)
    assert.match(source, /const PAGE_SIZE = 50;/, file)
    assert.match(source, /const paged = usePagedRows\(shown, PAGE_SIZE, /, file)
    assert.match(source, /total=\{state === "loaded" \? shown\.length : undefined\} all=\{state === "loaded" \? rows\.length : undefined\} shown=\{paged\.pageRows\.length\}/, file)
    assert.match(source, new RegExp(`<ListPager page=\{paged\.page\} pageSize=\{PAGE_SIZE\} total=\{shown\.length\} onPage=\{paged\.setPage\} testId="${pager}" />`), file)
    assert.doesNotMatch(source, /&& shown\.map\(/, file)
  }
  assert.match(read('src/modules/procurement/ReceivingListPage.tsx'), /total=\{state === "loaded" \? shown\.length : undefined\} all=\{state === "loaded" \? rows\.length : undefined\} shown=\{pageRows\.length\}/)
  // Inventory: "1 of 196 match the filters", not "196 total, 1 shown".
  const inventory = read('src/modules/inventory/Page.tsx')
  assert.match(inventory, /total=\{state === "ready" \? \(narrowed \? visible\.length : listAll\) : undefined\} all=\{state === "ready" && narrowed \? listAll : undefined\}/)
  assert.match(read('src/modules/master-data/Page.tsx'), /<ListCard title=\{copy\(view\.list\)\} total=\{shown\} all=\{all\}/)
  // Suppliers and contracts page too; the contract list asks the server for its page.
  const suppliers = read('src/modules/srm/Page.tsx')
  assert.match(suppliers, /const supplierPage = usePagedRows\(sortedRows, SUPPLIER_PAGE_SIZE, /)
  assert.match(suppliers, /testId="supplier-list-pager"/)
  const contracts = read('src/modules/contracts/ContractsListPage.tsx')
  assert.match(contracts, /page: String\(page\), sort:/)
  assert.match(contracts, /<ListPager page=\{page\} pageSize=\{CONTRACT_PAGE_SIZE\} total=\{data\?\.total \?\? 0\} onPage=\{setPage\} testId="contracts-pager" \/>/)
  assert.match(contracts, /const truncated = Boolean\(data\?\.limitations\?\.includes\("truncated"\)\);/)
})

test('loading rows and failed reads look the same on every list (U-15)', () => {
  for (const file of ['src/modules/procurement/ThreeWayMatchListPage.tsx', 'src/modules/procurement/ReceivingListPage.tsx']) {
    const source = read(file)
    assert.match(source, /\{state === "loading" && <ListStateRow colSpan=\{\d\} state="loading" \/>\}/, file)
  }
  const finance = read('src/modules/finance/OperationalFinanceP2pWorkbench.tsx')
  assert.match(finance, /<Warning title=\{error\.code\}>\{error\.message\}<\/Warning>\n\s+<button type="button" onClick=\{load\} className=\{listButtonClass\.secondary\}>\{listSay\("retry"\)\}<\/button>/)
})

test('suppliers, their evaluation and contracts use the shared search card; the contract form its action bar (U-16)', () => {
  for (const file of ['src/modules/srm/Page.tsx', 'src/modules/srm/SupplierEvaluationPage.tsx', 'src/modules/contracts/ContractsListPage.tsx']) {
    const source = read(file)
    assert.match(source, /<ListSearchCard\n\s+title=/, file)
    assert.match(source, /activeFilters=\{\[/, file)
    assert.match(source, /<ResetButton onClick=\{resetFilters\} \/>/, file)
    assert.doesNotMatch(source, /<h2 className="fc-section-title"[^>]*>\{(copy|t)\("(Supplier|Contract) search"\)\}<\/h2>/, file)
  }
  assert.match(read('src/modules/srm/SupplierEvaluationPage.tsx'), /className=\{rowActionClass\.neutral\}>/)
  const form = read('src/modules/contracts/ContractForm.tsx')
  assert.match(form, /<RequiredNote \/>/)
  assert.doesNotMatch(form, /Required fields/)
  assert.match(form, /<FormActionBar\n\s+onCancel=\{onCancel\}\n\s+submit=\{\{ label: t\(editing \? "Save changes" : "Save draft"\), onClick: \(\) => void save\(\), busy: saving, testId: "contract-save" \}\}/)
  assert.match(form, /messageTestId="contract-form-error"/)
})
