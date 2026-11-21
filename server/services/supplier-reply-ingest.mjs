// Supplier replies that arrive without a person pasting them
// (docs/supplier-reply-ingest-api.md): a forwarder posts the email to
// POST /api/integrations/supplier-replies with a workspace integration token.
// The reply then takes the paste path (supplier-reply-service.mjs): the same
// reading, the same checks in code, the same card, and a person still records
// it. Nothing is recorded on the order here. Two things differ from a paste:
// the card shows the sender and says when it is not the supplier's email on
// record, and an emailed reply never replaces an open card.
//
// Off unless FLOWCHAIN_SUPPLIER_REPLY_INGEST=on. On, a workspace still needs:
// - a token an admin made (settings.workspace.manage), acting for that admin;
// - AI reading switched on where the deployment requires the opt-in, as
//   pasting does (ai-workspace-access.mjs);
// - not a public-data workspace, unless
//   FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA=on.
// Each workspace keeps at most FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY
// emailed replies in any 24 hours (50 by default, the inbound mail limit of
// docs/supplier-reply-dates-design.md §4.11), counted in the database after
// the request is checked, so junk requests do not use it up.
import { z } from 'zod'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { aiOptInRequired } from '../domain/ai-workspace-access.mjs'
import {
  INTEGRATION_MESSAGE_NAMESPACE, INTEGRATION_TOKEN_DAYS, INTEGRATION_TOKEN_LIMIT, INTEGRATION_TOKEN_NAME_LIMIT, INTEGRATION_TOKEN_NAMESPACE, INTEGRATION_TOKEN_USE_NAMESPACE,
  integrationMessageKey, integrationSecretMatches, integrationTokenExpired, newIntegrationToken, parseIntegrationToken, publicIntegrationToken,
} from '../domain/integration-tokens.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { publicDataNoteSummary } from '../domain/public-data-note.mjs'
import { SUPPLIER_REPLY_ORDER_STATES } from '../domain/supplier-reply-reading.mjs'
import { mergeOperationalSettings } from '../domain/workspace-settings-contract.mjs'
import { SUPPLIER_REPLY_LIMITS } from '../../shared/supplier-reply-contract.mjs'

const text = (value) => String(value ?? '').trim()
const MANAGE = 'settings.workspace.manage'
const REVISE = 'procurement.purchase_order.revise'
const DAY_MS = 24 * 60 * 60 * 1000

export class SupplierReplyIngestError extends Error {
  constructor(code, message, status = 400, details = []) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}
const fail = (code, message, status, details) => { throw new SupplierReplyIngestError(code, message, status, details) }
// One answer for every token that is not accepted: missing, malformed,
// unknown, wrong, expired, revoked, or its member disabled or moved to
// another role.
const INVALID = 'The integration token is missing, unknown, expired or revoked.'
const refuseToken = () => fail('INTEGRATION_TOKEN_INVALID', INVALID, 401)

export const supplierReplyIngestEnabled = (env = {}) => text(env.FLOWCHAIN_SUPPLIER_REPLY_INGEST).toLowerCase() === 'on'
const publicDataAllowed = (env = {}) => text(env.FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA).toLowerCase() === 'on'
export function supplierReplyIngestPerDay(env = {}) {
  const value = Number(env.FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY)
  return Number.isInteger(value) && value > 0 && value <= 1000 ? value : 50
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
// What a forwarder sends. Fields it adds beyond these are dropped.
export const supplierReplyIngestRequestSchema = z.object({
  text: z.string().min(1).max(SUPPLIER_REPLY_LIMITS.text * 2),
  subject: z.string().max(998).optional(),
  from: z.string().max(320).optional(),
  // The email's Message-ID (printable ASCII, as RFC 5322 has it): the same
  // message sent twice is kept once.
  messageId: z.string().max(998).regex(/^[\x21-\x7e]+$/).optional(),
  receivedOn: day.optional(),
  // The order's number, when the forwarder knows it; else the subject and
  // text are searched for one.
  purchaseOrder: z.string().max(120).optional(),
})
export const integrationTokenCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(INTEGRATION_TOKEN_NAME_LIMIT),
  expiresInDays: z.number().int().min(1).max(INTEGRATION_TOKEN_DAYS.max).optional(),
})

function parsed(schema, body) {
  const result = schema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
  if (!result.success) fail('SUPPLIER_REPLY_INGEST_INVALID', 'The request does not match the expected fields.', 422, result.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', code: issue.code })))
  return result.data
}

// Purchase order numbers named in the text (PREFIX-YYYYMM-NNNN), first
// mention first, at most 20.
const ORDER_NUMBER = /\b[A-Z][A-Z0-9]{0,9}-\d{6}-\d{4,6}\b/gi
export function orderNumbersIn(...texts) {
  const found = []
  for (const value of texts) {
    for (const match of String(value || '').matchAll(ORDER_NUMBER)) {
      const number = match[0].toUpperCase()
      if (!found.includes(number)) found.push(number)
      if (found.length >= 20) return found
    }
  }
  return found
}

const recordKey = (tenantId, namespace, key) => ({ tenantId_namespace_recordKey: { tenantId, namespace, recordKey: key } })
const ownerIdentity = (tenantId, user) => ({ authenticated: true, source: 'integration_token', tenantId, userId: user.id, role: user.role })

export function createSupplierReplyIngestService({ prisma, replies, env = process.env, now = () => new Date(), resolveActor = resolveProvisionedActor } = {}) {
  if (!prisma) throw new Error('The supplier reply ingestion service needs prisma.')

  // Why a workspace may not take replies this way, or null when it may.
  async function workspaceRefusal(tenantId) {
    const [tenant, note] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { operationalSettings: true } }),
      prisma.runtimeRecord.findUnique({ where: recordKey(tenantId, 'workspace.public-data', 'note'), select: { payload: true } }),
    ])
    if (!tenant) return { code: 'INTEGRATION_TOKEN_INVALID', status: 401, message: INVALID }
    if (publicDataNoteSummary(note?.payload) && !publicDataAllowed(env)) return { code: 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA', status: 403, message: 'Replies cannot be sent to a public-data workspace unless the server allows it.' }
    if (aiOptInRequired(env) && mergeOperationalSettings(tenant.operationalSettings).ai.modelAssistEnabled !== true) return { code: 'SUPPLIER_REPLY_INGEST_AI_OFF', status: 403, message: 'Switch on AI reading for this workspace in Settings first.' }
    return null
  }

  async function adminOf(identity) {
    const actor = await resolveActor(prisma, identity)
    assertAuthorized({ actor, permission: MANAGE, tenantId: actor.tenantId })
    return actor
  }

  // Codes and ids only, never the text or the token; best effort.
  async function auditRefusal(tenantId, tokenId, actorId, error) {
    await prisma.auditLog.create({ data: {
      id: `audit-ingest-${tokenId}-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`, tenantId, actorId: actorId || null, source: 'supplier_reply_ingest', module: 'procurement', action: 'supplier_reply_ingest_refused',
      entityType: 'IntegrationToken', entityId: tokenId, summary: `A supplier reply sent with an integration token was refused: ${error.code}.`,
      metadata: { tokenId, code: error.code, status: error.status },
    } }).catch(() => null)
  }

  // The token behind an Authorization header, its workspace and its member.
  // A record that exists but is refused is audited in its workspace.
  async function acceptToken(authorization) {
    const parts = parseIntegrationToken(authorization)
    if (!parts) refuseToken()
    const record = await prisma.runtimeRecord.findUnique({ where: recordKey(parts.tenantId, INTEGRATION_TOKEN_NAMESPACE, parts.tokenId) })
    if (!record) refuseToken()
    const payload = record.payload || {}
    const owner = await prisma.user.findFirst({ where: { id: text(payload.ownerUserId), tenantId: parts.tenantId } })
    const standing = integrationSecretMatches(payload, parts.secret)
      && !payload.revokedAt
      && !integrationTokenExpired(payload, now())
      && owner?.status === 'active'
      && text(owner.role).toLowerCase() === text(payload.ownerRole)
    if (!standing) {
      await auditRefusal(parts.tenantId, parts.tokenId, owner?.id, { code: 'INTEGRATION_TOKEN_INVALID', status: 401 })
      refuseToken()
    }
    return { tenantId: parts.tenantId, tokenId: parts.tokenId, owner }
  }

  // At most the daily number of emailed replies in the last 24 hours,
  // counted from the replies kept, so every server process sees the same count.
  async function assertUnderDailyLimit(tenantId) {
    const limit = supplierReplyIngestPerDay(env)
    const since = new Date(now().getTime() - DAY_MS)
    const recent = await prisma.supplierReply.count({ where: { tenantId, source: 'email', createdAt: { gt: since } } })
    if (recent < limit) return
    const oldest = await prisma.supplierReply.findFirst({ where: { tenantId, source: 'email', createdAt: { gt: since } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    const retryAfter = Math.max(1, Math.ceil(((oldest ? new Date(oldest.createdAt).getTime() : now().getTime()) + DAY_MS - now().getTime()) / 1000))
    fail('SUPPLIER_REPLY_INGEST_RATE_LIMITED', `This workspace has received ${limit} emailed replies in the last 24 hours. Try again later.`, 429, [{ field: 'retryAfterSeconds', code: String(retryAfter) }])
  }

  async function duplicateOf(tenantId, replyId, pending = false) {
    if (pending) return { status: 200, body: { duplicate: true, pending: true, replyId: null } }
    const earlier = await prisma.supplierReply.findFirst({ where: { tenantId, id: replyId }, select: { id: true, purchaseOrderId: true, state: true, readingStatus: true } })
    return { status: 200, body: { duplicate: true, pending: false, replyId: earlier?.id || replyId, purchaseOrderId: earlier?.purchaseOrderId || null, state: earlier?.state || null, readingStatus: earlier?.readingStatus || null } }
  }

  // The token is checked before the body is read (readBody is called only then).
  async function ingest({ authorization, readBody }) {
    const { tenantId, tokenId, owner } = await acceptToken(authorization)
    try {
      return await ingestFor({ tenantId, tokenId, owner, readBody })
    } catch (error) {
      if (error?.status && error.status < 500) await auditRefusal(tenantId, tokenId, owner.id, error)
      throw error
    }
  }

  async function ingestFor({ tenantId, tokenId, owner, readBody }) {
    const refusal = await workspaceRefusal(tenantId)
    if (refusal) fail(refusal.code, refusal.message, refusal.status)
    // Best effort: when the token was last used (its own record, see
    // integration-tokens.mjs).
    const usedAt = now().toISOString()
    await prisma.runtimeRecord.upsert({
      where: recordKey(tenantId, INTEGRATION_TOKEN_USE_NAMESPACE, tokenId),
      create: { id: `${INTEGRATION_TOKEN_USE_NAMESPACE}:${tokenId}`, tenantId, namespace: INTEGRATION_TOKEN_USE_NAMESPACE, recordKey: tokenId, payload: { lastUsedAt: usedAt } },
      update: { payload: { lastUsedAt: usedAt } },
    }).catch(() => null)
    const input = parsed(supplierReplyIngestRequestSchema, await readBody())

    // The same message twice: the first one stands.
    const messageId = text(input.messageId)
    if (messageId) {
      const earlier = await prisma.supplierReply.findFirst({ where: { tenantId, messageId }, select: { id: true } })
      if (earlier) return duplicateOf(tenantId, earlier.id)
    }

    const named = input.purchaseOrder ? [text(input.purchaseOrder).toUpperCase()] : orderNumbersIn(input.subject, input.text)
    if (!named.length) fail('SUPPLIER_REPLY_INGEST_NO_ORDER', 'No purchase order number was found. Put it in the subject or the text, or send purchaseOrder.', 422, [{ field: 'purchaseOrder', code: 'missing' }])
    const orders = await prisma.purchaseOrder.findMany({ where: { tenantId, number: { in: named } }, select: { id: true, number: true, status: true } })
    if (!orders.length) fail('SUPPLIER_REPLY_INGEST_ORDER_NOT_FOUND', 'No purchase order in this workspace has the number given.', 422, named.map((number) => ({ field: 'purchaseOrder', code: number })))
    // Open orders first: a reply that also mentions a closed order is about the open one.
    const open = orders.filter((order) => SUPPLIER_REPLY_ORDER_STATES.includes(text(order.status)))
    const candidates = open.length ? open : orders
    if (candidates.length > 1) fail('SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS', 'The reply names more than one open purchase order. Send it once per order, with purchaseOrder.', 422, candidates.map((order) => ({ field: 'purchaseOrder', code: order.number })))
    const order = candidates[0]

    await assertUnderDailyLimit(tenantId)

    // Claim the message before the reading: a retry while it is read finds
    // the claim and is told it is a duplicate, without a second reading.
    let claim = null
    if (messageId) {
      const key = integrationMessageKey(messageId)
      try {
        claim = await prisma.runtimeRecord.create({ data: { id: `${INTEGRATION_MESSAGE_NAMESPACE}:${tenantId}:${key}`, tenantId, namespace: INTEGRATION_MESSAGE_NAMESPACE, recordKey: key, payload: { replyId: null, tokenId, claimedAt: now().toISOString() } } })
      } catch (error) {
        if (error?.code !== 'P2002') throw error
        const held = await prisma.runtimeRecord.findUnique({ where: recordKey(tenantId, INTEGRATION_MESSAGE_NAMESPACE, key) })
        return duplicateOf(tenantId, held?.payload?.replyId, !held?.payload?.replyId)
      }
    }

    let pasted
    try {
      pasted = await replies.pasteReply(order.id, { text: input.text, ...(input.receivedOn ? { receivedOn: input.receivedOn } : {}) }, { identity: ownerIdentity(tenantId, owner), env }, {
        origin: { source: 'email', sender: input.from, messageId, tokenId },
      })
    } catch (error) {
      // Not kept: free the message so a retry can try again.
      if (claim) await prisma.runtimeRecord.delete({ where: recordKey(tenantId, INTEGRATION_MESSAGE_NAMESPACE, claim.recordKey) }).catch(() => null)
      throw error
    }
    const reply = pasted.reply
    if (claim) await prisma.runtimeRecord.update({ where: recordKey(tenantId, INTEGRATION_MESSAGE_NAMESPACE, claim.recordKey), data: { payload: { ...claim.payload, replyId: reply.id } } }).catch(() => null)
    // Ids and codes only: the card itself is for the person who records it.
    return { status: 201, body: { duplicate: false, pending: false, replyId: reply.id, purchaseOrderId: order.id, purchaseOrderNumber: order.number, state: reply.state, readingStatus: reply.readingStatus } }
  }

  async function tokenRecords(client, tenantId) {
    return client.runtimeRecord.findMany({ where: { tenantId, namespace: INTEGRATION_TOKEN_NAMESPACE }, orderBy: { createdAt: 'desc' } })
  }
  async function usesOf(tenantId) {
    const rows = await prisma.runtimeRecord.findMany({ where: { tenantId, namespace: INTEGRATION_TOKEN_USE_NAMESPACE } })
    return new Map(rows.map((row) => [row.recordKey, row.payload?.lastUsedAt || null]))
  }
  async function ownersOf(tenantId, records) {
    const ids = [...new Set(records.map((record) => text(record.payload?.ownerUserId)).filter(Boolean))]
    const users = ids.length ? await prisma.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, email: true } }) : []
    return new Map(users.map((user) => [user.id, user]))
  }

  async function listTokens(identity) {
    const actor = await adminOf(identity)
    const records = await tokenRecords(prisma, actor.tenantId)
    const [owners, uses, refusal] = await Promise.all([ownersOf(actor.tenantId, records), usesOf(actor.tenantId), workspaceRefusal(actor.tenantId)])
    return { enabled: !refusal, refusal: refusal?.code || null, limit: INTEGRATION_TOKEN_LIMIT, tokens: records.map((record) => publicIntegrationToken(record, { owners, uses, now: now() })) }
  }

  // A token acts for the admin who makes it, who must be able to revise
  // purchase orders: an admin cannot make one that acts as someone else.
  async function createToken(identity, body) {
    const actor = await adminOf(identity)
    const input = parsed(integrationTokenCreateSchema, body)
    const refusal = await workspaceRefusal(actor.tenantId)
    if (refusal) fail(refusal.code, refusal.message, refusal.status === 401 ? 403 : refusal.status)
    if (!can({ actor, permission: REVISE, tenantId: actor.tenantId })) fail('INTEGRATION_TOKEN_OWNER_CANNOT_REVISE', 'A token acts for the admin who makes it, who must be able to revise purchase orders.', 403)
    const owner = await prisma.user.findFirst({ where: { id: actor.user.id, tenantId: actor.tenantId } })
    if (!owner || owner.status !== 'active') fail('INTEGRATION_TOKEN_OWNER_INACTIVE', 'The token must act for an active member of this workspace.', 403)
    const made = newIntegrationToken({ tenantId: actor.tenantId, name: input.name, owner, createdById: actor.user.id, days: input.expiresInDays || INTEGRATION_TOKEN_DAYS.default, now: now() })
    // Counted and created in one serializable transaction, so two at once
    // cannot pass the limit (the loser gets a 409 to retry).
    await prisma.$transaction(async (tx) => {
      const records = await tokenRecords(tx, actor.tenantId)
      if (records.filter((record) => !record.payload?.revokedAt && !integrationTokenExpired(record.payload, now())).length >= INTEGRATION_TOKEN_LIMIT) fail('INTEGRATION_TOKEN_LIMIT', `A workspace may hold ${INTEGRATION_TOKEN_LIMIT} active tokens. Revoke one first.`, 409)
      await tx.runtimeRecord.create({ data: { id: `${INTEGRATION_TOKEN_NAMESPACE}:${made.tokenId}`, tenantId: actor.tenantId, namespace: INTEGRATION_TOKEN_NAMESPACE, recordKey: made.tokenId, payload: made.payload } })
      await tx.auditLog.create({ data: {
        id: `audit-${made.tokenId}-created`, tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_ingest', module: 'settings', action: 'integration_token_created',
        entityType: 'IntegrationToken', entityId: made.tokenId, summary: `Integration token "${made.payload.name}" created for supplier replies.`,
        metadata: { tokenId: made.tokenId, ownerUserId: owner.id, scope: made.payload.scope, expiresAt: made.payload.expiresAt },
      } })
    }, { isolationLevel: 'Serializable' })
    const record = { recordKey: made.tokenId, payload: made.payload }
    // The token is in this answer only; FlowChain cannot show it again.
    return { token: publicIntegrationToken(record, { owners: new Map([[owner.id, owner]]), now: now() }), secret: made.token }
  }

  async function revokeToken(identity, tokenId) {
    const actor = await adminOf(identity)
    const record = await prisma.runtimeRecord.findUnique({ where: recordKey(actor.tenantId, INTEGRATION_TOKEN_NAMESPACE, text(tokenId)) })
    if (!record) fail('INTEGRATION_TOKEN_NOT_FOUND', 'No such token in this workspace.', 404)
    const owners = await ownersOf(actor.tenantId, [record])
    if (record.payload?.revokedAt) return { token: publicIntegrationToken(record, { owners, now: now() }) }
    const payload = { ...record.payload, revokedAt: now().toISOString(), revokedById: actor.user.id }
    await prisma.$transaction(async (tx) => {
      await tx.runtimeRecord.update({ where: recordKey(actor.tenantId, INTEGRATION_TOKEN_NAMESPACE, record.recordKey), data: { payload } })
      await tx.auditLog.create({ data: {
        id: `audit-${record.recordKey}-revoked`, tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_ingest', module: 'settings', action: 'integration_token_revoked',
        entityType: 'IntegrationToken', entityId: record.recordKey, summary: `Integration token "${payload.name}" revoked.`, metadata: { tokenId: record.recordKey },
      } })
    })
    return { token: publicIntegrationToken({ ...record, payload }, { owners, now: now() }) }
  }

  return { ingest, listTokens, createToken, revokeToken }
}
