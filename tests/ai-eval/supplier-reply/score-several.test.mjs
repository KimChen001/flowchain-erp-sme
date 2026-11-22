// The several-orders scorer on a case written here (the fourth held-out
// batch lives on its own branch until its first run): which orders are read,
// each order scored on its own expected outcome, and a date put on the wrong
// order scored as a hard fail even when the reading puts it there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CASE_HELPERS } from './cases.mjs'
import { runSeveralOrdersCase, scoreSeveralOrdersCase, summarizeSeveralOrdersRun } from './score-several.mjs'

const { order, email, proposed } = CASE_HELPERS
const kase = {
  id: 'en-uci-0030-scorer-check', lang: 'en', workspace: 'uci', source: 'paste',
  replyDate: '2026-11-20', today: '2026-11-20',
  pastedOn: 'PO-202610-0030',
  orders: [order('uci', 'PO-202610-0030'), order('uci', 'PO-202610-0028'), { ...order('uci', 'PO-202611-0019'), status: 'closed' }, order('uci', 'PO-202611-0012')],
  replyText: email(`
    Hi Daniel,

    PO-202610-0030 - all 330 heart T-light holders: ships 2 December
    PO-202610-0028 - the 220 still to come: ships 25 November
    PO-202611-0019 - delivered last week
    PO-202611-0012 - not one of ours, I think

    Priya
  `),
  expected: {
    read: ['PO-202610-0030', 'PO-202610-0028'],
    notRead: [{ number: 'PO-202611-0019', why: 'closed' }, { number: 'PO-202611-0012', why: 'other_supplier' }],
    byOrder: {
      'PO-202610-0030': { state: 'proposed', replyKind: 'dates', lines: [proposed('L1', '2026-12-02', 'ships 2 December')], mustNotPropose: [{ date: '2026-11-25', why: "PO-202610-0028's date" }] },
      'PO-202610-0028': { state: 'proposed', replyKind: 'dates', lines: [proposed('L1', '2026-11-25', 'ships 25 November')], mustNotPropose: [{ date: '2026-12-02', why: "PO-202610-0030's date" }] },
    },
  },
}

// A model that answers per order: the order's number is in the prompt.
const answering = (byNumber) => async ({ messages }) => {
  const number = Object.keys(byNumber).find((key) => messages[0].content.includes(`"order":"${key}"`))
  return { text: JSON.stringify(byNumber[number]), usage: { inputTokens: 0, outputTokens: 0 } }
}
const reading = (date, quote) => ({ replyKind: 'dates', lines: [{ line: 'L1', date, quote, dateKind: 'stated' }], flags: [], reason: null })

test('right readings: both open Acme orders read, each on its own part; the closed and the other supplier\'s listed', async () => {
  const run = await runSeveralOrdersCase(kase, answering({
    'PO-202610-0030': reading('2026-12-02', 'PO-202610-0030 - all 330 heart T-light holders: ships 2 December'),
    'PO-202610-0028': reading('2026-11-25', 'PO-202610-0028 - the 220 still to come: ships 25 November'),
  }))
  assert.deepEqual(run.choice, { read: ['PO-202610-0030', 'PO-202610-0028'], notRead: [{ number: 'PO-202611-0019', why: 'closed' }, { number: 'PO-202611-0012', why: 'other_supplier' }] })
  const score = scoreSeveralOrdersCase(kase, run)
  assert.deepEqual([score.verdict, score.dated, score.datedCorrect, score.listed], ['ok', 2, 2, []])
  assert.equal(summarizeSeveralOrdersRun([score]).gate.pass, true)
})

test('a reading that swaps the two orders\' dates proposes neither: the check drops a quote from the other order\'s part', async () => {
  const run = await runSeveralOrdersCase(kase, answering({
    'PO-202610-0030': reading('2026-11-25', 'the 220 still to come: ships 25 November'),
    'PO-202610-0028': reading('2026-12-02', 'all 330 heart T-light holders: ships 2 December'),
  }))
  const score = scoreSeveralOrdersCase(kase, run)
  assert.deepEqual(score.hardFails, [])
  assert.equal(score.verdict, 'miss')
  assert.deepEqual(Object.values(run.byOrder).map((one) => one.check.lines.map((line) => [line.outcome, line.issue])), [[['dropped', 'other_order_text']], [['dropped', 'other_order_text']]])
})

test('an order read that the case does not read is a hard fail; one not read that it reads is a miss', () => {
  const run = { choice: { read: ['PO-202610-0030', 'PO-202611-0019'], notRead: [{ number: 'PO-202610-0028', why: 'over_limit' }] }, byOrder: { 'PO-202610-0030': { check: { state: 'proposed', lines: [{ ref: 'L1', outcome: 'proposed', proposedDate: '2026-12-02' }], flags: [] }, read: { readingStatus: 'read' } } } }
  const score = scoreSeveralOrdersCase(kase, run)
  assert.equal(score.verdict, 'hard_fail')
  assert.deepEqual(score.hardFails.map((row) => row.order), ['PO-202611-0019'])
  assert.deepEqual(score.misses.map((row) => [row.order, row.got]), [['PO-202610-0028', 'not read (over_limit)']])
  assert.deepEqual([score.dated, score.datedCorrect], [2, 1])
})
