import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { AI_SKILL_SIGNAL_SEVERITY, AI_SKILL_SIGNAL_TYPES, buildAiSkillSignals, compareSignalsByDate, countAiSkillSignals, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'

async function signalsAt(now, options) {
  const scenario = aiSkillScenario(options)
  if (now) scenario.ctx.aiSkillNow = new Date(now)
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  return { facts, signals: buildAiSkillSignals(facts) }
}

test('on the seed day the records are ordered by date, ties by id, with no score', async () => {
  const { signals } = await signalsAt()
  const ranked = rankAiSkillItemsByDate(signals)
  // Overdue first (longest late first), then due within 7 days, then open
  // problems (open longest first), then undated stock, then due later.
  assert.deepEqual(ranked.map((item) => [item.entityId, item.type, item.when.kind, item.when.date]), [
    ['PO-001', 'po_overdue', 'overdue', '2026-09-25'],
    ['PO-008', 'po_overdue', 'overdue', '2026-09-27'],
    ['PO-002', 'po_due_7d', 'due', '2026-10-03'],
    ['INV-001', 'invoice_variance', 'open', '2026-09-24'],
    ['GRN-002', 'grn_received_unposted', 'open', '2026-09-28'],
    ['ITEM-001', 'stock_shortage', 'undated', null],
    ['RFQ-001', 'rfq_ready_to_award', 'undated', null],
    ['PR-001', 'pr_awaiting_approval', 'due', '2026-10-13'],
  ])
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8])
  for (let index = 1; index < ranked.length; index += 1) assert.ok(compareSignalsByDate(ranked[index - 1], ranked[index]) < 0)
  // No signal carries a score or weight; the label is fixed per type.
  for (const item of signals) {
    assert.ok(!('score' in item) && !('weight' in item), item.id)
    if (item.type !== 'pr_awaiting_approval') assert.equal(item.severity, AI_SKILL_SIGNAL_SEVERITY[item.type], item.id)
  }
  // A request recorded as high priority is a warning; the label never orders the list.
  assert.equal(signals.find((item) => item.entityId === 'PR-001').data.priority, 'high')
  assert.equal(signals.find((item) => item.entityId === 'PR-001').severity, 'warning')
  // A record's other signals are kept with it.
  assert.deepEqual(ranked.find((item) => item.entityId === 'ITEM-001').also, ['stock_below_safety'])
  assert.deepEqual(ranked.find((item) => item.entityId === 'PO-001').also, ['po_partially_received'])
  assert.deepEqual(ranked.find((item) => item.entityId === 'GRN-002').also, ['grn_rejected_qty'])
  // The LDM-001 shortage is already covered by open purchase orders.
  const shortage = signals.find((item) => item.type === 'stock_shortage')
  assert.deepEqual([shortage.label, shortage.data.shortage, shortage.data.incoming, shortage.data.covered, shortage.data.pendingRequests], ['LDM-001', 7, 70, true, 50])
  const counts = countAiSkillSignals(signals)
  assert.equal(counts.po_overdue, 2)
  assert.deepEqual(Object.keys(counts), [...AI_SKILL_SIGNAL_TYPES])
})

test('days late are counted per report day and keep ordering by date', async () => {
  // Ten days later the same data has PO-002 six days late and PO-001 fourteen.
  const later = rankAiSkillItemsByDate((await signalsAt('2026-10-09T12:00:00Z')).signals)
  const overdue = later.filter((item) => item.type === 'po_overdue').map((item) => [item.entityId, item.data.days, item.when.date])
  assert.deepEqual(overdue, [['PO-001', 14, '2026-09-25'], ['PO-008', 12, '2026-09-27'], ['PO-002', 6, '2026-10-03']])
  // Far later the order is still by date and nothing is capped.
  const much = rankAiSkillItemsByDate((await signalsAt('2027-03-01T12:00:00Z')).signals).filter((item) => item.type === 'po_overdue')
  assert.deepEqual(much.map((item) => item.entityId), ['PO-001', 'PO-008', 'PO-002', 'PO-009'])
  assert.ok(much.every((item) => item.data.days > 100 && !('score' in item)))
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
