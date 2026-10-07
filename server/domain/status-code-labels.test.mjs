import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { movementTypeLabel, statusCodeLabel } from '../../src/i18n/statusLabels.ts'

test('stored status codes have English and Chinese display labels', () => {
  assert.equal(statusCodeLabel('approved', 'en-US'), 'Approved')
  assert.equal(statusCodeLabel('issued', 'en-US'), 'Issued')
  assert.equal(statusCodeLabel('partially_received', 'en-US'), 'Partially received')
  assert.equal(statusCodeLabel('issued', 'zh-CN'), '已下达')
  assert.equal(statusCodeLabel('LOCAL-DEMO-PO-002', 'en-US'), undefined)
})

test('workspace copy and document status chips translate stored status codes', async () => {
  const copy = await readFile(new URL('../../src/i18n/workspaceCopy.ts', import.meta.url), 'utf8')
  assert.match(copy, /statusCodeLabel\(label, language\)/)
  const shell = await readFile(new URL('../../src/components/document/DocumentShell.tsx', import.meta.url), 'utf8')
  assert.match(shell, /<Chip label=\{copy\(status\)\}/)
})

test('inventory adjustment movements name their reason, so opening stock stands apart', () => {
  assert.equal(movementTypeLabel('inventory_adjustment', 'en-US', 'opening_balance'), 'Inventory adjustment · Opening stock')
  assert.equal(movementTypeLabel('inventory_adjustment', 'zh-CN', 'opening_balance'), '库存调整 · 期初库存')
  assert.equal(movementTypeLabel('inventory_adjustment', 'en-US', 'damage'), 'Inventory adjustment · Damage')
  assert.equal(movementTypeLabel('inventory_adjustment', 'en-US'), 'Inventory adjustment')
  assert.equal(movementTypeLabel('receipt_posting', 'en-US', 'opening_balance'), 'Goods receipt')
})
