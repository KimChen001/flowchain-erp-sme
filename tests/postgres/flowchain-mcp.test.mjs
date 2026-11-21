import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { revokeMcpToken } from '../../server/mcp/flowchain-mcp-session.mjs'

// The local MCP prototype end to end (docs/mcp-prototype.md): the real script
// over stdio against the database, as one provisioned user proven by a token
// whose hash the database keeps. It lists that user's read tools, returns only
// their workspace's records, audits each list and call, and refuses a wrong or
// revoked token, a workspace with AI switched off, a user who signed out
// meanwhile, and production.
const root = resolve(import.meta.dirname, '..', '..')
const tenantA = 'mcp-proto-a'
const tenantB = 'mcp-proto-b'

async function seedTenant(prisma, tenantId, tag, { aiOn }) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}`, ...(aiOn ? { operationalSettings: { ai: { modelAssistEnabled: true } } } : {}) } })
  await prisma.user.create({ data: { id: `${tenantId}-manager`, tenantId, email: `mcp-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Supplier ${tag}` } })
  await prisma.purchaseOrder.create({ data: {
    id: `PO-MCP-${tag}`, tenantId, supplierId: `SUP-${tag}`, supplierName: `Supplier ${tag}`, status: 'issued', currency: 'USD', amount: '100.0000',
    expectedDate: new Date(Date.now() + 5 * 86_400_000), issuedAt: new Date(),
    lines: { create: [{ id: `PO-MCP-${tag}-L1`, sku: `SKU-${tag}`, itemName: `Item ${tag}`, orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA' }] },
  } })
  // The user's roles, as their first sign-in sets them.
  await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-manager` })
}

// The script with the given environment and arguments; send() writes one
// message, next() waits for the reply with that id, done() closes stdin and
// waits for exit.
const children = new Set()
function startServer(env, args = []) {
  const child = spawn(process.execPath, ['scripts/flowchain-mcp.mjs', ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  child.once('exit', () => children.delete(child))
  const replies = new Map()
  const waiting = new Map()
  let buffer = ''
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    stdout += text
    buffer += text
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim() || !line.startsWith('{')) continue
      const message = JSON.parse(line)
      if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) } else replies.set(message.id, message)
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    sendLine: (line) => child.stdin.write(`${line}\n`),
    next: (id) => {
      if (!replies.has(id)) return new Promise((resolveReply) => waiting.set(id, resolveReply))
      const reply = replies.get(id)
      replies.delete(id)
      return Promise.resolve(reply)
    },
    done: async () => { child.stdin.end(); return { code: await exited, stdout, stderr } },
    stderr: () => stderr,
  }
}

const body = (reply) => JSON.parse(reply.result.content[0].text)

test('the MCP prototype serves one user\'s read tools over stdio, audited, and refuses what no longer stands', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(process.env)
  try {
    await seedTenant(prisma, tenantA, 'A', { aiOn: true })
    await seedTenant(prisma, tenantB, 'B', { aiOn: false })
    const base = { ...process.env, FLOWCHAIN_PUBLIC_BASE_URL: 'http://127.0.0.1:15201' }
    const envA = { ...base, FLOWCHAIN_MCP_ACTOR: 'mcp-a@example.com', FLOWCHAIN_DEFAULT_TENANT_ID: tenantA }

    // The token is made by the script, printed once, and only its hash kept.
    const created = await startServer(envA, ['--create-token', '--actor=mcp-a@example.com']).done()
    assert.equal(created.code, 0, created.stderr)
    const token = created.stdout.trim()
    assert.match(token, /^fcm_/)
    const record = await prisma.runtimeRecord.findFirst({ where: { tenantId: tenantA, namespace: 'mcp_access_token' } })
    assert.ok(record && !JSON.stringify(record).includes(token), 'the database keeps the hash, not the token')

    const env = { ...envA, FLOWCHAIN_MCP_TOKEN: token }
    const mcp = startServer(env)
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pg-test', version: '1' } } })
    const init = await mcp.next(1)
    assert.equal(init.result.serverInfo.name, 'flowchain-local', mcp.stderr())
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const list = await mcp.next(2)
    assert.ok(list.result, `${JSON.stringify(list)} ${mcp.stderr()}`)
    const names = list.result.tools.map((tool) => tool.name)
    assert.ok(names.includes('list_purchase_orders'), names.join(', '))
    mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_purchase_orders', arguments: { status: 'all' } } })
    const call = await mcp.next(3)
    assert.equal(call.result.isError, false, `${JSON.stringify(call)} ${mcp.stderr()}`)
    assert.equal(call.result.structuredContent, undefined, 'the data once, as text')
    const text = call.result.content[0].text
    assert.ok(text.includes('PO-MCP-A'), 'its own workspace\'s order')
    assert.ok(!text.includes('PO-MCP-B'), 'never another workspace\'s')
    assert.ok(body(call).links.some((ref) => ref.link === 'http://127.0.0.1:15201/app/procurement/orders/PO-MCP-A'))
    // A malformed line, or a batch, gets an error and the server goes on.
    mcp.sendLine('not json')
    assert.equal((await mcp.next(null)).error.code, -32700)
    mcp.sendLine(JSON.stringify([{ jsonrpc: '2.0', id: 9, method: 'ping' }]))
    assert.match((await mcp.next(null)).error.message, /Batches are not supported/)
    mcp.send({ jsonrpc: '2.0', id: 4, method: 'ping' })
    assert.deepEqual((await mcp.next(4)).result, {})

    // Signing out of FlowChain ends the token, at the next call.
    await prisma.workspaceSession.create({ data: { id: 'WS-MCP-A', tenantId: tenantA, userId: `${tenantA}-manager`, sessionIdHash: 'mcp-test-session', expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date(Date.now() + 1000), revokedReason: 'signed_out' } })
    mcp.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_purchase_orders', arguments: { status: 'all' } } })
    const after = await mcp.next(5)
    assert.deepEqual([after.result.isError, body(after).error], [true, 'MCP_SIGNED_OUT'])
    assert.ok(!after.result.content[0].text.includes('PO-MCP-A'))
    const { code } = await mcp.done()
    assert.equal(code, 0)

    // Each list and call left a codes-only row in its own workspace; the
    // audit repository keeps the entry's metadata under metadata.metadata.
    const rows = await prisma.auditLog.findMany({ where: { tenantId: tenantA, action: { in: ['ai_mcp_tool_called', 'ai_mcp_tools_listed'] } }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(rows.map((row) => [row.action, row.metadata.metadata.outcome]), [['ai_mcp_tools_listed', 'ok'], ['ai_mcp_tool_called', 'ok'], ['ai_mcp_tool_called', 'MCP_SIGNED_OUT']])
    const recorded = rows[1].metadata.metadata
    assert.deepEqual([rows[1].tenantId, rows[1].actorId, recorded.channel, recorded.argumentKeys], [tenantA, `${tenantA}-manager`, 'mcp', ['status']])
    assert.ok(!JSON.stringify(rows).includes('"all"'), 'no argument value in the rows')

    // A wrong token, a revoked one, a workspace with AI off, production: the
    // server does not start.
    const fresh = (await startServer(envA, ['--create-token', '--actor=mcp-a@example.com']).done()).stdout.trim()
    const wrong = await startServer({ ...envA, FLOWCHAIN_MCP_TOKEN: `${fresh}x` }).done()
    assert.deepEqual([wrong.code, /token_mismatch/.test(wrong.stderr)], [1, true], wrong.stderr)
    await revokeMcpToken(prisma, { user: { id: `${tenantA}-manager`, tenantId: tenantA } })
    const revoked = await startServer({ ...envA, FLOWCHAIN_MCP_TOKEN: fresh }).done()
    assert.deepEqual([revoked.code, /token_revoked/.test(revoked.stderr)], [1, true], revoked.stderr)
    const envB = { ...base, FLOWCHAIN_MCP_ACTOR: 'mcp-b@example.com', FLOWCHAIN_DEFAULT_TENANT_ID: tenantB }
    const tokenB = (await startServer(envB, ['--create-token', '--actor=mcp-b@example.com']).done()).stdout.trim()
    const aiOff = await startServer({ ...envB, FLOWCHAIN_MCP_TOKEN: tokenB }).done()
    assert.deepEqual([aiOff.code, /AI features switched off/.test(aiOff.stderr)], [1, true], aiOff.stderr)
    const production = await startServer({ ...env, NODE_ENV: 'production' }).done()
    assert.deepEqual([production.code, /never in production/.test(production.stderr)], [1, true], production.stderr)
  } finally {
    // A failed assertion leaves no server running.
    for (const child of children) child.kill()
    await prisma.$disconnect()
  }
})
