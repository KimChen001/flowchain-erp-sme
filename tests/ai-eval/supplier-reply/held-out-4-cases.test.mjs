// Shape checks for the fourth held-out batch (held-out-4-cases.mjs): one
// email naming several purchase orders per case. No model and no reading
// code: each case is checked against the order snapshots, the contract's
// values and the §9 rules the batch follows (see the file's header).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HELD_OUT_4_CASES, HELD_OUT_4_KINDS, NOT_READ_REASONS } from './held-out-4-cases.mjs'
import { WRITTEN_BY } from './cases.mjs'
import { ORDER_SNAPSHOTS } from './orders.mjs'

// The contract's value lists, read from its source: the contract imports zod,
// and this test runs with no dependencies.
const CONTRACT = readFileSync(new URL('../../../shared/supplier-reply-contract.mjs', import.meta.url), 'utf8')
function contractList(name) {
  const match = CONTRACT.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`))
  assert.ok(match, `${name} is not in the contract`)
  return match[1].split(',').map((value) => value.trim().replace(/^'(.*)'$/, '$1')).filter(Boolean)
}
const STATES = contractList('SUPPLIER_REPLY_STATES')
const KINDS = contractList('SUPPLIER_REPLY_KINDS')
const DATE_KINDS = contractList('SUPPLIER_REPLY_DATE_KINDS')
const FLAG_KINDS = contractList('SUPPLIER_REPLY_FLAG_KINDS')
const LINE_ISSUES = contractList('SUPPLIER_REPLY_LINE_ISSUES')
const LINE_OUTCOMES = contractList('SUPPLIER_REPLY_LINE_OUTCOMES')
const SOURCES = contractList('SUPPLIER_REPLY_SOURCES')
// The states a checked reading can have (supplierReplyCheckSchema.state).
const CHECK_STATES = ['proposed', 'needs_you', 'nothing_to_record']
// The statuses on which an order takes a reply (SUPPLIER_REPLY_ORDER_NOT_OPEN).
const OPEN_STATUSES = ['issued', 'partially_received']
const READ_LIMIT = 5

const DAY = /^\d{4}-\d{2}-\d{2}$/
const ORDER_NUMBER = /PO-\d{6}-\d{4}/g

const snapshotsOf = (row) => new Map(row.orders.map((snapshot) => [snapshot.number, snapshot]))
const proposedDates = (entry) => entry.lines.filter((line) => line.outcome === 'proposed').map((line) => line.proposedDate)

// Each order's parts (§9): from each place its number appears to the next
// order number. Text before the first number belongs to no order.
function partsOf(text) {
  const hits = [...text.matchAll(ORDER_NUMBER)]
  const parts = new Map()
  hits.forEach((hit, index) => {
    const end = index + 1 < hits.length ? hits[index + 1].index : text.length
    parts.set(hit[0], [...(parts.get(hit[0]) || []), text.slice(hit.index, end)])
  })
  return parts
}

// The supplier's new text as #363 §4.3 cuts it: lines starting with ">"
// dropped, then everything from the first header of a quoted or forwarded
// message on.
const CUT_MARKERS = [/^On .+ wrote:$/m, /^-+ ?Original Message ?-+$/m, /^From: .+\nSent: /m, /原始邮件/, /^发件人：/m]
function newText(text) {
  const kept = text.split('\n').filter((line) => !line.startsWith('>')).join('\n')
  const cut = Math.min(...CUT_MARKERS.map((marker) => kept.search(marker)).filter((index) => index >= 0), kept.length)
  return kept.slice(0, cut)
}

test('ten cases with unique ids, at least three in Chinese, each kind once', () => {
  assert.equal(HELD_OUT_4_CASES.length, 10)
  const ids = HELD_OUT_4_CASES.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.ok(HELD_OUT_4_CASES.filter((row) => row.lang === 'zh').length >= 3, 'at least three Chinese cases')
  assert.deepEqual(HELD_OUT_4_CASES.map((row) => row.covers[1]).sort(), [...HELD_OUT_4_KINDS].sort())
})

test('every case has the batch shape', () => {
  for (const row of HELD_OUT_4_CASES) {
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.expected), `${row.id}: frozen`)
    assert.ok(['en', 'zh'].includes(row.lang), `${row.id}: lang`)
    assert.ok(Object.keys(ORDER_SNAPSHOTS).includes(row.workspace), `${row.id}: workspace`)
    assert.match(row.id, new RegExp(`^${row.lang}-${row.workspace}-\\d{4}-[a-z0-9-]+$`), `${row.id}: id`)
    assert.equal(row.writtenBy, WRITTEN_BY)
    assert.ok(typeof row.about === 'string' && row.about.length > 20, `${row.id}: about`)
    assert.equal(row.covers.length, 2, `${row.id}: covers`)
    assert.equal(row.covers[0], 'several-orders', `${row.id}: covers`)
    assert.match(row.replyDate, DAY)
    assert.match(row.today, DAY)
    assert.ok(row.today >= row.replyDate, `${row.id}: today is on or after the reply date`)
    assert.ok(SOURCES.includes(row.source), `${row.id}: source`)
    assert.ok(typeof row.replyText === 'string' && row.replyText.length > 0 && row.replyText.length <= 8000, `${row.id}: replyText`)
    assert.ok(row.orders.length >= 1, `${row.id}: orders`)
    assert.equal(snapshotsOf(row).size, row.orders.length, `${row.id}: one snapshot per order`)
  }
})

test('every read and notRead number is named in replyText, and so is every snapshot', () => {
  for (const row of HELD_OUT_4_CASES) {
    const named = new Set(row.replyText.match(ORDER_NUMBER))
    for (const number of row.expected.read) assert.ok(named.has(number), `${row.id}: ${number} (read) is named`)
    for (const { number } of row.expected.notRead) assert.ok(named.has(number), `${row.id}: ${number} (notRead) is named`)
    for (const { number } of row.orders) assert.ok(named.has(number), `${row.id}: ${number} (snapshot) is named`)
    assert.ok(named.size >= 2, `${row.id}: names several orders`)
  }
})

test('every read number has a byOrder entry and a snapshot in orders', () => {
  for (const row of HELD_OUT_4_CASES) {
    const snapshots = snapshotsOf(row)
    assert.deepEqual(Object.keys(row.expected.byOrder).sort(), [...row.expected.read].sort(), `${row.id}: one byOrder entry per read order`)
    for (const number of row.expected.read) assert.ok(snapshots.has(number), `${row.id}: ${number} has a snapshot`)
  }
})

test('pastedOn is read when the reply was pasted; an emailed reply has none', () => {
  for (const row of HELD_OUT_4_CASES) {
    if (row.source === 'paste') assert.ok(row.expected.read.includes(row.pastedOn), `${row.id}: pastedOn is read`)
    else assert.equal(row.pastedOn, null, `${row.id}: an emailed reply has no pastedOn`)
  }
})

test('snapshots are orders.mjs\'s own, with only the status changed', () => {
  for (const row of HELD_OUT_4_CASES) {
    for (const snapshot of row.orders) {
      const seed = ORDER_SNAPSHOTS[row.workspace][snapshot.number]
      assert.ok(seed, `${row.id}: ${snapshot.number} is in orders.mjs`)
      assert.deepEqual({ ...snapshot, status: seed.status }, seed, `${row.id}: ${snapshot.number} matches orders.mjs`)
    }
  }
})

test('read orders are open and share a supplier; each notRead reason holds', () => {
  for (const row of HELD_OUT_4_CASES) {
    const snapshots = snapshotsOf(row)
    const { read, notRead } = row.expected
    assert.ok(read.length >= 1 && read.length <= READ_LIMIT, `${row.id}: 1 to ${READ_LIMIT} orders read`)
    assert.equal(new Set(read).size, read.length, `${row.id}: read is unique`)
    const supplier = snapshots.get(row.pastedOn ?? read[0]).supplierName
    for (const number of read) {
      assert.ok(OPEN_STATUSES.includes(snapshots.get(number).status), `${row.id}: ${number} is open`)
      assert.equal(snapshots.get(number).supplierName, supplier, `${row.id}: ${number} has the same supplier`)
    }
    for (const { number, why } of notRead) {
      assert.ok(NOT_READ_REASONS.includes(why), `${row.id}: ${number} reason`)
      assert.ok(!read.includes(number), `${row.id}: ${number} is not both read and not read`)
      const snapshot = snapshots.get(number)
      if (why === 'closed') assert.ok(snapshot && !OPEN_STATUSES.includes(snapshot.status) && snapshot.supplierName === supplier, `${row.id}: ${number} is the supplier's closed order`)
      if (why === 'other_supplier') assert.ok(snapshot && snapshot.supplierName !== supplier, `${row.id}: ${number} is another supplier's`)
      if (why === 'unknown') assert.ok(!snapshot && !ORDER_SNAPSHOTS[row.workspace][number], `${row.id}: ${number} is unknown`)
      if (why === 'over_limit') assert.equal(read.length, READ_LIMIT, `${row.id}: ${number} is beyond the limit`)
    }
    // Every named order is read or listed.
    const named = new Set(row.replyText.match(ORDER_NUMBER))
    const placed = new Set([...read, ...notRead.map(({ number }) => number)])
    const unplaced = [...named].filter((number) => !placed.has(number))
    assert.deepEqual(unplaced, [], `${row.id}: every named order is read or listed`)
  }
})

test('byOrder entries use the contract\'s values and the order\'s own lines', () => {
  for (const row of HELD_OUT_4_CASES) {
    const snapshots = snapshotsOf(row)
    for (const [number, entry] of Object.entries(row.expected.byOrder)) {
      const where = `${row.id} ${number}`
      const lines = new Map(snapshots.get(number).lines.map((line) => [line.ref, line]))
      assert.ok(CHECK_STATES.includes(entry.state) && STATES.includes(entry.state), `${where}: state`)
      assert.ok(KINDS.includes(entry.replyKind), `${where}: replyKind`)
      for (const state of entry.alsoAccept || []) assert.ok(CHECK_STATES.includes(state) && state !== entry.state, `${where}: alsoAccept`)
      const refs = entry.lines.map((line) => line.ref)
      assert.equal(new Set(refs).size, refs.length, `${where}: one entry per line`)
      for (const line of entry.lines) {
        const seed = lines.get(line.ref)
        assert.ok(seed, `${where}: ${line.ref} is on the order`)
        assert.ok(LINE_OUTCOMES.includes(line.outcome), `${where} ${line.ref}: outcome`)
        if (line.dateKind !== undefined) assert.ok(DATE_KINDS.includes(line.dateKind), `${where} ${line.ref}: dateKind`)
        if (line.issue !== undefined) assert.ok(LINE_ISSUES.includes(line.issue), `${where} ${line.ref}: issue`)
        if (line.acceptNeedsYou !== undefined) assert.ok(LINE_ISSUES.includes(line.acceptNeedsYou), `${where} ${line.ref}: acceptNeedsYou`)
        if (line.outcome === 'proposed') {
          assert.match(line.proposedDate, DAY)
          assert.ok(line.proposedDate >= row.replyDate, `${where} ${line.ref}: on or after the reply date`)
          assert.notEqual(line.proposedDate, seed.promisedDate, `${where} ${line.ref}: a change, not the current date`)
          assert.ok(line.quoteIncludes, `${where} ${line.ref}: quoteIncludes`)
        } else if (line.outcome === 'confirmed') {
          assert.equal(line.proposedDate, seed.promisedDate, `${where} ${line.ref}: confirms the current date`)
        } else {
          assert.equal(line.proposedDate, null, `${where} ${line.ref}: nothing proposed`)
        }
        if (line.readAs) {
          assert.equal(line.readAs.from, row.replyDate, `${where} ${line.ref}: read from the reply date`)
          assert.equal(line.readAs.date, line.proposedDate, `${where} ${line.ref}: readAs date`)
          assert.ok(row.replyText.includes(line.readAs.phrase), `${where} ${line.ref}: readAs phrase`)
        }
      }
      assert.equal(entry.state === 'proposed', entry.lines.some((line) => line.outcome === 'proposed'), `${where}: proposed only with a proposed line`)
      for (const flag of entry.flags) assert.ok(FLAG_KINDS.includes(flag.kind), `${where}: flag kind`)
      for (const item of entry.mustNotPropose) {
        assert.ok(item.why, `${where}: every mustNotPropose has a why`)
        assert.ok(item.ref || item.date, `${where}: mustNotPropose names a line or a date`)
        if (item.ref) assert.ok(lines.has(item.ref), `${where}: mustNotPropose ${item.ref} is on the order`)
        if (item.date) assert.match(item.date, DAY)
      }
    }
  }
})

test('each proposed quote is the supplier\'s new text, in its own order\'s part', () => {
  for (const row of HELD_OUT_4_CASES) {
    const fresh = newText(row.replyText)
    const parts = partsOf(row.replyText)
    for (const [number, entry] of Object.entries(row.expected.byOrder)) {
      for (const line of entry.lines.filter((item) => item.outcome === 'proposed')) {
        const where = `${row.id} ${number} ${line.ref}`
        assert.ok(fresh.includes(line.quoteIncludes), `${where}: the quote is in the supplier's new text`)
        if (row.covers.includes('one-sentence-two-orders')) {
          // §9: one sentence that names both orders may be proposed on both.
          const sentence = row.replyText.split('\n').find((text) => text.includes(line.quoteIncludes))
          assert.ok(sentence.includes(number), `${where}: the sentence names the order`)
        } else {
          assert.ok((parts.get(number) || []).some((part) => part.includes(line.quoteIncludes)), `${where}: the quote is in the order's part`)
        }
      }
    }
  }
})

test('every mustNotPropose date differs from that order\'s expected proposals', () => {
  for (const row of HELD_OUT_4_CASES) {
    for (const [number, entry] of Object.entries(row.expected.byOrder)) {
      for (const item of entry.mustNotPropose.filter(({ date }) => date)) {
        // An entry with a ref covers that line only (cases.mjs's meaning).
        const against = item.ref
          ? entry.lines.filter((line) => line.ref === item.ref && line.outcome === 'proposed').map((line) => line.proposedDate)
          : proposedDates(entry)
        assert.ok(!against.includes(item.date), `${row.id} ${number}: ${item.date} is both expected and not allowed`)
      }
    }
  }
})

test('other_order flags name the orders that exist and are not read', () => {
  for (const row of HELD_OUT_4_CASES) {
    const snapshots = snapshotsOf(row)
    const listed = row.expected.notRead.filter(({ number }) => snapshots.has(number)).map(({ number }) => number).sort()
    for (const [number, entry] of Object.entries(row.expected.byOrder)) {
      const flagged = entry.flags.filter((flag) => flag.kind === 'other_order').map((flag) => flag.orderNumber).sort()
      assert.deepEqual(flagged, listed, `${row.id} ${number}: other_order flags`)
    }
  }
})
