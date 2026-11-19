// PROTOTYPE: who the local MCP server acts as, and the context its tools read
// with (docs/mcp-prototype.md). Not an API-token system: one provisioned
// user on this machine, named by FLOWCHAIN_MCP_ACTOR, proven by a token whose
// hash sits in a file outside the repository (~/.flowchain/mcp-token.json by
// default). The token is checked once, when the client starts the server;
// the server never passes it on to anything (MCP: no token passthrough).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertLocalDevelopment } from '../domain/local-development-contract.mjs'
import { loadAiSkillContext } from '../domain/ai-skill-context.mjs'
import { readAiSkillFacts } from '../domain/ai-skill-readers.mjs'
import { createDatabaseRepositoryRegistry } from '../repositories/adapter-registry.mjs'

const text = (value) => String(value ?? '').trim()
const sha256 = (value) => createHash('sha256').update(String(value)).digest()

// Local development only: never under a production profile, and only where
// the repository's own local-development switch is on.
export function assertMcpLocal(env = process.env) {
  if (text(env.NODE_ENV).toLowerCase() === 'production' || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === 'production') {
    throw new Error('The FlowChain MCP prototype runs only on a local development machine, never in production.')
  }
  assertLocalDevelopment(env, 'FlowChain MCP prototype')
}

export const mcpTokenPath = (env = process.env) => text(env.FLOWCHAIN_MCP_TOKEN_FILE) || join(homedir(), '.flowchain', 'mcp-token.json')

// A new token for one email: the file keeps its hash only. The token itself
// is returned once, to be put in the MCP client's local configuration.
export function createMcpToken({ email, path }) {
  const actor = text(email).toLowerCase()
  if (!actor.includes('@')) throw new Error('Name the user by email: --actor=you@example.com')
  const token = randomBytes(32).toString('base64url')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ email: actor, tokenSha256: sha256(token).toString('hex'), createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  return token
}

export function checkMcpToken({ email, token, path }) {
  if (!text(token) || !existsSync(path)) return false
  let stored
  try {
    stored = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  if (text(stored?.email).toLowerCase() !== text(email).toLowerCase()) return false
  const expected = Buffer.from(text(stored?.tokenSha256), 'hex')
  const given = sha256(text(token))
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// The provisioned, active user the server acts as. With several workspaces
// holding the email, FLOWCHAIN_DEFAULT_TENANT_ID picks one.
export async function resolveMcpUser(prisma, { email, tenantId = '' }) {
  const users = await prisma.user.findMany({ where: { email: text(email).toLowerCase(), ...(text(tenantId) ? { tenantId: text(tenantId) } : {}) }, select: { id: true, tenantId: true, role: true, status: true, email: true } })
  if (!users.length) throw Object.assign(new Error('No provisioned user has that email in this workspace.'), { code: 'MCP_ACTOR_NOT_PROVISIONED' })
  if (users.length > 1) throw Object.assign(new Error('Several workspaces have that email: set FLOWCHAIN_DEFAULT_TENANT_ID.'), { code: 'MCP_ACTOR_AMBIGUOUS' })
  if (users[0].status !== 'active') throw Object.assign(new Error('That user is disabled.'), { code: 'MCP_ACTOR_DISABLED' })
  return users[0]
}

// session() for createFlowchainMcpServer: the same context and facts the
// assistant reads for this user in the web app (loadAiSkillContext checks the
// user is provisioned and resolves their role, permissions and warehouses;
// readAiSkillFacts reads only what they may see), read afresh for each call.
export function createMcpSession({ prisma, env = process.env, user }) {
  return async () => {
    const identity = { authenticated: true, tenantId: user.tenantId, userId: user.id, role: user.role, source: 'mcp_local' }
    const routeContext = { identity, env, aiSkillPrisma: prisma, repositories: createDatabaseRepositoryRegistry({ env, prisma }) }
    const context = await loadAiSkillContext(routeContext)
    const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
    return { context, facts, routeContext }
  }
}
