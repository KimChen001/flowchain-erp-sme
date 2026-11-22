// The mail bridge without a mailbox, a network or FlowChain: its settings,
// which messages it sends and what it sends, how it reads the endpoint's
// answers (against a stub endpoint on this machine), and a round over a
// folder and over a stub IMAP client. The example .eml files are parsed for
// real when mailparser is installed in this folder (npm ci); otherwise that
// test is skipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeArgs } from '../bridge.mjs'
import { bridgeConfig, checkoutRoots, parseBridgeEnv, readBridgeConfig, requireImap } from '../lib/config.mjs'
import { TEXT_LIMIT, forwardable, messageIdOf, openState, outcomeOf, payloadOf, postReply, receivedDay } from '../lib/forward.mjs'
import { BridgeStop, envelopeKey, runFolder, runImap } from '../lib/run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(here, '..', '..', '..')
const TOKEN = 'fcsr.dGVuYW50.0f0e8b9a-1111-4222-8333-944455556666.secret'
const base = { FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'http://localhost:18831/api/integrations/supplier-replies', FLOWCHAIN_MAIL_BRIDGE_TOKEN: TOKEN, FLOWCHAIN_MAIL_BRIDGE_TIME_ZONE: 'America/New_York' }
const mailOf = (fields = {}) => ({ subject: 'Re: PO-202610-0028 delivery date', from: { value: [{ address: 'Priya@Acme-Home.example' }] }, messageId: '<m1@acme-home.example>', date: '2026-11-22T14:12:00Z', text: 'PO-202610-0028 ships on 4 December.', ...fields })
const envOutside = () => {
  const outside = mkdtempSync(join(tmpdir(), 'mail-bridge-'))
  writeFileSync(join(outside, 'bridge.env'), Object.entries(base).map(([key, value]) => `${key}=${value}`).join('\n'))
  return outside
}

// An endpoint on this machine that answers from a list and keeps what it got.
async function stubEndpoint(answers) {
  const received = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      received.push({ path: req.url, authorization: req.headers.authorization, type: req.headers['content-type'], raw })
      const next = answers.shift() || { status: 500, body: {} }
      res.writeHead(next.status, { 'content-type': next.raw === undefined ? 'application/json' : 'text/html', ...(next.headers || {}) })
      res.end(next.raw ?? JSON.stringify(next.body || {}))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const config = bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: `http://127.0.0.1:${server.address().port}/api/integrations/supplier-replies` })
  return { config, received, close: () => new Promise((done) => server.close(done)) }
}

test('settings: the token goes only over https or to this machine, never in a URL, and the file lives outside every worktree', () => {
  const config = bridgeConfig(base)
  assert.deepEqual([config.endpoint, config.orderPrefix, config.timeZone, config.maxBytes, config.imap.port, config.imap.mailbox], ['http://localhost:18831/api/integrations/supplier-replies', 'PO', 'America/New_York', 5_000_000, 993, 'INBOX'])
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'http://flowchain.example/api/integrations/supplier-replies' }), /https/)
  for (const sneaky of ['http://localhost.evil.example/x', 'http://127.0.0.1.nip.io/x']) assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: sneaky }), /https/, sneaky)
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'https://user:pw@flowchain.example/x' }), /user name or password/)
  assert.equal(bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'https://flowchain.example/api/integrations/supplier-replies' }).endpoint.startsWith('https://'), true)
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_TOKEN: 'abc' }), /fcsr/)
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_TIME_ZONE: 'Mars/Base' }), /time zone/)
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_MAX_BYTES: '12' }), /MAX_BYTES/)
  // Only the bridge's own names are read.
  assert.deepEqual(parseBridgeEnv('FLOWCHAIN_MAIL_BRIDGE_TOKEN="x"\nFLOWCHAIN_AI_PROVIDER_API_KEY=secret\n# FLOWCHAIN_MAIL_BRIDGE_FROM=a'), { FLOWCHAIN_MAIL_BRIDGE_TOKEN: 'x' })
  // The mailbox settings are needed only to read a mailbox.
  assert.throws(() => requireImap(config), /IMAP_HOST, FLOWCHAIN_MAIL_BRIDGE_IMAP_USER, FLOWCHAIN_MAIL_BRIDGE_IMAP_PASSWORD/)
  assert.throws(() => bridgeArgs([]), /--config/)
  assert.throws(() => bridgeArgs(['--config=x', '--interval=5']), /15 seconds/)
})

test('the settings file is refused inside the checkout, a sibling worktree, or through a junction into one', () => {
  assert.equal(checkoutRoots(checkout).length >= 1, true)
  assert.throws(() => readBridgeConfig(join(checkout, 'bridge.env'), { checkout }), /outside the FlowChain checkout/)
  const outside = envOutside()
  assert.equal(readBridgeConfig(join(outside, 'bridge.env'), { checkout }).stateFile, join(outside, 'flowchain-mail-bridge-state.json'))
  // A sibling worktree counts as the checkout.
  assert.throws(() => readBridgeConfig(join(outside, 'bridge.env'), { checkout, roots: [checkout, outside] }), /outside the FlowChain checkout/)
  // A junction (or link) that leads into the checkout is followed.
  const inner = join(checkout, 'tools', 'supplier-reply-mail-bridge', 'test', `.junction-target-${process.pid}`)
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, 'bridge.env'), readFileSync(join(outside, 'bridge.env')))
  const link = join(mkdtempSync(join(tmpdir(), 'mail-bridge-link-')), 'through')
  try {
    symlinkSync(inner, link, 'junction')
    assert.throws(() => readBridgeConfig(join(link, 'bridge.env'), { checkout }), /outside the FlowChain checkout/)
  } finally {
    rmSync(link, { force: true, recursive: true })
    rmSync(inner, { recursive: true, force: true })
  }
})

test('only a message naming an order number is sent, from a listed sender when senders are listed', () => {
  assert.equal(forwardable(mailOf()).forward, true)
  assert.equal(forwardable(mailOf({ subject: 'Hello', text: 'Order PO-202611-0012 is ready' })).forward, true)
  assert.equal(forwardable(mailOf({ subject: '回复', text: '订单ＰＯ－２０２６１１－００１２已备好' })).forward, true)
  assert.equal(forwardable(mailOf({ subject: 'Hello', text: 'Order PO–202611–0012 is ready' })).forward, true)
  assert.equal(forwardable(mailOf({ subject: 'Hello', text: 'Our newsletter' })).why, 'no_order_number')
  assert.equal(forwardable(mailOf({ subject: 'Re: INV-202611-0003', text: 'Invoice attached' })).forward, false)
  assert.equal(forwardable(mailOf(), { from: ['acme-home.example'] }).forward, true)
  assert.equal(forwardable(mailOf(), { from: ['priya@acme-home.example'] }).forward, true)
  assert.equal(forwardable(mailOf(), { from: ['globex.example'] }).why, 'sender_not_listed')
})

test('the body sent: the text, the subject, the sender, a Message-ID always, and the day it came in the workspace\'s time zone', () => {
  // 22 Nov 02:30 UTC is still 21 Nov in New York.
  assert.equal(receivedDay('2026-11-22T02:30:00Z', 'America/New_York'), '2026-11-21')
  assert.equal(receivedDay('2026-11-22T02:30:00Z', 'Asia/Shanghai'), '2026-11-22')
  const { body, truncated } = payloadOf(mailOf(), { timeZone: 'America/New_York' })
  assert.deepEqual(body, { text: 'PO-202610-0028 ships on 4 December.', messageId: '<m1@acme-home.example>', subject: 'Re: PO-202610-0028 delivery date', from: 'priya@acme-home.example', receivedOn: '2026-11-22' })
  assert.equal(truncated, false)
  const long = payloadOf(mailOf({ text: 'x'.repeat(TEXT_LIMIT + 10) }), { timeZone: 'UTC' })
  assert.deepEqual([long.body.text.length, long.truncated], [TEXT_LIMIT, true])
  // No Message-ID, or one FlowChain does not take: an id made from the
  // message, the same on a retry, so FlowChain still keeps it once.
  for (const messageId of ['', '<ünicode@example>']) {
    const made = messageIdOf(mailOf({ messageId }))
    assert.match(made, /^<[0-9a-f]{64}@flowchain-mail-bridge\.local>$/)
    assert.equal(messageIdOf(mailOf({ messageId })), made)
    assert.equal(payloadOf(mailOf({ messageId }), { timeZone: 'UTC' }).body.messageId, made)
    assert.notEqual(messageIdOf(mailOf({ messageId, text: 'PO-202610-0028 ships on 5 December.' })), made)
  }
})

test('the endpoint\'s answer decides what happens to the message; only FlowChain\'s own success counts as sent', () => {
  assert.equal(outcomeOf(201, { replyId: 'r1' }), 'sent')
  assert.equal(outcomeOf(201, null), 'stop')
  assert.equal(outcomeOf(200, { duplicate: true, pending: false }), 'sent')
  assert.equal(outcomeOf(200, { duplicate: true, pending: true }), 'later')
  assert.equal(outcomeOf(200, null), 'stop')
  assert.equal(outcomeOf(200, { ok: true }), 'stop')
  for (const status of [301, 302, 307, 308]) assert.equal(outcomeOf(status), 'stop', String(status))
  for (const status of [400, 413, 422]) assert.equal(outcomeOf(status), 'refused', String(status))
  for (const status of [401, 403, 404]) assert.equal(outcomeOf(status), 'stop', String(status))
  for (const status of [409, 429, 500, 503, null]) assert.equal(outcomeOf(status), 'later', String(status))
})

test('the POST carries the token and the body, never follows a redirect, and reads each kind of answer', async () => {
  const endpoint = await stubEndpoint([
    { status: 201, body: { duplicate: false, replyId: 'r1', purchaseOrderNumber: 'PO-202610-0028' } },
    { status: 422, body: { code: 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' } },
    { status: 429, body: { code: 'SUPPLIER_REPLY_INGEST_RATE_LIMITED' }, headers: { 'retry-after': '120' } },
    { status: 401, body: { code: 'INTEGRATION_TOKEN_INVALID' } },
    { status: 307, body: {}, headers: { location: '/elsewhere' } },
    { status: 200, raw: '<!doctype html><title>FlowChain</title>' },
  ])
  try {
    const { body } = payloadOf(mailOf(), endpoint.config)
    assert.deepEqual(await postReply(endpoint.config, body), { outcome: 'sent', status: 201, code: null, replyId: 'r1', orderNumber: 'PO-202610-0028', retryAfter: null })
    assert.deepEqual([endpoint.received[0].authorization, endpoint.received[0].type, JSON.parse(endpoint.received[0].raw).messageId], [`Bearer ${TOKEN}`, 'application/json', '<m1@acme-home.example>'])
    assert.deepEqual(await postReply(endpoint.config, body).then((row) => [row.outcome, row.code]), ['refused', 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS'])
    assert.deepEqual(await postReply(endpoint.config, body).then((row) => [row.outcome, row.retryAfter]), ['later', 120])
    assert.equal((await postReply(endpoint.config, body)).outcome, 'stop')
    // A redirect is not followed: one request, and the bridge stops.
    const before = endpoint.received.length
    assert.deepEqual(await postReply(endpoint.config, body).then((row) => [row.outcome, row.code]), ['stop', 'REDIRECT'])
    assert.equal(endpoint.received.length, before + 1)
    assert.equal(endpoint.received.some((row) => row.path === '/elsewhere'), false)
    // A web page (the UI's port, say) is not FlowChain's answer.
    assert.deepEqual(await postReply(endpoint.config, body).then((row) => [row.outcome, row.code]), ['stop', 'NOT_FLOWCHAIN'])
  } finally {
    await endpoint.close()
  }
  // No answer at all: try again next round.
  assert.deepEqual(await postReply(bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'http://127.0.0.1:9/x' }), {}, { timeoutMs: 2000 }).then((row) => [row.outcome, row.code]), ['later', 'NO_ANSWER'])
})

test('a folder round: sent and refused files move out, others and large ones are skipped, and a refused token stops the bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-bridge-eml-'))
  const write = (name, mail) => writeFileSync(join(dir, name), JSON.stringify(mail))
  write('1-reply.eml', mailOf())
  write('2-two-orders.eml', mailOf({ messageId: '<m2@x>', text: 'PO-202610-0028 and PO-202610-0030 ship on 4 December.' }))
  write('3-news.eml', mailOf({ messageId: '<m3@x>', subject: 'News', text: 'No order here' }))
  write('4-large.eml', mailOf({ messageId: '<m5@x>', text: `PO-202610-0028 ${'x'.repeat(3000)}` }))
  const parse = async (source) => JSON.parse(source.toString())
  const endpoint = await stubEndpoint([{ status: 201, body: { replyId: 'r1', purchaseOrderNumber: 'PO-202610-0028' } }, { status: 422, body: { code: 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' } }])
  const stateFile = join(dir, 'state.json')
  const lines = []
  try {
    const counts = await runFolder({ dir, config: { ...endpoint.config, maxBytes: 2000 }, parse, state: openState(stateFile), log: (line) => lines.push(line) })
    assert.deepEqual(counts, { sent: 1, refused: 1, skipped: 2, later: 0 })
    assert.deepEqual([readdirSync(join(dir, 'sent')), readdirSync(join(dir, 'refused')), readdirSync(join(dir, 'skipped')).sort()], [['1-reply.eml'], ['2-two-orders.eml'], ['3-news.eml', '4-large.eml']])
    assert.equal(endpoint.received.length, 2)
    assert.deepEqual(Object.values(JSON.parse(readFileSync(stateFile, 'utf8')).handled).map((row) => row.outcome).sort(), ['refused', 'sent'])
    // The log names files and answers, never the text or the token.
    assert.equal(lines.some((line) => line.includes('ships on') || line.includes(TOKEN)), false)
  } finally {
    await endpoint.close()
  }
  write('5-reply.eml', mailOf({ messageId: '<m4@x>' }))
  const refusing = await stubEndpoint([{ status: 401, body: { code: 'INTEGRATION_TOKEN_INVALID' } }])
  try {
    await assert.rejects(runFolder({ dir, config: refusing.config, parse, state: openState(null) }), (error) => error instanceof BridgeStop && /token/.test(error.message))
    assert.equal(existsSync(join(dir, '5-reply.eml')), true)
  } finally {
    await refusing.close()
  }
})

// An IMAP server in memory: unread messages by uid, with envelopes and sources.
function stubImap(mails, { capabilities = ['IMAP4rev1', 'MOVE'], sizes = {} } = {}) {
  const seen = new Set()
  const moved = []
  const fetched = { envelopes: 0, sources: [] }
  let listeners = 0
  class StubImap {
    constructor(options) { this.options = options; this.capabilities = new Map(capabilities.map((name) => [name, true])) }
    on(event) { if (event === 'error') listeners += 1; return this }
    async connect() {}
    async logout() {}
    async mailboxCreate() {}
    async getMailboxLock() { return { release() {} } }
    async search(query, options) { assert.deepEqual([query, options], [{ seen: false }, { uid: true }]); return [...mails.keys()].filter((uid) => !seen.has(uid)) }
    async fetchAll(range, query, options) {
      assert.deepEqual(options, { uid: true })
      const uids = range.split(',').map(Number)
      if (query.envelope) {
        fetched.envelopes += 1
        return uids.map((uid) => { const mail = mails.get(uid); return { uid, size: sizes[uid] || 1000, envelope: { messageId: mail.messageId, subject: mail.subject, date: new Date(mail.date), from: [{ address: mail.from.value[0].address }] } } })
      }
      assert.equal(query.source, true)
      fetched.sources.push(...uids)
      return uids.map((uid) => ({ uid, source: Buffer.from(JSON.stringify(mails.get(uid))) }))
    }
    async messageFlagsAdd(range, flags) { assert.deepEqual(flags, ['\\Seen']); seen.add(Number(range)) }
    async messageMove(range, folder) { moved.push([Number(range), folder]) }
  }
  return { StubImap, seen, moved, fetched, listeners: () => listeners }
}
const imapConfig = (extra = {}) => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_IMAP_HOST: 'imap.example', FLOWCHAIN_MAIL_BRIDGE_IMAP_USER: 'u', FLOWCHAIN_MAIL_BRIDGE_IMAP_PASSWORD: 'p', FLOWCHAIN_MAIL_BRIDGE_IMAP_DONE_FOLDER: 'FlowChain', ...extra })
const parseJson = async (source) => JSON.parse(source.toString())

test('a mailbox round: a sent message is marked read and moved; a refused or unrelated one stays unread and is not read again', async () => {
  const mails = new Map([
    [11, mailOf()],
    [12, mailOf({ messageId: '<m2@x>', text: 'PO-202610-0028 and PO-202610-0030 ship on 4 December.' })],
    [13, mailOf({ messageId: '<m3@x>', subject: 'News', text: 'No order here' })],
    [14, mailOf({ messageId: '<m4@x>' })],
  ])
  const imap = stubImap(mails)
  const answers = [{ outcome: 'sent', status: 201 }, { outcome: 'refused', status: 422, code: 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' }, { outcome: 'later', status: 503 }]
  const posted = []
  const post = async (cfg, body) => { posted.push(body.messageId); return { replyId: null, orderNumber: null, retryAfter: null, code: null, ...answers.shift() } }
  const state = openState(null)
  assert.deepEqual(await runImap({ config: imapConfig(), ImapFlow: imap.StubImap, parse: parseJson, post, state }), { sent: 1, refused: 1, skipped: 1, later: 1 })
  assert.deepEqual([[...imap.seen], imap.moved, posted, imap.listeners()], [[11], [[11, 'FlowChain']], ['<m1@acme-home.example>', '<m2@x>', '<m4@x>'], 1])
  // Next round: only the one to try again is read whole and sent.
  answers.push({ outcome: 'sent', status: 201 })
  imap.fetched.sources.length = 0
  assert.deepEqual(await runImap({ config: imapConfig(), ImapFlow: imap.StubImap, parse: parseJson, post, state }), { sent: 1, refused: 0, skipped: 0, later: 0 })
  assert.deepEqual([[...imap.seen].sort(), posted.at(-1), imap.fetched.sources], [[11, 14], '<m4@x>', [14]])
})

test('a mailbox full of handled unread messages still reaches a new reply; a large message is not read', async () => {
  // 60 unrelated unread messages, remembered from earlier rounds, then a reply.
  const mails = new Map()
  for (let uid = 1; uid <= 60; uid += 1) mails.set(uid, mailOf({ messageId: `<news-${uid}@x>`, subject: 'News', text: 'No order here' }))
  mails.set(61, mailOf({ messageId: '<reply@x>' }))
  mails.set(62, mailOf({ messageId: '<large@x>' }))
  const imap = stubImap(mails, { sizes: { 62: 9_000_000 } })
  const state = openState(null)
  for (let uid = 1; uid <= 60; uid += 1) state.remember(`<news-${uid}@x>`, 'skipped', 'no_order_number')
  const posted = []
  const post = async (cfg, body) => { posted.push(body.messageId); return { outcome: 'sent', status: 201, replyId: 'r', orderNumber: null, retryAfter: null, code: null } }
  assert.deepEqual(await runImap({ config: imapConfig(), ImapFlow: imap.StubImap, parse: parseJson, post, state }), { sent: 1, refused: 0, skipped: 1, later: 0 })
  assert.deepEqual([posted, imap.fetched.sources], [['<reply@x>'], [61]])
  assert.equal(state.has('<large@x>'), true)
})

test('without the server\'s MOVE a sent message is only marked read, never moved (no copy, delete and expunge)', async () => {
  const imap = stubImap(new Map([[21, mailOf()]]), { capabilities: ['IMAP4rev1', 'UIDPLUS'] })
  const lines = []
  const post = async () => ({ outcome: 'sent', status: 201, replyId: 'r', orderNumber: null, retryAfter: null, code: null })
  assert.deepEqual(await runImap({ config: imapConfig(), ImapFlow: imap.StubImap, parse: parseJson, post, state: openState(null), log: (line) => lines.push(line) }), { sent: 1, refused: 0, skipped: 0, later: 0 })
  assert.deepEqual([[...imap.seen], imap.moved], [[21], []])
  assert.equal(lines.some((line) => /does not offer MOVE/.test(line)), true)
})

test('a message without a Message-ID gets a key from its envelope', () => {
  const envelope = { messageId: '', subject: 'Re: PO-202610-0028', date: new Date('2026-11-22T14:12:00Z'), from: [{ address: 'a@b.example' }] }
  assert.match(envelopeKey(envelope, 1200), /^env:[0-9a-f]{64}$/)
  assert.equal(envelopeKey(envelope, 1200), envelopeKey({ ...envelope }, 1200))
  assert.equal(envelopeKey({ ...envelope, messageId: '<x@y>' }, 1200), '<x@y>')
})

let simpleParser = null
try { simpleParser = createRequire(join(here, '..', 'package.json'))('mailparser').simpleParser } catch { /* not installed: npm ci in this folder */ }
test('the example messages parse as a mailbox gives them, English and Chinese', { skip: !simpleParser && 'mailparser is not installed in this folder' }, async () => {
  const examples = join(here, '..', 'examples')
  const parsed = await Promise.all(readdirSync(examples).sort().map(async (name) => [name, await simpleParser(readFileSync(join(examples, name)))]))
  const rows = parsed.map(([name, mail]) => [name, forwardable(mail).forward, payloadOf(mail, { timeZone: 'America/New_York' }).body])
  assert.deepEqual(rows.map(([name, forward]) => [name, forward]), [['01-acme-new-date.eml', true], ['02-globex-zh.eml', true], ['03-newsletter.eml', false]])
  assert.deepEqual([rows[0][2].from, rows[0][2].receivedOn, rows[0][2].messageId], ['priya@acme-home.example', '2026-11-22', '<demo-0001-acme@acme-home.example>'])
  assert.match(rows[1][2].text, /PO-202611-0012 的货已经备好，12月3日安排发货/)
  assert.equal(rows[1][2].subject, '回复：PO-202611-0012 交期')
})
