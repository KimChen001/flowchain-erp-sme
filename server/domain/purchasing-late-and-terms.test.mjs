import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPurchaseOrderDocument, supplierPaymentTerms } from '../../shared/business-documents.mjs'
import { createPurchaseOrderDocumentReadService } from './purchase-order-document-read-service.mjs'

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
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'paymentTerm'), [['paymentTerm', { tenantId: 'tenant-doc' }]])
  calls.length = 0
  const none = await createPurchaseOrderDocumentReadService({ prisma: prismaWith({}) }).readPurchaseOrderDocument({ tenantId: 'tenant-doc', order, access: { prices: true } })
  assert.equal(none.paymentTerms, null)
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'paymentTerm'))
})

test('the PO list says when only overdue orders show, and offers them when not', () => {
  const page = read('src/modules/purchasing/Page.tsx')
  // One rule for the filter and the count.
  assert.match(page, /const overdueOpen = \(order: PurchaseOrder\) => Boolean\(\(summary\?\.openPurchaseOrderIds \|\| \[\]\)\.includes\(order\.po\) && workspaceToday && dueOf\(order\) && String\(dueOf\(order\)\) < workspaceToday\)/)
  assert.match(page, /if \(overdueOnly && !overdueOpen\(order\)\) return false;/)
  assert.match(page, /const overdueCount = orders\.filter\(overdueOpen\)\.length;/)
  assert.match(page, /data-testid="po-list-overdue-only"/)
  assert.match(page, /data-testid="po-list-overdue-offer"/)
  assert.match(page, /say\("Show all orders", "显示全部订单"\)/)
  assert.match(page, /say\("Show only these", "只看这些"\)/)
})

test('a late order\'s page points to the follow-up drafted on Today', () => {
  const page = read('src/modules/purchasing/Page.tsx')
  assert.match(page, /helper: delayed \? <>\{delayNote\}\{" "\}<button type="button"[^>]*data-testid="po-late-follow-up" onClick=\{\(\) => routerNavigate\("\/app\/overview\/risks"\)\}>\{say\("Follow up with the supplier on Today", "在今日页催办供应商"\)\}<\/button><\/> : delayNote/)
})
