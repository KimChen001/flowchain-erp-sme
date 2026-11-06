import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { aiSkillDraftCandidate, aiSkillDraftCard, aiSkillNextStepText } from './ai-skill-drafts.mjs'
import { requestMinimumOf } from './reorder-list.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'

// The preferred supplier's minimum order, by the reorder list's own rule
// (reorder-list.mjs): a purchase request the assistant suggests asks for at
// least it, when the item is bought in its stock unit, and says so.
const link = (itemId, extra = {}) => ({ payload: { itemId, supplierId: 'SUP-001', preferred: true, active: true, approved: true, minimumOrderQuantity: 100, ...extra } })
const factsWith = async (supplierLinks, change = () => {}) => {
  const scenario = aiSkillScenario({ supplierLinks })
  change(scenario.data)
  return { scenario, facts: await readAiSkillFacts(await loadAiSkillContext(scenario.ctx)) }
}
const minimumOf = (facts, sku) => facts.inventory.rows.find((row) => row.sku === sku).orderMinimum

test('the reorder list\'s minimum rule: only in the stock unit', () => {
  assert.equal(requestMinimumOf({ unit: 'pcs' }, { minimumOrderQuantity: 100 }, 'pcs'), 100)
  assert.equal(requestMinimumOf({ unit: 'pcs', metadata: { purchaseUnit: 'PCS' } }, { minimumOrderQuantity: 100 }, 'pcs'), 100)
  assert.equal(requestMinimumOf({ unit: 'pcs', metadata: { purchaseUnit: 'case' } }, { minimumOrderQuantity: 100 }, 'pcs'), 0)
  assert.equal(requestMinimumOf({ unit: 'pcs' }, { minimumOrderQuantity: 0 }, 'pcs'), 0)
  assert.equal(requestMinimumOf({ unit: 'pcs' }, null, 'pcs'), 0)
  assert.equal(requestMinimumOf({}, { minimumOrderQuantity: 100 }, ''), 0)
})

test('each stock row carries its preferred supplier\'s minimum, read as the reorder list reads it', async () => {
  const { facts } = await factsWith([link('ITEM-001')])
  assert.deepEqual(minimumOf(facts, 'LDM-001'), { quantity: 100, supplier: 'Acme Components' })
  assert.equal(minimumOf(facts, 'LDM-002'), null)
  // Bought in cases while stocked in pcs: the minimum is in cases, so none applies.
  const cases = await factsWith([link('ITEM-001')], (data) => { data.items.find((row) => row.id === 'ITEM-001').metadata = { purchaseUnit: 'case' } })
  assert.equal(minimumOf(cases.facts, 'LDM-001'), null)
  // Not marked preferred, but the item's own preferred supplier: still its source.
  assert.deepEqual(minimumOf((await factsWith([link('ITEM-001', { preferred: false })])).facts, 'LDM-001'), { quantity: 100, supplier: 'Acme Components' })
  // Another supplier not marked preferred, or no minimum recorded: none.
  assert.equal(minimumOf((await factsWith([link('ITEM-001', { preferred: false, supplierId: 'SUP-002' })])).facts, 'LDM-001'), null)
  assert.equal(minimumOf((await factsWith([link('ITEM-001', { minimumOrderQuantity: null })])).facts, 'LDM-001'), null)
  // No links read: nothing changes.
  assert.equal(minimumOf((await factsWith([])).facts, 'LDM-001'), null)
})

test('a suggested purchase request asks for at least the minimum, and says so', async () => {
  const { facts } = await factsWith([])
  const item = { id: 'stock_shortage:ITEM-009', type: 'stock_shortage', entityType: 'item', entityId: 'ITEM-009', label: 'LDM-009', severity: 'risk', data: { available: 10, demand: 60, reorder: 0, safety: 0, incoming: 0, pendingRequests: 0, purchaseOrderIds: [], minimum: 100, minimumSupplier: 'Acme Components' } }
  const candidate = aiSkillDraftCandidate(item, facts)
  assert.equal(candidate.kind, 'purchase_request_draft')
  assert.equal(candidate.quantity, 100)
  assert.deepEqual(candidate.raisedToMinimum, { minimum: 100, gap: 50, supplier: 'Acme Components' })
  assert.equal(aiSkillNextStepText(candidate, facts, 'en-US'), "Next: raise a purchase request for 100, Acme Components's minimum order.")
  assert.equal(aiSkillNextStepText(candidate, facts, 'zh-CN'), '下一步：按 Acme Components 的最小起订量申请采购 100。')
  const card = aiSkillDraftCard(candidate, facts, 'en-US')
  assert.equal(card.payload.quantity, 100)
  assert.match(card.description, /Acme Components takes orders of at least 100, so the request is for 100 rather than 50\./)
  // A gap above the minimum is asked for as it is.
  const big = aiSkillDraftCandidate({ ...item, data: { ...item.data, demand: 260 } }, facts)
  assert.equal(big.quantity, 250)
  assert.equal(big.raisedToMinimum, undefined)
})

test('the order prefill asks for at least the minimum, and the card says so', async () => {
  const scenario = aiSkillScenario({ supplierLinks: [link('ITEM-001')] })
  const sent = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => entry } }
  ctx.readBody = async () => ({ message: 'Create a purchase request for LDM-001 anyway', answerLanguage: 'en-US' })
  assert.equal(await handleAiRuntimeGatewayRoute(ctx), true)
  const answer = sent.at(-1).payload
  const card = answer.reviewCards.find((entry) => entry.draftType === 'purchase_request_draft')
  // 28 available against a target of 40: 12 on top of what is on order, raised to 100.
  assert.equal(card.payload.quantity, 100)
  assert.equal(card.title, 'Request 100 pcs of LDM-001')
  assert.match(card.description, /Acme Components takes orders of at least 100, so the request is for 100 rather than 12\./)
  assert.equal(card.payload.reason, card.description)
})
