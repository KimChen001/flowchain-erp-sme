import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20, item 30 (part 2): sales orders, suppliers and
// customers had no export, while the other lists do.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('sales orders export every order the filters match, page after page, as the shipments export does', () => {
  const page = read('src/modules/sales/OutboundWorkbench.tsx')
  assert.match(page, /const \{ rows: all \} = await fetchAllListRows<Order>\("\/api\/sales\/orders", filters, \{ itemsKey: "orders" \}\);/)
  assert.match(page, /filters\.delete\("page"\);/)
  assert.match(page, /await exportRowsToCsv\("sales-orders-export\.csv", all\.map\(/)
  assert.match(page, /<ExportButton onClick=\{\(\) => void exportOrders\(\)\} \/>/)
})

test('suppliers export the rows the filters show, without tax or bank details', () => {
  const page = read('src/modules/srm/Page.tsx')
  assert.match(page, /const exportSuppliers = \(\) => void exportRowsToCsv\("suppliers-export\.csv", sortedRows\.map\(/)
  assert.match(page, /<ExportButton onClick=\{exportSuppliers\} \/>/)
  const block = page.slice(page.indexOf('const exportSuppliers'), page.indexOf('})));', page.indexOf('const exportSuppliers')))
  assert.doesNotMatch(block, /bank|taxIdentification|creditCode/i)
  // Every header has its Chinese in the supplier copy.
  const copy = read('src/modules/srm/supplierCopy.ts')
  for (const header of [...block.matchAll(/\[copy\("([^"]+)"\)\]/g)].map((match) => match[1])) assert.ok(copy.includes(`'${header}':`), header)
})

test('customers export through the master-data export, with the list\'s filters', () => {
  const page = read('src/modules/master-data/Page.tsx')
  assert.match(page, /const canExport = tab === "customers" \|\| tab === "warehouses"/)
  assert.match(page, /exportMasterDataCsv\(tab, \{ customers: filteredCustomers,/)
  const exporter = read('src/modules/master-data/export.ts')
  assert.match(exporter, /customers: \{\s*filename: "master-data-customers-export\.csv",/)
  const zh = read('src/modules/master-data/masterDataFormat.ts')
  for (const header of ['Customer code', 'Customer name', 'Currency', 'Contact', 'Email', 'Phone', 'Address', 'Country', 'Payment terms', 'Credit status', 'Status']) {
    assert.ok(zh.includes(`"${header}": "`), header)
  }
})

test('the sales order export says what the list says: lines not priced, one unit or mixed, a calendar day, numbers, and a cut', () => {
  const page = read('src/modules/sales/OutboundWorkbench.tsx')
  assert.match(page, /\[say\("Lines not priced", "未定价行"\)\]: total \? total\.unpriced : "",/)
  assert.match(page, /\[say\("Unit", "单位"\)\]: units\.length > 1 \? say\("Mixed", "多种单位"\) : units\[0\] \|\| "",/)
  assert.match(page, /\[say\("Promised date", "承诺日期"\)\]: row\.promisedDate \? String\(row\.promisedDate\)\.slice\(0, 10\) : "",/)
  assert.match(page, /\[say\("Ordered", "订购数量"\)\]: number\(row\.orderedQuantity\),/)
  assert.match(page, /const \{ rows: all, total: matching, truncated \} = await fetchAllListRows<Order>/)
  assert.match(page, /if \(truncated\) toast\.warning\(say\(`Exported the first \$\{all\.length\} of \$\{matching\} orders\./)
})

test('the supplier export names the payment term as the page does, and keeps a 0-day lead time', () => {
  const page = read('src/modules/srm/Page.tsx')
  assert.match(page, /\[copy\("Payment terms"\)\]: \(paymentTerms \|\| \[\]\)\.find\(\(term\) => term\.id === row\.paymentTermsId \|\| term\.recordId === row\.paymentTermsId\)\?\.label \|\| row\.paymentTermsId \|\| "",/)
  assert.match(page, /\[copy\("Delivery lead time \(days\)"\)\]: row\.deliveryCycleDays \?\? "",/)
})
