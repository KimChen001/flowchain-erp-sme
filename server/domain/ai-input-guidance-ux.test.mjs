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

// Design audit 2026-11-15 (L5-08 = L7-29): only the PO and supplier pages gave
// the assistant their record, and the report page offered the same questions
// as Today. Every record page now does, through its address when the page
// sets none, and a page without a record offers a question about what it shows.
test('R137 every record page gives the assistant its record, and a page without one a question of its own', () => {
  const appSource = readFileSync(new URL('../../src/app/FlowChainApp.tsx', import.meta.url), 'utf8')
  assert.match(appSource, /activeContext=\{aiActiveContext \|\| routeRecordContext\}/)
  assert.match(appSource, /const ASSISTANT_RECORD_TYPES = new Set\(\["supplier", "item", "rfq", "purchase_request", "purchase_order", "sales_order", "supplier_invoice", "receiving_doc"\]\)/)
  // The address holds the record's id, never a label.
  assert.doesNotMatch(appSource, /entityLabel: routeRecordId/)
  for (const type of ['supplier', 'purchase_request', 'rfq', 'supplier_invoice', 'receiving_doc', 'sales_order']) assert.match(panelSource, new RegExp(`\n  ${type}: \{ "en-US": "[^"]+\?", "zh-CN": "[^"]+？" \},`), type)
  for (const phrase of ['这张供应商发票', '这张收货单']) assert.match(panelSource, new RegExp(phrase))
  assert.match(panelSource, /const MODULE_EMPTY_PROMPT/)
  assert.match(panelSource, /reports: \{ "en-US": "What stands out in our numbers this month\?", "zh-CN": "这个月的数据里有什么值得注意的？" \}/)
  assert.match(panelSource, /\(currentContext \? null : MODULE_EMPTY_PROMPT\[moduleId\]\?\.\[language\]\)/)
})
