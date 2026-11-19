import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

// UI review 10: a fresh page load showed "0" before the data arrived
// (Today's tiles, "0 updated today", "0 items, 0 shown", "0 links", "0 suppliers",
// "0 issues"). Each count now reads "—" until its first answer is in.
test('counts read "—" until their first answer arrives, never a 0 that is not true yet', async () => {
  const today = await read('src/modules/overview/Page.tsx')
  assert.match(today, /\{overview \? tile\.value : "—"\}/)
  assert.match(today, /\{overview \? t\("changesCount", \{ n: overview\.todayChanges \?\? 0 \}\) : "—"\}/)

  const items = await read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(items, /description=\{loaded \? copy\("\{count\} active"/)
  assert.match(items, /\{loaded \? copy\(items\.length === 1 \? "1 item, \{shown\} shown"/)

  const prices = await read('src/modules/master-data/ItemSupplierPricesPage.tsx')
  assert.match(prices, /setTotal\(page\.total\);\s+setReady\(true\);/)
  assert.match(prices, /\{ready \? copy\(total === 1 \? "1 link, \{shown\} shown"/)

  const evaluation = await read('src/modules/srm/SupplierEvaluationPage.tsx')
  assert.match(evaluation, /setCounts\(data\.counts \|\| null\);\s+setReady\(true\);/)
  assert.match(evaluation, /\{ready \? t\(total === 1 \? "1 supplier, \{shown\} shown"/)

  const risks = await read('src/modules/srm/SupplierRisksPage.tsx')
  assert.match(risks, /\{data \? t\(issues\.length === 1 \? "1 issue, \{shown\} shown"/)
})

// M5's empty supplier invoice, payable and receivable pages looked broken
// because the note never said M5 has none of them.
test('the M5 note says it has no invoices, payables or payments, in both languages', async () => {
  const note = await read('src/app/PublicDataNote.tsx')
  // A list item of the note's prices and money group since design audit B7.
  assert.match(note, /note\.dataset === "m5" && <li data-testid="public-data-note-m5-no-invoices">\{t\("publicData\.m5NoInvoices"\)\}<\/li>/)
  const i18n = await read('src/i18n/I18n.tsx')
  assert.match(i18n, /"publicData\.m5NoInvoices": "M5 sales are point of sale, so there are no customer invoices or receivables\./)
  assert.match(i18n, /"publicData\.m5NoInvoices": "M5 是门店零售：/)
})
