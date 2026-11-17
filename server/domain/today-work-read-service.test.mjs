import test from 'node:test'
import assert from 'node:assert/strict'
import { readTodayWorkSources } from './today-work-read-service.mjs'
import { tenantCalendarDay } from './tenant-calendar-day.mjs'
import { inMemoryModel } from './test-fixtures/in-memory-prisma.mjs'

// Design audit L6-01 (= L7-16): Today read overdue receivables with the
// workspace day turned into 00:00 UTC and handed to overdueReceivableWhere
// without a timezone. Read in the default New York timezone that instant is
// the day before, so the query asked for "due before yesterday" and every
// receivable that fell due yesterday was missing (Today said 30, the finance
// overview 52). The read now passes the instant and the workspace timezone,
// as the finance landing does. The rows go through a stand-in Prisma client
// that applies the where clause, so the test checks what the call site asks
// for, not only the helper.

const TENANT = 'tenant-today-receivables'
const day = (text) => new Date(`${text}T00:00:00.000Z`)
const receivable = (id, due, { status = 'open', outstanding = '10.0000' } = {}) => ({
  id, tenantId: TENANT, obligationNumber: `AR-${id}`, customerInvoiceId: `CI-${id}`, dueDate: day(due), outstandingAmount: outstanding,
  currency: 'GBP', status, disputeStatus: 'none', customerInvoice: { id: `CI-${id}`, invoiceNumber: `CI-${id}`, customerNameSnapshot: 'Customer' },
})
const rows = [
  receivable('DUE-1112', '2026-11-12'),
  receivable('DUE-1113', '2026-11-13'), // yesterday: overdue
  receivable('DUE-1114', '2026-11-14'), // today: not overdue yet
  receivable('DUE-1120', '2026-11-20'),
  receivable('PAID-1101', '2026-11-01', { status: 'settled', outstanding: '0.0000' }),
  receivable('DISPUTED-1105', '2026-11-05', { status: 'disputed' }),
  { ...receivable('OTHER-1101', '2026-11-01'), tenantId: 'another-tenant' },
]
const access = { home: { receivables: true }, collections: {}, amounts: true, partner: true }

async function overdueOn(now, timeZone) {
  const ctx = { identity: { tenantId: TENANT }, env: {}, homeOverviewPrisma: { receivableObligation: inMemoryModel(rows) } }
  const today = tenantCalendarDay(now, timeZone)
  const read = await readTodayWorkSources(ctx, { access, rawContext: {}, now, today, timeZone })
  return { today, ids: read.sources.receivables.map((row) => row.id) }
}

test('Today lists a receivable due yesterday as overdue in a New York workspace', async () => {
  // 23:30 on Nov 14 in New York is already Nov 15 in UTC.
  const { today, ids } = await overdueOn(new Date('2026-11-15T04:30:00.000Z'), 'America/New_York')
  assert.equal(today, '2026-11-14')
  assert.deepEqual(ids, ['DUE-1112', 'DUE-1113'])
})

test('Today lists a receivable due yesterday as overdue in a London workspace', async () => {
  // 00:30 on Nov 14 in London is still Nov 13 in New York, the default
  // timezone the old call read the day in.
  const { today, ids } = await overdueOn(new Date('2026-11-14T00:30:00.000Z'), 'Europe/London')
  assert.equal(today, '2026-11-14')
  assert.deepEqual(ids, ['DUE-1112', 'DUE-1113'])
})

// Design audit L7-12 = L7-18: Today read no payables at all. It reads those
// overdue by the payables list's rule (overduePayableWhere), on the instant
// and the workspace timezone, and only for a reader who may read payables.
test('Today reads the payables past their due date by the payables list rule, for a reader who may read them', async () => {
  const payable = (id, due, { status = 'approved', outstanding = '10.0000' } = {}) => ({
    id, tenantId: TENANT, obligationNumber: `AP-${id}`, supplierInvoiceId: `BILL-${id}`, dueDate: day(due), outstandingAmount: outstanding, currency: 'GBP', status,
    supplierInvoice: { id: `BILL-${id}`, invoiceNumber: `INV-${id}`, supplierName: 'Acme' },
  })
  const payables = [
    payable('DUE-1113', '2026-11-13'), // yesterday: overdue
    payable('HELD-1110', '2026-11-10', { status: 'held' }),
    payable('DUE-1114', '2026-11-14'), // today: not overdue yet
    payable('PAID-1101', '2026-11-01', { status: 'settled', outstanding: '0.0000' }),
    payable('VOID-1101', '2026-11-01', { status: 'cancelled' }),
    { ...payable('OTHER-1101', '2026-11-01'), tenantId: 'another-tenant' },
  ]
  const read = async (home, amounts = true) => readTodayWorkSources(
    { identity: { tenantId: TENANT }, env: {}, homeOverviewPrisma: { payableObligation: inMemoryModel(payables) } },
    { access: { home, collections: {}, amounts, partner: true }, rawContext: {}, now: new Date('2026-11-15T04:30:00.000Z'), today: '2026-11-14', timeZone: 'America/New_York' },
  )
  const { sources } = await read({ payables: true })
  assert.deepEqual(sources.payables.map((row) => row.id), ['HELD-1110', 'DUE-1113'])
  assert.deepEqual([sources.payables[0].supplierInvoiceNumber, sources.payables[0].supplierName, sources.payables[0].outstandingAmount, sources.payables[0].status], ['INV-HELD-1110', 'Acme', '10.0000', 'held'])
  assert.equal((await read({ payables: true }, false)).sources.payables[0].outstandingAmount, null)
  assert.equal((await read({})).sources.payables, undefined)
})

// Design audit 2026-11-15 (V-C-03): past 100 held invoices the newest were
// read, so the oldest cards Today shows first had no prepared step, and
// nothing said so.
test('past 100 held invoices, the oldest get the prepared step and Today says the rest have none', async () => {
  const held = Array.from({ length: 103 }, (_, index) => ({ id: `INV-${String(index).padStart(3, '0')}`, status: 'exception', matchStatus: 'variance', invoiceDate: `2026-${String(1 + Math.floor(index / 28)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}` }))
  // The snapshot lists them newest first.
  const rawContext = { supplierInvoices: [...held].reverse() }
  const invoices = held.map((row) => ({ id: row.id, tenantId: TENANT, invoiceNumber: row.id, supplierId: 'SUP-1', supplierName: 'Acme', relatedPoId: null, currency: 'GBP' }))
  const ctx = { identity: { tenantId: TENANT }, env: {}, homeOverviewPrisma: { supplierInvoice: inMemoryModel(invoices), financeMatchException: inMemoryModel([]) } }
  const read = await readTodayWorkSources(ctx, { access: { home: {}, collections: { supplierInvoices: true }, amounts: true, partner: true }, rawContext, now: new Date('2026-11-15T12:00:00Z'), today: '2026-11-15', timeZone: 'Europe/London' })
  const drafted = read.sources.invoiceExceptions.invoices.map((row) => row.id).sort()
  assert.equal(drafted.length, 100)
  assert.deepEqual(drafted, held.slice(0, 100).map((row) => row.id))
  assert.ok(read.limitations.includes('truncated:invoice_exceptions'))
})
