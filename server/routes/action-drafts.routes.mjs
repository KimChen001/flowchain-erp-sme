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
    const body = await readBody(req)
    const draft = body?.draft || body
    if (typeof repository.persistDraft !== 'function') {
      send(res, 501, { error: 'Action draft persistence is only available in database mode.' })
      return true
    }
    try {
      const saved = await repository.persistDraft(draft)
      await recordDatabaseAuditBestEffort(ctx, actionDraftSavedAuditEntry(saved))
      send(res, 201, {
        draft: saved,
        persisted: true,
        createsBusinessDocument: false,
        requiresConfirmation: true,
      })
    } catch (error) {
      send(res, error?.status || 500, {
        error: error?.message || 'Action draft persistence failed.',
        code: error?.code || 'ACTION_DRAFT_PERSISTENCE_FAILED',
      })
    }
    return true
  }

  return false
}
