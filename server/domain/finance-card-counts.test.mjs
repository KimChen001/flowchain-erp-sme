import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createOperationalFinanceReadService } from './operational-finance-read-service.mjs'
import { createOperationalFinanceO2cReadService } from './operational-finance-o2c-read-service.mjs'
import { inMemoryModel } from './test-fixtures/in-memory-prisma.mjs'

// Design audit 2026-11-15, batch A6 (L2-14, L1-18 = L7-02, L7-17): the same
// number was worked out several ways. The finance overview's "Awaiting match"
// left out invoices waiting for their receipt and its "Match exceptions" card
// counted open differences, while both open the supplier invoice list with
// a plain status filter; the credit tiles left out cancelled drafts that the
// lists they open show. Every summary card's number must be the number of
// rows the list it opens shows. Each card here is read with the filter its
// link sets, through a stand-in Prisma client that applies the where clauses.

const TENANT = 'tenant-card-counts'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const PERMISSIONS = [
  'finance.overview.read', 'finance.payable.read', 'finance.receivable.read', 'finance.amounts.read',
  'finance.partner_snapshot.read', 'finance.supplier_invoice.read', 'finance.customer_invoice.read',
  'finance.supplier_credit.read', 'finance.customer_credit.read', 'finance.three_way_match.read',
]
const user = {
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'finance', name: 'Finance', status: 'active', permissions: PERMISSIONS.map((permissionCode) => ({ permissionCode })) } }],
}
// Today in the workspace (Europe/London) is 2026-11-10.
const NOW = new Date('2026-11-10T12:00:00Z')
const day = (text) => new Date(`${text}T00:00:00.000Z`)

const exception = (supplierInvoiceId, exceptionType, status) => ({ id: `${supplierInvoiceId}-${exceptionType}`, tenantId: TENANT, supplierInvoiceId, exceptionType, status })
let created = 0
const bill = (id, status, extra = {}) => ({
  id, tenantId: TENANT, invoiceNumber: id, supplierName: 'Acme', currency: 'GBP', status, relatedPoId: 'PO-1', relatedGrnId: 'GRN-1',
  invoiceDate: day('2026-10-01'), dueDate: day('2026-10-31'), totalAmount: '100.0000', varianceAmount: '0.0000', matchStatus: null,
  matchExceptions: [], payableObligation: null, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, created++)), version: 1, ...extra,
})
const exceptions = [
  exception('E-PRICE', 'price', 'open'), exception('E-PRICE', 'amount', 'open'),
  // Billed 5 more than received at the order price: no variance amount.
  exception('E-QTY', 'quantity', 'open'),
  exception('E-REJECTED', 'price', 'rejected'),
  exception('E-APPROVED', 'price', 'approved'),
]
const exceptionsOf = (id) => exceptions.filter((row) => row.supplierInvoiceId === id)
const bills = [
  bill('S-MATCH', 'submitted'),
  bill('S-WAIT', 'submitted', { relatedGrnId: null }),
  bill('E-PRICE', 'exception', { varianceAmount: '0.6600', matchStatus: 'exception', matchExceptions: exceptionsOf('E-PRICE') }),
  bill('E-QTY', 'exception', { matchStatus: 'exception', matchExceptions: exceptionsOf('E-QTY') }),
  bill('E-REJECTED', 'exception', { matchStatus: 'exception', varianceAmount: '1.0000', matchExceptions: exceptionsOf('E-REJECTED') }),
  bill('E-APPROVED', 'exception', { matchStatus: 'variance_approved', varianceAmount: '2.0000', matchExceptions: exceptionsOf('E-APPROVED') }),
  bill('M-1', 'matched', { matchStatus: 'matched' }),
  bill('A-TOPAY', 'approved', { payableObligation: { status: 'approved' } }),
  bill('A-HELD', 'held', { payableObligation: { status: 'held' } }),
  bill('A-PART', 'approved', { payableObligation: { status: 'partially_settled' } }),
  bill('A-PAID', 'approved', { payableObligation: { status: 'settled' } }),
  bill('A-NOPAYABLE', 'approved'),
  bill('C-1', 'cancelled'),
]
const payable = (id, status, due, outstanding) => ({
  id, tenantId: TENANT, obligationNumber: `AP-${id}`, supplierInvoiceId: `A-${id}`, currency: 'GBP', status, dueDate: day(due),
  originalAmount: '100.0000', outstandingAmount: outstanding, approvedCreditAmount: '0.0000', version: 1,
  supplierInvoice: { invoiceNumber: `A-${id}`, supplierName: 'Acme' },
})
const payables = [
  payable('TOPAY', 'approved', '2026-11-20', '100.0000'),
  payable('HELD', 'held', '2026-11-01', '100.0000'),
  payable('PART', 'partially_settled', '2026-10-01', '30.0000'),
  payable('EXPORT', 'export_ready', '2026-11-12', '100.0000'),
  payable('PAID', 'settled', '2026-10-01', '0.0000'),
  payable('VOID', 'cancelled', '2026-10-01', '0.0000'),
]
const receivable = (id, status, due, outstanding, disputeStatus = 'none') => ({
  id, tenantId: TENANT, obligationNumber: `AR-${id}`, customerInvoiceId: `CI-${id}`, currency: 'GBP', status, disputeStatus, dueDate: day(due),
  originalAmount: '100.0000', outstandingAmount: outstanding, approvedCreditAmount: '0.0000', version: 1,
  customerInvoice: { id: `CI-${id}`, invoiceNumber: `CI-${id}`, customerNameSnapshot: 'Customer' },
})
const receivables = [
  receivable('OPEN', 'open', '2026-11-20', '100.0000'),
  receivable('LATE', 'open', '2026-11-01', '100.0000'),
  receivable('PART', 'partially_settled', '2026-10-01', '40.0000'),
  receivable('DISPUTED', 'disputed', '2026-10-01', '100.0000', 'open'),
  receivable('PAID', 'settled', '2026-10-01', '0.0000'),
]
const customerInvoice = (id, status, receivableObligation = null) => ({
  id, tenantId: TENANT, invoiceNumber: id, customerNameSnapshot: 'Customer', currency: 'GBP', status, receivableObligation,
  invoiceDate: day('2026-10-01'), dueDate: day('2026-10-31'), totalAmount: '100.0000', createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, created++)), version: 1,
})
const customerInvoices = [
  customerInvoice('CI-DRAFT', 'draft'),
  customerInvoice('CI-APPROVED-1', 'approved'),
  customerInvoice('CI-APPROVED-2', 'approved'),
  customerInvoice('CI-ISSUED', 'issued', { status: 'open' }),
]
const credit = (id, status) => ({ id, tenantId: TENANT, status, currency: 'GBP', totalAmount: '5.0000', createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, created++)), version: 1 })

function prisma() {
  return {
    tenant: { findUnique: async () => ({ timezone: 'Europe/London' }) },
    user: { findFirst: async () => structuredClone(user) },
    supplierInvoice: inMemoryModel(bills),
    financeMatchException: inMemoryModel(exceptions),
    payableObligation: inMemoryModel(payables),
    receivableObligation: inMemoryModel(receivables),
    customerInvoice: inMemoryModel(customerInvoices),
    supplierCreditMemo: inMemoryModel([credit('SCM-DRAFT', 'draft'), credit('SCM-APPROVED', 'approved'), credit('SCM-CANCELLED', 'cancelled')]),
    customerCreditNote: inMemoryModel([credit('CCN-APPROVED', 'approved'), credit('CCN-CANCELLED', 'cancelled')]),
  }
}
const services = () => {
  const client = prisma()
  return {
    p2p: createOperationalFinanceReadService({ prisma: client, now: () => NOW }),
    o2c: createOperationalFinanceO2cReadService({ prisma: client, now: () => NOW }),
  }
}
const page = readFileSync(new URL('../../src/modules/finance/OperationalFinanceP2pWorkbench.tsx', import.meta.url), 'utf8')
const read = (fn, query) => fn(query, { identity })

test('every finance overview card counts the rows of the list it opens', async () => {
  const { p2p, o2c } = services()
  const landing = await o2c.landing({ identity })
  // card: [its link on the overview, the list read with that link's filter]
  const cards = {
    approvedPayableObligations: ['/app/finance/payables?status=outstanding', () => read(p2p.listPayables, { status: 'outstanding' })],
    openReceivables: ['/app/finance/receivables?status=outstanding', () => read(o2c.listReceivables, { status: 'outstanding' })],
    overdueReceivables: ['/app/finance/receivables?status=overdue', () => read(o2c.listReceivables, { status: 'overdue' })],
    matchExceptions: ['/app/procurement/bills?status=exception', () => read(p2p.listSupplierInvoices, { status: 'exception' })],
    supplierInvoicesAwaitingMatch: ['/app/procurement/bills?status=submitted', () => read(p2p.listSupplierInvoices, { status: 'submitted' })],
    customerInvoicesAwaitingIssue: ['/app/sales/invoices?status=approved', () => read(o2c.listCustomerInvoices, { status: 'approved' })],
    disputedReceivables: ['/app/finance/receivables?disputeStatus=open', () => read(o2c.listReceivables, { disputeStatus: 'open' })],
    supplierCreditMemos: ['/app/finance/credits', () => read(p2p.listSupplierCreditMemos, {})],
    customerCreditNotes: ['/app/finance/customer-credit-notes', () => read(o2c.listCustomerCreditNotes, {})],
  }
  assert.deepEqual(Object.keys(landing.cards).sort(), Object.keys(cards).sort(), 'every card is checked')
  // Supplier credit notes come only from supplier returns, which are off, so
  // the overview shows no card for them (design audit W-07); the count stays.
  const hidden = new Set(['supplierCreditMemos'])
  for (const [card, [link, list]] of Object.entries(cards)) {
    if (hidden.has(card)) assert.ok(!page.includes(`"${link}"`), `${card} has no card`)
    else assert.ok(page.includes(`"${link}"`), `${card} opens ${link}`)
    assert.equal(landing.cards[card], (await list()).total, `${card} = the rows of ${link}`)
  }
  // The numbers themselves: both submitted invoices, also the one waiting
  // for its receipt; all four held by a match exception, also the rejected
  // one and the one whose differences were approved; every credit.
  assert.equal(landing.cards.supplierInvoicesAwaitingMatch, 2)
  assert.equal(landing.cards.matchExceptions, 4)
  assert.equal(landing.cards.supplierCreditMemos, 3)
  assert.equal(landing.cards.customerCreditNotes, 2)
  // The payables aging's rows count what their row title opens: To pay the
  // payables still owed, Held (match exception) the invoices held.
  const rows = (view) => view.groups.reduce((sum, group) => sum + group.count, 0)
  assert.equal(rows(landing.aging.payables), (await read(p2p.listPayables, { status: 'outstanding' })).total)
  assert.equal(rows(landing.aging.heldForMatch), (await read(p2p.listSupplierInvoices, { status: 'exception' })).total)
  assert.equal(rows(landing.aging.payablesWithHeld), rows(landing.aging.payables) + rows(landing.aging.heldForMatch))
})

test('every supplier invoice and payable card counts the rows of the list it opens', async () => {
  const { p2p } = services()
  const invoices = await read(p2p.listSupplierInvoices, {})
  for (const status of ['submitted', 'exception', 'matched', 'to_pay', 'partially_settled', 'settled']) {
    assert.ok(page.includes(`to="/app/procurement/bills?status=${status}"`), `the ${status} card opens its list`)
    assert.equal(invoices.counts[status], (await read(p2p.listSupplierInvoices, { status })).total, `bills ${status}`)
  }
  // To pay: the approved bill and the bill whose payable is on hold (A8).
  assert.equal(invoices.counts.to_pay, 2)
  const payables = await read(p2p.listPayables, {})
  for (const status of ['outstanding', 'overdue', 'held', 'settled']) {
    assert.ok(page.includes(`to="/app/finance/payables?status=${status}"`), `the ${status} card opens its list`)
    assert.equal(payables.counts[status], (await read(p2p.listPayables, { status })).total, `payables ${status}`)
  }
  assert.deepEqual([payables.counts.outstanding, payables.counts.overdue], [4, 2])
})

// Design audit L2-08 (= L7-05): the variance amount is the price difference
// only, so an invoice billing more than was received at the order price read
// "—" and fell under "No variance".
test('a quantity difference still to decide is a variance on the supplier invoice list', async () => {
  const { p2p } = services()
  const ids = async (variance) => (await read(p2p.listSupplierInvoices, { variance, pageSize: 100 })).items.map((row) => row.id).sort()
  assert.deepEqual(await ids('with'), ['E-APPROVED', 'E-PRICE', 'E-QTY', 'E-REJECTED'])
  const none = await ids('none')
  for (const id of ['E-QTY', 'E-REJECTED']) assert.ok(!none.includes(id), `${id} has a difference to decide`)
  assert.equal(none.length + 4, bills.length, 'the two filters split the list')
  // The list names the kind of difference still to decide.
  const held = await read(p2p.listSupplierInvoices, { status: 'exception', pageSize: 100 })
  const types = Object.fromEntries(held.items.map((row) => [row.id, row.openExceptionTypes]))
  assert.deepEqual(types, { 'E-PRICE': ['amount', 'price'], 'E-QTY': ['quantity'], 'E-REJECTED': ['price'], 'E-APPROVED': [] })
  assert.match(page, /row\.openExceptionTypes\.includes\("quantity"\)/)
  assert.match(page, /matchExceptionLabel\("quantity", language\)/)
})
