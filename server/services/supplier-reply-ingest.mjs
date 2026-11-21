// Supplier replies that arrive without a person pasting them
// (docs/supplier-reply-ingest-api.md): a forwarder posts the email to
// POST /api/integrations/supplier-replies with a workspace integration token.
// The reply then takes the paste path unchanged (supplier-reply-service.mjs):
// the same reading, the same checks in code, the same card, and a person
// still records it. Nothing is recorded on the order here.
//
// Off unless FLOWCHAIN_SUPPLIER_REPLY_INGEST=on. On, a workspace still needs:
// - a token an admin made (settings.workspace.manage), acting for an active
//   member who may revise purchase orders;
// - AI reading switched on where the deployment requires the opt-in, as
//   pasting does (ai-workspace-access.mjs);
// - not a public-data workspace, unless
//   FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA=on.
// Each workspace may send FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY replies a
// day (50 by default, the inbound mail limit of the reply design, §4.11).
import { z } from 'zod'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { aiOptInRequired } from '../domain/ai-workspace-access.mjs'
import {
  INTEGRATION_TOKEN_LIMIT, INTEGRATION_TOKEN_NAME_LIMIT, INTEGRATION_TOKEN_NAMESPACE, INTEGRATION_TOKEN_USE_NAMESPACE,
  createIngestRateLimiter, integrationSecretMatches, newIntegrationToken, parseIntegrationToken, publicIntegrationToken,
} from '../domain/integration-tokens.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { publicDataNoteSummary } from '../domain/public-data-note.mjs'
import { SUPPLIER_REPLY_ORDER_STATES } from '../domain/supplier-reply-reading.mjs'
import { mergeOperationalSettings } from '../domain/workspace-settings-contract.mjs'
import { SUPPLIER_REPLY_LIMITS } from '../../shared/supplier-reply-contract.mjs'

const text = (value) => String(value ?? '').trim()
const MANAGE = 'settings.workspace.manage'
const REVISE = 'procurement.purchase_order.revise'

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
// unknown, wrong secret or revoked.
const refuseToken = () => fail('INTEGRATION_TOKEN_INVALID', 'The integration token is missing, unknown or revoked.', 401)

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
  // The email's Message-ID: the same message sent twice is kept once.
  messageId: z.string().max(998).optional(),
  receivedOn: day.optional(),
  // The order's number, when the forwarder knows it; else the subject and
  // text are searched for one.
  purchaseOrder: z.string().max(120).optional(),
})
export const integrationTokenCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(INTEGRATION_TOKEN_NAME_LIMIT),
  // The member the token acts for; the admin creating it when omitted.
  ownerUserId: z.string().trim().min(1).max(120).optional(),
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

const tokenKey = (tenantId, recordKey) => ({ tenantId_namespace_recordKey: { tenantId, namespace: INTEGRATION_TOKEN_NAMESPACE, recordKey } })
const ownerIdentity = (tenantId, user) => ({ authenticated: true, source: 'integration_token', tenantId, userId: user.id, role: user.role })

export function createSupplierReplyIngestService({ prisma, replies, env = process.env, now = () => new Date(), limiter, resolveActor = resolveProvisionedActor } = {}) {
  if (!prisma) throw new Error('The supplier reply ingestion service needs prisma.')
  const rate = limiter || createIngestRateLimiter({ limit: supplierReplyIngestPerDay(env), now: () => now().getTime() })

  // Why a workspace may not take replies this way, or null when it may.
  async function workspaceRefusal(tenantId) {
    const [tenant, note] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { operationalSettings: true } }),
      prisma.runtimeRecord.findUnique({ where: { tenantId_namespace_recordKey: { tenantId, namespace: 'workspace.public-data', recordKey: 'note' } }, select: { payload: true } }),
    ])
    if (!tenant) return { code: 'INTEGRATION_TOKEN_INVALID', status: 401 }
    if (publicDataNoteSummary(note?.payload) && !publicDataAllowed(env)) return { code: 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA', status: 403, message: 'Replies cannot be sent to a public-data workspace unless the server allows it.' }
    if (aiOptInRequired(env) && mergeOperationalSettings(tenant.operationalSettings).ai.modelAssistEnabled !== true) return { code: 'SUPPLIER_REPLY_INGEST_AI_OFF', status: 403, message: 'Switch on AI reading for this workspace in Settings first.' }
    return null
  }

  async function adminOf(identity) {
    const actor = await resolveActor(prisma, identity)
    assertAuthorized({ actor, permission: MANAGE, tenantId: actor.tenantId })
    return actor
  }

  // The token behind an Authorization header, with its workspace and owner.
  async function acceptToken(authorization) {
    const parts = parseIntegrationToken(authorization)
    if (!parts) refuseToken()
    const record = await prisma.runtimeRecord.findUnique({ where: tokenKey(parts.tenantId, parts.tokenId) })
    if (!record || record.payload?.revokedAt || !integrationSecretMatches(record.payload, parts.secret)) refuseToken()
    return { tenantId: parts.tenantId, tokenId: parts.tokenId, record }
  }

  async function ingest({ authorization, body }) {
    const { tenantId, tokenId, record } = await acceptToken(authorization)
    const refusal = await workspaceRefusal(tenantId)
    if (refusal) fail(refusal.code, refusal.message || 'The integration token is missing, unknown or revoked.', refusal.status)
    const taken = rate.take(tenantId)
    if (!taken.ok) fail('SUPPLIER_REPLY_INGEST_RATE_LIMITED', 'Too many replies from this workspace in the last day. Try again later.', 429, [{ field: 'retryAfterSeconds', code: String(taken.retryAfterSeconds) }])
    // Best effort: when the token was last used (its own record, see
    // integration-tokens.mjs).
    const usedAt = now().toISOString()
    await prisma.runtimeRecord.upsert({
      where: { tenantId_namespace_recordKey: { tenantId, namespace: INTEGRATION_TOKEN_USE_NAMESPACE, recordKey: tokenId } },
      create: { id: `${INTEGRATION_TOKEN_USE_NAMESPACE}:${tokenId}`, tenantId, namespace: INTEGRATION_TOKEN_USE_NAMESPACE, recordKey: tokenId, payload: { lastUsedAt: usedAt } },
      update: { payload: { lastUsedAt: usedAt } },
    }).catch(() => null)
    const input = parsed(supplierReplyIngestRequestSchema, body)

    const owner = await prisma.user.findFirst({ where: { id: text(record.payload.ownerUserId), tenantId } })
    if (!owner || owner.status !== 'active') fail('INTEGRATION_TOKEN_OWNER_INACTIVE', 'The member this token acts for is no longer active. Ask an admin for a new token.', 403)

    // The same message twice: the first one stands.
    const messageId = text(input.messageId)
    if (messageId) {
      const earlier = await prisma.supplierReply.findFirst({ where: { tenantId, messageId }, select: { id: true, purchaseOrderId: true, state: true, readingStatus: true } })
      if (earlier) return { status: 200, body: { duplicate: true, replyId: earlier.id, purchaseOrderId: earlier.purchaseOrderId, state: earlier.state, readingStatus: earlier.readingStatus } }
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

    const pasted = await replies.pasteReply(order.id, { text: input.text, ...(input.receivedOn ? { receivedOn: input.receivedOn } : {}) }, { identity: ownerIdentity(tenantId, owner), env }, {
      origin: { source: 'email', sender: input.from, messageId, tokenId },
    })
    const reply = pasted.reply
    // Ids and codes only: the card itself is for the person who records it.
    return { status: 201, body: { duplicate: false, replyId: reply.id, purchaseOrderId: order.id, purchaseOrderNumber: order.number, state: reply.state, readingStatus: reply.readingStatus } }
  }

  async function tokenRecords(tenantId) {
    return prisma.runtimeRecord.findMany({ where: { tenantId, namespace: INTEGRATION_TOKEN_NAMESPACE }, orderBy: { createdAt: 'desc' } })
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
    const records = await tokenRecords(actor.tenantId)
    const [owners, uses, refusal] = await Promise.all([ownersOf(actor.tenantId, records), usesOf(actor.tenantId), workspaceRefusal(actor.tenantId)])
    return { enabled: !refusal, refusal: refusal?.code || null, limit: INTEGRATION_TOKEN_LIMIT, tokens: records.map((record) => publicIntegrationToken(record, owners, uses)) }
  }

  async function createToken(identity, body) {
    const actor = await adminOf(identity)
    const input = parsed(integrationTokenCreateSchema, body)
    const refusal = await workspaceRefusal(actor.tenantId)
    if (refusal) fail(refusal.code, refusal.message || 'This workspace cannot take replies this way.', refusal.status === 401 ? 403 : refusal.status)
    const records = await tokenRecords(actor.tenantId)
    if (records.filter((record) => !record.payload?.revokedAt).length >= INTEGRATION_TOKEN_LIMIT) fail('INTEGRATION_TOKEN_LIMIT', `A workspace may hold ${INTEGRATION_TOKEN_LIMIT} active tokens. Revoke one first.`, 409)
    const ownerUserId = text(input.ownerUserId) || actor.user.id
    const owner = await prisma.user.findFirst({ where: { id: ownerUserId, tenantId: actor.tenantId } })
    if (!owner || owner.status !== 'active') fail('INTEGRATION_TOKEN_OWNER_INACTIVE', 'The token must act for an active member of this workspace.', 422, [{ field: 'ownerUserId', code: 'inactive' }])
    const ownerActor = await resolveActor(prisma, ownerIdentity(actor.tenantId, owner))
    if (!can({ actor: ownerActor, permission: REVISE, tenantId: actor.tenantId })) fail('INTEGRATION_TOKEN_OWNER_CANNOT_REVISE', 'The token must act for a member who may revise purchase orders.', 422, [{ field: 'ownerUserId', code: 'permission' }])
    const made = newIntegrationToken({ tenantId: actor.tenantId, name: input.name, ownerUserId: owner.id, createdById: actor.user.id, now: now() })
    await prisma.$transaction(async (tx) => {
      await tx.runtimeRecord.create({ data: { id: `${INTEGRATION_TOKEN_NAMESPACE}:${made.tokenId}`, tenantId: actor.tenantId, namespace: INTEGRATION_TOKEN_NAMESPACE, recordKey: made.tokenId, payload: made.payload } })
      await tx.auditLog.create({ data: {
        id: `audit-${made.tokenId}-created`, tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_ingest', module: 'settings', action: 'integration_token_created',
        entityType: 'IntegrationToken', entityId: made.tokenId, summary: `Integration token "${made.payload.name}" created for supplier replies.`,
        metadata: { tokenId: made.tokenId, ownerUserId: owner.id, scope: made.payload.scope },
      } })
    })
    const record = { recordKey: made.tokenId, payload: made.payload }
    // The token is in this answer only; FlowChain cannot show it again.
    return { token: publicIntegrationToken(record, new Map([[owner.id, owner]])), secret: made.token }
  }

  async function revokeToken(identity, tokenId) {
    const actor = await adminOf(identity)
    const record = await prisma.runtimeRecord.findUnique({ where: tokenKey(actor.tenantId, text(tokenId)) })
    if (!record) fail('INTEGRATION_TOKEN_NOT_FOUND', 'No such token in this workspace.', 404)
    if (record.payload?.revokedAt) return { token: publicIntegrationToken(record, await ownersOf(actor.tenantId, [record])) }
    const payload = { ...record.payload, revokedAt: now().toISOString(), revokedById: actor.user.id }
    await prisma.$transaction(async (tx) => {
      await tx.runtimeRecord.update({ where: tokenKey(actor.tenantId, record.recordKey), data: { payload } })
      await tx.auditLog.create({ data: {
        id: `audit-${record.recordKey}-revoked`, tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_ingest', module: 'settings', action: 'integration_token_revoked',
        entityType: 'IntegrationToken', entityId: record.recordKey, summary: `Integration token "${payload.name}" revoked.`, metadata: { tokenId: record.recordKey },
      } })
    })
    return { token: publicIntegrationToken({ ...record, payload }, await ownersOf(actor.tenantId, [record])) }
  }

  return { ingest, listTokens, createToken, revokeToken }
}
