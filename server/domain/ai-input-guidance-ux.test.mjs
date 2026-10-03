import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panelSource = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')
const rendererSource = readFileSync(new URL('../../src/components/ai/AiResponseV2Renderer.tsx', import.meta.url), 'utf8')

test('R134 AI assistant empty state exposes business prompt chips', () => {
  assert.match(panelSource, /AI_EMPTY_STATE_PROMPT_CHIPS/)
  for (const label of ['今天先处理什么', '哪些事项风险最高', '哪些数据需要补齐', '帮我准备一个处理草稿']) {
    assert.match(panelSource, new RegExp(label))
  }
  assert.match(panelSource, /data-testid="ai-empty-prompt-chip"/)
  assert.match(panelSource, /今天先处理什么？/)
})

test('R135 the placeholder offers the page record next to the whole workspace, and the context can be cleared', () => {
  assert.match(panelSource, /export function getAiInputPlaceholder/)
  assert.match(panelSource, /moduleId === "overview"/)
  for (const phrase of ['这个 PO', '这个 SKU', '这个 RFQ', '这个供应商']) assert.match(panelSource, new RegExp(phrase))
  assert.match(panelSource, /Ask anything about your workspace, or about \$\{phrase\}/)
  // The record's chips are added to the workspace chips, never replace them.
  assert.match(panelSource, /\[\.\.\.recordPrompts\.slice\(0, 2\), \.\.\.workspacePrompts\.slice\(0, 2\)\]/)
  assert.match(panelSource, /data-testid="ai-context-chip"/)
  assert.match(panelSource, /data-testid="ai-context-clear"/)
  // The scope is the whole workspace on every page; a record's page only adds the record.
  assert.match(panelSource, /范围：/)
  assert.match(panelSource, /Whole workspace/)
  assert.doesNotMatch(panelSource, /routeById\(moduleId\)\?\.moduleLabel/)
})

test('R136 follow-up chips are distinct from review-first recommended actions', () => {
  assert.match(panelSource, /export function getAiFollowUpChips/)
  assert.match(panelSource, /data-testid="ai-follow-up-chip"/)
  assert.match(panelSource, /为什么这个 PO 优先？/)
  assert.match(panelSource, /查看关联 SKU/)
  assert.match(panelSource, /哪些数据不完整？/)
  assert.match(panelSource, /Which data is incomplete\?/)
  assert.match(panelSource, /预览供应商提醒草稿/)
  assert.match(panelSource, /Preview supplier reminder/)
  assert.match(panelSource, /rag\?\.mode === "no_results"/)
  assert.match(panelSource, /getAiFollowUpChips\(message, language\)/)
  assert.match(rendererSource, /ai-action-draft-preview/)
})
