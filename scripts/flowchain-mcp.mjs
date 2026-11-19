#!/usr/bin/env node
// PROTOTYPE: FlowChain's read tools as a local MCP server over stdio
// (docs/mcp-prototype.md). An MCP client on this machine (Claude Desktop)
// starts it; it acts as one provisioned, active user, read-only.
//
//   node scripts/flowchain-mcp.mjs --create-token --actor=you@example.com
//       a new token for that user (replacing any earlier one; its hash is
//       kept in the workspace's database, valid 30 days), printed once for
//       the client's configuration
//   node scripts/flowchain-mcp.mjs --revoke-token --actor=you@example.com
//   node scripts/flowchain-mcp.mjs
//       serves MCP on stdin/stdout as FLOWCHAIN_MCP_ACTOR, proven by
//       FLOWCHAIN_MCP_TOKEN
//
// Every form needs local development: NODE_ENV=development,
// FLOWCHAIN_DEV_LOCAL=true and a DATABASE_URL on this machine. Also
// FLOWCHAIN_DEFAULT_TENANT_ID when the email is in several workspaces, and
// FLOWCHAIN_PUBLIC_BASE_URL for record links. It refuses production, a
// workspace with its AI features switched off, and a token that no longer
// stands for its user. stdout carries protocol messages only.
import { createInterface } from 'node:readline'
import { createFlowchainMcpServer } from '../server/mcp/flowchain-mcp-server.mjs'
import { assertMcpLocal, checkMcpToken, createMcpSession, createMcpToken, mcpTokenHash, resolveMcpUser, revokeMcpToken, workspaceAiOn } from '../server/mcp/flowchain-mcp-session.mjs'

// Nothing but protocol messages on stdout.
console.log = (...values) => console.error(...values)
console.info = (...values) => console.error(...values)

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')).map(([key, ...value]) => [key, value.join('=') || true]))
const env = process.env
// The token, once read, leaves the environment: nothing started from here
// inherits it.
const token = String(env.FLOWCHAIN_MCP_TOKEN || '').trim()
delete process.env.FLOWCHAIN_MCP_TOKEN

let prisma = null
let disconnect = async () => {}
const fail = async (message) => {
  console.error(`[flowchain-mcp] ${message}`)
  await disconnect().catch(() => {})
  process.exit(1)
}

try {
  assertMcpLocal(env)
} catch (error) {
  await fail(error.message)
}
const persistence = await import('../server/persistence/prisma-client.mjs')
prisma = await persistence.getPrismaClient(env)
disconnect = () => persistence.disconnectPrismaClient()

const email = String(args['create-token'] || args['revoke-token'] ? args.actor || '' : env.FLOWCHAIN_MCP_ACTOR || '').trim()
let user
try {
  user = await resolveMcpUser(prisma, { email, tenantId: env.FLOWCHAIN_DEFAULT_TENANT_ID })
} catch (error) {
  await fail(error.message)
}

if (args['create-token']) {
  const created = await createMcpToken(prisma, { user })
  process.stdout.write(`${created}\n`)
  console.error(`[flowchain-mcp] A token for ${user.email}, valid 30 days, is printed above; its hash is kept in the workspace's database. Put it in your MCP client's local config as FLOWCHAIN_MCP_TOKEN; it is not shown again.`)
  await disconnect()
  process.exit(0)
}
if (args['revoke-token']) {
  const revoked = await revokeMcpToken(prisma, { user })
  console.error(`[flowchain-mcp] ${revoked ? `The token of ${user.email} is revoked.` : `${user.email} has no token.`}`)
  await disconnect()
  process.exit(0)
}

if (!token) await fail('Set FLOWCHAIN_MCP_TOKEN to the token --create-token printed.')
const tokenSha256 = mcpTokenHash(token)
const standing = await checkMcpToken(prisma, { user, tokenSha256 })
if (!standing.ok) await fail(`FLOWCHAIN_MCP_TOKEN does not stand for ${user.email} (${standing.reason}); create a new one with --create-token.`)
if (!(await workspaceAiOn(prisma, user.tenantId))) await fail('This workspace has its AI features switched off (Settings): an MCP client is an outside model, so the workspace is not served.')

const server = createFlowchainMcpServer({ session: createMcpSession({ prisma, env, user, tokenSha256 }), baseUrl: env.FLOWCHAIN_PUBLIC_BASE_URL || '', log: (line) => console.error(line) })
console.error(`[flowchain-mcp] Serving read-only FlowChain tools as ${user.email} (workspace ${user.tenantId}).`)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pending = Promise.resolve()
lines.on('line', (line) => {
  if (!line.trim()) return
  // One message at a time, in order; each call is bounded by its timeout.
  pending = pending.then(async () => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } })}\n`)
      return
    }
    // A batch is not taken (the revisions offered have none).
    if (Array.isArray(message)) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported.' } })}\n`)
      return
    }
    const response = await server.handle(message)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  })
})
lines.on('close', () => {
  pending.finally(() => disconnect().finally(() => process.exit(0)))
})
