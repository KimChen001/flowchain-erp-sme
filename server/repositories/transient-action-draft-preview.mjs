import { actionDraftSchema, buildActionDraftSuggestion, validateActionDraftPayload } from '../domain/action-draft-boundary.mjs'
import { buildPurchaseRequestDraftPreview } from '../domain/purchase-request-draft-preview.mjs'
import { buildRfqDraftPreview, buildSupplierFollowupDraftPreview } from '../domain/rfq-and-supplier-followup-draft-preview.mjs'

export function createTransientActionDraftPreview(db = {}) {
  return {
    getSchema: () => actionDraftSchema(),
    validateDraft: ({ type = '', payload = {} } = {}) => validateActionDraftPayload(type, payload),
    previewDraft: (request = {}, options = {}) => {
      if (request.type === 'purchase_request_draft') return buildPurchaseRequestDraftPreview(request, { db, ...options })
      if (request.type === 'rfq_draft') return buildRfqDraftPreview(request, { db, ...options })
      if (request.type === 'supplier_followup_draft') return buildSupplierFollowupDraftPreview(request, { db, ...options })
      return buildActionDraftSuggestion(request, options)
    },
  }
}
