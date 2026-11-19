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
  // The overdue order is in "Overdue POs", not counted again as an open issue (design audit L9-14).
  assert.deepEqual([seen.spend12m, seen.openPos, seen.overduePos, seen.onTime, seen.otif, seen.openIssues], [[{ currency: 'USD', amount: 100 }], 2, 1, null, null, 1])
  const hidden = buildSupplierInsights({ suppliers, totals, openRows, signals, visibility: { orders: false, amounts: false, onTime: false, issues: false } }).A
  assert.deepEqual([hidden.spend12m, hidden.orders12m, hidden.openPos, hidden.overduePos, hidden.onTime, hidden.otif, hidden.openIssues], [null, null, null, null, null, null, null])
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
    // Not supplier issues: a receipt the buyer has not posted yet (design
    // audit L9-14), an order due soon, and an issue of a supplier not in the
    // master. None is listed.
    { id: 'grn_received_unposted:GRN-4', type: 'grn_received_unposted', supplierId: 'C', entityType: 'receiving_doc', entityId: 'GRN-4', label: 'GRN-4', when: when('open', '2026-10-01', 3), data: {}, severity: 'info' },
    { id: 'po_due_7d:PO-3', type: 'po_due_7d', supplierId: 'A', entityType: 'purchase_order', entityId: 'PO-3', label: 'PO-3', when: when('due', '2026-10-06', 2), data: {} },
    { id: 'po_overdue:PO-X', type: 'po_overdue', supplierId: 'GONE', entityType: 'purchase_order', entityId: 'PO-X', label: 'PO-X', when: when('overdue', '2026-08-01', 64), data: { days: 64 } },
  ]
  const master = [{ id: 'A', code: 'SUP-A', name: 'Acme' }, { id: 'B', code: '', name: 'Birch' }, { id: 'C', code: 'SUP-C', name: '' }]
  const rows = insights.supplierRiskRows(signals, master)
  assert.deepEqual(rows.map((row) => row.entityId), ['PO-1', 'INV-9', 'PO-2'])
  assert.deepEqual(rows.map((row) => row.when.date), [...rows.map((row) => row.when.date)].sort())
  assert.deepEqual(rows.map((row) => [row.supplierId, row.supplierCode, row.supplierName]), [['A', 'SUP-A', 'Acme'], ['B', 'B', 'Birch'], ['A', 'SUP-A', 'Acme']])
  assert.equal(insights.SUPPLIER_ISSUE_TYPES.includes('grn_received_unposted'), false)
  assert.deepEqual(rows[0], { id: 'po_overdue:PO-1', type: 'po_overdue', entityType: 'purchase_order', entityId: 'PO-1', label: 'PO-1', when: when('overdue', '2026-09-01', 33), data: { days: 33 }, supplierId: 'A', supplierCode: 'SUP-A', supplierName: 'Acme' })
  // No score, weight or severity rank travels with a row.
  assert.ok(rows.every((row) => !('severity' in row) && !('score' in row) && !('rank' in row)))
  // The rows are exactly what each supplier's detail page lists.
  for (const id of ['A', 'B', 'C']) assert.equal(rows.filter((row) => row.supplierId === id).length, insights.supplierIssueSignals(signals, id).length)
})

// Design audit V-C-04 (the defect behind L9-02): an order approved but never
// sent to the supplier read "Not issued to the supplier yet" on Today and
// "N days overdue" on the supplier pages, which dropped the notSent mark. The
// open purchase orders report still counts it as open and overdue (decision
// V5); the supplier pages no longer hold it against the supplier.
test('an order approved but never sent is open, but not overdue or an open issue of the supplier', () => {
  const openRows = [
    { id: 'PO-SENT', supplierId: 'A', isOpen: true, status: 'issued', overdueDays: 4 },
    { id: 'PO-UNSENT', supplierId: 'A', isOpen: true, status: 'approved', overdueDays: 9 },
    { id: 'PO-UNSENT-LATER', supplierId: 'A', isOpen: true, status: 'approved', overdueDays: 0 },
  ]
  const when = (days) => ({ kind: 'overdue', date: '2026-09-20', days })
  const signals = [
    { id: 'po_overdue:PO-SENT', type: 'po_overdue', supplierId: 'A', entityType: 'purchase_order', entityId: 'PO-SENT', label: 'PO-SENT', when: when(4), data: { days: 4, notSent: false } },
    { id: 'po_overdue:PO-UNSENT', type: 'po_overdue', supplierId: 'A', entityType: 'purchase_order', entityId: 'PO-UNSENT', label: 'PO-UNSENT', when: when(9), data: { days: 9, notSent: true } },
  ]
  const row = buildSupplierInsights({ suppliers, openRows, signals, visibility: { orders: true, amounts: false, onTime: false, issues: true } }).A
  // The sent order is overdue; it is in "Overdue POs" only, not again in "Open issues" (design audit L9-14).
  assert.deepEqual([row.openPos, row.overduePos, row.notSentPos, row.openIssues], [3, 1, 2, 0])
  assert.equal(buildSupplierInsights({ suppliers, openRows, signals, visibility: { orders: false, issues: false } }).A.notSentPos, null)
  // Supplier risks and the detail page's issues leave it out too.
  assert.deepEqual(insights.supplierRiskRows(signals, [{ id: 'A', code: 'SUP-A', name: 'Acme' }]).map((entry) => entry.entityId), ['PO-SENT'])
  assert.deepEqual(insights.supplierIssueSignals(signals, 'A').map((entry) => entry.entityId), ['PO-SENT'])
  // The detail page's purchase records: no days overdue, marked not sent.
  const records = supplierPurchaseRecords([po('A', 10, { id: 'PO-UNSENT', status: 'approved' }), po('A', 10, { id: 'PO-SENT', createdAt: '2026-08-01' })], 'A', { openRows, timeZone: 'America/New_York' }).rows
  assert.deepEqual(records.map((entry) => [entry.id, entry.overdueDays, entry.notSent]), [['PO-UNSENT', 0, true], ['PO-SENT', 4, false]])
})

// Design audit L9-07: an order closed short after a partial receipt counted
// at its full amount, though the rest will never come or be billed.
test('an order closed short counts what was received of it in the 12-month spend', () => {
  const lines = [
    { orderedQuantity: 10, receivedQuantity: 4, unitPrice: 25, amount: 250 },
    { orderedQuantity: 6, receivedQuantity: 0, unitPrice: 10, amount: 60 },
  ]
  const totals = supplierPurchaseTotals([po('A', 310, { status: 'closed', lines }), po('A', 40)], window)
  assert.deepEqual(Object.fromEntries(totals.get('A').byCurrency), { USD: 140 })
  assert.equal(totals.get('A').amountKnown, true)
  // Without a line price, the line amount over the ordered quantity prices it.
  const byAmount = supplierPurchaseTotals([po('A', 310, { status: 'closed', lines: [{ orderedQuantity: 10, receivedQuantity: 4, amount: 250 }] })], window)
  assert.deepEqual(Object.fromEntries(byAmount.get('A').byCurrency), { USD: 100 })
  // A line with no quantity received on record makes the spend incomplete, not a guess.
  const unknown = supplierPurchaseTotals([po('B', 310, { status: 'closed', lines: [{ orderedQuantity: 10, receivedQuantity: null, unitPrice: 25 }] })], window)
  assert.equal(unknown.get('B').amountKnown, false)
  // A fully received order still counts its amount.
  assert.deepEqual(Object.fromEntries(supplierPurchaseTotals([po('A', 310, { status: 'fully_received', lines })], window).get('A').byCurrency), { USD: 310 })
})

// Design audit L9-03 and L9-13: the list and Supplier evaluation showed only
// on time (a partial first receipt passes), and "—" for any supplier with
// fewer than 5 deliveries in 90 days. OTIF is now a column of its own, and
// each rate carries the counts behind it, plus the deliveries withheld for
// receipts in warehouses the reader cannot see (L9-06).
test('the list carries OTIF beside on time, with counts below the sample and the deliveries withheld', () => {
  const scorecard = { suppliers: [
    { supplierId: 'A', sampleStatus: 'ok', withheldCount: 2, metrics: { onTime: { rate: 0.8, count: 4, of: 5 }, otif: { rate: 0.6, count: 3, of: 5 } } },
    { supplierId: 'B', sampleStatus: 'insufficient_sample', withheldCount: 0, metrics: { onTime: { rate: null, count: 3, of: 3 }, otif: { rate: null, count: 2, of: 3 } } },
  ] }
  const rows = buildSupplierInsights({ suppliers, scorecard, visibility: { orders: true, amounts: true, onTime: true, issues: true } })
  assert.deepEqual(rows.A.onTime, { rate: 0.8, count: 4, of: 5, sampleStatus: 'ok', withheld: 2 })
  assert.deepEqual(rows.A.otif, { rate: 0.6, count: 3, of: 5, sampleStatus: 'ok', withheld: 2 })
  assert.deepEqual([rows.B.onTime.rate, rows.B.onTime.count, rows.B.onTime.of, rows.B.otif.count, rows.B.otif.of], [null, 3, 3, 2, 3])
  assert.deepEqual(rows.C.otif, { rate: null, count: 0, of: 0, sampleStatus: 'no_obligations', withheld: 0 })
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
