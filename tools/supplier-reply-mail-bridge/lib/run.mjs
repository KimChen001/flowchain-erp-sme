// One round of the bridge: from a folder of .eml files, or from a mailbox
// over IMAP. The parser (mailparser's simpleParser), the IMAP client
// (imapflow's ImapFlow) and the POST are passed in, so the rounds are tested
// without a mailbox, a network or the libraries.
import { mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { requireImap } from './config.mjs'
import { forwardable, messageKey, payloadOf, postReply } from './forward.mjs'

// The endpoint refused the bridge itself (the token, the workspace switch or
// the URL): nothing more is sent and nothing is marked as handled.
export class BridgeStop extends Error {
  constructor(result) {
    const advice = result.status === 401 ? 'the token is wrong, expired or revoked: make a new one'
      : result.status === 404 ? 'the endpoint is off or the URL is wrong: start FlowChain with FLOWCHAIN_SUPPLIER_REPLY_INGEST=on and check FLOWCHAIN_MAIL_BRIDGE_ENDPOINT'
        : result.code === 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA' ? 'the workspace holds public data: start FlowChain with FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA=on to allow it'
          : result.code === 'SUPPLIER_REPLY_INGEST_AI_OFF' ? 'the workspace has AI switched off: switch it on in Settings'
            : 'the workspace refuses replies from this token'
    super(`FlowChain answered ${result.status}${result.code ? ` ${result.code}` : ''}: ${advice}.`)
    this.result = result
  }
}

const describe = (result) => [result.status ?? 'no answer', result.code, result.orderNumber, result.replyId && `reply ${result.replyId}`].filter(Boolean).join(' ')

// Files: sent ones move to sent/, refused ones to refused/, ones not for
// FlowChain to skipped/; ones to try again stay where they are.
export async function runFolder({ dir, config, parse, post = postReply, state, log = () => {} }) {
  const counts = { sent: 0, refused: 0, skipped: 0, later: 0 }
  const move = (name, sub) => {
    mkdirSync(join(dir, sub), { recursive: true })
    renameSync(join(dir, name), join(dir, sub, name))
  }
  try {
    for (const name of readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.eml')).sort()) {
      const source = readFileSync(join(dir, name))
      const mail = await parse(source)
      const check = forwardable(mail, config)
      if (!check.forward) { move(name, 'skipped'); counts.skipped += 1; log(`skipped  ${name}: ${check.why}`); continue }
      const { body, truncated } = payloadOf(mail, config)
      const result = await post(config, body)
      if (result.outcome === 'stop') throw new BridgeStop(result)
      if (result.outcome === 'later') {
        counts.later += 1
        log(`later    ${name}: ${describe(result)}`)
        if (result.status === 429) break
        continue
      }
      state.remember(messageKey(mail, source), result.outcome, result.code)
      move(name, result.outcome)
      counts[result.outcome] += 1
      log(`${result.outcome.padEnd(8)} ${name}: ${describe(result)}${truncated ? ' (text cut to the endpoint\'s limit)' : ''}`)
    }
  } finally {
    state.save()
  }
  return counts
}

// A mailbox: the unread messages, at most `limit` a round. A message sent to
// FlowChain is marked read (and moved to the done folder when one is set).
// A refused one, or one not for FlowChain, stays unread for a person, and is
// remembered so it is not read again. One to try again is left as it is.
export async function runImap({ config, ImapFlow, parse, post = postReply, state, log = () => {}, limit = 50 }) {
  const imap = requireImap(config)
  const client = new ImapFlow({ host: imap.host, port: imap.port, secure: true, auth: { user: imap.user, pass: imap.password }, logger: false })
  const counts = { sent: 0, refused: 0, skipped: 0, later: 0 }
  await client.connect()
  try {
    if (imap.doneFolder) await client.mailboxCreate(imap.doneFolder).catch(() => {})
    const lock = await client.getMailboxLock(imap.mailbox)
    try {
      const unread = (await client.search({ seen: false }, { uid: true })) || []
      const range = unread.slice(0, limit)
      // The whole message, without marking it read (BODY.PEEK).
      const messages = range.length ? await client.fetchAll(range.join(','), { uid: true, source: true }, { uid: true }) : []
      for (const { uid, source } of messages) {
        const mail = await parse(source)
        const key = messageKey(mail, source)
        if (state.has(key)) continue
        const check = forwardable(mail, config)
        if (!check.forward) { state.remember(key, 'skipped', check.why); counts.skipped += 1; continue }
        const { body, truncated } = payloadOf(mail, config)
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
          if (imap.doneFolder) await client.messageMove(String(uid), imap.doneFolder, { uid: true })
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
