import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = file => readFile(join(root, file), 'utf8')

test('retired import UI offers no rollback while archived fixture documents the former correction boundary', async () => {
  const [page, repository] = await Promise.all([
    source('src/modules/imports/Page.tsx'),
    source('server/domain/test-fixtures/legacy-import-persistence-repository.mjs'),
  ])

  assert.doesNotMatch(page, /可在回滚窗口内回滚|一键回滚|已自动撤销|可恢复原状态/)
  assert.match(page, /data-testid="legacy-import-retired-page"/)
  assert.match(page, /不再创建预览批次、提交业务表或回滚历史批次/)
  assert.doesNotMatch(page, /rollbackAvailable|targetRepositories|importBatchId/)
  assert.doesNotMatch(page, /<button[^>]*>[^<]*(?:一键回滚|回滚批次)/)

  assert.match(repository, /code: 'DURABLE_IMPORT_ROLLBACK_NOT_SUPPORTED'/)
  assert.match(repository, /当前版本不支持自动回滚。请通过对应业务模块创建反向调整或人工修正。/)
  assert.match(repository, /rollbackAvailable: false/)
})
