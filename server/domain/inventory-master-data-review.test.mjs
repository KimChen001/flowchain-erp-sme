import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// What a walk of the inventory and master data pages on the public-data
// walkthrough found (11/10): lists that drew every row, a document page 18,000
// px tall, raw ids and timestamps, and a filter badge that miscounted.

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('the long inventory and master data lists draw 50 rows at a time with the shared pager', async () => {
  const inventory = await read('src/modules/inventory/Page.tsx')
  // Balances, warnings, lots and serials hold every row in the browser (the
  // cards and search count them all) and draw one page; movements come a page
  // at a time from the server.
  assert.match(inventory, /const LIST_PAGE_SIZE = 50;/)
  assert.match(inventory, /const MOVEMENT_PAGE_SIZE = 50;/)
  assert.match(inventory, /const drawn: any\[\] = view === "movements" \? visible : paged\.pageRows;/)
  assert.doesNotMatch(inventory, /\(visible as (Item|Movement|Lot|Serial|InventoryException)\[\]\)\.map\(/)
  assert.match(inventory, /testId=\{`inventory-\$\{view\}-pager`\}/)

  const masterData = await read('src/modules/master-data/Page.tsx')
  assert.match(masterData, /const CUSTOMER_PAGE_SIZE = 50;/)
  assert.match(masterData, /<CustomerTable customers=\{customerPage\.pageRows\}/)
  assert.match(masterData, /testId="customer-pager"/)
  // The reference lists use the shared search card and list card.
  assert.match(masterData, /<ListSearchCard/)
  assert.match(masterData, /<ListCard title=\{copy\(view\.list\)\}/)

  const prices = await read('src/modules/master-data/ItemSupplierPricesPage.tsx')
  assert.match(prices, /const PAGE_SIZE = 50;/)
  assert.match(prices, /offset: String\(\(nextPage - 1\) \* PAGE_SIZE\)/)
  assert.doesNotMatch(prices, /Load \{count\} more/)
  assert.match(prices, /testId="item-supplier-prices-pager"/)

  // The item list's count names the rows on the page, as the PO list does.
  const items = await read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(items, /shown: formatNumber\(paged\.pageRows\.length\)/)
})

test('an inventory document page has a title, its facts once, and pages its lines and movements', async () => {
  const workbench = await read('src/modules/inventory/InventoryOperationsWorkbench.tsx')
  const detail = workbench.slice(workbench.indexOf('function OperationDetail('))
  assert.match(detail, /<h1 className="fc-page-title"/)
  assert.match(detail, /data-testid="inventory-operation-facts"/)
  // One warehouse for every line is said once, in the facts.
  assert.match(detail, /const samePlace = kind !== "transfer" && lines\.length > 1 && places\.size === 1/)
  assert.match(detail, /linePage\.pageRows\.map\(/)
  assert.match(detail, /testId="inventory-operation-line-pager"/)
  // The column that printed the count variance under "Status" is gone.
  assert.doesNotMatch(detail, /copy\("状态"\)/)
  // Many movements of one posting read as a line per kind until opened.
  assert.match(detail, /const MOVEMENT_FOLD_AFTER = 20;/)
  assert.match(detail, /data-testid="operation-movements-summary"/)
  // The reason box shows only when an action can use it.
  assert.match(detail, /\{\(anyAction \|\| preview \|\| error\) && \(/)
  // One status per document: the posting once posted or reversed.
  assert.match(workbench, /row\.postingStatus === "posted" \|\| row\.postingStatus === "reversed" \? row\.postingStatus : row\.workflowStatus/)
  assert.match(workbench, /<Status value=\{documentStatus\(row\)\} \/>/)
})

test('a phone filter button counts the filters in use, not the fields it folds away', async () => {
  const layout = await read('src/components/ui/listLayout.tsx')
  assert.match(layout, /activeFilters > 0 \? say\("filters", \{ count: activeFilters \}\) : say\("filtersNone"\)/)
  assert.doesNotMatch(layout, /say\("filters", \{ count: rest\.length \}\)/)
})

test('record pages leave out the internal id beside a code and show stored timestamps as dates', async () => {
  const page = await read('src/components/business/BusinessEntityDetailPage.tsx')
  assert.match(page, /!\(key === "id" && \[record\.code,/)
  assert.match(page, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}T\\d\{2\}:\\d\{2\}\/\.test\(value\)\) return formatDateTimeInTimeZone\(value, locale, timezone\)/)
})

test('a payment term recorded only as a NET code reads as its rule, keeping the code', async () => {
  const format = await read('src/modules/master-data/masterDataFormat.ts')
  assert.ok(format.includes('const net = /^NET\\s?(\\d+)$/i.exec(text);'), 'NET30 and "Net 45" read as a rule')
  assert.match(format, /masterDataCopy\("Net \{days\} days", language, \{ days: Number\(net\[1\]\) \}\)\} \(\$\{text\}\)/)
  assert.match(format, /"Net \{days\} days": "\{days\} 天账期"/)
  // The list and the record page both use it.
  assert.match(await read('src/modules/master-data/StandardMasterTables.tsx'), /orNotProvided\(paymentTermLabel\(item\.paymentTerms, language\)\)/)
  assert.match(await read('src/components/business/BusinessEntityDetailPage.tsx'), /NOT_RECORDED_KEYS\.has\(key\)\) return paymentTermLabel\(value/)
})

test('warehouse and print template lists fit a phone', async () => {
  const tables = await read('src/modules/master-data/MasterDataTables.tsx')
  // Columns no warehouse fills are left out; "Available" only when one is not.
  assert.match(tables, /\{ label: "Available", show: warehouses\.some\(\(item\) => !item\.available\)/)
  const standard = await read('src/modules/master-data/StandardMasterTables.tsx')
  assert.match(standard, /<div className=\{tableScrollClass\} ref=\{listTableCardsRef\}>\s*<table className=\{`w-full min-w-\[820px\]/)
  // Changing a customer's status sits in the row menu.
  assert.match(standard, /<RowMenu label=\{say\("More", "更多"\)\} testId=\{`customer-row-more-\$\{item\.code\}`\}>/)
})

test('a phone card keeps its title readable beside a long status', async () => {
  // A status cell holding a chip and a "Next: …" line squeezed the receivable
  // number to one character per line (39,973 px on a phone).
  const theme = await read('src/styles/theme.css')
  assert.match(theme, /grid-template-columns: auto minmax\(45%, 1fr\) auto;/)
  for (const file of ['src/modules/finance/OperationalFinanceO2cWorkbench.tsx', 'src/modules/finance/OperationalFinanceP2pWorkbench.tsx']) {
    const source = await read(file)
    assert.doesNotMatch(source, /<div className="mt-1 text-\[11px\]" style=\{\{ color: A\.sub \}\}>\{tr\("next"\)\}/, file)
    assert.match(source, /className="mt-1 hidden text-\[11px\] sm:block"/, file)
  }
})
