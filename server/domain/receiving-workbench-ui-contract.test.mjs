import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../src/modules/receiving/ReceivingPostingWorkbench.tsx', import.meta.url), 'utf8')

test('receiving workbench exposes explicit loading, capability, conflict, post, and reversal states', () => {
  for (const marker of ['receiving-loading', 'receiving-error', 'Post receipt', 'Reverse receipt', 'View reversal', 'Confirm posting', 'Confirm reversal', 'BackToListLink', 'impact-preview', 'reversal-reason', 'Read-only.', 'Unavailable', 'receiving-reconciliation', 'availableActions.primaryAction', 'onNavigate', 'Data was refreshed']) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker)
  }
})

test('receiving workbench maps the stable command error vocabulary without raw database errors', () => {
  for (const code of ['CAPABILITY_NOT_AVAILABLE', 'AUTHENTICATION_REQUIRED', 'PERMISSION_DENIED', 'TENANT_CONTEXT_REQUIRED', 'ACTOR_NOT_PROVISIONED', 'RECEIVING_NOT_FOUND', 'RECEIVING_VALIDATION_FAILED', 'RECEIVING_OVER_RECEIPT', 'RECEIVING_ALREADY_POSTED', 'RECEIVING_VERSION_CONFLICT', 'RECEIVING_CONCURRENT_POSTING_CONFLICT', 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'RECEIVING_ALREADY_REVERSED', 'RECEIVING_REVERSAL_NOT_SAFE']) assert.match(source, new RegExp(code))
  assert.doesNotMatch(source, /P2002|P2034|SQLSTATE|40001|40P01/)
})
