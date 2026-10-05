import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('action draft review shell is limited to text drafts and has no generic reviewed-record action', () => {
  const shell = readSource('src', 'modules', 'action-drafts', 'ActionDraftReviewShell.tsx')
  const planPanel = readSource('src', 'modules', 'action-drafts', 'BusinessActionPlanPanel.tsx')

  assert.match(shell, /export function ActionDraftReviewShell/)
  assert.match(shell, /文本草稿编辑器：仅用于供应商消息或内部备注，不替代正式业务页面/)
  assert.match(shell, /预览 \/ 留存边界/)
  assert.match(planPanel, /不会自动提交审批/)
  assert.match(planPanel, /不会下发 PO/)
  assert.match(planPanel, /不会发送邮件/)
  assert.match(planPanel, /不会授标/)
  assert.match(planPanel, /不会自动库存或发票过账/)
  assert.match(shell, /draftButtonClass = `h-8 rounded-lg px-3 \$\{typography\.denseButton\} disabled:cursor-not-allowed`/)
  assert.match(shell, /取消草稿/)
  assert.match(shell, /重置修改/)
  assert.match(shell, /保留待复核草稿/)
  assert.doesNotMatch(shell, /记录复核结果|confirmed-action-boundary|onConfirmSafeAction/)
  assert.match(shell, /复制草稿内容/)
  assert.doesNotMatch(shell, /JSON\.stringify/)
})

test('action draft review shell renders business payload, validation, audit, and evidence safely', () => {
  const shell = readSource('src', 'modules', 'action-drafts', 'ActionDraftReviewShell.tsx')

  assert.match(shell, /function businessValue/)
  assert.match(shell, /function payloadLabel/)
  assert.match(shell, /function isEditableScalar/)
  assert.match(shell, /function editValue/)
  assert.match(shell, /updatePayloadField/)
  assert.match(shell, /normalizeEvidenceLinks\(activeDraft\?\.originEvidence \|\| \[\], \{ source: "actionDraft" \}\)/)
  assert.match(shell, /navigationIntentFromEvidenceLink\(link, \{ source: "actionDraft" \}\)/)
  assert.match(shell, /onNavigate\(intent\.activeId, intent\.focusTarget \|\| null\)/)
  assert.match(shell, /需要补充或人工复核/)
  assert.match(shell, /审计预览/)
})

test('structured AI drafts use formal pages while text drafts retain the editor', () => {
  const app = readSource('src', 'app', 'FlowChainApp.tsx')
  const cockpit = readSource('src', 'modules', 'overview', 'TodayCockpitPanel.tsx')
  const ai = readSource('src', 'components', 'ai', 'AiResponseV2Renderer.tsx')
  const inventory = readSource('src', 'modules', 'inventory', 'Page.tsx')

  assert.match(app, /\/api\/action-drafts\/preview/)
  assert.match(app, /\/api\/action-drafts\/save/)
  assert.match(app, /<ActionDraftReviewShell/)
  assert.match(app, /onSaveDraft=\{saveActionDraftReview\}/)
  assert.doesNotMatch(app, /onConfirmSafeAction=\{confirmSafeActionDraft\}|\/api\/user-confirmed-actions/)
  // Structured drafts open a creation screen through one helper. An RFQ starts
  // from an approved purchase request, so an RFQ draft opens that form.
  const handoff = readSource('src', 'modules', 'action-drafts', 'structuredDraftHandoff.ts')
  assert.match(app, /if \(isStructuredDraftType\(request\.type\)\)/)
  assert.match(app, /structuredDraftTarget\(request\.type, request\.payload, request\.source\)/)
  assert.match(handoff, /type === "purchase_request_draft" \|\| type === "rfq_draft" \|\| type === "task_draft"/)
  assert.match(handoff, /"procurement:requests"/)
  assert.match(handoff, /intent: type === "rfq_draft" \? "rfq" : undefined/)
  assert.doesNotMatch(handoff, /procurement:rfq/)
  assert.match(app, /createsBusinessDocument/)
  assert.match(cockpit, /草稿预览/)
  assert.match(cockpit, /actionDraftRequest\(item\)/)
  assert.match(ai, /const target = structuredDraftTarget\(action\.card\.draftType \|\| "", action\.card\.payload, "ai_assistant"\)/)
  assert.match(ai, /onClick=\{\(\) => onReviewActionDraft\(request\)\}/)
  assert.match(inventory, /<EntityLink kind="item"/)
  assert.doesNotMatch(inventory, /\/api\/master-data\/items\/.*\/suppliers/)
  assert.doesNotMatch(inventory, /维护供应商关系/)
  assert.doesNotMatch(inventory, /inventory_replenishment|预览 PR/)
  assert.doesNotMatch(app, /\/api\/purchase-requests/)
})
