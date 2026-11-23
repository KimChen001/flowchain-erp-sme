// The supplier reply set's structure (README.md): every case is well formed,
// its order parses as the contract's order snapshot, its expected outcome
// maps onto the contract's checked reading, and every §4.8 row and §7 extra
// of docs/supplier-reply-dates-design.md is covered. No model is called.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SUPPLIER_REPLY_DATE_KINDS, SUPPLIER_REPLY_FLAG_KINDS, SUPPLIER_REPLY_KINDS, SUPPLIER_REPLY_LIMITS, SUPPLIER_REPLY_LINE_ISSUES, SUPPLIER_REPLY_LINE_OUTCOMES,
  supplierReplyCheckSchema, supplierReplyOrderSchema as orderSchema,
} from '../../../shared/supplier-reply-contract.mjs'
import { EXTRA_TAGS, SUPPLIER_REPLY_CASES, SUPPLIER_REPLY_REQUIREMENTS, WRITTEN_BY } from './cases.mjs'
import { HELD_OUT_CASES, HELD_OUT_TAGS } from './held-out-cases.mjs'
import { HELD_OUT_2_CASES, HELD_OUT_2_TAGS } from './held-out-2-cases.mjs'
import { ASSUMED_SUPPLIER_SKUS, HELD_OUT_3_CASES, HELD_OUT_3_TAGS } from './held-out-3-cases.mjs'
import { ORDER_SNAPSHOTS, SNAPSHOT_SEED_DAY } from './orders.mjs'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (value) => typeof value === 'string' && DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
const STATES = ['proposed', 'needs_you', 'nothing_to_record']
const CJK = /[㐀-鿿]/

// The held-out batches get the same per-case checks; the counts and the
// coverage stay the 46's own.
const HELD_OUT_BATCHES = [
  { name: 'held-out', cases: HELD_OUT_CASES, tags: HELD_OUT_TAGS },
  { name: 'held-out-2', cases: HELD_OUT_2_CASES, tags: HELD_OUT_2_TAGS },
  { name: 'held-out-3', cases: HELD_OUT_3_CASES, tags: HELD_OUT_3_TAGS },
]
const EXTRA_CASES = HELD_OUT_BATCHES.flatMap((batch) => batch.cases)
const batchTagsOf = (kase) => HELD_OUT_BATCHES.find((batch) => batch.cases.includes(kase))?.tags || []

// Where the quoted earlier message or the signature starts (§4.3's markers),
// for checking that a case's quote sits in the supplier's new text. This is
// the set's own check, not the product's cleaner.
const QUOTE_MARKERS = [/^On .+ wrote:\s*$/m, /^-{2,}\s*Original Message\s*-{2,}\s*$/mi, /^From: .+$/m, /^-+\s*原始邮件\s*-+\s*$/m, /^发件人[：:]/m, /^>/m, /^-- $/m]
const newPartOf = (text) => text.slice(0, Math.min(text.length, ...QUOTE_MARKERS.map((marker) => text.search(marker)).filter((index) => index >= 0)))
const hasQuotedPart = (text) => QUOTE_MARKERS.slice(0, 6).some((marker) => marker.test(text))
// §4.3 drops the lines that start with ">" as well as everything after a
// header. In a case tagged inline-answer, the supplier's lines between ">"
// lines (with no header above them) are its new text too.
const newTextOf = (kase) => newPartOf(kase.covers.includes('inline-answer') ? kase.replyText.split('\n').filter((line) => !line.startsWith('>')).join('\n') : kase.replyText)

// The seed snapshot a case's order must equal. A held-out case may give the
// lines assumed supplier codes, labelled as ours (the seed has none): then
// every line has a code of its own, none is one of our SKUs, and nothing
// else differs from the snapshot.
function seedOrderOf(kase) {
  const snapshot = ORDER_SNAPSHOTS[kase.workspace][kase.order.number]
  if (kase.assumedSupplierSkus === undefined) return snapshot
  const { label, codes } = kase.assumedSupplierSkus
  assert.ok(kase.heldOut, 'assumed supplier codes only in a held-out batch')
  assert.equal(label, ASSUMED_SUPPLIER_SKUS, 'the codes are labelled as assumed, written by us')
  assert.deepEqual(Object.keys(codes), snapshot.lines.map((line) => line.ref), 'a code for every line')
  const values = Object.values(codes)
  assert.ok(values.every((code) => typeof code === 'string' && code.length > 0 && !snapshot.lines.some((line) => line.sku === code)), 'codes of their own, not our SKUs')
  assert.equal(new Set(values).size, values.length, 'one code per line')
  return { ...snapshot, lines: snapshot.lines.map((line) => ({ ...line, supplierSku: codes[line.ref] })) }
}

// The expected outcome as the contract's checked reading, with the fields a
// case leaves out set to null, so its enums and shapes are the contract's.
function asCheck(kase) {
  const lineOf = new Map(kase.order.lines.map((line) => [line.ref, line]))
  return {
    state: kase.expected.state,
    replyKind: kase.expected.replyKind ?? null,
    lines: kase.expected.lines.map((line) => ({
      ref: line.ref,
      purchaseOrderLineId: lineOf.get(line.ref)?.purchaseOrderLineId ?? null,
      outcome: line.outcome,
      issue: line.issue ?? null,
      currentDate: lineOf.get(line.ref)?.promisedDate ?? null,
      proposedDate: line.proposedDate ?? null,
      quote: line.quoteIncludes ?? null,
      dateKind: line.dateKind ?? null,
      readAs: line.readAs ?? null,
      readings: line.readings ?? null,
      parts: line.parts ? line.parts.map((part) => ({ ...part, quote: `${part.quantity} ${part.date}` })) : null,
    })),
    flags: kase.expected.flags.map((flag) => ({ kind: flag.kind, quote: flag.kind, orderNumber: flag.orderNumber ?? null })),
    reason: null,
    dropped: 0,
  }
}

test('the set: about 40 cases, about 25 in English and 15 in Chinese, mostly UCI with 3 to 5 on M5', () => {
  const count = (pick) => SUPPLIER_REPLY_CASES.filter(pick).length
  assert.ok(SUPPLIER_REPLY_CASES.length >= 38 && SUPPLIER_REPLY_CASES.length <= 50, `${SUPPLIER_REPLY_CASES.length} cases`)
  assert.ok(count((row) => row.lang === 'en') >= 22, 'English cases')
  assert.ok(count((row) => row.lang === 'zh') >= 13, 'Chinese cases')
  const m5 = count((row) => row.workspace === 'm5')
  assert.ok(m5 >= 3 && m5 <= 5, `${m5} M5 cases`)
  assert.equal(new Set(SUPPLIER_REPLY_CASES.map((row) => row.id)).size, SUPPLIER_REPLY_CASES.length, 'ids are unique')
})

test('every snapshot parses as the contract\'s order, with refs L1… in order and its own line ids', () => {
  assert.ok(isDay(SNAPSHOT_SEED_DAY))
  for (const [workspace, orders] of Object.entries(ORDER_SNAPSHOTS)) {
    for (const [number, snapshot] of Object.entries(orders)) {
      const parsed = orderSchema.safeParse(snapshot)
      assert.ok(parsed.success, `${workspace} ${number}: ${JSON.stringify(parsed.error?.issues)}`)
      assert.equal(snapshot.number, number)
      assert.ok(['issued', 'partially_received'].includes(snapshot.status), `${number} is ${snapshot.status}`)
      assert.deepEqual(snapshot.lines.map((line) => line.ref), snapshot.lines.map((_, index) => `L${index + 1}`), `${number} refs`)
      assert.equal(new Set(snapshot.lines.map((line) => line.purchaseOrderLineId)).size, snapshot.lines.length, `${number} line ids`)
      for (const line of snapshot.lines) {
        assert.ok(line.remaining > 0, `${number} ${line.ref} has something to receive`)
        assert.ok(isDay(line.promisedDate), `${number} ${line.ref} promised date`)
        assert.ok(line.purchaseOrderLineId.startsWith(`${snapshot.id}-L`), `${number} ${line.ref} line id`)
      }
    }
  }
  // Strict, as the contract is: an extra key is refused.
  const first = Object.values(ORDER_SNAPSHOTS.uci)[0]
  assert.ok(!orderSchema.safeParse({ ...first, prices: [] }).success)
  assert.ok(!orderSchema.safeParse({ ...first, lines: [{ ...first.lines[0], unitPrice: 1 }] }).success)
})

test('each held-out batch: 8 to 10 cases in both languages, all held out, with ids of their own', () => {
  assert.ok(SUPPLIER_REPLY_CASES.every((kase) => kase.heldOut === false))
  for (const { name, cases } of HELD_OUT_BATCHES) {
    assert.ok(cases.length >= 8 && cases.length <= 10, `${name}: ${cases.length} cases`)
    assert.ok(['en', 'zh'].every((lang) => cases.some((kase) => kase.lang === lang)), `${name}: both languages`)
    assert.ok(cases.every((kase) => kase.heldOut === true), `${name}: all held out`)
  }
  const ids = [...SUPPLIER_REPLY_CASES, ...EXTRA_CASES].map((kase) => kase.id)
  assert.equal(new Set(ids).size, ids.length)
})

for (const kase of [...SUPPLIER_REPLY_CASES, ...EXTRA_CASES]) {
  test(`case ${kase.id}`, () => {
    const { expected, order } = kase
    assert.match(kase.id, /^(en|zh)-(uci|m5)-[a-z0-9-]+$/)
    assert.ok(kase.id.startsWith(`${kase.lang}-${kase.workspace}-`), 'the id starts with its language and workspace')
    assert.equal(kase.writtenBy, WRITTEN_BY)
    assert.ok(typeof kase.about === 'string' && kase.about.length > 10, 'about')
    assert.ok(isDay(kase.replyDate) && isDay(kase.today), 'replyDate and today are days')
    assert.ok(kase.today >= kase.replyDate, 'pasted on or after it arrived')
    assert.ok(kase.today >= SNAPSHOT_SEED_DAY, 'not before the snapshot\'s seed day')
    assert.ok(typeof kase.replyText === 'string' && kase.replyText.trim().length > 0, 'reply text')
    assert.ok(kase.replyText.length <= SUPPLIER_REPLY_LIMITS.text, 'within the paste limit')
    assert.equal(CJK.test(kase.replyText), kase.lang === 'zh', 'the reply is in the case\'s language')

    // The order: a seed snapshot, as the contract takes it.
    assert.deepEqual(order, seedOrderOf(kase), 'the order is the seed snapshot')
    assert.ok(orderSchema.safeParse(order).success)
    const lineOf = new Map(order.lines.map((line) => [line.ref, line]))

    // The expected outcome maps onto the contract's checked reading.
    const check = supplierReplyCheckSchema.safeParse(asCheck(kase))
    assert.ok(check.success, JSON.stringify(check.error?.issues))
    assert.ok(STATES.includes(expected.state))
    assert.ok(SUPPLIER_REPLY_KINDS.includes(expected.replyKind))
    assert.equal(typeof expected.injection, 'boolean')
    for (const state of expected.alsoAccept || []) assert.ok(STATES.includes(state) && state !== expected.state, `alsoAccept ${state}`)

    const refs = expected.lines.map((line) => line.ref)
    assert.equal(new Set(refs).size, refs.length, 'one expected entry per line')
    for (const line of expected.lines) {
      const current = lineOf.get(line.ref)
      assert.ok(current, `${line.ref} is one of the order's open lines`)
      assert.ok(SUPPLIER_REPLY_LINE_OUTCOMES.includes(line.outcome), `${line.ref} outcome`)
      if (line.issue !== undefined) assert.ok(SUPPLIER_REPLY_LINE_ISSUES.includes(line.issue), `${line.ref} issue`)
      if (line.dateKind !== undefined) assert.ok(SUPPLIER_REPLY_DATE_KINDS.includes(line.dateKind), `${line.ref} dateKind`)
      if (line.outcome === 'proposed') {
        assert.ok(isDay(line.proposedDate), `${line.ref} proposed date`)
        assert.ok(line.proposedDate >= kase.replyDate, `${line.ref} on or after the reply date`)
        assert.ok(daysBetween(kase.replyDate, line.proposedDate) <= SUPPLIER_REPLY_LIMITS.horizonDays, `${line.ref} within the horizon`)
        assert.notEqual(line.proposedDate, current.promisedDate, `${line.ref} changes the date`)
        assert.ok(['stated', 'relative'].includes(line.dateKind), `${line.ref} only stated or relative dates are proposed`)
        assert.ok(line.quoteIncludes, `${line.ref} names its quote`)
      } else if (line.outcome === 'confirmed') {
        assert.equal(line.proposedDate, current.promisedDate, `${line.ref} confirms the current date`)
        assert.ok(current.promisedDate >= kase.replyDate, `${line.ref} the confirmed date is still ahead`)
      } else {
        assert.equal(line.proposedDate, null, `${line.ref} has no proposed date`)
      }
      if (line.quoteIncludes) {
        assert.ok(kase.replyText.includes(line.quoteIncludes), `${line.ref} quote "${line.quoteIncludes}" is in the reply`)
        assert.ok(newTextOf(kase).includes(line.quoteIncludes), `${line.ref} quote is in the supplier's new text, not a quoted part`)
      }
      // readAs: a proposed relative date, or a stated day without a month.
      if (line.dateKind === 'relative' && line.outcome === 'proposed') assert.ok(line.readAs, `${line.ref} a relative date says how it was read`)
      if (line.readAs !== undefined) {
        assert.equal(line.outcome, 'proposed', `${line.ref} readAs only on a proposed line`)
        assert.ok(line.dateKind === 'relative' || kase.covers.includes('day-only'), `${line.ref} readAs only for a relative or day-only date`)
        assert.equal(line.readAs.from, kase.replyDate, `${line.ref} counted from the reply date`)
        assert.equal(line.readAs.date, line.proposedDate, `${line.ref} read as the proposed date`)
        assert.ok(kase.replyText.includes(line.readAs.phrase), `${line.ref} the phrase is in the reply`)
      }
      if (line.acceptNeedsYou !== undefined) {
        assert.equal(line.outcome, 'proposed', `${line.ref} acceptNeedsYou only on a proposed line`)
        assert.ok(SUPPLIER_REPLY_LINE_ISSUES.includes(line.acceptNeedsYou), `${line.ref} acceptNeedsYou is an issue code`)
        assert.ok((expected.alsoAccept || []).includes('needs_you'), `${line.ref} the case accepts needs_you when the line is held`)
      }
      if (line.issue === 'ambiguous_numeric') {
        assert.equal(line.readings?.length, 2, `${line.ref} both readings`)
        assert.ok(line.readings.every(isDay) && line.readings[0] !== line.readings[1], `${line.ref} two different days`)
      } else {
        assert.equal(line.readings, undefined, `${line.ref} readings only for an ambiguous date`)
      }
      if (line.parts) {
        assert.ok(line.parts.length >= 2 && line.parts.every((part) => isDay(part.date) && part.quantity > 0), `${line.ref} parts`)
        assert.deepEqual(line.parts.map((part) => part.date), [...line.parts.map((part) => part.date)].sort(), `${line.ref} parts in date order`)
        if (line.outcome === 'proposed') {
          assert.equal(line.parts.reduce((total, part) => total + part.quantity, 0), current.remaining, `${line.ref} the parts complete the line`)
          assert.equal(line.parts.at(-1).date, line.proposedDate, `${line.ref} the last part's date is proposed`)
        }
      }
    }

    // The state follows the lines (§4.5).
    const outcomes = expected.lines.map((line) => line.outcome)
    assert.equal(outcomes.includes('proposed'), expected.state === 'proposed', 'proposed exactly when a line is proposed')
    if (expected.state === 'nothing_to_record') assert.ok(!outcomes.includes('needs_you'), 'nothing to record has no line for the person')
    if (expected.replyKind === 'auto_reply') assert.equal(expected.state, 'nothing_to_record')

    for (const flag of expected.flags) {
      assert.ok(SUPPLIER_REPLY_FLAG_KINDS.includes(flag.kind), `flag ${flag.kind}`)
      if (flag.kind === 'other_order') {
        assert.ok(flag.orderNumber && flag.orderNumber !== order.number, 'another order\'s number')
        assert.ok(kase.replyText.includes(flag.orderNumber), 'the other order is named in the reply')
      }
    }

    for (const entry of expected.mustNotPropose) {
      assert.ok(entry.date || entry.ref, 'a value never to propose has a date, a line, or both')
      if (entry.date) assert.ok(isDay(entry.date), `mustNotPropose ${entry.date}`)
      if (entry.ref) assert.ok(lineOf.has(entry.ref), `mustNotPropose ${entry.ref}`)
      assert.ok(entry.why, 'says why')
      for (const line of expected.lines.filter((row) => row.outcome === 'proposed')) {
        const clash = (!entry.ref || entry.ref === line.ref) && (!entry.date || entry.date === line.proposedDate)
        assert.ok(!clash, `${line.ref} ${line.proposedDate} is both expected and never to propose`)
      }
    }

    // Tags and what they imply.
    const tags = new Set([...SUPPLIER_REPLY_REQUIREMENTS.map((row) => row.tag), ...EXTRA_TAGS, ...(kase.heldOut ? batchTagsOf(kase) : [])])
    assert.ok(kase.covers.length > 0 && kase.covers.every((tag) => tags.has(tag)), `covers ${kase.covers}`)
    assert.equal(kase.covers.includes('injection'), expected.injection, 'injection cases are the ones tagged')
    if (kase.covers.includes('quoted-chase') || kase.covers.includes('long-thread')) assert.ok(hasQuotedPart(kase.replyText), 'has a quoted earlier message')
    if (kase.covers.includes('split')) assert.ok(expected.lines.some((line) => line.parts) || expected.state === 'needs_you', 'a split shows its parts or goes to the person')
    if (kase.covers.includes('relative')) assert.ok(expected.lines.some((line) => line.readAs))
    // A day of the month with no month is a stated date read from the reply
    // date: the first such day on or after it, with readAs.
    if (kase.covers.includes('day-only')) {
      const day = expected.lines.find((line) => line.readAs)
      assert.ok(day && day.dateKind === 'stated', 'a day-only date is proposed as stated, with readAs')
      const first = Array.from({ length: 62 }, (_, offset) => new Date(Date.parse(`${kase.replyDate}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10))
        .find((candidate) => candidate.slice(8) === day.proposedDate.slice(8))
      assert.equal(day.proposedDate, first, 'the first such day on or after the reply date')
    }
    // A refused date next to the committed one: the committed date is
    // proposed, and the refused date is listed as never to propose.
    if (kase.covers.includes('negated-date')) {
      assert.equal(expected.state, 'proposed')
      const refused = expected.mustNotPropose.filter((entry) => entry.date && !entry.ref)
      assert.ok(refused.length > 0, 'the refused date is listed')
      assert.ok(refused.every((entry) => expected.lines.every((line) => line.proposedDate !== entry.date)))
      assert.ok(expected.lines.every((line) => line.acceptNeedsYou === 'several_dates'), 'a held line (several_dates) is not a miss')
    }
    if (kase.covers.includes('ambiguous-numeric')) assert.ok(expected.lines.some((line) => line.issue === 'ambiguous_numeric'))
    if (kase.covers.includes('vague')) assert.ok(expected.lines.some((line) => line.issue === 'vague'))
    if (kase.covers.includes('confirms')) assert.ok(outcomes.includes('confirmed'))
    if (kase.covers.includes('auto-reply')) assert.equal(expected.replyKind, 'auto_reply')
    if (kase.covers.includes('supplier-sku')) assert.ok(kase.assumedSupplierSkus, 'a supplier-code case gives its lines supplier codes')
    if (kase.covers.includes('several-orders')) assert.ok(expected.flags.some((flag) => flag.kind === 'other_order'), 'several orders: the others are flagged')
    if (kase.covers.includes('inline-answer')) assert.ok(hasQuotedPart(kase.replyText), 'an inline answer sits in a quoted thread')
    for (const [tag, kind] of [['flag-quantity', 'quantity_change'], ['flag-price', 'price_change'], ['flag-cancellation', 'cancellation'], ['flag-substitution', 'substitution'], ['other-order', 'other_order'], ['wrong-order-number', 'other_order']]) {
      if (kase.covers.includes(tag)) assert.ok(expected.flags.some((flag) => flag.kind === kind), `${tag} expects a ${kind} flag`)
    }
  })
}

test('every §4.8 row and §7 extra is covered, the main rows more than once', () => {
  for (const requirement of SUPPLIER_REPLY_REQUIREMENTS) {
    const covering = SUPPLIER_REPLY_CASES.filter((row) => row.covers.includes(requirement.tag))
    assert.ok(covering.length >= requirement.min, `${requirement.tag}: ${covering.length} of at least ${requirement.min}`)
  }
  // Each flag kind at least once.
  for (const kind of SUPPLIER_REPLY_FLAG_KINDS) assert.ok(SUPPLIER_REPLY_CASES.some((row) => row.expected.flags.some((flag) => flag.kind === kind)), kind)
  // One injection case asks to mark all lines received.
  assert.ok(SUPPLIER_REPLY_CASES.some((row) => row.expected.injection && /mark all lines received/i.test(row.replyText)))
  // The Chinese date forms and quoted-thread markers.
  const chinese = SUPPLIER_REPLY_CASES.filter((row) => row.lang === 'zh').map((row) => row.replyText).join('\n')
  for (const form of ['11月28日', '下周五', '月底', '二十八号', '原始邮件', '发件人：']) assert.ok(chinese.includes(form), form)
  // Each outcome, in both languages.
  for (const lang of ['en', 'zh']) {
    for (const state of STATES) assert.ok(SUPPLIER_REPLY_CASES.some((row) => row.lang === lang && row.expected.state === state), `${lang} ${state}`)
  }
})

test('the README\'s coverage table lists exactly the cases that cover each requirement', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8')
  const rows = readme.split(/\r?\n/).filter((line) => /^\|.*\| `[a-z-]+` \|/.test(line))
  for (const requirement of SUPPLIER_REPLY_REQUIREMENTS) {
    const row = rows.find((line) => line.includes(`| \`${requirement.tag}\` |`))
    assert.ok(row, `the README has a row for ${requirement.tag}`)
    const listed = row.split('|').at(-2).split(',').map((id) => id.trim().replace(/`/g, '')).filter(Boolean).sort()
    const covering = SUPPLIER_REPLY_CASES.filter((kase) => kase.covers.includes(requirement.tag)).map((kase) => kase.id).sort()
    assert.deepEqual(listed, covering, requirement.tag)
  }
})
