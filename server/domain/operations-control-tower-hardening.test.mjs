import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildGrnDraft,
  buildInventoryMovementDraft,
  buildReceivingExceptionCaseDraft,
  confirmReceivingRecord,
  detectReceivingExceptions,
  evaluateReceivingSource,
  previewInventoryBalanceImpact,
  RECEIVING_INVENTORY_BASELINE,
} from './receiving-inventory-ledger.mjs'
import {
  buildInvoiceExceptionCaseDraft,
  buildInvoiceMatchingRiskSummary,
  buildInvoiceMatchReviewDraft,
  normalizeInvoiceMatchStatus,
  normalizeInvoiceVarianceType,
  resolveThreeWayMatchEvidence,
  saveFinanceCollaborationNote,
  INVOICE_MATCHING_BASELINE,
} from './invoice-matching-review.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const read = (...parts) => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')

const issuedPo = {
  po: 'PO-R271-1',
  status: '已发出',
  supplier: 'Fast Precision',
  sourceSku: 'SKU-R271',
  sourceName: 'Servo Motor',
  items: 100,
  received: 20,
  unit: 'pcs',
  eta: '2026-07-10',
}

test('R271-R273 receiving baseline eligibility and GRN draft block PO Drafts', () => {
  assert.ok(RECEIVING_INVENTORY_BASELINE.inspectedFiles.includes('server/routes/receiving.routes.mjs'))
  const eligible = evaluateReceivingSource(issuedPo)
  assert.equal(eligible.eligible, true)
  assert.equal(eligible.sourceType, 'partially_received_po')
  assert.equal(eligible.openQuantity, 80)

  assert.equal(evaluateReceivingSource({ po: 'PO-DRAFT-1', status: 'draft', items: 10 }).eligible, false)
  assert.equal(evaluateReceivingSource({ po: 'PO-CANCEL', status: '已取消', items: 10 }).eligible, false)
  assert.equal(evaluateReceivingSource({ po: 'PO-DONE', status: '已完成', items: 10, received: 10 }).eligible, false)
  assert.ok(evaluateReceivingSource({ po: 'PO-MISS', status: '已发出' }).dataLimitations.includes('missing_ordered_quantity'))

  const grn = buildGrnDraft({ po: issuedPo, receivedQuantity: 80, warehouse: 'WH-A', location: 'BIN-1', qualityStatus: 'accepted' })
  assert.equal(grn.ok, true)
  assert.equal(grn.draft.sourcePoId, 'PO-R271-1')
  assert.equal(grn.draft.boundary.doesNotPostReceiving, true)
  assert.equal(grn.draft.boundary.doesNotUpdateInventoryBalance, true)
  assert.equal(grn.sideEffects.postsInventory, false)

  const missing = buildGrnDraft({ po: issuedPo, receivedQuantity: 80 })
  assert.ok(missing.draft.missingFields.includes('warehouse'))
  assert.equal(buildGrnDraft({ po: { po: 'PO-DRAFT-2', status: 'draft', items: 10 } }).blocked, true)
})

test('R312 receiving source eligibility is strict and only explicit receivable statuses pass', () => {
  const base = { po: 'PO-R312', supplier: 'Fast Precision', sourceSku: 'SKU-R312', items: 10, received: 0 }
  for (const status of ['issued', 'partially_received', 'ready_for_receiving', '已发出', '部分到货']) {
    const result = evaluateReceivingSource({ ...base, status, received: status === 'partially_received' || status === '部分到货' ? 4 : 0 })
    assert.equal(result.eligible, true, status)
  }

  for (const status of ['draft', '草稿', 'pending_review', 'review_required', 'approval_required', 'approved_not_issued', 'ready_for_manual_issue', 'created', 'unknown', 'closed', 'cancelled', 'fully_received', 'completed', '已取消', '已关闭', '已完成', '已收货', '待审批', '已驳回']) {
    const result = evaluateReceivingSource({ ...base, status })
    assert.equal(result.eligible, false, status)
    assert.ok(result.reason, status)
    assert.equal(buildGrnDraft({ po: { ...base, status } }).blocked, true, status)
  }

  const missingPo = evaluateReceivingSource({ status: 'issued', sourceSku: 'SKU-R312', items: 10 })
  assert.equal(missingPo.eligible, false)
  assert.ok(missingPo.dataLimitations.includes('missing_po_id'))

  const missingQuantityAndSku = evaluateReceivingSource({ po: 'PO-R312-MISSING', status: 'issued' })
  assert.equal(missingQuantityAndSku.eligible, true)
  assert.ok(missingQuantityAndSku.dataLimitations.includes('missing_ordered_quantity'))
  assert.ok(missingQuantityAndSku.dataLimitations.includes('missing_sku'))
})

test('R274-R277 receiving confirmation exceptions inventory movement and balance preview remain non-mutating', () => {
  const draft = buildGrnDraft({ po: issuedPo, receivedQuantity: 90, warehouse: 'WH-A', location: 'BIN-1', qualityStatus: 'quality_hold' }).draft
  assert.deepEqual(confirmReceivingRecord({ draft }).errors, ['missing_confirmation'])
  assert.ok(confirmReceivingRecord({ draft: buildGrnDraft({ po: { po: 'PO-DRAFT', status: 'draft', items: 10 } }).draft || {}, confirm: true }).errors.includes('source_po_not_eligible'))

  const confirmed = confirmReceivingRecord({ draft, confirm: true, actor: 'receiver-a' })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.record.status, 'received_pending_inventory_review')
  assert.equal(confirmed.sideEffects.postsInventory, false)
  assert.equal(confirmed.sideEffects.updatesStockBalance, false)
  assert.equal(confirmed.sideEffects.closesPo, false)

  const exceptions = detectReceivingExceptions({ draft, existingGrns: [{ grn: 'GRN-OLD', po: 'PO-R271-1' }], expectedDate: '2026-07-01' })
  assert.ok(exceptions.exceptions.some((item) => item.exceptionType === 'over_receipt'))
  assert.ok(exceptions.exceptions.some((item) => item.exceptionType === 'quality_hold'))
  assert.ok(exceptions.exceptions.some((item) => item.exceptionType === 'duplicate_receiving_risk'))
  const caseDraft = buildReceivingExceptionCaseDraft({ draft, detected: exceptions })
  assert.equal(caseDraft.autoCreateCase, false)
  assert.equal(caseDraft.mutationAllowed, false)

  const movement = buildInventoryMovementDraft({ receivingRecord: confirmed.record, currentBalance: { available: 50, onHand: 55, held: 0 } })
  assert.equal(movement.movementType, 'hold')
  assert.equal(movement.boundary.doesNotPostInventory, true)
  assert.equal(movement.expectedBalanceImpact.availableImpact, 0)
  assert.equal(movement.sideEffects.updatesStockBalance, false)
  assert.equal(previewInventoryBalanceImpact({ currentBalance: {}, movementType: 'receipt', quantity: 5 }).confidence, 'low')
  assert.ok(previewInventoryBalanceImpact({ currentBalance: { available: 1, onHand: 1 }, movementType: 'adjustment', quantity: -5 }).warnings.includes('negative_projected_available'))
})

test('R281-R290 invoice matching review detects variances and blocks approval payment posting', () => {
  assert.ok(INVOICE_MATCHING_BASELINE.inspectedFiles.includes('src/domain/procurement/invoice-matching.ts'))
  assert.equal(normalizeInvoiceMatchStatus('variance_review'), 'variance_review')
  assert.equal(normalizeInvoiceVarianceType('missing_grn'), 'missing_grn')
  assert.throws(() => normalizeInvoiceMatchStatus('approved'))

  const evidence = resolveThreeWayMatchEvidence({
    invoice: { invoiceNumber: 'INV-R281-1', relatedPo: 'PO-R271-1', amount: 1300, quantity: 12, invoiceDate: '2026-07-01', supplier: 'Fast Precision' },
    po: { po: 'PO-R271-1', amount: 1000, supplier: 'Fast Precision' },
    grn: { grn: 'GRN-R271-1', acceptedQty: 10, arrived: '2026-07-03' },
  })
  assert.equal(evidence.status, 'variance_review')
  assert.ok(evidence.variances.some((item) => item.type === 'price_variance'))
  assert.ok(evidence.variances.some((item) => item.type === 'quantity_variance'))
  assert.ok(evidence.variances.some((item) => item.type === 'invoice_before_receipt'))

  const draft = buildInvoiceMatchReviewDraft({ evidence })
  assert.equal(draft.boundary.noApproval, true)
  assert.equal(draft.boundary.noPayment, true)
  assert.equal(draft.boundary.noPosting, true)
  assert.equal(saveFinanceCollaborationNote({ draft, note: 'Review variance' }).ok, false)
  assert.equal(saveFinanceCollaborationNote({ draft, note: 'Review variance', confirm: true }).ok, true)
  assert.equal(buildInvoiceExceptionCaseDraft({ draft }).autoCreateCase, false)
  assert.equal(buildInvoiceMatchingRiskSummary({ evidence }).category, 'invoice_mismatch')
  assert.equal(draft.sideEffects.approvesInvoice, false)
  assert.equal(draft.sideEffects.paysInvoice, false)
  assert.equal(draft.sideEffects.postsInvoice, false)
})

test('R280/R290/R300 source guardrails preserve boundaries no keys and no standalone AI nav', () => {
  const domainSource = [
    read('server', 'domain', 'receiving-inventory-ledger.mjs'),
    read('server', 'domain', 'invoice-matching-review.mjs'),
  ].join('\n')
  const uiSource = [
    read('src', 'app', 'routeRegistry.tsx'),
    read('src', 'modules', 'receiving', 'ReceivingPostingWorkbench.tsx'),
    read('src', 'modules', 'inventory', 'Page.tsx'),
    read('src', 'modules', 'srm', 'Page.tsx'),
    read('src', 'components', 'ai', 'ContextualAIInsightPanel.tsx'),
    read('src', 'modules', 'action-drafts', 'ActionDraftReviewShell.tsx'),
  ].join('\n')
  const all = [domainSource, uiSource].join('\n')
  const app = read('src', 'app', 'FlowChainApp.tsx')
  const relationships = read('src', 'domain', 'relationships', 'resolver.ts')
  const procurement = read('server', 'domain', 'procurement-transaction-core.mjs')
  const confirmed = read('server', 'domain', 'user-confirmed-business-action.mjs')

  assert.doesNotMatch(all, /OPENAI_API_KEY|ARK_API_KEY|sk-[A-Za-z0-9]{20,}/)
  assert.doesNotMatch(app, /AI Command Center|standalone-ai/i)
  assert.doesNotMatch(all, /postsInventory:\s*true|updatesStockBalance:\s*true|approvesInvoice:\s*true|paysInvoice:\s*true|issuesPo:\s*true|mutatesSupplierMaster:\s*true|sendsExternalEmail:\s*true/)
  assert.match(procurement, /doesNotAwardSupplier/)
  assert.match(confirmed, /post_inventory_movement/)
  assert.match(confirmed, /award_supplier/)
  assert.match(relationships, /resolveEntityRelationships/)
  assert.doesNotMatch(relationships, /fetch\(|apiJson|POST|PATCH/)
  assert.doesNotMatch(all, /SKU-00412.*exception/i)
  assert.match(uiSource, /label: "收货记录"/)
  assert.match(uiSource, /管理采购到货、质检与入库记录/)
  assert.match(uiSource, /打印入库单/)
  assert.doesNotMatch(uiSource, /收货复核边界/)
  assert.match(uiSource, /EntityLink/)
  assert.match(uiSource, /需补货/)
  assert.match(uiSource, /质检/)
  assert.match(uiSource, /可用量/)
  assert.match(uiSource, /风险与异常/)
  assert.match(uiSource, /供应商跟进备注草稿/)
  assert.match(uiSource, /新增供应商关系/)
  assert.match(uiSource, /设为首选/)
  assert.match(uiSource, /暂无采购交易记录/)
  for (const forbidden of [
    /Operations Control Tower/,
    /Receiving Review Boundary/,
    /Invoice Matching Review/,
    /Supplier Risk Evidence/,
    /Create case draft/,
    /Preview follow-up note/,
    /Explain evidence/,
    /draft only/i,
    /preview only/i,
    /no approval\/payment\/posting/i,
    /requiresReview:\s*true\s*·/i,
  ]) {
    assert.doesNotMatch(uiSource, forbidden)
  }
  for (const line of uiSource.split('\n')) {
    assert.doesNotMatch(line, /["'`][^"'`]*mutationAllowed/i)
  }
})
