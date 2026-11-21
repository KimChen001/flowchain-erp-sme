// Workspace integration tokens for supplier reply ingestion
// (docs/supplier-reply-ingest-api.md). A token lets a forwarder (a mail rule,
// Zapier, Power Automate) hand a supplier's reply to FlowChain without a
// person pasting it. It does one thing: POST /api/integrations/supplier-replies.
//
// - The token reads `fcsr.<workspace>.<token id>.<secret>`. Only a SHA-256
//   hash of the secret is stored, with its last four characters as a hint;
//   the whole token is shown once, when it is created.
// - Tokens live in runtime records (namespace below), so no table is added.
// - A token acts for the admin who made it, who must be able to revise
//   purchase orders; every check of the paste path runs as that member. It
//   stops working when it expires, is revoked, or that member is disabled or
//   changes role (as the local MCP token, #391, does).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const INTEGRATION_TOKEN_NAMESPACE = 'integration.supplier-reply-token'
// When each token was last used, in its own record, so that noting a use
// never writes over a revocation made at the same moment.
export const INTEGRATION_TOKEN_USE_NAMESPACE = 'integration.supplier-reply-token-use'
// One record per handed-over message (its Message-ID hashed): created before
// the reading, so a retry finds it instead of paying for a second reading.
export const INTEGRATION_MESSAGE_NAMESPACE = 'integration.supplier-reply-message'
export const INTEGRATION_TOKEN_PREFIX = 'fcsr'
// Active tokens a workspace may hold at once.
export const INTEGRATION_TOKEN_LIMIT = 5
export const INTEGRATION_TOKEN_NAME_LIMIT = 80
// Days a token lasts: 90 unless the admin chooses 1 to 365.
export const INTEGRATION_TOKEN_DAYS = Object.freeze({ default: 90, max: 365 })

const text = (value) => String(value ?? '').trim()
const SECRET = /^[A-Za-z0-9_-]{43}$/
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DAY_MS = 24 * 60 * 60 * 1000

export const hashIntegrationSecret = (secret) => createHash('sha256').update(String(secret), 'utf8').digest('hex')
export const integrationMessageKey = (messageId) => createHash('sha256').update(String(messageId), 'utf8').digest('hex')

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
export function newIntegrationToken({ tenantId, name, owner, createdById, days = INTEGRATION_TOKEN_DAYS.default, now = new Date(), idFactory = randomUUID, secretFactory = () => randomBytes(32).toString('base64url') }) {
  const tokenId = idFactory()
  const secret = secretFactory()
  if (!ID.test(tokenId) || !SECRET.test(secret)) throw new Error('An integration token needs a UUID and a 32-byte secret.')
  const payload = {
    version: 1,
    scope: 'supplier_replies.ingest',
    name: text(name).slice(0, INTEGRATION_TOKEN_NAME_LIMIT),
    hash: hashIntegrationSecret(secret),
    hint: secret.slice(-4),
    ownerUserId: owner.id,
    // The owner's role when the token was made: a change ends the token.
    ownerRole: text(owner.role).toLowerCase(),
    createdById,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
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

export const integrationTokenExpired = (payload, now = new Date()) => !payload?.expiresAt || Date.parse(payload.expiresAt) <= now.getTime()

// What an admin sees of a token: never the hash.
export function publicIntegrationToken(record, { owners = new Map(), uses = new Map(), now = new Date() } = {}) {
  const payload = record?.payload || {}
  const owner = owners.get(payload.ownerUserId)
  const expired = integrationTokenExpired(payload, now)
  return {
    id: record.recordKey,
    name: payload.name || '',
    hint: payload.hint || '',
    scope: payload.scope || 'supplier_replies.ingest',
    owner: { id: payload.ownerUserId || null, name: owner?.name || owner?.email || null },
    createdAt: payload.createdAt || null,
    createdById: payload.createdById || null,
    expiresAt: payload.expiresAt || null,
    lastUsedAt: uses.get(record.recordKey) || null,
    revokedAt: payload.revokedAt || null,
    active: !payload.revokedAt && !expired,
  }
}

// Public mailbox providers. A sender on one of them matches a supplier only
// by the whole address, never by the domain: anyone can open an account
// there. A domain counts when it is one of these, or a provider's name
// followed by a country or generic ending (yahoo.co.uk, gmx.de, yandex.ru).
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'msn.com', 'me.com', 'mac.com', 'aim.com', 'ymail.com', 'rocketmail.com', 'pm.me', 'tuta.io',
  'web.de', 't-online.de', 'freenet.de', 'libero.it', 'virgilio.it', 'laposte.net', 'orange.fr', 'free.fr', 'wanadoo.fr', 'sfr.fr',
  'btinternet.com', 'sky.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'optonline.net', 'earthlink.net',
  'inbox.ru', 'list.ru', 'bk.ru', 'rambler.ru', 'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com', 'fastmail.com', 'hey.com', 'tutanota.com',
  'qq.com', 'vip.qq.com', 'foxmail.com', '163.com', 'vip.163.com', '126.com', 'yeah.net', '139.com', '189.cn', 'wo.cn', 'sina.com', 'sina.cn', 'sohu.com', 'tom.com', '21cn.com', 'aliyun.com',
])
const PUBLIC_MAIL_BRANDS = new Set(['yahoo', 'hotmail', 'outlook', 'live', 'gmx', 'yandex', 'ya', 'zoho', 'zohomail', 'proton', 'protonmail', 'aol', 'icloud', 'mail', 'email', 'inbox'])
export function publicMailDomain(domain) {
  const name = text(domain).toLowerCase()
  if (PUBLIC_MAIL_DOMAINS.has(name)) return true
  const [brand, ...ending] = name.split('.')
  // The ending is a country or generic one: one or two short labels (com, de, co.uk, com.br).
  return PUBLIC_MAIL_BRANDS.has(brand) && ending.length >= 1 && ending.length <= 2 && ending.every((label) => /^[a-z]{2,3}$/.test(label))
}

const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const ADDR_SPEC = new RegExp(`^${ATOM}(?:\\.${ATOM})*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$`)

// The one address a From value names, lower case, or null when it does not
// name exactly one plain address. Read as RFC 5322 has it: quoted display
// names and comments are skipped (they may contain anything, angle brackets
// included); then either one angle address `<…>` with nothing after it, or
// a bare address. Several mailboxes, groups, quoted local parts and
// unbalanced quotes, comments or brackets give null, so they are never on record.
export function senderAddress(value) {
  const raw = String(value ?? '')
  if (!raw.trim() || raw.length > 998) return null
  let outside = ''
  let depth = 0
  let quoted = false
  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at]
    if (quoted || depth > 0) {
      if (char === '\\') { at += 1; continue }
      if (quoted && char === '"') quoted = false
      else if (!quoted && char === '(') depth += 1
      else if (!quoted && char === ')') depth -= 1
      continue
    }
    if (char === '"') { quoted = true; outside += ' '; continue }
    if (char === '(') { depth = 1; outside += ' '; continue }
    if (char === ')') return null
    outside += char
  }
  if (quoted || depth > 0) return null
  const angles = [...outside.matchAll(/<([^<>]*)>/g)]
  if (angles.length > 1) return null
  let spec
  if (angles.length === 1) {
    const [whole, inner] = angles[0]
    const before = outside.slice(0, angles[0].index)
    const after = outside.slice(angles[0].index + whole.length)
    // Only a display name before it (no brackets or separators), nothing after it.
    if (after.trim() || /[<>@,;:]/.test(before)) return null
    spec = inner.trim()
  } else {
    if (/[<>]/.test(outside)) return null
    spec = outside.trim()
  }
  return ADDR_SPEC.test(spec) ? spec.toLowerCase() : null
}

// Whether a reply's sender is the supplier's email on record: the same
// address, or the same company domain (never a public mailbox domain).
// False when either is missing or is not one plain address
// (docs/supplier-reply-dates-design.md §4.11: "sender not on record").
export function senderOnRecord(sender, supplierEmail) {
  const from = senderAddress(sender)
  const onRecord = senderAddress(supplierEmail)
  if (!from || !onRecord) return false
  if (from === onRecord) return true
  const domain = from.split('@')[1]
  return domain === onRecord.split('@')[1] && !publicMailDomain(domain)
}
