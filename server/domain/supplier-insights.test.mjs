import test from 'node:test'
import assert from 'node:assert/strict'
import * as insights from './supplier-insights.mjs'
import { buildSupplierInsights, supplierPurchaseRecords, supplierPurchaseTotals } from './supplier-insights.mjs'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts, readAiSkillSupplierIssueFacts } from './ai-skill-readers.mjs'
import { buildAiSkillSignals } from './ai-skill-signals.mjs'

const window = { from: '2025-10-05', to: '2026-10-04' }
const po = (supplierId, amount, extra = {}) => ({ supplierId, status: 'issued', totalAmount: amount, currency: 'USD', createdAt: '2026-09-01', lines: [], ...extra })
const suppliers = ['A', 'B', 'C', 'D'].map((id) => ({ id, name: `Supplier ${id}`, status: 'active' }))

test('12-month totals count committed orders by business date, per currency', () => {
  const totals = supplierPurchaseTotals([
    po('A', 100), po('A', 50, { currency: 'EUR' }), po('A', 70, { status: 'draft' }), po('A', 80, { status: 'cancelled' }),
    po('A', 90, { createdAt: '2024-01-01' }), po('B', null), po('', 10),
  ], window)
  assert.deepEqual(Object.fromEntries(totals.get('A').byCurrency), { USD: 100, EUR: 50 })
  assert.equal(totals.get('A').orders, 2)
  assert.equal(totals.get('B').amountKnown, false)
  assert.equal(totals.has(''), false)
})

test('metrics are null when the reader may not see them', () => {
  const totals = supplierPurchaseTotals([po('A', 100)], window)
  const openRows = [{ supplierId: 'A', isOpen: true, overdueDays: 3 }, { supplierId: 'A', isOpen: true, overdueDays: 0 }]
  const signals = [{ type: 'po_overdue', supplierId: 'A' }, { type: 'po_due_7d', supplierId: 'A' }, { type: 'invoice_variance', supplierId: 'A' }, { type: 'invoice_variance', supplierId: '' }]
  const seen = buildSupplierInsights({ suppliers, totals, openRows, signals, visibility: { orders: true, amounts: true, onTime: false, issues: true } }).A
  assert.deepEqual([seen.spend12m, seen.openPos, seen.overduePos, seen.onTime, seen.openIssues], [[{ currency: 'USD', amount: 100 }], 2, 1, null, 2])
  const hidden = buildSupplierInsights({ suppliers, totals, openRows, signals, visibility: { orders: false, amounts: false, onTime: false, issues: false } }).A
  assert.deepEqual([hidden.spend12m, hidden.orders12m, hidden.openPos, hidden.overduePos, hidden.onTime, hidden.openIssues], [null, null, null, null, null, null])
})

test('FlowChain suggests no tier: tiers are set by a person (owner decision 2026-10-09)', () => {
  const row = buildSupplierInsights({ suppliers, totals: supplierPurchaseTotals([po('A', 100)], window), visibility: { orders: true, amounts: true, onTime: true, issues: true } }).A
  assert.equal('suggestion' in row, false)
  assert.equal(Object.keys(insights).some((name) => /suggest|concentration|itemSources/i.test(name)), false)
})

test('purchase records use the workspace day and the due day the open purchase orders report counts from', () => {
  // Entered at 21:00 New York time on Sep 30, which is already Oct 1 in UTC.
  const late = po('A', 100, { id: 'PO-EVENING', createdAt: '2026-10-01T01:00:00.000Z' })
  // The earlier line is received; the open line is due Sep 20.
  const split = po('A', 100, { id: 'PO-SPLIT', createdAt: '2026-09-01T12:00:00.000Z', lines: [
    { orderedQuantity: 5, receivedQuantity: 5, unit: 'pcs', metadata: { promisedDate: '2026-09-10' } },
    { orderedQuantity: 5, receivedQuantity: 0, unit: 'pcs', metadata: { promisedDate: '2026-09-20' } },
  ] })
  const rows = supplierPurchaseRecords([late, split], 'A', { timeZone: 'America/New_York' }).rows
  assert.equal(rows.find((row) => row.id === 'PO-EVENING').date, '2026-09-30')
  assert.equal(rows.find((row) => row.id === 'PO-SPLIT').promisedDate, '2026-09-20')
  assert.equal(supplierPurchaseRecords([late], 'A', { timeZone: 'Asia/Shanghai' }).rows[0].date, '2026-10-01')
})

test('supplier risks list every supplier issue the earliest date first, never by a score, with the supplier named', () => {
  const when = (kind, date, days) => ({ kind, date, days })
  const signals = [
    { id: 'invoice_variance:INV-9', type: 'invoice_variance', supplierId: 'B', entityType: 'supplier_invoice', entityId: 'INV-9', label: 'INV-9', when: when('open', '2026-09-20', 14), data: { variance: 12.5, currency: 'USD' }, severity: 'risk' },
    { id: 'po_overdue:PO-2', type: 'po_overdue', supplierId: 'A', entityType: 'purchase_order', entityId: 'PO-2', label: 'PO-2', when: when('overdue', '2026-09-28', 6), data: { days: 6 }, severity: 'risk' },
    { id: 'po_overdue:PO-1', type: 'po_overdue', supplierId: 'A', entityType: 'purchase_order', entityId: 'PO-1', label: 'PO-1', when: when('overdue', '2026-09-01', 33), data: { days: 33 }, severity: 'risk' },
    { id: 'grn_received_unposted:GRN-4', type: 'grn_received_unposted', supplierId: 'C', entityType: 'receiving_doc', entityId: 'GRN-4', label: 'GRN-4', when: when('open', '2026-10-01', 3), data: {}, severity: 'info' },
    // Not a supplier issue, and an issue of a supplier not in the master: neither is listed.
    { id: 'po_due_7d:PO-3', type: 'po_due_7d', supplierId: 'A', entityType: 'purchase_order', entityId: 'PO-3', label: 'PO-3', when: when('due', '2026-10-06', 2), data: {} },
    { id: 'po_overdue:PO-X', type: 'po_overdue', supplierId: 'GONE', entityType: 'purchase_order', entityId: 'PO-X', label: 'PO-X', when: when('overdue', '2026-08-01', 64), data: { days: 64 } },
  ]
  const master = [{ id: 'A', code: 'SUP-A', name: 'Acme' }, { id: 'B', code: '', name: 'Birch' }, { id: 'C', code: 'SUP-C', name: '' }]
  const rows = insights.supplierRiskRows(signals, master)
  assert.deepEqual(rows.map((row) => row.entityId), ['PO-1', 'INV-9', 'PO-2', 'GRN-4'])
  assert.deepEqual(rows.map((row) => row.when.date), [...rows.map((row) => row.when.date)].sort())
  assert.deepEqual(rows.map((row) => [row.supplierId, row.supplierCode, row.supplierName]), [['A', 'SUP-A', 'Acme'], ['B', 'B', 'Birch'], ['A', 'SUP-A', 'Acme'], ['C', 'SUP-C', 'C']])
  assert.deepEqual(rows[0], { id: 'po_overdue:PO-1', type: 'po_overdue', entityType: 'purchase_order', entityId: 'PO-1', label: 'PO-1', when: when('overdue', '2026-09-01', 33), data: { days: 33 }, supplierId: 'A', supplierCode: 'SUP-A', supplierName: 'Acme' })
  // No score, weight or severity rank travels with a row.
  assert.ok(rows.every((row) => !('severity' in row) && !('score' in row) && !('rank' in row)))
  // The rows are exactly what each supplier's detail page lists.
  for (const id of ['A', 'B', 'C']) assert.equal(rows.filter((row) => row.supplierId === id).length, insights.supplierIssueSignals(signals, id).length)
})

// The issues as they were read before 2026-11-08: the assistant's signals
// over its full facts, which read every sales order, stock row and item.
const fullFactsSignals = (skillContext) => readAiSkillFacts(skillContext).then(buildAiSkillSignals)
const supplierSignals = (signals) => signals.filter((signal) => insights.SUPPLIER_ISSUE_TYPES.includes(signal.type))
// Readers with every mix of orders, prices, receipts, invoices, invoice amounts and the partner snapshot.
const READERS = ['workspace-administrator', 'operations-manager', 'procurement-specialist', 'finance-specialist', 'operations-specialist', 'read-only-viewer']

async function everyRead(service, ctx) {
  return { list: await service.read(ctx), acme: await service.readActivity(ctx, 'SUP-001'), summit: await service.readActivity(ctx, 'SUP-002'), risks: await service.readRisks(ctx) }
}

test('the supplier list, detail pages and risks read only what their issues need, with the same results as the full facts, per reader', async () => {
  for (const roleKey of READERS) {
    const scenario = aiSkillScenario({ roleKey })
    const { ctx } = scenario
    const options = { prisma: ctx.aiSkillPrisma, listPurchaseOrders: ctx.repositories.procurementRuntime.listForReport, now: () => new Date(ctx.aiSkillNow) }
    const narrow = await everyRead(insights.createSupplierInsightsReadService(options), ctx)
    const repositoryReads = scenario.calls.repositories.map(([name]) => name)
    const prismaReads = scenario.calls.prisma.map(([model]) => model)
    const full = await everyRead(insights.createSupplierInsightsReadService({ ...options, readIssueSignals: fullFactsSignals }), ctx)
    assert.deepEqual(narrow, full, roleKey)
    // The signals themselves, every field, not only what the pages print.
    const skillContext = await loadAiSkillContext(ctx)
    assert.deepEqual(supplierSignals(buildAiSkillSignals(await readAiSkillSupplierIssueFacts(skillContext))), supplierSignals(await fullFactsSignals(skillContext)), roleKey)
    // No sales order, stock row or item is read, and the purchase orders are
    // read once per page: the list, two detail pages and the risks.
    for (const name of ['salesOrders.listOrders', 'inventoryRuntime.listItems', 'masterData.listManagedItems', 'procurementRuntime.snapshot']) assert.ok(!repositoryReads.includes(name), `${roleKey} read ${name}`)
    for (const model of ['item', 'inventoryBalance', 'runtimeRecord']) assert.ok(!prismaReads.includes(model), `${roleKey} read ${model}`)
    assert.equal(repositoryReads.filter((name) => name === 'procurementRuntime.listForReport').length, narrow.list.visibility.orders ? 4 : 0, roleKey)
  }
  // The fixture has every kind of issue, so the comparison covers each.
  const { ctx } = aiSkillScenario()
  const admin = await insights.createSupplierInsightsReadService({ prisma: ctx.aiSkillPrisma, now: () => new Date(ctx.aiSkillNow) }).readRisks(ctx)
  assert.deepEqual([...new Set(admin.issues.map((issue) => issue.type))].sort(), [...insights.SUPPLIER_ISSUE_TYPES].sort())
})

test('without the narrow receipt and invoice read, the issues come from the business read context, the same as before', async () => {
  for (const roleKey of ['workspace-administrator', 'read-only-viewer']) {
    const scenario = aiSkillScenario({ roleKey })
    delete scenario.ctx.repositories.procurementRuntime.listReceiptsAndInvoices
    const skillContext = await loadAiSkillContext(scenario.ctx)
    assert.deepEqual(supplierSignals(buildAiSkillSignals(await readAiSkillSupplierIssueFacts(skillContext))), supplierSignals(await fullFactsSignals(skillContext)), roleKey)
    assert.ok(scenario.calls.repositories.some(([name]) => name === 'procurementRuntime.snapshot'), roleKey)
  }
})
