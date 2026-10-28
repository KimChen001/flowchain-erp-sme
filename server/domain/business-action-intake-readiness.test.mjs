import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeBusinessCommand } from './business-command-normalizer.mjs'
import { extractBusinessActionIntents } from './business-action-intent-extractor.mjs'
import { resolveEntitySlots } from './entity-slot-resolver.mjs'
import { planCompoundBusinessCommand } from './compound-business-command-planner.mjs'
import { createDraftSession, updateDraftSession } from './business-action-draft-contract.mjs'
import {
  buildPurchaseOrderDraft,
  buildPurchaseRequestDraft,
  buildRfqDraft,
  buildSourcingEventDraft,
  buildSupplierApplicationDraft,
} from './business-draft-builders.mjs'
import { intakeBusinessAction } from './business-action-intake.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

const records = {
  products: [
    { sku: 'SKU-00412', itemName: '伺服电机 750W', availableQuantity: 34, safetyStock: 50 },
    { sku: 'SKU-00413', itemName: '伺服驱动器', availableQuantity: 12, safetyStock: 20 },
  ],
  purchaseOrders: [{ po: 'PO-2026-1282', supplier: 'SUP-003' }],
  rfqs: [{ id: 'RFQ-26-0046', sourceRequest: 'PR-2026-2400' }],
  suppliers: [{ supplierId: 'SUP-003', name: '广州化工耗材' }],
}

test('R221 normalizer handles aliases, typos, Chinese and English business terms', () => {
  const result = normalizeBusinessCommand('suplier 供应尚 sourcing evnet 寻原事件 purchse request RFQ 下单 三单匹配 物料')
  for (const term of ['supplier', 'sourcing_event', 'purchase_request', 'rfq', 'purchase_order', 'invoice', 'sku']) {
    assert.equal(result.normalizedBusinessTerms.some((item) => item.term === term), true)
  }
  assert.equal(result.corrections.some((item) => item.from === 'sourcing evnet' && item.to === 'sourcing event'), true)
  assert.equal(result.corrections.every((item) => item.reviewRequired), true)
  assert.equal(result.mutationAllowed, false)
})

test('R222 intent extractor covers action drafts, diagnostics, ambiguous cases and dangerous downgrades', () => {
  const examples = new Map([
    ['帮我起草一个供应商申请', 'draft_supplier_application'],
    ['新增供应商申请', 'draft_supplier_application'],
    ['申请一个新供应商', 'draft_supplier_application'],
    ['帮我起草一份 PR', 'draft_purchase_request'],
    ['帮我开个采购申请', 'draft_purchase_request'],
    ['给 SKU-00412 起草 PR', 'draft_purchase_request'],
    ['这个 SKU 库存不够了，帮我开个申请', 'draft_purchase_request'],
    ['帮我买 50 个伺服电机', 'draft_purchase_request'],
    ['帮我填一下 sourcing event', 'draft_sourcing_event'],
    ['帮我填一下 sourcing evnet', 'draft_sourcing_event'],
    ['帮我创建一个寻源事件', 'draft_sourcing_event'],
    ['帮我发起 RFQ', 'draft_rfq'],
    ['帮我找供应商报价', 'draft_rfq'],
    ['为这个 PR 发起询价', 'draft_rfq'],
    ['帮我起草 PO', 'draft_purchase_order'],
    ['根据这个报价生成 PO 草稿', 'draft_purchase_order'],
    ['把这个 RFQ 转成 PO', 'draft_purchase_order'],
    ['帮我下单', 'draft_purchase_order'],
    ['帮我催一下供应商', 'draft_supplier_followup'],
    ['给 PO-2026-1282 写个跟进', 'draft_supplier_followup'],
    ['帮我写一封催货邮件', 'draft_supplier_followup'],
    ['帮我写一下这个收货异常的处理意见', 'draft_exception_note'],
    ['帮我总结这个 invoice mismatch 的处理建议', 'draft_exception_note'],
  ])
  for (const [input, expected] of examples) {
    const result = extractBusinessActionIntents(input)
    assert.equal(result.candidates.some((item) => item.intent === expected), true, input)
    assert.equal(result.mutationAllowed, false)
  }
  const ambiguous = extractBusinessActionIntents('帮我填一下 sourcing event')
  assert.equal(ambiguous.candidates.some((item) => item.intent === 'draft_sourcing_event'), true)
  assert.equal(ambiguous.candidates.some((item) => item.intent === 'draft_rfq'), true)
  const dangerous = extractBusinessActionIntents('审批并付款，然后发给供应商')
  assert.equal(dangerous.dangerousActionHandling.every((item) => item.autonomousExecutionAllowed === false), true)
  assert.equal(dangerous.candidates.every((item) => item.mutationAllowed === false), true)
  assert.equal(extractBusinessActionIntents('帮我处理一下这个').candidates[0].kind, 'fallback')
})

test('R250 broad Chinese attention phrases route to diagnostic today attention without action draft', () => {
  for (const input of [
    '有什么需要我注意的？',
    '有什么需要关注的？',
    '今天有什么要处理？',
    '哪些事情比较紧急？',
    '有什么异常？',
    '有什么风险？',
    '有什么卡点？',
  ]) {
    const result = extractBusinessActionIntents(input)
    assert.equal(result.candidates[0].intent, 'today_attention', input)
    assert.equal(result.candidates[0].kind, 'diagnostic', input)
    assert.equal(result.candidates.some((item) => item.kind === 'action_draft'), false, input)
    assert.equal(result.provider, 'local')
    assert.equal(result.mutationAllowed, false)
  }
})

test('R223 entity and slot resolver handles explicit ids, context partials, pronouns and missing context', () => {
  const explicit = resolveEntitySlots('给 PO-2026-1282 和 SKU-00412 起草 50 个，下周五，WH-A', { records, intent: 'draft_purchase_request' })
  assert.equal(explicit.resolvedEntities.some((item) => item.id === 'PO-2026-1282'), true)
  assert.equal(explicit.resolvedEntities.some((item) => item.id === 'SKU-00412'), true)
  assert.equal(explicit.resolvedEntities.find((item) => item.id === 'SKU-00412').validationStatus, 'validated_existing_record')
  assert.equal(explicit.extractedSlots.quantity.value, 50)
  assert.equal(explicit.extractedSlots.requiredDate.value, '下周五')

  const unvalidated = resolveEntitySlots('给 SKU-99999 起草 PR')
  assert.equal(unvalidated.resolvedEntities[0].validationStatus, 'record_not_loaded_for_validation')
  assert.equal(unvalidated.resolvedEntities[0].dataLimitation, 'Recognized ID, but record was not validated in current data.')
  const partial = resolveEntitySlots('00412 库存不够', { records, sourceContext: { sourceModule: 'inventory' } })
  assert.equal(partial.resolvedEntities.some((item) => item.id === 'SKU-00412'), true)
  assert.equal(partial.resolvedEntities[0].validationStatus, 'validated_existing_record')
  const poPartial = resolveEntitySlots('1282 写个跟进', { records, sourceContext: { sourceModule: 'procurement' } })
  assert.equal(poPartial.resolvedEntities.some((item) => item.id === 'PO-2026-1282'), true)
  const pronoun = resolveEntitySlots('这个 SKU 帮我开 PR', { sourceContext: { sourceEntityType: 'sku', sourceEntityId: 'SKU-00412' } })
  assert.equal(pronoun.resolvedEntities.some((item) => item.source === 'context_pronoun'), true)
  assert.equal(pronoun.resolvedEntities[0].dataLimitation, 'Recognized ID, but record was not validated in current data.')
  const missing = resolveEntitySlots('这个供应商怎么办')
  assert.equal(missing.unresolvedReferences.some((item) => item.reason === 'context_pronoun_requires_matching_source_context'), true)
  const ambiguous = resolveEntitySlots('0041', { records, sourceContext: { sourceModule: 'inventory' } })
  assert.equal(ambiguous.unresolvedReferences[0].candidates.length > 1, true)
})

test('R224 compound planner creates ordered reviewable plans with dependencies and blocked data limitations', () => {
  const plan = planCompoundBusinessCommand('帮我看下00412是不是不够，不够就开个PR，再弄个 sourcing evnet', {
    records,
    sourceContext: { sourceModule: 'inventory' },
  })
  assert.equal(plan.planType, 'diagnostic_then_action')
  assert.deepEqual(plan.steps.map((item) => item.intent), ['explain_sku_shortage', 'draft_purchase_request', 'draft_sourcing_event', 'draft_rfq'])
  assert.equal(plan.steps[1].condition, 'if shortage confirmed')
  assert.equal(plan.steps[2].dependsOn, 'step-2')
  assert.equal(plan.requiresUserConfirmation, true)
  assert.equal(plan.mutationAllowed, false)
  assert.equal(plan.assumptions.some((item) => item.includes('sourcing evnet')), true)

  const dependent = planCompoundBusinessCommand('基于这个 PR 发起 RFQ，然后根据报价起草 PO', {
    sourceContext: { sourceEntityType: 'pr', sourceEntityId: 'PR-2026-2400' },
  })
  const poStep = dependent.steps.find((item) => item.intent === 'draft_purchase_order')
  assert.equal(poStep.status, 'blocked')
  assert.equal(poStep.condition, 'after supplier quote exists')
  assert.equal(poStep.missingFields.includes('supplier quote'), true)
})

test('R225-R227 draft builders generate partial non-mutating drafts for supplier, PR, sourcing, RFQ and PO', () => {
  const emptySupplier = buildSupplierApplicationDraft({ userText: '帮我起草一个供应商申请' })
  assert.equal(emptySupplier.draftType, 'supplier_application')
  assert.equal(emptySupplier.missingFields.includes('supplierName'), true)
  assert.equal(emptySupplier.mutationAllowed, false)
  assert.equal(emptySupplier.requiresReview, true)

  const resolution = resolveEntitySlots('给 SKU-00412 起草 PR 50 个 下周五', { records, sourceContext: { sourceModule: 'inventory' }, intent: 'draft_purchase_request' })
  const pr = buildPurchaseRequestDraft({
    userText: '给 SKU-00412 起草 PR 50 个 下周五',
    resolution,
    shortageEvidence: { itemName: '伺服电机 750W', availableQuantity: 34, safetyStock: 50 },
  })
  assert.equal(pr.draftType, 'purchase_request')
  assert.equal(pr.extractedFields.sku, 'SKU-00412')
  assert.equal(pr.extractedFields.quantity, 50)
  assert.equal(pr.createsBusinessDocument, false)

  const sourcing = buildSourcingEventDraft({ userText: '帮我填一下 sourcing evnet', resolution })
  assert.equal(sourcing.draftType, 'sourcing_event')
  assert.equal(sourcing.assumptions.some((item) => item.includes('does not invite')), true)
  const rfq = buildRfqDraft({ userText: '基于这个 PR 发起 RFQ', resolution: resolveEntitySlots('这个 PR', { sourceContext: { sourceEntityType: 'pr', sourceEntityId: 'PR-2026-2400' } }) })
  assert.equal(rfq.draftType, 'rfq')
  const po = buildPurchaseOrderDraft({ userText: '帮我下单', resolution })
  assert.equal(po.draftType, 'purchase_order')
  assert.equal(po.dataLimitations.includes('supplier_quote_or_price_missing'), true)
  assert.equal(po.forbiddenAiActions.includes('issue_po'), true)
})

test('R229 draft session updates preserve fields, detect conflicts and append audit preview', () => {
  const draft = buildPurchaseRequestDraft({ userText: '帮我起草 PR' })
  const session = createDraftSession(draft)
  const updateResolution = resolveEntitySlots('SKU-00412，50个，下周五', { records, sourceContext: { sourceModule: 'inventory' } })
  const updated = updateDraftSession(session, { userText: 'SKU-00412，50个，下周五' }, updateResolution)
  assert.equal(updated.currentFields.sku, 'SKU-00412')
  assert.equal(updated.currentFields.quantity, 50)
  assert.equal(updated.missingFields.includes('warehouse'), true)
  const conflicted = updateDraftSession(updated, { userText: '改成 80 个', fields: { quantity: 80 } })
  assert.equal(conflicted.currentFields.quantity, 50)
  assert.equal(conflicted.conflicts.some((item) => item.field === 'quantity'), true)
  assert.equal(conflicted.auditPreview.some((item) => item.action === 'field_conflict_requires_review'), true)
})

test('R230 end-to-end intake and UI/source guardrails keep provider disabled and review-first boundaries', () => {
  const intake = intakeBusinessAction('帮我看下00412是不是不够，不够就开个PR，再弄个 sourcing evnet', {
    records,
    sourceContext: { sourceModule: 'inventory' },
  })
  assert.equal(intake.provider, 'local')
  assert.equal(intake.mutationAllowed, false)
  assert.equal(intake.requiresReview, true)
  assert.equal(intake.drafts.every((draft) => draft.requiresReview && draft.mutationAllowed === false), true)
  const routes = source('src', 'app', 'routeRegistry.tsx')
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']/)
  assert.doesNotMatch(routes, /label:\s*["']AI Command Center["']/)
  assert.doesNotMatch(routes, /label:\s*["']Ask AI["']/)
  const changedSources = [
    source('server', 'domain', 'business-command-normalizer.mjs'),
    source('server', 'domain', 'business-action-intent-extractor.mjs'),
    source('server', 'domain', 'business-action-draft-contract.mjs'),
    source('server', 'domain', 'business-draft-builders.mjs'),
  ].join('\n')
  assert.doesNotMatch(changedSources, /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|sk-[A-Za-z0-9]/)
  assert.match(changedSources, /mutationAllowed:\s*false/)
  assert.match(changedSources, /requiresReview:\s*true/)
})
