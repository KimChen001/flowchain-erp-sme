// The mail bridge without a mailbox, a network or FlowChain: its settings,
// which messages it sends and what it sends, how it reads the endpoint's
// answers (against a stub endpoint on this machine), and a round over a
// folder and over a stub IMAP client. The example .eml files are parsed for
// real when mailparser is installed in this folder (npm ci); otherwise that
// test is skipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeArgs } from '../bridge.mjs'
import { bridgeConfig, parseBridgeEnv, readBridgeConfig, requireImap } from '../lib/config.mjs'
import { TEXT_LIMIT, forwardable, messageKey, openState, outcomeOf, payloadOf, postReply, receivedDay } from '../lib/forward.mjs'
import { BridgeStop, runFolder, runImap } from '../lib/run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TOKEN = 'fcsr.dGVuYW50.0f0e8b9a-1111-4222-8333-944455556666.secret'
const base = { FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'http://localhost:18831/api/integrations/supplier-replies', FLOWCHAIN_MAIL_BRIDGE_TOKEN: TOKEN, FLOWCHAIN_MAIL_BRIDGE_TIME_ZONE: 'America/New_York' }
const mailOf = (fields = {}) => ({ subject: 'Re: PO-202610-0028 delivery date', from: { value: [{ address: 'Priya@Acme-Home.example' }] }, messageId: '<m1@acme-home.example>', date: '2026-11-22T14:12:00Z', text: 'PO-202610-0028 ships on 4 December.', ...fields })

// An endpoint on this machine that answers from a list and keeps what it got.
async function stubEndpoint(answers) {
  const received = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      received.push({ authorization: req.headers.authorization, type: req.headers['content-type'], body: JSON.parse(raw || '{}') })
      const next = answers.shift() || { status: 500, body: {} }
      res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers || {}) })
      res.end(JSON.stringify(next.body || {}))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const config = bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: `http://127.0.0.1:${server.address().port}/api/integrations/supplier-replies` })
  return { config, received, close: () => new Promise((done) => server.close(done)) }
}

test('settings: the token goes only over https or to this machine, and the file must live outside the checkout', () => {
  const config = bridgeConfig(base)
  assert.deepEqual([config.endpoint, config.orderPrefix, config.timeZone, config.imap.port, config.imap.mailbox], ['http://localhost:18831/api/integrations/supplier-replies', 'PO', 'America/New_York', 993, 'INBOX'])
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'http://flowchain.example/api/integrations/supplier-replies' }), /https/)
  assert.equal(bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'https://flowchain.example/api/integrations/supplier-replies' }).endpoint.startsWith('https://'), true)
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_TOKEN: 'abc' }), /fcsr/)
  assert.throws(() => bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_TIME_ZONE: 'Mars/Base' }), /time zone/)
  // Only the bridge's own names are read.
  assert.deepEqual(parseBridgeEnv('FLOWCHAIN_MAIL_BRIDGE_TOKEN="x"\nFLOWCHAIN_AI_PROVIDER_API_KEY=secret\n# FLOWCHAIN_MAIL_BRIDGE_FROM=a'), { FLOWCHAIN_MAIL_BRIDGE_TOKEN: 'x' })
  // The mailbox settings are needed only to read a mailbox.
  assert.throws(() => requireImap(config), /IMAP_HOST, FLOWCHAIN_MAIL_BRIDGE_IMAP_USER, FLOWCHAIN_MAIL_BRIDGE_IMAP_PASSWORD/)
  const checkout = resolve(here, '..', '..', '..')
  assert.throws(() => readBridgeConfig(join(checkout, 'bridge.env'), { checkout }), /outside the FlowChain checkout/)
  const outside = mkdtempSync(join(tmpdir(), 'mail-bridge-'))
  writeFileSync(join(outside, 'bridge.env'), Object.entries(base).map(([key, value]) => `${key}=${value}`).join('\n'))
  assert.equal(readBridgeConfig(join(outside, 'bridge.env'), { checkout }).stateFile, join(outside, 'flowchain-mail-bridge-state.json'))
  assert.throws(() => bridgeArgs([]), /--config/)
  assert.throws(() => bridgeArgs(['--config=x', '--interval=5']), /15 seconds/)
})

test('only a message naming an order number is sent, from a listed sender when senders are listed', () => {
  assert.equal(forwardable(mailOf()).forward, true)
  assert.equal(forwardable(mailOf({ subject: 'Hello', text: 'Order PO-202611-0012 is ready' })).forward, true)
  assert.equal(forwardable(mailOf({ subject: 'Hello', text: 'Our newsletter' })).why, 'no_order_number')
  assert.equal(forwardable(mailOf({ subject: 'Re: INV-202611-0003', text: 'Invoice attached' })).forward, false)
  assert.equal(forwardable(mailOf(), { from: ['acme-home.example'] }).forward, true)
  assert.equal(forwardable(mailOf(), { from: ['priya@acme-home.example'] }).forward, true)
  assert.equal(forwardable(mailOf(), { from: ['globex.example'] }).why, 'sender_not_listed')
})

test('the body sent: the text, the subject, the sender, the Message-ID and the day it came, in the workspace\'s time zone', () => {
  // 22 Nov 02:30 UTC is still 21 Nov in New York.
  assert.equal(receivedDay('2026-11-22T02:30:00Z', 'America/New_York'), '2026-11-21')
  assert.equal(receivedDay('2026-11-22T02:30:00Z', 'Asia/Shanghai'), '2026-11-22')
  const { body, truncated } = payloadOf(mailOf(), { timeZone: 'America/New_York' })
  assert.deepEqual(body, { text: 'PO-202610-0028 ships on 4 December.', subject: 'Re: PO-202610-0028 delivery date', from: 'priya@acme-home.example', messageId: '<m1@acme-home.example>', receivedOn: '2026-11-22' })
  assert.equal(truncated, false)
  const long = payloadOf(mailOf({ text: 'x'.repeat(TEXT_LIMIT + 10), messageId: '<ünicode@example>' }), { timeZone: 'UTC' })
  assert.deepEqual([long.body.text.length, long.truncated, 'messageId' in long.body], [TEXT_LIMIT, true, false])
  assert.equal(messageKey(mailOf({ messageId: '' }), 'source').startsWith('sha256:'), true)
})

test('the endpoint\'s answer decides what happens to the message', () => {
  assert.equal(outcomeOf(201), 'sent')
  assert.equal(outcomeOf(200, { duplicate: true, pending: false }), 'sent')
  assert.equal(outcomeOf(200, { duplicate: true, pending: true }), 'later')
  for (const status of [400, 413, 422]) assert.equal(outcomeOf(status), 'refused', String(status))
  for (const status of [401, 403, 404]) assert.equal(outcomeOf(status), 'stop', String(status))
  for (const status of [409, 429, 500, 503, null]) assert.equal(outcomeOf(status), 'later', String(status))
})

test('the POST carries the token and the body, and reads each kind of answer', async () => {
  const endpoint = await stubEndpoint([
    { status: 201, body: { duplicate: false, replyId: 'r1', purchaseOrderNumber: 'PO-202610-0028' } },
    { status: 422, body: { code: 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' } },
    { status: 429, body: { code: 'SUPPLIER_REPLY_INGEST_RATE_LIMITED' }, headers: { 'retry-after': '120' } },
    { status: 401, body: { code: 'INTEGRATION_TOKEN_INVALID' } },
  ])
  try {
    const { body } = payloadOf(mailOf(), endpoint.config)
    assert.deepEqual(await postReply(endpoint.config, body), { outcome: 'sent', status: 201, code: null, replyId: 'r1', orderNumber: 'PO-202610-0028', retryAfter: null })
    assert.deepEqual([endpoint.received[0].authorization, endpoint.received[0].type, endpoint.received[0].body.messageId], [`Bearer ${TOKEN}`, 'application/json', '<m1@acme-home.example>'])
    assert.deepEqual(await postReply(endpoint.config, body).then((row) => [row.outcome, row.code]), ['refused', 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS'])
    assert.deepEqual(await postReply(endpoint.config, body).then((row) => [row.outcome, row.retryAfter]), ['later', 120])
    assert.equal((await postReply(endpoint.config, body)).outcome, 'stop')
  } finally {
    await endpoint.close()
  }
  // No answer at all: try again next round.
  assert.deepEqual(await postReply(bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_ENDPOINT: 'http://127.0.0.1:9/x' }), {}, { timeoutMs: 2000 }).then((row) => [row.outcome, row.code]), ['later', 'NO_ANSWER'])
})

test('a folder round: sent and refused files move out, others are skipped, and a refused token stops the bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-bridge-eml-'))
  const write = (name, mail) => writeFileSync(join(dir, name), JSON.stringify(mail))
  write('1-reply.eml', mailOf())
  write('2-two-orders.eml', mailOf({ messageId: '<m2@x>', text: 'PO-202610-0028 and PO-202610-0030 ship on 4 December.' }))
  write('3-news.eml', mailOf({ messageId: '<m3@x>', subject: 'News', text: 'No order here' }))
  const parse = async (source) => JSON.parse(source.toString())
  const endpoint = await stubEndpoint([{ status: 201, body: { replyId: 'r1', purchaseOrderNumber: 'PO-202610-0028' } }, { status: 422, body: { code: 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' } }])
  const stateFile = join(dir, 'state.json')
  const lines = []
  try {
    const counts = await runFolder({ dir, config: endpoint.config, parse, state: openState(stateFile), log: (line) => lines.push(line) })
    assert.deepEqual(counts, { sent: 1, refused: 1, skipped: 1, later: 0 })
    assert.deepEqual([readdirSync(join(dir, 'sent')), readdirSync(join(dir, 'refused')), readdirSync(join(dir, 'skipped'))], [['1-reply.eml'], ['2-two-orders.eml'], ['3-news.eml']])
    assert.equal(endpoint.received.length, 2)
    assert.deepEqual(Object.values(JSON.parse(readFileSync(stateFile, 'utf8')).handled).map((row) => row.outcome).sort(), ['refused', 'sent'])
    // The log names files and answers, never the text or the token.
    assert.equal(lines.some((line) => line.includes('ships on') || line.includes(TOKEN)), false)
  } finally {
    await endpoint.close()
  }
  write('4-reply.eml', mailOf({ messageId: '<m4@x>' }))
  const refusing = await stubEndpoint([{ status: 401, body: { code: 'INTEGRATION_TOKEN_INVALID' } }])
  try {
    await assert.rejects(runFolder({ dir, config: refusing.config, parse, state: openState(null) }), (error) => error instanceof BridgeStop && /token/.test(error.message))
    assert.equal(existsSync(join(dir, '4-reply.eml')), true)
  } finally {
    await refusing.close()
  }
})

test('a mailbox round: a sent message is marked read and moved; a refused or unrelated one stays unread and is not sent again', async () => {
  const sources = new Map([
    [11, mailOf()],
    [12, mailOf({ messageId: '<m2@x>', text: 'PO-202610-0028 and PO-202610-0030 ship on 4 December.' })],
    [13, mailOf({ messageId: '<m3@x>', subject: 'News', text: 'No order here' })],
    [14, mailOf({ messageId: '<m4@x>' })],
  ])
  const seen = new Set()
  const moved = []
  class StubImap {
    constructor(options) { this.options = options }
    async connect() {}
    async logout() {}
    async mailboxCreate() {}
    async getMailboxLock() { return { release() {} } }
    async search(query, options) { assert.deepEqual([query, options], [{ seen: false }, { uid: true }]); return [...sources.keys()].filter((uid) => !seen.has(uid)) }
    async fetchAll(range, query) { assert.equal(query.source, true); return range.split(',').map(Number).map((uid) => ({ uid, source: Buffer.from(JSON.stringify(sources.get(uid))) })) }
    async messageFlagsAdd(range, flags) { assert.deepEqual(flags, ['\\Seen']); seen.add(Number(range)) }
    async messageMove(range, folder) { moved.push([Number(range), folder]) }
  }
  const parse = async (source) => JSON.parse(source.toString())
  const config = { ...bridgeConfig({ ...base, FLOWCHAIN_MAIL_BRIDGE_IMAP_HOST: 'imap.example', FLOWCHAIN_MAIL_BRIDGE_IMAP_USER: 'u', FLOWCHAIN_MAIL_BRIDGE_IMAP_PASSWORD: 'p', FLOWCHAIN_MAIL_BRIDGE_IMAP_DONE_FOLDER: 'FlowChain' }) }
  const answers = [{ outcome: 'sent', status: 201 }, { outcome: 'refused', status: 422, code: 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' }, { outcome: 'later', status: 503 }]
  const posted = []
  const post = async (cfg, body) => { posted.push(body.messageId); return { replyId: null, orderNumber: null, retryAfter: null, code: null, ...answers.shift() } }
  const state = openState(null)
  assert.deepEqual(await runImap({ config, ImapFlow: StubImap, parse, post, state }), { sent: 1, refused: 1, skipped: 1, later: 1 })
  assert.deepEqual([[...seen], moved, posted], [[11], [[11, 'FlowChain']], ['<m1@acme-home.example>', '<m2@x>', '<m4@x>']])
  // Next round: only the one to try again is sent; the refused and unrelated ones are remembered.
  answers.push({ outcome: 'sent', status: 201 })
  assert.deepEqual(await runImap({ config, ImapFlow: StubImap, parse, post, state }), { sent: 1, refused: 0, skipped: 0, later: 0 })
  assert.deepEqual([[...seen].sort(), posted.at(-1)], [[11, 14], '<m4@x>'])
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
