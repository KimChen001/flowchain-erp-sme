import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aiSkillRoutingCases } from '../../tests/ai-evals/skills/cases.mjs'
import { detectAiActionRequest, routeSkill } from './ai-skill-router.mjs'

const outcome = (route) => route === null ? null : route.refusal ? 'refusal' : route.capability ? 'capability' : route.skillId

test('every routing case reaches its skill, refusal or no skill', () => {
  const failures = []
  for (const item of aiSkillRoutingCases) {
    const route = routeSkill({ message: item.prompt, skillHint: item.skillHint, focusTarget: item.focusTarget })
    if (outcome(route) !== item.expected) failures.push(`${item.id}: expected ${item.expected}, got ${outcome(route)}`)
    else if (item.focus) assert.deepEqual(route.focus, item.focus, item.id)
  }
  assert.deepEqual(failures, [])
})

test('routing ignores the answer language and never changes the message', () => {
  for (const item of aiSkillRoutingCases) {
    const input = { message: item.prompt, skillHint: item.skillHint, focusTarget: item.focusTarget }
    const before = JSON.stringify(input)
    const english = routeSkill({ ...input, answerLanguage: 'en-US', userIntentLabel: 'Home' })
    const chinese = routeSkill({ ...input, answerLanguage: 'zh-CN', userIntentLabel: '首页' })
    assert.deepEqual(english, chinese, item.id)
    assert.equal(JSON.stringify(input), before, item.id)
  }
  // The router reads the raw message only: no sanitize(), language or labels.
  const source = readFileSync(new URL('./ai-skill-router.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /sanitize|answerLanguage|userIntentLabel|returnLabel/)
})

test('the action detector refuses instructions but not questions about them', () => {
  for (const prompt of ['Approve PO-001', 'please pay invoice 7', 'Go ahead and send it', '直接批准这个 PO', '帮我付款']) assert.equal(detectAiActionRequest(prompt), true, prompt)
  for (const prompt of ['Which POs need approval?', 'payment terms', 'Is the invoice paid?', 'evaluation', 'Why was it cancelled?']) assert.equal(detectAiActionRequest(prompt), false, prompt)
  // A draft request that mentions sending is a draft, not a refusal.
  assert.equal(routeSkill({ message: 'Prepare a draft I can send to Acme' }).skillId, 'prepare_action_draft')
  // A focus of an unsupported type is dropped rather than passed through.
  assert.equal(routeSkill({ message: 'What should I handle first today?', focusTarget: { entityType: 'tenant', entityId: 'x' } }).focus, null)
})
