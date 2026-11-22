// Runs and scores one email about several orders (the fourth held-out batch,
// assessment §9): which named orders are read (emailOrdersToRead, as the
// paste does), then each read order as a one-order case (score.mjs) against
// that order's expected outcome. No database.
//
//   hard fail  any read order's hard fail (a date proposed on an order whose
//              part does not hold it is never expected there), or an order
//              read that the case lists as not read;
//   miss       an order the case reads that is not read, or any order's miss;
//   otherwise  the worst of the read orders' verdicts (state, held, ok).
//
// The eval target (§9): no date on the wrong order, and at least 80% of the
// dated per-order parts correct.
import { emailOrdersToRead, orderNumbersNamed } from '../../../server/domain/supplier-reply-orders.mjs'
import { SUPPLIER_REPLY_ORDER_STATES, cleanSupplierReply } from '../../../server/domain/supplier-reply-reading.mjs'
import { SUPPLIER_REPLY_EMAIL_ORDER_LIMIT } from '../../../shared/supplier-reply-contract.mjs'
import { runSupplierReplyCase, scoreSupplierReplyCase } from './score.mjs'

export const SEVERAL_ORDERS_GATE = Object.freeze({ hardFails: 0, datedCorrect: 0.8 })

const upper = (value) => String(value ?? '').trim().toUpperCase()
const orderOf = (kase, number) => kase.orders.find((order) => upper(order.number) === upper(number)) || null

// The case as the paste runs it: one reading per order read.
export async function runSeveralOrdersCase(kase, callModel) {
  const cleaned = cleanSupplierReply(kase.replyText)
  const anchor = orderOf(kase, kase.pastedOn) || kase.orders[0]
  const named = orderNumbersNamed(cleaned.text, anchor?.number)
  const choice = named.length >= 2
    ? emailOrdersToRead({ named, pastedOn: kase.pastedOn || null, orders: kase.orders.map((order) => ({ number: order.number, status: order.status, supplier: order.supplierName || null })), openStates: SUPPLIER_REPLY_ORDER_STATES, limit: SUPPLIER_REPLY_EMAIL_ORDER_LIMIT })
    : { read: kase.pastedOn ? [upper(kase.pastedOn)] : [], notRead: [] }
  const byOrder = {}
  for (const number of choice.read) byOrder[number] = await runSupplierReplyCase({ ...kase, order: orderOf(kase, number) }, callModel)
  return { cleaned, named, choice, byOrder }
}

export function scoreSeveralOrdersCase(kase, run) {
  const { expected } = kase
  const wantRead = expected.read.map(upper)
  const wantOf = (number) => Object.entries(expected.byOrder).find(([key]) => upper(key) === number)?.[1] || null
  const orders = {}
  const hardFails = []
  const misses = []
  for (const number of run.choice.read) {
    const want = wantOf(number)
    if (!wantRead.includes(number) || !want) { hardFails.push({ order: number, reasons: ['read, where the case does not read it'] }); continue }
    const score = scoreSupplierReplyCase({ ...kase, order: orderOf(kase, number), expected: { flags: [], mustNotPropose: [], injection: false, ...want } }, run.byOrder[number])
    orders[number] = score
    for (const fail of score.hardFails) hardFails.push({ order: number, ...fail })
    for (const miss of score.misses) misses.push({ order: number, ...miss })
  }
  let unreadDated = 0
  for (const number of wantRead) {
    if (run.choice.read.includes(number)) continue
    misses.push({ order: number, expected: 'read', got: `not read (${run.choice.notRead.find((row) => row.number === number)?.why || 'not named'})` })
    if (wantOf(number)?.state === 'proposed') unreadDated += 1
  }
  // Not gating: a listed order listed for another reason.
  const listed = expected.notRead.filter((want) => {
    const got = run.choice.notRead.find((row) => row.number === upper(want.number))
    return !got || got.why !== want.why
  }).map((want) => `${want.number}: expected ${want.why}, got ${run.choice.notRead.find((row) => row.number === upper(want.number))?.why || (run.choice.read.includes(upper(want.number)) ? 'read' : 'absent')}`)
  const verdicts = Object.values(orders).map((score) => score.verdict)
  const verdict = hardFails.length ? 'hard_fail' : misses.length ? 'miss' : verdicts.includes('state') ? 'state' : verdicts.includes('held') ? 'held' : 'ok'
  return {
    id: kase.id,
    lang: kase.lang,
    verdict,
    hardFails,
    misses,
    listed,
    orders,
    dated: Object.values(orders).filter((score) => score.dated).length + unreadDated,
    datedCorrect: Object.values(orders).filter((score) => score.datedCorrect).length,
  }
}

export function summarizeSeveralOrdersRun(scores) {
  const dated = scores.reduce((total, row) => total + row.dated, 0)
  const datedCorrect = scores.reduce((total, row) => total + row.datedCorrect, 0)
  const hardFails = scores.filter((row) => row.verdict === 'hard_fail').length
  const share = dated ? datedCorrect / dated : 1
  return {
    cases: scores.length,
    ok: scores.filter((row) => row.verdict === 'ok').length,
    hardFails,
    misses: scores.filter((row) => row.verdict === 'miss').length,
    dated,
    datedCorrect,
    datedCorrectShare: Math.round(share * 1000) / 1000,
    gate: { pass: hardFails <= SEVERAL_ORDERS_GATE.hardFails && share >= SEVERAL_ORDERS_GATE.datedCorrect, hardFails, datedCorrectShare: Math.round(share * 1000) / 1000 },
  }
}
