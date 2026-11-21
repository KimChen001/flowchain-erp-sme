import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { runAiReadTool } from './ai-read-tool-runner.mjs'
import { buildAiSkillSignals } from './ai-skill-signals.mjs'

// Product review 2026-11-20, item 8: the assistant's "needs attention" used
// other rules than Today and the reorder list. It said "below reorder point"
// for items Today says are covered (the reorder list counts open requests
// and draft orders), and told a requester their own request needed
// attention, which Today shows only to someone who may approve it.

const stock = (sku, stockStatus, extra = {}) => ({ itemId: `I-${sku}`, sku, itemName: sku, stockStatus, available: 40, incomingApprovedPo: 0, safetyStock: 10, reorderPoint: 50, shortage: null, ...extra })
const rows = [
  stock('A', 'below_reorder_point'),
  stock('B', 'ok', { available: 60 }),
  stock('C', 'below_reorder_point'),
  stock('D', 'below_safety_stock', { available: 5, incomingApprovedPo: 20 }),
  stock('E', 'below_safety_stock', { available: 5 }),
]
const signalsOf = (reorder) => buildAiSkillSignals({ asOf: '2026-09-29', inventory: { rows }, ...(reorder === undefined ? {} : { reorder }) })
const byType = (signals, type) => signals.filter((row) => row.type === type).map((row) => row.label).sort()
const coveredOf = (signals, sku) => signals.find((row) => row.type === 'stock_below_safety' && row.label === sku)?.data.covered

test('"below the reorder point" follows the reorder list\'s order now; an item it cannot judge is not checked', () => {
  const reorder = {
    rows: [{ sku: 'A', orderNow: false, incoming: 0 }, { sku: 'B', orderNow: true, incoming: 0 }, { sku: 'D', orderNow: false, incoming: 20 }, { sku: 'E', orderNow: true, incoming: 0 }],
    notJudged: [{ sku: 'C' }],
  }
  const signals = signalsOf(reorder)
  // A: an open request covers it on the list; B: the list asks for an order
  // though the stock record's status is fine; C: not judged, so not checked,
  // as on Today (#409 review), whatever its stock status says.
  assert.deepEqual(byType(signals, 'stock_below_reorder'), ['B'])
  // Below safety stock on hand either way; covered when the list asks for no
  // order and stock is coming, as the inventory pages say.
  assert.deepEqual(byType(signals, 'stock_below_safety'), ['D', 'E'])
  assert.deepEqual([coveredOf(signals, 'D'), coveredOf(signals, 'E')], [true, false])
  // An item the list holds no row for is above its reorder point there.
  assert.equal(signalsOf({ rows: [], notJudged: [] }).some((row) => row.type === 'stock_below_reorder'), false)
})

test('without the reorder list the stock signals are as before', () => {
  const signals = signalsOf(undefined)
  assert.deepEqual(byType(signals, 'stock_below_reorder'), ['A', 'C'])
  assert.deepEqual([coveredOf(signals, 'D'), coveredOf(signals, 'E')], [true, false])
  assert.deepEqual(byType(signalsOf(null), 'stock_below_reorder'), ['A', 'C'])
})

async function factsFor({ roleKey = 'workspace-administrator', requester = null } = {}) {
  const scenario = aiSkillScenario({ roleKey })
  if (requester) for (const row of scenario.data.purchaseRequests) row.requester = requester
  const context = await loadAiSkillContext(scenario.ctx)
  return readAiSkillFacts(context)
}
const waitingRequests = (signals) => signals.filter((row) => row.type === 'pr_awaiting_approval').map((row) => row.entityId)

test('a request waits for approval in "needs attention" only for someone who may approve it, as on Today', async () => {
  // Someone else's request: the administrator may approve it.
  const other = await factsFor({ requester: 'someone-else' })
  assert.deepEqual(other.purchaseRequests.toApprove.map((row) => row.id), ['PR-001'])
  assert.deepEqual(waitingRequests(buildAiSkillSignals(other)), ['PR-001'])
  // Their own request, with another approver possible: not theirs to act on.
  const own = await factsFor({ requester: 'workspace-administrator-user' })
  assert.deepEqual(own.purchaseRequests.toApprove, [])
  assert.deepEqual(waitingRequests(buildAiSkillSignals(own)), [])
  // A question about the requests waiting still reads every one.
  assert.deepEqual(own.purchaseRequests.awaitingApproval.map((row) => row.id), ['PR-001'])
  // A reader who may not approve requests sees none to act on.
  const viewer = await factsFor({ roleKey: 'read-only-viewer', requester: 'someone-else' })
  assert.deepEqual(viewer.purchaseRequests?.toApprove ?? [], [])
  assert.deepEqual(waitingRequests(buildAiSkillSignals(viewer)), [])
})

test('attention_list reads the reorder list once per answer and ranks stock by its order now', async () => {
  const scenario = aiSkillScenario()
  const plain = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  // An item the stock record calls fine, which the reorder list asks to order.
  const fine = plain.inventory.rows.find((row) => !['out_of_stock', 'below_safety_stock', 'below_reorder_point'].includes(row.stockStatus))
  assert.ok(fine, 'the scenario has an item at its levels')
  let reads = 0
  const reorderList = { read: async () => { reads += 1; return { rows: [{ sku: fine.sku, orderNow: true, incoming: 0 }], notJudged: [] } } }
  const context = await loadAiSkillContext({ ...scenario.ctx, aiReadServices: { reorderList } })
  const facts = await readAiSkillFacts(context)
  const run = async (args) => (await runAiReadTool('attention_list', args, { facts, context })).result
  const below = await run({ kind: 'problems', types: ['stock_below_reorder'], limit: 10 })
  assert.deepEqual(below.rows.map((row) => row.label), [fine.sku])
  await run({ kind: 'today' })
  assert.equal(reads, 1)
})

// #409 review: an item with no row on the list counts no incoming stock (the
// shared rule), and one the list could not judge is never "covered".
test('stock under its safety level is covered only by the list\'s own row', () => {
  const below = [stock('F', 'below_safety_stock', { available: 5, incomingApprovedPo: 30 }), stock('G', 'below_safety_stock', { available: 5, incomingApprovedPo: 30 })]
  const signals = buildAiSkillSignals({ asOf: '2026-09-29', inventory: { rows: below }, reorder: { rows: [], notJudged: [{ sku: 'G' }] } })
  assert.deepEqual([coveredOf(signals, 'F'), coveredOf(signals, 'G')], [false, false])
})

// #409 review: items the list could not judge are said to be not checked,
// as Today says it, never dropped without a word.
test('attention_list says how many items were not checked for stock', async () => {
  const scenario = aiSkillScenario()
  const plain = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const [first, second] = plain.inventory.rows
  const run = async (notJudged) => {
    const reorderList = { read: async () => ({ rows: [], notJudged }) }
    const context = await loadAiSkillContext({ ...scenario.ctx, aiReadServices: { reorderList } })
    const facts = await readAiSkillFacts(context)
    return (await runAiReadTool('attention_list', { kind: 'today' }, { facts, context })).result
  }
  assert.deepEqual((await run([{ sku: first.sku }, { sku: second.sku }])).stockNotChecked, { items: 2, reason: 'reader_sees_some_warehouses' })
  assert.equal((await run([])).stockNotChecked, undefined)
})
