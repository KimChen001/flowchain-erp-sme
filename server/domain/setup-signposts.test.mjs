import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20: first-day messages that pointed to the wrong
// page, or to nowhere. Read from the source, as the other copy checks are.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('an item without a supplier points to a supplier\'s Supplied items, where the link is made', () => {
  const request = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  assert.match(request, /ITEM_HAS_NO_APPROVED_SUPPLIER: \["This item has no approved supplier yet\. Add it under Supplied items on a supplier's page \(Master data › Suppliers\) first\.", "[^"]*可供应物料[^"]*"\]/)
  assert.doesNotMatch(request, /Add one on the item's page/)
  const item = read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(item, /data-testid="item-detail-suppliers-hint"/)
  assert.match(item, /<Link to="\/app\/master-data\/suppliers"/)
  for (const file of ['src/modules/master-data/dataImportCopy.ts', 'server/domain/data-import-service.mjs']) {
    assert.match(read(file), /use Set as preferred under Supplied items on the other supplier's page, or write No\./, file)
    assert.doesNotMatch(read(file), /Change the preferred supplier on the item/, file)
  }
})

test('warehouses, bins and print templates say they are edited in Settings, with a link', () => {
  const page = read('src/modules/master-data/Page.tsx')
  assert.match(page, /warehouses: \{ text: "Warehouses and their locations are added and edited in Settings › Warehouses & access\.", link: "Open Warehouses & access", to: "\/app\/settings\/warehouse-access" \}/)
  assert.match(page, /"print-templates": \{ text: "These are the built-in print layouts\.[^"]*", link: "Open document settings", to: "\/app\/settings\/company" \}/)
  // A copied template lived only in the browser: there is no copy any more.
  assert.match(page, /<PrintTemplateTable templates=\{filteredTemplates\} \/>/)
  assert.doesNotMatch(read('src/modules/master-data/StandardMasterTables.tsx'), /Copy template/)
  assert.match(read('src/modules/master-data/BinListPage.tsx'), /<Link to="\/app\/settings\/warehouse-access"/)
  // Every new line has its Chinese.
  const zh = read('src/modules/master-data/masterDataFormat.ts')
  for (const english of [
    "Suppliers for this item are added on each supplier's page, under Supplied items; Set as preferred there makes one the default.",
    'Open suppliers', 'Warehouses and their locations are added and edited in Settings › Warehouses & access.', 'Open Warehouses & access',
    'No warehouses yet. Add them in Settings › Warehouses & access.',
    'Bins listed here hold stock. To add a location before stock arrives, use Settings › Warehouses & access.',
    'These are the built-in print layouts. To change what prints (letterhead, logo and the notes on each document), use Settings › Company & workspace › Documents.',
    'Open document settings',
  ]) assert.ok(zh.includes(`${JSON.stringify(english)}: "`), english)
})

test('Members says warehouse access is set on its own tab; Settings leaves the user menu for those who cannot open it', () => {
  assert.match(read('src/modules/settings/WorkspaceMembers.tsx'), /A new member sees no warehouse until you give them access on Warehouses & access\./)
  assert.match(read('src/app/FlowChainApp.tsx'), /\.\.\.\(canOpenRoute\("settings:company"\)/)
})
