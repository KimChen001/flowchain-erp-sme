import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillIntentText } from './ai-skill-intent-text.mjs'
import { AI_SKILL_COPY, aiSkillList, aiSkillQuestionLanguage } from './ai-skill-copy.mjs'
import { aiAnswerClaimsAction } from './ai-answer-claims.mjs'
import { routeSkill } from './ai-skill-router.mjs'

const states = (found) => Object.fromEntries(Object.entries(found).filter(([state, list]) => state !== 'viaName' && list.length).map(([state, list]) => [state, list.map((entry) => entry.id || entry.sku)]))

test('the answer follows the language the question is phrased in', () => {
  for (const [question, ui, expected] of [
    ['How many 未结采购订单 do we have?', 'zh-CN', 'en-US'],
    ['PO-012 的状态是什么？', 'en-US', 'zh-CN'],
    ['What is the ATP for SKU-001?', 'zh-CN', 'en-US'],
    ['SKU-001 还有多少库存？', 'en-US', 'zh-CN'],
    ['Northstar 有多少逾期订单', 'en-US', 'zh-CN'],
    ['华东电子 has how many open orders?', 'zh-CN', 'en-US'],
    ['列出 overdue POs', 'en-US', 'zh-CN'],
    ['这个 SKU available to promise 是多少', 'en-US', 'zh-CN'],
    ['Show me 华东电子的订单', 'zh-CN', 'en-US'],
    ['A类物料有哪些', 'en-US', 'zh-CN'],
    ['What does 可承诺量 mean?', 'zh-CN', 'en-US'],
    ['WHAT IS OVERDUE', 'zh-CN', 'en-US'],
    // English words inside a name do not make a Chinese question English,
    // and a Chinese name does not make an English question Chinese.
    ['Bank of America 的发票总额是多少？', 'en-US', 'zh-CN'],
    ['Johnson and Johnson 有多少未结采购订单？', 'en-US', 'zh-CN'],
    ['The Flow Controller 还有多少库存？', 'en-US', 'zh-CN'],
    ['Made in China 供应商的订单逾期了吗？', 'en-US', 'zh-CN'],
    ['PO list 里有哪些逾期的？', 'en-US', 'zh-CN'],
    ['LDM-001 的 on hand 是多少？', 'en-US', 'zh-CN'],
    ['Show 一下逾期的采购订单', 'en-US', 'zh-CN'],
    ['现在科技 has how many open POs?', 'zh-CN', 'en-US'],
    ['Any open POs from Summit?', 'zh-CN', 'en-US'],
    ['上海有成 POs overdue?', 'zh-CN', 'zh-CN'],
    ['overdue POs', 'zh-CN', 'en-US'],
    ['逾期订单', 'en-US', 'zh-CN'],
    // No language in the question: the interface language.
    ['PO-012', 'zh-CN', 'zh-CN'],
    ['PO-012', 'en-US', 'en-US'],
    ['SKU ATP', 'zh-CN', 'zh-CN'],
  ]) assert.equal(aiSkillQuestionLanguage(question, ui), expected, question)
  // Computing it again with its own result changes nothing.
  for (const question of ['PO-012', 'How many 未结采购订单 do we have?', 'SKU ATP']) {
    for (const ui of ['en-US', 'zh-CN']) {
      const once = aiSkillQuestionLanguage(question, ui)
      assert.equal(aiSkillQuestionLanguage(question, once), once, question)
    }
  }
})

const COMMON_WORDS = `about above across after again against almost along already also although always among another answer anyone
anything around asked because become before begin behind being below between beyond both bring build business busy
call came cannot care carry certain change check choose clear close come coming company could course cover create
current daily days deal decide details did different does done down during each early either else enough even
ever every example expect explain fact fall far fast feel few fill final find first follow form forward found
four free friday from full further gave general get give given goes going gone good great group grow half hand
happen hard head hear held help here high hold home hour house however idea important include inside instead
into issue just keep kind know large later least less level like line little long look made main make manager
many mark matter maybe mean meet might minute money monday more morning most move much must name near need
never next night none normal note nothing notice number often once only open order other over own part
people perhaps place plan please point possible present pretty problem process product provide public pull push
question quite rather ready real really reason recent reply report request require right same saturday say second
see seem seen send set several shall share should show side since small some something soon sorry sound speak
special start state stay step still stop such sunday supply sure system take team tell than thank that their them
then there these they thing think this those though three through thursday till time today together told tomorrow
total toward tuesday turn under until update upon usual very wait want week wednesday well were what when where
whether which while whole whom whose why will with within without word work world would write year yesterday young`.split(/\s+/).filter(Boolean)

test('question language detection is linear on long input', () => {
  const started = Date.now()
  aiSkillQuestionLanguage('a'.repeat(200000), 'en-US')
  aiSkillQuestionLanguage('a-'.repeat(100000), 'en-US')
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`)
})

test('common words are never corrected, and misspelled workspace words are', () => {
  assert.ok(COMMON_WORDS.length >= 300, COMMON_WORDS.length)
  const changed = COMMON_WORDS.filter((word) => aiSkillIntentText(word) !== word)
  assert.deepEqual(changed, [])
  assert.equal(aiSkillIntentText('how mnay opne purchse ordrs'), 'how many open purchase orders')
  assert.equal(aiSkillIntentText('wich invocies have a varience?'), 'which invoices have a variance?')
  // Record ids, names inside the sentence and near-verbs stay as typed.
  assert.equal(aiSkillIntentText('Is Rikc handling PO-0012?'), 'is rikc handling po-0012?')
  assert.equal(aiSkillIntentText('aprove PO-001'), 'aprove po-001')
  for (const word of ['avoidable', 'rises', 'committee', 'regaining', 'relieving', 'wanting']) assert.equal(aiSkillIntentText(word), word)
})

test('a choice between records is worded as a choice', () => {
  assert.equal(aiSkillList(['EAST-PO-020', 'WEST-PO-020'], 'en-US', { or: true }), 'EAST-PO-020 or WEST-PO-020')
  assert.equal(aiSkillList(['A', 'B', 'C'], 'en-US', { or: true }), 'A, B or C')
  assert.equal(aiSkillList(['EAST-PO-020', 'WEST-PO-020'], 'zh-CN', { or: true }), 'EAST-PO-020 还是 WEST-PO-020')
  assert.equal(aiSkillList(['A', 'B'], 'en-US'), 'A and B')
})

test('no answer template claims that the assistant acted, in either language', () => {
  const sample = { id: 'PO-001', po: 'PO-001', sku: 'LDM-001', name: 'Acme Components', supplier: 'Acme Components', status: 'Issued to the supplier', count: 2, total: 5, open: 2, overdue: 1, date: 'Sep 29, 2026', amounts: '$10.00', list: 'PO-001 and PO-002' }
  const fill = (template, values = {}) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? sample[key] ?? 'x'))
  // A purchase order status label (po_status) is the app's status word
  // (已下达, 已批准, 已取消; owner's terminology, 2026-11-05). It stands in an
  // evidence status field, which the validator reads as "状态：…", or after
  // 状态： in a purchase order template, so each zh label is checked there.
  const isStatusLabel = (key) => key.startsWith('po_status.')
  const claims = Object.entries(AI_SKILL_COPY).flatMap(([key, copy]) => [copy.en, copy.zh].filter((template) => aiAnswerClaimsAction(isStatusLabel(key) ? `状态：${fill(template)}` : fill(template))).map((template) => `${key}: ${template}`))
  assert.deepEqual(claims, [])
  const zhStatuses = Object.entries(AI_SKILL_COPY).filter(([key]) => isStatusLabel(key)).map(([, copy]) => copy.zh)
  const placed = Object.entries(AI_SKILL_COPY).filter(([key, copy]) => key.startsWith('po.') && copy.zh.includes('{status}'))
    .flatMap(([key, copy]) => zhStatuses.filter((status) => aiAnswerClaimsAction(fill(copy.zh, { status }))).map((status) => `${key}: ${status}`))
  assert.deepEqual(placed, [])
})
