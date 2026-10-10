import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { runAiSkillRuntime } from './ai-skill-runtime.mjs'

// What the assistant says when no skill answers the question, from the local
// walkthrough on 2026-10-09: "我压力大" and "how about the contract data?" got
// the help card, labelled "Answered from your workspace data", every time.

async function ask(message, language = 'en-US') {
  const scenario = aiSkillScenario()
  return runAiSkillRuntime({ ...scenario.ctx, env: {} }, { message, answerLanguage: language })
}

test('a user under pressure gets the first three of today\'s priorities, not the help card', async () => {
  for (const message of ['我压力大', '我压力太大怎么办', 'i had the big pressure', "I'm so stressed", 'feeling overwhelmed today', '事情太多忙不过来']) {
    const route = routeSkill({ message })
    assert.equal(route.skillId, 'today_priorities', message)
    assert.equal(route.signals.calm, true, message)
  }
  // Pressure on prices, or a question another rule answers, is not about the user.
  assert.notEqual(routeSkill({ message: 'Are suppliers putting pressure on our prices?' })?.signals?.calm, true)
  assert.equal(routeSkill({ message: "I'm stressed about our overdue purchase orders" }).skillId, 'purchase_orders')

  const english = await ask('i had the big pressure')
  assert.equal(english.intent, 'today_priorities')
  assert.equal(english.keyEvidence.length, 3)
  assert.equal(english.conclusion.title, "That's a lot at once. Start with these 3")
  assert.equal(english.conclusion.summary, "These are the earliest of 8 open items. Take them one at a time; the rest stay on Today's priorities.")
  const chinese = await ask('我压力大', 'zh-CN')
  assert.equal(chinese.conclusion.title, '事情确实不少，先从这 3 件开始')
  assert.match(chinese.conclusion.summary, /这是 8 项待办里最早的几项/)
  // The same three records as the first three of today's priorities.
  const today = await ask("What should I handle first today?")
  assert.deepEqual(english.keyEvidence.map((item) => item.entityId), today.keyEvidence.slice(0, 3).map((item) => item.entityId))
})

test('a question about contracts says they cannot be read yet and links to Contracts', async () => {
  for (const message of ['how about the contract data?', '合同情况怎么样', 'Show me the supplier agreements']) {
    assert.deepEqual(routeSkill({ message }), { capability: true, contracts: true }, message)
  }
  const english = await ask('how about the contract data?')
  assert.equal(english.intent, 'capability_overview')
  assert.equal(english.conclusion.title, "I can't read contracts yet")
  assert.match(english.conclusion.summary, /^Contracts are in their own module for now/)
  assert.deepEqual(english.navigationLinks.map((link) => [link.label, link.moduleId]), [['Open Contracts', 'contracts:list']])
  assert.equal(english.answerSourceLabel, 'No workspace data was read for this answer')
  const chinese = await ask('合同情况怎么样', 'zh-CN')
  assert.equal(chinese.conclusion.title, '我暂时还不能读取合同')
  assert.equal(chinese.navigationLinks[0].label, '打开合同')
})

test('the help answer says no workspace data was read, and an unanswered question says so in its title', async () => {
  const unmatched = await ask('what is the meaning of the blue widget')
  assert.equal(unmatched.intent, 'capability_overview')
  assert.equal(unmatched.conclusion.title, "I can't answer that from your workspace data yet")
  assert.equal(unmatched.answerSourceLabel, 'No workspace data was read for this answer')
  // A greeting and the help chip keep the plain title.
  for (const message of ['hello']) {
    const greeting = await ask(message)
    assert.equal(greeting.conclusion.title, 'Here is what I can help with', message)
    assert.equal(greeting.answerSourceLabel, 'No workspace data was read for this answer', message)
  }
  const scenario = aiSkillScenario()
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const chip = answerAiSkill({ skillId: 'capability_overview', facts: null, language: 'zh-CN', query: '你能做什么', actor: scenario.actor, route: { capability: true } }).response
  assert.equal(chip.conclusion.title, '我可以帮你做这些')
  assert.equal(chip.answerSourceLabel, '本次回答没有读取工作区数据')
  // A data answer keeps its label.
  const today = answerAiSkill({ skillId: 'today_priorities', facts, language: 'en-US', query: 'q', actor: scenario.actor }).response
  assert.equal(today.answerSourceLabel, 'Answered from your workspace data')
})
