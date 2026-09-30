import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'

// Renders the assistant's answer card and recovery message as the browser
// would, in the default English interface: esbuild bundles the client modules
// and react-dom/server renders them. No Chinese may reach the markup.

const CJK = /[㐀-鿿]/
const root = resolve(import.meta.dirname, '../..')

async function loadClient() {
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-ai-renderer-'))
  const entry = `
    import { createElement } from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { AiResponseV2Renderer } from './src/components/ai/AiResponseV2Renderer.tsx'
    import { aiRecoveryReason, displaySafeAssistantRecoveryMessage } from './src/modules/ai-assistant/Panel.tsx'
    import { ApiError } from './src/lib/api-client.ts'
    export const render = (response) => renderToStaticMarkup(createElement(AiResponseV2Renderer, { response, onNavigate: () => {}, onReviewActionDraft: () => {}, onFollowUp: () => {} }))
    export { aiRecoveryReason, displaySafeAssistantRecoveryMessage, ApiError }
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx', sourcefile: 'renderer-entry.tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  })
  const file = join(directory, 'renderer.cjs')
  // A self-contained bundle: react, react-dom and the icons are inlined.
  await writeFile(file, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(file).href)).default
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function answers() {
  const scenario = aiSkillScenario()
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  return (skillId, extra = {}) => answerAiSkill({ skillId, facts: skillId === 'capability_overview' ? null : facts, language: 'en-US', query: 'q', actor: scenario.actor, ...extra }).response
}

test('an English skill answer renders with no Chinese, the source badge and the checked line', async () => {
  const client = await loadClient()
  const answer = await answers()
  for (const skillId of ['today_priorities', 'highest_risk_items', 'records_needing_data', 'prepare_action_draft', 'workspace_metrics', 'capability_overview']) {
    const markup = client.render(answer(skillId))
    assert.doesNotMatch(markup, CJK, `${skillId} renders without Chinese`)
    assert.match(markup, /data-answer-source="workspace_rules"/, skillId)
    assert.match(markup, /Answered from your workspace data/, skillId)
  }
  const today = client.render(answer('today_priorities'))
  assert.match(today, /Checked: purchase orders, purchase requests, RFQs, inventory balances, supplier invoices and receipts/)
  assert.match(today, /Verifiable records 5/)
  assert.match(today, /View key evidence \(5\)/)
  assert.match(today, />Risk</)
  const drafts = client.render(answer('prepare_action_draft'))
  assert.match(drafts, /data-action-kind="generate_text_draft"[^>]*>Review draft</)

  // The recovery message follows the interface language and the failure.
  const { ApiError, aiRecoveryReason, displaySafeAssistantRecoveryMessage } = client
  const unavailable = displaySafeAssistantRecoveryMessage('What should I handle first today?', 'en-US', aiRecoveryReason(new ApiError(503, { code: 'AI_SKILL_UNAVAILABLE', error: 'x' }, 'x'), false))
  assert.doesNotMatch(unavailable, CJK)
  assert.match(unavailable, /could not read your workspace data just now/)
  assert.match(displaySafeAssistantRecoveryMessage('q', 'en-US', aiRecoveryReason(new Error('aborted'), true)), /took too long/)
  assert.match(displaySafeAssistantRecoveryMessage('q', 'en-US', aiRecoveryReason(new ApiError(401, { code: 'AUTHENTICATION_REQUIRED' }, ''), false)), /Sign in again/)
  assert.match(displaySafeAssistantRecoveryMessage('q', 'en-US', aiRecoveryReason(new ApiError(400, { code: 'AI_QUESTION_TOO_SHORT', error: 'Enter a question of at least two characters.' }, ''), false)), /Enter a question of at least two characters\./)
  assert.match(displaySafeAssistantRecoveryMessage('q', 'zh-CN', aiRecoveryReason(new ApiError(503, {}, ''), false)), /当前工作区数据暂时未能完整读取/)
})
