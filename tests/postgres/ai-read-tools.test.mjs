import test from 'node:test'
import assert from 'node:assert/strict'

// The model-first read tools (docs/ai-model-first-design.md §4) on the seeded
// walkthrough in a real database: every tool answers for an administrator,
// the service tools read their services, and each role gets only what it may
// read. Nothing is written.

const tenantId = 'tenant-ai-read-tools'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { createDatabaseRepositoryRegistry } = await import('../../server/repositories/adapter-registry.mjs')
const { loadAiSkillContext } = await import('../../server/domain/ai-skill-context.mjs')
const { readAiSkillFacts } = await import('../../server/domain/ai-skill-readers.mjs')
const { aiReadToolsFor, aiReadToolRefs, runAiReadTool } = await import('../../server/domain/ai-read-tool-runner.mjs')
const { seedLocalDemo } = await import('../../scripts/setup-local-demo.mjs')
const { seedLocalScenario } = await import('../../scripts/setup-local-scenario.mjs')
const { createKnowledgeService } = await import('../../server/domain/ai-knowledge-service.mjs')
const { parseKnowledgeFile } = await import('../../server/domain/ai-knowledge-file-parser.mjs')
const { readFileSync } = await import('node:fs')

const AS_OF = '2026-09-29'
const NOW = new Date(`${AS_OF}T16:00:00Z`)
const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ENABLE_CONTRACTS: 'true' }
// Each user's stored role (the legacy role the authorization backfill maps).
const users = { admin: 'admin', viewer: 'viewer', finance: 'finance-specialist' }
const counted = ['purchaseOrder', 'purchaseOrderLine', 'purchaseRequest', 'rfq', 'receivingDocument', 'supplierInvoice', 'inventoryBalance', 'item', 'supplier', 'salesOrder', 'contract', 'actionDraft']

// The arguments each tool is asked with: the walkthrough's records.
const ARGS = {
  get_purchase_order: { order: 'PO-020' },
  stock_projection: { sku: 'LDM-001', weeks: 4 },
  late_order_impact: { orders: ['PO-020'] },
  calculate: { operation: 'days_between', dates: ['2026-09-29', '2026-10-13'] },
  search_records: { query: 'Acme' },
  price_history: { sku: 'LDM-001' },
  search_documents: { query: 'escalation of a late supplier' },
}
// The assistant evaluation's three fictional documents (tests/ai-eval/knowledge).
const DOCUMENTS = ['product-guide.md', 'purchasing-policy.md', 'invoice-policy.md']

test('the read tools answer from the seeded workspace, each role reading only what it may', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'AI Read Tools', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', defaultLanguage: 'en-US' } })
    await prisma.user.createMany({ data: Object.entries(users).map(([key, role]) => ({ id: `${tenantId}-${key}`, tenantId, email: `read-tools-${key}@example.com`, name: `Read Tools ${key}`, role })) })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-admin` })
    await seedLocalDemo(prisma, env)
    await seedLocalScenario(prisma, env, { asOf: AS_OF })
    const knowledge = createKnowledgeService(prisma, { env })
    const knowledgeAdmin = { tenantId, userId: `${tenantId}-admin`, permissionCodes: new Set(['settings.workspace.manage']) }
    for (const file of DOCUMENTS) {
      const extracted = await parseKnowledgeFile({ fileName: file, contentBase64: readFileSync(new URL(`../ai-eval/knowledge/documents/${file}`, import.meta.url)).toString('base64') })
      await knowledge.add(knowledgeAdmin, { title: extracted.title, content: extracted.content })
    }
    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const contextFor = async (key) => {
      const ctx = { repositories, identity: { authenticated: true, tenantId, userId: `${tenantId}-${key}`, role: users[key], source: 'local_session' }, dataMode: 'user', env, db: {}, aiSkillPrisma: prisma, aiSkillNow: NOW }
      const context = await loadAiSkillContext(ctx)
      return { context, facts: await readAiSkillFacts(context) }
    }
    const state = async () => Object.fromEntries(await Promise.all(counted.map(async (model) => [model, await prisma[model].count()])))
    const before = await state()

    // The administrator: every tool, every one answers.
    const admin = await contextFor('admin')
    const offered = aiReadToolsFor(admin.facts, admin.context).map((tool) => tool.name)
    for (const name of ['search_records', 'reorder_list', 'list_receivables', 'list_contracts', 'price_history', 'stock_projection', 'supplier_risks', 'search_documents']) assert.ok(offered.includes(name), `${name} is offered`)
    const results = {}
    for (const name of offered) {
      const output = await runAiReadTool(name, ARGS[name] || {}, admin)
      assert.equal(output.ok, true, `${name}: ${output.error || ''} ${JSON.stringify(output.details || '')}`)
      results[name] = output.result
    }
    assert.equal(results.get_purchase_order.order.orderNumber.endsWith('PO-020'), true)
    // "PO-20", as typed, is the walkthrough's zero-padded PO-020.
    assert.equal((await runAiReadTool('get_purchase_order', { order: 'PO-20' }, admin)).result?.order.orderNumber.endsWith('PO-020'), true)
    assert.ok(results.search_records.rows.some((row) => row.type === 'supplier' && /Acme/.test(row.name)))
    assert.ok(results.list_contracts.rows.length >= 1, 'the walkthrough has contracts')
    // A contract's title, dates and terms (the walkthrough's record no value);
    // its terms are held by code and read from the workspace's terms.
    assert.equal(results.list_contracts.pricesHidden, false)
    assert.ok(results.list_contracts.rows.every((row) => row.title && row.startDate && 'totalValue' in row && row.ref.type === 'contract'))
    const termed = results.list_contracts.rows.filter((row) => row.paymentTerms)
    assert.ok(termed.length >= 1 && termed.every((row) => row.paymentTerms.name === 'Net 30' && row.paymentTerms.days === 30), JSON.stringify(termed.map((row) => row.paymentTerms)))
    // The Supplier risks page's issues, counted per supplier: PO-020 is late.
    assert.equal(results.supplier_risks.suppliers.reduce((sum, row) => sum + row.issues, 0), results.supplier_risks.total)
    const precision = await runAiReadTool('supplier_risks', { supplier: 'Precision Fastener Works', type: 'po_overdue' }, admin)
    assert.ok(precision.result.rows.some((row) => /PO-020$/.test(row.record) && row.ref.type === 'purchase_order'), JSON.stringify(precision))
    assert.ok(results.price_history.latest?.unitPrice, 'an administrator sees the latest price')
    assert.ok(results.reorder_list.rows.every((row) => row.sku && row.ref.type === 'item'))
    assert.ok(results.reorder_list.summary, 'the reorder list summary is read')
    assert.ok((await runAiReadTool('list_contracts', { state: 'notice_due' }, admin)).result.rows.every((row) => row.state === 'notice_due'))
    assert.equal(results.stock_projection.weeks.length, 4)
    assert.deepEqual(results.calculate, { result: 14, unit: 'days' })
    // The purchasing policy's escalation section, found in English; a Chinese
    // search over English documents is sent back to search in English.
    assert.ok(results.search_documents.documents >= DOCUMENTS.length, 'the walkthrough has its own documents too')
    assert.deepEqual(results.search_documents.documentLanguages, ['en-US'])
    assert.ok(results.search_documents.passages.some((row) => /purchasing/i.test(row.document) && /escalation/i.test(row.section) && row.ref.type === 'document'), JSON.stringify(results.search_documents.passages.map((row) => [row.document, row.section])))
    const chinese = await runAiReadTool('search_documents', { query: '紧急采购怎么规定' }, admin)
    assert.equal(chinese.error, 'query_language')
    assert.match(chinese.details[0], /en-US/)
    // PO-020 buys LDM-004, which no open sales order needs.
    assert.ok(results.late_order_impact.skus.every((row) => row.sku !== 'LDM-001'))
    assert.ok(aiReadToolRefs(results.list_purchase_orders).length > 0)

    // A viewer reads the same records without prices or amounts.
    const viewer = await contextFor('viewer')
    const viewerPrices = await runAiReadTool('price_history', ARGS.price_history, viewer)
    assert.equal(viewerPrices.ok, true)
    assert.equal(viewerPrices.result.pricesHidden, true)
    assert.equal(viewerPrices.result.latest?.unitPrice ?? null, null)
    const viewerOrders = await runAiReadTool('list_purchase_orders', { status: 'all' }, viewer)
    assert.ok(viewerOrders.result.rows.every((row) => row.amount === null))
    const viewerContracts = await runAiReadTool('list_contracts', {}, viewer)
    assert.equal(viewerContracts.result.pricesHidden, true)
    assert.ok(viewerContracts.result.rows.every((row) => row.totalValue === null))

    // Finance reads invoices and receivables, not purchase orders or stock.
    const finance = await contextFor('finance')
    const financeTools = aiReadToolsFor(finance.facts, finance.context).map((tool) => tool.name)
    for (const name of ['list_purchase_orders', 'price_history', 'reorder_list', 'stock_projection', 'late_order_impact']) assert.ok(!financeTools.includes(name), `finance is not offered ${name}`)
    assert.ok(financeTools.includes('list_receivables'))
    const financeOutputs = []
    for (const name of financeTools) financeOutputs.push(await runAiReadTool(name, ARGS[name] || {}, finance))
    assert.ok(financeOutputs.every((output) => output.ok), JSON.stringify(financeOutputs.filter((output) => !output.ok)))
    assert.doesNotMatch(JSON.stringify(financeOutputs), /LOCAL-[A-Z]+-PO-\d+/, 'no purchase order number reaches finance')

    // No tool returns a contact's email address, and nothing was written.
    for (const output of [results, viewerPrices, viewerOrders, viewerContracts, financeOutputs]) assert.doesNotMatch(JSON.stringify(output), /@/)
    assert.deepEqual(await state(), before)
  } finally {
    await prisma.$disconnect()
  }
})
