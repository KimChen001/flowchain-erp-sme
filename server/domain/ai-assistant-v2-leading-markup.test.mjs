import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { createScriptedModelClient } from './ai-assistant-v2-model/scripted.mjs'
import { answerAssistantV2 } from './ai-assistant-v2.mjs'
import { aiV2TextTidier } from './ai-assistant-v2-display.mjs'
import { tidyProblems } from '../../tests/ai-eval/v2-public/score.mjs'

// 2026-11-14 on DeepSeek V4.1 Flash, the money questions of the UCI question
// set: the answer to "Which deliveries have we received but not been invoiced
// for yet?" opened with an XML declaration, shown to the user as written, and
// the tidy check passed it.
const ANSWER = '<?xml version="1.0"?>\nFour posted receipts have no supplier invoice against them yet, worth £3,734.53 in all.'
const WORDS = 'Four posted receipts have no supplier invoice against them yet, worth £3,734.53 in all.'

test('an XML declaration before the answer\'s words is taken off; quoted markup is left as written', () => {
  const tidier = aiV2TextTidier({ language: 'en-US' })
  assert.equal(tidier.tidy(ANSWER, ''), WORDS)
  assert.equal(aiV2TextTidier({ language: 'zh-CN' }).tidy('<?xml version="1.0" encoding="UTF-8"?>\n\n有 4 张已过账的收货单还没有供应商发票。', ''), '有 4 张已过账的收货单还没有供应商发票。')
  // Only at the start of a text part: a declaration the answer quotes later,
  // or inside a code block, stays.
  assert.equal(tidier.tidy('<?xml version="1.0"?>\n<order id="PO-1"/>', 'The supplier\'s file starts:\n'), '<?xml version="1.0"?>\n<order id="PO-1"/>')
  assert.equal(tidier.tidy('```xml\n<?xml version="1.0"?>\n```', ''), '```xml\n<?xml version="1.0"?>\n```')
  // Nothing else at the start is touched.
  assert.equal(tidier.tidy('<b>Four</b> receipts are not invoiced.', ''), '<b>Four</b> receipts are not invoiced.')
})

test('the answer streams and folds without the declaration', async () => {
  const scenario = aiSkillScenario({ roleKey: 'workspace-administrator' })
  const events = []
  const outcome = await answerAssistantV2({ ...scenario.ctx, env: { FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5' } }, { threadId: 'thr_markup', message: 'Which deliveries have we received but not been invoiced for yet?', answerLanguage: 'en-US' }, {
    emit: (event) => events.push(event),
    modelClient: createScriptedModelClient([[{ type: 'text_delta', text: '<?xml version="1.0"?>\n' }, { type: 'text_delta', text: WORDS }, { type: 'message_end', usage: { input_tokens: 1000, output_tokens: 50 } }]]),
    uiTools: [],
    thread: { messages: [], results: new Map() },
  })
  const shown = events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')
  assert.doesNotMatch(shown, /<\?xml/)
  assert.match(shown, /^Four posted receipts/)
  assert.doesNotMatch(outcome.body.conclusion.summary, /<\?xml/)
})

test('the question set\'s tidy check reports an answer that opens with markup', () => {
  assert.deepEqual(tidyProblems(ANSWER), ['opens with <?xml version="1.0"?>'])
  assert.deepEqual(tidyProblems(WORDS), [])
})
