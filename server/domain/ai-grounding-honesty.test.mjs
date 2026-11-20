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
  // A span of weeks in words is its days (promised-date-zh: "推迟一周" is
  // add_days 7, and the date it gives is then a source).
  for (const question of ['把 Globex 那张逾期订单的交期推迟一周', '推迟一个星期', 'Push it back a week', 'Move it out one week']) {
    assert.equal(aiCalculationGrounded({ operation: 'add_days', dates: ['2026-11-05'], values: [7] }, { results, question }), true, question)
  }
  assert.equal(aiCalculationGrounded({ operation: 'add_days', dates: ['2026-11-05'], values: [14] }, { results, question: '推迟两周' }), true)
  assert.equal(aiCalculationGrounded({ operation: 'add_days', dates: ['2026-11-05'], values: [21] }, { results, question: 'Delay it 3 weeks' }), true)
  assert.equal(aiCalculationGrounded({ operation: 'add_days', dates: ['2026-11-05'], values: [7] }, { results, question: 'What happens if Acme delays another week?' }), true)
  // Not a span the user gave: still refused.
  assert.equal(aiCalculationGrounded({ operation: 'add_days', dates: ['2026-11-05'], values: [7] }, { results, question: 'Push it back' }), false)
  assert.equal(aiCalculationGrounded({ operation: 'add_days', dates: ['2026-11-05'], values: [14] }, { results, question: '推迟一周' }), false)
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

// Question set 2026-11-20: "What should I reorder this week?" answered "order
// by 27 Nov" (today + 7), flagged in every run; so did "if Acme delays
// another week". A span of weeks the user named reaches a day from today.
test('a date a span of weeks in the question reaches from today is one the user gave', () => {
  const dates = (answer, question, conversation = '') => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results: [], question, conversation, today: '2026-11-20' }).problems.filter((row) => row.kind === 'date').map((row) => row.value)
  assert.deepEqual(dates('Order 60 by 27 Nov 2026.', 'What should I reorder this week?'), [])
  assert.deepEqual(dates('11 月 27 日前下单', '这周要补什么货？'), [])
  assert.deepEqual(dates('It would arrive around 27 Nov.', 'What happens if Acme delays another week?'), [])
  assert.deepEqual(dates('Two weeks from now is 4 Dec.', 'and in two weeks?', 'What should I reorder?'), [])
  // No span named: the day is not the user's.
  assert.equal(dates('Order 60 by 27 Nov 2026.', 'What should I reorder?').length, 1)
  assert.equal(dates('Order 60 by 28 Nov 2026.', 'What should I reorder this week?').length, 1)
})

// 2026-11-20 question set, minimum-multiple-en: "three times the minimum
// order" is a product by 3; its right £957 was flagged, as 3 was no digit
// the user typed.
test('a count or multiple in the user\'s words grounds a calculation', () => {
  const results = [{ minimumOrderQuantity: 50, unitPrice: 6.38 }]
  const grounded = (values, question) => aiCalculationGrounded({ operation: 'product', values }, { results, question })
  assert.equal(grounded([50, 3], 'What would three times the minimum order of the Regency Cakestand cost?'), true)
  assert.equal(grounded([50, 2], 'And twice that?'), true)
  assert.equal(grounded([50, 2], '起订量的两倍要多少钱？'), true)
  assert.equal(grounded([50, 3], '三倍呢？'), true)
  // Not a count the user gave.
  assert.equal(grounded([50, 3], 'What would the minimum order cost?'), false)
  assert.equal(grounded([50, 3], '三方匹配通过了几张？'), false)
})

// 2026-11-20 live runs: "three times the minimum order" came as one call of
// two calculations (50 × 3, then 150 × 6.38), and "推迟一周" was answered
// with the promised date plus a week written without a calculation.
test('a calculation may use an earlier one of the same call, and a named span moves a recorded date', () => {
  const results = [{ minimumOrderQuantity: 50, unitPrice: 6.38 }]
  const input = { calculations: [{ label: 'three minimums', operation: 'product', values: [50, 3] }, { label: 'cost', operation: 'product', values: [150, 6.38] }] }
  const output = { results: [{ label: 'three minimums', operation: 'product', result: 150 }, { label: 'cost', operation: 'product', result: 957 }] }
  const question = 'What would three times the minimum order cost?'
  assert.equal(aiCalculationGrounded(input, { results, question, output }), true)
  // Without the earlier result, 150 is no figure anyone gave.
  assert.equal(aiCalculationGrounded(input, { results, question }), false)
  const dates = (answer, question) => checkAiModelFirstGrounding({ answer: { title: '', answer, records: [] }, results: [{ promisedDate: '2026-11-15' }], question, today: '2026-11-20' }).problems.filter((row) => row.kind === 'date').map((row) => row.value)
  assert.deepEqual(dates('推迟一周后是 22 Nov 2026。', '把 Globex 那张逾期订单的交期推迟一周'), [])
  // No span named, or a day the span does not reach: flagged.
  assert.equal(dates('改到 22 Nov 2026。', '把 Globex 那张逾期订单的交期改一下').length, 1)
  assert.equal(dates('推迟一周后是 23 Nov 2026。', '把交期推迟一周').length, 1)
})

test('only an earlier calculation of the call grounds a later one', () => {
  const results = [{ minimumOrderQuantity: 50, unitPrice: 6.38 }]
  const question = 'What would three times the minimum order cost?'
  // The cost first, from a 150 only the second calculation gives: refused.
  const input = { calculations: [{ operation: 'product', values: [150, 6.38] }, { operation: 'product', values: [50, 3] }] }
  const output = { results: [{ operation: 'product', result: 957 }, { operation: 'product', result: 150 }] }
  assert.equal(aiCalculationGrounded(input, { results, question, output }), false)
})
