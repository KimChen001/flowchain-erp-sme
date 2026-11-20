import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SUPPLIER_RELIABILITY_CONTRACT_VERSION, supplierReliabilityOutcomesSchema, supplierReliabilityResponseSchema } from '../../shared/supplier-reliability-contract.mjs'
import { manualReplies, notRecordedReplies, openReplies, recordedReplies, reliabilityRows } from '../../src/modules/srm/supplierReliability.ts'
import { supplierCopy, supplierCopyPairs } from '../../src/modules/srm/supplierCopy.ts'

// The promised dates and supplier replies block on Supplier evaluation
// (docs/supplier-reply-dates-design.md §4.12): which suppliers it lists, how
// reply outcomes group, that its words are in English and Chinese, and that
// it stays apart from the on time and OTIF columns.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const card = read('src/modules/srm/SupplierReliabilityCard.tsx')
const page = read('src/modules/srm/SupplierEvaluationPage.tsx')

const outcomes = { recordedUnchanged: 2, recordedEdited: 1, recordedManual: 1, notRecorded: { wrong_reading: 1, supplier_will_confirm: 1, other: 0 }, needsYou: 1, proposed: 1, nothingToRecord: 1 }
const revisions = (orders, over = {}) => ({ orders, revisedOrders: 0, revisions: 0, perOrder: orders >= 5 ? 0 : null, averageDaysMoved: null, movedLater: { count: 0, of: 0, share: null }, ...over })
const replies = (received, over = {}) => ({ received, read: received, withStatedDate: { count: 0, of: received, share: null }, outcomes: { ...outcomes, recordedUnchanged: 0, recordedEdited: 0, recordedManual: 0, notRecorded: { wrong_reading: 0, supplier_will_confirm: 0, other: 0 }, needsYou: 0, proposed: 0, nothingToRecord: received }, recorded: 0, medianHoursToRecord: null, ...over })
const response = (suppliers, visibility = { revisions: true, replies: true }) => {
  const value = { contractVersion: SUPPLIER_RELIABILITY_CONTRACT_VERSION, asOf: '2026-11-20', window: { from: '2026-08-23', to: '2026-11-20', days: 90 }, minimumSample: 5, visibility, suppliers }
  assert.ok(supplierReliabilityResponseSchema.safeParse(value).success)
  return value
}
const shown = [{ id: 'sup-b' }, { id: 'sup-a' }, { id: 'sup-quiet' }, { id: 'sup-missing' }]

test('the block lists suppliers with an order due or a reply, in the table\'s order, and counts the rest', () => {
  const data = response({
    'sup-a': { revisions: revisions(6), replies: replies(0) },
    'sup-b': { revisions: revisions(0), replies: replies(2) },
    'sup-quiet': { revisions: revisions(0), replies: replies(0) },
  })
  const { listed, quiet } = reliabilityRows(shown, data)
  assert.deepEqual(listed.map((row) => row.id), ['sup-b', 'sup-a'])
  assert.equal(quiet, 2)
})

test('a part the reader may not read lists nobody by it', () => {
  const data = response({ 'sup-a': { revisions: null, replies: replies(3) }, 'sup-b': { revisions: null, replies: replies(0) } }, { revisions: false, replies: true })
  assert.deepEqual(reliabilityRows(shown, data).listed.map((row) => row.id), ['sup-a'])
  const none = response({ 'sup-a': { revisions: null, replies: null } }, { revisions: false, replies: false })
  assert.deepEqual(reliabilityRows(shown, none).listed, [])
  // The card shows nothing at all then, never zeros.
  assert.match(card, /if \(data && !data\.visibility\.revisions && !data\.visibility\.replies\) return null;/)
  assert.match(card, /const headers = \[\.\.\.\(showRevisions \? REVISION_HEADERS : \[\]\), \.\.\.\(showReplies \? REPLY_HEADERS : \[\]\)\];/)
})

test('reply outcomes group into recorded, recorded by hand, not recorded and open, and add up to the replies received', () => {
  assert.equal(recordedReplies(outcomes), 3)
  assert.equal(manualReplies(outcomes), 1)
  assert.equal(notRecordedReplies(outcomes), 2)
  assert.equal(openReplies(outcomes), 2)
  assert.equal(recordedReplies(outcomes) + manualReplies(outcomes) + notRecordedReplies(outcomes) + openReplies(outcomes) + outcomes.nothingToRecord, 9)
  // Every outcome the contract has is grouped, so none drops out of the cell.
  const groups = { recordedUnchanged: 'recorded', recordedEdited: 'recorded', recordedManual: 'manual', notRecorded: 'not recorded', needsYou: 'open', proposed: 'open', nothingToRecord: 'tooltip' }
  assert.deepEqual(Object.keys(supplierReliabilityOutcomesSchema.shape).sort(), Object.keys(groups).sort())
  // Recorded by hand shows in the cell and in the tooltip.
  assert.match(card, /t\("Recorded by hand: \{n\}", \{ n: outcomes\.recordedManual \}\)/)
  assert.match(card, /manualReplies\(outcomes\) \? t\("\{n\} recorded by hand", \{ n: manualReplies\(outcomes\) \}\) : null/)
  assert.equal(supplierCopy('{n} recorded by hand', 'zh-CN'), '手动记录 {n}')
})

test('every word on the block is in English and Chinese, with its placeholders', () => {
  const quoted = [...card.matchAll(/\bt\("([^"]+)"/g), ...card.matchAll(/\["([^"]+)", "([^"]+)"\]/g)].flatMap((match) => match.slice(1))
  assert.ok(quoted.length >= 40, `found ${quoted.length}`)
  for (const english of quoted) {
    const chinese = supplierCopyPairs[english]
    assert.ok(chinese, `no Chinese for "${english}"`)
    for (const placeholder of english.match(/\{\w+\}/g) || []) assert.ok(chinese.includes(placeholder), `"${chinese}" lacks ${placeholder}`)
  }
  assert.equal(supplierCopy('Average days moved', 'zh-CN'), '平均变动天数')
  assert.equal(supplierCopy('平均变动天数', 'en-US'), 'Average days moved')
  // Numbers follow the workspace locale, never the interface language.
  assert.match(card, /new Intl\.NumberFormat\(locale, options\)/)
  assert.match(card, /formatCalendarDay\(data\.window\.from, locale\)/)
})

test('small samples show "—" with the counts and the minimum in the tooltip', () => {
  assert.match(card, /part\.perOrder === null \? dash\(`\$\{changes\} \$\{t\("A figure needs \{n\} orders\.", \{ n: minimum \}\)\}`, true\)/)
  assert.match(card, /part\.averageDaysMoved === null \? dash\(`\$\{changes\} \$\{later\} \$\{t\("A figure needs \{n\} date changes\.", \{ n: minimum \}\)\}`, true\)/)
  assert.match(card, /part\.withStatedDate\.share === null \? dash\(`\$\{counts\} \$\{t\("A percentage needs \{n\} replies read\.", \{ n: minimum \}\)\}`, true\)/)
})

test('the block sits below the indicator table and leaves on time and OTIF as they are', () => {
  const table = page.indexOf('data-testid="supplier-evaluation-table"')
  const block = page.indexOf('<SupplierReliabilityCard suppliers={shown} loadKey={reliabilityLoads} />')
  assert.ok(table > 0 && block > table)
  assert.ok(page.includes('<td className={`${tdNumericRightClass} !px-3`}>{onTimeCell(insight)}</td>'))
  assert.ok(page.includes('<td className={`${tdNumericRightClass} !px-3`}>{otifCell(insight)}</td>'))
  assert.ok(!page.includes('averageDaysMoved'))
  // It reads the contract's route and checks the answer against the contract.
  assert.match(card, /apiJson<unknown>\(SUPPLIER_RELIABILITY_ROUTE\)/)
  assert.match(card, /supplierReliabilityResponseSchema\.safeParse\(value\)/)
})
