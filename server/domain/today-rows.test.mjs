import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { firstRowsByKind, reorderRequestHref, rowsPerKind } from '../../src/modules/overview/todayRows.ts'

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

// Today on the UCI walkthrough: a long run of overdue receivables dated
// before the items to reorder.
const rows = [
  { id: 'po:1', kind: 'purchase_order_overdue', date: '2026-11-01' },
  ...Array.from({ length: 8 }, (_, n) => ({ id: `ar:${n}`, kind: 'receivable_overdue', date: '2026-11-02' })),
  { id: 'po:2', kind: 'purchase_order_overdue', date: '2026-11-03' },
  ...Array.from({ length: 4 }, (_, n) => ({ id: `re:${n}`, kind: 'reorder_now', date: '2026-11-11' })),
]

test('the first rows hold the earliest row of every kind, then the next earliest, in list order', () => {
  const first = firstRowsByKind(rows, 5)
  assert.deepEqual(first.map((row) => row.id), ['po:1', 'ar:0', 'ar:1', 'ar:2', 're:0'])
  // More kinds than rows: every kind still gets its row.
  const many = [{ id: 'a', kind: 'a' }, { id: 'b', kind: 'b' }, { id: 'c', kind: 'c' }]
  assert.deepEqual(firstRowsByKind(many, 2).map((row) => row.id), ['a', 'b', 'c'])
  // Fewer rows than the count: all of them.
  assert.equal(firstRowsByKind(rows.slice(0, 3), 5).length, 3)
  assert.deepEqual([...rowsPerKind(rows)], [['purchase_order_overdue', 2], ['receivable_overdue', 8], ['reorder_now', 4]])
})

test('a reorder row opens the purchase request the reorder list prefills for that item', () => {
  const href = reorderRequestHref({ itemId: 'UCI-ITEM-21497', supplierId: 'SUP-7', quantity: 35 }, 'Reorder list: stock position 280 pcs against reorder point 315 pcs; order by 2026-11-11.')
  const url = new URL(href, 'http://local')
  assert.equal(url.pathname, '/app/procurement/requests')
  assert.equal(url.searchParams.get('itemId'), 'UCI-ITEM-21497')
  assert.equal(url.searchParams.get('origin'), 'reorder_list')
  assert.equal(url.searchParams.get('quantity'), '35')
  assert.equal(url.searchParams.get('suppliers'), 'SUP-7')
  assert.match(url.searchParams.get('reason'), /^Reorder list: stock position 280 pcs/)
  // No shortfall in the request's unit: the quantity is left to enter.
  const empty = new URL(reorderRequestHref({ itemId: 'I', supplierId: null, quantity: null }, 'r'), 'http://local')
  assert.equal(empty.searchParams.has('quantity'), false)
  assert.equal(empty.searchParams.has('suppliers'), false)
  // A shortfall raised to the supplier's minimum says so and hands over the shortfall.
  const raised = new URL(reorderRequestHref({ itemId: 'I', supplierId: 'S', quantity: 110, raisedToMinimum: true }, 'r', 35), 'http://local')
  assert.equal(raised.searchParams.get('quantity'), '110')
  assert.equal(raised.searchParams.get('quantityFrom'), 'supplier_minimum')
  assert.equal(raised.searchParams.get('shortfall'), '35')
  assert.equal(href.includes('quantityFrom'), false)
  // The same parameters the reorder list's own button sends.
  const list = read('src/modules/inventory/ReorderListPage.tsx')
  assert.match(list, /itemId: row\.purchaseRequest\.itemId, origin: "reorder_list", reason/)
})

test('Today shows every kind in its first rows, links a reorder row to its request and asks for the overview once', () => {
  const page = read('src/modules/overview/Page.tsx')
  assert.match(page, /firstRowsByKind\(shown, COLLAPSED\)/)
  assert.match(page, /data-testid="today-kind-all"/)
  assert.match(page, /data-testid="today-reorder-request"/)
  assert.match(page, /reorderListText\(t\.language, "reason"/)
  // One request at a time, shared by a page drawn twice (the /app/overview redirect).
  assert.match(page, /if \(!overviewRequest\) overviewRequest = apiJson<HomeOverview>\("\/api\/home\/overview"\)\.finally/)
  assert.doesNotMatch(page, /setOverview\(await apiJson/)
  // On a phone the three tiles share one short row, notes hidden.
  assert.match(page, /className="grid grid-cols-3 gap-2 sm:gap-4" data-testid="today-tiles"/)
  const copy = read('src/modules/overview/todayCopy.ts')
  assert.match(copy, /position: "库存位置（含在途）\{position\}，再订货点 \{reorderPoint\}"/)
  assert.doesNotMatch(copy, /库存头寸/)
  assert.match(copy, /createRequest: "Create purchase request"/)
})

test('Today is named as the sidebar names it, and /app/today opens it', () => {
  const registry = read('src/app/routeRegistry.tsx')
  assert.match(registry, /id: "overview:risks",\s+path: "\/app\/overview\/risks",\s+moduleId: "overview",\s+moduleLabel: "首页",\s+label: "今日",/)
  const app = read('src/app/FlowChainApp.tsx')
  assert.match(app, /\/\^\\\/app\\\/today\\\/\?\$\/\.test\(location\.pathname\)/)
  assert.match(app, /routerNavigate\(`\/app\/overview\/risks\$\{location\.search\}\$\{location\.hash\}`, \{ replace: true \}\)/)
})

test('the assistant button is a 48 px round icon on a phone, still named', () => {
  const panel = read('src/modules/ai-assistant/Panel.tsx')
  const button = panel.slice(panel.indexOf('data-testid="ai-assistant-toggle"') - 200, panel.indexOf('data-testid="ai-assistant-toggle"') + 900)
  assert.match(button, /h-12 w-12 items-center justify-center rounded-full/)
  assert.match(button, /sm:w-auto/)
  assert.match(button, /aria-label=\{language === "zh-CN" \? "展开 AI 助手" : "Open AI assistant"\}/)
  assert.match(button, /<span className="sr-only sm:not-sr-only">/)
})
