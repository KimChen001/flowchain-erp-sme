import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createOperationalFinanceO2cCommandService } from './operational-finance-o2c-command-service.mjs'
import {
  CANCELLABLE_CUSTOMER_INVOICE_STATUSES,
  CUSTOMER_INVOICE_PAYMENT_STATUSES,
  canCancelCustomerInvoice,
  createOperationalFinanceO2cReadService,
  customerInvoicePaymentStatus,
} from './operational-finance-o2c-read-service.mjs'
import { buildHomeOverview } from '../services/business-read-context-service.mjs'
import { documentStatusLabel, statusCodeLabel } from '../../src/i18n/statusLabels.ts'

// Round 8b of the UI review, finance (the order-to-cash walk, 2026-11-12): a
// shipment already invoiced and paid could be drafted again and the draft
// then sat for good; a paid customer invoice read "Issued" everywhere; the
// invoice page said "No action is available" next to an action; the payment
// form led with Check and ACH in a GBP workspace behind a Preview step; and
// the invoice document scrolled sideways on a phone.

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const TENANT = 'tenant-8b-finance'
const USER = 'user-8b-finance'
const identity = { authenticated: true, tenantId: TENANT, userId: USER, role: 'manager' }
const env = { FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true' }
const userWith = (permissions) => ({
  id: USER, tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [],
  roleAssignments: [{ status: 'active', role: { id: 'role-finance', roleKey: 'finance', name: 'Finance', status: 'active', permissions: permissions.map((permissionCode) => ({ permissionCode })) } }],
})
const PREPARER = ['finance.customer_invoice.read', 'finance.customer_invoice.create', 'finance.customer_invoice.submit']

// A stand-in for the Prisma calls the cancel command makes, with a
// transaction that rolls back every change when its work throws.
function commandPrisma({ invoice, permissions = PREPARER }) {
  const state = { invoice: { ...invoice }, executions: [], audits: [] }
  const executionKey = (where) => [where.tenantId, where.commandType, where.idempotencyKey].join('|')
  let ids = 0
  const client = {
    user: { findFirst: async ({ where }) => (where.id === USER && where.tenantId === TENANT ? userWith(permissions) : null) },
    businessCommandExecution: {
      findUnique: async ({ where }) => state.executions.find((row) => executionKey(row) === executionKey(where.tenantId_commandType_idempotencyKey)) || null,
      create: async ({ data }) => { const row = { ...data }; state.executions.push(row); return row },
      update: async ({ where, data }) => { const row = state.executions.find((entry) => entry.id === where.id); Object.assign(row, data); return row },
    },
    customerInvoice: {
      findFirst: async ({ where }) => (where.id === state.invoice.id && where.tenantId === state.invoice.tenantId ? { ...state.invoice } : null),
      findUnique: async ({ where }) => (where.id === state.invoice.id ? { ...state.invoice } : null),
      update: async ({ where, data }) => {
        assert.equal(where.id, state.invoice.id)
        const { version, ...rest } = data
        state.invoice = { ...state.invoice, ...rest, version: state.invoice.version + (version?.increment || 0) }
        return { ...state.invoice }
      },
    },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data } },
    $queryRawUnsafe: async (_sql, tenantId, id) => (tenantId === state.invoice.tenantId && id === state.invoice.id ? [{ id }] : []),
    $transaction: async (work) => {
      const saved = structuredClone({ invoice: state.invoice, executions: state.executions, audits: state.audits })
      try {
        return await work(client)
      } catch (error) {
        Object.assign(state, saved)
        throw error
      }
    },
  }
  const service = createOperationalFinanceO2cCommandService({ prisma: client, env, idFactory: () => `id-${++ids}`, now: () => new Date('2026-11-12T10:00:00Z') })
  return { service, state }
}
const draft = (extra = {}) => ({ id: 'ci-1', tenantId: TENANT, invoiceNumber: 'CI-202611-0110', customerNameSnapshot: 'Customer 12748', salesOrderId: 'so-1', shipmentId: 'dn-1', status: 'draft', totalAmount: '112.5000', currency: 'GBP', version: 0, issuedAt: null, ...extra })
const context = { identity }

test('a draft or submitted customer invoice that was never issued can be cancelled, with a reason', async () => {
  assert.deepEqual([...CANCELLABLE_CUSTOMER_INVOICE_STATUSES], ['draft', 'submitted'])
  for (const status of ['draft', 'submitted']) {
    const { service, state } = commandPrisma({ invoice: draft({ status, version: 2 }) })
    const plan = await service.previewCancelCustomerInvoice('ci-1', { expectedVersion: 2, reason: 'Duplicate of CI-202611-0108' }, context)
    assert.equal(plan.allowed, true, status)
    assert.equal(plan.nextStatus, 'cancelled')
    assert.deepEqual(plan.factsToCreate, { receivableObligations: 0, payments: 0, journalEntries: 0 })
    const result = await service.cancelCustomerInvoice('ci-1', { expectedVersion: 2, reason: 'Duplicate of CI-202611-0108', idempotencyKey: `cancel-${status}` }, context)
    assert.equal(result.invoice.status, 'cancelled')
    assert.equal(result.idempotentReplay, false)
    assert.equal(state.invoice.status, 'cancelled')
    assert.equal(state.invoice.version, 3)
    assert.equal(state.invoice.cancelledById, USER)
    assert.equal(state.invoice.cancellationReason, 'Duplicate of CI-202611-0108')
    assert.deepEqual(state.invoice.cancelledAt, new Date('2026-11-12T10:00:00Z'))
  }
})

test('an approved, issued, disputed or already cancelled invoice is never cancelled, nor one that was ever issued', async () => {
  for (const invoice of [draft({ status: 'approved' }), draft({ status: 'issued', issuedAt: new Date('2026-11-12T09:00:00Z') }), draft({ status: 'disputed' }), draft({ status: 'cancelled' }), draft({ status: 'submitted', issuedAt: new Date('2026-11-12T09:00:00Z') })]) {
    assert.equal(canCancelCustomerInvoice(invoice), false, invoice.status)
    const { service, state } = commandPrisma({ invoice })
    const plan = await service.previewCancelCustomerInvoice('ci-1', { expectedVersion: 0, reason: 'Wrong' }, context)
    assert.equal(plan.allowed, false)
    assert.equal(plan.blockingIssues[0].code, 'CUSTOMER_INVOICE_STATUS_INVALID')
    await assert.rejects(
      service.cancelCustomerInvoice('ci-1', { expectedVersion: 0, reason: 'Wrong', idempotencyKey: `refused-${invoice.status}` }, context),
      (error) => error.code === 'CUSTOMER_INVOICE_STATUS_INVALID' && error.status === 409,
    )
    // Nothing changed, nothing was audited and the key was not used up.
    assert.equal(state.invoice.status, invoice.status)
    assert.equal(state.audits.length, 0)
    assert.equal(state.executions.length, 0)
  }
})

test('cancelling needs a reason and the version the page read', async () => {
  const { service } = commandPrisma({ invoice: draft({ version: 1 }) })
  const noReason = await service.previewCancelCustomerInvoice('ci-1', { expectedVersion: 1, reason: '  ' }, context)
  assert.deepEqual(noReason.blockingIssues.map((issue) => issue.code), ['CUSTOMER_INVOICE_CANCEL_REASON_REQUIRED'])
  await assert.rejects(service.cancelCustomerInvoice('ci-1', { expectedVersion: 1, reason: '', idempotencyKey: 'no-reason' }, context), (error) => error.code === 'CUSTOMER_INVOICE_CANCEL_REASON_REQUIRED' && error.status === 422)
  await assert.rejects(service.cancelCustomerInvoice('ci-1', { expectedVersion: 0, reason: 'Stale', idempotencyKey: 'stale' }, context), (error) => error.code === 'FINANCE_VERSION_CONFLICT')
  await assert.rejects(service.cancelCustomerInvoice('missing', { expectedVersion: 0, reason: 'Gone', idempotencyKey: 'missing' }, context), (error) => error.code === 'CUSTOMER_INVOICE_NOT_FOUND' && error.status === 404)
})

test('only a role that may draft customer invoices may cancel one', async () => {
  const { service, state } = commandPrisma({ invoice: draft(), permissions: ['finance.customer_invoice.read', 'finance.customer_invoice.approve'] })
  await assert.rejects(service.previewCancelCustomerInvoice('ci-1', { expectedVersion: 0, reason: 'No' }, context), (error) => error.status === 403)
  await assert.rejects(service.cancelCustomerInvoice('ci-1', { expectedVersion: 0, reason: 'No', idempotencyKey: 'denied' }, context), (error) => error.status === 403)
  assert.equal(state.invoice.status, 'draft')
  assert.equal(state.audits.length, 0)
})

test('a repeated cancel with the same key replays the first result; another payload under that key is refused', async () => {
  const { service, state } = commandPrisma({ invoice: draft() })
  const input = { expectedVersion: 0, reason: 'Duplicate', idempotencyKey: 'cancel-once' }
  const first = await service.cancelCustomerInvoice('ci-1', input, context)
  const again = await service.cancelCustomerInvoice('ci-1', input, context)
  assert.equal(again.idempotentReplay, true)
  assert.equal(again.invoice.status, first.invoice.status)
  assert.equal(state.invoice.version, 1)
  assert.equal(state.audits.length, 1)
  assert.equal(state.executions.length, 1)
  assert.equal(state.executions[0].commandType, 'cancel_customer_invoice')
  assert.equal(state.executions[0].status, 'completed')
  await assert.rejects(service.cancelCustomerInvoice('ci-1', { ...input, reason: 'Something else' }, context), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' && error.status === 409)
})

test('the cancellation is audited with who, why, before and after, and nothing moves money', async () => {
  const { service, state } = commandPrisma({ invoice: draft({ status: 'submitted', version: 1 }) })
  await service.cancelCustomerInvoice('ci-1', { expectedVersion: 1, reason: 'Raised against the wrong shipment', idempotencyKey: 'audited' }, context)
  assert.equal(state.audits.length, 1)
  const [entry] = state.audits
  assert.equal(entry.tenantId, TENANT)
  assert.equal(entry.actorId, USER)
  assert.equal(entry.module, 'finance')
  assert.equal(entry.action, 'customer_invoice_cancelled')
  assert.equal(entry.entityType, 'CustomerInvoice')
  assert.equal(entry.entityId, 'ci-1')
  assert.equal(entry.metadata.commandType, 'cancel_customer_invoice')
  assert.equal(entry.metadata.idempotencyKey, 'audited')
  assert.equal(entry.metadata.before.status, 'submitted')
  assert.equal(entry.metadata.after.status, 'cancelled')
  assert.deepEqual(entry.metadata.evidence, { reason: 'Raised against the wrong shipment', salesOrderId: 'so-1', shipmentId: 'dn-1' })
  assert.equal(entry.metadata.paymentExecution, false)
  assert.equal(entry.metadata.ledgerMutation, false)
})

test('the route exposes cancel and cancel-preview for customer invoices, and the submit check is unchanged', () => {
  const routes = read('server/routes/operational-finance.routes.mjs')
  assert.match(routes, /issue-preview\|issue\|cancel-preview\|cancel\)\)\?\$\//)
  assert.match(routes, /"cancel-preview": "previewCancelCustomerInvoice",\s*\n\s*cancel: "cancelCustomerInvoice"/)
  const policy = read('server/domain/operational-finance-o2c-policy.mjs')
  assert.match(policy, /`Line \$\{index \+ 1\} exceeds shipped not-yet-invoiced quantity\.`/)
})

test('an issued customer invoice reads where its payment stands, from its receivable', () => {
  assert.deepEqual(Object.keys(CUSTOMER_INVOICE_PAYMENT_STATUSES), ['to_be_paid', 'partially_settled', 'settled'])
  assert.equal(customerInvoicePaymentStatus('issued', 'open'), 'to_be_paid')
  assert.equal(customerInvoicePaymentStatus('issued', 'overdue'), 'to_be_paid')
  assert.equal(customerInvoicePaymentStatus('issued', 'partially_settled'), 'partially_settled')
  assert.equal(customerInvoicePaymentStatus('issued', 'settled'), 'settled')
  assert.equal(customerInvoicePaymentStatus('issued', 'disputed'), null)
  assert.equal(customerInvoicePaymentStatus('issued', null), null)
  assert.equal(customerInvoicePaymentStatus('approved', 'settled'), null)
})

test("Today's recent documents show a customer invoice's payment state, and its Issued reads 已开具", () => {
  const context = { purchaseOrders: [{ id: 'po-1', number: 'PO-1', status: 'issued', updatedAt: '2026-11-12T08:00:00Z' }], dataLimitations: [] }
  const recentCustomerInvoices = [
    { id: 'ci-paid', invoiceNumber: 'CI-202611-0108', status: 'issued', customerName: 'Customer 12748', totalAmount: '112.5', currency: 'GBP', updatedAt: '2026-11-12T09:00:00Z' },
    { id: 'ci-part', invoiceNumber: 'CI-202611-0111', status: 'issued', receivableStatus: 'partially_settled', currency: 'GBP', updatedAt: '2026-11-12T09:01:00Z' },
    { id: 'ci-open', invoiceNumber: 'CI-202611-0112', status: 'issued', currency: 'GBP', updatedAt: '2026-11-12T09:02:00Z' },
    { id: 'ci-unread', invoiceNumber: 'CI-202611-0113', status: 'issued', currency: 'GBP', updatedAt: '2026-11-12T09:03:00Z' },
    { id: 'ci-draft', invoiceNumber: 'CI-202611-0110', status: 'cancelled', currency: 'GBP', updatedAt: '2026-11-12T09:04:00Z' },
  ]
  const overview = buildHomeOverview(context, {
    now: new Date('2026-11-12T12:00:00Z'),
    timeZone: 'Europe/London',
    sources: { recentCustomerInvoices, customerInvoiceReceivableStatuses: { 'ci-paid': 'settled', 'ci-open': 'open' } },
  })
  const status = Object.fromEntries(overview.recentDocuments.map((row) => [row.id, row.status]))
  assert.equal(status['ci-paid'], 'settled')
  assert.equal(status['ci-part'], 'partially_settled')
  assert.equal(status['ci-open'], 'to_be_paid')
  // Its receivable not read: as stored.
  assert.equal(status['ci-unread'], 'issued')
  assert.equal(status['ci-draft'], 'cancelled')
  assert.equal(status['po-1'], 'issued')
  // A customer invoice's Issued is 已开具; a purchase order's stays 已下达.
  assert.equal(documentStatusLabel('customer_invoice', 'issued', 'zh-CN'), '已开具')
  assert.equal(documentStatusLabel('customer_invoice', 'issued', 'en-US'), 'Issued')
  assert.equal(documentStatusLabel('purchase_order', 'issued', 'zh-CN'), undefined)
  assert.equal(statusCodeLabel('issued', 'zh-CN'), '已下达')
  assert.equal(statusCodeLabel('to_be_paid', 'en-US'), 'To be paid')
  assert.equal(statusCodeLabel('to_be_paid', 'zh-CN'), '待收款')
  const today = read('src/modules/overview/Page.tsx')
  assert.match(today, /label=\{documentStatusLabel\(row\.type, row\.status, t\.language\) \?\? t\.status\(row\.status\)\}/)
  assert.match(today, /status === "to_pay" \|\| status === "to_be_paid" \? "info"/)
})

// The new invoice form's data: what is already on an invoice (drafts too),
// what is left, and the order or shipment the form was opened from.
function entryPrisma() {
  const order = (id, number) => ({ id, orderNumber: number, customerId: 'UCI-CUS-12748', customerName: 'Customer 12748', currency: 'GBP' })
  const line = (id, posted) => ({ id, salesOrderLineId: `${id}-sol`, itemId: 'item-15036', sku: '15036', itemName: 'Assorted Colours Silk Fan', postedQuantity: posted, unit: 'pcs', salesOrderLine: { unitPrice: '3.7500' } })
  const shipments = [
    { id: 'dn-0108', shipmentNumber: 'DN-202611-0108', salesOrderId: 'so-0108', salesOrder: order('so-0108', 'SO-202611-0108'), postingStatus: 'posted', reversedAt: null, postedAt: new Date('2026-11-12T08:02:00Z'), lines: [line('dn-0108-1', '30.0000')] },
    { id: 'dn-0109', shipmentNumber: 'DN-202611-0109', salesOrderId: 'so-0108', salesOrder: order('so-0108', 'SO-202611-0108'), postingStatus: 'posted', reversedAt: null, postedAt: new Date('2026-11-12T08:03:00Z'), lines: [line('dn-0109-1', '14.0000')] },
    { id: 'dn-0111', shipmentNumber: 'DN-202611-0111', salesOrderId: 'so-0108', salesOrder: order('so-0108', 'SO-202611-0108'), postingStatus: 'posted', reversedAt: null, postedAt: new Date('2026-11-12T08:06:00Z'), lines: [line('dn-0111-1', '6.0000')] },
  ]
  const invoiceLines = [
    // CI-0108: issued and paid, the whole of DN-0108.
    { shipmentLineId: 'dn-0108-1', quantity: '30.0000', customerInvoice: { id: 'ci-0108', invoiceNumber: 'CI-202611-0108', status: 'issued', tenantId: TENANT } },
    // CI-0109: a draft for 10 of the 14 on DN-0109.
    { shipmentLineId: 'dn-0109-1', quantity: '10.0000', customerInvoice: { id: 'ci-0109', invoiceNumber: 'CI-202611-0109', status: 'draft', tenantId: TENANT } },
    // A cancelled one holds nothing.
    { shipmentLineId: 'dn-0111-1', quantity: '6.0000', customerInvoice: { id: 'ci-0110', invoiceNumber: 'CI-202611-0110', status: 'cancelled', tenantId: TENANT } },
  ]
  const calls = []
  const prisma = {
    user: { findFirst: async () => userWith([...PREPARER, 'finance.amounts.read']) },
    tenant: { findUnique: async () => ({ timezone: 'Europe/London' }) },
    runtimeRecord: { findMany: async () => [{ payload: { id: 'UCI-CUS-12748', paymentTerms: 'NET30' } }] },
    paymentTerm: { findMany: async () => [] },
    shipmentDocument: {
      findMany: async ({ where, take }) => {
        calls.push({ where, take })
        return shipments.filter((row) => (where.salesOrderId ? row.salesOrderId === where.salesOrderId : true) && (where.OR ? where.OR.some((part) => row.id === part.id || row.shipmentNumber === part.shipmentNumber) : true))
      },
      findFirst: async ({ where }) => shipments.find((row) => where.OR.some((part) => row.id === part.id || row.shipmentNumber === part.shipmentNumber)) || null,
    },
    salesOrder: { findFirst: async ({ where }) => (where.id === 'so-0108' ? { id: 'so-0108', orderNumber: 'SO-202611-0108' } : null) },
    customerInvoice: { findMany: async () => [] },
    customerInvoiceLine: {
      findMany: async ({ where }) => invoiceLines.filter((row) => where.shipmentLineId.in.includes(row.shipmentLineId) && where.customerInvoice.status.in.includes(row.customerInvoice.status)),
    },
    returnPostingDocument: { findMany: async () => [] },
  }
  return { prisma, calls }
}

test('the invoice form offers only shipments with something left to invoice, starting each line at what is left', async () => {
  const { prisma, calls } = entryPrisma()
  const service = createOperationalFinanceO2cReadService({ prisma, capabilities: { 'customer-invoice': { enabled: true } } })
  const all = await service.entryData({ identity })
  // DN-0108 was invoiced in full: not offered. A cancelled invoice frees DN-0111.
  assert.deepEqual(all.postedShipments.map((row) => row.shipmentNumber), ['DN-202611-0109', 'DN-202611-0111'])
  const dn0109 = all.postedShipments[0]
  assert.equal(dn0109.lines[0].invoicedQuantity, '10.0000')
  assert.equal(dn0109.lines[0].remainingQuantity, '4.0000')
  assert.deepEqual(dn0109.invoices, [{ id: 'ci-0109', invoiceNumber: 'CI-202611-0109', status: 'draft' }])
  assert.equal(all.postedShipments[1].lines[0].remainingQuantity, '6.0000')
  // The customer is on NET30, which is no payment term of the workspace: no
  // due date is made up, and the form can say why.
  assert.equal(dn0109.customerPaymentTerm, null)
  assert.equal(dn0109.customerPaymentTerms, 'NET30')
  assert.equal(calls[0].take, 400)

  // Opened from the order: all of its shipments, each saying what is left, and the order's number.
  const fromOrder = await service.entryData({ identity }, { salesOrder: 'so-0108' })
  assert.deepEqual(fromOrder.postedShipments.map((row) => [row.shipmentNumber, row.invoiceable]), [['DN-202611-0108', false], ['DN-202611-0109', true], ['DN-202611-0111', true]])
  assert.deepEqual(fromOrder.customerInvoiceSource.salesOrder, { id: 'so-0108', orderNumber: 'SO-202611-0108' })
  // Opened from a shipment invoiced in full: it comes back with its invoice, to say so.
  const fromShipment = await service.entryData({ identity }, { shipment: 'dn-0108' })
  assert.equal(fromShipment.postedShipments.length, 1)
  assert.equal(fromShipment.postedShipments[0].invoiceable, false)
  assert.deepEqual(fromShipment.postedShipments[0].invoices.map((row) => row.invoiceNumber), ['CI-202611-0108'])
  assert.equal(fromShipment.customerInvoiceSource.shipment.shipmentNumber, 'DN-202611-0108')
})

test('the invoice form and page: remaining quantities, the order by number, the terms note, cancel, toasts and the next step', () => {
  const source = read('src/modules/finance/OperationalFinanceO2cWorkbench.tsx')
  // Each line starts at what is left and says shipped / invoiced / left.
  assert.match(source, /const left = Number\(line\.remainingQuantity \?\? line\.postedQuantity\);/)
  assert.match(source, /lineProgress: \["Shipped \{shipped\} · already invoiced \{invoiced\} · left to invoice \{left\}", "已发货 \{shipped\} · 已开票 \{invoiced\} · 可开票 \{left\}"\]/)
  assert.match(source, /else if \(left !== null && quantity > left\) issue\.quantity = "quantityOver";/)
  // The order by its number, linked; never its id.
  assert.match(source, /\{t\("finance\.shipmentsForOrder"\)\} <OrderLink id=\{orderFilter\} number=\{filterOrderNumber\} \/>/)
  // The link's name is the number too (the shared entity link names a sales order by id).
  assert.match(source, /function OrderLink\(\{ id, number \}[^\n]*\n[^\n]*\n\s*return \(\n\s*<Link to=\{`\/app\/sales\/orders\/\$\{encodeURIComponent\(id\)\}`\}/)
  assert.doesNotMatch(source, /<strong>\{orderFilter\}<\/strong>/)
  // Terms the workspace does not have: said, linked, no due date made up.
  assert.match(source, /termsMissing: \["\{terms\} is not set up as a payment term, so the due date is not filled in\.", "\{terms\} 未设置为付款条款，因此未自动填写到期日。"\]/)
  assert.match(source, /<Link to="\/app\/master-data\/payment-terms"/)
  // Cancel draft: a confirm dialog with a required reason, then the server.
  assert.match(source, /const reason = await dialog\.prompt\(\{/)
  assert.match(source, /tone: "danger",/)
  assert.match(source, /`\$\{base\}\/cancel-preview`/)
  // Toasts after create, submit, approve, issue and cancel.
  for (const key of ['toastCreated', 'toastSubmitted', 'toastApproved', 'toastIssued', 'toastCancelled']) assert.match(source, new RegExp(`${key}: \\[`), key)
  assert.match(source, /onDone=\{done\("toastSubmitted"\)\}/)
  assert.match(source, /onDone=\{done\("toastApproved"\)\}/)
  assert.match(source, /onDone=\{done\("toastIssued"\)\}/)
  // "No action is available" only when nothing at all is.
  assert.match(source, /const nothingToDo = !actions\.length && !canOpenDocument && !nextOnReceivable && !paidInFull;/)
  assert.match(source, /\{nothingToDo && <span[^\n]*\{t\("finance\.noActions"\)\}/)
  // The list filters by payment state and the search follows typing through the router.
  assert.match(source, /statuses=\{\["draft", "submitted", "approved", "issued", "to_be_paid", "partially_settled", "settled", "cancelled"\]\}/)
  assert.match(source, /window\.setTimeout\(\(\) => setQuery\(\{ search: search\.trim\(\) \}\), SEARCH_DELAY\)/)
  assert.doesNotMatch(source, /new PopStateEvent\("popstate"\)/)
  // The aging page says its title once.
  assert.doesNotMatch(source, /tr\("agingTitle"\)/)
  // "Next: …" is a link, with the full-width colon in Chinese.
  assert.match(source, /const colon = language === "en-US" \? ": " : "：";/)
  assert.doesNotMatch(source, /\{tr\("next"\)\}: /)
})

let loaded
async function load(entry) {
  loaded ||= (async () => {
    await mkdir(path.resolve('node_modules/.cache'), { recursive: true })
    const dir = await mkdtemp(path.resolve('node_modules/.cache/flowchain-8b-finance-'))
    const modules = {}
    for (const [name, file] of Object.entries({ payments: 'src/modules/finance/PaymentRecords.tsx', controls: 'src/modules/finance/FinanceControls.tsx', shell: 'src/modules/business-documents/DocumentShell.tsx' })) {
      const outfile = path.join(dir, `${name}.mjs`)
      await build({ entryPoints: [file], outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent', external: ['react', 'react-dom', 'react-router', 'lucide-react', 'sonner'], loader: { '.css': 'empty' } })
      modules[name] = await import(pathToFileURL(outfile).href)
    }
    return { modules, cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return (await loaded).modules[entry]
}
test.after(async () => { if (loaded) await (await loaded).cleanup() })

test('the payment form offers a bank transfer first, no ACH outside US dollars, and says what the payment leaves', async () => {
  const { paymentMethodsFor, paymentAfter } = await load('payments')
  assert.deepEqual(paymentMethodsFor('GBP'), ['wire', 'card', 'cash', 'check', 'other'])
  assert.deepEqual(paymentMethodsFor('USD'), ['wire', 'ach', 'check', 'card', 'cash', 'other'])
  assert.deepEqual(paymentAfter('112.5000', '50.00'), { outstandingAmount: '62.5000', status: 'partially_settled' })
  assert.deepEqual(paymentAfter('62.5000', '62.50'), { outstandingAmount: '0.0000', status: 'settled' })
  assert.equal(paymentAfter('62.5000', '70'), null)
  assert.equal(paymentAfter('62.5000', '0'), null)
  assert.equal(paymentAfter(null, '10'), null)
  const source = read('src/modules/finance/PaymentRecords.tsx')
  // No separate Preview step: Cancel · Record payment on the right (FormActionBar).
  assert.doesNotMatch(source, /data-testid="payment-preview"/)
  assert.match(source, /<FormActionBar\s*\n\s*onCancel=\{onClose\}/)
  assert.match(source, /testId: "payment-confirm"/)
  const dictionary = read('src/i18n/I18n.tsx')
  assert.match(dictionary, /"finance\.paymentReferenceHint": "Bank or payment reference"/)
  assert.doesNotMatch(dictionary, /Check or bank reference number/)
})

test('a customer invoice shows its payment state in place of Issued', async () => {
  const { shownCustomerInvoiceStatus, financeStatusTone } = await load('controls')
  assert.equal(shownCustomerInvoiceStatus({ status: 'issued', paymentStatus: 'settled' }), 'settled')
  assert.equal(shownCustomerInvoiceStatus({ status: 'issued', paymentStatus: 'to_be_paid' }), 'to_be_paid')
  assert.equal(shownCustomerInvoiceStatus({ status: 'issued', paymentStatus: null }, 'disputed'), 'disputed')
  // Without the server's payment state, the receivable shown with it decides.
  assert.equal(shownCustomerInvoiceStatus({ status: 'issued' }, 'settled'), 'settled')
  assert.equal(shownCustomerInvoiceStatus({ status: 'issued' }, 'open'), 'to_be_paid')
  assert.equal(shownCustomerInvoiceStatus({ status: 'issued', paymentStatus: null }), 'issued')
  assert.equal(shownCustomerInvoiceStatus({ status: 'draft', paymentStatus: null }), 'draft')
  assert.equal(financeStatusTone('to_be_paid'), 'info')
  const dictionary = read('src/i18n/I18n.tsx')
  assert.match(dictionary, /"finance\.status\.to_be_paid": "待收款"/)
  assert.match(dictionary, /"finance\.status\.to_be_paid": "To be paid"/)
})

test('the invoice document fits a phone screen and prints at its own size', async () => {
  const { documentSheetScale } = await load('shell')
  assert.equal(documentSheetScale(1200), 1)
  assert.equal(documentSheetScale(0), 1)
  const phone = documentSheetScale(358)
  assert.ok(phone > 0.44 && phone < 0.46, String(phone))
  assert.ok(358 / phone >= 793 && 358 / phone < 800)
  const shell = read('src/modules/business-documents/DocumentShell.tsx')
  // The scale is a screen rule only; printing keeps the A4 sheet as it was.
  assert.match(shell, /"@media screen \{ \.business-document-stage \.business-document-sheet \{ zoom: var\(--fc-document-scale, 1\); \} \}"/)
  assert.match(shell, /@media print \{ @page \{ size: A4; margin: 12mm; \} \}/)
  const css = read('src/modules/business-documents/business-documents.css')
  assert.doesNotMatch(css, /zoom/)
})

test('the UCI seed adds the NET30 term its customers name, only when the workspace lacks it', () => {
  const seed = read('scripts/public-data/seed.mjs')
  assert.match(seed, /paymentTerms: `NET\$\{assumptions\.paymentTermsDays\}`/)
  assert.match(seed, /if \(!findPaymentTerm\(terms, code\)\) \{\s*\n\s*await prisma\.paymentTerm\.create\(/)
})
