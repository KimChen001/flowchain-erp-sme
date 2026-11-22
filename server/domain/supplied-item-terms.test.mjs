import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { itemSupplierInputIssues } from './master-data-commands.mjs'
import { numberSeparators, parseTermNumber, rebaseTermsForm, suppliedItemTermsChanges, suppliedItemTermsProblems } from '../../src/modules/srm/suppliedItemTerms.ts'

// Product review 2026-11-20, item 7: a supplied item's price, lead time and
// minimum order could only be set when the item was first added to the
// supplier. They are now edited on the row, through the existing PATCH.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the supplied items add row labels its item and price, and keeps the price history under the row', () => {
  const page = read('src/modules/srm/Page.tsx')
  assert.match(page, /<Field label=\{copy\("Item"\)\}>\s*<select\s+aria-label=\{copy\("Select item"\)\}/)
  assert.match(page, /<Field label=\{copy\("Reference price"\)\}>\s*<input\s+aria-label=\{copy\("参考价格"\)\}/)
  assert.ok(page.includes('{writes.items && relationFormHistoryKey && <div className="mt-2"><PriceHistoryFacts '))
  assert.match(read('src/modules/srm/supplierCopy.ts'), /'Item': '物料'/)
})
const EN = { decimal: '.', group: ',' }
const DE = { decimal: ',', group: '.' }
const TERMS = { leadTimeDays: 14, minimumOrderQuantity: 50, referencePrice: 2.75 }
const formOf = (terms) => ({ leadTimeDays: terms.leadTimeDays === null ? '' : String(terms.leadTimeDays), minimumOrderQuantity: terms.minimumOrderQuantity === null ? '' : String(terms.minimumOrderQuantity), referencePrice: terms.referencePrice === null ? '' : String(terms.referencePrice) })

test('a typed number is read in the locale\'s separators; anything else is refused, never read as blank', () => {
  assert.deepEqual(numberSeparators('en-US'), EN)
  assert.deepEqual(numberSeparators('de-DE'), DE)
  assert.equal(parseTermNumber('1,000', EN), 1000)
  assert.equal(parseTermNumber(' 2.5 ', EN), 2.5)
  assert.equal(parseTermNumber('', EN), null)
  assert.equal(parseTermNumber('2,5', DE), 2.5)
  assert.equal(parseTermNumber('1.000', DE), 1000)
  assert.equal(parseTermNumber('1.000,25', DE), 1000.25)
  // What a number field would have turned into "" and cleared.
  for (const raw of ['1e', 'abc', '-3', '2.5.1', '1,2,3.4.5']) assert.ok(Number.isNaN(parseTermNumber(raw, EN)), raw)
})

test('only changed fields are sent, and a hidden price never is', () => {
  // Lead time changed: only the lead time goes.
  assert.deepEqual(suppliedItemTermsChanges({ ...formOf(TERMS), leadTimeDays: '21' }, TERMS, { separators: EN }), { leadTimeDays: 21 })
  // Nothing changed: nothing goes.
  assert.deepEqual(suppliedItemTermsChanges(formOf(TERMS), TERMS, { separators: EN }), {})
  // Cleared on purpose: sent as not recorded.
  assert.deepEqual(suppliedItemTermsChanges({ ...formOf(TERMS), minimumOrderQuantity: '' }, TERMS, { separators: EN }), { minimumOrderQuantity: null })
  // A reader who may not see prices gets null for the price; saving the lead
  // time must not send that null back and clear the stored price (#412 review).
  const masked = { ...TERMS, referencePrice: null }
  assert.deepEqual(suppliedItemTermsChanges({ ...formOf(masked), leadTimeDays: '21' }, masked, { priceHidden: true, separators: EN }), { leadTimeDays: 21 })
  assert.deepEqual(suppliedItemTermsChanges({ ...formOf(masked), referencePrice: '9.99' }, masked, { priceHidden: true, separators: EN }), {})
})

test('the page refuses what the server would, before sending; a price of zero is not a price', () => {
  assert.deepEqual(suppliedItemTermsProblems({ leadTimeDays: 14, minimumOrderQuantity: 50, referencePrice: 2.75 }), [])
  assert.deepEqual(suppliedItemTermsProblems({ leadTimeDays: null, minimumOrderQuantity: null, referencePrice: null }), [])
  assert.deepEqual(suppliedItemTermsProblems({ leadTimeDays: 2.5, minimumOrderQuantity: 0, referencePrice: 0 }), ['wholeDays', 'positive', 'priceAboveZero'])
  assert.deepEqual(suppliedItemTermsProblems({ leadTimeDays: Number.NaN }), ['wholeDays'])
  // The server agrees on the refusals, stores a blank as null, and a price of 0 as null too.
  const supplier = { status: 'active', metadata: {} }
  const old = { payload: {} }
  assert.deepEqual(itemSupplierInputIssues({ leadTimeDays: 2.5, minimumOrderQuantity: 0 }, { old, supplier }).issues.map((issue) => issue.field), ['leadTimeDays', 'minimumOrderQuantity'])
  assert.equal(itemSupplierInputIssues({ referencePrice: 0 }, { old, supplier }).values.referencePrice, null)
  assert.deepEqual(itemSupplierInputIssues({ leadTimeDays: 21 }, { old, supplier }).values, { leadTimeDays: 21, minimumOrderQuantity: undefined, referencePrice: undefined, currency: undefined })
})

test('an open form follows a reread for the fields not touched, and keeps what was typed', () => {
  const typed = { ...formOf(TERMS), leadTimeDays: '30' }
  const latest = { leadTimeDays: 10, minimumOrderQuantity: 60, referencePrice: 3 }
  assert.deepEqual(rebaseTermsForm(typed, new Set(['leadTimeDays']), latest), { leadTimeDays: '30', minimumOrderQuantity: '60', referencePrice: '3' })
  // Saving then sends only the typed field against the latest terms.
  assert.deepEqual(suppliedItemTermsChanges(rebaseTermsForm(typed, new Set(['leadTimeDays']), latest), latest, { separators: EN }), { leadTimeDays: 30 })
})

test('the supplier page passes the hidden price, rereads on a version conflict, and saves through the PATCH', () => {
  const page = read('src/modules/srm/Page.tsx')
  assert.match(page, /\{writes\.items && editingTerms === r\.relationshipId && \(\s*<SuppliedItemTermsRow/)
  assert.match(page, /priceHidden=\{\(r\.restrictedFields \|\| \[\]\)\.includes\("referencePrice"\)\}/)
  assert.match(page, /onSave=\{\(changes\) => updateRelationship\(r, changes\)\}/)
  assert.match(page, /if \(e instanceof ApiError && e\.code === "VERSION_CONFLICT"\) await openDetail\(selected\.id\);/)
  assert.match(page, /`\/api\/master-data\/items\/\$\{relationship\.itemId\}\/suppliers\/\$\{relationship\.relationshipId\}`,\s*"PATCH",\s*\{ \.\.\.patch, expectedVersion: relationship\.version \}/)
  const row = read('src/modules/srm/SuppliedItemTermsRow.tsx')
  // Text fields, read by the form, so a value the browser cannot read is refused rather than cleared.
  assert.match(row, /type="text"\s*inputMode="decimal"/)
  assert.doesNotMatch(row, /type="number"/)
  for (const key of ['title', 'leadTime', 'moq', 'price', 'priceNoCurrency', 'priceHidden', 'blank', 'nothingChanged', 'save', 'saving', 'cancel', 'wholeDays', 'positive', 'priceAboveZero']) {
    const pair = row.match(new RegExp(`  ${key}: \\["([^"]+)", "([^"]+)"\\]`))
    assert.ok(pair, key)
    assert.match(pair[2], /[一-鿿]/, `${key} has its Chinese`)
  }
})
