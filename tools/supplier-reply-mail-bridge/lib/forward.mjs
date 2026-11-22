// One message, from the mailbox to FlowChain: whether it is for FlowChain,
// the endpoint's body, the POST, and what to do with the message after the
// endpoint answered. A parsed message has mailparser's shape: subject,
// from.value[0].address, messageId, date, text (no attachments are sent).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

// The endpoint takes at most this much text (SUPPLIER_REPLY_LIMITS.text × 2).
export const TEXT_LIMIT = 16000
// A reading calls the model, which may take a while.
export const POST_TIMEOUT_MS = 120_000

const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex')
const senderOf = (mail) => String(mail?.from?.value?.[0]?.address || '').trim().toLowerCase()
const usableId = (value) => {
  const id = String(value || '').trim()
  return id && id.length <= 998 && /^[\x21-\x7e]+$/.test(id) ? id : null
}

// The day a message was received, in the workspace's time zone.
export function receivedDay(date, timeZone) {
  const when = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(when.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when)
}

// Whether a message is for FlowChain: it names an order number in the
// numbering (PO-202611-0012, also written full-width or with another dash)
// in its subject or text, and, when senders are listed, comes from one of
// them (an address, or a domain).
export function forwardable(mail, { orderPrefix = 'PO', from = [] } = {}) {
  const number = new RegExp(`\\b${orderPrefix}\\s*[-–—]?\\s*\\d{6}\\s*[-–—]\\s*\\d{4,6}\\b`, 'i')
  if (!number.test(`${mail?.subject || ''}\n${mail?.text || ''}`.normalize('NFKC'))) return { forward: false, why: 'no_order_number' }
  if (from.length) {
    const sender = senderOf(mail)
    const domain = sender.split('@')[1] || ''
    if (!from.some((entry) => entry === sender || entry === domain || entry === `@${domain}`)) return { forward: false, why: 'sender_not_listed' }
  }
  return { forward: true, why: null }
}

// The message's id for FlowChain: its Message-ID, or, when it has none (or
// one FlowChain does not take), an id made from its sender, date, subject
// and text, so a retry of the same message is still kept once.
export function messageIdOf(mail) {
  const own = usableId(mail?.messageId)
  if (own) return own
  const date = mail?.date ? new Date(mail.date).toISOString() : ''
  return `<${sha256([senderOf(mail), date, String(mail?.subject || ''), sha256(String(mail?.text || ''))].join('\n'))}@flowchain-mail-bridge.local>`
}
export const messageKey = (mail) => messageIdOf(mail)

// The endpoint's body for a parsed message.
export function payloadOf(mail, { timeZone }) {
  const textValue = String(mail?.text || '').replace(/\r\n/g, '\n').trim()
  const body = { text: textValue.slice(0, TEXT_LIMIT), messageId: messageIdOf(mail) }
  const subject = String(mail?.subject || '').trim()
  if (subject) body.subject = subject.slice(0, 998)
  const sender = senderOf(mail)
  if (sender) body.from = sender.slice(0, 320)
  const day = mail?.date ? receivedDay(mail.date, timeZone) : null
  if (day) body.receivedOn = day
  return { body, truncated: textValue.length > TEXT_LIMIT }
}

// What the endpoint's answer means for the message:
//   sent     201 with the new reply's id, or 200 when it is already in
//            FlowChain (duplicate): done
//   later    200 still being read elsewhere, 409, 429, 5xx, or no answer:
//            next round
//   refused  any other 4xx about this message (no order named, several open
//            orders, too long …): done; it stays for a person in the mailbox
//   stop     401, 403, 404, a redirect, or a 2xx that is not FlowChain's
//            answer (the URL points at something else): the bridge stops, so
//            nothing is marked as handled
export function outcomeOf(status, body = null) {
  if (status === 201) return body?.replyId ? 'sent' : 'stop'
  if (status === 200) return body?.duplicate === true ? (body.pending ? 'later' : 'sent') : 'stop'
  if (status >= 300 && status < 400) return 'stop'
  if ([401, 403, 404].includes(status)) return 'stop'
  if (status === 409 || status === 429 || status === null || status >= 500) return 'later'
  if (status >= 400) return 'refused'
  return 'stop'
}

export async function postReply(config, body, { fetchImpl = fetch, timeoutMs = POST_TIMEOUT_MS } = {}) {
  let response
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // A redirect is never followed: the body and the token would go to
      // another address.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { outcome: 'later', status: null, code: 'NO_ANSWER', replyId: null, orderNumber: null, retryAfter: null }
  }
  let json = null
  try { json = await response.json() } catch { /* not JSON */ }
  const retryAfter = Number(response.headers?.get?.('retry-after')) || null
  const code = json?.code || (response.status >= 300 && response.status < 400 ? 'REDIRECT' : null) || (response.status >= 200 && response.status < 300 && outcomeOf(response.status, json) === 'stop' ? 'NOT_FLOWCHAIN' : null)
  return { outcome: outcomeOf(response.status, json), status: response.status, code, replyId: json?.replyId || null, orderNumber: json?.purchaseOrderNumber || null, retryAfter }
}

// Handled messages, remembered between rounds (key → outcome).
export function openState(file) {
  let handled = {}
  if (file) {
    try { handled = JSON.parse(readFileSync(file, 'utf8')).handled || {} } catch { handled = {} }
  }
  return {
    has: (key) => Boolean(handled[key]),
    remember: (key, outcome, code = null) => { handled[key] = { outcome, code, at: new Date().toISOString() } },
    save: () => { if (file) writeFileSync(file, `${JSON.stringify({ handled }, null, 2)}\n`) },
    size: () => Object.keys(handled).length,
  }
}
