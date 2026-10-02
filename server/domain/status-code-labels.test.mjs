import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { statusCodeLabel } from '../../src/i18n/statusLabels.ts'

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
