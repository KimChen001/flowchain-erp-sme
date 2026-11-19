import test from 'node:test'
import assert from 'node:assert/strict'
import { getDirectProcurementDocument } from '../repositories/db-procurement-read-repository.mjs'
import { createOperationalFinanceReadService } from './operational-finance-read-service.mjs'
import { inMemoryModel } from './test-fixtures/in-memory-prisma.mjs'
import { heldInvoiceRows, inWorkQueue, isMatchHeldInvoice, workQueueCount } from '../../src/modules/procurement/workQueue.ts'

// Design audit L1-18 = L7-02 and L7-03: the purchasing workbench said "0
// Invoice or match issues" while the supplier invoice list had 27 match
// exceptions. It counted orders still open only, so a held invoice on a
// closed order was in no queue, and it found issues by matching Chinese
// status text, which missed a quantity difference ("exception"). The issues
// are now the supplier invoices held by a match exception themselves, by the
// stored status code the supplier invoice list filters on, whatever the
// order's status; each card's number is the number of rows its queue lists.

const TENANT = 'tenant-work-queue'
const TODAY = '2026-11-10'
const day = (text) => new Date(`${text}T00:00:00.000Z`)
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const user = {
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'), warehouseScopes: [],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'buyer', name: 'Buyer', status: 'active', permissions: ['finance.supplier_invoice.read', 'finance.amounts.read', 'finance.partner_snapshot.read'].map((permissionCode) => ({ permissionCode })) } }],
}
let created = 0
const invoice = (id, status, extra = {}) => ({
  id, tenantId: TENANT, invoiceNumber: `SUP-${id}`, supplierId: 'SUP-1', supplierName: 'Acme', relatedPoId: 'PO-OPEN', relatedGrnId: 'GRN-1', currency: 'GBP',
  invoiceDate: day('2026-10-01'), dueDate: day('2026-10-31'), amount: '100.0000', totalAmount: '100.0000', varianceAmount: '0.0000', matchStatus: null,
  status, lines: [], matchExceptions: [], createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, created++)), updatedAt: day('2026-10-01'), version: 1, ...extra,
})
const raw = [
  // Billed 89, received 84, on an order closed short: a quantity difference,
  // no variance amount, past its due date.
  invoice('QTY-CLOSED', 'exception', { relatedPoId: 'PO-CLOSED', matchStatus: 'exception', dueDate: day('2026-11-01'), matchExceptions: [{ status: 'open' }] }),
  // A price difference: the read model shows its status as 存在差异.
  invoice('PRICE', 'exception', { matchStatus: 'exception', varianceAmount: '0.6600', dueDate: day('2026-12-01'), matchExceptions: [{ status: 'open' }, { status: 'open' }] }),
  // Every difference approved; the invoice still waits for its own approval.
  invoice('DIFF-APPROVED', 'exception', { matchStatus: 'variance_approved', varianceAmount: '2.0000', matchExceptions: [{ status: 'approved' }] }),
  // Approved with its variance: not held, though its status also reads 存在差异.
  invoice('APPROVED', 'approved', { matchStatus: 'variance_approved', varianceAmount: '2.0000', matchExceptions: [{ status: 'approved' }] }),
  invoice('SUBMITTED', 'submitted'),
]
const prisma = {
  tenant: { findUnique: async () => ({ timezone: 'Europe/London' }) },
  user: { findFirst: async () => structuredClone(user) },
  supplierInvoice: inMemoryModel(raw),
  financeMatchException: inMemoryModel([]),
}
// Each invoice as GET /api/procurement/documents serves it to the workbench.
const documents = () => Promise.all(raw.map((row) => getDirectProcurementDocument(prisma, 'invoice', row.id, TENANT)))
// Two order rows as the workbench builds them: one to approve, one in progress.
const orderRows = [
  { id: 'PO-PENDING', kind: 'purchase_order', status: 'pending_approval', bucket: 'approval', amount: 10, signals: [] },
  { id: 'PO-OPEN', kind: 'purchase_order', status: 'issued', bucket: 'tracking', amount: 10, signals: [] },
]

test('the issues queue lists every supplier invoice held by a match exception, also on a closed order', async () => {
  const docs = await documents()
  // The read model hides "exception" behind 存在差异 when there is a variance
  // amount, and says the same of an approved invoice; the stored code decides.
  assert.equal(docs.find((row) => row.id === 'PRICE').invoiceStatus, '存在差异')
  assert.equal(docs.find((row) => row.id === 'APPROVED').invoiceStatus, '存在差异')
  assert.deepEqual(docs.filter(isMatchHeldInvoice).map((row) => row.id), ['QTY-CLOSED', 'PRICE', 'DIFF-APPROVED'])

  const held = heldInvoiceRows(docs, TODAY)
  const byId = Object.fromEntries(held.map((row) => [row.id, row]))
  assert.deepEqual(Object.keys(byId), ['QTY-CLOSED', 'PRICE', 'DIFF-APPROVED'])
  assert.deepEqual([byId['QTY-CLOSED'].kind, byId['QTY-CLOSED'].bucket, byId['QTY-CLOSED'].orderNumber, byId['QTY-CLOSED'].daysLate], ['supplier_invoice', 'issues', 'PO-CLOSED', 9])
  assert.deepEqual(byId['QTY-CLOSED'].signals, ['overdue', 'match_exception'])
  assert.deepEqual(byId.PRICE.signals, ['match_exception'])
  // Due 2026-10-31: ten days past its due date, still to approve.
  assert.deepEqual([byId['DIFF-APPROVED'].status, byId['DIFF-APPROVED'].daysLate, byId['DIFF-APPROVED'].signals], ['variance_approved', 10, ['overdue', 'invoice_to_approve']])
  assert.equal(byId['QTY-CLOSED'].number, 'SUP-QTY-CLOSED')

  // The card counts what the supplier invoice list's Match exceptions card
  // and its status=exception filter count.
  const list = await createOperationalFinanceReadService({ prisma }).listSupplierInvoices({ status: 'exception' }, { identity })
  assert.equal(workQueueCount([...orderRows, ...held], 'issues'), list.total)
  assert.equal(list.total, 3)
})

test('each workbench card counts the rows of the queue it opens', async () => {
  const rows = [...orderRows, ...heldInvoiceRows(await documents(), TODAY)]
  const expected = { all: 5, approval: 1, tracking: 1, issues: 3 }
  for (const [queue, count] of Object.entries(expected)) {
    assert.equal(workQueueCount(rows, queue), count, queue)
    assert.equal(rows.filter((row) => inWorkQueue(row, queue)).length, count, `${queue} lists as many rows`)
  }
  // A late order is not an invoice or match issue.
  assert.equal(inWorkQueue({ ...orderRows[1], signals: ['overdue'], daysLate: 3 }, 'issues'), false)
})
