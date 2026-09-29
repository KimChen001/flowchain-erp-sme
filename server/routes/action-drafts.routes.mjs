import {
  actionDraftPreviewAuditEntry,
  actionDraftSavedAuditEntry,
  recordDatabaseAuditBestEffort,
} from '../domain/audit-policy.mjs'

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
