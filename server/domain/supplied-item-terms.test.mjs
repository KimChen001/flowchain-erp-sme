import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { itemSupplierInputIssues } from './master-data-commands.mjs'
import { suppliedItemTermsPatch, suppliedItemTermsProblems } from '../../src/modules/srm/suppliedItemTerms.ts'

// Product review 2026-11-20, item 7: a supplied item's price, lead time and
// minimum order could only be set when the item was first added to the
// supplier. They are now edited on the row, through the existing PATCH.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('a blank field is sent as not recorded, a filled one as its number', () => {
  assert.deepEqual(suppliedItemTermsPatch({ leadTimeDays: '14', minimumOrderQuantity: '', referencePrice: ' 2.75 ' }), { leadTimeDays: 14, minimumOrderQuantity: null, referencePrice: 2.75 })
  assert.deepEqual(suppliedItemTermsPatch({ leadTimeDays: '', minimumOrderQuantity: '', referencePrice: '' }), { leadTimeDays: null, minimumOrderQuantity: null, referencePrice: null })
})

test('the page refuses what the server would, before sending', () => {
  assert.deepEqual(suppliedItemTermsProblems({ leadTimeDays: 14, minimumOrderQuantity: 50, referencePrice: 2.75 }), [])
  assert.deepEqual(suppliedItemTermsProblems({ leadTimeDays: null, minimumOrderQuantity: null, referencePrice: null }), [])
  assert.deepEqual(suppliedItemTermsProblems({ leadTimeDays: 2.5, minimumOrderQuantity: 0, referencePrice: -1 }), ['wholeDays', 'positive', 'zeroOrMore'])
  // The server's own rules agree: the same values are refused there, and blanks stored as not recorded.
  const supplier = { status: 'active', metadata: {} }
  const old = { payload: {} }
  assert.deepEqual(itemSupplierInputIssues({ leadTimeDays: 2.5, minimumOrderQuantity: 0, referencePrice: -1 }, { old, supplier }).issues.map((issue) => issue.field), ['leadTimeDays', 'minimumOrderQuantity', 'referencePrice'])
  assert.deepEqual(itemSupplierInputIssues({ leadTimeDays: null, minimumOrderQuantity: null, referencePrice: null }, { old, supplier }).values, { leadTimeDays: null, minimumOrderQuantity: null, referencePrice: null, currency: undefined })
  assert.deepEqual(itemSupplierInputIssues({ leadTimeDays: 14, minimumOrderQuantity: 50, referencePrice: 2.75 }, { old, supplier }).values, { leadTimeDays: 14, minimumOrderQuantity: 50, referencePrice: 2.75, currency: undefined })
})

test('the supplier page edits a row\'s terms through the PATCH, for people who may change items', () => {
  const page = read('src/modules/srm/Page.tsx')
  assert.match(page, /\{writes\.items && editingTerms === r\.relationshipId && \(\s*<SuppliedItemTermsRow/)
  assert.match(page, /onSave=\{\(patch\) => updateRelationship\(r, patch\)\}/)
  assert.match(page, /`\/api\/master-data\/items\/\$\{relationship\.itemId\}\/suppliers\/\$\{relationship\.relationshipId\}`,\s*"PATCH",\s*\{ \.\.\.patch, expectedVersion: relationship\.version \}/)
  const row = read('src/modules/srm/SuppliedItemTermsRow.tsx')
  for (const key of ['title', 'leadTime', 'moq', 'price', 'priceNoCurrency', 'blank', 'save', 'saving', 'cancel', 'wholeDays', 'positive', 'zeroOrMore']) {
    const pair = row.match(new RegExp(`  ${key}: \\["([^"]+)", "([^"]+)"\\]`))
    assert.ok(pair, key)
    assert.match(pair[2], /[一-鿿]/, `${key} has its Chinese`)
  }
})
