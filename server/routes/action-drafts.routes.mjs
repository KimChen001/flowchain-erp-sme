import {
  actionDraftUsedAuditEntry,
  recordDatabaseAuditBestEffort,
} from '../domain/audit-policy.mjs'
import { supportedActionDraftTypes } from '../domain/action-draft-boundary.mjs'
import { sanitizeSuggestionTrail } from '../../shared/prefill-suggestions.mjs'

const DRAFT_USES = new Set(['copied', 'opened_in_email'])

export async function handleActionDraftsRoute(ctx) {
  const { req, res, url, send, readBody } = ctx

  // The user copied a reviewed draft or opened it in their own mail app.
  // Nothing is sent and nothing is stored but the audit row.
  if (req.method === 'POST' && url.pathname === '/api/action-drafts/used') {
    const identity = ctx.identity
    if (!identity?.authenticated || !String(identity.tenantId || '').trim()) {
      send(res, 401, { code: 'AUTHENTICATION_REQUIRED', error: 'Sign in to record draft use.' })
      return true
    }
    const body = (await readBody(req)) || {}
    const draftType = String(body.draftType || '').trim()
    if (!supportedActionDraftTypes.some((item) => item.type === draftType) || !DRAFT_USES.has(body.use)) {
      send(res, 400, { code: 'VALIDATION_ERROR', error: 'A supported draft type and use are required.' })
      return true
    }
    const audit = await recordDatabaseAuditBestEffort(ctx, actionDraftUsedAuditEntry({ draftType, use: body.use, suggestions: sanitizeSuggestionTrail(body.suggestionTrail) }))
    send(res, 202, { recorded: audit.ok === true, sendsMessage: false })
    return true
  }

  return false
}
