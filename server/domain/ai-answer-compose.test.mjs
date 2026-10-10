import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'
import { AI_COMPOSE_LIMITS, aiAnswerComposable, aiAnswerComposeEnabled, aiAnswerComposeSlots, composeAiAnswer, verifyAiAnswerComposition } from './ai-answer-compose.mjs'
import { parleyChatAdapter } from './ai-runtime-provider-specific-adapters-v2.mjs'

// Placeholder provider settings: every provider here is a scripted stub, so
// nothing is ever sent anywhere.
const COMPOSE_ENV = {
  FLOWCHAIN_AI_AGENT_MODE: 'compose',
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
  FLOWCHAIN_AI_PROVIDER_KIND: 'parley_chat',
  FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/compose-test',
  FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder',
  FLOWCHAIN_AI_PROVIDER_MODEL: 'placeholder-model',
}
const reply = (title, summary) => async () => ({ ok: true, rawOutput: { conclusion: { summary: JSON.stringify({ title, summary }) } }, usage: { inputTokens: 1200, outputTokens: 90 } })

async function priorities(language = 'en-US') {
  const scenario = aiSkillScenario()
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const response = answerAiSkill({ skillId: 'today_priorities', facts, language, query: 'q', actor: scenario.actor }).response
  return { facts, response }
}

test('wording is on only in compose mode with a callable provider', () => {
  assert.equal(aiAnswerComposeEnabled({}), false)
  assert.equal(aiAnswerComposeEnabled({ ...COMPOSE_ENV, FLOWCHAIN_AI_AGENT_MODE: 'plan' }), false)
  assert.equal(aiAnswerComposeEnabled({ ...COMPOSE_ENV, FLOWCHAIN_AI_RUNTIME_MODE: 'local' }), false)
  assert.equal(aiAnswerComposeEnabled(COMPOSE_ENV), true)
})

test("the slots are the template answer's own values, and only data answers are worded", async () => {
  const { response } = await priorities()
  const { slots, groups } = aiAnswerComposeSlots(response)
  assert.equal(slots['answer.title'], response.conclusion.title)
  assert.equal(slots.r1, response.keyEvidence[0].entityLabel)
  assert.equal(slots['r1.detail'], response.keyEvidence[0].summary)
  assert.ok(groups.some((group) => group.slots.includes('r1')))
  assert.ok(Object.keys(slots).length <= 3 + AI_COMPOSE_LIMITS.records * 5 + AI_COMPOSE_LIMITS.cards + AI_COMPOSE_LIMITS.sections * 2)
  assert.equal(aiAnswerComposable(response), true)
  for (const intent of ['capability_overview', 'knowledge_retrieval', 'business_query']) assert.equal(aiAnswerComposable({ ...response, intent }), false, intent)
  assert.equal(aiAnswerComposable({ ...response, keyEvidence: [], sections: [] }), false)
})

test('a grounded reply is rendered from the slots and labelled', async () => {
  const { facts, response } = await priorities()
  const result = await composeAiAnswer({ response, facts, message: 'What should I handle first today?', env: COMPOSE_ENV, provider: reply('Start with {r1}', '{r1} comes first: {r1.detail} After that, look at {r2}.') })
  assert.equal(result.compose.status, 'composed')
  assert.equal(result.response.conclusion.title, `Start with ${response.keyEvidence[0].entityLabel}`)
  assert.ok(result.response.conclusion.summary.startsWith(`${response.keyEvidence[0].entityLabel} comes first: ${response.keyEvidence[0].summary}`))
  assert.equal(result.response.answerSource, 'workspace_agent')
  assert.equal(result.response.answerSourceLabel, 'Answered from your workspace data. Worded by AI; figures checked.')
  // Everything else is the skill's: evidence, links, cards, figures, metrics.
  for (const key of ['keyEvidence', 'navigationLinks', 'reviewCards', 'figures', 'metrics', 'dataLimitations']) assert.deepEqual(result.response[key], response[key], key)
  assert.equal(result.compose.slotsUsed, 3)
  assert.deepEqual(result.compose.usage, { input: 1200, output: 90 })
})

test('the verifier keeps the template for anything a slot should carry, a claim or the wrong language', async () => {
  const { facts, response } = await priorities()
  // A supplier this answer does not cite.
  const { slots } = aiAnswerComposeSlots(response, facts)
  const supplier = facts.suppliers.map((row) => row.name).find((name) => name && !Object.values(slots).some((value) => value.includes(name)))
  assert.ok(supplier)
  const cases = [
    ['digits', 'Start with {r1}', '{r1} is 4 days late.'],
    ['number_words', 'Start with {r1}', 'Seven orders are late, starting with {r1}.'],
    ['currency', 'Start with {r1}', '{r1} costs us $ every day.'],
    ['date', 'Start with {r1}', '{r1} was due in October.'],
    ['raw_name', 'Start with {r1}', `${supplier} is behind {r1}.`],
    ['unknown_slot', 'Start with {r1}', '{r99} comes first.'],
    ['action_claim', 'Start with {r1}', 'I sent a reminder about {r1}.'],
    ['technical', 'Start with {r1}', 'The model thinks {r1} comes first.'],
    ['language', 'Start with {r1}', '先处理 {r1}。'],
    ['no_slots', 'Your day', 'There is a lot to do today.'],
  ]
  for (const [reason, title, summary] of cases) {
    const result = await composeAiAnswer({ response, facts, message: 'What first?', env: COMPOSE_ENV, provider: reply(title, summary) })
    assert.equal(result.compose.status, 'rejected', reason)
    assert.equal(result.compose.reason, reason, reason)
    assert.equal(result.response, response, reason)
  }
  // Too long, and a reply that is not the asked JSON.
  const long = await composeAiAnswer({ response, facts, message: 'q', env: COMPOSE_ENV, provider: reply('{r1}', `{r1.detail} ${'Look closely. '.repeat(120)}`) })
  assert.equal(long.compose.reason, 'too_long')
  const prose = await composeAiAnswer({ response, facts, message: 'q', env: COMPOSE_ENV, provider: async () => ({ ok: true, rawOutput: { conclusion: { summary: 'Start with the late order.' } } }) })
  assert.equal(prose.compose.reason, 'invalid_reply')
})

test('filling the slots changes nothing but the slots: English keeps its words, Chinese loses the spaces around slots', async () => {
  const { facts, response } = await priorities()
  const english = await composeAiAnswer({ response, facts, message: 'q', env: COMPOSE_ENV, provider: reply('Start with {r1}', 'Issues remain:  {r1} still needs a follow-up, and its suppliers stress the same issues.') })
  assert.equal(english.compose.status, 'composed')
  assert.equal(english.response.conclusion.summary, `Issues remain: ${response.keyEvidence[0].entityLabel} still needs a follow-up, and its suppliers stress the same issues.`)
  const zh = await priorities('zh-CN')
  const chinese = await composeAiAnswer({ response: zh.response, facts: zh.facts, message: '今天先处理什么？', env: COMPOSE_ENV, provider: reply('先处理 {r1}', '{r1} 也已 {r1.value}， 需要跟进。') })
  assert.equal(chinese.compose.status, 'composed')
  assert.equal(chinese.response.conclusion.summary, `${zh.response.keyEvidence[0].entityLabel} 也已${zh.response.keyEvidence[0].value}，需要跟进。`)
})

test('a Chinese answer is worded in Chinese, and "第一" or "唯一" is not a count', async () => {
  const { facts, response } = await priorities('zh-CN')
  const ok = await composeAiAnswer({ response, facts, message: '今天先处理什么？', env: COMPOSE_ENV, provider: reply('先处理 {r1}', '第一件事是 {r1}：{r1.detail}这是唯一需要马上跟进的。') })
  assert.equal(ok.compose.status, 'composed')
  assert.equal(ok.response.answerSourceLabel, '基于当前工作区数据回答，由 AI 组织语言，数字已核对')
  const counted = await composeAiAnswer({ response, facts, message: '今天先处理什么？', env: COMPOSE_ENV, provider: reply('先处理 {r1}', '有七张单逾期，先看 {r1}。') })
  assert.equal(counted.compose.reason, 'number_words')
  const english = await composeAiAnswer({ response, facts, message: '今天先处理什么？', env: COMPOSE_ENV, provider: reply('Start with {r1}', '{r1} comes first.') })
  assert.equal(english.compose.reason, 'language')
})

test("counts equal to the answer's own, the question's words and the names the answer shows may be written out", async () => {
  const listed = await priorities()
  const { facts } = listed
  // The list in full (no count of a longer list): its counts are totals.
  const response = { ...listed.response, figures: [] }
  const { slots, partial } = aiAnswerComposeSlots(response, facts)
  assert.deepEqual(partial, [])
  const overdue = Number(slots['count.po_overdue'])
  assert.equal(overdue, 2)
  // "Two orders are overdue": the answer cites two overdue orders.
  const counted = await composeAiAnswer({ response, facts, message: 'What first?', env: COMPOSE_ENV, provider: reply('Start with {r1}', 'Two orders are overdue; start with {r1} from {r1.supplier}.') })
  assert.equal(counted.compose.status, 'composed')
  // A supplier the answer shows, written out.
  const named = await composeAiAnswer({ response, facts, message: 'What first?', env: COMPOSE_ENV, provider: reply(`Chase ${slots['r1.supplier']} first`, '{r1} comes first: {r1.detail}') })
  assert.equal(named.compose.status, 'composed')
  // "Next week" and "LDM-001", as the question asks them.
  const zh = await priorities('zh-CN')
  const asked = await composeAiAnswer({ response: zh.response, facts: zh.facts, message: 'LDM-001 下周够不够？', env: COMPOSE_ENV, provider: reply('LDM-001 下周的情况', '工作区没有记录下周的预测；目前 {r1} {r1.value}。') })
  assert.equal(asked.compose.status, 'composed')
  // A count the answer does not have stays rejected, in either form.
  for (const summary of ['Twelve orders are overdue, starting with {r1}.', '12 orders are overdue, starting with {r1}.']) {
    const wrong = await composeAiAnswer({ response, facts, message: 'What first?', env: COMPOSE_ENV, provider: reply('Start with {r1}', summary) })
    assert.equal(wrong.compose.status, 'rejected', summary)
  }
})

// The walkthrough on 2026-10-09: "Chase PO-020 first—5 orders overdue" when the
// answer listed the first 5 of 21 and 12 orders were overdue.
test('an answer that lists the first of more never writes the listed count as a total', async () => {
  const { facts, response } = await priorities()
  assert.match(response.conclusion.summary, /Showing the first 5 of 8/)
  const { slots, partial, groups } = aiAnswerComposeSlots(response, facts)
  // The totals the answer states are slots: the list, the report figures.
  assert.equal(slots['total.attention_item_count'], '8')
  assert.equal(slots['total.overdue_purchase_orders'], '2')
  assert.equal(slots['total.open_purchase_orders'], '4')
  assert.equal(slots['total.short_skus'], '1')
  assert.ok(groups.some((group) => group.about.includes('not totals') && group.slots.includes('count.records')))
  assert.ok(partial.includes('count.records') && !partial.includes('count.drafts'))
  const ask = (title, summary, language = 'en-US', answer = response) => composeAiAnswer({ response: answer, facts, message: language === 'zh-CN' ? '今天先处理什么？' : 'What first?', env: COMPOSE_ENV, provider: reply(title, summary) })
  // The listed count passed off as a total, as a slot, a digit or a word.
  for (const [title, summary] of [
    ['Chase {r1} first: {count.records} orders overdue', '{r1} comes first: {r1.detail}'],
    ['Chase {r1} first: 5 orders overdue', '{r1} comes first: {r1.detail}'],
    ['Chase {r1} first', 'Five orders need attention, starting with {r1}.'],
    ['Chase {r1} first', '{count.po_overdue} orders are overdue, starting with {r1}.'],
  ]) {
    const result = await ask(title, summary)
    assert.equal(result.compose.reason, 'partial_count', title + summary)
    assert.equal(result.response, response)
  }
  // Beside a total, or the total itself, it is fine, in either language.
  const shown = await ask('Chase {r1} first', 'Here are the first {count.records} of {total.attention_item_count} items: {r1} comes first. {total.overdue_purchase_orders} orders are overdue in all.')
  assert.equal(shown.compose.status, 'composed')
  assert.equal(shown.response.conclusion.summary, `Here are the first 5 of 8 items: ${response.keyEvidence[0].entityLabel} comes first. 2 orders are overdue in all.`)
  // A total is a slot, never a number of its own: "4 days late" when 4 orders are open.
  assert.equal((await ask('Chase {r1} first', '{r1} is 4 days late.')).compose.reason, 'digits')
  const zh = await priorities('zh-CN')
  const chinese = await composeAiAnswer({ response: zh.response, facts: zh.facts, message: '今天先处理什么？', env: COMPOSE_ENV, provider: reply('先处理 {r1}', '共有 {total.overdue_purchase_orders} 张采购订单逾期，先看 {r1}。') })
  assert.equal(chinese.compose.status, 'composed')
  const zhListed = await composeAiAnswer({ response: zh.response, facts: zh.facts, message: '今天先处理什么？', env: COMPOSE_ENV, provider: reply('先处理 {r1}', '有五项需要处理，先看 {r1}。') })
  assert.equal(zhListed.compose.reason, 'partial_count')
})

test('a supplier row cited for a late order counts as a supplier, not as a late order', async () => {
  const scenario = aiSkillScenario()
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const response = answerAiSkill({ skillId: 'supplier_attention', facts, language: 'en-US', query: 'q', actor: scenario.actor }).response
  const { slots } = aiAnswerComposeSlots(response, facts)
  assert.equal(slots['count.supplier'], String(response.keyEvidence.length))
  assert.equal(slots['count.po_overdue'], undefined)
  assert.equal(slots['total.supplier_attention_count'], String(response.figures.find((row) => row.code === 'supplier_attention_count').value))
})

test("a sentence slot's full stop is not doubled, and Chinese punctuation is full width", async () => {
  const zh = await priorities('zh-CN')
  const label = zh.response.keyEvidence[0].entityLabel
  const detail = zh.response.keyEvidence[0].summary
  assert.match(detail, /。$/)
  const chinese = await composeAiAnswer({ response: zh.response, facts: zh.facts, message: '今天先处理什么？', env: COMPOSE_ENV, provider: reply('先处理 {r1}', '先看 {r1}: {r1.detail}；然后再看其他的。') })
  assert.equal(chinese.compose.status, 'composed')
  assert.equal(chinese.response.conclusion.summary, `先看 ${label}：${detail}然后再看其他的。`)
  const { facts, response } = await priorities()
  const english = await composeAiAnswer({ response, facts, message: 'q', env: COMPOSE_ENV, provider: reply('Start with {r1}', '{r1}: {r1.detail}. Then the rest.') })
  assert.equal(english.response.conclusion.summary, `${response.keyEvidence[0].entityLabel}: ${response.keyEvidence[0].summary} Then the rest.`)
})

test('a follow-up the rules resolved is worded with what it means, and a reply with a raw line break is still read', async () => {
  const { facts, response } = await priorities()
  const seen = []
  const result = await composeAiAnswer({ response, facts, message: 'what about the second one?', resolvedQuestion: 'What about PO-008?', env: COMPOSE_ENV, provider: async (input) => { seen.push(input); return { ok: true, rawOutput: { conclusion: { summary: '{"title": "About {r1}", "summary": "{r1}: {r1.detail}\nNothing else stands out."}' } } } } })
  assert.equal(seen[0].task.resolvedQuestion, 'What about PO-008?')
  const body = parleyChatAdapter.buildRequestBody(seen[0], { model: 'placeholder-model' })
  assert.equal(JSON.parse(body.messages[1].content).task.resolvedQuestion, 'What about PO-008?')
  assert.equal(result.compose.status, 'composed')
  assert.match(result.response.conclusion.summary, /Nothing else stands out.$/)
  // The same question as resolved: no resolvedQuestion is sent.
  await composeAiAnswer({ response, facts, message: 'q', resolvedQuestion: 'q', env: COMPOSE_ENV, provider: async (input) => { seen.push(input); return { ok: false, reason: 'non_success_status' } } })
  assert.equal(seen[1].task.resolvedQuestion, undefined)
})

test('the wording may use its own model', async () => {
  const { facts, response } = await priorities()
  const models = []
  await composeAiAnswer({ response, facts, message: 'q', env: { ...COMPOSE_ENV, FLOWCHAIN_AI_COMPOSE_MODEL: 'stronger-model' }, provider: async (input, env) => { models.push(env.FLOWCHAIN_AI_PROVIDER_MODEL); return { ok: false, reason: 'non_success_status' } } })
  await composeAiAnswer({ response, facts, message: 'q', env: COMPOSE_ENV, provider: async (input, env) => { models.push(env.FLOWCHAIN_AI_PROVIDER_MODEL); return { ok: false, reason: 'non_success_status' } } })
  assert.deepEqual(models, ['stronger-model', 'placeholder-model'])
})

test('a slow or failing provider keeps the template answer', async () => {
  const { facts, response } = await priorities()
  const started = Date.now()
  const slow = await composeAiAnswer({ response, facts, message: 'q', env: { ...COMPOSE_ENV, FLOWCHAIN_AI_COMPOSE_TIMEOUT_MS: '1000' }, provider: () => new Promise(() => {}) })
  assert.equal(slow.compose.status, 'degraded')
  assert.equal(slow.compose.reason, 'timeout')
  assert.equal(slow.response, response)
  assert.ok(Date.now() - started < 3000)
  const failing = await composeAiAnswer({ response, facts, message: 'q', env: COMPOSE_ENV, provider: async () => { throw new Error('boom') } })
  assert.equal(failing.compose.reason, 'provider_error')
  const declined = await composeAiAnswer({ response, facts, message: 'q', env: COMPOSE_ENV, provider: async () => ({ ok: false, reason: 'non_success_status' }) })
  assert.deepEqual([declined.compose.status, declined.compose.reason], ['degraded', 'non_success_status'])
  // Off: no call at all.
  let called = false
  const off = await composeAiAnswer({ response, facts, message: 'q', env: { ...COMPOSE_ENV, FLOWCHAIN_AI_AGENT_MODE: 'plan' }, provider: async () => { called = true } })
  assert.equal(off.compose, null)
  assert.equal(called, false)
})

test('the request carries the question and the slots only, as JSON, with a short output cap', async () => {
  const { facts, response } = await priorities()
  const seen = []
  await composeAiAnswer({ response, facts, message: 'Summarise today for my boss', env: COMPOSE_ENV, provider: async (input) => { seen.push(input); return { ok: false, reason: 'non_success_status' } } })
  const body = parleyChatAdapter.buildRequestBody(seen[0], { model: 'placeholder-model' })
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.equal(body.max_tokens, 700)
  const sentData = JSON.parse(body.messages[1].content)
  assert.equal(sentData.task.question, 'Summarise today for my boss')
  assert.equal(sentData.facts.slots.r1, response.keyEvidence[0].entityLabel)
  // Nothing beyond the answer's own values: no raw facts, ids of other records or settings.
  assert.deepEqual(Object.keys(sentData).sort(), ['facts', 'responseShape', 'task'])
  assert.doesNotMatch(body.messages[1].content, /placeholder|tenant|actor|facts\.purchaseOrders/)
  assert.match(body.messages[0].content, /Facts enter only through slots/)
})

test('through the gateway: the answer is worded, and the audit row has codes only', async () => {
  const scenario = aiSkillScenario()
  const audits = []
  const sent = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: COMPOSE_ENV,
    send: (_res, status, payload) => sent.push({ status, payload }),
    aiComposeProvider: reply('Start with {r1}', '{r1} comes first: {r1.detail}'),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => { audits.push(entry); return entry } } }
  ctx.readBody = async () => ({ message: 'What should I handle first today?', answerLanguage: 'en-US' })
  await handleAiRuntimeGatewayRoute(ctx)
  const answer = sent.at(-1).payload
  assert.equal(answer.answerSource, 'workspace_agent')
  assert.match(answer.conclusion.title, /^Start with /)
  const compose = audits.at(-1).metadata.compose
  assert.equal(compose.status, 'composed')
  assert.equal(compose.slotsUsed, 2)
  assert.doesNotMatch(JSON.stringify(audits.at(-1)), /Start with|comes first|handle first today/)
  // A refusal is never worded.
  ctx.readBody = async () => ({ message: 'Approve PO-006', answerLanguage: 'en-US' })
  await handleAiRuntimeGatewayRoute(ctx)
  assert.notEqual(sent.at(-1).payload.answerSource, 'workspace_agent')
})

test('the verifier also runs the skill answer validator on the finished answer', async () => {
  const { facts, response } = await priorities()
  const { slots } = aiAnswerComposeSlots(response)
  const verified = verifyAiAnswerComposition(JSON.stringify({ title: '{r1}', summary: '{r1.detail}' }), { response, facts, slots })
  assert.equal(verified.ok, true)
  // An answer whose evidence names a record the readers never returned fails it.
  const broken = { ...response, keyEvidence: [{ ...response.keyEvidence[0], entityId: 'PO-NOT-READ' }] }
  const rejected = verifyAiAnswerComposition(JSON.stringify({ title: '{r1}', summary: '{r1.detail}' }), { response: broken, facts, slots })
  assert.deepEqual(rejected, { ok: false, reason: 'invalid_answer' })
})
