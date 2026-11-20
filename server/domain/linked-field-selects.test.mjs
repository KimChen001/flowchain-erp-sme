import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { linkedFieldOptions } from '../../src/modules/master-data/linkedFieldOptions.ts'

// Product review 2026-11-20, item 28: the item form typed its default
// warehouse (the server wants the warehouse's id: "MAIN" failed with "Choose a
// warehouse of this workspace") and its tax code; the customer form typed its
// currency and payment terms (a term typed as "30 days" matched none, so the
// invoice's due date stayed blank). They are now chosen.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const WAREHOUSES = [{ value: 'WH-1', label: 'MAIN · Main warehouse' }, { value: 'WH-2', label: 'EAST · East DC' }]

test('a stored value stays offered, marked, when it is not among the options', () => {
  assert.deepEqual(linkedFieldOptions(WAREHOUSES, 'WH-2'), WAREHOUSES)
  assert.deepEqual(linkedFieldOptions(WAREHOUSES, ''), WAREHOUSES)
  assert.deepEqual(linkedFieldOptions(WAREHOUSES, null), WAREHOUSES)
  // An inactive warehouse, or a term typed before: kept, first, marked.
  assert.deepEqual(linkedFieldOptions(WAREHOUSES, 'WH-OLD'), [{ value: 'WH-OLD', label: 'WH-OLD', unknown: true }, ...WAREHOUSES])
  assert.deepEqual(linkedFieldOptions([], ' 30 days '), [{ value: '30 days', label: '30 days', unknown: true }])
  // An option without a value is never offered.
  assert.deepEqual(linkedFieldOptions([{ value: '', label: 'blank' }, ...WAREHOUSES], 'WH-1'), WAREHOUSES)
})

test('the item form chooses its default warehouse by id and its tax code, typing them only when the lists could not load', () => {
  const item = read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(item, /apiJson<.+?>\("\/api\/master-data\/warehouses"\)/)
  assert.match(item, /\.map\(\(row\) => \(\{ value: row\.id, label:/)
  assert.match(item, /apiJson<.+?>\("\/api\/master-data\/tax-codes"\)/)
  assert.match(item, /const linked = key === "defaultWarehouseId" \? warehouseOptions : key === "taxCodeId" \? taxCodeOptions : null;/)
  assert.match(item, /\.catch\(\(\) => setWarehouseOptions\(null\)\)/)
  assert.match(item, /data-testid=\{`item-field-\$\{key\}`\}/)
})

test('the customer form chooses its currency and payment terms', () => {
  const customer = read('src/modules/master-data/StandardMasterTables.tsx')
  assert.match(customer, /key === "currency" \? orderedCurrencyCodes\(workspaceCurrency, null, form\.currency\)/)
  assert.match(customer, /: key === "paymentTerms" \? termOptions/)
  assert.match(customer, /apiJson<.+?>\("\/api\/master-data\/payment-terms\/select"\)/)
  // The stored value is the term's code, which the invoice's due date reads by code or name.
  assert.match(customer, /value: option\.code \|\| option\.id/)
  assert.match(read('src/modules/master-data/masterDataFormat.ts'), /"not in the list": "不在列表中",/)
})
