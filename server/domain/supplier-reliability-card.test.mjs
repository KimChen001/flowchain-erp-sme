import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SUPPLIER_RELIABILITY_CONTRACT_VERSION, supplierReliabilityOutcomesSchema, supplierReliabilityResponseSchema } from '../../shared/supplier-reliability-contract.mjs'
import { manualReplies, notRecordedReplies, openReplies, outcomeParts, recordedReplies, reliabilityRows, reliabilityScope } from '../../src/modules/srm/supplierReliability.ts'
import { supplierCopy, supplierCopyPairs } from '../../src/modules/srm/supplierCopy.ts'

// The promised dates and supplier replies block on Supplier evaluation
// (docs/supplier-reply-dates-design.md §4.12): which suppliers it lists, how
// reply outcomes group, what it says of quiet suppliers, the counts it shows
// under the minimum sample, that its words are in English and Chinese, and
// that it stays apart from the on time and OTIF columns.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const card = read('src/modules/srm/SupplierReliabilityCard.tsx')
const page = read('src/modules/srm/SupplierEvaluationPage.tsx')

const none = { recordedUnchanged: 0, recordedEdited: 0, recordedManual: 0, notRecorded: { wrong_reading: 0, supplier_will_confirm: 0, other: 0 }, needsYou: 0, proposed: 0, nothingToRecord: 0 }
const outcomes = { recordedUnchanged: 2, recordedEdited: 1, recordedManual: 1, notRecorded: { wrong_reading: 1, supplier_will_confirm: 1, other: 0 }, needsYou: 1, proposed: 1, nothingToRecord: 1 }
const total = (value) => value.recordedUnchanged + value.recordedEdited + value.recordedManual + value.notRecorded.wrong_reading + value.notRecorded.supplier_will_confirm + value.notRecorded.other + value.needsYou + value.proposed + value.nothingToRecord
const revisions = (orders, over = {}) => ({ orders, revisedOrders: 0, revisions: 0, perOrder: orders >= 5 ? 0 : null, averageDaysMoved: null, movedLater: { count: 0, of: 0, share: null }, ...over })
const replies = (received, over = {}) => ({ received, read: received, withStatedDate: { count: 0, of: received, share: null }, outcomes: { ...none, nothingToRecord: received }, recorded: 0, medianHoursToRecord: null, ...over })
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

test('a part the reader may not read lists nobody by it, and the quiet line names only what they can see', () => {
  const data = response({ 'sup-a': { revisions: null, replies: replies(3) }, 'sup-b': { revisions: null, replies: replies(0) } }, { revisions: false, replies: true })
  assert.deepEqual(reliabilityRows(shown, data).listed.map((row) => row.id), ['sup-a'])
  assert.equal(reliabilityScope(data.visibility), 'replies')
  assert.equal(reliabilityScope({ revisions: true, replies: false }), 'orders')
  assert.equal(reliabilityScope({ revisions: true, replies: true }), 'both')
  // Each scope has its own empty state and quiet line, never "no orders due"
  // to a reader who cannot see orders.
  assert.match(card, /scope === "orders" \? t\("No orders due in these 90 days\."\) : scope === "replies" \? t\("No replies in these 90 days\."\) : t\("No orders due and no supplier replies in these 90 days\."\)/)
  assert.match(card, /if \(scope === "replies"\) return n === 1 \? t\("1 supplier with no replies in these 90 days is not listed\."\) : t\("\{n\} suppliers with no replies in these 90 days are not listed\.", \{ n \}\);/)
  assert.match(card, /if \(scope === "orders"\) return n === 1 \? t\("1 supplier with no orders due in these 90 days is not listed\."\) : t\("\{n\} suppliers with no orders due in these 90 days are not listed\.", \{ n \}\);/)
  const neither = response({ 'sup-a': { revisions: null, replies: null } }, { revisions: false, replies: false })
  assert.deepEqual(reliabilityRows(shown, neither).listed, [])
  // The card shows nothing at all then, never zeros.
  assert.match(card, /if \(hidden \|\| \(data && !data\.visibility\.revisions && !data\.visibility\.replies\)\) return null;/)
  assert.match(card, /const headers = \[\.\.\.\(showRevisions \? REVISION_HEADERS : \[\]\), \.\.\.\(showReplies \? REPLY_HEADERS : \[\]\)\];/)
})

test('the outcome cell shows every group with a reply in it, so its parts add up to the replies received', () => {
  assert.equal(recordedReplies(outcomes), 3)
  assert.equal(manualReplies(outcomes), 1)
  assert.equal(notRecordedReplies(outcomes), 2)
  assert.equal(openReplies(outcomes), 2)
  const sum = (parts) => parts.reduce((all, { n }) => all + n, 0)
  assert.deepEqual(outcomeParts(outcomes), [
    { part: 'recorded', n: 3 }, { part: 'manual', n: 1 }, { part: 'notRecorded', n: 2 }, { part: 'open', n: 2 }, { part: 'nothingToRecord', n: 1 },
  ])
  assert.equal(sum(outcomeParts(outcomes)), total(outcomes))
  // Only auto-replies: "2 with nothing to record", never "0 recorded".
  assert.deepEqual(outcomeParts({ ...none, nothingToRecord: 2 }), [{ part: 'nothingToRecord', n: 2 }])
  // Only typed by hand.
  assert.deepEqual(outcomeParts({ ...none, recordedManual: 1 }), [{ part: 'manual', n: 1 }])
  // Every way the outcomes can fall adds up, one reply moved at a time.
  for (const key of ['recordedUnchanged', 'recordedEdited', 'recordedManual', 'needsYou', 'proposed', 'nothingToRecord']) {
    const one = { ...none, [key]: 3 }
    assert.equal(sum(outcomeParts(one)), 3, key)
  }
  for (const reason of ['wrong_reading', 'supplier_will_confirm', 'other']) assert.equal(sum(outcomeParts({ ...none, notRecorded: { ...none.notRecorded, [reason]: 2 } })), 2, reason)
  // Every outcome the contract has is grouped, so none drops out of the cell.
  assert.deepEqual(Object.keys(supplierReliabilityOutcomesSchema.shape).sort(), Object.keys(none).sort())
  // The cell is built from these parts, and the tooltip lists each outcome.
  assert.match(card, /const summary = outcomeParts\(outcomes\)\.map\(\(\{ part: group, n \}\) => t\(OUTCOME_PART_TEXT\[group\], \{ n: number\(n\) \}\)\)\.join\(" · "\);/)
  assert.match(card, /t\("Recorded by hand: \{n\}", \{ n: outcomes\.recordedManual \}\)/)
  assert.match(card, /t\("Nothing to record: \{n\}", \{ n: outcomes\.nothingToRecord \}\)/)
  assert.equal(supplierCopy('{n} with nothing to record', 'zh-CN'), '无需记录 {n}')
  assert.equal(supplierCopy('{n} recorded by hand', 'zh-CN'), '手动记录 {n}')
})

test('under the minimum sample a figure gives way to its counts, never a bare "—", with the minimum in the tooltip', () => {
  // Per order: "1 change · 2 orders"; average days moved: the changes and the share moved later as counts.
  assert.match(card, /part\.perOrder === null \? counts\(`\$\{changesText\(part\.revisions\)\} · \$\{ordersText\(part\.orders\)\}`, `\$\{changes\} \$\{t\("A figure needs \{n\} orders\.", \{ n: minimum \}\)\}`\)/)
  assert.match(card, /counts\(changesText\(part\.revisions\), `\$\{changes\} \$\{later\} \$\{t\("A figure needs \{n\} date changes\.", \{ n: minimum \}\)\}`\)\}\{laterLine\}/)
  assert.match(card, /part\.movedLater\.share === null \? ratio\(part\.movedLater\.count, part\.movedLater\.of\) : percent\(part\.movedLater\.share\)/)
  // Replies with a date: "1/3", as on time shows "3/3".
  assert.match(card, /part\.withStatedDate\.share === null \? counts\(ratio\(part\.withStatedDate\.count, part\.withStatedDate\.of\), `\$\{stated\} \$\{t\("A percentage needs \{n\} replies read\.", \{ n: minimum \}\)\}`\)/)
  // "—" only where there is nothing to count.
  for (const line of card.split('\n').filter((text) => text.includes('dash('))) {
    if (/const dash|hiddenCell =/.test(line)) continue
    assert.match(line, /dash\((t\("No |none\)|part\.orders \? t\("No date changes)/, line.trim())
  }
})

test('every word on the block is in English and Chinese, with its placeholders', () => {
  const quoted = [
    ...card.matchAll(/\bt\("([^"]+)"/g),
    ...card.matchAll(/\["([^"]+)", "([^"]+)"\]/g),
    ...card.matchAll(/^\s+\w+: "([^"]+)",$/gm),
  ].flatMap((match) => match.slice(1))
  assert.ok(quoted.length >= 50, `found ${quoted.length}`)
  for (const english of quoted) {
    const chinese = supplierCopyPairs[english]
    assert.ok(chinese, `no Chinese for "${english}"`)
    for (const placeholder of english.match(/\{\w+\}/g) || []) assert.ok(chinese.includes(placeholder), `"${chinese}" lacks ${placeholder}`)
  }
  assert.equal(supplierCopy('Average days moved', 'zh-CN'), '平均变动天数')
  assert.equal(supplierCopy('平均变动天数', 'en-US'), 'Average days moved')
  // Numbers and dates follow the workspace locale, never the interface
  // language, also a count filled into a sentence (the quiet line, tooltips).
  assert.match(card, /new Intl\.NumberFormat\(locale, options\)/)
  assert.match(card, /join\(typeof filled === "number" \? new Intl\.NumberFormat\(locale\)\.format\(filled\) : filled\)/)
  assert.match(card, /formatCalendarDay\(data\.window\.from, locale\)/)
})

test('the block sits below the indicator table, stays mounted while hidden, and leaves on time and OTIF as they are', () => {
  const table = page.indexOf('data-testid="supplier-evaluation-table"')
  const block = page.indexOf('<SupplierReliabilityCard suppliers={shown} loadKey={reliabilityLoads} hidden={error || rows.length === 0} />')
  assert.ok(table > 0 && block > table)
  assert.ok(!/\? <SupplierReliabilityCard/.test(page), 'the card is not mounted conditionally')
  assert.ok(page.includes('<td className={`${tdNumericRightClass} !px-3`}>{onTimeCell(insight)}</td>'))
  assert.ok(page.includes('<td className={`${tdNumericRightClass} !px-3`}>{otifCell(insight)}</td>'))
  assert.ok(!page.includes('averageDaysMoved'))
  // It reads the contract's route, drops an older answer, and checks the answer against the contract.
  assert.match(card, /apiJson<unknown>\(SUPPLIER_RELIABILITY_ROUTE\)/)
  assert.match(card, /if \(!current\) return;/)
  assert.match(card, /supplierReliabilityResponseSchema\.safeParse\(value\)/)
})
