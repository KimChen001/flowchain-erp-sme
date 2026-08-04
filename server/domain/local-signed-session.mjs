import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
const sign = (value, secret) => createHmac('sha256', secret).update(value).digest('base64url')

export function createLocalSessionSecret(env = process.env) {
  const configured = String(env.FLOWCHAIN_LOCAL_SESSION_SECRET || '')
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production' && !configured) {
    const error = new Error('FLOWCHAIN_LOCAL_SESSION_SECRET is required in production.')
    error.code = 'FLOWCHAIN_LOCAL_SESSION_SECRET_REQUIRED'
    error.status = 500
    throw error
  }
  return configured || randomBytes(32).toString('base64url')
}

export function issueLocalSessionToken(session, secret, { ttlSeconds = 8 * 60 * 60, now = Date.now() } = {}) {
  const payload = encode({ sid: session.sessionId, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds })
  return `${payload}.${sign(payload, secret)}`
}

export function verifyLocalSessionToken(token, secret, { now = Date.now() } = {}) {
  try {
    const [payload, signature, extra] = String(token || '').split('.')
    if (!payload || !signature || extra) return { valid: false, reason: 'malformed_token' }
    const expected = sign(payload, secret)
    const left = Buffer.from(signature); const right = Buffer.from(expected)
    if (left.length !== right.length || !timingSafeEqual(left, right)) return { valid: false, reason: 'invalid_signature' }
    const claims = decode(payload)
    if (!claims.sid || !Number.isFinite(claims.exp)) return { valid: false, reason: 'invalid_claims' }
    if (claims.exp <= Math.floor(now / 1000)) return { valid: false, reason: 'expired_token', claims }
    return { valid: true, claims }
  } catch { return { valid: false, reason: 'malformed_token' } }
}

const normalizedRole = value => {
  const role = String(value || '').toLowerCase()
  if (['finance-specialist', 'business-specialist'].includes(role)) return role
  if (/admin|管理员/.test(role)) return 'admin'
  if (/manager|经理|approver/.test(role)) return 'manager'
  if (/buyer|采购员/.test(role)) return 'buyer'
  if (/viewer|只读/.test(role)) return 'viewer'
  return 'business-specialist'
}

export function resolveServerTenantId(env = process.env) {
  return String(env.FLOWCHAIN_DEFAULT_TENANT_ID || '').trim()
}

export function resolveRequestIdentity(req, sessions, secret, env = process.env) {
  const authorization = String(req.headers?.authorization || '')
  const token = authorization.replace(/^Bearer\s+/i, '').trim()
  const verified = verifyLocalSessionToken(token, secret)
  if (verified.valid) {
    const session = sessions.get(verified.claims.sid)
    if (session && session.expiresAt > Date.now()) return { authenticated: true, source: 'local_signed_session', userId: session.userId, name: session.name, email: session.email, role: session.role, tenantId: session.tenantId, sessionId: session.sessionId, expiresAt: new Date(session.expiresAt).toISOString() }
  }
  const allowHeaders = env.NODE_ENV === 'test' || String(env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS).toLowerCase() === 'true'
  if (allowHeaders && (req.headers?.['x-flowchain-user'] || req.headers?.['x-flowchain-role'])) return { authenticated: true, source: 'explicit_test_headers', userId: String(req.headers['x-flowchain-user'] || 'test-user'), name: 'Test User', email: '', role: normalizedRole(req.headers['x-flowchain-role']), tenantId: resolveServerTenantId(env) }
  return { authenticated: false, source: token ? 'invalid_session' : 'anonymous', userId: 'anonymous', name: 'Anonymous', email: '', role: 'viewer', tenantId: '' }
}

export function createLocalSession(profile, { ttlSeconds = 8 * 60 * 60, now = Date.now(), env = process.env, authoritativeRole = false } = {}) {
  const normalizedEmail = String(profile.email || '').trim().toLowerCase()
  const userId = String(profile.id || `USR-${createHash('sha256').update(normalizedEmail || String(profile.name || '')).digest('hex').slice(0, 16)}`)
  return { sessionId: randomBytes(18).toString('base64url'), userId, tenantId: String(profile.tenantId || resolveServerTenantId(env)), name: profile.name, email: normalizedEmail, company: profile.company, role: authoritativeRole ? normalizedRole(profile.role) : 'manager', userVersion: profile.version ?? null, createdAt: new Date(now).toISOString(), expiresAt: now + ttlSeconds * 1000 }
}
