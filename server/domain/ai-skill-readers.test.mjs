import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_SKILL_TENANT, aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { readBusinessContext } from '../services/runtime-business-read-service.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'

async function factsFor(options) {
  const scenario = aiSkillScenario(options)
  const context = await loadAiSkillContext(scenario.ctx)
  return { scenario, context, facts: await readAiSkillFacts(context) }
}

test('skill facts are the report numbers for the same rows', async () => {
  const { scenario, facts } = await factsFor()
  // The same reads and builders the report routes use.
  const business = await readBusinessContext(scenario.ctx)
  const openReport = buildOpenPurchaseOrdersReport(await scenario.ctx.repositories.procurementRuntime.listForReport({ tenantId: AI_SKILL_TENANT }), {}, scenario.ctx.aiSkillNow)
  const overview = buildRuntimeGovernedReport(business, { subject: 'overview' })
  const finance = buildRuntimeGovernedReport(business, { subject: 'finance' })
  const inventoryReport = buildRuntimeGovernedReport(business, { subject: 'inventory' })
  const kpi = (report, id) => report.kpis.find((row) => row.id === id)

  assert.equal(facts.purchaseOrders.open, openReport.summary.open)
  assert.equal(facts.purchaseOrders.overdue, openReport.summary.overdue)
  assert.deepEqual([facts.purchaseOrders.open, facts.purchaseOrders.overdue], [4, 2])
  assert.equal(facts.purchaseOrders.open, kpi(overview, 'open_po_count').currentValue)
  assert.deepEqual(facts.purchaseOrders.rows.map((row) => row.id).sort(), ['PO-001', 'PO-002', 'PO-008', 'PO-009'])
  // Committed spend per currency, never added across currencies.
  assert.deepEqual(facts.purchaseOrders.committedSpend.amounts.map(({ currency, amount }) => ({ currency, amount })), kpi(overview, 'purchase_order_amount').currencyAmounts.map(({ currencyCode, amount }) => ({ currency: currencyCode, amount })))
  assert.deepEqual(facts.purchaseOrders.committedSpend.amounts.map(({ currency, amount }) => [currency, amount]), [['EUR', 500], ['USD', 17920]])
  assert.equal(facts.purchaseOrders.committedSpend.status, 'multi_currency_unconverted')
  assert.equal(facts.purchaseOrders.committedSpend.total, null)
  assert.deepEqual(facts.invoices.committed.amounts.map(({ currency, amount }) => [currency, amount]), kpi(finance, 'invoice_amount').currencyAmounts.map(({ currencyCode, amount }) => [currencyCode, amount]))
  assert.deepEqual(facts.invoices.committed.amounts.map(({ currency, amount }) => [currency, amount]), [['USD', 7381.5]])
  // At-risk SKUs: the inventory risk KPI's definition, and the inventory report's rows.
  assert.deepEqual(facts.inventory.atRisk, ['LDM-001'])
  assert.equal(facts.inventory.atRiskCount, kpi(overview, 'inventory_risk_sku').currentValue)
  assert.deepEqual(facts.inventory.atRisk, inventoryReport.details.filter((row) => row.shortage > 0).map((row) => row.id))
  const ldm1 = facts.inventory.rows.find((row) => row.sku === 'LDM-001')
  assert.deepEqual([ldm1.available, ldm1.openSalesDemand, ldm1.shortage, ldm1.incomingApprovedPo, ldm1.stockStatus], [28, 35, 7, 70, 'below_safety_stock'])

  assert.deepEqual(facts.invoices.variances.map((row) => [row.id, row.variance, row.currency]), [['INV-001', 200, 'USD']])
  assert.deepEqual(facts.purchaseRequests.awaitingApproval.map((row) => [row.id, row.priority]), [['PR-001', 'high']])
  // Responses come from participations, not the RFQ row counter; an awarded RFQ is not ready.
  assert.deepEqual(facts.rfqs.readyToAward.map((row) => [row.id, row.responses]), [['RFQ-001', 2]])
  assert.deepEqual(facts.receipts.rejected.map((row) => [row.id, row.rejected]), [['GRN-002', 2]])
  assert.deepEqual(facts.receipts.unposted.map((row) => row.id), ['GRN-002'])
  assert.deepEqual(facts.records.map((row) => [row.entityType, row.entityId, row.missing]), [
    ['item', 'ITEM-009', ['unit', 'preferred_supplier', 'stock_threshold']],
    ['purchase_request', 'PR-002', ['required_date', 'lines']],
  ])
  assert.equal(facts.asOf, '2026-09-29')
  assert.equal(facts.generatedAt, '2026-09-29T12:00:00.000Z')
  assert.deepEqual(facts.limitations, [])
})

test('every read carries the actor tenant and no read writes', async () => {
  const { scenario } = await factsFor()
  assert.ok(scenario.calls.prisma.length > 0)
  for (const [model, method, args] of scenario.calls.prisma) {
    assert.match(method, /^(findMany|findFirst|findUnique|count)$/, `${model}.${method}`)
    const tenant = args.where?.tenantId ?? args.where?.id
    assert.equal(tenant, AI_SKILL_TENANT, `${model}.${method} is scoped`)
  }
  for (const [name, tenantId] of scenario.calls.repositories) assert.equal(tenantId, AI_SKILL_TENANT, name)
  // Raw reads are bounded.
  const raw = scenario.calls.prisma.filter(([model]) => ['item', 'inventoryBalance'].includes(model))
  assert.equal(raw.length, 2)
  for (const [model, , args] of raw) assert.equal(args.take, 501, model)
  // A write through the stand-in client throws, so a skill cannot mutate.
  await assert.rejects(async () => scenario.ctx.aiSkillPrisma.purchaseOrder.update({ where: { id: 'PO-001' }, data: {} }), /write attempted/)
})

test('missing permissions hide sources and amounts instead of reporting zero', async () => {
  // A procurement specialist cannot read supplier invoices.
  const buyer = (await factsFor({ roleKey: 'procurement-specialist' })).facts
  assert.equal(buyer.invoices, null)
  assert.deepEqual(buyer.limitations.find((row) => row.code === 'hidden_by_permission'), { code: 'hidden_by_permission', sources: ['supplier_invoices'] })
  assert.ok(buyer.records.every((row) => row.source !== 'supplier_invoices'))
  assert.equal(buyer.purchaseOrders.open, 4)
  // A read-only viewer sees the records without amounts.
  const viewer = (await factsFor({ roleKey: 'read-only-viewer' })).facts
  assert.equal(viewer.purchaseOrders.committedSpend, null)
  assert.equal(viewer.invoices.committed, null)
  assert.ok(viewer.purchaseOrders.rows.every((row) => row.amount === null))
  assert.ok(viewer.invoices.variances.every((row) => row.variance === null))
  assert.deepEqual(viewer.limitations.filter((row) => row.code === 'amounts_hidden').map((row) => row.what), ['purchase_orders', 'supplier_invoices'])
})

test('truncated reads become limitations and nulls stay null', async () => {
  const { facts } = await factsFor({ truncated: [{ subject: 'purchase_orders', limit: 500 }] })
  assert.deepEqual(facts.limitations.find((row) => row.code === 'truncated'), { code: 'truncated', source: 'purchase_orders', limit: 500 })
  // LDM-003 has no inventory balance: its availability stays unknown, not zero.
  const ldm3 = facts.inventory.rows.find((row) => row.sku === 'LDM-003')
  assert.equal(ldm3.available, null)
  assert.equal(ldm3.stockStatus, 'unknown')
})

test('on a different UTC day the assistant still counts overdue to the tenant day', async () => {
  // 01:30 UTC on Sep 30 is still Sep 29 in New York; the report and the
  // assistant both count overdue days to Sep 29.
  const scenario = aiSkillScenario()
  scenario.ctx.aiSkillNow = new Date('2026-09-30T01:30:00Z')
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  assert.equal(facts.today, '2026-09-29')
  assert.equal(facts.asOf, '2026-09-29')
  assert.equal(facts.limitations.some((row) => row.code === 'report_day'), false)
})

test('the skill context requires a signed-in identity bound to the actor tenant', async () => {
  const scenario = aiSkillScenario()
  await assert.rejects(loadAiSkillContext({ ...scenario.ctx, identity: { authenticated: false } }), (error) => error.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
  await assert.rejects(loadAiSkillContext({ ...scenario.ctx, identity: { authenticated: true, tenantId: '' } }), (error) => error.status === 403)
  await assert.rejects(loadAiSkillContext({ ...scenario.ctx, identity: { ...scenario.ctx.identity, tenantId: 'tenant-someone-else' } }), (error) => error.code === 'TENANT_CONTEXT_REQUIRED')
  const context = await loadAiSkillContext(scenario.ctx)
  assert.deepEqual(context.tenant, { locale: 'en-US', currency: 'USD', timezone: 'America/New_York' })
})

// The facts are read from the business read context as the actor may see it,
// the way the reports read it.
test('the read-only viewer gets no purchase order or invoice amounts in the skill facts', async () => {
  const { facts } = await factsFor({ roleKey: 'read-only-viewer' })
  const text = JSON.stringify(facts)
  // PO totals 3,920 and 17,920 committed; invoices 2,381.50 and 7,381.50 committed.
  for (const secret of ['17920', '3920', '2381.5', '7381.5']) assert.equal(text.includes(secret), false, secret)
  assert.ok(facts.purchaseOrders.index.every((row) => row.amount === null))
  // The invoice supplier needs finance.partner_snapshot.read.
  assert.deepEqual(facts.invoices.variances.map((row) => [row.id, row.supplierId, row.supplier, row.variance]), [['INV-001', '', null, null]])
  // A hidden amount or supplier is not a missing one.
  assert.deepEqual(facts.records.filter((row) => row.source === 'supplier_invoices'), [])
})

test('the procurement specialist gets no supplier invoices or sales orders in the skill facts', async () => {
  const { facts } = await factsFor({ roleKey: 'procurement-specialist' })
  const text = JSON.stringify(facts)
  for (const secret of ['INV-00', 'SO-001', 'Redwood', '2381.5', '7381.5']) assert.equal(text.includes(secret), false, secret)
  assert.equal(facts.invoices, null)
  // Availability still counts every order's demand, as the inventory report does.
  const ldm1 = facts.inventory.rows.find((row) => row.sku === 'LDM-001')
  assert.deepEqual([ldm1.openSalesDemand, ldm1.shortage, ldm1.salesOrderIds], [35, 7, []])
  assert.deepEqual(facts.inventory.atRisk, ['LDM-001'])
})

test("the skill facts read inventory from the actor's warehouses only", async () => {
  const scenario = aiSkillScenario({ roleKey: 'operations-specialist' })
  scenario.actor.readWarehouseIds = new Set(['WH-EAST'])
  const listItems = scenario.ctx.repositories.inventoryRuntime.listItems
  let warehouseIds
  scenario.ctx.repositories.inventoryRuntime.listItems = async (scope) => { warehouseIds = scope.warehouseIds; return listItems(scope) }
  await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  assert.deepEqual(warehouseIds, ['WH-EAST'])
  const [, , balanceRead] = scenario.calls.prisma.find(([model]) => model === 'inventoryBalance')
  assert.deepEqual(balanceRead.where, { tenantId: AI_SKILL_TENANT, warehouseId: { in: ['WH-EAST'] } })
})
