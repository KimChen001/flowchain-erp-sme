import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

// UI review 11: every detail page opens with one header card: the title (H1)
// with its status beside it, what the record is and with whom under it, and
// the actions on the right or inside the card.
test('the PO page header is a card with the status beside the title and the next steps inside', async () => {
  const shell = await read('src/components/document/DocumentShell.tsx')
  assert.match(shell, /<Card className="p-5" data-testid="document-header">/)
  assert.match(shell, /<h1 className="fc-page-title" style=\{\{ color: A\.label \}\}>\{copy\(title\)\}<\/h1>\s*\{status && <Chip label=\{copy\(status\)\}/)
  assert.match(shell, /\{header \? <div className="mt-4">\{header\}<\/div> : null\}/)
  const po = await read('src/modules/purchasing/Page.tsx')
  assert.match(po, /header=\{<div className="space-y-3" data-testid="po-header-actions">/)
})

test('the three-way match and supplier invoice read pages have one header card, Refresh inside it', async () => {
  const page = await read('src/modules/procurement/ProcurementDocumentDetailPage.tsx')
  assert.doesNotMatch(page, /"Three-way match details"\)/)
  assert.match(page, /data-testid="procurement-document-heading">\{heading\}<\/h1>\s*\{statusChip\(/)
  assert.match(page, /data-testid="procurement-document-note">\{readOnlyNote\}<\/p>/)
})

test('the supplier header sits above its tabs, so every tab keeps the name, tier, status and actions', async () => {
  const page = await read('src/modules/srm/Page.tsx')
  const header = page.indexOf('data-testid="supplier-detail-header"')
  const tabs = page.indexOf('role="tablist" aria-label={selected.supplierName}')
  assert.ok(header > 0 && tabs > header, 'header card before the tabs')
  assert.match(page.slice(header, tabs), /<h1 className="fc-page-title">\{selected\.supplierName\}<\/h1>/)
  assert.match(page.slice(header, tabs), /Set inactive/)
})

test('an item reads like a supplier: status chip beside the title, Edit as a secondary button', async () => {
  const page = await read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(page, /<StatusChip label=\{statusLabel\(selected\.status\)\}/)
  assert.match(page, /className=\{listButtonClass\.secondary\}\s*>\s*<Pencil size=\{13\} \/>\s*\{copy\("Edit item"\)\}/)
})

// The menu says Items; the item's own actions say item too. The SKU code stays the code.
test('item actions say item, in English and Chinese', async () => {
  const format = await read('src/modules/master-data/masterDataFormat.ts')
  for (const [en, zh] of [['New item', '新建物料'], ['Edit item', '编辑物料'], ['Search items', '搜索物料']]) {
    assert.ok(format.includes(`"${en}": "${zh}"`), `${en} has its Chinese pair`)
  }
  const page = await read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.doesNotMatch(page, /copy\("(新建|编辑|搜索) SKU"\)/)
  const supplier = await read('src/modules/srm/supplierCopy.ts')
  assert.match(supplier, /'Select item': '选择物料'/)
})

// The finance overview counted difference lines (44) while its card opens the
// list of invoices with differences and Today counts invoices (27). Since
// design audit L2-14 the card counts by the rule of the list it opens, the
// supplier invoices held by a match exception (status=exception).
test('the match exceptions card counts supplier invoices with a difference to decide', async () => {
  const service = await read('server/domain/operational-finance-o2c-read-service.mjs')
  assert.match(service, /prisma\.supplierInvoice\.count\(\{\s*where: \{ tenantId: current\.tenantId, \.\.\.matchHeldInvoiceWhere\(\) \},/)
  assert.doesNotMatch(service, /prisma\.financeMatchException\.count\(/)
})
