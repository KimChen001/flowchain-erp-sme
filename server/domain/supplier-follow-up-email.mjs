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

const fail = (code, message, field) => Object.assign(new Error(message), { status: 422, code, details: field ? [{ field, message }] : [] })

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

// Where an email goes: the configured provider, or the local outbox file. A
// public-data workspace always uses the outbox, so a research workspace never
// emails a real company.
export function supplierEmailDelivery(env = process.env) {
  if (text(env.FLOWCHAIN_PUBLIC_DATA_EXTRACT)) return 'outbox'
  return mailProviderName(env) || 'none'
}
