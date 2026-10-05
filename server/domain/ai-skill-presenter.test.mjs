import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { AI_SKILL_IDS as REGISTRY_IDS } from './ai-skill-registry.mjs'

const CJK = /[㐀-鿿]/
const ARRAYS = ['keyEvidence', 'dataLimitations', 'businessImpact', 'navigationLinks', 'reviewCards', 'followUpSuggestions', 'contextCards', 'recommendedActions']

async function answers(options) {
  const scenario = aiSkillScenario(options)
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const answer = (skillId, language, extra = {}) => answerAiSkill({ skillId, facts: skillId === 'capability_overview' ? null : facts, language, query: 'q', actor: scenario.actor, ...extra }).response
  return { scenario, facts, answer }
}

// What must not change with the language: ids, codes, counts and amounts.
function invariant(response) {
  return {
    intent: response.intent, answerSource: response.answerSource, skill: response.skill, checked: response.checked, metrics: response.metrics,
    severity: response.conclusion.severity,
    evidence: response.keyEvidence.map((item) => [item.entityType, item.entityId, item.statusCode, item.rank, item.severity]),
    impacts: response.businessImpact.map((item) => item.affectedObjects),
    links: response.navigationLinks.map((link) => [link.moduleId, link.entityType, link.entityId]),
    cards: response.reviewCards.map((card) => [card.draftType, card.targetEntityId, card.payload.poId, card.payload.invoiceId, card.payload.quantity, card.payload.itemIdOrSku]),
    limitations: response.dataLimitations.map((item) => item.code),
    followUps: response.followUpSuggestions.map((item) => item.skillHint),
  }
}

test('every skill answers with the full V2 shape in both languages and the same facts', async () => {
  const { scenario, answer } = await answers()
  for (const skillId of REGISTRY_IDS) {
    const english = answer(skillId, 'en-US')
    const chinese = answer(skillId, 'zh-CN')
    for (const response of [english, chinese]) {
      assert.equal(response.version, 'v2', skillId)
      for (const key of ARRAYS) assert.ok(Array.isArray(response[key]), `${skillId} ${key}`)
      assert.ok(response.conclusion.title && response.conclusion.summary, skillId)
      assert.ok(['info', 'warning', 'risk', 'success'].includes(response.conclusion.severity), skillId)
      assert.equal(response.realEvidenceCount, response.keyEvidence.length)
      assert.equal(response.limitationCount, response.dataLimitations.length)
      assert.equal(response.businessImpact.length, response.keyEvidence.length, `${skillId} impact aligned with evidence`)
      assert.ok(!Object.hasOwn(response, 'businessQuery'), `${skillId} has no business query block`)
      assert.equal(response.answerSource, 'workspace_rules')
      assert.equal(response.intent, skillId)
      for (const link of response.navigationLinks) assert.equal(link.returnTo, 'ai-assistant')
      if (skillId !== 'capability_overview') assert.equal(response.generatedAt, scenario.ctx.aiSkillNow.toISOString(), `${skillId} generatedAt is the injected clock`)
    }
    assert.equal(english.language, 'en-US')
    assert.equal(chinese.language, 'zh-CN')
    assert.equal(english.answerSourceLabel, 'Answered from your workspace data')
    assert.equal(chinese.answerSourceLabel, '基于当前工作区数据回答')
    assert.doesNotMatch(JSON.stringify(english), CJK, `${skillId} English answer has no Chinese`)
    assert.match(chinese.conclusion.title + chinese.conclusion.summary, CJK, `${skillId} Chinese conclusion`)
    assert.deepEqual(invariant(chinese), invariant(english), `${skillId} facts do not depend on the language`)
  }
})

test('today priorities states the report figures with tenant formatting', async () => {
  const { answer } = await answers()
  const english = answer('today_priorities', 'en-US')
  assert.equal(english.conclusion.title, '8 items need attention today (as of Sep 29, 2026)')
  assert.equal(english.conclusion.summary, '4 open purchase orders, 2 overdue. Committed PO spend: €500.00 and $17,920.00. Committed supplier invoices: $7,381.50. 1 SKU is short against open sales orders: LDM-001.')
  assert.deepEqual(english.metrics, { asOf: '2026-09-29', openPurchaseOrders: 4, overduePurchaseOrders: 2, committedSpend: [{ currency: 'EUR', amount: 500 }, { currency: 'USD', amount: 17920 }], committedInvoices: [{ currency: 'USD', amount: 7381.5 }], atRiskSkus: ['LDM-001'], atRiskSkuCount: 1 })
  // By date: the longest overdue first (PO-001 4 days, PO-008 2 days), then due
  // soonest (PO-002 in 4 days), then the oldest open problems. The undated
  // stock shortage (LDM-001) comes after every dated item.
  assert.deepEqual(english.keyEvidence.map((item) => item.entityLabel), ['PO-001', 'PO-008', 'PO-002', 'INV-001', 'GRN-002'])
  assert.equal(english.keyEvidence[0].summary, '4 days past the promised date; 30 pcs still to receive from Acme Components.')
  // Each line states the date it is ordered by.
  assert.equal(english.keyEvidence[3].summary, 'Invoice variance of $200.00 from Acme Components. Open 5 days, since Sep 24, 2026.')
  assert.equal(answer('today_priorities', 'zh-CN').keyEvidence[4].summary, '已收货，尚未过账到库存。已挂起 1 天（自 Sep 28, 2026）。')
  assert.equal(english.checkedLabel, 'Checked: purchase orders, purchase requests, RFQs, inventory balances, supplier invoices and receipts')
  assert.ok(english.dataLimitations.some((item) => item.code === 'multi_currency'))
  const chinese = answer('today_priorities', 'zh-CN')
  assert.equal(chinese.conclusion.title, '今天需要关注 8 项（截至 Sep 29, 2026）')
  // The tenant's locale formats numbers and dates in both languages.
  assert.match(chinese.conclusion.summary, /\$17,920\.00/)
})

test('a workspace with another locale and no currency formats values as stored', async () => {
  const { facts } = await answers({ tenant: { locale: 'de-DE', currency: 'EUR', timezone: 'Europe/Berlin' } })
  facts.invoices.committed.amounts.push({ currency: null, amount: 12.5, recordCount: 1 })
  const english = answerAiSkill({ skillId: 'workspace_metrics', facts, language: 'en-US', query: 'q' }).response
  assert.match(english.conclusion.summary, /17\.920,00\s\$/)
  // An amount without a currency is a plain number, never a guessed currency.
  assert.match(english.conclusion.summary, /7\.381,50\s\$ and 12,5\./)
  assert.ok(english.dataLimitations.some((item) => item.code === 'currency_missing'))
  assert.match(english.conclusion.title, /29\.09\.2026/)
})

test('drafts are review-only cards for the top signals, and need purchasing edit access', async () => {
  const { answer } = await answers()
  const english = answer('prepare_action_draft', 'en-US')
  assert.deepEqual(english.reviewCards.map((card) => [card.draftType, card.targetEntityId]), [['po_followup_draft', 'PO-001'], ['po_followup_draft', 'PO-008'], ['supplier_followup_draft', 'INV-001']])
  for (const card of english.reviewCards) {
    assert.equal(card.previewOnly, true)
    assert.equal(card.reviewRequired, true)
    assert.equal(card.requiresHumanReview, true)
    assert.equal(card.payload.language, 'en-US')
  }
  assert.equal(english.reviewCards[0].payload.message, 'Please confirm a delivery date for the remaining 30 pcs of LDM-001 on PO-001.')
  assert.equal(english.reviewCards[2].payload.message, 'Invoice INV-001 differs from the purchase order by $200.00. Please send a corrected invoice or the reason for the difference.')
  assert.equal(answer('prepare_action_draft', 'zh-CN').reviewCards[0].payload.message, '请确认 PO-001 上 LDM-001 剩余 30 pcs 的交货日期。')
  // A read-only viewer gets links and a limitation, no cards.
  const viewer = (await answers({ roleKey: 'read-only-viewer' })).answer('prepare_action_draft', 'en-US')
  assert.deepEqual(viewer.reviewCards, [])
  assert.equal(viewer.conclusion.title, 'Drafts need purchasing edit access')
  assert.ok(viewer.dataLimitations.some((item) => item.code === 'draft_permission'))
  assert.ok(viewer.navigationLinks.length > 0)
})

test('an uncovered shortage gets a structured purchase request draft sized to the target', async () => {
  const { facts } = await answers()
  // Without incoming supply or a pending request LDM-001 needs its reorder
  // point of 40 less the 28 available: 12.
  const row = facts.inventory.rows.find((entry) => entry.sku === 'LDM-001')
  Object.assign(row, { incomingApprovedPo: 0, purchaseOrderIds: [] })
  facts.purchaseRequests.awaitingApproval = []
  facts.purchaseOrders.rows = []
  const response = answerAiSkill({ skillId: 'prepare_action_draft', facts, language: 'en-US', query: 'q' }).response
  const card = response.reviewCards.find((entry) => entry.draftType === 'purchase_request_draft')
  assert.deepEqual([card.payload.itemIdOrSku, card.payload.quantity], ['LDM-001', 12])
  assert.equal(card.title, 'Request 12 of LDM-001')
})

test('focus narrows an answer to the record and the records tied to it', async () => {
  const { answer } = await answers()
  const po = answer('today_priorities', 'en-US', { focus: { entityType: 'purchase_order', entityId: 'PO-001' } })
  assert.equal(po.conclusion.title, 'Why PO-001 needs attention')
  // Dated records first; the item's own stock line has no date.
  assert.deepEqual(po.keyEvidence.map((item) => item.entityId), ['PO-001', 'INV-001', 'ITEM-001'])
  const none = answer('today_priorities', 'en-US', { focus: { entityType: 'purchase_order', entityId: 'PO-003' } })
  assert.equal(none.conclusion.title, 'PO-003 has no open issue in the workspace data')
  assert.deepEqual(none.keyEvidence, [])
})

test('the refusal offers a draft and never acts', async () => {
  const { answer } = await answers()
  const refusal = answer('capability_overview', 'en-US', { refusal: true })
  assert.equal(refusal.conclusion.title, "I can't do that, but I can prepare a draft")
  assert.match(refusal.conclusion.summary, /I can't approve, pay, send, issue, cancel or delete anything\. I can prepare a draft for you to review\./)
  assert.equal(refusal.followUpSuggestions[0].skillHint, 'prepare_action_draft')
  assert.deepEqual(refusal.reviewCards, [])
  const zh = answer('capability_overview', 'zh-CN', { refusal: true })
  assert.match(zh.conclusion.summary, /我不能批准、付款、发送/)
})
