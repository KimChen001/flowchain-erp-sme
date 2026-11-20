import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20: the top-level Receiving page (the Receipts list)
// had no way to start a receipt, and the page of orders waiting to be received
// left approved orders out without a word. Read from the source, as the other
// list-page checks are.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the Receipts list offers New receipt to people who prepare receipts, opening the orders to receive', () => {
  const page = read('src/modules/procurement/ReceivingListPage.tsx')
  assert.match(page, /const canPrepareReceipt = Boolean\(usePermissionSet\(\)\?\.has\("receiving\.prepare"\)\)/)
  assert.match(page, /\{canPrepareReceipt && <Link to="\/app\/procurement\/receiving\/new"[^>]*data-testid="receiving-new"/)
  assert.match(page, /tr\("新建收货单", "New receipt"\)/)
  // The subtitle names both ways in, in both languages.
  assert.match(page, /use New receipt and choose its purchase order, or Receive on the purchase order/)
  assert.match(page, /点击“新建收货单”选择到货的采购订单，或在采购订单上点击“收货”/)
})

test('the orders to receive say how many approved orders are not issued yet, and link to them', () => {
  const chooser = read('src/modules/procurement/ReceivablePurchaseOrderChooser.tsx')
  // Only issued and partially received orders are listed, as the Receive action allows.
  assert.match(chooser, /const RECEIVE_STATUSES = new Set\(\["issued", "partially_received"\]\)/)
  // Approved orders with quantity to receive are counted, not listed.
  assert.match(chooser, /setNotIssued\(\(rows \|\| \[\]\)\.filter\(\(row\) => receivableOf\(row, new Set\(\[AWAITING_ISSUE\]\)\)\)\.length\)/)
  assert.match(chooser, /const AWAITING_ISSUE = "approved"/)
  assert.match(chooser, /<Link to="\/app\/procurement\/orders\?status=approved"/)
  // Each row maps through a wrapper, so map's index never reaches the statuses.
  assert.match(chooser, /\.map\(\(row\) => receivableOf\(row\)\)/)
  for (const key of ['notIssuedOne', 'notIssuedMany', 'notIssuedLink']) {
    const pair = chooser.match(new RegExp(`${key}: \\["([^"]+)", "([^"]+)"\\]`))
    assert.ok(pair, key)
    assert.match(pair[2], /[一-鿿]/, `${key} has its Chinese`)
  }
})
