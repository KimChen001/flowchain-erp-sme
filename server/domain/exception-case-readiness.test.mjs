import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createExceptionCaseDraft, normalizeExceptionCase, validateExceptionCase } from './exception-case-model.mjs'
import { buildCaseNoteDraft, buildExceptionCaseDraftFromEvidence, buildExceptionCaseDraftFromSourceContext } from './exception-case-draft-builder.mjs'
import { createInMemoryExceptionCaseRepository } from '../repositories/exception-case-repository.mjs'
import { handleExceptionCasesRoute } from '../routes/exception-cases.routes.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

function evidenceBundle(evidenceType, sourceEntityType, sourceEntityId, riskLevel = 'high') {
  return {
    sourceEntityType,
    sourceEntityId,
    evidence: [{
      id: `${sourceEntityId}:${evidenceType}`,
      title: `${evidenceType} evidence`,
      sourceModule: sourceEntityType === 'sku' ? 'inventory' : sourceEntityType === 'supplier' ? 'srm' : 'procurement',
      sourceEntityType,
      sourceEntityId,
      evidenceType,
      summary: `${sourceEntityId} has ${evidenceType} evidence.`,
      riskLevel,
      reason: `${evidenceType} requires operational review.`,
      route: sourceEntityType === 'sku' ? 'inventory' : 'procurement',
    }],
    linkedRecords: [{ entityType: sourceEntityType, entityId: sourceEntityId, displayLabel: sourceEntityId }],
    dataLimitations: [],
  }
}

function responseHarness({ method = 'GET', pathname = '/api/exception-cases', body = {}, repo } = {}) {
  const chunks = []
  const res = {
    statusCode: 200,
    headers: {},
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(payload) { chunks.push(payload) },
  }
  return {
    ctx: {
      req: { method, headers: {} },
      res,
      url: new URL(`http://local${pathname}`),
      db: {},
      dataMode: 'test',
      repositories: repo ? { exceptionCases: repo } : undefined,
      readBody: async () => body,
      send: (response, status, payload) => {
        response.statusCode = status
        chunks.push(JSON.stringify(payload))
      },
      event: () => {},
    },
    result: () => ({ status: res.statusCode, payload: chunks.length ? JSON.parse(chunks.at(-1)) : null }),
  }
}

test('R231 baseline review keeps exception case boundary aligned with existing evidence audit and draft structures', () => {
  const inventoryExceptions = source('src', 'modules', 'inventory', 'InventoryExceptionDocuments.tsx')
  const evidence = source('src', 'domain', 'relationships', 'evidence.ts')
  const actionDraftRepo = source('server', 'repositories', 'db-action-draft-repository.mjs')
  const cockpit = source('src', 'modules', 'overview', 'TodayCockpitPanel.tsx')
  assert.match(inventoryExceptions, /库存异常单据/)
  assert.match(evidence, /resolvePoDelayEvidence/)
  assert.match(evidence, /resolveSkuShortageEvidence/)
  assert.match(evidence, /resolveReceivingExceptionEvidence/)
  assert.match(evidence, /resolveInvoiceMatchingEvidence/)
  assert.match(actionDraftRepo, /previewDraft/)
  assert.match(cockpit, /actionDraftRequest/)
})

test('R232 exception case model normalizes cases and drafts with review-first AI prohibitions', () => {
  const item = normalizeExceptionCase({
    caseType: 'po_delay',
    title: 'PO delay',
    severity: 'high',
    sourceEntityType: 'purchaseOrder',
    sourceEntityId: 'PO-2026-1282',
    evidenceItems: [{ id: 'ev-1', riskLevel: '高', reason: '高' }],
  })
  assert.equal(item.caseType, 'po_delay')
  assert.equal(item.status, 'open')
  assert.equal(item.evidenceItems[0].reason.includes('risk level separately'), true)
  assert.equal(validateExceptionCase(item).ok, true)
  const invalid = validateExceptionCase({ caseType: 'bad', title: '', sourceEntityId: '' })
  assert.equal(invalid.ok, false)

  const draft = createExceptionCaseDraft({ caseType: 'sku_shortage', sourceEntityType: 'sku', sourceEntityId: 'SKU-00412' })
  assert.equal(draft.requiresReview, true)
  assert.equal(draft.mutationAllowed, false)
  assert.equal(draft.createsCaseRecord, false)
  assert.equal(draft.forbiddenAiActions.includes('auto_create_case'), true)
  assert.equal(draft.forbiddenAiActions.includes('auto_close_case'), true)
  assert.equal(draft.forbiddenAiActions.includes('auto_send_supplier_email'), true)
})

test('R233 repository is scoped, confirmation-gated, non-destructive, and duplicate-aware', async () => {
  const db = {}
  const repo = createInMemoryExceptionCaseRepository({ db })
  const scopeA = { tenantId: 't1', userId: 'u1', dataMode: 'test' }
  const scopeB = { tenantId: 't1', userId: 'u2', dataMode: 'test' }
  await assert.rejects(
    () => repo.createCase(scopeA, { case: { caseType: 'sku_shortage', title: 'SKU shortage', severity: 'high', sourceEntityType: 'sku', sourceEntityId: 'SKU-00412' } }),
    /confirmation/i,
  )
  const created = await repo.createCase(scopeA, { confirm: true, case: { caseType: 'sku_shortage', title: 'SKU shortage', severity: 'high', sourceEntityType: 'sku', sourceEntityId: 'SKU-00412', owner: 'Ops' } })
  assert.equal(created.caseId.startsWith('EC-'), true)
  assert.equal((await repo.listCases(scopeA)).length, 1)
  assert.equal((await repo.listCases(scopeB)).length, 0)
  const draft = await repo.previewCaseDraft(scopeA, { caseType: 'sku_shortage', sourceEntityType: 'sku', sourceEntityId: 'SKU-00412', title: 'Duplicate draft' })
  assert.equal(draft.duplicateWarning.caseId, created.caseId)
  await assert.rejects(() => repo.updateCaseStatus(scopeA, created.caseId, { status: 'closed' }), /not allowed/i)
  await assert.rejects(() => repo.addCaseNote(scopeA, created.caseId, { body: 'note' }), /confirmation/i)
  const withNote = await repo.addCaseNote(scopeA, created.caseId, { confirm: true, body: 'reviewed note' })
  assert.equal(withNote.notes.length, 1)
})

test('R234 case drafts build deterministically from PO SKU GRN invoice supplier and RFQ evidence', () => {
  const bundles = [
    ['po_delay', evidenceBundle('po_delay', 'purchaseOrder', 'PO-2026-1282')],
    ['sku_shortage', evidenceBundle('sku_shortage', 'sku', 'SKU-00412')],
    ['receiving_exception', evidenceBundle('receiving_exception', 'grn', 'GRN-202605-0419')],
    ['invoice_matching_failure', evidenceBundle('invoice_matching', 'invoice', 'INV-2026-0098')],
    ['supplier_risk', evidenceBundle('supplier_risk', 'supplier', 'SUP-003', 'medium')],
    ['rfq_timing_risk', evidenceBundle('rfq_timing', 'rfq', 'RFQ-26-0046', 'medium')],
  ]
  for (const [expectedType, bundle] of bundles) {
    const draft = buildExceptionCaseDraftFromEvidence({ bundle, sourceTrigger: 'today_cockpit' })
    assert.equal(draft.proposedCaseFields.caseType, expectedType)
    assert.equal(draft.requiresReview, true)
    assert.equal(draft.mutationAllowed, false)
    assert.equal(draft.proposedCaseFields.evidenceItems.length > 0, true)
    assert.equal(draft.proposedCaseFields.evidenceItems.every((item) => item.reason && !['高', '中', '低'].includes(item.reason)), true)
  }
})

test('R250.1 source context drafts require explicit context and do not use default SKU evidence', async () => {
  const page = source('src', 'modules', 'exception-cases', 'Page.tsx')
  assert.doesNotMatch(page, /sourceEntityId:\s*"SKU-00412"|SKU-00412:shortage|demoDraftEvidence/)
  assert.match(page, /请从今日驾驶舱、业务记录或智能洞察中选择风险来源后，再创建异常工单草稿。/)

  const poDraft = buildExceptionCaseDraftFromSourceContext({
    sourceModule: 'procurement',
    sourceEntityType: 'purchaseOrder',
    sourceEntityId: 'PO-2026-1282',
    caseType: 'po_delay',
  })
  assert.equal(poDraft.proposedCaseFields.caseType, 'po_delay')
  assert.equal(poDraft.proposedCaseFields.sourceEntityId, 'PO-2026-1282')
  assert.ok(poDraft.proposedCaseFields.dataLimitations.includes('source_context_has_no_evidence_items'))

  const skuDraft = buildExceptionCaseDraftFromSourceContext({
    sourceModule: 'inventory',
    sourceEntityType: 'sku',
    sourceEntityId: 'SKU-LOCAL-1',
  })
  assert.equal(skuDraft.proposedCaseFields.caseType, 'sku_shortage')
  assert.equal(skuDraft.createsCaseRecord, false)

  const repo = createInMemoryExceptionCaseRepository({ db: {} })
  const missing = responseHarness({ method: 'POST', pathname: '/api/exception-cases/draft', repo, body: {} })
  assert.equal(await handleExceptionCasesRoute(missing.ctx), true)
  assert.equal(missing.result().status, 422)
  assert.equal(missing.result().payload.code, 'EXCEPTION_CASE_DRAFT_SOURCE_CONTEXT_REQUIRED')

  const sourced = responseHarness({
    method: 'POST',
    pathname: '/api/exception-cases/draft',
    repo,
    body: { sourceModule: 'invoice-matching', sourceEntityType: 'invoice', sourceEntityId: 'INV-LOCAL-1' },
  })
  assert.equal(await handleExceptionCasesRoute(sourced.ctx), true)
  assert.equal(sourced.result().status, 200)
  assert.equal(sourced.result().payload.draft.proposedCaseFields.caseType, 'invoice_matching_failure')
  assert.equal(sourced.result().payload.createsCaseRecord, false)
})

test('R237 route rejects missing confirmation and creates only exception case records after confirmation', async () => {
  const repo = createInMemoryExceptionCaseRepository({ db: {} })
  const missing = responseHarness({
    method: 'POST',
    pathname: '/api/exception-cases',
    repo,
    body: { case: { caseType: 'po_delay', title: 'PO delay', severity: 'high', sourceEntityType: 'purchaseOrder', sourceEntityId: 'PO-2026-1282' } },
  })
  assert.equal(await handleExceptionCasesRoute(missing.ctx), true)
  assert.equal(missing.result().status, 400)
  assert.equal(missing.result().payload.code, 'EXCEPTION_CASE_CONFIRMATION_REQUIRED')

  const confirmed = responseHarness({
    method: 'POST',
    pathname: '/api/exception-cases',
    repo,
    body: { confirm: true, case: { caseType: 'po_delay', title: 'PO delay', severity: 'high', sourceEntityType: 'purchaseOrder', sourceEntityId: 'PO-2026-1282', owner: 'Ops' } },
  })
  assert.equal(await handleExceptionCasesRoute(confirmed.ctx), true)
  assert.equal(confirmed.result().status, 201)
  assert.equal(confirmed.result().payload.created, true)
  assert.equal(confirmed.result().payload.createsBusinessDocument, false)
})

test('R238-R240 UI and integration guardrails keep case management business-facing and review-first', () => {
  const routes = source('src', 'app', 'routeRegistry.tsx')
  const page = source('src', 'modules', 'exception-cases', 'Page.tsx')
  const app = source('src', 'app', 'FlowChainApp.tsx')
  const route = source('server', 'routes', 'exception-cases.routes.mjs')
  const planner = source('server', 'domain', 'business-action-draft-contract.mjs')
  const relationships = source('src', 'domain', 'relationships', 'resolver.ts')

  assert.match(routes, /moduleLabel:\s*"异常处理工单"/)
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']|label:\s*["']AI Command Center["']|label:\s*["']Ask AI["']/)
  assert.match(app, /ExceptionCasesPage/)
  for (const text of ['暂无异常处理工单', '生成内部跟进草稿', '确认创建工单', '预览跟进备注', '确认后保存备注', '工单字段已更新', '工单状态已更新']) {
    assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  for (const text of ['Exception Cases', 'Case List', 'Open Cases', 'Review Queue', 'Case fields updated', 'Case status updated']) {
    assert.doesNotMatch([routes, page].join('\n'), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  for (const text of ['供应商风险', '收货异常', '发票匹配异常', '库存风险', '采购订单延期', '未关闭', '复核中', '等待供应商', '等待内部处理', '未分配', '当前操作人']) {
    assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  for (const unsafe of ['Auto close', 'Auto send', 'Issue PO', 'Pay invoice']) {
    assert.doesNotMatch(page, new RegExp(unsafe))
  }
  assert.match(route, /previewOnly:\s*true/)
  assert.match(route, /createsCaseRecord:\s*false/)
  assert.match(route, /confirm/)
  assert.match(planner, /auto_modify_business_data/)
  assert.match(relationships, /resolveEntityRelationships/)
  assert.doesNotMatch([page, route, routes].join('\n'), /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|sk-[A-Za-z0-9]/)
})

test('R239 note draft boundary remains non-mutating and cannot send or close cases', () => {
  const draft = buildCaseNoteDraft({ caseId: 'EC-000001', summary: 'Need supplier follow-up.' })
  assert.equal(draft.requiresReview, true)
  assert.equal(draft.mutationAllowed, false)
  assert.equal(draft.forbiddenAiActions.includes('auto_send_supplier_email'), true)
  assert.equal(draft.forbiddenAiActions.includes('auto_close_case'), true)
})
