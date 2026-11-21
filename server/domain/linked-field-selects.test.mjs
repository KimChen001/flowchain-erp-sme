import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { listTaxCodes } from './master-data.mjs'
import { linkedFieldOptions, paymentTermOptions, taxCodeOptions, warehouseOptions } from '../../src/modules/master-data/linkedFieldOptions.ts'

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

test('tax codes are offered from the response the server actually sends: { id: the code, label: its name }', () => {
  // The database mapping (db-master-data-repository mapTaxCode) and the JSON
  // one (master-data listTaxCodes) both answer { id, label, rate, status }.
  const response = listTaxCodes({ taxCodes: [
    { code: 'VAT20', name: 'Standard rate', rate: 20, status: 'active' },
    { code: 'VAT0', name: 'Zero rate', rate: 0, status: 'active' },
    { code: 'OLD', name: 'Retired', rate: 5, status: 'inactive' },
  ] })
  assert.deepEqual(response.map((row) => Object.keys(row).sort()), response.map(() => ['id', 'label', 'rate', 'sourceType', 'status']))
  assert.deepEqual(taxCodeOptions(response), [{ value: 'VAT20', label: 'VAT20 · Standard rate' }, { value: 'VAT0', label: 'VAT0 · Zero rate' }])
  // An existing item's code is among them, not "(not in the list)".
  assert.equal(linkedFieldOptions(taxCodeOptions(response), 'VAT20').some((option) => option.unknown), false)
  // The database mapping's shape, as mapTaxCode writes it.
  assert.deepEqual(taxCodeOptions([{ id: 'GST', label: 'GST', rate: 10, status: 'active' }]), [{ value: 'GST', label: 'GST' }])
})

test('warehouses by id with code and name, active only; payment terms by code', () => {
  assert.deepEqual(warehouseOptions([
    { id: 'WH-1', code: 'MAIN', name: 'Main warehouse', status: 'active' },
    { id: 'WH-9', code: 'OLD', name: 'Closed', status: 'inactive' },
    { id: 'WH-3', code: '', name: 'No code' },
  ]), [{ value: 'WH-1', label: 'MAIN · Main warehouse' }, { value: 'WH-3', label: 'No code' }])
  assert.deepEqual(paymentTermOptions([{ id: 'PT-1', code: 'NET30', label: 'Net 30 days' }, { id: 'NET60' }, { id: '' }]), [{ value: 'NET30', label: 'Net 30 days (NET30)' }, { value: 'NET60', label: 'NET60' }])
})

test('the forms use those options, typing only when a list could not load', () => {
  const item = read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(item, /\.then\(\(result\) => setWarehouseOptions\(warehouseOptionsOf\(result\.warehouses\)\)\)/)
  assert.match(item, /\.then\(\(result\) => setTaxCodeOptions\(taxCodeOptionsOf\(result\.taxCodes\)\)\)/)
  assert.match(item, /const linked = key === "defaultWarehouseId" \? warehouseOptions : key === "taxCodeId" \? taxCodeOptions : null;/)
  assert.match(item, /\.catch\(\(\) => setWarehouseOptions\(null\)\)/)
  const customer = read('src/modules/master-data/StandardMasterTables.tsx')
  assert.match(customer, /key === "currency" \? orderedCurrencyCodes\(workspaceCurrency, null, form\.currency\)/)
  assert.match(customer, /\.then\(\(result\) => setTermOptions\(paymentTermOptions\(result\.options\)\)\)/)
  assert.match(read('src/modules/master-data/masterDataFormat.ts'), /"not in the list": "不在列表中",/)
})
