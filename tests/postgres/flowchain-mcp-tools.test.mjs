import test from 'node:test'
import assert from 'node:assert/strict'

// Every tool the local MCP prototype offers (docs/mcp-prototype.md), run on
// the seeded walkthrough in a real database through the MCP session: the
// read-only views of the repositories and of Prisma, the token check and the
// workspace's AI switch, with every model path off. Each tool answers, and
// nothing but the audit rows is written.

const tenantId = 'tenant-mcp-tools'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { seedLocalDemo } = await import('../fixtures/workspace/master-data.mjs')
const { seedLocalScenario } = await import('../fixtures/workspace/scenario.mjs')
const { createAssistantV2RateLimiter } = await import('../../server/domain/ai-assistant-v2-controls.mjs')
const { MCP_TOOL_ALLOWLIST, createFlowchainMcpServer } = await import('../../server/mcp/flowchain-mcp-server.mjs')
const { createMcpSession, createMcpToken, mcpTokenHash } = await import('../../server/mcp/flowchain-mcp-session.mjs')

const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId }
// The walkthrough's records, for the tools that need an argument.
const ARGS = {
  get_purchase_order: { order: 'PO-020' },
  search_records: { query: 'Acme' },
  price_history: { sku: 'TST-001' },
  item_suppliers: { sku: 'TST-001' },
  search_documents: { query: 'escalation of a late supplier' },
  order_quantity_costs: { sku: 'TST-001', quantities: [50, 100] },
  stock_projection: { sku: 'TST-001', weeks: 4 },
  stock_movements: { sku: 'TST-001' },
  decision_history: { record: 'PO-020' },
  record_history: { record: 'PO-020' },
  late_order_impact: { orders: ['PO-020'] },
  calculate: { operation: 'days_between', dates: ['2026-09-29', '2026-10-13'] },
}
const counted = ['purchaseOrder', 'purchaseOrderLine', 'purchaseRequest', 'rfq', 'receivingDocument', 'supplierInvoice', 'inventoryBalance', 'inventoryMovement', 'item', 'supplier', 'salesOrder', 'actionDraft', 'runtimeRecord']

test('every MCP tool answers on the seeded walkthrough through the read-only session, writing only its audit rows', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'MCP Tools', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', defaultLanguage: 'en-US', operationalSettings: { ai: { modelAssistEnabled: true } } } })
    await prisma.user.create({ data: { id: `${tenantId}-admin`, tenantId, email: 'mcp-tools-admin@example.com', name: 'MCP Tools admin', role: 'admin' } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-admin` })
    await seedLocalDemo(prisma, env)
    await seedLocalScenario(prisma, env, { asOf: '2026-09-29' })
    const user = await prisma.user.findFirst({ where: { id: `${tenantId}-admin` }, select: { id: true, tenantId: true, role: true, status: true, email: true } })
    const token = await createMcpToken(prisma, { user })
    const state = async () => Object.fromEntries(await Promise.all(counted.map(async (model) => [model, await prisma[model].count()])))
    const before = await state()
    const audited = await prisma.auditLog.count()

    // The script's session, with a limit and a size cap that let every tool
    // run once and show its whole result here.
    const failed = []
    const session = createMcpSession({ prisma, env, user, tokenSha256: mcpTokenHash(token) })
    const server = createFlowchainMcpServer({ session, limiter: createAssistantV2RateLimiter({ limits: { questions: 1000, windowMs: 60_000 } }), maxResultChars: 10_000_000, log: (line) => failed.push(line) })
    const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.ok(listed.result, `${JSON.stringify(listed)} ${failed.join(' ')}`)
    const tools = listed.result.tools.map((tool) => tool.name)
    assert.deepEqual(tools.sort(), [...MCP_TOOL_ALLOWLIST].sort(), 'an administrator on the walkthrough is offered the whole allowlist')
    let id = 1
    for (const name of tools) {
      const reply = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: ARGS[name] || {} } })
      const body = JSON.parse(reply.result.content[0].text)
      if (reply.result.isError) failed.push(`${name}: ${body.error} ${JSON.stringify(body.details || '')}`)
    }
    assert.deepEqual(failed, [], failed.join('\n'))

    // Nothing written but one audit row for the list and one per call.
    assert.deepEqual(await state(), before)
    assert.equal(await prisma.auditLog.count(), audited + 1 + tools.length)
  } finally {
    await prisma.$disconnect()
  }
})
