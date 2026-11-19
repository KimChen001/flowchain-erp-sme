#!/usr/bin/env node
// PROTOTYPE: FlowChain's read tools as a local MCP server over stdio
// (docs/mcp-prototype.md). An MCP client on this machine (Claude Desktop)
// starts it; it acts as one provisioned user, read-only.
//
//   node scripts/flowchain-mcp.mjs --create-token --actor=you@example.com
//       writes the token's hash to ~/.flowchain/mcp-token.json (or
//       FLOWCHAIN_MCP_TOKEN_FILE) and prints the token once, for the client's
//       configuration
//   node scripts/flowchain-mcp.mjs
//       serves MCP on stdin/stdout. Needs DATABASE_URL (local), local
//       development on (FLOWCHAIN_DEV_LOCAL=true), FLOWCHAIN_MCP_ACTOR and
//       FLOWCHAIN_MCP_TOKEN; FLOWCHAIN_DEFAULT_TENANT_ID when the email is in
//       several workspaces; FLOWCHAIN_PUBLIC_BASE_URL for record links.
//
// Refuses to start under NODE_ENV=production. stdout carries protocol
// messages only; everything else goes to stderr.
import { createInterface } from 'node:readline'
import { createFlowchainMcpServer } from '../server/mcp/flowchain-mcp-server.mjs'
import { assertMcpLocal, checkMcpToken, createMcpSession, createMcpToken, mcpTokenPath, resolveMcpUser } from '../server/mcp/flowchain-mcp-session.mjs'

// Nothing but protocol messages on stdout.
console.log = (...values) => console.error(...values)
console.info = (...values) => console.error(...values)
const fail = (message) => {
  console.error(`[flowchain-mcp] ${message}`)
  process.exit(1)
}

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')).map(([key, ...value]) => [key, value.join('=') || true]))
const env = process.env
try {
  assertMcpLocal(env)
} catch (error) {
  fail(error.message)
}

if (args['create-token']) {
  try {
    const token = createMcpToken({ email: args.actor, path: mcpTokenPath(env) })
    process.stdout.write(`${token}\n`)
    console.error(`[flowchain-mcp] Token for ${String(args.actor).toLowerCase()} saved as a hash in ${mcpTokenPath(env)}. Put the line above in your MCP client's local config as FLOWCHAIN_MCP_TOKEN; it is not shown again.`)
    process.exit(0)
  } catch (error) {
    fail(error.message)
  }
}

const email = String(env.FLOWCHAIN_MCP_ACTOR || '').trim()
if (!email) fail('Set FLOWCHAIN_MCP_ACTOR to the email of the user the server acts as.')
if (!checkMcpToken({ email, token: env.FLOWCHAIN_MCP_TOKEN, path: mcpTokenPath(env) })) fail('FLOWCHAIN_MCP_TOKEN does not match the token saved for FLOWCHAIN_MCP_ACTOR (create one with --create-token).')

const { getPrismaClient, disconnectPrismaClient } = await import('../server/persistence/prisma-client.mjs')
const prisma = await getPrismaClient(env)
let user
try {
  user = await resolveMcpUser(prisma, { email, tenantId: env.FLOWCHAIN_DEFAULT_TENANT_ID })
} catch (error) {
  await disconnectPrismaClient()
  fail(error.message)
}
const server = createFlowchainMcpServer({ session: createMcpSession({ prisma, env, user }), baseUrl: env.FLOWCHAIN_PUBLIC_BASE_URL || '', log: (line) => console.error(line) })
console.error(`[flowchain-mcp] Serving read-only FlowChain tools as ${email} (workspace ${user.tenantId}).`)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pending = Promise.resolve()
lines.on('line', (line) => {
  if (!line.trim()) return
  // One message at a time, in order.
  pending = pending.then(async () => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } })}\n`)
      return
    }
    const response = await server.handle(message)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  })
})
lines.on('close', () => {
  pending.finally(() => disconnectPrismaClient().finally(() => process.exit(0)))
})
