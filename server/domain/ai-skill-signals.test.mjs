import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { AI_SKILL_SIGNAL_WEIGHTS, buildAiSkillSignals, countAiSkillSignals, rankAiSkillItems } from './ai-skill-signals.mjs'

async function signalsAt(now, options) {
  const scenario = aiSkillScenario(options)
  if (now) scenario.ctx.aiSkillNow = new Date(now)
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  return { facts, signals: buildAiSkillSignals(facts) }
}

test('on the seed day the records rank by fixed weights, ties by id', async () => {
  const { signals } = await signalsAt()
  const ranked = rankAiSkillItems(signals)
  assert.deepEqual(ranked.map((item) => [item.entityId, item.type, item.score]), [
    ['ITEM-001', 'stock_shortage', 85],
    ['PO-001', 'po_overdue', 84],
    ['PO-008', 'po_overdue', 82],
    ['INV-001', 'invoice_variance', 70],
    ['GRN-002', 'grn_rejected_qty', 60],
    ['PR-001', 'pr_awaiting_approval', 55],
    ['RFQ-001', 'rfq_ready_to_award', 55],
    ['PO-002', 'po_due_7d', 50],
  ])
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8])
  // A record's other signals are kept with it.
  assert.deepEqual(ranked.find((item) => item.entityId === 'ITEM-001').also, ['stock_below_safety'])
  assert.deepEqual(ranked.find((item) => item.entityId === 'PO-001').also, ['po_partially_received'])
  assert.deepEqual(ranked.find((item) => item.entityId === 'GRN-002').also, ['grn_received_unposted'])
  // The LDM-001 shortage is already covered by open purchase orders.
  const shortage = signals.find((item) => item.type === 'stock_shortage')
  assert.deepEqual([shortage.label, shortage.data.shortage, shortage.data.incoming, shortage.data.covered, shortage.data.pendingRequests], ['LDM-001', 7, 70, true, 50])
  const counts = countAiSkillSignals(signals)
  assert.equal(counts.po_overdue, 2)
  assert.deepEqual(Object.keys(counts), Object.keys(AI_SKILL_SIGNAL_WEIGHTS))
})

test('days late are counted per report day and capped', async () => {
  // Ten days later the same data has PO-002 six days late and PO-001 fourteen.
  const later = rankAiSkillItems((await signalsAt('2026-10-09T12:00:00Z')).signals)
  const overdue = later.filter((item) => item.type === 'po_overdue').map((item) => [item.entityId, item.data.days, item.score])
  assert.deepEqual(overdue, [['PO-001', 14, 94], ['PO-008', 12, 92], ['PO-002', 6, 86]])
  // Far later the bonus stops at 20.
  const much = (await signalsAt('2027-03-01T12:00:00Z')).signals.filter((item) => item.type === 'po_overdue')
  assert.ok(much.every((item) => item.score === 100))
  // PO-009 (due in 20 days) becomes due within 7 days on day 14.
  const soon = (await signalsAt('2026-10-13T12:00:00Z')).signals.find((item) => item.entityId === 'PO-009')
  assert.deepEqual([soon.type, soon.data.days], ['po_due_7d', 6])
})

test('cancelled, draft, pending, rejected and fully received purchase orders are never signalled', async () => {
  for (const now of ['2026-09-29T12:00:00Z', '2026-10-09T12:00:00Z', '2027-03-01T12:00:00Z']) {
    const { signals } = await signalsAt(now)
    const ids = new Set(signals.filter((item) => item.entityType === 'purchase_order').map((item) => item.entityId))
    for (const id of ['PO-003', 'PO-004', 'PO-005', 'PO-006', 'PO-007']) assert.ok(!ids.has(id), `${id} at ${now}`)
  }
})

test('hidden sources give no signals, and hidden amounts give no money', async () => {
  const buyer = (await signalsAt(null, { roleKey: 'procurement-specialist' })).signals
  assert.ok(buyer.every((item) => item.type !== 'invoice_variance'))
  const viewer = (await signalsAt(null, { roleKey: 'read-only-viewer' })).signals
  const variance = viewer.find((item) => item.type === 'invoice_variance')
  assert.equal(variance.money, null)
  assert.equal(variance.data.variance, null)
})
