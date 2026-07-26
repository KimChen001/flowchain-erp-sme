import {
  buildCaseNoteDraft,
  buildExceptionCaseDraftFromEvidence,
  buildExceptionCaseDraftFromSourceContext,
  hasExceptionCaseSourceContext,
} from '../domain/exception-case-draft-builder.mjs'
import { buildExceptionWorkflowDraft, exceptionCaseAuditPolicyEntry } from '../domain/exception-case-workflow.mjs'
import { recordDatabaseAuditBestEffort } from '../domain/audit-policy.mjs'

function repository(ctx) {
  if (!ctx.repositories?.exceptionCases) throw new Error('PostgreSQL exception case repository is not configured.')
  return ctx.repositories.exceptionCases
}

function scopeFrom(ctx, body = {}) {
  return {
    tenantId: ctx.identity?.tenantId,
    userId: ctx.identity?.userId,
    dataMode: 'user',
  }
}

function sendError(send, res, error) {
  send(res, error?.status || 500, {
    error: error?.message || 'Exception case operation failed.',
    code: error?.code || 'EXCEPTION_CASE_OPERATION_FAILED',
    validation: error?.validation,
  })
}

export async function handleExceptionCasesRoute(ctx) {
  const { req, res, url, send, readBody } = ctx
  const repo = repository(ctx)

  if (req.method === 'GET' && url.pathname === '/api/exception-cases') {
    const filters = {
      status: url.searchParams.get('status') || '',
      caseType: url.searchParams.get('caseType') || '',
      severity: url.searchParams.get('severity') || '',
    }
    const cases = await repo.listCases(scopeFrom(ctx), filters)
    send(res, 200, { cases, createsBusinessDocument: false })
    return true
  }

  if (req.method === 'GET' && /^\/api\/exception-cases\/[^/]+$/.test(url.pathname)) {
    const caseId = decodeURIComponent(url.pathname.split('/').pop())
    const item = await repo.getCaseById(scopeFrom(ctx), caseId)
    if (!item) {
      send(res, 404, { error: 'Exception case not found.' })
      return true
    }
    send(res, 200, { case: item })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/exception-cases/draft') {
    const body = await readBody(req)
    if (!body.bundle && !body.evidence && !body.evidenceItems && !hasExceptionCaseSourceContext(body)) {
      send(res, 422, {
        error: 'Exception case draft requires explicit source context or evidence.',
        code: 'EXCEPTION_CASE_DRAFT_SOURCE_CONTEXT_REQUIRED',
        guidedState: 'Select a risk from Today Cockpit, a business record, or an AI insight to create an exception case draft.',
        previewOnly: true,
        createsCaseRecord: false,
      })
      return true
    }
    const draftInput = body.bundle || body.evidence || body.evidenceItems
      ? buildExceptionCaseDraftFromEvidence(body)
      : buildExceptionCaseDraftFromSourceContext(body)
    const draft = await repo.previewCaseDraft(scopeFrom(ctx, body), draftInput)
    send(res, 200, { draft, previewOnly: true, createsCaseRecord: false })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/exception-cases') {
    const body = await readBody(req)
    try {
      const item = await repo.createCase(scopeFrom(ctx, body), body)
      ctx.event?.(ctx.db, 'exception_case_created', `Exception case ${item.caseId} created after user confirmation`, item.caseId)
      await recordDatabaseAuditBestEffort(ctx, exceptionCaseAuditPolicyEntry('exception_case_created', item, body, { nextStatus: item.status }))
      send(res, 201, { case: item, created: true, createsBusinessDocument: false })
    } catch (error) {
      sendError(send, res, error)
    }
    return true
  }

  if (req.method === 'POST' && /^\/api\/exception-cases\/[^/]+\/notes$/.test(url.pathname)) {
    const body = await readBody(req)
    const caseId = decodeURIComponent(url.pathname.split('/').at(-2))
    try {
      const item = await repo.addCaseNote(scopeFrom(ctx, body), caseId, body)
      if (!item) {
        send(res, 404, { error: 'Exception case not found.' })
        return true
      }
      ctx.event?.(ctx.db, 'exception_case_note_added', `Exception case note added after confirmation`, caseId)
      await recordDatabaseAuditBestEffort(ctx, exceptionCaseAuditPolicyEntry('exception_case_note_added', item, body))
      send(res, 200, { case: item, noteSaved: true })
    } catch (error) {
      sendError(send, res, error)
    }
    return true
  }

  if (req.method === 'POST' && /^\/api\/exception-cases\/[^/]+\/status$/.test(url.pathname)) {
    const body = await readBody(req)
    const caseId = decodeURIComponent(url.pathname.split('/').at(-2))
    try {
      const item = await repo.updateCaseStatus(scopeFrom(ctx, body), caseId, body)
      if (!item) {
        send(res, 404, { error: 'Exception case not found.' })
        return true
      }
      ctx.event?.(ctx.db, 'exception_case_status_changed', `Exception case ${caseId} status changed to ${item.status}`, caseId)
      await recordDatabaseAuditBestEffort(ctx, exceptionCaseAuditPolicyEntry(item.status === 'closed' ? 'exception_case_closed' : 'exception_case_status_changed', item, body, { nextStatus: item.status }))
      send(res, 200, { case: item, statusUpdated: true })
    } catch (error) {
      sendError(send, res, error)
    }
    return true
  }

  if (req.method === 'PATCH' && /^\/api\/exception-cases\/[^/]+$/.test(url.pathname)) {
    const body = await readBody(req)
    const caseId = decodeURIComponent(url.pathname.split('/').pop())
    try {
      const item = await repo.updateCaseFields(scopeFrom(ctx, body), caseId, body)
      if (!item) {
        send(res, 404, { error: 'Exception case not found.' })
        return true
      }
      ctx.event?.(ctx.db, 'exception_case_fields_updated', `Exception case ${caseId} fields updated after confirmation`, caseId)
      await recordDatabaseAuditBestEffort(ctx, exceptionCaseAuditPolicyEntry('exception_case_fields_updated', item, body))
      send(res, 200, { case: item, updated: true })
    } catch (error) {
      sendError(send, res, error)
    }
    return true
  }

  if (req.method === 'POST' && /^\/api\/exception-cases\/[^/]+\/note-draft$/.test(url.pathname)) {
    const body = await readBody(req)
    const caseId = decodeURIComponent(url.pathname.split('/').at(-2))
    send(res, 200, { draft: buildCaseNoteDraft({ ...body, caseId }), previewOnly: true })
    return true
  }

  if (req.method === 'POST' && /^\/api\/exception-cases\/[^/]+\/workflow-draft$/.test(url.pathname)) {
    const body = await readBody(req)
    const caseId = decodeURIComponent(url.pathname.split('/').at(-2))
    const item = await repo.getCaseById(scopeFrom(ctx, body), caseId)
    if (!item) {
      send(res, 404, { error: 'Exception case not found.' })
      return true
    }
    send(res, 200, { draft: buildExceptionWorkflowDraft({ ...body, case: item }), previewOnly: true, mutationAllowed: false })
    return true
  }

  return false
}
