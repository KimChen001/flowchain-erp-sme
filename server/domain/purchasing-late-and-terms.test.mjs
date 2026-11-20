import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPurchaseOrderDocument, supplierPaymentTerms } from '../../shared/business-documents.mjs'
import { createPurchaseOrderDocumentReadService } from './purchase-order-document-read-service.mjs'
import { isOverdueOpen, todayChasesOrder } from '../../src/modules/purchasing/lateOrders.ts'

// Product review 2026-11-20, items 13, 17 and 29.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const order = { id: 'PO-1', status: 'approved', supplierId: 'SUP-1', currency: 'USD', lines: [], metadata: { targetWarehouseId: 'WH-1' } }
const TERMS = [{ id: 'PT-30', code: 'NET30', name: 'Net 30 days' }, { id: 'PT-60', code: 'NET60', name: 'Net 60 days' }]

test('the PO printout carries the payment terms recorded on the supplier, by their name, and none when none were recorded', () => {
  const doc = (metadata) => buildPurchaseOrderDocument({ order, supplier: { id: 'SUP-1', name: 'Harbor', metadata }, paymentTerms: TERMS, access: { prices: true } })
  assert.equal(doc({ paymentTermsId: 'PT-60' }).paymentTerms, 'Net 60 days')
  assert.equal(doc({ paymentTermsId: 'NET30' }).paymentTerms, 'Net 30 days')
  // Older records kept the text itself.
  assert.equal(doc({ paymentTerms: '45 days end of month' }).paymentTerms, '45 days end of month')
  // Nothing recorded: nothing printed, never NET30.
  assert.equal(doc({}).paymentTerms, null)
  assert.equal(buildPurchaseOrderDocument({ order, access: { prices: true } }).paymentTerms, null)
  assert.equal(supplierPaymentTerms(null), null)
  // The page prints it as the customer invoice does.
  assert.match(read('src/modules/business-documents/PurchaseOrderDocumentPage.tsx'), /\{doc\.paymentTerms && \(\s*<div data-testid="po-document-payment-terms">/)
  assert.doesNotMatch(read('shared/business-documents.mjs'), /defaults to NET30 and so is never printed/)
})

test('the read service reads the workspace\'s payment terms only when the supplier has one recorded', async () => {
  const calls = []
  const model = (name, row) => ({
    findUnique: async (args) => { calls.push(name); return row },
    findFirst: async (args) => { calls.push(name); return row },
    findMany: async (args) => { calls.push([name, args.where]); return row },
  })
  const prismaWith = (metadata) => ({
    tenant: model('tenant', { name: 'Harbor Goods', operationalSettings: {} }),
    supplier: model('supplier', { id: 'SUP-1', name: 'Harbor', metadata }),
    warehouse: model('warehouse', { id: 'WH-1', code: 'OAK', name: 'Oakland DC' }),
    runtimeRecord: model('runtimeRecord', []),
    paymentTerm: model('paymentTerm', TERMS),
  })
  const recorded = await createPurchaseOrderDocumentReadService({ prisma: prismaWith({ paymentTermsId: 'PT-30' }) }).readPurchaseOrderDocument({ tenantId: 'tenant-doc', order, access: { prices: true } })
  assert.equal(recorded.paymentTerms, 'Net 30 days')
  // Only the term the supplier names, in this workspace (readPaymentTerms, as the customer invoice).
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'paymentTerm'), [['paymentTerm', { tenantId: 'tenant-doc', OR: [{ id: 'PT-30' }, { code: 'PT-30' }] }]])
  calls.length = 0
  const none = await createPurchaseOrderDocumentReadService({ prisma: prismaWith({}) }).readPurchaseOrderDocument({ tenantId: 'tenant-doc', order, access: { prices: true } })
  assert.equal(none.paymentTerms, null)
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'paymentTerm'))
})

test('the PO list says when only overdue orders show, and offers them within the other filters', () => {
  const page = read('src/modules/purchasing/Page.tsx')
  assert.match(page, /const overdueOpen = \(order: PurchaseOrder\) => isOverdueOpen\(Boolean\(openOrderIds\?\.has\(order\.po\)\)/)
  // One set for the other filters: the count is what "Show only these" shows.
  assert.match(page, /const filtered = overdueOnly \? matchingOtherFilters\.filter\(overdueOpen\) : matchingOtherFilters;/)
  assert.match(page, /const overdueCount = matchingOtherFilters\.filter\(overdueOpen\)\.length;/)
  assert.match(page, /data-testid="po-list-overdue-only"/)
  assert.match(page, /data-testid="po-list-overdue-offer"/)
  assert.match(page, /say\("Show all orders", "显示全部订单"\)/)
  assert.match(page, /say\("Show only these", "只看这些"\)/)
})

test('overdue is open and due before the workspace day; Today chases only issued or partly received ones', () => {
  assert.equal(isOverdueOpen(true, '2026-11-19', '2026-11-20'), true)
  // Due today is not late, whatever the browser's clock says.
  assert.equal(isOverdueOpen(true, '2026-11-20', '2026-11-20'), false)
  assert.equal(isOverdueOpen(false, '2026-11-01', '2026-11-20'), false)
  assert.equal(isOverdueOpen(true, null, '2026-11-20'), false)
  assert.equal(isOverdueOpen(true, '2026-11-01', null), false)
  for (const status of ['issued', 'partially_received']) assert.equal(todayChasesOrder(status, true, '2026-11-01', '2026-11-20'), true, status)
  // Draft, pending, rejected and approved-but-unsent orders are never chased.
  for (const status of ['draft', 'pending_approval', 'rejected', 'approved', 'cancelled', 'closed', 'fully_received']) {
    assert.equal(todayChasesOrder(status, true, '2026-11-01', '2026-11-20'), false, status)
  }
  assert.equal(todayChasesOrder('issued', true, '2026-11-20', '2026-11-20'), false)
  assert.equal(todayChasesOrder('issued', false, '2026-11-01', '2026-11-20'), false)
})

test("a late order's page points to the follow-up drafted on Today, by that rule, with a real link", () => {
  const page = read('src/modules/purchasing/Page.tsx')
  assert.match(page, /const chasedOnToday = todayChasesOrder\(purchaseOrderStatusCode\(selectedPO\.status\), Boolean\(openOrderIds\?\.has\(selectedPO\.po\)\), dueOf\(selectedPO\) \? String\(dueOf\(selectedPO\)\) : null, workspaceToday\);/)
  assert.match(page, /helper: chasedOnToday \? <>\{delayNote\}\{" "\}<Link to="\/app\/overview\/risks#today-decisions"[^>]*data-testid="po-late-follow-up">\{say\("Follow up with the supplier on Today", "在今日页催办供应商"\)\}<\/Link><\/> : delayNote/)
})
