import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SUPPLIER_REPLY_CONTRACT_VERSION, SUPPLIER_REPLY_DISMISS_REASONS, SUPPLIER_REPLY_FLAG_KINDS, SUPPLIER_REPLY_LIMITS,
  SUPPLIER_REPLY_EMAIL_ORDER_STATES, SUPPLIER_REPLY_ERROR_CODES, SUPPLIER_REPLY_LINE_ISSUES, SUPPLIER_REPLY_READING_STATUSES, SUPPLIER_REPLY_ROUTES, supplierReplyCardSchema,
} from '../../shared/supplier-reply-contract.mjs'
import {
  SUPPLIER_REPLY_NOTE_LIMIT, SUPPLIER_REPLY_PASTE_LIMIT, SUPPLIER_REPLY_TEXT_LIMIT, dismissReady, featuredReplies, formStart, isOutage, lineNow, markQuotes, needsManualForm,
  openQuestions, pickableReadings, proposalRecord, recordKey, recordLines, replyErrorKind,
} from '../../src/modules/purchasing/supplierReply/supplierReplyLogic.ts'
import { SUPPLIER_REPLY_COPY, SUPPLIER_REPLY_ERROR_TEXT, supplierReplyText } from '../../src/modules/purchasing/supplierReply/supplierReplyCopy.ts'

// The supplier reply card (step 1b of docs/supplier-reply-dates-design.md,
// #363 §4.5–4.9): what it decides without React, its words in both
// languages, and where it sits. The card renders the shapes of
// shared/supplier-reply-contract.mjs.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

const line = (over = {}) => ({
  ref: 'L1', purchaseOrderLineId: 'pol-1', outcome: 'proposed', issue: null, currentDate: '2026-11-12', proposedDate: '2026-11-28',
  quote: 'We can ship the balance on 28 November.', dateKind: 'stated', readAs: null, readings: null, parts: null,
  sku: 'SKU-1040', supplierSku: 'AC-77', itemName: 'Bracket', remaining: 60, unit: 'pcs', overdueDays: 5, ...over,
})
const formLine = (id, currentDate = '2026-11-12') => ({ purchaseOrderLineId: id, sku: `SKU-${id}`, supplierSku: null, itemName: null, remaining: 20, unit: 'pcs', currentDate, overdueDays: 5 })
const cardFixture = (over = {}) => ({
  contractVersion: SUPPLIER_REPLY_CONTRACT_VERSION, id: 'sr-1', purchaseOrderId: 'po-12', purchaseOrderNumber: 'PO-202611-0012', orderVersion: 4, supplierName: 'Acme Ltd',
  source: 'paste', receivedOn: '2026-11-17', createdAt: '2026-11-17T10:00:00.000Z', state: 'proposed', readingStatus: 'read', replyKind: 'dates',
  text: 'Hello,\nWe can ship the balance on\n28 November. Unit price rises 4% from December.', quotedTextHidden: true, quotedText: '> When will PO-202611-0012 ship?',
  lines: [line(), line({ ref: 'L2', purchaseOrderLineId: 'pol-2', sku: 'SKU-2210', itemName: 'Hinge', remaining: 20 })],
  flags: [{ kind: 'price_change', quote: 'Unit price rises 4% from December.', orderNumber: null }], reason: null, instructionsIgnored: false,
  formLines: [formLine('pol-1'), formLine('pol-2'), formLine('pol-3', '2026-12-01')],
  canDecide: true, notNowUntil: null, decision: null, supersededById: null, ...over,
})

test('the fixtures are cards the contract accepts', () => {
  for (const card of [cardFixture(), cardFixture({ state: 'needs_you', readingStatus: 'ai_off', lines: [] }), cardFixture({ state: 'needs_you', lines: [line({ outcome: 'needs_you', issue: 'ambiguous_numeric', proposedDate: null, quote: 'ships 03/12', readings: ['2026-12-03', '2026-03-12'] })] })]) {
    const parsed = supplierReplyCardSchema.safeParse(card)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  }
  assert.equal(SUPPLIER_REPLY_TEXT_LIMIT, SUPPLIER_REPLY_LIMITS.text)
  // What may be pasted: twice the cleaned reply, as supplierReplyPasteRequestSchema takes it.
  assert.equal(SUPPLIER_REPLY_PASTE_LIMIT, SUPPLIER_REPLY_LIMITS.text * 2)
  assert.equal(SUPPLIER_REPLY_NOTE_LIMIT, SUPPLIER_REPLY_LIMITS.note)
})

test('a card from an email about several orders lists them; one from a single-order email has no list', () => {
  const several = cardFixture({ emailOrders: [{ number: 'PO-202611-0012', status: 'this' }, { number: 'PO-202611-0013', status: 'read' }, { number: 'PO-202611-0019', status: 'closed' }] })
  assert.ok(supplierReplyCardSchema.safeParse(several).success)
  assert.equal(supplierReplyCardSchema.safeParse(cardFixture({ emailOrders: [{ number: 'PO-202611-0013', status: 'open' }] })).success, false)
  assert.equal('emailOrders' in supplierReplyCardSchema.parse(cardFixture()), false)
  // The card says which part it read and lists the others (SupplierReplyCard.tsx).
  const source = readFileSync(new URL('../../src/modules/purchasing/supplierReply/SupplierReplyCard.tsx', import.meta.url), 'utf8')
  assert.match(source, /data-testid="supplier-reply-email-orders"/)
  assert.match(source, /emailOrder_\$\{item\.status\}/)
})

test('the supplier\'s sentences are marked on the reply, across line breaks', () => {
  const card = cardFixture()
  const segments = markQuotes(card.text, [card.lines[0].quote, card.lines[1].quote, card.flags[0].quote, null])
  assert.deepEqual(segments.filter((segment) => segment.marked).map((segment) => segment.text), ['We can ship the balance on\n28 November.', 'Unit price rises 4% from December.'])
  assert.equal(segments.map((segment) => segment.text).join(''), card.text)
  // Nothing to mark: the reply as one plain segment; overlaps merge.
  assert.deepEqual(markQuotes('No date yet.', []), [{ text: 'No date yet.', marked: false }])
  assert.deepEqual(markQuotes('ship 28 Nov please', ['ship 28', '28 Nov']).filter((segment) => segment.marked).map((segment) => segment.text), ['ship 28 Nov'])
  // As the server finds a quote: regardless of case, curly quotes or dashes.
  assert.deepEqual(markQuotes('Small change: we now expect to ship on 03/12 — sorry.', ['We now expect to ship on 03/12 - sorry.']).filter((segment) => segment.marked).map((segment) => segment.text), ['we now expect to ship on 03/12 — sorry.'])
  assert.deepEqual(markQuotes('It’s ready “Friday”.', ["It's ready \"Friday\"."]).filter((segment) => segment.marked).length, 1)
})

test('the manual form and Edit start from the proposal and send only real changes', () => {
  const card = cardFixture()
  assert.deepEqual(formStart(card), { 'pol-1': '2026-11-28', 'pol-2': '2026-11-28', 'pol-3': '' })
  // An unchanged, empty or malformed date is not sent; an unknown line neither.
  assert.deepEqual(recordLines(card, { 'pol-1': '2026-11-30', 'pol-2': '2026-11-12', 'pol-3': '', 'pol-9': '2026-12-01' }), [{ purchaseOrderLineId: 'pol-1', promisedDate: '2026-11-30' }])
  assert.deepEqual(recordLines(card, { 'pol-1': '30/11/2026' }), [])
  // One key per card, version and set of dates: a double click records once.
  const lines = [{ purchaseOrderLineId: 'pol-2', promisedDate: '2026-12-01' }, { purchaseOrderLineId: 'pol-1', promisedDate: '2026-11-30' }]
  assert.equal(recordKey(card, lines), recordKey(card, [...lines].reverse()))
  assert.notEqual(recordKey(card, lines), recordKey(card))
  assert.notEqual(recordKey(card), recordKey({ ...card, orderVersion: 5 }))
  assert.ok(recordKey(card, Array.from({ length: 200 }, (_, index) => ({ purchaseOrderLineId: `pol-${index}`, promisedDate: '2026-12-01' }))).length <= 200)
})

test('a proposal with lines that need the person waits for each, then sends them with the proposal (review finding 1)', () => {
  // "Brackets ship 28 November; hinges 03/12": the bracket line is proposed, the hinge line needs its reading.
  const hinge = line({ ref: 'L2', purchaseOrderLineId: 'pol-2', sku: 'SKU-2210', outcome: 'needs_you', issue: 'ambiguous_numeric', proposedDate: null, quote: 'hinges 03/12', readings: ['2026-12-03', '2027-03-12'] })
  const card = cardFixture({ lines: [line(), hinge] })
  assert.ok(supplierReplyCardSchema.safeParse(card).success)
  assert.deepEqual(openQuestions(card).map((entry) => entry.purchaseOrderLineId), ['pol-2'])
  assert.deepEqual(proposalRecord(card, formStart(card), new Set()), { ready: false, lines: undefined })
  // Picked: the proposal and the picked date go together.
  assert.deepEqual(proposalRecord(card, { ...formStart(card), 'pol-2': '2026-12-03' }, new Set()), { ready: true, lines: [{ purchaseOrderLineId: 'pol-1', promisedDate: '2026-11-28' }, { purchaseOrderLineId: 'pol-2', promisedDate: '2026-12-03' }] })
  // Left unchanged: the proposal alone, as the server proposes it.
  assert.deepEqual(proposalRecord(card, formStart(card), new Set(['pol-2'])), { ready: true, lines: undefined })
  // A card with no open question records as proposed; a needs-you card has none (its form is the manual one).
  assert.deepEqual(proposalRecord(cardFixture(), formStart(cardFixture()), new Set()), { ready: true, lines: undefined })
  assert.deepEqual(openQuestions(cardFixture({ state: 'needs_you', lines: [hinge] })), [])
})

test('one click picks only a 03/12 reading or one of two dates in a sentence; a date mismatch is typed (finding 5)', () => {
  const readings = ['2026-12-03', '2027-03-12']
  assert.deepEqual(pickableReadings({ issue: 'ambiguous_numeric', readings }), readings)
  assert.deepEqual(pickableReadings({ issue: 'several_dates', readings }), readings)
  // "next Friday" early in a week: both Fridays, one click each.
  assert.deepEqual(pickableReadings({ issue: 'ambiguous_weekday', readings }), readings)
  assert.equal(pickableReadings({ issue: 'date_mismatch', readings }), null)
  assert.equal(pickableReadings({ issue: 'ambiguous_numeric', readings: null }), null)
  // A vague line may offer the one or two days its words could mean (二十八号, "on Friday").
  assert.deepEqual(pickableReadings({ issue: 'vague', readings: ['2026-11-28'] }), ['2026-11-28'])
  assert.deepEqual(pickableReadings({ issue: 'vague', readings }), readings)
  // An email about several orders: a day from text of no single order is offered.
  assert.deepEqual(pickableReadings({ issue: 'no_order_part', readings: ['2026-12-02'] }), ['2026-12-02'])
  assert.equal(pickableReadings({ issue: 'other_order_text', readings: ['2026-12-02'] }), null)
  assert.equal(pickableReadings({ issue: 'vague', readings: null }), null)
})

test('Now is the order date as the card was rendered, and a date moved since the reading is marked (finding 2)', () => {
  const card = cardFixture({ formLines: [{ ...formLine('pol-1', '2026-12-05'), overdueDays: null }, formLine('pol-2')] })
  assert.deepEqual(lineNow(card, card.lines[0]), { now: '2026-12-05', overdueDays: null, movedFrom: '2026-11-12' })
  assert.deepEqual(lineNow(card, card.lines[1]), { now: '2026-11-12', overdueDays: 5, movedFrom: undefined })
})

test('needs you and every outage show the manual form; a proposal does not', () => {
  assert.equal(needsManualForm(cardFixture()), false)
  assert.equal(needsManualForm(cardFixture({ state: 'needs_you' })), true)
  for (const status of SUPPLIER_REPLY_READING_STATUSES.filter((value) => value !== 'read')) {
    assert.equal(isOutage(cardFixture({ readingStatus: status })), true)
    assert.equal(needsManualForm(cardFixture({ state: 'needs_you', readingStatus: status })), true)
  }
  // A decided or replaced reply offers no form.
  for (const state of ['recorded', 'not_recorded', 'superseded', 'nothing_to_record']) assert.equal(needsManualForm(cardFixture({ state })), false)
})

test('a newer paste kept beside an open reply shows with it; the rest are earlier replies', () => {
  const open = cardFixture({ id: 'sr-open' })
  const inactive = cardFixture({ id: 'sr-new', state: 'nothing_to_record', canDecide: false, lines: [] })
  const old = cardFixture({ id: 'sr-old', state: 'recorded' })
  assert.deepEqual(featuredReplies([inactive, open, old]).featured.map((card) => card.id), ['sr-new', 'sr-open'])
  assert.deepEqual(featuredReplies([inactive, open, old]).earlier.map((card) => card.id), ['sr-old'])
  assert.deepEqual(featuredReplies([open, old]).featured.map((card) => card.id), ['sr-open'])
  // Today: the one just pasted or decided first.
  assert.deepEqual(featuredReplies([inactive, open, old], old).featured.map((card) => card.id), ['sr-old', 'sr-open'])
  assert.deepEqual(featuredReplies([]).featured, [])
})

test('a dismissal needs a note only for Other, and at most 200 characters', () => {
  assert.equal(dismissReady('wrong_reading', ''), true)
  assert.equal(dismissReady('other', '  '), false)
  assert.equal(dismissReady('other', 'Asked by phone.'), true)
  assert.equal(dismissReady('supplier_will_confirm', 'x'.repeat(201)), false)
})

test('a stale card and a closed reply are told apart from other refusals, in either error shape', () => {
  assert.equal(replyErrorKind({ code: 'SYNC_VERSION_CONFLICT', status: 409 }), 'stale')
  assert.equal(replyErrorKind({ status: 409, payload: { error: { code: 'SYNC_VERSION_CONFLICT' } } }), 'stale')
  assert.equal(replyErrorKind({ code: 'SUPPLIER_REPLY_NOT_OPEN', status: 409 }), 'closed')
  // A line's date moved since the reading: refused, the card stays open and says so.
  assert.equal(replyErrorKind({ code: 'SUPPLIER_REPLY_STALE', status: 409 }), 'moved')
  assert.equal(replyErrorKind({ code: 'PURCHASE_ORDER_PROMISE_CLOSED', status: 409 }), 'other')
  assert.equal(replyErrorKind(new Error('offline')), 'other')
  // Every other code the routes answer with has its own sentence, or the
  // purchasing words the procurement pages already use.
  const purchasing = read('src/modules/procurement/procurementErrors.ts')
  for (const code of SUPPLIER_REPLY_ERROR_CODES) {
    const handled = ['stale', 'moved', 'closed'].includes(replyErrorKind({ code })) || code in SUPPLIER_REPLY_ERROR_TEXT || purchasing.includes(`${code}:`) || code === 'TRANSACTION_CONFLICT'
    assert.ok(handled, code)
  }
  for (const [code, [english, chinese]] of Object.entries(SUPPLIER_REPLY_ERROR_TEXT)) assert.ok(english && /[㐀-鿿]/.test(chinese), code)
})

test('every code the card shows has English and Chinese words', () => {
  for (const [key, [english, chinese]] of Object.entries(SUPPLIER_REPLY_COPY)) {
    assert.ok(english && chinese, key)
    // A pair that is only placeholders ("{date} {qty}") has no words to translate.
    const words = chinese.replace(/\{\w+\}/g, '').trim()
    if (words) assert.match(chinese, /[㐀-鿿]/, `${key} has Chinese`)
  }
  for (const issue of SUPPLIER_REPLY_LINE_ISSUES) assert.ok(`issue_${issue}` in SUPPLIER_REPLY_COPY, issue)
  for (const kind of SUPPLIER_REPLY_FLAG_KINDS) assert.ok(`flag_${kind}` in SUPPLIER_REPLY_COPY, kind)
  for (const reason of SUPPLIER_REPLY_DISMISS_REASONS) assert.ok(`dismiss_${reason}` in SUPPLIER_REPLY_COPY, reason)
  for (const status of SUPPLIER_REPLY_READING_STATUSES.filter((value) => value !== 'read')) assert.ok(`outage_${status}` in SUPPLIER_REPLY_COPY, status)
  for (const status of SUPPLIER_REPLY_EMAIL_ORDER_STATES.filter((value) => value !== 'this')) assert.ok(`emailOrder_${status}` in SUPPLIER_REPLY_COPY, status)
  assert.equal(supplierReplyText('en-US', 'emailOrders', { n: 3, number: 'PO-202611-0012', limit: 5 }), 'This email names 3 orders. FlowChain reads up to 5 of them, each on its own order with one reading. This card reads only the part about PO-202611-0012.')
  assert.equal(supplierReplyText('zh-CN', 'emailOrder_over_limit', { number: 'PO-202611-0019', limit: 5 }), 'PO-202611-0019：一封邮件超过 5 张订单，未读取')
  assert.equal(supplierReplyText('en-US', 'readAs', { phrase: 'next Friday', date: 'Nov 27, 2026', from: 'Nov 17, 2026' }), '"next Friday" read as Nov 27, 2026, from the reply date Nov 17, 2026')
  assert.equal(supplierReplyText('zh-CN', 'left', { qty: '60 件' }), '剩余 60 件')
  // A day read from the reply, not stated as the delivery day (line.inferred).
  assert.equal(supplierReplyText('en-US', 'readInferred', { date: 'Nov 28, 2026' }), 'Read as Nov 28, 2026 — the reply gave no exact delivery day')
  assert.equal(supplierReplyText('zh-CN', 'readInferred', { date: 'Nov 28, 2026' }), '按 Nov 28, 2026 读取——回信没有给出确切交货日')
  const inferred = cardFixture({ lines: [line({ inferred: true, dateKind: 'stated', readAs: { phrase: 'the 28th', from: '2026-11-17', date: '2026-11-28' } })] })
  assert.ok(supplierReplyCardSchema.safeParse(inferred).success)
})

test('the paste box sits on a chased overdue item and on the order page; buttons need the revise permission', () => {
  const today = read('src/modules/overview/DecisionCards.tsx')
  // Chased: set aside, or back on Today after the follow-up (chasedOn), and
  // only an order the supplier has.
  assert.match(today, /entry\.row\.kind === "purchase_order_overdue" && \(entry\.decision === "chased" \|\| Boolean\(entry\.chasedOn\)\) && !entry\.row\.detail\?\.notIssued;/)
  assert.match(today, /\{takesSupplierReply\(entry\) \? <SupplierReplies orderId=\{entry\.row\.recordId\} entry="today" onRecorded=\{onChanged\} \/> : null\}/)
  assert.match(today, /\{takesSupplierReply\(entry\) \? <div className="mt-1\.5"><SupplierReplies orderId=\{row\.recordId\} entry="today" onRecorded=\{onChanged\} \/><\/div> : null\}/)
  const page = read('src/modules/purchasing/Page.tsx')
  assert.match(page, /<SupplierReplies orderId=\{selectedPO\.po\} orderStatus=\{String\(selectedPO\.status \|\| ""\)\} entry="order" onRecorded=\{loadWorkbench\} \/>/)
  // The promised dates are read again after a recording changes the order.
  assert.match(page, /<PurchaseOrderPromiseDates key=\{`\$\{selectedPO\.po\}:\$\{selectedPO\.version \?\? ""\}`\}/)
  const replies = read('src/modules/purchasing/supplierReply/SupplierReplies.tsx')
  assert.match(replies, /const PASTE_STATUSES = new Set\(\["issued", "partially_received"\]\);/)
  assert.match(replies, /const mayChange = Boolean\(permissions\?\.has\(REVISE\)\);\n\s+const canPaste = mayChange && /)
  const card = read('src/modules/purchasing/supplierReply/SupplierReplyCard.tsx')
  // Record, Edit, Not now and Don't record only with canDecide; the stale
  // order version goes back as expectedVersion.
  assert.match(card, /\{open && card\.canDecide \? \(\n\s+<div className="mt-3 flex flex-wrap items-center gap-2" data-testid="supplier-reply-actions">/)
  assert.match(card, /expectedVersion: card\.orderVersion/)
  assert.match(card, /line\.inferred \? t\("readInferred", \{ date: day\(line\.readAs\.date\) \}\) : t\("readAs"/)
  // The urls are written out (for the write-route caller test) and are the contract's routes.
  const order = '/api/procurement/orders/${encodeURIComponent(card.purchaseOrderId)}'
  assert.ok(card.includes(`const reply = \`${order}/supplier-replies/\${encodeURIComponent(card.id)}\`;`))
  assert.equal(SUPPLIER_REPLY_ROUTES.paste, SUPPLIER_REPLY_ROUTES.list)
  assert.ok(replies.includes('const replies_ = `/api/procurement/orders/${encodeURIComponent(orderId)}/supplier-replies`;'))
  assert.equal(SUPPLIER_REPLY_ROUTES.list, '/api/procurement/orders/:id/supplier-replies')
  for (const [route, action] of [[SUPPLIER_REPLY_ROUTES.record, 'record'], [SUPPLIER_REPLY_ROUTES.dismiss, 'dismiss'], [SUPPLIER_REPLY_ROUTES.notNow, 'not-now']]) {
    assert.equal(route, `/api/procurement/orders/:id/supplier-replies/:replyId/${action}`)
    assert.ok(card.includes(`send(\`\${reply}/${action}\``), action)
  }
})
