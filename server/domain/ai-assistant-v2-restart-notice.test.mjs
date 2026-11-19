import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { createScriptedModelClient } from './ai-assistant-v2-model/scripted.mjs'
import { answerAssistantV2 } from './ai-assistant-v2.mjs'
import { safeParseStreamEvent } from '../../shared/assistant-protocol.mjs'

// Design audit 2026-11-15, L5-07: after a restart, an expired thread or a
// permission change, a follow-up was answered on an empty thread while the
// panel still showed the conversation. The panel now sends its last turns;
// when the server kept no thread, the answer says it works from them.

const PREVIOUS = { previousTurns: [{ question: 'Which purchase orders are overdue?', answer: 'PO-001 and PO-008 are overdue.' }] }

async function ask({ thread = { messages: [], results: new Map() }, conversationContext } = {}) {
  const scenario = aiSkillScenario({ roleKey: 'workspace-administrator' })
  const events = []
  const outcome = await answerAssistantV2({ ...scenario.ctx, env: { FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5' } }, { threadId: 'thr_restart', message: 'Which of them is the oldest?', answerLanguage: 'en-US', ...(conversationContext ? { conversationContext } : {}) }, {
    emit: (event) => events.push(event),
    modelClient: createScriptedModelClient([[{ type: 'text_delta', text: 'PO-001 is the oldest.' }, { type: 'message_end', usage: { input_tokens: 1000, output_tokens: 20 } }]]),
    uiTools: [],
    thread,
  })
  return { ...outcome, events }
}
const notices = (events) => events.filter((event) => event.type === 'notice').map((event) => event.code)

test('a follow-up on a thread the server no longer holds says it works from the turns the panel sent', async () => {
  const restarted = await ask({ conversationContext: PREVIOUS })
  assert.deepEqual(notices(restarted.events), ['context_restarted'])
  restarted.events.forEach((event, seq) => assert.ok(safeParseStreamEvent({ v: 2, seq, ...event }).success, JSON.stringify(event)))
  assert.equal(restarted.body.conclusion.summary, 'PO-001 is the oldest.')
  // The thread the server kept: no notice, whatever the panel sent.
  const kept = await ask({ conversationContext: PREVIOUS, thread: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Which purchase orders are overdue?' }] }, { role: 'assistant', content: [{ type: 'text', text: 'PO-001 and PO-008 are overdue.' }] }], results: new Map() } })
  assert.deepEqual(notices(kept.events), [])
  // A first question: nothing to restart.
  assert.deepEqual(notices((await ask()).events), [])
})
