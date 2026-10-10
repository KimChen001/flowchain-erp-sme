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
import { runAiSkillRuntime } from './ai-skill-runtime.mjs'

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
    import { autoOpenDraftCard, structuredDraftTarget } from './src/modules/action-drafts/structuredDraftHandoff.ts'
    export const render = (response) => renderToStaticMarkup(createElement(AiResponseV2Renderer, { response, onNavigate: () => {}, onReviewActionDraft: () => {}, onFollowUp: () => {} }))
    export { aiRecoveryReason, displaySafeAssistantRecoveryMessage, ApiError, autoOpenDraftCard, structuredDraftTarget }
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
    // The help answer reads no business data and says so.
    assert.match(markup, skillId === 'capability_overview' ? /No workspace data was read for this answer/ : /Answered from your workspace data/, skillId)
  }
  // The help answer reads no records: no "Verifiable records 0" line.
  assert.doesNotMatch(client.render(answer('capability_overview')), /Verifiable records/)
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

test('an order answer names each request button, and only a clear choice is opened on arrival', async () => {
  const client = await loadClient()
  const scenario = aiSkillScenario()
  const covered = await runAiSkillRuntime({ ...scenario.ctx, env: {} }, { message: 'can you help me generate the order?', answerLanguage: 'en-US' })
  const markup = client.render(covered)
  assert.doesNotMatch(markup, CJK)
  assert.match(markup, /data-action-kind="generate_text_draft"[^>]*>Draft a follow-up on PO-001</)
  assert.match(markup, /data-action-kind="create_formal_business_draft"[^>]*>Open a request for LDM-001 anyway</)
  assert.equal(client.autoOpenDraftCard(covered.reviewCards), null)
  const named = await runAiSkillRuntime({ ...scenario.ctx, env: {} }, { message: 'Create a purchase order for LDM-001', answerLanguage: 'en-US' })
  const card = client.autoOpenDraftCard(named.reviewCards)
  assert.equal(card.draftType, 'purchase_request_draft')
  // The same handoff the button makes: the request form, filled in.
  assert.deepEqual(client.structuredDraftTarget(card.draftType, card.payload, 'ai_assistant'), {
    moduleId: 'procurement:requests',
    query: { mode: 'create', itemId: 'LDM-001', sku: 'LDM-001', quantity: '12', reason: '28 available against a target of 40; this is on top of what is already on order.', origin: 'ai_assistant' },
  })
  assert.match(client.render(named), /data-action-kind="create_formal_business_draft"[^>]*>Open request: 12 pcs of LDM-001</)
  // A text draft is never opened on arrival.
  assert.equal(client.autoOpenDraftCard([{ draftType: 'po_followup_draft', autoOpen: true }]), null)
})

test('a compound answer renders a section per part in place of the summary and the priorities', async () => {
  const client = await loadClient()
  const scenario = aiSkillScenario()
  const response = await runAiSkillRuntime({ ...scenario.ctx, env: {} }, { message: 'Which purchase orders are overdue, and what is available for LDM-001?', answerLanguage: 'en-US' })
  assert.equal(response.intent, 'compound')
  const markup = client.render(response)
  assert.doesNotMatch(markup, CJK)
  assert.match(markup, /data-testid="ai-answer-sections"/)
  assert.match(markup, />Answer by part</)
  assert.deepEqual([...markup.matchAll(/data-testid="ai-answer-section" data-skill="([a-z_]+)"/g)].map((match) => match[1]), ['purchase_orders', 'inventory_availability'])
  assert.match(markup, /LDM-001: 63 pcs available to promise/)
  assert.equal(markup.includes(response.conclusion.summary), false, 'the summary repeats the section titles and is not shown')
  assert.doesNotMatch(markup, /data-testid="ai-focused-primary-items"/)
  // A one-part answer still shows its summary and priorities.
  const single = client.render((await answers())('today_priorities'))
  assert.match(single, /data-testid="ai-focused-primary-items"/)
  assert.doesNotMatch(single, /data-testid="ai-answer-sections"/)
})

// The walkthrough on 2026-10-09: a Chinese question on the English interface
// got a Chinese answer inside English labels ("Priorities", "Impact:", "Next
// step"). The card's labels follow the answer's language.
test("a Chinese answer on the English interface gets Chinese labels, and no count of nothing", async () => {
  const client = await loadClient()
  const answer = await answers()
  const chinese = client.render(answer('today_priorities', { language: 'zh-CN' }))
  for (const label of ['重点事项', '影响：', '下一步', '可核验业务证据']) assert.ok(chinese.includes(label), label)
  for (const label of ['Priorities', 'Impact:', 'Next step', 'Verifiable records', 'View key evidence']) assert.ok(!chinese.includes(label), label)
  const english = client.render(answer('today_priorities'))
  assert.match(english, /Verifiable records 5/)
  // "System notes 0" says nothing, so it is not shown.
  assert.doesNotMatch(english, /System notes 0/)
  assert.doesNotMatch(chinese, /系统说明 0/)
})
