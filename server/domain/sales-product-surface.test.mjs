import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('sales order list exposes the canonical order number as a business link', () => {
  const source = readSource('src', 'modules', 'sales', 'OutboundWorkbench.tsx')

  assert.match(source, /BusinessEntityLink entityType="sales_order" entityId=\{row\.id\}/)
  assert.match(source, /\{row\.orderNumber\}/)
  assert.match(source, />\s*查看\s*<\/Link>/)
  assert.match(source, /销售订单查询/)
})

test('sales detail presents business-facing Chinese section names', () => {
  const source = readSource('src', 'modules', 'sales', 'OutboundWorkbench.tsx')

  for (const label of ['关联记录', '订单证据与时间线', '履约一致性检查', '发货证据与时间线']) {
    assert.match(source, new RegExp(label))
  }
  for (const removedLabel of ['Smart Links', 'Evidence Timeline', 'Outbound Reconciliation', 'Reconciliation & AI Explain']) {
    assert.doesNotMatch(source, new RegExp(removedLabel))
  }
})

test('sales risk and evidence pages use row-level tables and real evidence selection', () => {
  const source = readSource('src', 'modules', 'sales', 'Page.tsx')

  assert.match(source, /交付风险查询/)
  assert.match(source, /逐行查看订单缺口/)
  assert.match(source, /订单证据查询/)
  assert.match(source, /查看证据/)
  assert.match(source, /orderId=/)
  assert.match(source, /EntityLink kind="sales_order"/)
  assert.match(source, /EntityLink kind="item" id=\{order\.itemId\}/)
  assert.doesNotMatch(source, /EntityLink kind="item" id=\{order\.sku\}/)
  assert.doesNotMatch(source, /客户订单 → SKU → 库存可用量 → 采购订单 → 供应商 → 收货单/)
})
