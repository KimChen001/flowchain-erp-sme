// Runs and scores the supplier reply set (README.md) against the reading as
// the server runs it (server/domain/supplier-reply-reading.mjs): clean the
// pasted text, read it with the given callModel, check the reading in code.
// No database. Scoring follows docs/supplier-reply-dates-design.md §7:
//
//   hard fail  a line proposed with a date the case does not expect for it:
//              a wrong date, a line the case does not expect proposed, or a
//              value in the case's mustNotPropose (old quoted dates, injected
//              dates, another order's date, a refused date);
//   miss       a line the case expects proposed that is not (needs you,
//              dropped, confirmed or absent), with no hard fail;
//   state      neither, but the card's state is not the expected one;
//   held       a line left for the person on an issue the case accepts
//              (acceptNeedsYou: a refused date read as the claim), not a miss;
//   ok         otherwise.
//
// The gate (#363 SR-6): no hard fail, and at least 90% of the dated cases
// (expected state proposed) correct: every expected line proposed with its
// date and no hard fail.
import { checkReplyReading, cleanSupplierReply, readSupplierReply, supplierReplyInstructionsIgnored } from '../../../server/domain/supplier-reply-reading.mjs'

export const SUPPLIER_REPLY_GATE = Object.freeze({ hardFails: 0, datedCorrect: 0.9 })

// One case as the server runs a paste: the cleaned text goes to the reading
// and to the checks. callModel({ system, messages, maxTokens }) → { text, usage? }.
export async function runSupplierReplyCase(kase, callModel) {
  const cleaned = cleanSupplierReply(kase.replyText)
  const read = await readSupplierReply({ order: kase.order, text: cleaned.text, receivedOn: kase.replyDate, today: kase.today, callModel })
  const check = read.readingStatus === 'read'
    ? checkReplyReading({ order: kase.order, text: cleaned.text, receivedOn: kase.replyDate, reading: read.reading, emailRead: kase.emailRead, inlineFrom: cleaned.inlineFrom })
    : null
  // The card's "not followed" notice, set from the raw paste as the server sets it.
  return { cleaned, read, check, instructionsIgnored: supplierReplyInstructionsIgnored(kase.replyText) }
}

const matches = (entry, line) => (!entry.ref || entry.ref === line.ref) && (!entry.date || entry.date === line.proposedDate)

// The score of one run of one case. A reading that did not come back (an
// outage or two invalid answers) shows the person the manual form: needs you,
// nothing proposed.
export function scoreSupplierReplyCase(kase, run) {
  const { expected } = kase
  const lines = run.check?.lines || []
  const gotState = run.check?.state || 'needs_you'
  const proposed = lines.filter((line) => line.outcome === 'proposed')
  const expectedByRef = new Map(expected.lines.map((line) => [line.ref, line]))

  const hardFails = []
  for (const line of proposed) {
    const reasons = []
    const want = expectedByRef.get(line.ref)
    if (!want) reasons.push('a line the case does not expect is proposed')
    else if (want.outcome !== 'proposed') reasons.push(`proposed where the case expects ${want.outcome}${want.proposedDate ? ` ${want.proposedDate}` : ''}`)
    else if (want.proposedDate !== line.proposedDate) reasons.push(`wrong date: expected ${want.proposedDate}`)
    for (const entry of expected.mustNotPropose) if (matches(entry, line)) reasons.push(`never to propose: ${entry.why}`)
    if (reasons.length) hardFails.push({ ref: line.ref, date: line.proposedDate, reasons })
  }

  const misses = []
  const held = []
  let expectedProposed = 0
  let correctProposed = 0
  for (const want of expected.lines.filter((line) => line.outcome === 'proposed')) {
    expectedProposed += 1
    const got = proposed.find((line) => line.ref === want.ref)
    if (got && got.proposedDate === want.proposedDate) { correctProposed += 1; continue }
    if (got) continue // a hard fail above
    const other = lines.find((line) => line.ref === want.ref)
    const row = { ref: want.ref, expected: want.proposedDate, got: other ? `${other.outcome}${other.issue ? ` (${other.issue})` : ''}` : 'absent' }
    // Left for the person on an issue the case accepts (a refused date read
    // as the claim: several_dates): not proposed, and not a miss.
    if (want.acceptNeedsYou && other?.outcome === 'needs_you' && other.issue === want.acceptNeedsYou) held.push(row)
    else misses.push(row)
  }

  // Not gating: how each expected line's details came out.
  const details = []
  for (const want of expected.lines) {
    const got = lines.find((line) => line.ref === want.ref)
    if (!got) continue
    if (want.readAs && got.outcome === 'proposed' && (got.readAs?.from !== want.readAs.from || got.readAs?.date !== want.readAs.date)) details.push(`${want.ref} readAs ${JSON.stringify(got.readAs)}`)
    if (want.readings && JSON.stringify([...(got.readings || [])].sort()) !== JSON.stringify([...want.readings].sort())) details.push(`${want.ref} readings ${JSON.stringify(got.readings)}`)
    if (want.parts && got.outcome === 'proposed' && got.parts?.at(-1)?.date !== want.parts.at(-1).date) details.push(`${want.ref} parts ${JSON.stringify(got.parts)}`)
  }
  const flagsFound = expected.flags.filter((want) => (run.check?.flags || []).some((flag) => flag.kind === want.kind && (!want.orderNumber || flag.orderNumber === want.orderNumber)))

  const stateMatch = gotState === expected.state || (expected.alsoAccept || []).includes(gotState)
  const dated = expected.state === 'proposed'
  const datedCorrect = dated && hardFails.length === 0 && correctProposed === expectedProposed
  const verdict = hardFails.length ? 'hard_fail' : misses.length ? 'miss' : !stateMatch ? 'state' : held.length ? 'held' : 'ok'
  return {
    id: kase.id,
    lang: kase.lang,
    workspace: kase.workspace,
    heldOut: Boolean(kase.heldOut),
    readingStatus: run.read?.readingStatus || null,
    expectedState: expected.state,
    gotState,
    verdict,
    stateMatch,
    dated,
    datedCorrect,
    hardFails,
    misses,
    held,
    details,
    flags: { expected: expected.flags.length, found: flagsFound.length },
    injection: { expected: expected.injection, flagged: Boolean(run.instructionsIgnored) },
  }
}

// The gate over the set and a held-out batch: the set's own gate, and no
// hard fail in the held-out batch either.
export function supplierReplyGate(setSummary, heldOutSummary = null) {
  return { pass: setSummary.gate.pass && (!heldOutSummary || heldOutSummary.hardFails === 0), set: setSummary.gate, heldOutHardFails: heldOutSummary ? heldOutSummary.hardFails : null }
}

// Totals over the scored cases, and the gate.
export function summarizeSupplierReplyRun(scores, { calls = 0, inputTokens = 0, outputTokens = 0, costMicros = 0 } = {}) {
  const count = (pick) => scores.filter(pick).length
  const dated = count((row) => row.dated)
  const datedCorrect = count((row) => row.datedCorrect)
  const hardFails = count((row) => row.verdict === 'hard_fail')
  const statuses = {}
  for (const row of scores) statuses[row.readingStatus || 'none'] = (statuses[row.readingStatus || 'none'] || 0) + 1
  const share = dated ? datedCorrect / dated : 1
  return {
    cases: scores.length,
    ok: count((row) => row.verdict === 'ok'),
    hardFails,
    misses: count((row) => row.verdict === 'miss'),
    held: count((row) => row.verdict === 'held'),
    stateOnly: count((row) => row.verdict === 'state'),
    stateMatches: count((row) => row.stateMatch),
    dated,
    datedCorrect,
    datedCorrectShare: Math.round(share * 1000) / 1000,
    nothingToRecord: { expected: count((row) => row.expectedState === 'nothing_to_record'), correct: count((row) => row.expectedState === 'nothing_to_record' && row.gotState === 'nothing_to_record') },
    flags: scores.reduce((total, row) => ({ expected: total.expected + row.flags.expected, found: total.found + row.flags.found }), { expected: 0, found: 0 }),
    injection: { expected: count((row) => row.injection.expected), flagged: count((row) => row.injection.expected && row.injection.flagged), flaggedWithout: count((row) => !row.injection.expected && row.injection.flagged) },
    readingStatus: statuses,
    calls,
    inputTokens,
    outputTokens,
    costUsd: Math.round(costMicros) / 1e6,
    gate: { pass: hardFails <= SUPPLIER_REPLY_GATE.hardFails && share >= SUPPLIER_REPLY_GATE.datedCorrect, hardFails, datedCorrectShare: Math.round(share * 1000) / 1000 },
  }
}
