import { createHash, randomUUID } from 'node:crypto'
import { parseDecision } from '../domain/decision-items.mjs'
import { SUPPLIER_EMAIL_AUDIT_ACTION, SUPPLIER_EMAIL_LIMITS, parseFollowUpEmail, supplierEmailDelivery } from '../domain/supplier-follow-up-email.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'
import { mergeOperationalSettings } from '../domain/workspace-settings-contract.mjs'
import { createOutboxMailer, defaultOutboxPath } from '../mail/outbox-mailer.mjs'
import { createDecisionItemRepository } from '../repositories/decision-item-repository.mjs'

// Sends the follow-up on an overdue purchase order to its supplier, after the
// person confirmed the text and the address (docs/drafted-decisions-design.md
// §4.11, DD-9), and records it:
//   - only when the workspace turned supplier email on (review settings);
//   - at most one email per order and 20 per workspace per workspace day;
//   - replies go to the sender's own address;
//   - the email is an AuditLog row on the order (recipient, subject, body,
//     provider and message id), and the decision item becomes "chased";
//   - the same email sent twice (a retry) is sent once.
// A public-data workspace writes to the local outbox only.

const fail = (status, code, message) => Object.assign(new Error(message), { status, code })
const DAY = 86_400_000

export async function supplierEmailSettingOn(prisma, tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { operationalSettings: true } })
  return mergeOperationalSettings(tenant?.operationalSettings).review.supplierFollowUpEmail === true
}

// The emails sent from this workspace in the workspace day `today`.
async function sentToday(prisma, tenantId, { now, today, timeZone }) {
  const rows = await prisma.auditLog.findMany({
    where: { tenantId, action: SUPPLIER_EMAIL_AUDIT_ACTION, createdAt: { gte: new Date(now.getTime() - 2 * DAY) } },
    select: { entityId: true, metadata: true, createdAt: true },
  })
  return rows.filter((row) => tenantCalendarDay(row.createdAt, timeZone) === today)
}

export async function sendSupplierFollowUp({ prisma, tenantId, actor, row, input, env = process.env, mailer = null, now = new Date(), today, timeZone }) {
  if (row.kind !== 'purchase_order_overdue') throw fail(422, 'SUPPLIER_EMAIL_NOT_OVERDUE', 'Only an overdue purchase order can be followed up by email.')
  if (!(await supplierEmailSettingOn(prisma, tenantId))) throw fail(409, 'SUPPLIER_EMAIL_OFF', 'Supplier email is off in this workspace. An administrator can turn it on in Settings.')
  const email = parseFollowUpEmail(input)
  const repository = createDecisionItemRepository({ prisma })
  const key = `${row.kind}:${row.recordId}`
  // A retry of an email already sent today returns that send, before anything
  // else is checked, so a lost answer never sends twice.
  const idempotency = createHash('sha256').update(JSON.stringify([key, email.to, email.subject, email.body])).digest('hex')
  const sent = await sentToday(prisma, tenantId, { now, today, timeZone })
  const repeat = sent.find((entry) => entry.metadata?.idempotency === idempotency)
  if (repeat) return { repeated: true, provider: repeat.metadata.provider, messageId: repeat.metadata.messageId, outbox: repeat.metadata.provider === 'outbox' }
  const live = await repository.findLive(tenantId, key)
  if (live && live.state !== 'open') throw fail(409, 'DECISION_ALREADY_MADE', 'Someone has already decided on this. Reload Today to see who.')
  if (sent.filter((entry) => entry.entityId === String(row.recordId)).length >= SUPPLIER_EMAIL_LIMITS.perOrderPerDay) throw fail(429, 'SUPPLIER_EMAIL_ORDER_LIMIT', 'This order was already followed up by email today.')
  if (sent.length >= SUPPLIER_EMAIL_LIMITS.perWorkspacePerDay) throw fail(429, 'SUPPLIER_EMAIL_WORKSPACE_LIMIT', `This workspace has sent ${SUPPLIER_EMAIL_LIMITS.perWorkspacePerDay} supplier emails today. Try again tomorrow.`)

  const delivery = supplierEmailDelivery(env)
  if (delivery === 'none') throw fail(503, 'SUPPLIER_EMAIL_NO_PROVIDER', 'No mail provider is set up for this server.')
  const sender = delivery === 'outbox' ? createOutboxMailer({ path: defaultOutboxPath(env) }) : mailer
  if (!sender) throw fail(503, 'SUPPLIER_EMAIL_NO_PROVIDER', 'No mail provider is set up for this server.')
  const replyTo = String(actor.user?.email || '').trim() || undefined
  const result = await sender.send({ to: email.to, subject: email.subject, text: email.body, replyTo, tag: 'supplier-follow-up' })
  const provider = result?.provider || delivery

  await prisma.auditLog.create({ data: {
    id: randomUUID(), tenantId, source: 'today', module: 'procurement', action: SUPPLIER_EMAIL_AUDIT_ACTION, entityType: 'purchase_order', entityId: String(row.recordId), actorId: actor.user.id,
    summary: provider === 'outbox' ? `Follow-up to ${email.to} saved to the local outbox` : `Follow-up emailed to ${email.to}`,
    metadata: { to: email.to, replyTo: replyTo || null, subject: email.subject, body: email.body, provider, messageId: result?.messageId || null, idempotency, decisionItemId: live?.id || null },
  } })
  // The item is chased now; a decision someone took in the meantime stands.
  await repository.decide(tenantId, actor.user.id, row, { ...parseDecision({ option: 'chased' }, { kind: row.kind, today }), note: 'email' }, { now, today }).catch((error) => {
    if (error?.code !== 'DECISION_ALREADY_MADE') throw error
  })
  return { repeated: false, provider, messageId: result?.messageId || null, outbox: provider === 'outbox' }
}
