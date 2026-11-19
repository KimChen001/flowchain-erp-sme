// PROTOTYPE: who the local MCP server acts as, and the context its tools read
// with (docs/mcp-prototype.md). Not an API-token system: one provisioned,
// active user on this machine, named by FLOWCHAIN_MCP_ACTOR and proven by a
// token whose hash is kept in the workspace's database (RuntimeRecord,
// namespace mcp_access_token), so it can be revoked. A token ends when
//   - it is revoked (--revoke-token) or 30 days old;
//   - the user is disabled, or their role changed since it was made;
//   - the user's roles were never set (FlowChain would set them on the
//     user's first sign-in, a write this read-only server does not make);
//   - any of the user's FlowChain sessions is ended after it was made
//     (signing out, or an administrator ending their sessions).
// The server never passes the token on (MCP: no token passthrough).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { assertLocalDevelopment } from '../domain/local-development-contract.mjs'
import { loadAiSkillContext } from '../domain/ai-skill-context.mjs'
import { readAiSkillFacts } from '../domain/ai-skill-readers.mjs'
import { modelFreeEnv, readAiWorkspaceAccess } from '../domain/ai-workspace-access.mjs'
import { createDatabaseRepositoryRegistry } from '../repositories/adapter-registry.mjs'

const text = (value) => String(value ?? '').trim()
export const mcpTokenHash = (token) => createHash('sha256').update(text(token)).digest('hex')
const coded = (code, message) => Object.assign(new Error(message), { code })

export const MCP_TOKEN_NAMESPACE = 'mcp_access_token'
export const MCP_TOKEN_DAYS = 30

// Local development only: never under a production profile, and only where
// the repository's own local-development switch is on.
export function assertMcpLocal(env = process.env) {
  if (text(env.NODE_ENV).toLowerCase() === 'production' || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === 'production') {
    throw new Error('The FlowChain MCP prototype runs only on a local development machine, never in production.')
  }
  assertLocalDevelopment(env, 'FlowChain MCP prototype')
}

// The provisioned, active user the server acts as. With several workspaces
// holding the email, FLOWCHAIN_DEFAULT_TENANT_ID picks one.
export async function resolveMcpUser(prisma, { email, tenantId = '' }) {
  const address = text(email).toLowerCase()
  if (!address.includes('@')) throw coded('MCP_ACTOR_REQUIRED', 'Name the user by email: you@example.com.')
  const users = await prisma.user.findMany({ where: { email: address, ...(text(tenantId) ? { tenantId: text(tenantId) } : {}) }, select: { id: true, tenantId: true, role: true, status: true, email: true } })
  if (!users.length) throw coded('MCP_ACTOR_NOT_PROVISIONED', 'No provisioned user has that email in this workspace.')
  if (users.length > 1) throw coded('MCP_ACTOR_AMBIGUOUS', 'Several workspaces have that email: set FLOWCHAIN_DEFAULT_TENANT_ID.')
  if (users[0].status !== 'active') throw coded('MCP_ACTOR_DISABLED', 'That user is disabled.')
  return users[0]
}

// The user's standing now: active, their role, and whether their roles were
// ever set (authorization-service.mjs grants the legacy role's template on a
// first sign-in otherwise).
const userStanding = (prisma, user) => prisma.user.findFirst({ where: { id: user?.id, tenantId: user?.tenantId }, select: { status: true, role: true, rolesAssignedAt: true, _count: { select: { roleAssignments: true } } } })
const rolesSet = (standing) => Boolean(standing?.rolesAssignedAt || standing?._count?.roleAssignments)

const tokenRecord = (prisma, user) => prisma.runtimeRecord.findUnique({ where: { tenantId_namespace_recordKey: { tenantId: user.tenantId, namespace: MCP_TOKEN_NAMESPACE, recordKey: user.id } } })

// A new token for an active, provisioned user, replacing any earlier one. The
// database keeps its hash; the token is returned once, for the MCP client's
// local configuration.
export async function createMcpToken(prisma, { user, now = new Date() }) {
  const standing = await userStanding(prisma, user)
  if (standing?.status !== 'active') throw coded('MCP_ACTOR_DISABLED', 'That user is disabled.')
  if (!rolesSet(standing)) throw coded('MCP_ROLES_NOT_SET', "That user's roles were never set: sign in to FlowChain once, or have an administrator set them, then create the token.")
  const token = `fcm_${randomBytes(32).toString('base64url')}`
  const payload = { userId: user.id, role: text(standing.role).toLowerCase(), tokenSha256: mcpTokenHash(token), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + MCP_TOKEN_DAYS * 86_400_000).toISOString(), revokedAt: null }
  await prisma.runtimeRecord.upsert({
    where: { tenantId_namespace_recordKey: { tenantId: user.tenantId, namespace: MCP_TOKEN_NAMESPACE, recordKey: user.id } },
    create: { id: `MCP-TOKEN-${user.tenantId}-${user.id}`, tenantId: user.tenantId, namespace: MCP_TOKEN_NAMESPACE, recordKey: user.id, payload },
    update: { payload },
  })
  return token
}

export async function revokeMcpToken(prisma, { user, now = new Date() }) {
  const record = await tokenRecord(prisma, user)
  if (!record) return false
  await prisma.runtimeRecord.update({ where: { id: record.id }, data: { payload: { ...record.payload, revokedAt: now.toISOString() } } })
  return true
}

// Whether the token (by its hash) still stands for the user: { ok, reason }.
export async function checkMcpToken(prisma, { user, tokenSha256, now = new Date() }) {
  const record = await tokenRecord(prisma, user)
  const stored = record?.payload || null
  if (!stored?.tokenSha256) return { ok: false, reason: 'no_token' }
  const expected = Buffer.from(text(stored.tokenSha256), 'hex')
  const given = Buffer.from(text(tokenSha256), 'hex')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'token_mismatch' }
  if (stored.revokedAt) return { ok: false, reason: 'token_revoked' }
  if (!(Date.parse(stored.expiresAt) > now.getTime())) return { ok: false, reason: 'token_expired' }
  const current = await userStanding(prisma, user)
  if (current?.status !== 'active') return { ok: false, reason: 'user_disabled' }
  if (text(current.role).toLowerCase() !== text(stored.role)) return { ok: false, reason: 'role_changed' }
  if (!rolesSet(current)) return { ok: false, reason: 'roles_not_set' }
  const ended = await prisma.workspaceSession.findFirst({ where: { tenantId: user.tenantId, userId: user.id, revokedAt: { gt: new Date(stored.createdAt) } }, select: { id: true } })
  if (ended) return { ok: false, reason: 'signed_out' }
  return { ok: true }
}

// Whether the workspace has switched its AI features on (Settings, the same
// switch the web assistant's model needs): an MCP client is an outside model
// reading the workspace's data, so a workspace with AI off is not served.
// Read where the web assistant reads it (ai-workspace-access.mjs).
export async function workspaceAiOn(prisma, tenantId) {
  return (await readAiWorkspaceAccess({ prisma, tenantId })).enabled === true
}

// Read-only views of what the tools are handed (design: no writes). Only the
// repositories the read tools read from are passed (not the procurement
// commands, purchase requests, imports or chat history), and a method named
// for a write throws, the audit log's insert aside. Underneath, the Prisma
// client keeps only its reads (and the audit log's create), inside a
// transaction too, so a write by any other name fails there. A write throws
// MCP_READ_ONLY. A database role with read rights and the audit insert only
// is the real guarantee (docs/mcp-prototype.md).
export const MCP_READ_REPOSITORIES = Object.freeze(['masterData', 'inventoryRead', 'inventoryRuntime', 'procurementRead', 'procurementRuntime', 'purchaseOrderDocuments', 'salesOrders', 'auditLog'])
const WRITE_METHOD = /^(create|update|upsert|delete|remove|set|review|transition|submit|approve|issue|cancel|close|reject|return|revise|record|retire|resolve|complete|commit|post|send|save|apply|import|archive|restore|write|mark|assign|add|clear|transact)/
const PRISMA_READS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'])
const readOnlyError = (what) => coded('MCP_READ_ONLY', `The MCP session is read-only: ${what} is not allowed.`)
export function readOnlyRepositories(registry = {}) {
  const wrap = (name, repository) => new Proxy(repository, {
    get(target, key) {
      const value = target[key]
      if (typeof value !== 'function') return value
      if ((name === 'auditLog' && key === 'recordAuditEntry') || (typeof key === 'string' && !WRITE_METHOD.test(key))) return value.bind(target)
      return () => { throw readOnlyError(`${name}.${String(key)}`) }
    },
  })
  const passed = Object.entries(registry).filter(([name, value]) => MCP_READ_REPOSITORIES.includes(name) || !(value && typeof value === 'object'))
  return Object.fromEntries(passed.map(([name, value]) => [name, value && typeof value === 'object' ? wrap(name, value) : value]))
}
export function readOnlyPrisma(client) {
  const delegate = (model, target) => new Proxy(target, {
    get(inner, key) {
      const value = inner[key]
      if (typeof value !== 'function') return value
      if (PRISMA_READS.has(key) || (model === 'auditLog' && key === 'create')) return value.bind(inner)
      return () => { throw readOnlyError(`${model}.${String(key)}`) }
    },
  })
  return new Proxy(client, {
    get(target, key) {
      const value = target[key]
      if (key === '$transaction') return (work, options) => (typeof work === 'function' ? value.call(target, (tx) => work(readOnlyPrisma(tx)), options) : Promise.reject(readOnlyError('$transaction([...])')))
      if (key === '$executeRaw' || key === '$executeRawUnsafe' || key === '$runCommandRaw') return () => { throw readOnlyError(String(key)) }
      if (typeof key === 'string' && !key.startsWith('$') && value && typeof value === 'object') return delegate(key, value)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// The session for createFlowchainMcpServer: the user's identity and the
// read-only repositories (for the audit row too) are fixed; load() checks
// the token and the workspace's AI switch, then reads the same context and
// facts the web assistant reads for this user, afresh, with every model path
// off (modelFreeEnv): no tool here calls a model.
export function createMcpSession({ prisma, env = process.env, user, tokenSha256, now = () => new Date() }) {
  const { FLOWCHAIN_MCP_TOKEN: _token, ...rest } = env
  const safeEnv = modelFreeEnv(rest)
  const reader = readOnlyPrisma(prisma)
  const identity = { authenticated: true, tenantId: user.tenantId, userId: user.id, role: user.role, source: 'mcp_local' }
  const routeContext = { identity, env: safeEnv, aiSkillPrisma: reader, repositories: readOnlyRepositories(createDatabaseRepositoryRegistry({ env: safeEnv, prisma: reader })) }
  return {
    actorKey: `${user.tenantId}:${user.id}`,
    routeContext,
    async load() {
      const token = await checkMcpToken(prisma, { user, tokenSha256, now: now() })
      if (!token.ok) throw coded(`MCP_${token.reason.toUpperCase()}`, `The MCP token no longer stands for this user (${token.reason}).`)
      if (!(await workspaceAiOn(prisma, user.tenantId))) throw coded('MCP_AI_ACCESS_OFF', 'This workspace has its AI features switched off.')
      const scoped = { ...routeContext }
      const context = await loadAiSkillContext(scoped)
      const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
      // The tools of one call read the facts' business context, once, as the
      // web assistant's do (design audit L5-15).
      if (facts.businessContext) scoped.aiSkillBusinessContext = facts.businessContext
      return { context, facts, routeContext: scoped }
    },
  }
}
