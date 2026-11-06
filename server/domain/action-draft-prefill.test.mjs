import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizePrefillMap } from '../../shared/prefill-suggestions.mjs'
import { buildActionDraftSuggestion } from './action-draft-boundary.mjs'
import { buildSupplierFollowupDraftPreview } from './rfq-and-supplier-followup-draft-preview.mjs'
import { handleActionDraftsRoute } from '../routes/action-drafts.routes.mjs'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'

const db = () => ({ suppliers: [{ id: 'SUP-ATLAS', name: 'Atlas Industrial Supply' }], products: [], rfqs: [], auditLog: [] })

function routeContext(pathname, body, { identity = { authenticated: true, tenantId: 'tenant-a', userId: 'user-a', role: 'buyer' }, store = db() } = {}) {
  let response = null
  let wrote = false
  return {
    store,
    ctx: {
      req: { method: 'POST', body },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db: store,
      identity,
      repositories: createTestRepositoryRegistry(store),
      send(_res, status, payload) { response = { status, payload } },
      readBody: async (req) => req.body,
      writeDb: async () => { wrote = true },
    },
    get response() { return response },
    get wrote() { return wrote },
  }
}

test('a prefill map keeps well-formed suggestions with their values and drops the rest', () => {
  assert.deepEqual(sanitizePrefillMap({
    to: { source: 'default', ref: 'supplier:email', value: 'orders@atlas.example' },
    subject: { source: 'template', value: 'PO-013: delivery date' },
    message: { source: 'model', ref: 'has spaces in it', value: 'Hello' },
    'Bad Field': { source: 'record', value: 'x' },
    quantity: { source: 'record', value: 12 },
    note: { source: 'guess', value: 'x' },
    long: { source: 'template', value: 'x'.repeat(4001) },
  }), {
    to: { source: 'default', ref: 'supplier:email', value: 'orders@atlas.example' },
    subject: { source: 'template', value: 'PO-013: delivery date' },
    message: { source: 'model', value: 'Hello' },
  })
  assert.equal(sanitizePrefillMap(null), null)
  assert.equal(sanitizePrefillMap([{ source: 'record', value: 'x' }]), null)
  assert.equal(sanitizePrefillMap({ x: { source: 'guess', value: 'y' } }), null)
})

test('an invoice variance draft keeps its recipient, subject and lines, and names the invoice', () => {
  const lines = [{ lineId: 'L1', sku: 'LDM-001', remaining: 40, unit: 'pcs', promisedDate: '2026-09-28', originalPromisedDate: null }]
  const result = buildSupplierFollowupDraftPreview({
    type: 'supplier_followup_draft',
    source: 'ai_assistant',
    payload: { supplierId: 'SUP-ATLAS', supplierName: 'Atlas Industrial Supply', invoiceId: 'INV-001', poId: 'PO-013', to: 'orders@atlas.example', contactName: 'Dana Park', subject: 'INV-001: price variance', message: 'Invoice INV-001 differs from the purchase order.', lines },
    prefill: {
      to: { source: 'default', ref: 'supplier:email', value: 'orders@atlas.example' },
      message: { source: 'template', ref: 'draft.invoice.message', value: 'Invoice INV-001 differs from the purchase order.' },
      'not a field': { source: 'record', value: 'x' },
      subject: { source: 'guess', value: 'INV-001: price variance' },
    },
  }, { db: db(), now: new Date('2026-10-03T00:00:00Z') })
  assert.equal(result.ok, true)
  const { payload, prefill } = result.draft
  assert.equal(payload.to, 'orders@atlas.example')
  assert.equal(payload.contactName, 'Dana Park')
  assert.equal(payload.subject, 'INV-001: price variance')
  assert.equal(payload.messageDraft, 'Invoice INV-001 differs from the purchase order.')
  assert.deepEqual(payload.lines, lines)
  assert.equal(payload.relatedDocumentType, 'supplier_invoice')
  assert.equal(payload.relatedDocumentId, 'INV-001')
  assert.equal(payload.poId, 'PO-013')
  // The message suggestion follows the field it is stored in; invalid entries are dropped.
  assert.deepEqual(prefill, {
    to: { source: 'default', ref: 'supplier:email', value: 'orders@atlas.example' },
    messageDraft: { source: 'template', ref: 'draft.invoice.message', value: 'Invoice INV-001 differs from the purchase order.' },
  })
})

test('a purchase order follow-up preview carries its prefill map; without one there is none', () => {
  const withPrefill = buildActionDraftSuggestion({ type: 'po_followup_draft', payload: { poId: 'PO-013', message: 'Please confirm a delivery date.' }, prefill: { message: { source: 'template', ref: 'draft.po_followup.message', value: 'Please confirm a delivery date.' } } })
  assert.deepEqual(withPrefill.draft.prefill, { message: { source: 'template', ref: 'draft.po_followup.message', value: 'Please confirm a delivery date.' } })
  const without = buildActionDraftSuggestion({ type: 'po_followup_draft', payload: { poId: 'PO-013', message: 'Hi' } })
  assert.equal('prefill' in without.draft, false)
})

test('copying a draft or opening it in the mail app records codes only and sends nothing', async () => {
  const route = routeContext('/api/action-drafts/used', {
    draftType: 'po_followup_draft',
    use: 'opened_in_email',
    message: 'Please confirm a delivery date for PO-013.',
    suggestionTrail: { origin: 'ai_assistant', fields: [{ field: 'message', source: 'template', ref: 'draft.po_followup.message', outcome: 'edited', value: 'Please confirm a date' }, { field: 'to', source: 'default', outcome: 'accepted' }] },
  })
  await handleActionDraftsRoute(route.ctx)
  assert.equal(route.response.status, 202)
  assert.deepEqual(route.response.payload, { recorded: true, sendsMessage: false })
  assert.equal(route.wrote, false)
  assert.equal(route.store.auditLog.length, 1)
  const entry = route.store.auditLog[0]
  assert.equal(entry.action, 'ai_draft_used')
  assert.equal(entry.metadata.use, 'opened_in_email')
  assert.equal(entry.metadata.sendsMessage, false)
  assert.deepEqual(entry.metadata.suggestions.counts, { prefilled: 2, accepted: 1, edited: 1, cleared: 0 })
  assert.doesNotMatch(JSON.stringify(entry), /Please confirm/)
})

test('draft use needs a signed-in workspace, a supported draft type and a known use', async () => {
  const anonymous = routeContext('/api/action-drafts/used', { draftType: 'po_followup_draft', use: 'copied' }, { identity: null })
  await handleActionDraftsRoute(anonymous.ctx)
  assert.equal(anonymous.response.status, 401)
  for (const body of [{ draftType: 'payment_draft', use: 'copied' }, { draftType: 'po_followup_draft', use: 'sent' }]) {
    const route = routeContext('/api/action-drafts/used', body)
    await handleActionDraftsRoute(route.ctx)
    assert.equal(route.response.status, 400)
    assert.equal(route.store.auditLog.length, 0)
  }
})
