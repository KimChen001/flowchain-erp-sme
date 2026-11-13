import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panelSource = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')

test('R134 AI assistant empty state exposes business prompt chips', () => {
  assert.match(panelSource, /AI_EMPTY_STATE_PROMPT_CHIPS/)
  for (const label of ['今天先处理什么', '哪些采购订单逾期了', '帮我起草一份采购申请', '公司的采购制度是怎么规定的']) {
    assert.match(panelSource, new RegExp(label))
  }
  assert.match(panelSource, /data-testid="ai-empty-prompt-chip"/)
  assert.match(panelSource, /今天先处理什么？/)
})

test('R135 one assistant on every page: the placeholder offers the page record, the header names none', () => {
  assert.match(panelSource, /export function getAiInputPlaceholder/)
  assert.doesNotMatch(panelSource, /moduleId === "overview"/)
  for (const phrase of ['这个 PO', '这个 SKU', '这个询价单', '这个供应商']) assert.match(panelSource, new RegExp(phrase))
  assert.match(panelSource, /Ask about \$\{phrase\} or anything else, or tell me what to do…/)
  assert.match(panelSource, /"Ask a question, or tell me what to do…"/)
  assert.match(panelSource, /"问点什么，或让我帮你做…"/)
  // Owner, 2026-11-12: the assistant is one assistant for the whole ERP, not a
  // page's or a "workspace" of its own. The workspace cards stay on a record's
  // page, with one question about the record in the last place.
  assert.match(panelSource, /\[\.\.\.workspacePrompts\.slice\(0, 3\), recordPrompt\]/)
  assert.doesNotMatch(panelSource, /data-testid="ai-context-chip"|data-testid="ai-context-clear"|dismissedContextKey/)
  assert.doesNotMatch(panelSource, /AI 工作区|AI workspace|整个工作区|Whole workspace/)
  assert.match(panelSource, /"展开助手"/)
  assert.match(panelSource, /采购、销售、库存、财务都可以问/)
  assert.match(panelSource, /Ask about purchasing, sales, inventory or finance\./)
  // The header shows no "Scope:" line (panel design, 2026-11-01).
  assert.doesNotMatch(panelSource, /范围：|"Scope: "/)
  assert.doesNotMatch(panelSource, /routeById\(moduleId\)\?\.moduleLabel/)
})

test('R136 the panel has one path: every question streams to the model, with no rule chips or skill hints', () => {
  // Next steps come from the answer (its follow-up part), never from rules in the panel.
  assert.doesNotMatch(panelSource, /getAiFollowUpChips|skillHint|SKILL_HINTS|requestScopeLabel|AiResponseV2Renderer|postAiRuntimeResponse/)
  assert.match(panelSource, /streamAssistantV2\(/)
  // When the assistant cannot answer here, the welcome says why before the first question.
  assert.match(panelSource, /data-testid="ai-readiness-notice"/)
  assert.match(panelSource, /ai\.v2\.notice\.\$\{notice\}/)
})
