import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20: the top-level Receiving page (the Receipts list)
// had no way to start a receipt, and the page of orders waiting to be received
// left approved orders out without a word. The orders themselves are read
// with receiving permissions (receiving-orders-to-receive.test.mjs); these
// check the pages, from the source, as the other list-page checks do.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the Receipts list offers New receipt only to people who prepare receipts and can open the page', () => {
  const page = read('src/modules/procurement/ReceivingListPage.tsx')
  assert.match(page, /const canPrepareReceipt = Boolean\(usePermissionSet\(\)\?\.has\("receiving\.prepare"\)\) && canOpenRoute\("procurement:receiving:new"\);/)
  assert.match(page, /\{canPrepareReceipt && <Link to="\/app\/procurement\/receiving\/new"[^>]*data-testid="receiving-new"/)
  assert.match(page, /tr\("新建收货单", "New receipt"\)/)
  // The subtitle names New receipt only when the button is there.
  assert.match(page, /subtitle=\{canPrepareReceipt\s*\? tr\("[^"]*新建收货单[^"]*", "[^"]*use New receipt and choose its purchase order[^"]*"\)\s*: tr\("点击编号查看收货、过账与库存影响。", "Select a number to review receiving, posting, and inventory impact\."\)\}/)
})

test('the orders to receive come from the receiving read, and links go only where the reader may go', () => {
  const chooser = read('src/modules/procurement/ReceivablePurchaseOrderChooser.tsx')
  assert.match(chooser, /apiJson<OrdersToReceive>\("\/api\/procurement\/receivable-orders"\)/)
  assert.doesNotMatch(chooser, /apiJson<[^>]*>\("\/api\/procurement\/orders"\)/)
  assert.match(chooser, /setNotIssued\(Number\(answer\?\.notIssued\) \|\| 0\)/)
  // Each row maps through a wrapper, so map's index never reaches receivableOf.
  assert.match(chooser, /\.map\(\(row\) => receivableOf\(row\)\)/)
  // The link: to the approved orders only for those who may open the list;
  // "mark them issued" only for those who may issue.
  assert.match(chooser, /const canOpenOrders = canOpenRoute\("procurement:orders"\);/)
  assert.match(chooser, /\{canOpenOrders\s*\? <Link to="\/app\/procurement\/orders\?status=approved" className=\{`\$\{tableLinkClass\} max-sm:inline-flex max-sm:min-h-9 max-sm:items-center`\}>\{tr\("notIssuedSee"\)\}<\/Link>\s*: tr\("notIssuedAsk"\)\}/)
  // The order's number links to its page only for those who may open it.
  assert.match(chooser, /\{canOpenOrder \? <EntityLink kind="purchase_order" id=\{row\.id\} number=\{row\.number\} className=\{tableLinkClass\} \/> : <span className="font-medium">\{row\.number\}<\/span>\}/)
  // The cut-off note promises no search beyond the rows loaded.
  assert.doesNotMatch(chooser, /search to find another/i)
  assert.match(chooser, /actions=\{canOpenOrders \? backToOrders : undefined\}/)
  for (const key of ['notIssuedOne', 'notIssuedMany', 'notIssuedSee', 'notIssuedAsk', 'truncated']) {
    const pair = chooser.match(new RegExp(`${key}: \\["([^"]+)", "([^"]+)"\\]`))
    assert.ok(pair, key)
    assert.match(pair[2], /[一-鿿]/, `${key} has its Chinese`)
  }
})
