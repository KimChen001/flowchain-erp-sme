import test from 'node:test'
import assert from 'node:assert/strict'

// trace_document_chain (server/domain/ai-assistant-v2-chain-tools.mjs) in a
// real database: a request quoted through an RFQ and ordered, two receipts in
// two warehouses, one invoice approved with its payable overdue and one held
// at the three-way match by a price difference. The tool reads the business
// read context through the database repositories, and the payable, the match
// exception and the supplier's later order price with Prisma, as the reader:
// each role sees only what it may read. Nothing is written.

const tenantId = 'tenant-doc-chain'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { createDatabaseRepositoryRegistry } = await import('../../server/repositories/adapter-registry.mjs')
const { loadAiSkillContext } = await import('../../server/domain/ai-skill-context.mjs')
const { readAiSkillFacts } = await import('../../server/domain/ai-skill-readers.mjs')
const { aiReadToolsFor, aiReadToolRefs, runAiReadTool } = await import('../../server/domain/ai-read-tool-runner.mjs')
const { checkAiModelFirstGrounding } = await import('../../server/domain/ai-model-first-grounding.mjs')

const NOW = new Date('2026-11-18T12:00:00Z')
const TODAY = '2026-11-18'
const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId }
// Each user's stored role (the legacy role the authorization backfill maps).
const users = { admin: 'admin', viewer: 'viewer', buyer: 'buyer', east: 'admin' }
const counted = ['purchaseRequest', 'rfq', 'purchaseOrder', 'purchaseOrderLine', 'receivingDocument', 'supplierInvoice', 'threeWayMatch', 'financeMatchException', 'payableObligation', 'auditLog']
const day = (value) => new Date(`${value}T00:00:00Z`)

async function seed(prisma) {
  await prisma.tenant.create({ data: { id: tenantId, name: 'Document Chain', countryCode: 'GB', locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London', defaultLanguage: 'en-US' } })
  await prisma.warehouse.createMany({ data: [{ id: 'dc-wh-1', tenantId, code: 'WH1', name: 'Main' }, { id: 'dc-wh-2', tenantId, code: 'WH2', name: 'Overflow' }] })
  await prisma.user.createMany({ data: Object.entries(users).map(([key, role]) => ({ id: `${tenantId}-${key}`, tenantId, email: `doc-chain-${key}@example.com`, name: `Doc Chain ${key}`, role })) })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-admin` })
  // Every user reads both warehouses, except the east user: the main one only.
  for (const key of Object.keys(users)) {
    for (const warehouseId of key === 'east' ? ['dc-wh-1'] : ['dc-wh-1', 'dc-wh-2']) {
      await prisma.userWarehouseScope.upsert({
        where: { tenantId_userId_warehouseId: { tenantId, userId: `${tenantId}-${key}`, warehouseId } },
        create: { id: `dc-scope-${key}-${warehouseId}`, tenantId, userId: `${tenantId}-${key}`, warehouseId, accessLevel: 'read' },
        update: {},
      })
    }
  }
  await prisma.userWarehouseScope.deleteMany({ where: { tenantId, userId: `${tenantId}-east`, warehouseId: 'dc-wh-2' } })
  const item = { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', unit: 'pcs' }
  await prisma.purchaseRequest.create({ data: { id: 'dc-pr-1', tenantId, number: 'PR-202611-0001', status: 'converted', requiredDate: day('2026-11-13'), currency: 'GBP', linkedPoId: 'dc-po-1', createdAt: day('2026-11-02'), lines: { create: [{ id: 'dc-pr-1-L1', ...item, quantity: '500' }] } } })
  await prisma.purchaseRequest.create({ data: { id: 'dc-pr-2', tenantId, number: 'PR-202611-0002', status: 'approved', requiredDate: day('2026-11-30'), currency: 'GBP', createdAt: day('2026-11-16'), lines: { create: [{ id: 'dc-pr-2-L1', ...item, quantity: '12' }] } } })
  await prisma.rfq.create({ data: { id: 'dc-rfq-1', tenantId, number: 'RFQ-202611-0001', title: 'Heart holders', status: 'closed', sourceRequestId: 'dc-pr-1', linkedPoId: 'dc-po-1', awardedSupplier: 'Acme Components', currency: 'GBP', dueDate: day('2026-11-03'), createdAt: day('2026-11-02') } })
  const order = (id, number, { status, created, lines, ...rest }) => prisma.purchaseOrder.create({ data: { id, tenantId, number, status, supplierId: 'dc-sup-1', supplierName: 'Acme Components', currency: 'GBP', createdAt: new Date(created), ...rest, lines: { create: lines } } })
  await order('dc-po-1', 'PO-202611-0001', { status: 'partially_received', created: '2026-11-04T09:00:00Z', issuedAt: new Date('2026-11-04T10:00:00Z'), sourceRequestId: 'dc-pr-1', sourceRfqId: 'dc-rfq-1', amount: '1250', lines: [{ id: 'dc-po-1-L1', ...item, orderedQuantity: '500', receivedQuantity: '280', unitPrice: '2.5', amount: '1250', metadata: { promisedDate: '2026-11-13' } }] })
  // A later order from the same supplier at the invoice's price: the price moved.
  await order('dc-po-3', 'PO-202611-0003', { status: 'issued', created: '2026-11-15T09:00:00Z', issuedAt: new Date('2026-11-15T10:00:00Z'), amount: '258', lines: [{ id: 'dc-po-3-L1', ...item, orderedQuantity: '100', receivedQuantity: '0', unitPrice: '2.58', amount: '258', metadata: { promisedDate: '2026-11-28' } }] })
  const receipt = (id, number, warehouseId, arrived, accepted, rejected) => prisma.receivingDocument.create({ data: {
    id, tenantId, documentNumber: number, poId: 'dc-po-1', supplierId: 'dc-sup-1', supplierName: 'Acme Components', status: 'received', workflowStatus: 'posted', postingStatus: 'posted',
    warehouseId, currency: 'GBP', arrivedAt: new Date(`${arrived}T07:00:00Z`), postedAt: new Date(`${arrived}T07:10:00Z`),
    lines: { create: [{ id: `${id}-L1`, purchaseOrderLineId: 'dc-po-1-L1', ...item, acceptedQty: accepted, rejectedQty: rejected, warehouseId }] },
  } })
  await receipt('dc-grn-1', 'GRN-202611-0001', 'dc-wh-1', '2026-11-06', '200', '0')
  await receipt('dc-grn-2', 'GRN-202611-0002', 'dc-wh-2', '2026-11-10', '80', '5')
  const invoice = (id, number, { receiptId, status, matchStatus, quantity, price, total, variance, invoiceDate, dueDate }) => prisma.supplierInvoice.create({ data: {
    id, tenantId, invoiceNumber: number, supplierId: 'dc-sup-1', supplierName: 'Acme Components', relatedPoId: 'dc-po-1', relatedGrnId: receiptId, invoiceDate: day(invoiceDate), dueDate: day(dueDate),
    totalAmount: total, amount: total, currency: 'GBP', status, matchStatus, varianceAmount: variance,
    lines: { create: [{ id: `${id}-L1`, lineNumber: 1, purchaseOrderLineId: 'dc-po-1-L1', receivingLineId: `${receiptId}-L1`, ...item, quantity, unitPrice: price, lineAmount: total, amount: total }] },
  } })
  await invoice('dc-inv-31', 'INV-SUP-22-0031', { receiptId: 'dc-grn-1', status: 'approved', matchStatus: 'matched', quantity: '200', price: '2.5', total: '500', variance: '0', invoiceDate: '2026-11-07', dueDate: '2026-11-16' })
  await invoice('dc-inv-49', 'INV-SUP-22-0049', { receiptId: 'dc-grn-2', status: 'exception', matchStatus: 'exception', quantity: '80', price: '2.58', total: '206.4', variance: '6.4', invoiceDate: '2026-11-11', dueDate: '2026-12-11' })
  await prisma.payableObligation.create({ data: { id: 'dc-ap-31', tenantId, supplierInvoiceId: 'dc-inv-31', obligationNumber: 'AP-202611-0001', originalAmount: '500', outstandingAmount: '500', currency: 'GBP', dueDate: day('2026-11-16'), status: 'approved', approvedAt: day('2026-11-08') } })
  await prisma.threeWayMatch.create({ data: { id: 'dc-twm-49', tenantId, invoiceId: 'dc-inv-49', poId: 'dc-po-1', grnId: 'dc-grn-2', supplierId: 'dc-sup-1', supplierName: 'Acme Components', poAmount: '200', invoiceAmount: '206.4', varianceAmount: '6.4', currency: 'GBP', status: 'exception' } })
  await prisma.threeWayMatchLine.create({ data: {
    id: 'dc-twml-49', matchId: 'dc-twm-49', supplierInvoiceLineId: 'dc-inv-49-L1', purchaseOrderLineId: 'dc-po-1-L1', receivingLineId: 'dc-grn-2-L1', itemId: 'dc-item-1', sku: '85123A', unit: 'pcs',
    orderedQuantity: '500', receivedQuantity: '80', previouslyInvoicedQuantity: '0', invoiceQuantity: '80', poUnitPrice: '2.5', invoiceUnitPrice: '2.58', poLineAmount: '200', invoiceLineAmount: '206.4',
    quantityVariance: '0', priceVariance: '0.08', amountVariance: '6.4', currency: 'GBP', status: 'exception',
  } })
  await prisma.financeMatchException.create({ data: { id: 'dc-fme-49', tenantId, matchId: 'dc-twm-49', matchLineId: 'dc-twml-49', supplierInvoiceId: 'dc-inv-49', exceptionType: 'price', status: 'open', expectedValue: '2.5', actualValue: '2.58', varianceValue: '0.08', currency: 'GBP' } })
}

test('trace_document_chain follows PR, RFQ, PO, receipts, a held invoice and a payable in the database, each role seeing only what it may', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await seed(prisma)
    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const asUser = async (key) => {
      const ctx = { repositories, identity: { authenticated: true, tenantId, userId: `${tenantId}-${key}`, role: users[key], source: 'local_session' }, dataMode: 'user', env, db: {}, aiSkillPrisma: prisma, aiSkillNow: NOW }
      const context = await loadAiSkillContext(ctx)
      const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
      return { context, facts, trace: (document) => runAiReadTool('trace_document_chain', { document }, { facts, context }) }
    }
    const state = async () => Object.fromEntries(await Promise.all(counted.map(async (model) => [model, await prisma[model].count()])))
    const before = await state()
    const numbers = (result) => result.nodes.map((node) => node.number)
    const nodeOf = (result, number) => result.nodes.find((node) => node.number === number)

    // The administrator: the whole chain from the held invoice.
    const admin = await asUser('admin')
    assert.ok(aiReadToolsFor(admin.facts, admin.context).some((tool) => tool.name === 'trace_document_chain'))
    const held = await admin.trace('INV-SUP-22-0049')
    assert.equal(held.ok, true, JSON.stringify(held))
    const result = held.result
    assert.deepEqual(numbers(result), ['PR-202611-0001', 'RFQ-202611-0001', 'PO-202611-0001', 'GRN-202611-0001', 'GRN-202611-0002', 'INV-SUP-22-0031', 'INV-SUP-22-0049'])
    assert.deepEqual(result.links.map((link) => `${link.from} ${link.relation} ${link.to}`).sort(), [
      'GRN-202611-0001 invoiced_by INV-SUP-22-0031', 'GRN-202611-0002 invoiced_by INV-SUP-22-0049',
      'PO-202611-0001 invoiced_by INV-SUP-22-0031', 'PO-202611-0001 invoiced_by INV-SUP-22-0049',
      'PO-202611-0001 received_by GRN-202611-0001', 'PO-202611-0001 received_by GRN-202611-0002',
      'PR-202611-0001 converted_to_po PO-202611-0001', 'PR-202611-0001 sourced_by_rfq RFQ-202611-0001', 'RFQ-202611-0001 awarded_to_po PO-202611-0001',
    ])
    assert.doesNotMatch(JSON.stringify(result), /PR-202611-0002/)
    const order = nodeOf(result, 'PO-202611-0001')
    assert.deepEqual([order.status, order.supplier, order.dueDate, order.overdueDays, order.amount, order.lines[0].remaining], ['partially_received', 'Acme Components', '2026-11-13', 5, 1250, 220])
    const invoice = nodeOf(result, 'INV-SUP-22-0049')
    assert.deepEqual([invoice.status, invoice.matchStatus, invoice.nextStep, invoice.preparedStep], ['exception', 'exception', 'bill_exception', 'review_price'])
    assert.deepEqual(invoice.differences, [{ kind: 'price', sku: '85123A', unit: 'pcs', cause: 'price_changed', expected: 2.5, actual: 2.58, variance: 0.08, percent: 3.2, evidenceOrder: 'PO-202611-0003' }])
    assert.deepEqual(nodeOf(result, 'INV-SUP-22-0031').payable, { number: 'AP-202611-0001', status: 'approved', outstanding: 500, currency: 'GBP', dueDate: '2026-11-16', overdueDays: 2 })
    assert.deepEqual(result.openPoints.map((point) => [point.number, point.kind, point.text]), [
      ['INV-SUP-22-0049', 'held_at_match', 'Held by a match exception: price +3.2% on 85123A'],
      ['PO-202611-0001', 'late_to_receive', '220 pcs of 85123A still to receive, 5 days past the promised date 2026-11-13'],
      ['GRN-202611-0002', 'rejected', '5 pcs of 85123A rejected'],
      ['INV-SUP-22-0031', 'payment_overdue', 'Not paid, 2 days past its due date 2026-11-16'],
    ])
    // From the request the chain is the same; the approved request with
    // nothing after it has its own open point.
    assert.deepEqual(numbers((await admin.trace('PR-202611-0001')).result), numbers(result))
    assert.deepEqual((await admin.trace('PR-202611-0002')).result.openPoints.map((point) => point.kind), ['no_order_yet'])
    assert.deepEqual(await admin.trace('INV-SUP-99-0001'), { ok: false, error: 'not_found' })
    // An answer from the result passes the grounding check.
    const answer = { answer: 'INV-SUP-22-0049 is held by a match exception: its price is 3.2% above PO-202611-0001, and PO-202611-0003 already has 2.58. 220 pcs of 85123A are still to receive, 5 days past 2026-11-13. INV-SUP-22-0031 (AP-202611-0001) is 2 days overdue.' }
    assert.deepEqual(checkAiModelFirstGrounding({ answer, results: [result], refs: aiReadToolRefs(result), question: 'Why is INV-SUP-22-0049 held?', today: TODAY }).problems, [])

    // A viewer: no prices, amounts or invoice suppliers.
    const viewer = await asUser('viewer')
    const seen = (await viewer.trace('INV-SUP-22-0049')).result
    assert.deepEqual(seen.hidden, { prices: true, invoiceAmounts: true, invoiceSuppliers: true })
    assert.deepEqual(nodeOf(seen, 'INV-SUP-22-0049').differences, [{ kind: 'price', sku: '85123A', unit: 'pcs' }])
    assert.equal(nodeOf(seen, 'PO-202611-0001').amount, undefined)
    assert.doesNotMatch(JSON.stringify(seen), /1250|206\.4|2\.58|"outstanding"/)

    // A buyer reads no finance page: no invoice, and the held one is not found.
    const buyer = await asUser('buyer')
    const bought = (await buyer.trace('PO-202611-0001')).result
    assert.deepEqual(numbers(bought), ['PR-202611-0001', 'RFQ-202611-0001', 'PO-202611-0001', 'GRN-202611-0001', 'GRN-202611-0002'])
    assert.ok(bought.notShown.includes('supplier_invoices'))
    assert.doesNotMatch(JSON.stringify(bought), /INV-SUP|AP-2026/)
    assert.deepEqual(await buyer.trace('INV-SUP-22-0049'), { ok: false, error: 'not_found' })

    // The east user reads the main warehouse only: the overflow receipt is left out.
    const east = await asUser('east')
    const scoped = (await east.trace('INV-SUP-22-0049')).result
    assert.deepEqual(numbers(scoped), ['PR-202611-0001', 'RFQ-202611-0001', 'PO-202611-0001', 'GRN-202611-0001', 'INV-SUP-22-0031', 'INV-SUP-22-0049'])
    assert.equal(scoped.receiptsInYourWarehousesOnly, true)
    assert.doesNotMatch(JSON.stringify(scoped), /GRN-202611-0002/)
    assert.deepEqual(await east.trace('GRN-202611-0002'), { ok: false, error: 'not_found' })

    assert.deepEqual(await state(), before, 'nothing was written')
  } finally {
    await prisma.$disconnect()
  }
})
