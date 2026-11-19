import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createMcpToken } from '../../server/mcp/flowchain-mcp-session.mjs'

// The local MCP prototype end to end (docs/mcp-prototype.md): the real script
// over stdio against the database, as one provisioned user proven by a local
// token. It lists that user's read tools, returns only their workspace's
// records, writes a codes-only audit row per call, and refuses a wrong token
// and production.
const root = resolve(import.meta.dirname, '..', '..')
const tenantA = 'mcp-proto-a'
const tenantB = 'mcp-proto-b'

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}` } })
  await prisma.user.create({ data: { id: `${tenantId}-manager`, tenantId, email: `mcp-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Supplier ${tag}` } })
  await prisma.purchaseOrder.create({ data: {
    id: `PO-MCP-${tag}`, tenantId, supplierId: `SUP-${tag}`, supplierName: `Supplier ${tag}`, status: 'issued', currency: 'USD', amount: '100.0000',
    expectedDate: new Date(Date.now() + 5 * 86_400_000), issuedAt: new Date(),
    lines: { create: [{ id: `PO-MCP-${tag}-L1`, sku: `SKU-${tag}`, itemName: `Item ${tag}`, orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA' }] },
  } })
}

// The script with the given environment; send() writes one message, next()
// waits for the reply with that id, done() closes stdin and waits for exit.
function startServer(env) {
  const child = spawn(process.execPath, ['scripts/flowchain-mcp.mjs'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const replies = new Map()
  const waiting = new Map()
  let buffer = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) } else replies.set(message.id, message)
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    sendLine: (line) => child.stdin.write(`${line}\n`),
    next: (id) => (replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise((resolveReply) => waiting.set(id, resolveReply))),
    done: async () => { child.stdin.end(); return { code: await exited, stderr } },
    exited,
    stderr: () => stderr,
  }
}

test('the MCP prototype serves one user\'s read tools over stdio, audited, and refuses a wrong token and production', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(process.env)
  const dir = mkdtempSync(join(tmpdir(), 'flowchain-mcp-pg-'))
  try {
    await seedTenant(prisma, tenantA, 'A')
    await seedTenant(prisma, tenantB, 'B')
    const tokenFile = join(dir, 'mcp-token.json')
    const token = createMcpToken({ email: 'mcp-a@example.com', path: tokenFile })
    const env = { ...process.env, FLOWCHAIN_DEV_LOCAL: 'true', NODE_ENV: 'test', FLOWCHAIN_MCP_ACTOR: 'mcp-a@example.com', FLOWCHAIN_MCP_TOKEN: token, FLOWCHAIN_MCP_TOKEN_FILE: tokenFile, FLOWCHAIN_DEFAULT_TENANT_ID: tenantA, FLOWCHAIN_PUBLIC_BASE_URL: 'http://127.0.0.1:15201' }

    const mcp = startServer(env)
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pg-test', version: '1' } } })
    const init = await mcp.next(1)
    assert.equal(init.result.serverInfo.name, 'flowchain-local', mcp.stderr())
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = (await mcp.next(2)).result.tools.map((tool) => tool.name)
    assert.ok(names.includes('list_purchase_orders'), names.join(', '))
    mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_purchase_orders', arguments: { status: 'all' } } })
    const call = (await mcp.next(3)).result
    assert.equal(call.isError, false, JSON.stringify(call))
    const text = call.content[0].text
    assert.ok(text.includes('PO-MCP-A'), 'its own workspace\'s order')
    assert.ok(!text.includes('PO-MCP-B'), 'never another workspace\'s')
    assert.ok(call.structuredContent.links.some((ref) => ref.link === 'http://127.0.0.1:15201/app/procurement/orders/PO-MCP-A'))
    // A malformed line gets a parse error and the server goes on.
    mcp.sendLine('not json')
    assert.equal((await mcp.next(null)).error.code, -32700)
    mcp.send({ jsonrpc: '2.0', id: 4, method: 'ping' })
    assert.deepEqual((await mcp.next(4)).result, {})
    const { code } = await mcp.done()
    assert.equal(code, 0)

    // One codes-only audit row for the call, in its own workspace.
    const rows = await prisma.auditLog.findMany({ where: { action: 'ai_mcp_tool_called' } })
    assert.equal(rows.length, 1)
    // The audit repository keeps the entry's metadata under metadata.metadata.
    const recorded = rows[0].metadata.metadata
    assert.deepEqual([rows[0].tenantId, rows[0].actorId, recorded.channel, recorded.outcome, recorded.argumentKeys], [tenantA, `${tenantA}-manager`, 'mcp', 'ok', ['status']])
    assert.ok(!JSON.stringify(rows[0]).includes('"all"'), 'no argument value in the row')

    // A wrong token, or production, and the server does not start.
    const wrong = startServer({ ...env, FLOWCHAIN_MCP_TOKEN: `${token}x` })
    const refused = await wrong.done()
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /does not match the token/)
    const production = await startServer({ ...env, NODE_ENV: 'production' }).done()
    assert.equal(production.code, 1)
    assert.match(production.stderr, /never in production/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await disconnectPrismaClient()
  }
})
