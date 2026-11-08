import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { WORKED_EXAMPLE_AS_OF, workedExampleRows } from './test-fixtures/supplier-scorecard-worked-example.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { buildSupplierScorecard, createSupplierScorecardReadService } from './supplier-scorecard.mjs'
import { runSupplierComparison } from './ai-skill-supplier-comparison.mjs'

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
  assert.equal(best.mode, 'best')
  const bravo = best.suppliers[0]
  assert.equal(bravo.onTime.count, 6)
  assert.equal(bravo.onTime.of, 6)
  const example = best.suppliers[1]
  assert.equal(example.inFull.rate.toFixed(3), '0.833')
  assert.equal(example.otif.rate.toFixed(3), '0.667')
  assert.equal(example.delay.lateCount, 3)
  const worst = runSupplierComparison(facts, { route: { scorecard: card, signals: { compare: { mode: 'worst' } } } })
  assert.deepEqual(worst.suppliers.map((row) => row.name), ['Example Supplier', 'Bravo Parts'])
  assert.equal(worst.mode, 'worst')
})

test('named suppliers are compared side by side, with no rate below the minimum sample', async () => {
  const { facts } = await scenarioFacts()
  const card = scorecard()
  const result = runSupplierComparison(facts, { route: { scorecard: card, signals: { compare: { mode: 'best' } }, entities: { suppliers: [{ id: 'EXAMPLE-SUP', name: 'Example Supplier' }, { id: 'SUP-C', name: 'Charlie Tools' }] } } })
  assert.equal(result.mode, 'compare')
  assert.deepEqual(result.suppliers.map((row) => [row.name, row.onTime?.rate ?? null, row.deliveries]), [['Example Supplier', 0.75, 12], ['Charlie Tools', null, 1]])
  // One named supplier: its own line.
  const one = runSupplierComparison(facts, { route: { scorecard: card, entities: { suppliers: [{ id: 'SUP-B', name: 'Bravo Parts' }] } } })
  assert.equal(one.mode, 'one')
  assert.deepEqual(one.suppliers.map((row) => [row.name, row.onTime.rate]), [['Bravo Parts', 1]])
})

test('the comparison needs the scorecard, and says why it has none', async () => {
  // A reader without the scorecard: the comparison says so instead of guessing.
  const { facts } = await scenarioFacts()
  assert.equal(runSupplierComparison(facts, { route: {} }).hidden, true)
  assert.equal(runSupplierComparison(facts, { route: { scorecardError: 'SCORECARD_PERIOD_TOO_LONG' } }).unavailable, 'SCORECARD_PERIOD_TOO_LONG')
})
