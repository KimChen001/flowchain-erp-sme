import test from 'node:test'
import assert from 'node:assert/strict'
import { supportedActionDraftTypes } from './action-draft-boundary.mjs'

test('action draft boundary lists the supported draft types', () => {
  assert.deepEqual(supportedActionDraftTypes.map((item) => item.type), [
    'purchase_request_draft',
    'rfq_draft',
    'po_followup_draft',
    'inventory_exception_closure_draft',
    'supplier_followup_draft',
  ])
  assert.equal(supportedActionDraftTypes.every((item) => item.requiredPayloadFields.length > 0), true)
  assert.equal(Object.isFrozen(supportedActionDraftTypes), true)
})
