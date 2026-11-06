import test from 'node:test'
import assert from 'node:assert/strict'

// The walkthrough seed scripts read their tenant when they load, so it is set
// before they are imported.
const tenantId = 'tenant-ai-report-agreement'
const otherTenantId = 'tenant-ai-report-agreement-other'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { createDatabaseRepositoryRegistry } = await import('../../server/repositories/adapter-registry.mjs')
const { handleReportsAnalyticsRoute } = await import('../../server/routes/reports-analytics.routes.mjs')
const { handleAiRuntimeGatewayRoute } = await import('../../server/routes/ai-runtime-gateway.routes.mjs')
const { buildOpenPurchaseOrdersReport } = await import('../../server/domain/open-purchase-orders-report.mjs')
const { seedLocalDemo } = await import('../../scripts/setup-local-demo.mjs')
const { seedLocalScenario } = await import('../../scripts/setup-local-scenario.mjs')

// The walkthrough scenario pinned to one seed day, and the assistant asked at
// noon New York time on that day.
const AS_OF = '2026-09-29'
const NOW = new Date(`${AS_OF}T16:00:00Z`)
const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId }
const CJK = /[㐀-鿿]/
const CHIPS = [
  ['What should I handle first today?', 'today_priorities'],
  ['Which items have the highest risk?', 'highest_risk_items'],
  ['Which records need more data?', 'records_needing_data'],
  ['Prepare an action draft', 'prepare_action_draft'],
  ['How many open purchase orders do we have?', 'workspace_metrics'],
]
const users = { admin: `${tenantId}-admin`, buyer: `${tenantId}-buyer`, viewer: `${tenantId}-viewer` }
const counted = ['purchaseOrder', 'purchaseOrderLine', 'purchaseRequest', 'rfq', 'receivingDocument', 'receivingLine', 'supplierInvoice', 'inventoryBalance', 'inventoryMovement', 'item', 'supplier', 'salesOrder', 'actionDraft']

async function businessState(prisma) {
  const state = {}
  for (const model of counted) {
    const [count, latest] = await Promise.all([prisma[model].count(), prisma[model].findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }).catch(() => null)])
    state[model] = [count, latest?.updatedAt?.toISOString() || null]
  }
  return state
}

async function routeJson(handler, ctx, method, path, body) {
  let sent
  const handled = await handler({ ...ctx, req: { method, headers: {} }, res: {}, url: new URL(`http://local${path}`), readBody: async () => body, send: (_res, status, payload) => { sent = { status, payload } } })
  assert.equal(handled, true, path)
  return sent
}

test('the assistant states the same open POs, committed spend and at-risk SKUs as the reports', async () => {
  // Run only with scripts/run-postgres-test-files.mjs against its disposable database.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'AI Report Agreement', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', defaultLanguage: 'en-US' } })
    await prisma.tenant.create({ data: { id: otherTenantId, name: 'Other Workspace', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', defaultLanguage: 'en-US' } })
    await prisma.user.createMany({ data: [
      { id: users.admin, tenantId, email: 'agreement-admin@example.com', name: 'Agreement Admin', role: 'admin' },
      { id: users.buyer, tenantId, email: 'agreement-buyer@example.com', name: 'Agreement Buyer', role: 'buyer' },
      { id: users.viewer, tenantId, email: 'agreement-viewer@example.com', name: 'Agreement Viewer', role: 'viewer' },
    ] })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin })
    await seedLocalDemo(prisma, env)
    await seedLocalScenario(prisma, env, { asOf: AS_OF })
    // Another workspace's open, overdue purchase order must never be counted.
    await prisma.supplier.create({ data: { id: 'AGREEMENT-OTHER-SUP', tenantId: otherTenantId, code: 'OTHER', name: 'Other Supplier' } })
    await prisma.purchaseOrder.create({ data: { id: 'AGREEMENT-OTHER-PO', tenantId: otherTenantId, supplierId: 'AGREEMENT-OTHER-SUP', supplierName: 'Other Supplier', status: 'issued', currency: 'USD', amount: 99999, expectedDate: new Date('2026-09-01T12:00:00Z'), lines: { create: [{ id: 'AGREEMENT-OTHER-PO-L1', sku: 'LDM-001', orderedQuantity: 999, receivedQuantity: 0, unit: 'pcs', unitPrice: 100, amount: 99999, metadata: { promisedDate: '2026-09-01' } }] } } })

    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const identity = (role, userId) => ({ authenticated: true, tenantId, userId, role, source: 'local_session' })
    const reportCtx = { repositories, identity: identity('admin', users.admin), dataMode: 'user', env }
    const aiCtx = (role, userId) => ({ repositories, identity: identity(role, userId), dataMode: 'user', env, db: {}, aiSkillPrisma: prisma, aiSkillNow: NOW })

    // The reports, as their routes serve them. The open purchase orders report
    // is the same builder over the same rows its route reads, at the same clock.
    const overview = (await routeJson(handleReportsAnalyticsRoute, reportCtx, 'GET', '/api/reports/overview')).payload
    const finance = (await routeJson(handleReportsAnalyticsRoute, reportCtx, 'GET', '/api/reports/finance')).payload
    const inventory = (await routeJson(handleReportsAnalyticsRoute, reportCtx, 'GET', '/api/reports/inventory')).payload
    const routeReport = (await routeJson(handleReportsAnalyticsRoute, reportCtx, 'GET', '/api/reports/open-purchase-orders')).payload
    const openReport = buildOpenPurchaseOrdersReport(await repositories.procurementRuntime.listForReport({ tenantId }), {}, NOW)
    assert.equal(routeReport.summary.open, openReport.summary.open, 'the open count does not depend on the clock')
    const kpi = (report, id) => report.kpis.find((row) => row.id === id)
    const spend = kpi(overview, 'purchase_order_amount').currencyAmounts.map(({ currencyCode, amount }) => ({ currency: currencyCode, amount }))
    const invoices = kpi(finance, 'invoice_amount').currencyAmounts.map(({ currencyCode, amount }) => ({ currency: currencyCode, amount }))
    const atRisk = inventory.details.filter((row) => row.shortage !== null && row.shortage > 0).map((row) => row.id).sort()
    // The walkthrough has overdue orders, USD spend and a short SKU to show.
    assert.equal(openReport.summary.overdue, 8)
    assert.ok(openReport.summary.open > openReport.summary.overdue)
    assert.deepEqual(spend.map((row) => row.currency), ['USD'])
    assert.ok(spend[0].amount > 0 && invoices[0].amount > 0)
    assert.equal(kpi(overview, 'open_po_count').currentValue, openReport.summary.open)
    assert.equal(kpi(overview, 'inventory_risk_sku').currentValue, atRisk.length)
    assert.ok(atRisk.includes('LDM-001'))

    const before = await businessState(prisma)
    const auditsBefore = await prisma.auditLog.count({ where: { tenantId, action: 'ai_skill_answered' } })
    const answers = {}
    for (const [message, skillId] of CHIPS) {
      const { status, payload } = await routeJson(handleAiRuntimeGatewayRoute, aiCtx('admin', users.admin), 'POST', '/api/ai-runtime/respond', { message, answerLanguage: 'en-US' })
      assert.equal(status, 200, message)
      assert.equal(payload.intent, skillId, message)
      assert.equal(payload.answerSource, 'workspace_rules')
      assert.doesNotMatch(JSON.stringify(payload), CJK, `${message} is English`)
      // Every answer states the report numbers.
      assert.equal(payload.metrics.openPurchaseOrders, openReport.summary.open, `${message} open POs`)
      assert.equal(payload.metrics.overduePurchaseOrders, openReport.summary.overdue, `${message} overdue POs`)
      assert.deepEqual(payload.metrics.committedSpend, spend, `${message} committed spend per currency`)
      assert.deepEqual(payload.metrics.committedInvoices, invoices, `${message} committed invoices per currency`)
      assert.deepEqual(payload.metrics.atRiskSkus, atRisk, `${message} at-risk SKUs`)
      assert.ok(!JSON.stringify(payload).includes('AGREEMENT-OTHER'), `${message} reads only its own workspace`)
      answers[skillId] = payload
    }
    // The chips' Chinese answers carry the same facts.
    const chinese = (await routeJson(handleAiRuntimeGatewayRoute, aiCtx('admin', users.admin), 'POST', '/api/ai-runtime/respond', { message: '今天先处理什么？', answerLanguage: 'zh-CN' })).payload
    assert.match(chinese.conclusion.title, CJK)
    assert.deepEqual(chinese.metrics, answers.today_priorities.metrics)
    assert.deepEqual(chinese.keyEvidence.map((item) => item.entityId), answers.today_priorities.keyEvidence.map((item) => item.entityId))

    // The overdue purchase orders the assistant lists are the report's.
    const reportOverdue = openReport.rows.filter((row) => row.overdueDays > 0).map((row) => row.id)
    const metricsEvidence = answers.workspace_metrics.keyEvidence.map((item) => item.entityId)
    assert.ok(metricsEvidence.length > 0 && metricsEvidence.every((id) => reportOverdue.includes(id)))
    // Drafts are review-only; none is a purchase order draft.
    assert.ok(answers.prepare_action_draft.reviewCards.length > 0)
    for (const card of answers.prepare_action_draft.reviewCards) {
      assert.equal(card.previewOnly, true)
      assert.ok(['po_followup_draft', 'supplier_followup_draft', 'purchase_request_draft'].includes(card.draftType))
    }
    console.log(JSON.stringify({ openPurchaseOrders: openReport.summary.open, overdue: openReport.summary.overdue, spend, invoices, atRisk, today: answers.today_priorities.conclusion, drafts: answers.prepare_action_draft.reviewCards.map((card) => card.title) }))

    // A procurement specialist cannot read invoices: the invoice facts are hidden, not zero.
    const buyer = (await routeJson(handleAiRuntimeGatewayRoute, aiCtx('buyer', users.buyer), 'POST', '/api/ai-runtime/respond', { message: 'What should I handle first today?' })).payload
    assert.equal(buyer.metrics.committedInvoices, null)
    assert.ok(buyer.dataLimitations.some((item) => item.code === 'hidden_by_permission'))
    assert.ok(buyer.keyEvidence.every((item) => item.entityType !== 'supplier_invoice'))
    assert.equal(buyer.metrics.openPurchaseOrders, openReport.summary.open)
    // A read-only viewer sees the counts but no amounts.
    const viewer = (await routeJson(handleAiRuntimeGatewayRoute, aiCtx('viewer', users.viewer), 'POST', '/api/ai-runtime/respond', { message: 'How many open purchase orders do we have?' })).payload
    assert.equal(viewer.metrics.committedSpend, null)
    assert.equal(viewer.metrics.committedInvoices, null)
    assert.equal(viewer.metrics.openPurchaseOrders, openReport.summary.open)
    assert.doesNotMatch(viewer.conclusion.summary, /\$/)

    // Answering wrote no business data, and one audit row per answer with no question text.
    assert.deepEqual(await businessState(prisma), before)
    const audits = await prisma.auditLog.findMany({ where: { tenantId, action: 'ai_skill_answered' }, orderBy: { createdAt: 'asc' } })
    assert.equal(audits.length - auditsBefore, CHIPS.length + 3)
    for (const row of audits) {
      assert.equal(row.source, 'ai_assisted')
      assert.match(row.metadata.metadata.queryHash, /^[0-9a-f]{32}$/)
      assert.doesNotMatch(JSON.stringify(row), /What should I handle|How many open purchase orders|今天先处理/)
    }

    // A purchase order line in another unit is never added to the item's
    // incoming stock: 12 CASE on LDM-002, which is kept in pcs, leaves its
    // available to promise where it was, in the report and in the answer.
    const atpOf = (report) => report.details.find((row) => row.id === 'LDM-002').availableToPromise
    const atpBefore = atpOf(inventory)
    await prisma.purchaseOrder.create({ data: { id: 'AGREEMENT-CASE-PO', tenantId, supplierId: 'LOCAL-DEMO-SUP-001', supplierName: 'Acme Components', status: 'issued', currency: 'USD', amount: 1200, expectedDate: new Date('2026-10-10T12:00:00Z'), lines: { create: [{ id: 'AGREEMENT-CASE-PO-L1', sku: 'LDM-002', itemId: 'LOCAL-DEMO-ITEM-002', orderedQuantity: 12, receivedQuantity: 0, unit: 'CASE', unitPrice: 100, amount: 1200 }] } } })
    const inventoryAfter = (await routeJson(handleReportsAnalyticsRoute, reportCtx, 'GET', '/api/reports/inventory')).payload
    assert.equal(atpOf(inventoryAfter), atpBefore)
    const promise = (await routeJson(handleAiRuntimeGatewayRoute, aiCtx('admin', users.admin), 'POST', '/api/ai-runtime/respond', { message: 'How much LDM-002 can I promise?', answerLanguage: 'en-US' })).payload
    assert.equal(promise.intent, 'inventory_availability')
    assert.equal(promise.figures.find((row) => row.key === 'atp:LDM-002').value, atpBefore)
    // Left out, but never hidden: the report says which SKU has a line in
    // another unit, and the answer names the order and its quantity.
    assert.ok(inventoryAfter.limitations.includes('po_line_unit_mismatch:LDM-002'))
    assert.match(promise.conclusion.summary, /Not counted as incoming because the line is in another unit than the stock: AGREEMENT-CASE-PO \(12 CASE\)\./)
    // Asked for the order, the assistant names the CASE line first and opens nothing.
    const orderAnswer = (await routeJson(handleAiRuntimeGatewayRoute, aiCtx('admin', users.admin), 'POST', '/api/ai-runtime/respond', { message: 'Create a purchase order for LDM-002', answerLanguage: 'en-US' })).payload
    assert.equal(orderAnswer.intent, 'prepare_action_draft')
    assert.match(orderAnswer.conclusion.summary, /^LDM-002 is also on open purchase order lines in another unit, not counted above: AGREEMENT-CASE-PO \(12 CASE\)\./)
    assert.ok(orderAnswer.reviewCards.every((card) => card.autoOpen !== true))
  } finally {
    await prisma.$disconnect()
  }
})
