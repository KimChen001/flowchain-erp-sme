import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { aiReadToolsFor, runAiReadTool } from './ai-read-tool-runner.mjs'
import { cashByMonth, grossProfitOf, receiptsNotInvoiced } from './ai-assistant-v2-money-tools.mjs'
import { ASSISTANT_V2_SYSTEM } from './ai-assistant-v2.mjs'

// The money tools (2026-11-14) on the skill scenario, seeded 2026-09-29:
// payables still owed, recorded payments and customer invoices, read through
// the read-only Prisma stand-in.

const link = { id: 'ITEM-001::SUP-001', payload: { itemId: 'ITEM-001', supplierId: 'SUP-001', preferred: true, active: true, approved: true, referencePrice: 95, currency: 'USD' } }
const date = (value) => new Date(`${value}T00:00:00Z`)
const payable = (id, { invoice, outstanding, due, status = 'approved', currency = 'USD', supplier = 'Acme Components' }) => ({
  id, supplierInvoiceId: invoice, obligationNumber: `AP-${invoice}`, outstandingAmount: String(outstanding), currency, dueDate: date(due), status,
  supplierInvoice: { id: invoice, invoiceNumber: invoice, supplierName: supplier, invoiceDate: date('2026-08-20') },
})
const payment = (obligationType, paymentDate, amount, { currency = 'USD', status = 'recorded' } = {}) => ({ obligationType, paymentDate: date(paymentDate), amount: String(amount), currency, status })

function money(data) {
  data.payables = [
    payable('AP-1', { invoice: 'INV-002', outstanding: 5000, due: '2026-09-20' }),
    payable('AP-2', { invoice: 'INV-010', outstanding: 1200, due: '2026-10-03', status: 'held', supplier: 'Summit Packaging' }),
    payable('AP-3', { invoice: 'INV-011', outstanding: 0, due: '2026-09-01', status: 'settled' }),
    payable('AP-4', { invoice: 'INV-012', outstanding: 300, due: '2026-10-20', currency: 'EUR', supplier: 'Summit Packaging' }),
  ]
  data.payments = [
    payment('receivable', '2026-09-05', 1000),
    payment('receivable', '2026-08-20', 400),
    payment('payable', '2026-09-10', 600),
    payment('payable', '2026-09-12', 50, { status: 'voided' }),
    payment('payable', '2026-09-15', 100, { currency: 'EUR' }),
  ]
  // INV-002 is linked to GRN-003; GRN-001 (20 of PO-001 at 100) has no invoice.
  data.supplierInvoices[1].relatedGrnId = 'GRN-003'
  data.receipts[0].lines[0].purchaseOrderLineId = 'PO-001-L1'
  data.customerInvoices = [
    { id: 'CI-1', customerNameSnapshot: 'Harbor Supply Co', invoiceDate: date('2026-09-10'), currency: 'USD', lines: [
      { itemId: 'ITEM-001', sku: 'LDM-001', itemName: 'Flow Controller', quantity: '10', unit: 'pcs', lineAmount: '1500' },
      { itemId: 'ITEM-002', sku: 'LDM-002', itemName: 'Temperature Sensor', quantity: '5', unit: 'pcs', lineAmount: '400' },
    ] },
    { id: 'CI-2', customerNameSnapshot: 'Redwood Retail', invoiceDate: date('2026-08-15'), currency: 'USD', lines: [
      { itemId: 'ITEM-001', sku: 'LDM-001', itemName: 'Flow Controller', quantity: '4', unit: 'pcs', lineAmount: '600' },
    ] },
  ]
}

async function money2({ without = [], change = null } = {}) {
  const scenario = aiSkillScenario({ supplierLinks: [link] })
  money(scenario.data)
  change?.(scenario.data)
  for (const code of without) scenario.ctx.aiSkillActor.permissionCodes.delete(code)
  const context = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const run = async (name, args = {}) => {
    const output = await runAiReadTool(name, args, { facts, context })
    assert.ok(output.ok, `${name}: ${output.error}`)
    return output.result
  }
  return { scenario, context, facts, run }
}

test('supplier_payables: what is owed and overdue as of the workspace day, held at the match and not invoiced apart', async () => {
  const { run } = await money2()
  const summary = await run('supplier_payables')
  // AP-3 is settled; AP-1 was due 9 days ago; AP-2 (payment held) is due in 4.
  assert.deepEqual(summary.totals, [
    { currency: 'USD', owedInvoices: 2, owed: 6200, overdueInvoices: 1, overdue: 5000, dueIn7DaysInvoices: 1, dueIn7Days: 1200, paymentHeldInvoices: 1 },
    { currency: 'EUR', owedInvoices: 1, owed: 300, overdueInvoices: 0, overdue: 0, dueIn7DaysInvoices: 0, dueIn7Days: 0, paymentHeldInvoices: 0 },
  ])
  // INV-001 waits at the three-way match: not owed yet, counted apart.
  assert.deepEqual(summary.heldAtMatch, [{ currency: 'USD', invoices: 1, amount: 2381.5 }])
  assert.deepEqual(summary.receiptsNotInvoiced, [{ currency: 'USD', amount: 2000, receipts: 1 }])
  assert.deepEqual(summary.oldestOverdue.map((row) => [row.invoiceNumber, row.overdueDays]), [['INV-002', 9]])

  const overdue = await run('supplier_payables', { view: 'overdue' })
  assert.deepEqual(overdue.rows.map((row) => [row.invoiceNumber, row.supplier, row.dueDate, row.overdueDays, row.outstanding]), [['INV-002', 'Acme Components', '2026-09-20', 9, 5000]])
  assert.deepEqual(overdue.rows[0].ref, { type: 'supplier_invoice', id: 'INV-002', label: 'INV-002' })

  const bySupplier = await run('supplier_payables', { view: 'by_supplier' })
  assert.deepEqual(bySupplier.rows.map((row) => [row.supplier, row.currency, row.owed, row.overdue]), [['Acme Components', 'USD', 5000, 5000], ['Summit Packaging', 'USD', 1200, 0], ['Summit Packaging', 'EUR', 300, 0]])

  const owedToSummit = await run('supplier_payables', { view: 'owed', supplier: 'summit' })
  assert.deepEqual(owedToSummit.rows.map((row) => [row.invoiceNumber, row.paymentHeld]), [['INV-010', true], ['INV-012', false]])

  const notInvoiced = await run('supplier_payables', { view: 'not_invoiced' })
  assert.deepEqual(notInvoiced.rows.map((row) => [row.receipt, row.purchaseOrder, row.value, row.currency]), [['GRN-001', 'PO-001', 2000, 'USD']])
})

test('supplier_payables: a receipt counts as invoiced once an invoice line names one of its lines', async () => {
  const { run } = await money2({ change: (data) => { data.supplierInvoices[0].lines = [{ receivingLineId: 'GRNL-001' }] } })
  assert.equal((await run('supplier_payables', { view: 'not_invoiced' })).total, 0)
})

test('supplier_payables: without finance.amounts.read the amounts are null and say so; without supplier names a supplier filter is refused', async () => {
  const { run } = await money2({ without: ['finance.amounts.read'] })
  const overdue = await run('supplier_payables', { view: 'overdue' })
  assert.equal(overdue.amountsHidden, true)
  assert.equal(overdue.rows[0].outstanding, null)
  assert.deepEqual(overdue.totals, [{ currency: 'USD', invoices: 1, amount: null }])
  const hidden = await money2({ without: ['finance.partner_snapshot.read'] })
  assert.equal((await hidden.run('supplier_payables', { view: 'overdue' })).rows[0].supplier, null)
  assert.deepEqual(await runAiReadTool('supplier_payables', { supplier: 'Acme' }, { facts: hidden.facts, context: hidden.context }), { ok: false, error: 'supplier_names_hidden' })
})

test('the money tools are offered only with their pages\' read permissions', async () => {
  const offered = async (without) => {
    const { facts, context } = await money2({ without })
    return aiReadToolsFor(facts, context).map((tool) => tool.name).filter((name) => ['supplier_payables', 'cash_movements', 'gross_profit'].includes(name))
  }
  assert.deepEqual(await offered([]), ['supplier_payables', 'cash_movements', 'gross_profit'])
  assert.deepEqual(await offered(['finance.payable.read']), ['cash_movements', 'gross_profit'])
  assert.deepEqual(await offered(['finance.payable.read', 'finance.receivable.read', 'finance.customer_invoice.read']), [])
})

test('cash_movements: recorded payments in and out by payment date, per currency, voided ones left out', async () => {
  const { run } = await money2()
  const september = await run('cash_movements', { from: '2026-09-01', to: '2026-09-30' })
  assert.deepEqual(september.totals, [
    { currency: 'USD', receivedFromCustomers: 1000, customerPayments: 1, paidToSuppliers: 600, supplierPayments: 1, net: 400 },
    { currency: 'EUR', receivedFromCustomers: 0, customerPayments: 0, paidToSuppliers: 100, supplierPayments: 1, net: -100 },
  ])
  const year = await run('cash_movements', { period: 'last_12_months' })
  assert.deepEqual(year.months.map((row) => [row.month, row.currency, row.receivedFromCustomers, row.paidToSuppliers]), [['2026-08', 'USD', 400, 0], ['2026-09', 'EUR', 0, 100], ['2026-09', 'USD', 1000, 600]])
  // A reader of payables only sees the supplier side, and is told so.
  const payablesOnly = await money2({ without: ['finance.receivable.read'] })
  const paid = await payablesOnly.run('cash_movements', { from: '2026-09-01', to: '2026-09-30' })
  assert.equal(paid.notRead, 'customer_payments')
  assert.deepEqual(paid.totals.map((row) => [row.currency, row.receivedFromCustomers, row.paidToSuppliers]), [['USD', 0, 600], ['EUR', 0, 100]])
  const hidden = await money2({ without: ['finance.amounts.read'] })
  assert.deepEqual(await runAiReadTool('cash_movements', {}, { facts: hidden.facts, context: hidden.context }), { ok: false, error: 'amounts_hidden' })
})

test('gross_profit: sales less the units at the preferred supplier\'s reference price, an item without a price counted apart', async () => {
  const { run } = await money2()
  const september = await run('gross_profit', { from: '2026-09-01', to: '2026-09-30' })
  // 10 LDM-001 at 95 cost 950 against 1,500; LDM-002 has no reference price.
  assert.deepEqual([september.revenue, september.cost, september.grossProfit, september.grossMarginPercent], [1900, 950, 550, 36.7])
  assert.deepEqual([september.costedRevenue, september.linesWithoutCost, september.revenueWithoutCost, september.itemsWithoutCost], [1500, 1, 400, ['LDM-002']])
  assert.equal(september.costSource, 'reference_price_of_preferred_supplier')
  assert.match(september.basis, /estimate/)
  const months = await run('gross_profit', { by: 'month', period: 'last_12_months' })
  assert.deepEqual(months.rows.map((row) => [row.month, row.revenue, row.cost, row.grossProfit]), [['2026-08', 600, 380, 220], ['2026-09', 1900, 950, 550]])
  const items = await run('gross_profit', { by: 'item', period: 'last_12_months' })
  assert.deepEqual(items.rows.map((row) => [row.sku, row.quantity, row.grossProfit, row.linesWithoutCost ?? 0]), [['LDM-001', 14, 770, 0], ['LDM-002', 5, 0, 1]])
  // Without prices every line is uncosted, and the result says prices are hidden.
  const hidden = await money2({ without: ['procurement.prices.read'] })
  const blind = await hidden.run('gross_profit', { from: '2026-09-01', to: '2026-09-30' })
  assert.equal(blind.pricesHidden, true)
  assert.deepEqual([blind.cost, blind.grossMarginPercent, blind.linesWithoutCost], [0, null, 2])
})

test('the pure money figures: receipts, cash by month and gross profit', () => {
  const rows = receiptsNotInvoiced([
    { id: 'R1', documentNumber: 'GRN-1', poId: 'PO-1', arrivedAt: date('2026-09-01'), lines: [{ id: 'L1', purchaseOrderLineId: 'POL-1', acceptedQty: '3' }, { id: 'L2', purchaseOrderLineId: 'POL-X', acceptedQty: '1' }] },
    { id: 'R2', documentNumber: 'GRN-2', poId: 'PO-1', arrivedAt: date('2026-09-02'), lines: [{ id: 'L3', purchaseOrderLineId: 'POL-1', acceptedQty: '1' }] },
  ], { linkedReceipts: new Set(['R2']), linkedLines: new Set(), orderLines: new Map([['POL-1', 2.5]]), orders: new Map([['PO-1', { number: 'PO-1', currency: 'GBP', supplierName: 'Acme' }]]) })
  assert.deepEqual(rows.map((row) => [row.receipt, row.value, row.linesWithoutPrice, row.supplier]), [['GRN-1', 7.5, 1, 'Acme']])
  assert.deepEqual(cashByMonth([]), { totals: [], months: [] })
  const profit = grossProfitOf([{ day: '2026-10-01', sku: 'A', quantity: 2, lineAmount: 10 }], { unitCost: () => 2.5, by: 'total' })
  assert.deepEqual([profit.revenue, profit.cost, profit.grossProfit, profit.grossMarginPercent, profit.rows], [10, 5, 5, 50, []])
})

test('the prompt sends money questions to the money tools, and no longer calls profit or cash unrecorded', () => {
  assert.match(ASSISTANT_V2_SYSTEM, /supplier_payables/)
  assert.match(ASSISTANT_V2_SYSTEM, /cash_movements/)
  assert.match(ASSISTANT_V2_SYSTEM, /gross_profit/)
  assert.doesNotMatch(ASSISTANT_V2_SYSTEM, /does not record it \(profit or margins, cash/)
})
