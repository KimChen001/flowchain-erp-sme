import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Round 8 of the UI review: the parts of every page around the content.
// A walk of the main pages at 1440 px and on a 390 px phone found the same
// word three times on top of Today (trail, tab, title), two entries to the
// assistant, tab rows folding onto two lines (ten under Settings, six on a
// phone), column names scrolling away on 50-row lists and Today's tiles drawn
// unlike the cards on every other page.

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('a one-step trail is not shown, and a list page keeps its trail off a phone', async () => {
  const crumb = await read('src/components/navigation/AppBreadcrumb.tsx')
  assert.match(crumb, /if \(items\.length < 2\) return null;/)
  assert.match(crumb, /route\.pageType === "detail" \? "" : "max-sm:hidden"/)
})

test('the assistant has one entry, its floating button', async () => {
  const app = await read('src/app/FlowChainApp.tsx')
  assert.doesNotMatch(app, /\{t\("nav\.ai"\)\}/)
  const panel = await read('src/modules/ai-assistant/Panel.tsx')
  assert.match(panel, /data-testid="ai-assistant-toggle"/)
})

test('the public data note keeps to one line until it is opened (owner 11/13)', async () => {
  const note = await read('src/app/PublicDataNote.tsx')
  assert.ok(note.includes('<p className={open ? undefined : "truncate"}'))
  assert.ok(note.includes('className={`flex gap-2.5 ${open ? "items-start" : "items-center"}`}'))
  // "What is assumed" sits on the same line, before the hide button.
  assert.ok(note.includes('className="shrink-0 whitespace-nowrap text-xs font-semibold text-sky-800'))
})

test("Today's tab row is its header: the title is read out, not drawn again (owner 11/13)", async () => {
  const shell = await read('src/components/navigation/ModuleShell.tsx')
  assert.ok(shell.includes('{showPageHeader && route.moduleId === "overview" ? ('))
  assert.ok(shell.includes('<h1 className="sr-only" data-testid="page-title">{routeLabel(route)}</h1>'))
})

test('module tabs stay on one row that scrolls, with arrows from a tablet up', async () => {
  const shell = await read('src/components/navigation/ModuleShell.tsx')
  assert.match(shell, /<div className="fc-subnav-track" ref=\{subnav\.ref\}/)
  assert.match(shell, /data-testid="module-subnav-earlier"/)
  assert.match(shell, /data-testid="module-subnav-more"/)
  // The active tab is brought into view until the reader moves the row.
  assert.match(shell, /if \(moved\.current \|\| !active/)
  const css = await read('src/styles/theme.css')
  assert.match(css, /\.fc-subnav-track \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/)
  assert.match(css, /\.fc-subnav-arrow \{[^}]*hidden[^}]*sm:flex/)
  assert.doesNotMatch(css, /\.fc-module-subnav \{ @apply flex flex-wrap/)
})

test('a long list keeps its column names in view from a tablet up', async () => {
  const css = await read('src/styles/theme.css')
  const block = css.slice(css.indexOf('@media screen and (min-width: 640px) {'))
  assert.match(block, /\.overflow-x-auto:has\(> table\[data-list-cards\]\) \{\s*max-height: calc\(100dvh - 120px\);/)
  assert.match(block, /> thead > tr > th \{\s*position: sticky;\s*top: 0;\s*z-index: 30;/)
  // Above the sticky first and Actions cells, below an open row menu's cell (50).
  const menu = await read('src/components/ui/listLayout.tsx')
  assert.match(menu, /cell\.style\.zIndex = "50"/)
})

test('cut-off text in a list shows in full on hover', async () => {
  const table = await read('src/components/ui/workbenchTable.ts')
  assert.match(table, /tables\.forEach\(labelListTable\);\s*titleTruncatedText\(element\);/)
  assert.match(table, /if \(node\.title && node\.dataset\.autoTitle !== "true"\) continue;/)
})

test("Today's tiles are drawn like the cards on the list pages", async () => {
  const page = await read('src/modules/overview/Page.tsx')
  assert.match(page, /icon: ListChecks, color: A\.blue/)
  assert.match(page, /icon: AlarmClock, color: A\.red/)
  // Count first, then its name, as ActionableMetricCard reads.
  assert.match(page, /<div className=\{TILE_VALUE\}>\{tile\.value\}<\/div>\s*<div className="fc-label mt-0\.5"/)
})

test('a page that is not available here always offers a way on', async () => {
  const app = await read('src/app/FlowChainApp.tsx')
  // Frozen and turned-off parts lead to their module's first page, or Today.
  // Menus & modules cannot turn a feature on yet, so it is not offered.
  assert.match(app, /const moduleHome = home && home\.id !== route\.id && canOpenRoute\(home\.id\) \? home : null;/)
  assert.doesNotMatch(app, /blocked-route-settings/)
  assert.match(app, /"This part of FlowChain is not available\."[^\n]*\n\s*\{blockedRouteLinks\(activeRoute\)\}/)
  assert.match(app, /"You have access, but this feature is turned off for this workspace\."[^\n]*\n\s*\{blockedRouteLinks\(activeRoute\)\}/)
})

test('shared list and form buttons are 36 px tall on a phone, and one result reads as one', async () => {
  const list = await read('src/components/ui/listLayout.tsx')
  for (const tone of ['bg-slate-50', 'bg-blue-50', 'bg-blue-600']) assert.ok(list.includes(`inline-flex h-8 items-center gap-1.5 rounded-lg ${tone} px-3 max-sm:h-9`), tone)
  const form = await read('src/components/ui/formLayout.tsx')
  assert.ok(form.includes('text-blue-600 hover:underline max-sm:min-h-9'), 'back link')
  assert.ok(form.includes('disabled:opacity-40 max-sm:flex max-sm:h-9 max-sm:w-9'), 'line remove button')
  const note = await read('src/app/PublicDataNote.tsx')
  assert.ok(note.includes('hover:underline max-sm:min-h-9'), 'what is assumed')
  assert.ok(note.includes('hover:text-slate-800 max-sm:flex max-sm:h-9 max-sm:w-9'), 'hide')
  const pager = await read('src/modules/procurement/listPaging.tsx')
  assert.ok(pager.includes('pageOne: ["Page 1 of 1 · 1 result", "第 1 / 1 页 · 共 1 条"]'))
  assert.ok(pager.includes('{total === 1 ? say("pageOne") :'))
})

test("a customer's issued invoices read where their payment stands, as on the invoice page", async () => {
  const page = await read('src/components/business/CustomerRelatedRecords.tsx')
  assert.ok(page.includes('const shownInvoiceStatus = (invoice: { status: string; paymentStatus?: string | null }) => (invoice.status === "issued" && invoice.paymentStatus ? invoice.paymentStatus : invoice.status);'))
  assert.ok(page.includes('settled: ["Paid", "已结清"],'))
  assert.ok(page.includes('label={pair(INVOICE_STATUS[shownInvoiceStatus(invoice)], shownInvoiceStatus(invoice))}'))
})

test("an order's invoices read where their payment stands too", async () => {
  const read_ = await read('server/domain/outbound-workbench-read-service.mjs')
  assert.ok(read_.includes('paymentStatus: customerInvoicePaymentStatus(invoice.status, invoice.receivableObligation?.status),'))
  assert.ok(read_.includes('select: { id: true, invoiceNumber: true, status: true, shipmentId: true, receivableObligation: { select: { status: true } } },'))
  const page = await read('src/modules/sales/OutboundWorkbench.tsx')
  assert.ok(page.includes('const code = invoice.status === "issued" && invoice.paymentStatus ? invoice.paymentStatus : invoice.status;'))
  assert.ok(page.includes('<span className="text-xs text-slate-500">{invoiceStatus(invoice)}</span>'))
})

test('close buttons and a record page trail are 36 px tall on a phone', async () => {
  assert.match(await read('src/components/ui/ConfirmDialog.tsx'), /aria-label=\{say\("close"\)\}[^>]*max-sm:h-9 max-sm:w-9/)
  assert.match(await read('src/components/ui/index.tsx'), /aria-label=\{copy\("关闭"\)\}[^>]*max-sm:h-9 max-sm:w-9/)
  assert.match(await read('src/components/navigation/AppBreadcrumb.tsx'), /rounded max-sm:min-h-9/)
})
