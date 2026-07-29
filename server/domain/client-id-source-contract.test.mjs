import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../../src/lib/client-id.ts', import.meta.url), 'utf8')
const procurement = await readFile(new URL('../../src/modules/purchase-requests/CanonicalProcurementPanel.tsx', import.meta.url), 'utf8')

test('browser temporary id helper has all required fallbacks and explicit security boundary', () => {
  assert.match(source, /randomUUID/)
  assert.match(source, /getRandomValues/)
  assert.match(source, /temporaryCounter/)
  assert.match(source, /Never use for database IDs, idempotency keys, sessions, tokens, checksums/)
})

test('procurement request draft uses the UI-only helper instead of direct randomUUID', () => {
  assert.match(procurement, /createClientTemporaryId\("pr-line"\)/)
  assert.doesNotMatch(procurement, /crypto\.randomUUID/)
})
