import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { priceHistoryText } from '../../src/modules/procurement/priceHistoryText.ts'

// What a walk of the purchasing pages on the public-data walkthrough found too
// long or misleading (11/10), and what the pages now do instead.

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('the price history beside a row is one line, naming the supplier only when it is another one', async () => {
  assert.equal(priceHistoryText('en-US', 'lastPoShort', { price: '$0.98', unit: 'pcs', po: 'PO-202610-0015', date: 'Oct 19, 2026' }), 'Last PO $0.98 / pcs · PO-202610-0015 · Oct 19, 2026')
  assert.equal(priceHistoryText('zh-CN', 'lastPoShort', { price: '$0.98', unit: '件', po: 'PO-202610-0015', date: 'Oct 19, 2026' }), '上次采购 $0.98 / 件 · PO-202610-0015 · Oct 19, 2026')
  const facts = await read('src/modules/procurement/PriceHistoryFacts.tsx')
  // Supplier-scoped history (a supplier's page) or the row's own supplier: no name.
  assert.match(facts, /const otherSupplier = !history\.supplierId && \(!supplierId \|\| latest\.supplierId !== supplierId\)/)
  // The average only when it differs from the last price.
  assert.match(facts, /Number\(averagePrice\) !== Number\(latest\.unitPrice\)/)
  const purchasing = await read('src/modules/purchasing/Page.tsx')
  assert.match(purchasing, /excludesThisOrder compact supplierId=\{selectedPO\.supplierId\}/)
})

test('a long order with one unchanged promised date reads as one sentence until opened', async () => {
  const promises = await read('src/modules/purchasing/components/PurchaseOrderPromiseDates.tsx')
  assert.match(promises, /const FOLD_AFTER = 3/)
  assert.match(promises, /data-testid="po-promise-summary"/)
  assert.match(promises, /aria-expanded=\{!folded\}/)
  // A revision or a moved date shows the table again.
  assert.match(promises, /!po\.promiseRevisions\.length/)
})

test('a PO with nothing received or invoiced does not list a match row per line', async () => {
  const purchasing = await read('src/modules/purchasing/Page.tsx')
  assert.match(purchasing, /const nothingToMatch = grnRows\.length === 0 && invoiceRows\.length === 0/)
  assert.match(purchasing, /data-match-state="nothing-yet"/)
  // A line not yet received and not invoiced is waiting, in gray, not the
  // orange of a receipt missing behind an invoice.
  assert.match(purchasing, /row\.status === "缺少收货" && row\.receivedQty === 0 && !invoiced\(row\)/)
  // The four progress steps fit a phone without scrolling sideways.
  const progress = purchasing.slice(purchasing.indexOf('function PoProgress'), purchasing.indexOf('type EvidenceColumn'))
  assert.doesNotMatch(progress, /min-w-\[640px\]/)
  // The list counts the rows on the page, out of the matching total.
  assert.match(purchasing, /total=\{filtered\.length\} shown=\{paged\.pageRows\.length\}/)
})

test('a receipt timeline reads one entry per kind of change, not one per line', async () => {
  const receipt = await read('src/modules/receiving/ReceivingPostingWorkbench.tsx')
  assert.match(receipt, /const EVENT_GROUP_AFTER = 3/)
  // Grouped by event, movement kind, moment and kind of fact; only runs next to each other.
  assert.match(receipt, /event\.event === "inventory_movement_created" \? event\.label\.split\(" · "\)\[0\] : "", stamp\(event\.occurredAt\), eventKind\(event\)/)
  assert.match(receipt, /data-testid="evidence-event-group-toggle"/)
  assert.match(receipt, /On hand updated for \$\{count\} items/)
})

test('counts on list cards and metric cards use the workspace digit grouping', async () => {
  const list = await read('src/components/ui/listLayout.tsx')
  assert.match(list, /typeof values\[name\] === "number" \? formatNumber\(values\[name\] as number\)/)
  const metric = await read('src/components/cards/ActionableMetricCard.tsx')
  assert.match(metric, /\/\^-\?\\d\{4,\}\$\/\.test\(value\) \? formatNumber\(Number\(value\)\) : value/)
})
