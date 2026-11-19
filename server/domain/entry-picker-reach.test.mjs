import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

// Design audit batch A4. The reach itself (the 201st item, the 101st order,
// the 2,001st customer) is tested against PostgreSQL in
// tests/postgres/entry-picker-reach.test.mjs; these pin the forms that use it.

test('the order form searches items on the server and keeps a draft\'s own items (L4-01)', async () => {
  const service = await read('server/domain/sales-order-workbench-service.mjs')
  assert.doesNotMatch(service, /take: 200\b/)
  assert.match(service, /OR: \[\{ sku: \{ contains: itemQuery, mode: 'insensitive' \} \}, \{ name: \{ contains: itemQuery, mode: 'insensitive' \} \}\]/)
  const picker = await read('src/modules/sales/ItemPicker.tsx')
  assert.match(picker, /new URLSearchParams\(\{ view: "items", \.\.\.\(text \? \{ itemQuery: text \} : \{\}\) \}\)/)
  assert.match(picker, /role="combobox"/)
  const form = await read('src/modules/sales/OutboundWorkbench.tsx')
  assert.match(form, /<ItemPicker\s/)
  assert.doesNotMatch(form, /<option value="">\{say\("Choose an item", "选择物料"\)\}<\/option>/)
  assert.match(form, /order-entry-data\?\$\{new URLSearchParams\(\{ itemIds: data\.lines\.map/)
})

test('the supplier invoice form reads the order or receipt it was opened from, and a chosen supplier\'s own documents (L2-12)', async () => {
  const form = await read('src/modules/finance/SupplierInvoiceScreens.tsx')
  assert.match(form, /for \(const key of \["po", "receipt"\]\) if \(opened\.get\(key\)\)/)
  assert.match(form, /loadSupplierDocuments\(event\.target\.value\)/)
  const route = await read('server/routes/operational-finance.routes.mjs')
  assert.match(route, /read\.entryData\(ctx, query\(ctx\.url\)\)/)
})

test('customers are found by id, never by scanning the first 2,000 rows (L4-19, V-B-03)', async () => {
  for (const path of ['server/domain/master-data-commands.mjs', 'server/domain/operational-finance-o2c-read-service.mjs', 'server/domain/sales-order-workbench-service.mjs']) {
    assert.doesNotMatch(await read(path), /take: 2000\b/, path)
  }
  assert.match(await read('server/domain/master-data-commands.mjs'), /OR: \[\{ payload: \{ path: \['id'\], equals: key \} \}, \{ id: key \}\]/)
})
