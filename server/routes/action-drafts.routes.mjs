import {
  actionDraftPreviewAuditEntry,
  actionDraftSavedAuditEntry,
  actionDraftUsedAuditEntry,
  recordDatabaseAuditBestEffort,
} from '../domain/audit-policy.mjs'
import { supportedActionDraftTypes } from '../domain/action-draft-boundary.mjs'
import { sanitizeSuggestionTrail } from '../../shared/prefill-suggestions.mjs'

const DRAFT_USES = new Set(['copied', 'opened_in_email'])

function actionDraftRepository(ctx) {
  if (!ctx.repositories?.actionDrafts) throw new Error('PostgreSQL action draft repository is not configured.')
  return ctx.repositories.actionDrafts
}

export async function handleActionDraftsRoute(ctx) {
  const { req, res, url, send, readBody } = ctx
  const repository = actionDraftRepository(ctx)

  if (req.method === 'GET' && url.pathname === '/api/action-drafts/schema') {
    send(res, 200, { schema: repository.getSchema() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/action-drafts/preview') {
    const body = await readBody(req)
    const result = repository.previewDraft(body)
    if (!result.ok) {
      send(res, 400, result)
      return true
    }
    await recordDatabaseAuditBestEffort(ctx, actionDraftPreviewAuditEntry(result))
    send(res, 200, { draft: result.draft, previewOnly: true })
    return true
  }

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

  if (req.method === 'POST' && (url.pathname === '/api/action-drafts' || url.pathname === '/api/action-drafts/save')) {
    const identity = ctx.identity
    if (!identity?.authenticated || !String(identity.tenantId || '').trim()) {
      send(res, 401, { code: 'AUTHENTICATION_REQUIRED', error: 'Sign in to save a draft.' })
      return true
    }
    const body = await readBody(req)
    const draft = body?.draft || body
    if (typeof repository.persistDraft !== 'function') {
      send(res, 501, { error: 'Action draft persistence is only available in database mode.' })
      return true
    }
    try {
      // The session decides where the draft lives and who created it; any
      // tenant or creator in the posted draft is ignored.
      const saved = await repository.persistDraft({
        ...draft,
        tenantId: identity.tenantId,
        createdById: identity.userId,
      })
      await recordDatabaseAuditBestEffort(ctx, actionDraftSavedAuditEntry(saved))
      send(res, 201, {
        draft: saved,
        persisted: true,
        createsBusinessDocument: false,
        requiresConfirmation: true,
      })
    } catch (error) {
      // Only errors raised on purpose carry a status and a caller-safe
      // message. Anything else (a Prisma or driver error) goes to the server
      // error boundary, which logs a sanitized summary and returns a generic
      // 500 instead of the raw database message.
      if (!Number.isInteger(error?.status)) throw error
      send(res, error.status, {
        error: error?.message || 'Action draft persistence failed.',
        code: error?.code || 'ACTION_DRAFT_PERSISTENCE_FAILED',
      })
    }
    return true
  }

  return false
}
