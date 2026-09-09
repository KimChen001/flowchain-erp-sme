import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createSupplierActionSummaryReadService } from '../../server/domain/supplier-action-summary-read-service.mjs'

const tenantId = 'tenant-ai-cross-domain'
const otherTenantId = 'tenant-ai-cross-domain-other'
const now = new Date('2026-07-24T08:00:00.000Z')
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_BANK_RECONCILIATION: 'true' }
const permissions = [
  'finance.payable.read', 'finance.supplier_invoice.read', 'finance.settlement.read', 'finance.cashbook.read',
  'finance.bank_reconciliation.read', 'finance.amounts.read', 'finance.partner_snapshot.read',
  'procurement.purchase_order.read', 'receiving.read',
]

function actor(permissionCodes = permissions) {
  return {
    complete: true,
    authenticated: true,
    tenantId,
    userId: 'ai-cross-domain-reader',
    roleIds: ['ai-cross-domain-test-role'],
    inactiveRoleIds: [],
    permissionCodes: new Set(permissionCodes),
    permissionSourceRoleIds: new Map(),
    readWarehouseIds: new Set(["AI-WAREHOUSE"]),
    operateWarehouseIds: new Set(),
  }
}

const invoice = (id, supplierId, data = {}) => ({
  id,
  tenantId,
  invoiceNumber: `INV-${id}`,
  supplierId,
  amount: data.amount ?? '100.0000',
  totalAmount: data.amount ?? '100.0000',
  currency: 'CNY',
  status: data.status || 'approved',
  matchStatus: data.matchStatus || 'matched',
  varianceAmount: data.varianceAmount ?? '0.0000',
  relatedPoId: data.relatedPoId || null,
  relatedGrnId: data.relatedGrnId || null,
})

const payable = (id, supplierInvoiceId, data = {}) => ({
  id,
  tenantId,
  supplierInvoiceId,
  obligationNumber: `PAY-${id}`,
  originalAmount: data.originalAmount ?? data.outstandingAmount ?? '100.0000',
  outstandingAmount: data.outstandingAmount ?? '100.0000',
  currency: 'CNY',
  dueDate: data.dueDate || now,
  status: data.status || 'approved',
  heldAt: data.heldAt || null,
})

async function seed(prisma) {
  await prisma.tenant.createMany({ data: [
    { id: tenantId, name: 'AI Cross-domain Tenant', currency: 'CNY' },
    { id: otherTenantId, name: 'Other AI Tenant', currency: 'CNY' },
  ] })
  await prisma.supplier.createMany({ data: [
    ...['A', 'B', 'C', 'D', 'E', 'F'].map((suffix) => ({ id: `supplier-${suffix.toLowerCase()}`, tenantId, code: suffix, name: `Supplier ${suffix}` })),
    { id: 'supplier-cross-tenant', tenantId: otherTenantId, code: 'X', name: 'Cross Tenant Supplier' },
  ] })

  const invoices = [
    invoice('a-ready', 'supplier-a'),
    invoice('a-future', 'supplier-a'),
    invoice('a-partial', 'supplier-a'),
    invoice('a-settled', 'supplier-a'),
    invoice('b-disputed', 'supplier-b', { status: 'disputed', matchStatus: 'mismatch', varianceAmount: '25.0000' }),
    invoice('b-held', 'supplier-b'),
  ]
  for (const item of invoices) await prisma.supplierInvoice.create({ data: item })
  const payables = [
    payable('a-ready', 'a-ready', { dueDate: new Date('2026-07-24T04:00:00.000Z') }),
    payable('a-future', 'a-future', { dueDate: new Date('2026-08-12T04:00:00.000Z') }),
    payable('a-partial', 'a-partial', { status: 'partially_settled', outstandingAmount: '30.0000', dueDate: new Date('2026-07-20T04:00:00.000Z') }),
    payable('a-settled', 'a-settled', { status: 'settled', outstandingAmount: '0.0000', dueDate: new Date('2026-07-10T04:00:00.000Z') }),
    payable('b-disputed', 'b-disputed', { dueDate: new Date('2026-07-18T04:00:00.000Z') }),
    payable('b-held', 'b-held', { status: 'held', heldAt: new Date('2026-07-23T04:00:00.000Z') }),
  ]
  for (const item of payables) await prisma.payableObligation.create({ data: item })

  await prisma.purchaseOrder.create({ data: {
    id: 'PO-C-OVERDUE', tenantId, supplierId: 'supplier-c', supplierName: 'Supplier C', status: 'issued',
    expectedDate: new Date('2026-07-10T04:00:00.000Z'), currency: 'CNY', amount: '500.0000',
    lines: { create: [{ id: 'PO-C-L1', orderedQuantity: '10.0000', receivedQuantity: '10.0000' }] },
  } })
  await prisma.purchaseOrder.create({ data: {
    id: 'PO-D-PARTIAL', tenantId, supplierId: 'supplier-d', supplierName: 'Supplier D', status: 'issued',
    expectedDate: new Date('2026-07-27T04:00:00.000Z'), currency: 'CNY', amount: '300.0000',
    lines: { create: [{ id: 'PO-D-L1', orderedQuantity: '10.0000', receivedQuantity: '4.0000' }] },
  } })
  await prisma.purchaseOrder.create({ data: {
    id: 'PO-INCOMPLETE', tenantId, supplierId: null, status: 'issued', currency: 'CNY',
  } })
  await prisma.receivingDocument.create({ data: {
    warehouseId: 'AI-WAREHOUSE', id: 'GRN-D-EXCEPTION', documentNumber: 'GRN-D-EXCEPTION', tenantId, poId: 'PO-D-PARTIAL', supplierId: 'supplier-d',
    status: 'exception', workflowStatus: 'draft', postingStatus: 'unposted', currency: 'CNY',
    lines: { create: [{ id: 'GRN-D-L1', acceptedQty: '4.0000', rejectedQty: '2.0000' }] },
  } })
  await prisma.rfq.create({ data: {
    id: 'RFQ-E-AWAITING', tenantId, title: 'Supplier E RFQ', supplierId: 'supplier-e', status: 'active',
    supplierCount: 3, respondedSupplierCount: 1, dueDate: new Date('2026-07-22T04:00:00.000Z'), currency: 'CNY',
  } })
  await prisma.cashbookAccount.create({ data: {
    id: 'AI-CASHBOOK', tenantId, accountCode: 'AI-CASHBOOK', name: 'AI Test Cashbook', accountType: 'bank', currency: 'CNY',
  } })
  await prisma.settlementDocument.create({ data: {
    id: 'SET-B-UNPOSTED', tenantId, settlementNumber: 'SET-B-UNPOSTED', direction: 'disbursement', counterpartyType: 'supplier',
    counterpartyId: 'supplier-b', counterpartyNameSnapshot: 'Supplier B', cashbookAccountId: 'AI-CASHBOOK', currency: 'CNY',
    amount: '25.0000', settlementDate: new Date('2026-07-23T04:00:00.000Z'), status: 'draft', workflowStatus: 'approved', postingStatus: 'unposted',
  } })
  await prisma.settlementAllocation.create({ data: {
    id: 'ALLOC-B-UNPOSTED', tenantId, settlementId: 'SET-B-UNPOSTED', obligationType: 'payable', payableObligationId: 'b-disputed',
    amount: '25.0000', cashAppliedAmount: '25.0000', totalSettlementAmount: '25.0000', currency: 'CNY',
  } })
  await prisma.supplierInvoice.create({ data: { ...invoice('cross-tenant', 'supplier-cross-tenant'), tenantId: otherTenantId } })
}

function safeBankService() {
  return { listExceptions: async () => ({ items: [{
    id: 'BANK-F-BLOCK', supplierId: 'supplier-f', exceptionType: 'unreconciled_payment', status: 'open', severity: 'blocking',
  }] }) }
}

test('real PostgreSQL supplier action summary returns authoritative cross-domain facts in stable order', async () => {
  const prisma = await createPrismaClient(env)
  try {
    await seed(prisma)
    const service = createSupplierActionSummaryReadService({ prisma, env, now: () => now, bankService: safeBankService() })
    const full = await service.read({}, { actor: actor() })
    const byId = Object.fromEntries(full.items.map((item) => [item.supplier.id, item]))

    assert.equal(full.items.length, 6)
    assert.equal(byId['supplier-a'].payment.dueCount, 3)
    assert.equal(byId['supplier-a'].payment.readyCount, 3)
    assert.equal(byId['supplier-a'].payment.dueAmount, 230)
    assert.equal(byId['supplier-b'].payment.blockedCount, 2)
    assert.ok(byId['supplier-b'].payment.blocks.some((item) => item.reason === 'invoice_disputed'))
    assert.ok(byId['supplier-b'].payment.blocks.some((item) => item.reason === 'payment_hold'))
    assert.ok(byId['supplier-b'].payment.blocks.some((item) => item.reason === 'settlement_not_posted'))
    assert.equal(byId['supplier-c'].procurement.overduePoCount, 1)
    assert.deepEqual(byId['supplier-c'].procurement.overduePoIds, ['PO-C-OVERDUE'])
    assert.equal(byId['supplier-d'].procurement.unreceivedPoCount, 1)
    assert.equal(byId['supplier-d'].receiving.exceptionCount, 1)
    assert.equal(byId['supplier-d'].receiving.rejectedQuantity, 2)
    assert.equal(byId['supplier-e'].rfq.awaitingResponseCount, 1)
    assert.equal(byId['supplier-e'].rfq.expiredCount, 1)
    assert.equal(byId['supplier-f'].reconciliation.blockingExceptionCount, 1)
    assert.ok(byId['supplier-f'].recommendedActions.includes('review_bank_reconciliation_exceptions'))
    assert.ok(full.recordValiditySummary.incompleteCount >= 1)
    assert.ok(full.items.every((item) => item.priority.algorithmVersion === 'supplier-action-priority-v1'))
    assert.ok(full.items.flatMap((item) => item.evidence).every((item) => item.id && item.route))
    assert.ok(!full.items.some((item) => item.supplier.id === 'supplier-cross-tenant'))

    const restricted = await service.read({}, { actor: { ...actor(), readWarehouseIds: new Set() } })
    assert.equal(restricted.items.find(item => item.supplier.id === 'supplier-d').receiving.exceptionCount, 0)
    assert.ok(!JSON.stringify(restricted).includes('GRN-D-EXCEPTION'))

    const repeated = await service.read({}, { actor: actor() })
    assert.deepEqual(repeated.items.map((item) => item.supplier.id), full.items.map((item) => item.supplier.id))
  } finally {
    await prisma.$disconnect()
  }
})

test('PostgreSQL read model preserves permission, redaction, and capability states', async () => {
  const prisma = await createPrismaClient(env)
  try {
    const service = createSupplierActionSummaryReadService({ prisma, env, now: () => now, bankService: safeBankService() })
    const redactedPermissions = permissions.filter((code) => !['finance.amounts.read', 'finance.partner_snapshot.read'].includes(code))
    const redacted = await service.read({}, { actor: actor(redactedPermissions) })
    assert.ok(redacted.items.length > 0)
    assert.ok(redacted.items.every((item) => item.supplier.name === null && item.supplier.displayName === '受限供应商'))
    assert.ok(redacted.items.every((item) => item.payment.dueAmount === null && item.payment.overdueAmount === null))
    assert.ok(redacted.items.some((item) => Number.isInteger(item.payment.dueCount)))

    const noPayable = await service.read({}, { actor: actor(permissions.filter((code) => code !== 'finance.payable.read')) })
    assert.ok(noPayable.items.every((item) => item.payment.state === 'hidden'))
    assert.ok(noPayable.items.every((item) => item.payment.dueCount === null))

    const unavailableBank = createSupplierActionSummaryReadService({
      prisma,
      env,
      now: () => now,
      bankService: { listExceptions: async () => { const error = new Error('disabled'); error.code = 'BANK_RECONCILIATION_CAPABILITY_NOT_AVAILABLE'; throw error } },
    })
    const unavailable = await unavailableBank.read({}, { actor: actor() })
    assert.ok(unavailable.items.every((item) => item.reconciliation.state === 'unavailable'))
    assert.ok(unavailable.items.every((item) => item.reconciliation.blockingExceptionCount === null))
  } finally {
    await prisma.$disconnect()
  }
})
