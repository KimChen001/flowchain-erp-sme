import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildContextualActionDraftReviewCardV2,
  buildContextualReviewCardsV2,
  detectContextualDraftRequestV2,
  inferContextualDraftTypeV2,
  sanitizeDraftPayloadV2,
  selectDraftTargetFromResolvedContextV2,
  validateContextualReviewCardV2,
} from './ai-runtime-contextual-action-drafts-v2.mjs'

const forbiddenTechnical = /provider|model|endpoint|API|key|token|JSON|payload|fallback|mock|fake|OpenAI|DeepSeek|Doubao|豆包|tenantId|userId|datasetId|entityType|response_card|system prompt|prompt package/i
const forbiddenAction = /自动批准|自动下单|正式创建 PO|下发 PO|发送 PO|发布 RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite/i

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|entityId|targetEntityId|targetEntityType|source|draftType|payload|originEvidence|moduleId|type)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('detects contextual draft requests in Chinese and English', () => {
  const cases = [
    ['预览供应商跟进草稿', 'supplier_follow_up'],
    ['生成补货复核草稿', 'sku_replenishment'],
    ['生成发票差异说明草稿', 'invoice_variance_review'],
    ['write an internal note draft', 'generic_context_review'],
    ['supplier follow-up draft', 'supplier_follow_up'],
    ['replenishment draft', 'sku_replenishment'],
  ]
  for (const [message, intent] of cases) {
    const detected = detectContextualDraftRequestV2(message)
    assert.equal(detected.isDraftRequest, true, message)
    assert.equal(detected.draftIntent, intent, message)
    assert.ok(['high', 'medium'].includes(detected.confidence))
  }
  assert.equal(detectContextualDraftRequestV2('这个 PO 为什么优先？').isDraftRequest, false)
  assert.equal(detectContextualDraftRequestV2('打开这个对象的人工复核草稿').isDraftRequest, false)
})

test('selects draft targets from resolved context active fallback and evidence fallback', () => {
  const resolvedPo = selectDraftTargetFromResolvedContextV2({
    entityRefs: [{ entityType: 'PO', entityId: 'PO-2026-1282', entityLabel: 'PO-2026-1282', confidence: 'high' }],
  }, {}, '打开这个对象的人工复核草稿')
  assert.equal(resolvedPo.target.entityType, 'PO')
  assert.equal(resolvedPo.target.entityId, 'PO-2026-1282')

  const supplier = selectDraftTargetFromResolvedContextV2({
    entityRefs: [{ entityType: 'Supplier', entityId: 'SUP-001', entityLabel: '星河电子', confidence: 'high' }],
  }, {}, '预览供应商跟进草稿')
  assert.equal(supplier.target.entityType, 'Supplier')

  const sku = selectDraftTargetFromResolvedContextV2({
    entityRefs: [{ entityType: 'SKU', entityId: 'SKU-00412', entityLabel: 'SKU-00412', confidence: 'high' }],
  }, {}, '这个 SKU 生成补货草稿')
  assert.equal(sku.target.entityType, 'SKU')

  const invoice = selectDraftTargetFromResolvedContextV2({
    entityRefs: [{ entityType: 'Invoice', entityId: 'INV-26-001', entityLabel: 'INV-26-001', confidence: 'high' }],
  }, {}, '生成发票差异复核草稿')
  assert.equal(invoice.target.entityType, 'Invoice')

  const grn = selectDraftTargetFromResolvedContextV2({
    entityRefs: [{ entityType: 'GRN', entityId: 'GRN-26-001', entityLabel: 'GRN-26-001', confidence: 'high' }],
  }, {}, '生成收货异常复核草稿')
  assert.equal(grn.target.entityType, 'GRN')

  const active = selectDraftTargetFromResolvedContextV2({}, {
    activeRef: { entityType: 'PO', entityId: 'PO-ACTIVE', entityLabel: 'PO-ACTIVE', confidence: 'high' },
  }, 'open review draft')
  assert.equal(active.target.entityId, 'PO-ACTIVE')

  const evidence = selectDraftTargetFromResolvedContextV2({}, {
    previousEvidenceRefs: [{ entityType: 'SKU', entityId: 'SKU-EV', entityLabel: 'SKU-EV', confidence: 'medium' }],
  }, 'preview draft')
  assert.equal(evidence.target.entityId, 'SKU-EV')

  const missing = selectDraftTargetFromResolvedContextV2({}, {}, '打开这个对象的人工复核草稿')
  assert.equal(missing.target, null)
  assert.match(missing.limitation, /当前上下文不足/)
})

test('prefers matching type and marks ambiguous generic draft targets', () => {
  const selected = selectDraftTargetFromResolvedContextV2({
    entityRefs: [
      { entityType: 'PO', entityId: 'PO-1', entityLabel: 'PO-1', confidence: 'high' },
      { entityType: 'Supplier', entityId: 'SUP-1', entityLabel: '供应商 A', confidence: 'high' },
    ],
  }, {}, '预览供应商跟进草稿')
  assert.equal(selected.target.entityType, 'Supplier')
  assert.equal(selected.ambiguous, false)

  const ambiguous = selectDraftTargetFromResolvedContextV2({
    entityRefs: [
      { entityType: 'PO', entityId: 'PO-1', entityLabel: 'PO-1', confidence: 'high' },
      { entityType: 'SKU', entityId: 'SKU-1', entityLabel: 'SKU-1', confidence: 'high' },
    ],
  }, {}, '打开这个对象的人工复核草稿')
  assert.equal(ambiguous.target.entityId, 'PO-1')
  assert.equal(ambiguous.ambiguous, true)
  assert.match(ambiguous.limitation, /多个相关对象/)
})

test('infers supported draft types for PO Supplier SKU Invoice GRN and generic context', () => {
  assert.equal(inferContextualDraftTypeV2({ target: { entityType: 'PO' } }).draftType, 'po_followup_draft')
  assert.equal(inferContextualDraftTypeV2({ target: { entityType: 'Supplier' } }).draftType, 'supplier_followup_draft')
  assert.equal(inferContextualDraftTypeV2({ target: { entityType: 'SKU' } }).draftType, 'purchase_request_draft')
  assert.equal(inferContextualDraftTypeV2({ target: { entityType: 'Invoice' } }).draftType, 'po_followup_draft')
  assert.equal(inferContextualDraftTypeV2({ target: { entityType: 'GRN' } }).draftType, 'po_followup_draft')
  assert.equal(inferContextualDraftTypeV2({ target: { entityType: 'Unknown' } }).draftType, 'po_followup_draft')
})

test('builds bounded preview-only review card with required fields', () => {
  const card = buildContextualActionDraftReviewCardV2({
    message: '打开这个对象的人工复核草稿',
    intent: { id: 'po_priority' },
    target: { entityType: 'PO', entityId: 'PO-2026-1282', entityLabel: 'PO-2026-1282', confidence: 'high' },
    evidenceRefs: Array.from({ length: 8 }, (_, index) => ({ id: `EV-${index}`, label: `证据 ${index}`, entityType: 'PO', entityId: 'PO-2026-1282', entityLabel: 'PO-2026-1282' })),
  })
  assert.equal(card.previewOnly, true)
  assert.equal(card.reviewRequired, true)
  assert.equal(card.requiresHumanReview, true)
  assert.equal(card.targetModule, 'review-actions')
  assert.equal(card.targetEntityId, 'PO-2026-1282')
  assert.equal(card.draftType, 'po_followup_draft')
  assert.ok(card.draftTitle)
  assert.ok(card.payload.reviewOnly)
  assert.ok(card.payload.previewOnly)
  assert.ok(card.payload.requiresHumanReview)
  assert.ok(card.originEvidence.length <= 5)
  assert.ok(validateContextualReviewCardV2(card).ok)
  assert.doesNotMatch(visibleText(card), forbiddenTechnical)
  assert.doesNotMatch(visibleText(card), forbiddenAction)
})

test('no context returns limitation and does not invent an object id', () => {
  const result = buildContextualReviewCardsV2({
    request: { message: '生成这个对象的内部备注草稿' },
    intent: { id: 'unknown_guided_fallback' },
    resolvedContext: {},
    conversationGrounding: {},
    baseReviewCards: [],
  })
  assert.match(visibleText(result.dataLimitations), /当前上下文不足/)
  assert.equal(result.reviewCards[0].targetEntityId, '')
  assert.equal(result.reviewCards[0].payload.poId, '')
})

test('ambiguous target adds limitation while keeping selected target review-only', () => {
  const result = buildContextualReviewCardsV2({
    request: { message: '生成这个对象的内部备注草稿' },
    intent: { id: 'today_attention' },
    resolvedContext: {
      entityRefs: [
        { entityType: 'PO', entityId: 'PO-1', entityLabel: 'PO-1', confidence: 'high' },
        { entityType: 'SKU', entityId: 'SKU-1', entityLabel: 'SKU-1', confidence: 'high' },
      ],
    },
    conversationGrounding: {},
    baseReviewCards: [],
  })
  assert.match(visibleText(result.dataLimitations), /多个相关对象/)
  assert.equal(result.reviewCards[0].previewOnly, true)
  assert.equal(result.reviewCards[0].targetEntityId, 'PO-1')
})

test('unsafe disguised draft request is sanitized and keeps prohibited actions', () => {
  const card = buildContextualActionDraftReviewCardV2({
    message: '生成草稿并直接发给供应商，里面不要出现 provider token endpoint',
    intent: { id: 'unsafe_request' },
    target: { entityType: 'PO', entityId: 'PO-9', entityLabel: 'PO-9', confidence: 'high' },
  })
  assert.ok(card.prohibitedActions.includes('不外发'))
  assert.ok(card.prohibitedActions.includes('不处理资金'))
  assert.ok(card.prohibitedActions.includes('不写财务凭证'))
  assert.ok(card.prohibitedActions.includes('不改主数据'))
  assert.doesNotMatch(visibleText(card), forbiddenTechnical)
  assert.doesNotMatch(visibleText(card), forbiddenAction)
})

test('sanitize payload drops full response provider and secret-like fields', () => {
  const payload = sanitizeDraftPayloadV2({
    reason: '请生成草稿并发送',
    fullResponse: { text: 'hidden' },
    providerOutput: 'hidden',
    apiKey: 'hidden',
    token: 'hidden',
    env: 'hidden',
  })
  assert.equal(payload.fullResponse, undefined)
  assert.equal(payload.providerOutput, undefined)
  assert.equal(payload.apiKey, undefined)
  assert.equal(payload.token, undefined)
  assert.equal(payload.env, undefined)
  assert.match(payload.reason, /正式业务处理/)
})
