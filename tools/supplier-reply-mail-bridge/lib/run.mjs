// One round of the bridge: from a folder of .eml files, or from a mailbox
// over IMAP. The parser (mailparser's simpleParser), the IMAP client
// (imapflow's ImapFlow) and the POST are passed in, so the rounds are tested
// without a mailbox, a network or the libraries.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { requireImap } from './config.mjs'
import { forwardable, messageKey, payloadOf, postReply } from './forward.mjs'

// The endpoint refused the bridge itself (the token, the workspace switch,
// the URL): nothing more is sent and nothing is marked as handled.
export class BridgeStop extends Error {
  constructor(result) {
    const advice = result.status === 401 ? 'the token is wrong, expired or revoked: make a new one'
      : result.status === 404 ? 'the endpoint is off or the URL is wrong: start FlowChain with FLOWCHAIN_SUPPLIER_REPLY_INGEST=on and check FLOWCHAIN_MAIL_BRIDGE_ENDPOINT'
        : result.code === 'REDIRECT' ? 'the endpoint redirected, and the bridge never follows a redirect: give its final address (https, or localhost)'
          : result.code === 'NOT_FLOWCHAIN' ? 'the address did not answer as FlowChain\'s API: check the port in FLOWCHAIN_MAIL_BRIDGE_ENDPOINT (the API, not the web page)'
            : result.code === 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA' ? 'the workspace holds public data: start FlowChain with FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA=on to allow it'
              : result.code === 'SUPPLIER_REPLY_INGEST_AI_OFF' ? 'the workspace has AI switched off: switch it on in Settings'
                : 'the workspace refuses replies from this token'
    super(`FlowChain answered ${result.status}${result.code ? ` ${result.code}` : ''}: ${advice}.`)
    this.result = result
  }
}

const describe = (result) => [result.status ?? 'no answer', result.code, result.orderNumber, result.replyId && `reply ${result.replyId}`].filter(Boolean).join(' ')
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex')

// Files: sent ones move to sent/, refused ones to refused/, ones not for
// FlowChain (or too large) to skipped/; ones to try again stay where they are.
export async function runFolder({ dir, config, parse, post = postReply, state, log = () => {} }) {
  const counts = { sent: 0, refused: 0, skipped: 0, later: 0 }
  const move = (name, sub) => {
    mkdirSync(join(dir, sub), { recursive: true })
    renameSync(join(dir, name), join(dir, sub, name))
  }
  try {
    for (const name of readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.eml')).sort()) {
      if (config.maxBytes && statSync(join(dir, name)).size > config.maxBytes) { move(name, 'skipped'); counts.skipped += 1; log(`skipped  ${name}: larger than ${config.maxBytes} bytes`); continue }
      const source = readFileSync(join(dir, name))
      let mail
      let prepared
      try {
        mail = await parse(source)
        const check = forwardable(mail, config)
        prepared = check.forward ? payloadOf(mail, config) : { why: check.why }
      } catch (error) {
        prepared = { why: `could not be read (${String(error?.name || 'error')})` }
      }
      if (prepared.why) { move(name, 'skipped'); counts.skipped += 1; log(`skipped  ${name}: ${prepared.why}`); continue }
      const { body, truncated } = prepared
      const result = await post(config, body)
      if (result.outcome === 'stop') throw new BridgeStop(result)
      if (result.outcome === 'later') {
        counts.later += 1
        log(`later    ${name}: ${describe(result)}`)
        if (result.status === 429) break
        continue
      }
      state.remember(messageKey(mail), result.outcome, result.code)
      move(name, result.outcome)
      counts[result.outcome] += 1
      log(`${result.outcome.padEnd(8)} ${name}: ${describe(result)}${truncated ? ' (text cut to the endpoint\'s limit)' : ''}`)
    }
  } finally {
    state.save()
  }
  return counts
}

// A message's key from its envelope, before its body is read: its
// Message-ID, or its sender, date, subject and size.
export function envelopeKey(envelope, size) {
  const id = String(envelope?.messageId || '').trim()
  if (id && id.length <= 998 && /^[\x21-\x7e]+$/.test(id)) return id
  const from = String(envelope?.from?.[0]?.address || '').toLowerCase()
  // A date the server could not parse stays a string: it is left out, never
  // turned into one (which would throw).
  const when = envelope?.date instanceof Date ? envelope.date : null
  const date = when && !Number.isNaN(when.getTime()) ? when.toISOString() : ''
  return `env:${sha256([from, date, String(envelope?.subject || ''), String(size ?? '')].join('\n'))}`
}

let noMoveNoted = false

// A mailbox round over the unread messages.
// - First only their envelopes and sizes are read. Messages handled before
//   (refused, or not for FlowChain, which stay unread for a person) are left
//   out, and at most `limit` new ones are read whole.
// - A message larger than config.maxBytes is not read; it is remembered as
//   skipped.
// - A message sent to FlowChain is marked read, and moved to the done folder
//   when one is set and the server offers MOVE. Without MOVE, imapflow would
//   copy, mark deleted and expunge, and a plain EXPUNGE removes every deleted
//   message in the mailbox. So the bridge then only marks the message read,
//   and never expunges.
// - A message to try again is left as it is.
export async function runImap({ config, ImapFlow, parse, post = postReply, state, log = () => {}, limit = 50 }) {
  const imap = requireImap(config)
  const client = new ImapFlow({ host: imap.host, port: imap.port, secure: true, auth: { user: imap.user, pass: imap.password }, logger: false })
  // A dropped connection fails the round (the next round connects again)
  // instead of ending the process.
  client.on('error', () => {})
  const counts = { sent: 0, refused: 0, skipped: 0, later: 0 }
  await client.connect()
  try {
    const canMove = Boolean(imap.doneFolder) && Boolean(client.capabilities?.has?.('MOVE'))
    if (imap.doneFolder && !canMove && !noMoveNoted) {
      noMoveNoted = true
      log(`the mail server does not offer MOVE: sent messages are marked read but not moved to ${imap.doneFolder}`)
    }
    if (canMove) await client.mailboxCreate(imap.doneFolder).catch(() => {})
    const lock = await client.getMailboxLock(imap.mailbox)
    try {
      // The unread messages by a search: imapflow packs the UIDs into ranges,
      // so a long backlog never makes a command too long for the server.
      const heads = (await client.fetchAll({ seen: false }, { uid: true, envelope: true, size: true }, { uid: true })) || []
      const fresh = heads.map((row) => ({ uid: row.uid, size: Number(row.size) || 0, key: envelopeKey(row.envelope, row.size) })).filter((row) => !state.has(row.key)).slice(0, limit)
      const toRead = []
      for (const row of fresh) {
        if (config.maxBytes && row.size > config.maxBytes) {
          state.remember(row.key, 'skipped', 'too_large')
          counts.skipped += 1
          log(`skipped  uid ${row.uid}: larger than ${config.maxBytes} bytes`)
          continue
        }
        toRead.push(row)
      }
      const keys = new Map(toRead.map((row) => [row.uid, row.key]))
      const messages = toRead.length ? await client.fetchAll(toRead.map((row) => row.uid).join(','), { uid: true, source: true }, { uid: true }) : []
      for (const { uid, source } of messages) {
        const key = keys.get(uid)
        // One message that cannot be read is skipped and remembered; the
        // others in the round go on.
        let prepared
        try {
          const mail = await parse(source)
          const check = forwardable(mail, config)
          prepared = check.forward ? { ...payloadOf(mail, config) } : { why: check.why }
        } catch (error) {
          prepared = { why: 'unreadable', error }
        }
        if (prepared.why) {
          state.remember(key, 'skipped', prepared.why)
          counts.skipped += 1
          if (prepared.error) log(`skipped  uid ${uid}: could not be read (${String(prepared.error?.name || 'error')})`)
          continue
        }
        const { body, truncated } = prepared
        const result = await post(config, body)
        if (result.outcome === 'stop') throw new BridgeStop(result)
        if (result.outcome === 'later') {
          counts.later += 1
          log(`later    uid ${uid}: ${describe(result)}`)
          if (result.status === 429) break
          continue
        }
        state.remember(key, result.outcome, result.code)
        if (result.outcome === 'sent') {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
          if (canMove) await client.messageMove(String(uid), imap.doneFolder, { uid: true })
        }
        counts[result.outcome] += 1
        log(`${result.outcome.padEnd(8)} uid ${uid}: ${describe(result)}${truncated ? ' (text cut to the endpoint\'s limit)' : ''}`)
      }
    } finally {
      lock.release()
    }
  } finally {
    state.save()
    await client.logout().catch(() => {})
  }
  return counts
}
