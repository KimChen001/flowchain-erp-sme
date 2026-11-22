// Shape checks for blind batch 5 (several orders in one email). These check
// the case data only; they do not run the reader or a model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HELD_OUT_5_CASES } from './held-out-5-cases.mjs'
import { ORDER_SNAPSHOTS } from './orders.mjs'

const OPEN = new Set(['issued', 'partially_received'])
const STATES = new Set(['proposed', 'needs_you', 'nothing_to_record'])
const REPLY_KINDS = new Set(['dates', 'confirms', 'no_date', 'auto_reply', 'other'])
const DATE_KINDS = new Set(['stated', 'relative', 'vague'])
const NOT_READ_WHY = new Set(['closed', 'other_supplier', 'unknown', 'over_limit'])
const DAY = /^\d{4}-\d{2}-\d{2}$/

function fullWidth(digits) {
  return digits.replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0))
}

// The ways a number may be written that still match one order (rule 1).
function writtenForms(number) {
  const match = number.match(/^([A-Z]+)-(\d{6})-(\d{4})$/)
  if (!match) return [number]
  const [, prefix, month, serial] = match
  const short = String(Number(serial))
  return [number, `${prefix} ${month}-${serial}`, `${prefix}-${month}-${short}`, `${prefix} ${short}`, serial, fullWidth(serial)]
}

function namedIn(text, number, allowOtherForms) {
  if (text.includes(number)) return true
  return allowOtherForms && writtenForms(number).some((form) => text.includes(form))
}

test('batch 5 holds 12 cases with unique ids, at least 4 in Chinese, on both workspaces', () => {
  assert.equal(HELD_OUT_5_CASES.length, 12)
  const ids = HELD_OUT_5_CASES.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.ok(HELD_OUT_5_CASES.filter((c) => c.lang === 'zh').length >= 4, 'at least 4 Chinese cases')
  assert.deepEqual([...new Set(HELD_OUT_5_CASES.map((c) => c.workspace))].sort(), ['m5', 'uci'])
  for (const c of HELD_OUT_5_CASES) {
    assert.ok(Object.isFrozen(c), `${c.id} is frozen`)
    assert.equal(c.heldOut, true, c.id)
    assert.ok(['en', 'zh'].includes(c.lang), c.id)
    assert.ok(c.id.startsWith(`${c.lang}-${c.workspace}-`), `${c.id} starts with lang and workspace`)
    assert.ok(c.covers.includes('several-orders') && c.covers.length === 2, `${c.id} covers several-orders plus one point`)
    assert.ok(DAY.test(c.replyDate) && DAY.test(c.today), c.id)
    assert.ok(c.today >= c.replyDate, `${c.id}: today is not before the reply date`)
  }
})

test('each case is read in a supported way: pasted on its first read order, or emailed', () => {
  for (const c of HELD_OUT_5_CASES) {
    if (c.source === 'paste') {
      assert.ok(c.pastedOn, `${c.id} has pastedOn`)
      assert.equal(c.expected.read[0], c.pastedOn, `${c.id}: the pasted order is read first`)
    } else {
      assert.equal(c.source, 'email', c.id)
      assert.equal(c.pastedOn, null, `${c.id}: an emailed reply has pastedOn null`)
    }
    const idOrder = (c.pastedOn ?? c.expected.read[0]).slice(-4)
    assert.equal(c.id.split('-')[2], idOrder, `${c.id} carries the last 4 digits of its pasted or first named order`)
  }
})

test('every read and listed number is named in the reply (in another form only for the written-another-way case)', () => {
  for (const c of HELD_OUT_5_CASES) {
    const otherForms = c.covers.includes('number-written-another-way')
    const numbers = [...c.expected.read, ...c.expected.notRead.map((entry) => entry.number)]
    assert.ok(numbers.length >= 2, `${c.id} names two or more orders`)
    assert.equal(new Set(numbers).size, numbers.length, `${c.id}: no number is both read and listed`)
    for (const number of numbers) {
      assert.ok(namedIn(c.replyText, number, otherForms), `${c.id}: ${number} is named in the reply`)
    }
  }
  const another = HELD_OUT_5_CASES.find((c) => c.covers.includes('number-written-another-way'))
  assert.ok(another.expected.read.some((number) => !another.replyText.includes(number)), 'the written-another-way case reads an order not written in full')
})

test('each read order has a snapshot and an expected reading; read orders share one supplier and are open', () => {
  for (const c of HELD_OUT_5_CASES) {
    assert.ok(c.expected.read.length >= 1 && c.expected.read.length <= 5, c.id)
    assert.deepEqual(Object.keys(c.expected.byOrder).sort(), [...c.expected.read].sort(), `${c.id}: byOrder covers exactly the read orders`)
    const suppliers = new Set()
    for (const number of c.expected.read) {
      const snapshot = c.orders.find((o) => o.number === number)
      assert.ok(snapshot, `${c.id}: ${number} has a snapshot in orders`)
      assert.ok(OPEN.has(snapshot.status), `${c.id}: ${number} is open`)
      suppliers.add(snapshot.supplierName)
    }
    assert.equal(suppliers.size, 1, `${c.id}: read orders share one supplier`)
    // Every snapshot is the orders.mjs one, with at most its status changed.
    for (const snapshot of c.orders) {
      const source = ORDER_SNAPSHOTS[c.workspace][snapshot.number]
      assert.ok(source, `${c.id}: ${snapshot.number} is in orders.mjs for ${c.workspace}`)
      assert.deepEqual({ ...snapshot, status: source.status }, source, `${c.id}: ${snapshot.number} matches orders.mjs`)
    }
  }
})

test('listed orders are listed for the right reason', () => {
  for (const c of HELD_OUT_5_CASES) {
    const supplier = c.orders.find((o) => o.number === c.expected.read[0]).supplierName
    for (const { number, why } of c.expected.notRead) {
      assert.ok(NOT_READ_WHY.has(why), `${c.id}: ${number} why`)
      const snapshot = c.orders.find((o) => o.number === number)
      if (why === 'unknown') {
        assert.equal(snapshot, undefined, `${c.id}: unknown ${number} is left out of orders`)
        for (const workspace of Object.keys(ORDER_SNAPSHOTS)) {
          assert.equal(ORDER_SNAPSHOTS[workspace][number], undefined, `${c.id}: ${number} is in no workspace`)
        }
      } else if (why === 'closed') {
        assert.ok(snapshot && !OPEN.has(snapshot.status) && snapshot.supplierName === supplier, `${c.id}: ${number} is the supplier's closed order`)
      } else if (why === 'other_supplier') {
        assert.ok(snapshot && snapshot.supplierName !== supplier, `${c.id}: ${number} is another supplier's order`)
      }
    }
  }
})

test('expected lines are well formed, and each quote is in the reply', () => {
  for (const c of HELD_OUT_5_CASES) {
    for (const [number, reading] of Object.entries(c.expected.byOrder)) {
      const where = `${c.id} ${number}`
      const snapshot = c.orders.find((o) => o.number === number)
      const refs = new Map(snapshot.lines.map((line) => [line.ref, line]))
      assert.ok(STATES.has(reading.state), where)
      assert.ok(reading.alsoAccept.every((state) => STATES.has(state) && state !== reading.state), where)
      assert.ok(REPLY_KINDS.has(reading.replyKind), where)
      if (reading.state === 'proposed') assert.ok(reading.lines.some((line) => line.outcome === 'proposed'), `${where}: a proposed card proposes a line`)
      if (reading.state !== 'proposed') assert.ok(reading.lines.every((line) => line.outcome !== 'proposed'), `${where}: only a proposed card proposes`)
      for (const line of reading.lines) {
        const orderLine = refs.get(line.ref)
        assert.ok(orderLine, `${where}: ${line.ref} is a line of the order`)
        assert.ok(DATE_KINDS.has(line.dateKind), `${where} ${line.ref}`)
        if (line.outcome === 'proposed') {
          assert.ok(DAY.test(line.proposedDate), `${where} ${line.ref}`)
          assert.ok(line.proposedDate >= c.replyDate, `${where} ${line.ref}: not before the reply date`)
          assert.notEqual(line.proposedDate, orderLine.promisedDate, `${where} ${line.ref}: not the current promise`)
          assert.ok(line.quoteIncludes && c.replyText.includes(line.quoteIncludes), `${where} ${line.ref}: quote "${line.quoteIncludes}" is in the reply`)
          if (line.dateKind === 'relative') {
            assert.ok(line.readAs, `${where} ${line.ref}: a relative date has readAs`)
            assert.equal(line.readAs.from, c.replyDate, `${where} ${line.ref}: counted from the reply date`)
            assert.equal(line.readAs.date, line.proposedDate, `${where} ${line.ref}`)
            assert.ok(c.replyText.includes(line.readAs.phrase), `${where} ${line.ref}: the phrase is in the reply`)
          }
        } else {
          assert.equal(line.outcome, 'needs_you', `${where} ${line.ref}`)
          assert.equal(line.proposedDate, null, `${where} ${line.ref}`)
        }
      }
    }
  }
})

test('no date that must not be proposed is an expected proposal on the same line', () => {
  for (const c of HELD_OUT_5_CASES) {
    for (const [number, reading] of Object.entries(c.expected.byOrder)) {
      const proposed = reading.lines.filter((line) => line.outcome === 'proposed')
      for (const banned of reading.mustNotPropose) {
        assert.ok(DAY.test(banned.date) && banned.why, `${c.id} ${number}: ${banned.date} has a why`)
        const clashes = proposed.filter((line) => line.proposedDate === banned.date && (!banned.ref || line.ref === banned.ref))
        assert.deepEqual(clashes, [], `${c.id} ${number}: ${banned.date} is both banned and expected`)
      }
    }
  }
})
