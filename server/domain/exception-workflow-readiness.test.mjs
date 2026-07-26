import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  allowedNextExceptionCaseStatuses,
  buildExceptionWorkflowDraft,
  buildResolutionPayload,
  summarizeExistingCaseWorkflow,
  validateExceptionCaseFieldUpdate,
  validateExceptionCaseTransition,
} from './exception-case-workflow.mjs'
import { createInMemoryExceptionCaseRepository } from '../repositories/exception-case-repository.mjs'
import { handleExceptionCasesRoute } from '../routes/exception-cases.routes.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

const baseCase = {
  caseType: 'po_delay',
  title: 'PO delay case',
  severity: 'high',
  sourceEntityType: 'purchaseOrder',
  sourceEntityId: 'PO-2026-1282',
  owner: 'Ops',
  dueDate: '2026-07-10',
  linkedRecords: [{ entityType: 'purchaseOrder', entityId: 'PO-2026-1282' }],
  evidenceItems: [{ id: 'ev-1', summary: 'Open quantity remains.', reason: 'PO open quantity remains after ETA.' }],
}

function responseHarness({ method = 'POST', pathname = '/api/exception-cases', body = {}, repo, auditLog = [] } = {}) {
  const chunks = []
  const res = { statusCode: 200 }
  return {
    ctx: {
      req: { method, headers: {} },
      res,
      url: new URL(`http://local${pathname}`),
      db: {},
      dataMode: 'test',
      identity: { authenticated: true, tenantId: 'demo-tenant', userId: 'demo-user', role: 'admin' },
      repositories: {
        exceptionCases: repo,
        auditLog: {
          adapter: 'db-audit-log-v1',
          recordAuditEntry: async (entry) => {
            auditLog.push(entry)
            return entry
          },
        },
      },
      readBody: async () => body,
      send: (response, status, payload) => {
        response.statusCode = status
        chunks.push(JSON.stringify(payload))
      },
      event: () => {},
    },
    result: () => ({ status: res.statusCode, payload: chunks.length ? JSON.parse(chunks.at(-1)) : null, auditLog }),
  }
}

async function createCase(repo, overrides = {}, dataMode = 'test') {
  return repo.createCase({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode }, { confirm: true, case: { ...baseCase, ...overrides } })
}

test('R241 baseline review confirms safe exception workflow extension points', () => {
  const model = source('server', 'domain', 'exception-case-model.mjs')
  const repo = source('server', 'repositories', 'exception-case-repository.mjs')
  const route = source('server', 'routes', 'exception-cases.routes.mjs')
  const page = source('src', 'modules', 'exception-cases', 'Page.tsx')
  assert.match(model, /EXCEPTION_CASE_STATUSES/)
  assert.match(repo, /updateCaseStatus/)
  assert.match(repo, /addCaseNote/)
  assert.match(route, /\/api\/exception-cases/)
  assert.match(page, /CaseDetail/)
  assert.doesNotMatch([model, repo, route, page].join('\n'), /workflow engine|BPM/i)
})

test('R242 status transition rules allow safe paths and reject invalid or unconfirmed final transitions', () => {
  assert.deepEqual(allowedNextExceptionCaseStatuses('open'), ['in_review', 'waiting_supplier', 'waiting_internal', 'cancelled'])
  assert.equal(validateExceptionCaseTransition('open', 'in_review', { actor: 'Ops' }).ok, true)
  assert.equal(validateExceptionCaseTransition('open', 'closed', { confirm: true, resolutionNote: 'done' }).code, 'EXCEPTION_CASE_TRANSITION_NOT_ALLOWED')
  assert.equal(validateExceptionCaseTransition('in_review', 'resolved', {}).code, 'EXCEPTION_CASE_TRANSITION_CONFIRMATION_REQUIRED')
  assert.equal(validateExceptionCaseTransition('resolved', 'closed', { confirm: true }).code, 'EXCEPTION_CASE_RESOLUTION_NOTE_REQUIRED')
  assert.equal(validateExceptionCaseTransition('resolved', 'closed', { confirm: true, resolutionNote: 'Root cause reviewed.' }).ok, true)
})

test('R243 owner due date and severity updates require confirmation and valid input', async () => {
  assert.equal(validateExceptionCaseFieldUpdate({ fields: { severity: 'urgent' }, confirm: true }).errors.includes('severity_invalid'), true)
  assert.equal(validateExceptionCaseFieldUpdate({ fields: { dueDate: 'not-a-date' }, confirm: true }).errors.includes('due_date_invalid'), true)
  assert.equal(validateExceptionCaseFieldUpdate({ fields: { owner: 'Ops#<script>' }, confirm: true }).errors.includes('owner_invalid'), true)
  assert.equal(validateExceptionCaseFieldUpdate({ fields: { owner: 'Ops Lead', dueDate: '2026-07-20', severity: 'critical' } }).errors.includes('confirmation_required'), true)

  const repo = createInMemoryExceptionCaseRepository({ db: {} })
  const item = await createCase(repo)
  await assert.rejects(() => repo.updateCaseFields({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, item.caseId, { fields: { severity: 'critical' } }), /confirmation/i)
  const updated = await repo.updateCaseFields({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, item.caseId, { confirm: true, fields: { severity: 'critical', owner: 'Ops Lead', dueDate: '2026-07-20' } })
  assert.equal(updated.severity, 'critical')
  assert.equal(updated.owner, 'Ops Lead')
  assert.equal(updated.auditTrail.some((entry) => entry.action === 'exception_case_fields_updated'), true)
})

test('R244 case notes require confirmation and AI note drafts remain non-mutating', async () => {
  const repo = createInMemoryExceptionCaseRepository({ db: {} })
  const item = await createCase(repo)
  await assert.rejects(() => repo.addCaseNote({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, item.caseId, { body: 'draft note' }), /confirmation/i)
  const withNote = await repo.addCaseNote({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, item.caseId, { confirm: true, body: 'Confirmed internal note', noteType: 'internal' })
  assert.equal(withNote.notes.at(-1).noteType, 'internal')
  const draft = buildExceptionWorkflowDraft({ case: item, draftType: 'supplier_followup_note' })
  assert.equal(draft.requiresReview, true)
  assert.equal(draft.mutationAllowed, false)
  assert.equal(draft.forbiddenAiActions.includes('auto_send_supplier_email'), true)
})

test('R245 closure requires resolution model confirmation and does not mutate linked business data', async () => {
  const beforeBusiness = JSON.stringify({ purchaseOrders: [{ po: 'PO-2026-1282', status: '已发出' }] })
  assert.throws(() => buildResolutionPayload({ confirm: true }, baseCase), /Resolution note/)
  const resolution = buildResolutionPayload({ confirm: true, resolutionNote: 'Supplier committed recovery date.', actor: 'Ops' }, baseCase)
  assert.equal(resolution.resolutionSummary, 'Supplier committed recovery date.')

  const repo = createInMemoryExceptionCaseRepository({ db: {} })
  const item = await createCase(repo)
  const inReview = await repo.updateCaseStatus({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, item.caseId, { status: 'in_review', reason: 'Start review' })
  const resolved = await repo.updateCaseStatus({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, inReview.caseId, { confirm: true, status: 'resolved', reason: 'Evidence reviewed' })
  await assert.rejects(() => repo.updateCaseStatus({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, resolved.caseId, { confirm: true, status: 'closed' }), /Resolution note/)
  const closed = await repo.updateCaseStatus({ tenantId: 'demo-tenant', userId: 'demo-user', dataMode: 'test' }, resolved.caseId, { confirm: true, status: 'closed', resolutionNote: 'Resolution reviewed.' })
  assert.equal(closed.status, 'closed')
  assert.equal(closed.resolution.resolutionSummary, 'Resolution reviewed.')
  assert.equal(JSON.stringify({ purchaseOrders: [{ po: 'PO-2026-1282', status: '已发出' }] }), beforeBusiness)
})

test('R246-R248 routes expose workflow controls and create audit entries for confirmed updates', async () => {
  const repo = createInMemoryExceptionCaseRepository({ db: {} })
  const item = await createCase(repo, {}, 'user')
  const patch = responseHarness({
    method: 'PATCH',
    pathname: `/api/exception-cases/${item.caseId}`,
    repo,
    body: { confirm: true, fields: { owner: 'Ops Lead', dueDate: '2026-07-20', severity: 'critical' }, actor: 'Ops' },
  })
  assert.equal(await handleExceptionCasesRoute(patch.ctx), true)
  assert.equal(patch.result().status, 200)
  assert.equal(patch.result().payload.case.owner, 'Ops Lead')
  assert.equal(patch.result().auditLog.some((entry) => entry.action === 'exception_case_fields_updated'), true)

  const status = responseHarness({
    method: 'POST',
    pathname: `/api/exception-cases/${item.caseId}/status`,
    repo,
    body: { status: 'in_review', reason: 'Start review', actor: 'Ops' },
  })
  assert.equal(await handleExceptionCasesRoute(status.ctx), true)
  assert.equal(status.result().payload.case.status, 'in_review')
  assert.equal(status.result().auditLog.some((entry) => entry.action === 'exception_case_status_changed'), true)
})

test('R247 deterministic workflow drafts cover supplier follow-up internal resolution and closure summary', () => {
  const caseItem = { ...baseCase, caseId: 'EC-000001', status: 'waiting_supplier', summary: 'PO is delayed.' }
  for (const draftType of ['supplier_followup_note', 'internal_followup_note', 'resolution_note', 'closure_summary']) {
    const draft = buildExceptionWorkflowDraft({ case: caseItem, draftType })
    assert.equal(draft.draftType, draftType)
    assert.equal(draft.requiresReview, true)
    assert.equal(draft.mutationAllowed, false)
    assert.equal(draft.assumptions.includes('Not sent automatically'), true)
    assert.equal(draft.assumptions.includes('Not saved automatically'), true)
  }
})

test('R249 existing case workflow status returns duplicate-aware recommendations', () => {
  assert.equal(summarizeExistingCaseWorkflow({ caseId: 'EC-1', status: 'waiting_supplier', owner: 'Buyer', dueDate: '2026-07-10' }).recommendation, 'preview_supplier_followup_draft')
  assert.equal(summarizeExistingCaseWorkflow({ caseId: 'EC-2', status: 'resolved' }).recommendation, 'review_case_closure')
  assert.equal(summarizeExistingCaseWorkflow({ caseId: 'EC-3', status: 'closed' }).recommendation, 'monitor_recurrence_before_reopening')
  assert.equal(summarizeExistingCaseWorkflow({ caseId: 'EC-4', status: 'open' }).duplicateCreationRecommended, false)
})

test('R250 source guardrails keep workflow UI business-facing and AI safely bounded', () => {
  const page = source('src', 'modules', 'exception-cases', 'Page.tsx')
  const routes = source('src', 'app', 'routeRegistry.tsx')
  const workflow = source('server', 'domain', 'exception-case-workflow.mjs')
  const caseRoute = source('server', 'routes', 'exception-cases.routes.mjs')
  const planner = source('server', 'domain', 'business-action-draft-contract.mjs')
  const relationships = source('src', 'domain', 'relationships', 'resolver.ts')
  for (const expected of ['流程控制', '更新字段', '移至复核中', '标记为等待供应商', '标记为已解决', '关闭工单', '处理结论草稿']) {
    assert.match(page, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(routes, /moduleLabel:\s*"异常处理工单"/)
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']|label:\s*["']AI Command Center["']|label:\s*["']Ask AI["']/)
  assert.match(workflow, /auto_close_case/)
  assert.match(workflow, /auto_send_supplier_email/)
  assert.match(caseRoute, /recordDatabaseAuditBestEffort/)
  assert.match(planner, /auto_modify_business_data/)
  assert.match(relationships, /resolveEntityRelationships/)
  assert.doesNotMatch([page, workflow, caseRoute].join('\n'), /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|sk-[A-Za-z0-9]/)
})

test('R250.1 final case transitions require explicit confirmation UI before backend confirm flag', () => {
  const page = source('src', 'modules', 'exception-cases', 'Page.tsx')
  for (const expected of [
    '确认最终状态变更',
    '当前状态',
    '下一状态',
    '工单 ID',
    '关联主记录',
    '需要处理结论',
    '审计预览',
    '关联 PO、GRN、发票、SKU、供应商记录不会被修改。',
    '确认状态变更',
  ]) {
    assert.match(page, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(page, /requestTransition\(status/)
  assert.match(page, /"cancelled", "resolved", "closed"/)
  assert.doesNotMatch(page, /onClick=\{\(\) => onChangeStatus\(item, status/)
})
