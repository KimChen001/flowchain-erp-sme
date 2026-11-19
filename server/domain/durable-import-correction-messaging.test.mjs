import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = file => readFile(join(root, file), 'utf8')

test('the archived import fixture documents the former correction boundary', async () => {
  const repository = await source('server/domain/test-fixtures/legacy-import-persistence-repository.mjs')

  assert.match(repository, /code: 'DURABLE_IMPORT_ROLLBACK_NOT_SUPPORTED'/)
  assert.match(repository, /当前版本不支持自动回滚。请通过对应业务模块创建反向调整或人工修正。/)
  assert.match(repository, /rollbackAvailable: false/)
})
