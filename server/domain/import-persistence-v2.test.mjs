import assert from 'node:assert/strict'
import test from 'node:test'
import { commitImportPreview, createImportPreview, getImportBatch, listImportedInventoryMovements, listImportedRecords, rollbackImportBatch } from './test-fixtures/legacy-import-persistence-repository.mjs'

function preview(schemaId, rows) {
  return createImportPreview({ businessObject: schemaId, schemaVersion: '1', fileMetadata: { name: `${schemaId}.xlsx` }, sheetName: '导入数据', fieldMapping: {}, rows, validationErrors: [], validationWarnings: [] }, { actor: '测试用户' })
}

test('preview is review-only and commit is idempotent', () => {
  const result = preview('purchase-request', [{ pr: 'PR-IMPORT-V2-001', sourceSku: 'SKU-00412', quantity: 12, unit: '台', requiredDate: '2026-07-25', priority: '中', status: '草稿' }])
  assert.equal(result.writesDb, false)
  assert.equal(listImportedRecords('purchaseRequests').some((row) => row.pr === 'PR-IMPORT-V2-001'), false)
  const input = { businessObject: 'purchase-request', snapshotHash: result.snapshotHash, idempotencyKey: 'idem-pr-v2-001', userConfirmation: true }
  const first = commitImportPreview(result.previewId, input)
  const replay = commitImportPreview(result.previewId, input)
  assert.equal(first.inserted, 1)
  assert.equal(replay.importBatchId, first.importBatchId)
  assert.equal(replay.replayed, true)
  assert.equal(listImportedRecords('purchaseRequests').filter((row) => row.pr === 'PR-IMPORT-V2-001').length, 1)
})
test('duplicate business keys are skipped and reversible changes retain audit state', () => {
  const result = preview('purchase-request', [{ pr: 'PR-IMPORT-V2-001', sourceSku: 'SKU-00412', quantity: 5, unit: '台', requiredDate: '2026-07-26', priority: '低', status: '草稿' }])
  const committed = commitImportPreview(result.previewId, { businessObject: 'purchase-request', snapshotHash: result.snapshotHash, idempotencyKey: 'idem-pr-v2-duplicate', userConfirmation: true }, { baselineRecords: [] })
  assert.equal(committed.skipped, 1)
  const rollback = rollbackImportBatch(committed.importBatchId, { reason: '测试回滚' }, { actor: '管理员', role: 'admin' })
  assert.equal(rollback.status, 'rolled_back')
  assert.equal(getImportBatch(committed.importBatchId).status, 'rolled_back')
})

test('inventory balance commit creates ledger movement and rollback creates reverse adjustment', () => {
  const result = preview('inventory-balance', [{ sku: 'SKU-00412', warehouse: '上海总仓', bin: 'D-02-01', quantity: 32, asOfDate: '2026-07-11', status: '可用' }])
  const committed = commitImportPreview(result.previewId, { businessObject: 'inventory-balance', snapshotHash: result.snapshotHash, idempotencyKey: 'idem-inventory-v2-001', userConfirmation: true })
  const original = listImportedInventoryMovements().find((row) => row.importBatchId === committed.importBatchId)
  assert.ok(original)
  assert.match(original.movementType, /opening_balance|inventory_adjustment/)
  rollbackImportBatch(committed.importBatchId, { reason: '测试库存反向调整' }, { actor: '管理员', role: 'admin' })
  assert.ok(listImportedInventoryMovements().some((row) => row.importBatchId === committed.importBatchId && row.movementType === 'rollback_adjustment'))
})
