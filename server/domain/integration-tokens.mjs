// Workspace integration tokens for supplier reply ingestion
// (docs/supplier-reply-ingest-api.md). A token lets a forwarder (a mail rule,
// Zapier, Power Automate) hand a supplier's reply to FlowChain without a
// person pasting it. It does one thing: POST /api/integrations/supplier-replies.
//
// - The token reads `fcsr.<workspace>.<token id>.<secret>`. Only a SHA-256
//   hash of the secret is stored, with its last four characters as a hint;
//   the whole token is shown once, when it is created.
// - Tokens live in runtime records (namespace below), so no table is added.
// - A token acts for its owner, an active member who may revise purchase
//   orders; every check of the paste path runs as that member.
// - Revoking is immediate; a revoked token is never accepted again.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const INTEGRATION_TOKEN_NAMESPACE = 'integration.supplier-reply-token'
// When each token was last used, in its own record, so that noting a use
// never writes over a revocation made at the same moment.
export const INTEGRATION_TOKEN_USE_NAMESPACE = 'integration.supplier-reply-token-use'
export const INTEGRATION_TOKEN_PREFIX = 'fcsr'
// Active tokens a workspace may hold at once.
export const INTEGRATION_TOKEN_LIMIT = 5
export const INTEGRATION_TOKEN_NAME_LIMIT = 80

const text = (value) => String(value ?? '').trim()
const SECRET = /^[A-Za-z0-9_-]{43}$/
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const hashIntegrationSecret = (secret) => createHash('sha256').update(String(secret), 'utf8').digest('hex')

export function formatIntegrationToken({ tenantId, tokenId, secret }) {
  return [INTEGRATION_TOKEN_PREFIX, Buffer.from(String(tenantId), 'utf8').toString('base64url'), tokenId, secret].join('.')
}

// The parts of a presented token, or null when it is not one.
export function parseIntegrationToken(value) {
  const parts = text(value).replace(/^Bearer\s+/i, '').split('.')
  if (parts.length !== 4 || parts[0] !== INTEGRATION_TOKEN_PREFIX) return null
  const [, workspace, tokenId, secret] = parts
  if (!ID.test(tokenId) || !SECRET.test(secret) || !/^[A-Za-z0-9_-]{1,200}$/.test(workspace)) return null
  const tenantId = Buffer.from(workspace, 'base64url').toString('utf8')
  if (!tenantId || Buffer.from(tenantId, 'utf8').toString('base64url') !== workspace) return null
  return { tenantId, tokenId, secret }
}

// A new token: the record to store (no secret in it) and the token to show once.
export function newIntegrationToken({ tenantId, name, ownerUserId, createdById, now = new Date(), idFactory = randomUUID, secretFactory = () => randomBytes(32).toString('base64url') }) {
  const tokenId = idFactory()
  const secret = secretFactory()
  if (!ID.test(tokenId) || !SECRET.test(secret)) throw new Error('An integration token needs a UUID and a 32-byte secret.')
  const payload = {
    version: 1,
    scope: 'supplier_replies.ingest',
    name: text(name).slice(0, INTEGRATION_TOKEN_NAME_LIMIT),
    hash: hashIntegrationSecret(secret),
    hint: secret.slice(-4),
    ownerUserId,
    createdById,
    createdAt: now.toISOString(),
    revokedAt: null,
    revokedById: null,
  }
  return { tokenId, payload, token: formatIntegrationToken({ tenantId, tokenId, secret }) }
}

// Whether a presented secret matches the stored hash, in constant time.
export function integrationSecretMatches(payload, secret) {
  const stored = Buffer.from(text(payload?.hash), 'hex')
  const presented = Buffer.from(hashIntegrationSecret(secret), 'hex')
  return stored.length === 32 && presented.length === 32 && timingSafeEqual(stored, presented)
}

// What an admin sees of a token: never the hash.
export function publicIntegrationToken(record, owners = new Map(), uses = new Map()) {
  const payload = record?.payload || {}
  const owner = owners.get(payload.ownerUserId)
  return {
    id: record.recordKey,
    name: payload.name || '',
    hint: payload.hint || '',
    scope: payload.scope || 'supplier_replies.ingest',
    owner: { id: payload.ownerUserId || null, name: owner?.name || owner?.email || null },
    createdAt: payload.createdAt || null,
    createdById: payload.createdById || null,
    lastUsedAt: uses.get(record.recordKey) || null,
    revokedAt: payload.revokedAt || null,
    active: !payload.revokedAt,
  }
}

// A fixed-window count per workspace, in this server process: at most
// `limit` ingested replies in any `windowMs`. A multi-process deployment
// would keep the count in the database instead.
export function createIngestRateLimiter({ limit = 60, windowMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const seen = new Map()
  return {
    take(tenantId) {
      const at = now()
      const recent = (seen.get(tenantId) || []).filter((time) => at - time < windowMs)
      if (recent.length >= limit) {
        seen.set(tenantId, recent)
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - at) / 1000)) }
      }
      recent.push(at)
      seen.set(tenantId, recent)
      return { ok: true, remaining: limit - recent.length }
    },
  }
}
