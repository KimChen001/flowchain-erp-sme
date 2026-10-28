import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { WORKED_EXAMPLE_AS_OF, workedExampleRows } from './test-fixtures/supplier-scorecard-worked-example.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { buildSupplierScorecard, createSupplierScorecardReadService } from './supplier-scorecard.mjs'
import { presentSupplierComparison, runSupplierComparison } from './ai-skill-supplier-comparison.mjs'
import { aiSkillComparisonSignals, routeSkill } from './ai-skill-router.mjs'
import { aiSkillById, toolsFor } from './ai-skills.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'

// Two suppliers from the scorecard's worked example: A is the example itself
// (12 deliveries, 9 on time), B the six punctual lines L01 to L06 as its own
// orders (6 of 6 on time), C one delivery only.
function scorecard() {
  const a = workedExampleRows({ onePurchaseOrderPerLine: true })
  const copy = (rows, supplierId, keep) => {
    const lines = new Set(keep.map((id) => `EXAMPLE-${id}`))
    const rename = (id) => id.replace('EXAMPLE', supplierId)
    return {
      purchaseOrders: rows.purchaseOrders.filter((po) => lines.has(po.lines[0].id)).map((po) => ({ ...po, id: rename(po.id), supplierId, lines: po.lines.map((line) => ({ ...line, id: rename(line.id) })) })),
      receipts: rows.receipts.filter((receipt) => receipt.lines.every((line) => lines.has(line.purchaseOrderLineId))).map((receipt) => ({ ...receipt, id: rename(receipt.id), poId: rename(receipt.poId), supplierId, lines: receipt.lines.map((line) => ({ ...line, purchaseOrderLineId: rename(line.purchaseOrderLineId) })) })),
    }
  }
  const b = copy(a, 'SUP-B', ['L02', 'L03', 'L04', 'L05', 'L06', 'L07'])
  const c = copy(a, 'SUP-C', ['L02'])
  return buildSupplierScorecard({
    purchaseOrders: [...a.purchaseOrders, ...b.purchaseOrders, ...c.purchaseOrders],
    receipts: [...a.receipts, ...b.receipts, ...c.receipts],
    invoices: [],
    suppliers: [{ id: 'EXAMPLE-SUP', name: 'Example Supplier' }, { id: 'SUP-B', name: 'Bravo Parts' }, { id: 'SUP-C', name: 'Charlie Tools' }],
    period: { from: '2026-07-17', to: '2026-10-14' },
    asOfDay: WORKED_EXAMPLE_AS_OF,
  })
}

async function scenarioFacts(roleKey) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  return { scenario, facts: await readAiSkillFacts(await loadAiSkillContext(scenario.ctx)) }
}
const answer = (result, facts, language = 'en-US') => presentSupplierComparison(result, facts, { skill: aiSkillById('supplier_comparison'), language, query: 'q' })

test('delivery performance questions route to the supplier comparison; open late orders do not', () => {
  const route = (message) => routeSkill({ message })?.skillId || null
  for (const message of ['Which supplier is most reliable?', 'Compare Acme Components and Summit Packaging', 'How is Acme Components performing?', 'Which supplier delivers late most often?', 'What is our on-time delivery rate by supplier?', '哪家供应商最准时？', '对比一下 Acme Components 和 Summit Packaging', 'Acme Components 的交付表现怎么样', '哪家供应商最不靠谱']) {
    assert.equal(route(message), 'supplier_comparison', message)
  }
  assert.equal(route('Which suppliers need attention?'), 'supplier_attention')
  assert.equal(route('Which suppliers do we spend the most with?'), 'spend_analysis')
  assert.equal(route('Which purchase orders are late?'), 'purchase_orders')
  assert.notEqual(route('Which suppliers are late?'), 'supplier_comparison')
  assert.equal(aiSkillComparisonSignals('Which supplier delivers late most often?').mode, 'worst')
  assert.equal(aiSkillComparisonSignals('哪家供应商最不靠谱').mode, 'worst')
  assert.equal(aiSkillComparisonSignals('Which supplier is most reliable?').mode, 'best')
  assert.deepEqual(aiSkillComparisonSignals('How reliable was Acme last quarter?').period, { kind: 'last_quarter' })
})

test('suppliers are ranked by the scorecard\'s on-time rate; too few deliveries are named, not rated', async () => {
  const { facts } = await scenarioFacts()
  const card = scorecard()
  const byId = new Map(card.suppliers.map((row) => [row.supplierId, row]))
  assert.equal(byId.get('EXAMPLE-SUP').metrics.onTime.rate, 0.75)
  assert.equal(byId.get('SUP-B').metrics.onTime.rate, 1)
  assert.equal(byId.get('SUP-C').metrics.onTime.rate, null)
  const best = runSupplierComparison(facts, { route: { scorecard: card, signals: { compare: { mode: 'best' } } } })
  assert.deepEqual(best.suppliers.map((row) => row.name), ['Bravo Parts', 'Example Supplier'])
  assert.deepEqual(best.few, [{ name: 'Charlie Tools', deliveries: 1 }])
  const english = answer(best, facts)
  assert.equal(english.conclusion.title, 'Most reliable: Bravo Parts, on time 100% (6 of 6 deliveries) (Jul 17, 2026 – Oct 14, 2026)')
  assert.match(english.conclusion.summary, /1 supplier has too few deliveries to rate: Charlie Tools\./)
  assert.match(english.keyEvidence[1].summary, /in full 83\.3%, OTIF 66\.7%, 2\.5% of the received quantity rejected and 3 late deliveries, 5 days late on average/)
  assert.deepEqual(english.figures.map((row) => [row.key, row.value]), [['supplier_on_time_rate:SUP-B', 1], ['supplier_on_time_rate:EXAMPLE-SUP', 0.75]])
  assert.deepEqual(english.reviewCards, [])
  const worst = runSupplierComparison(facts, { route: { scorecard: card, signals: { compare: { mode: 'worst' } } } })
  assert.deepEqual(worst.suppliers.map((row) => row.name), ['Example Supplier', 'Bravo Parts'])
  assert.match(answer(worst, facts, 'zh-CN').conclusion.title, /^最不可靠的是 Example Supplier：准时 75%（12 次交付中 9 次）/)
})

test('named suppliers are compared side by side, with no rate below the minimum sample', async () => {
  const { facts } = await scenarioFacts()
  const card = scorecard()
  const result = runSupplierComparison(facts, { route: { scorecard: card, signals: { compare: { mode: 'best' } }, entities: { suppliers: [{ id: 'EXAMPLE-SUP', name: 'Example Supplier' }, { id: 'SUP-C', name: 'Charlie Tools' }] } } })
  assert.equal(result.mode, 'compare')
  const english = answer(result, facts)
  assert.equal(english.conclusion.title, 'On time: Example Supplier 75% and Charlie Tools not rated (Jul 17, 2026 – Oct 14, 2026)')
  assert.match(english.conclusion.summary, /A rate needs at least 5 deliveries in the period\./)
  assert.equal(english.keyEvidence[1].value, '1 delivery, too few to rate (5 needed)')
  // One named supplier: its own line.
  const one = runSupplierComparison(facts, { route: { scorecard: card, entities: { suppliers: [{ id: 'SUP-B', name: 'Bravo Parts' }] } } })
  assert.equal(answer(one, facts).conclusion.title, 'Bravo Parts: on time 100% (6 of 6 deliveries) (Jul 17, 2026 – Oct 14, 2026)')
})

test('the gateway reads the scorecard the supplier page reads, for the same period', async () => {
  const scenario = aiSkillScenario()
  const sent = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => entry } }
  ctx.readBody = async () => ({ message: 'Which supplier is most reliable?', answerLanguage: 'en-US' })
  assert.equal(await handleAiRuntimeGatewayRoute(ctx), true)
  const { payload } = sent.at(-1)
  assert.equal(payload.intent, 'supplier_comparison')
  // The scorecard's own read for the actor: the default 90 days to today. The
  // fixture lines record no original promise, so nobody is rated, as on the page.
  const expected = await createSupplierScorecardReadService({ prisma: scenario.ctx.aiSkillPrisma, now: () => scenario.ctx.aiSkillNow }).read({}, { actor: scenario.actor })
  assert.deepEqual(expected.period, { from: '2026-07-02', to: '2026-09-29' })
  assert.equal(payload.conclusion.title, 'No supplier has 5 or more deliveries due in Jul 2, 2026 – Sep 29, 2026')
  assert.ok(scenario.calls.prisma.some(([model]) => model === 'purchaseOrder'))
})

test('the comparison needs both purchase orders and receipts, as the scorecard does', async () => {
  const has = (roleKey) => toolsFor(aiSkillScenario({ roleKey }).actor).some((entry) => entry.id === 'supplier_comparison')
  assert.equal(has('workspace-administrator'), true)
  assert.equal(has('finance-specialist'), false)
  // A reader without the scorecard: the comparison says so instead of guessing.
  const { facts } = await scenarioFacts()
  assert.match(answer(runSupplierComparison(facts, { route: {} }), facts).conclusion.title, /needs access to purchase orders and receipts/)
  const tooLong = runSupplierComparison(facts, { route: { scorecardError: 'SCORECARD_PERIOD_TOO_LONG' } })
  assert.match(answer(tooLong, facts).conclusion.summary, /at most 731 days/)
})
