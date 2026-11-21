import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20, item 30: the reorder list and the inventory
// balances and warnings had no export, while the other lists do. Read from
// the source, as the other list-export checks (u14-list-exports) are.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the reorder list exports the rows its search and supplier filter show, with its own column names', () => {
  const page = read('src/modules/inventory/ReorderListPage.tsx')
  assert.match(page, /const exportRows = \(\) => void exportRowsToCsv\("reorder-list-export\.csv", rows\.map\(/)
  // rows is the filtered, ranked list (search and supplier), not the page drawn.
  assert.match(page, /const rows = useMemo\(\(\) => \{\s*const all = list\?\.rows \|\| \[\];/)
  assert.match(page, /<span data-testid="reorder-list-export"><ExportButton onClick=\{exportRows\} \/><\/span>/)
  for (const column of ['colOrderBy', 'exportDaysLeft', 'orderNow', 'exportSku', 'colItem', 'exportUnit', 'colOnHand', 'colReserved', 'colIncoming', 'colRequested', 'colBackorders', 'colPosition', 'colReorderPoint', 'colDemand', 'colShortfall', 'exportSuggested', 'colSupplier']) {
    assert.ok(page.includes(`[t("${column}")]:`), column)
  }
  const copy = read('src/modules/inventory/reorderListCopy.ts')
  for (const [key, english, chinese] of [['exportUnit', 'Unit', '单位'], ['exportSuggested', 'Suggested order quantity', '建议订货量'], ['exportDaysLeft', 'Days until order-by date', '距下单日天数']]) {
    assert.ok(copy.includes(`${key}: "${english}",`), key)
    assert.ok(copy.includes(`${key}: "${chinese}",`), key)
  }
})

test('inventory balances and warnings export every row the filters show, with the stock status the list shows', () => {
  const page = read('src/modules/inventory/Page.tsx')
  assert.match(page, /const exportStock = \(\) => void exportRowsToCsv\(view === "warnings" \? "inventory-warnings-export\.csv" : "inventory-balances-export\.csv", stockExportRows\(visible as Item\[\]\), timezone\);/)
  assert.match(page, /const stockExportRows = \(items: Item\[\]\) => items\.map\(\(item\) => \(\{/)
  assert.match(page, /\{\(view === "overview" \|\| view === "warnings"\) && state === "ready" && <ExportButton onClick=\{exportStock\} \/>\}/)
  // The balances view reads every page before the list is drawn, so the export is the whole list.
  assert.match(page, /if \(pageRows\.length < BALANCE_PAGE_SIZE \|\| total === null \|\| all\.length >= total\) break;/)
  assert.match(page, /\[tr\("status"\)\]: stockStateText\(item\),/)
  for (const [key, english, chinese] of [['exportItemName', 'Item name', '物料名称'], ['exportLocation', 'Location', '库位'], ['exportSafety', 'Safety stock', '安全库存'], ['exportReorderPoint', 'Reorder point', '再订货点']]) {
    assert.ok(page.includes(`${key}: ["${english}", "${chinese}"],`), key)
  }
})

test('the exports read as the lists do: thresholds blank where the list shows "—", order now as Yes or No', () => {
  const page = read('src/modules/inventory/Page.tsx')
  assert.match(page, /\[tr\("exportSafety"\)\]: thresholdNumber\(item\.safetyStock\) \?\? "",/)
  assert.match(page, /\[tr\("exportReorderPoint"\)\]: thresholdNumber\(item\.reorderPoint\) \?\? "",/)
  assert.match(page, /return number === null \? "—" : formatQuantity\(number\);/)
  assert.match(read('src/modules/inventory/ReorderListPage.tsx'), /\[t\("orderNow"\)\]: t\(row\.orderNow \? "exportYes" : "exportNo"\),/)
  const copy = read('src/modules/inventory/reorderListCopy.ts')
  assert.ok(copy.includes('exportYes: "Yes",') && copy.includes('exportYes: "是",'))
  assert.ok(copy.includes('exportNo: "No",') && copy.includes('exportNo: "否",'))
})
