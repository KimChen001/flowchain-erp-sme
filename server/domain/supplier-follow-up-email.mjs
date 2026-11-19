import { mailProviderName } from '../mail/mailer.mjs'

// A follow-up email to the supplier of an overdue purchase order, sent from
// Today (docs/drafted-decisions-design.md §4.11, DD-9). The person confirms
// the text, then the address; only then does FlowChain send it. These are the
// rules; the service sends and records.

export const SUPPLIER_EMAIL_PERMISSION = 'procurement.supplier_message.send'
export const SUPPLIER_EMAIL_LIMITS = Object.freeze({
  // At most one email per order per workspace day, and this many per workspace.
  perOrderPerDay: 1,
  perWorkspacePerDay: 20,
  subjectMax: 200,
  bodyMax: 5000,
})
export const SUPPLIER_EMAIL_AUDIT_ACTION = 'supplier_follow_up_sent'

const text = (value) => String(value ?? '').trim()
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

// extra: what the card needs to say the refusal in the interface language
// (the figure that is not on the order, the order number), as the message
// itself is English for developers.
const fail = (code, message, field, extra = {}) => Object.assign(new Error(message), { status: 422, code, details: field ? [{ field, message, ...extra }] : [] })

// The email as the card sends it. confirmedTo is the address the person
// confirmed on the second step; it must be the one sent to.
export function parseFollowUpEmail(input = {}) {
  const to = text(input.to).toLowerCase()
  const subject = text(input.subject)
  const body = String(input.body ?? '').replace(/\r\n/g, '\n').trim()
  if (!EMAIL.test(to) || to.length > 254) throw fail('SUPPLIER_EMAIL_ADDRESS_INVALID', 'Enter one email address.', 'to')
  if (text(input.confirmedTo).toLowerCase() !== to) throw fail('SUPPLIER_EMAIL_NOT_CONFIRMED', 'Confirm the address before sending.', 'confirmedTo')
  if (!subject || subject.length > SUPPLIER_EMAIL_LIMITS.subjectMax || /[\r\n]/.test(subject)) throw fail('SUPPLIER_EMAIL_SUBJECT_INVALID', `Write a subject of one line, up to ${SUPPLIER_EMAIL_LIMITS.subjectMax} characters.`, 'subject')
  if (!body || body.length > SUPPLIER_EMAIL_LIMITS.bodyMax) throw fail('SUPPLIER_EMAIL_BODY_INVALID', `Write a message of up to ${SUPPLIER_EMAIL_LIMITS.bodyMax} characters.`, 'body')
  return { to, subject, body }
}

// The text and the address against the order (design audit 2026-11-15,
// L5-12; §4.11 "the figures come from the order and cannot be edited; the
// wording can", "no prices"). The card lets the person edit the whole text,
// so the server checks it against the draft it built from the order:
//   - the order number is in the subject or the message;
//   - every other figure is one of the order's: a quantity still to receive,
//     the days late, the number of lines, a part of the due or promised date,
//     or a digit of the order number, a line's item code or name, or the
//     supplier's name or contact name on record (a phone number after "+" or
//     "Tel:" aside);
//   - no amount with a currency, and no currency code;
//   - an address other than the supplier's on record was confirmed as such
//     (`recipientNotOnRecord`), and the record says which it was.
const CURRENCY = /[£$€¥￥]\s*\d|\d[\d,.]*\s*(?:[£$€¥￥]|元|美元|英镑|欧元|人民币)|\b(?:USD|GBP|EUR|CNY|RMB|JPY|HKD|CAD|AUD|CHF|SGD)\b/i
const PHONE = /(?:\+|\b(?:tel|phone|mobile|fax)\b\.?[:：]?\s*|(?:电话|手机|传真)[:：]?\s*)\d[\d\s().-]{5,}\d/gi
const FIGURE = /\d[\d,]*(?:\.\d+)?/g
const DOTTED_DATE = /\b(\d{1,4})\.(\d{1,2})\.(\d{2,4})\b/g
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function dateParts(value) {
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return match ? [Number(match[1]), Number(match[1]) % 100, Number(match[2]), Number(match[3])] : []
}

export function checkFollowUpContent(email, draft, input = {}) {
  if (!draft || draft.type !== 'supplier_follow_up') throw Object.assign(new Error('This order has no follow-up to send. Reload Today.'), { status: 409, code: 'SUPPLIER_EMAIL_DRAFT_MISSING', details: [] })
  const orderNumber = text(draft.orderNumber)
  const all = `${email.subject}\n${email.body}`
  if (orderNumber && !all.toLowerCase().includes(orderNumber.toLowerCase())) throw fail('SUPPLIER_EMAIL_ORDER_MISSING', `Keep the order number ${orderNumber} in the message.`, 'body', { orderNumber })
  if (CURRENCY.test(all)) throw fail('SUPPLIER_EMAIL_PRICE', 'Leave prices and currencies out of a supplier follow-up.', 'body')
  const lines = Array.isArray(draft.lines) ? draft.lines : []
  const allowed = new Set([
    ...lines.map((line) => Number(line.remaining)),
    Number(draft.overdueDays), Number(draft.moreLines), lines.length, lines.length + (Number(draft.moreLines) || 0),
    ...[draft.dueDate, ...lines.map((line) => line.promisedDate)].flatMap(dateParts),
  ].filter(Number.isFinite))
  // The order number, item codes and names, and the supplier's names on
  // record carry digits of their own (the card's greeting names the contact).
  const codes = [orderNumber, text(draft.supplier?.contactName), text(draft.supplier?.name), ...lines.flatMap((line) => [text(line.sku), text(line.supplierSku), text(line.itemName)])].filter(Boolean).sort((a, b) => b.length - a.length)
  const words = codes.length ? all.replace(new RegExp(codes.map(escape).join('|'), 'gi'), ' ') : all
  // A date written with dots (04.11.2026 in a German workspace) is its parts,
  // each checked as a part of the order's dates, never a decimal 4.11.
  const dated = words.replace(DOTTED_DATE, (_, a, b, c) => ` ${a} ${b} ${c} `)
  for (const match of dated.replace(PHONE, ' ').matchAll(FIGURE)) {
    const value = Number(match[0].replace(/,/g, '').replace(/\.$/, ''))
    if (!allowed.has(value)) throw fail('SUPPLIER_EMAIL_FIGURE_CHANGED', `${match[0]} is not on order ${orderNumber || ''}. The order's figures cannot be changed; edit only the wording.`.replace(/ {2}/g, ' '), 'body', { figure: match[0], orderNumber })
  }
  const onRecord = text(draft.supplier?.email).toLowerCase()
  const recipientOnRecord = Boolean(onRecord) && onRecord === email.to
  if (!recipientOnRecord && input.recipientNotOnRecord !== true) {
    throw fail('SUPPLIER_EMAIL_RECIPIENT_NOT_ON_RECORD', onRecord ? `${email.to} is not the supplier's email on record (${onRecord}). Confirm it to send.` : `The supplier has no email on record. Confirm ${email.to} to send.`, 'to')
  }
  return { recipientOnRecord }
}

// Where an email goes: the configured provider, or the local outbox file. A
// public-data workspace always uses the outbox, so a research workspace never
// emails a real company.
export function supplierEmailDelivery(env = process.env) {
  if (text(env.FLOWCHAIN_PUBLIC_DATA_EXTRACT)) return 'outbox'
  return mailProviderName(env) || 'none'
}
