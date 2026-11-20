import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { runAiReadTool } from './ai-read-tool-runner.mjs'
import { createScriptedModelClient } from './ai-assistant-v2-model/scripted.mjs'
import { answerAssistantV2 } from './ai-assistant-v2.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS } from './ai-assistant-v2-ui-tools.mjs'
import { aiCalculationGrounded, checkAiModelFirstGrounding } from './ai-model-first-grounding.mjs'
import { FLAG_CASES } from '../../tests/ai-eval/v2-public/flag-cases.mjs'

// Design audit 2026-11-15, batch C11 ("核对诚实度与评测"): what the answer check
// and the question set claim to have checked.

const ENV = Object.freeze({ FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5' })
const USAGE = Object.freeze({ input_tokens: 1000, output_tokens: 50 })
const say = (...pieces) => pieces.map((piece) => ({ type: 'text_delta', text: piece }))
const call = (id, name, input) => [{ type: 'tool_use_start', id, name }, { type: 'tool_use_end', id, name, input }]
const end = () => ({ type: 'message_end', usage: USAGE })
const numbers = (problems) => problems.filter((row) => row.kind === 'number').map((row) => row.value)

async function ask(turns, question) {
  const scenario = aiSkillScenario({ roleKey: 'workspace-administrator' })
  const events = []
  const outcome = await answerAssistantV2({ ...scenario.ctx, env: ENV }, { threadId: 'thr_honesty', message: question, answerLanguage: 'en-US' }, {
    emit: (event) => events.push(event), modelClient: createScriptedModelClient(turns), uiTools: [], thread: { messages: [], results: new Map() },
  })
  return { ...outcome, events, flagged: events.filter((event) => event.type === 'flag').flatMap((event) => event.spans.map((span) => span.text)) }
}

// L5-03 probe 1: the price read was 2.95; the model typed 2.59 into calculate,
// and its result counted as a source, so the wrong cost passed the check.
test('a calculation whose values the results and the question do not hold is not a source', async () => {
  const results = [{ sku: '85123A', unitPrice: 2.95, currency: 'GBP' }]
  assert.equal(aiCalculationGrounded({ operation: 'product', values: [2.59, 100] }, { results, question: 'What would 100 of 85123A cost?' }), false)
  assert.equal(aiCalculationGrounded({ operation: 'product', values: [2.95, 100] }, { results, question: 'What would 100 of 85123A cost?' }), true)
  // Several calculations: each value is checked; a date-only one has none.
  assert.equal(aiCalculationGrounded({ calculations: [{ operation: 'sum', values: [2.95] }, { operation: 'sum', values: [7.5] }] }, { results }), false)
  assert.equal(aiCalculationGrounded({ operation: 'days_between', dates: ['2026-10-01', '2026-10-08'] }, { results }), true)
  // A percent is the share the results hold, written either way.
  assert.equal(aiCalculationGrounded({ operation: 'product', values: [62.5, 4] }, { results: [{ onTime: { percent: 0.625 } }, { count: 4 }] }), true)

  // Through the loop: PO-001 has 30 pcs left at 100 USD.
  const wrong = await ask([
    [...call('tu_po', 'get_purchase_order', { order: 'PO-001' }), end()],
    [...call('tu_calc', 'calculate', { operation: 'product', values: [30, 110] }), end()],
    [...say('The 30 pcs still to come on PO-001 cost $3,300.'), end()],
  ], 'What does the rest of PO-001 cost?')
  assert.ok(wrong.flagged.some((value) => value.includes('3,300')), `flagged: ${wrong.flagged.join(', ')}`)
  const right = await ask([
    [...call('tu_po', 'get_purchase_order', { order: 'PO-001' }), end()],
    [...call('tu_calc', 'calculate', { operation: 'product', values: [30, 100] }), end()],
    [...say('The 30 pcs still to come on PO-001 cost $3,000.'), end()],
  ], 'What does the rest of PO-001 cost?')
  assert.deepEqual(right.flagged, [])
})

// L5-03 probe 2: after seven right figures, "short by N" passed for 70 of the
// values 10 to 1,500 (168 = 48 + 120 among them) and counted as checked.
test('a figure only worked out from the answer\'s own figures is counted apart, never as checked', () => {
  const results = [{ rows: [{ sku: '85123A', available: 48, onOrder: [{ order: 'PO-202610-0022', remaining: 120 }] }] }]
  const run = (answer) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results })
  const worked = run('85123A has 48 pcs available and 120 pcs on PO-202610-0022. The open sales orders are short by 168 pcs.')
  assert.deepEqual(numbers(worked.problems), [])
  assert.equal(worked.checked.derived, 1)
  assert.equal(worked.checked.number, 2)
  // A figure no sum, difference, product or ratio of them gives is flagged.
  assert.deepEqual(numbers(run('85123A has 48 pcs available and 120 pcs on PO-202610-0022. The open sales orders are short by 171 pcs.').problems), ['171'])
})

// L5-16: three answers with a wrong figure the check must flag.
test('the check flags the wrong figure in each counter-example of the question set', () => {
  assert.equal(FLAG_CASES.length, 3)
  for (const row of FLAG_CASES) {
    const { problems } = checkAiModelFirstGrounding({ answer: { title: '', answer: row.answer, records: [] }, results: row.results, question: row.question })
    const flagged = numbers(problems)
    for (const figure of row.flagged) assert.ok(flagged.some((value) => value.replace(/[^\d.]/g, '') === figure), `${row.id}: ${figure} not flagged (${flagged.join(', ') || 'nothing'})`)
  }
})

// L5-21: a chip is sent as the user's words, so its quantity reached a form as
// one the user typed.
test('a follow-up chip with a figure the records and the question do not hold is refused', () => {
  const tool = AI_ASSISTANT_V2_UI_TOOLS.find((entry) => entry.name === 'suggest_followups')
  const ctx = { language: 'en-US', userText: 'What should I reorder?', results: new Map([['tu_1', { tool: 'reorder_list', output: { rows: [{ sku: 'LDM-001', shortfall: 28, orderNow: true }] } }]]) }
  assert.equal(tool.build({ questions: ['Order 120 of LDM-001'] }, ctx).error?.code, 'ungrounded_figure')
  assert.equal(tool.build({ questions: ['Order 28 of LDM-001'] }, ctx).component, 'followups')
  assert.equal(tool.build({ questions: ['Which suppliers are late?'] }, ctx).component, 'followups')
})

// L5-17: availableToPromise counts overdue lines as arriving; the question set
// expects what a customer can be promised without them.
test('stock_position gives available to promise without what overdue orders still owe', async () => {
  const scenario = aiSkillScenario()
  const context = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(context, {})
  const { result } = await runAiReadTool('stock_position', {}, { facts, context })
  const row = (sku) => result.rows.find((entry) => entry.sku === sku)
  // LDM-001: 28 available, PO-001 (30) and PO-008 (40) overdue, 35 unreserved demand.
  assert.deepEqual([row('LDM-001').availableToPromise, row('LDM-001').availableToPromiseWithoutOverdue], [63, -7])
  // LDM-002: nothing overdue, so the two agree.
  assert.deepEqual([row('LDM-002').availableToPromise, row('LDM-002').availableToPromiseWithoutOverdue], [200, 200])
  assert.equal(row('LDM-003').availableToPromiseWithoutOverdue, null)
})

// 2026-11-20 question set and its review (#404). The user's own words give a
// calculation a week shift (as an add_days delta, with its direction) or a
// multiple (as a product's factor), never anything else, and never from the
// model's earlier answers.
test('a week shift or a multiple the user asked for grounds that calculation, and nothing else', () => {
  const results = [{ promisedDate: '2026-11-15', minimumOrderQuantity: 50, unitPrice: 6.38 }]
  const grounded = (input, question, extra = {}) => aiCalculationGrounded(input, { results, question, today: '2026-11-20', ...extra })
  const addDays = (days, from = '2026-11-15') => ({ operation: 'add_days', dates: [from], values: [days] })
  // Shifts, with their direction.
  assert.equal(grounded(addDays(7), '把 Globex 那张逾期订单的交期推迟一周'), true)
  assert.equal(grounded(addDays(-7), '把交期提前一周'), true)
  assert.equal(grounded(addDays(7), '把交期提前一周'), false)
  assert.equal(grounded(addDays(7), 'Push it back a week'), true)
  assert.equal(grounded(addDays(7), 'What happens if Acme delays another week?'), true)
  assert.equal(grounded(addDays(21), 'Delay it 3 weeks'), true)
  assert.equal(grounded(addDays(-7), 'Bring it forward a week'), true)
  assert.equal(grounded(addDays(14), 'Can they push it out a fortnight?'), true)
  // Multiples, as a product's factor, chained to the next calculation.
  const chain = { calculations: [{ operation: 'product', values: [50, 3] }, { operation: 'product', values: [150, 6.38] }] }
  assert.equal(grounded(chain, 'What would three times the minimum order cost?', { output: { results: [{ result: 150 }, { result: 957 }] } }), true)
  assert.equal(grounded({ operation: 'product', values: [50, 2] }, '起订量的两倍要多少钱？'), true)
  // Not a later result for an earlier calculation.
  const reversed = { calculations: [{ operation: 'product', values: [150, 6.38] }, { operation: 'product', values: [50, 3] }] }
  assert.equal(grounded(reversed, 'What would three times the minimum order cost?', { output: { results: [{ result: 957 }, { result: 150 }] } }), false)
})

test('words do not ground a calculation where they do not mean a shift or a multiple (review probes)', () => {
  const results = [{ promisedDate: '2026-11-15', minimumOrderQuantity: 50, unitPrice: 6.38 }]
  const grounded = (input, question, extra = {}) => aiCalculationGrounded(input, { results, question, today: '2026-11-20', ...extra })
  const addDays = (days, from = '2026-11-15') => ({ operation: 'add_days', dates: [from], values: [days] })
  // Spans only from the user's words, never from an earlier answer.
  assert.equal(grounded(addDays(21), 'When does it arrive?', { conversation: 'Lead time is about 3 weeks.' }), false)
  // A span is an add_days delta only, never another operation's input.
  assert.equal(grounded({ operation: 'product', values: [700, 6.38] }, 'What should I reorder this week?'), false)
  assert.equal(grounded({ operation: 'product', values: [7, 6.38] }, 'Push it back a week'), false)
  // No shift named.
  for (const question of ['What should I reorder this week?', 'How much do we sell a week?', '统一周期是多少？', '下周一能到吗？', '第47周发了多少？', '十二周的销量是多少？', 'Delay it 1.5 weeks']) {
    assert.equal(grounded(addDays(7), question), false, question)
  }
  assert.equal(grounded(addDays(35), 'Delay it 1.5 weeks'), false)
  assert.equal(grounded(addDays(329), '第47周'), false)
  assert.equal(grounded(addDays(14), '推迟十二周'), false)
  // add_days from a date nobody gave.
  assert.equal(grounded(addDays(7, '2026-11-02'), '推迟一周'), false)
  // Number words: only "N times", twice, double, triple, 两倍; no ×100.
  assert.equal(grounded({ operation: 'product', values: [240, 2] }, 'Please double-check the open orders'), false)
  assert.equal(grounded({ operation: 'product', values: [6.38, 2] }, 'Please double-check the price'), false)
  assert.equal(grounded({ operation: 'product', values: [6.38, 10] }, 'Show the top ten items'), false)
  assert.equal(grounded({ operation: 'product', values: [6.38, 1000] }, 'What would ten times the price be?'), false)
  assert.equal(grounded({ operation: 'product', values: [300, 6.38] }, 'And the cost?', { conversation: 'Three suppliers are late.' }), false)
  assert.equal(grounded({ operation: 'sum', values: [50, 3] }, 'What would three times the minimum order cost?'), false)
})

// The answer check is unchanged: words the user wrote give it no figure or
// date, and earlier answers give none either (review probes).
test('the answer check takes no figure or date from words or earlier answers', () => {
  const problems = (answer, question, conversation = '') => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results: [{ promisedDate: '2026-11-15', unitPrice: 6.38 }], question, conversation, today: '2026-11-20' }).problems.filter((row) => row.kind === 'number' || row.kind === 'date').map((row) => row.value)
  assert.ok(problems('It arrives 6 Dec 2026.', 'When does it arrive?', 'Lead time is about 3 weeks.').length)
  assert.ok(problems('Of 240 pcs, 120 arrive Friday.', 'Please double-check the open orders').length)
  assert.ok(problems('£6.38 each, £12.76 for two.', 'Please double-check the price').some((value) => value.includes('12.76')))
  assert.ok(problems('Take a £10 discount.', 'Show the top ten items').length)
  assert.ok(problems('It is 12 days late.', 'Which of the twelve open orders are late?').length)
  assert.ok(problems('Order by 27 Nov 2026.', 'What should I reorder this week?').length)
})
