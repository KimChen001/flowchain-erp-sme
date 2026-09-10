import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panelSource = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')

test('R134 AI assistant empty state exposes business prompt chips', () => {
  assert.match(panelSource, /AI_EMPTY_STATE_PROMPT_CHIPS/)
  for (const label of ['今天先处理什么', '哪些事项风险最高', '哪些数据需要补齐', '帮我准备一个处理草稿']) {
    assert.match(panelSource, new RegExp(label))
  }
  assert.match(panelSource, /data-testid="ai-empty-prompt-chip"/)
  assert.match(panelSource, /今天先处理什么？/)
})

test('R135 context-aware placeholder helper covers Today PO SKU RFQ and Supplier', () => {
  assert.match(panelSource, /export function getAiInputPlaceholder/)
  assert.match(panelSource, /moduleId === "overview"/)
  assert.match(panelSource, /这个 PO 为什么优先/)
  assert.match(panelSource, /这个 SKU 需要补货吗/)
  assert.match(panelSource, /这个 RFQ 有几家回复/)
  assert.match(panelSource, /这个供应商有哪些风险/)
  assert.match(panelSource, /data-testid="ai-context-chip"/)
  assert.match(panelSource, /当前上下文：/)
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
  assert.match(panelSource, /ai-action-draft-preview/)
})
