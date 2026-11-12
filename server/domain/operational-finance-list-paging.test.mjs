import test from 'node:test'
import assert from 'node:assert/strict'
import { createOperationalFinanceO2cReadService } from './operational-finance-o2c-read-service.mjs'
import { billPaymentStatus, createOperationalFinanceReadService, pagedInGroups } from './operational-finance-read-service.mjs'

// 2026-11-10 screenshot review: the receivables and customer invoice lists
// showed the server's first 25 records as the whole set ("25 total", "Open
// receivables 0", "Paid 25") while the aging page had 542 open; the oldest due
// came first, so all 25 were paid; the search box sent text the server never
// read; and every paid row offered "Add external reference". The lists now
// page on the server, count the cards over every record, put what needs
// attention first and search by number or customer.

const TENANT = 'tenant-finance-lists'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const PERMISSIONS = [
  'finance.receivable.read', 'finance.customer_invoice.read', 'finance.payable.read', 'finance.supplier_invoice.read',
  'finance.amounts.read', 'finance.partner_snapshot.read', 'finance.receivable.record_external_reference', 'finance.receivable.record_payment',
  'finance.receivable.dispute', 'finance.payable.record_payment',
]
const userWith = (permissions) => ({
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'finance', name: 'Finance', status: 'active', permissions: permissions.map((permissionCode) => ({ permissionCode })) } }],
})

// A small in-memory stand-in for the Prisma where/orderBy/skip/take the
// finance reads use: equals, in, not, gt, lt, contains (insensitive), AND,
// OR, NOT and a to-one relation's `is`. Relations are nested objects.
const comparable = (value) => (value instanceof Date ? value.getTime() : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value)
function matchesField(value, condition) {
  if (condition === null || typeof condition !== 'object' || condition instanceof Date) return comparable(value) === comparable(condition)
  if ('is' in condition) return value ? matches(value, condition.is) : false
  return Object.entries(condition).every(([operator, operand]) => {
    if (operator === 'mode') return true
    if (operator === 'in') return operand.includes(value)
    if (operator === 'not') return operand === null ? value !== null && value !== undefined : value !== null && value !== undefined && comparable(value) !== comparable(operand)
    if (operator === 'gt') return comparable(value) > comparable(operand)
    if (operator === 'lt') return comparable(value) < comparable(operand)
    if (operator === 'contains') return String(value ?? '').toLowerCase().includes(String(operand).toLowerCase())
    throw new Error(`operator ${operator} is not modelled`)
  })
}
function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return condition.every((part) => matches(row, part))
    if (key === 'OR') return condition.some((part) => matches(row, part))
    if (key === 'NOT') return !(Array.isArray(condition) ? condition.some((part) => matches(row, part)) : matches(row, condition))
    return matchesField(row[key], condition)
  })
}
function model(rows, calls, name) {
  const filtered = (where) => rows.filter((row) => matches(row, where))
  return {
    count: async ({ where } = {}) => filtered(where).length,
    findMany: async ({ where, orderBy = [], skip = 0, take, distinct, select } = {}) => {
      calls.push([name, { where, orderBy, skip, take }])
      let found = filtered(where)
      const order = Array.isArray(orderBy) ? orderBy : [orderBy]
      found = [...found].sort((a, b) => {
        for (const entry of order) {
          const [field, direction] = Object.entries(entry)[0]
          const left = comparable(a[field])
          const right = comparable(b[field])
          if (left < right) return direction === 'asc' ? -1 : 1
          if (left > right) return direction === 'asc' ? 1 : -1
        }
        return 0
      })
      if (distinct) found = found.filter((row, index) => found.findIndex((other) => distinct.every((field) => other[field] === row[field])) === index)
      found = found.slice(skip, take === undefined ? undefined : skip + take)
      return select ? found.map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))) : found
    },
  }
}

// Today in the workspace (Europe/London) is 2026-11-10.
const NOW = new Date('2026-11-10T12:00:00Z')
const day = (text) => new Date(`${text}T00:00:00.000Z`)
function receivableData() {
  const invoices = []
  const receivables = []
  const add = (number, customer, due, status, outstanding, created) => {
    const invoice = { id: `CI-ID-${number}`, tenantId: TENANT, invoiceNumber: `CI-${number}`, customerNameSnapshot: customer, status: 'issued', currency: 'GBP', dueDate: day(due), createdAt: day(created), version: 3 }
    const receivable = { id: `AR-ID-${number}`, tenantId: TENANT, obligationNumber: `AR-CI-${number}`, customerInvoiceId: invoice.id, customerInvoice: invoice, originalAmount: '100.0000', outstandingAmount: outstanding, approvedCreditAmount: '0.0000', currency: 'GBP', dueDate: day(due), status, disputeStatus: 'none', version: 1, createdAt: day(created) }
    invoice.receivableObligation = receivable
    invoices.push(invoice)
    receivables.push(receivable)
  }
  // 30 paid, oldest due first: what the list used to show alone.
  for (let index = 1; index <= 30; index += 1) add(`P${String(index).padStart(2, '0')}`, `Paid Customer ${index}`, `2025-12-${String(index % 28 + 1).padStart(2, '0')}`, 'settled', '0.0000', '2025-11-01')
  add('O1', 'Harbor Supply Co', '2026-11-08', 'open', '53.0000', '2026-10-09')
  add('O2', 'Redwood Retail', '2026-11-01', 'partially_settled', '20.0000', '2026-10-02')
  add('N1', 'Redwood Retail', '2026-12-05', 'open', '137.1900', '2026-11-05')
  add('N2', 'Juniper Ltd', '2026-11-10', 'open', '40.0000', '2026-11-01')
  add('D1', 'Disputed Goods plc', '2026-10-20', 'disputed', '75.0000', '2026-09-20')
  receivables[receivables.length - 1].disputeStatus = 'open'
  return { invoices, receivables }
}
function fakePrisma({ permissions = PERMISSIONS } = {}) {
  const calls = []
  const { invoices, receivables } = receivableData()
  const bills = [
    { id: 'BILL-1', tenantId: TENANT, invoiceNumber: 'SUP-INV-1', supplierName: 'Acme Parts' },
    { id: 'BILL-2', tenantId: TENANT, invoiceNumber: 'SUP-INV-2', supplierName: 'Brightline' },
    { id: 'BILL-3', tenantId: TENANT, invoiceNumber: 'SUP-INV-3', supplierName: 'Acme Parts' },
  ]
  const payable = (id, bill, due, status, outstanding, created) => ({ id, tenantId: TENANT, obligationNumber: `AP-${id}`, supplierInvoiceId: bill.id, supplierInvoice: bill, originalAmount: '80.0000', outstandingAmount: outstanding, approvedCreditAmount: '0.0000', currency: 'USD', dueDate: day(due), status, version: 1, createdAt: day(created) })
  const payables = [
    payable('PAID', bills[0], '2026-09-01', 'settled', '0.0000', '2026-08-01'),
    payable('LATE', bills[1], '2026-11-02', 'approved', '80.0000', '2026-10-02'),
    payable('HELD', bills[2], '2026-11-30', 'held', '80.0000', '2026-10-30'),
    payable('SOON', bills[0], '2026-12-01', 'export_ready', '80.0000', '2026-11-01'),
  ]
  return {
    calls,
    tenant: { findUnique: async () => ({ timezone: 'Europe/London' }) },
    user: { findFirst: async () => structuredClone(userWith(permissions)) },
    receivableObligation: model(receivables, calls, 'receivableObligation'),
    customerInvoice: model(invoices, calls, 'customerInvoice'),
    payableObligation: model(payables, calls, 'payableObligation'),
  }
}
const capabilities = { 'receivable-obligation': { enabled: true }, 'customer-invoice': { enabled: true }, 'payable-obligation': { enabled: true } }
const o2c = (prisma) => createOperationalFinanceO2cReadService({ prisma, capabilities, now: () => NOW })
const numbers = (result) => result.items.map((row) => row.customerInvoiceNumber)

test('the receivables page lists overdue first, then the rest owed, then paid, each newest first, paged across all of them', async () => {
  const prisma = fakePrisma()
  const first = await o2c(prisma).listReceivables({ sort: 'attention', pageSize: '4' }, { identity })
  assert.equal(first.total, 35)
  // Overdue (owed and due before 2026-11-10): newest due first. The disputed
  // one is owed but not overdue by the server's rule, so it comes with the
  // rest owed.
  assert.deepEqual(numbers(first), ['CI-O1', 'CI-O2', 'CI-N1', 'CI-N2'])
  const second = await o2c(prisma).listReceivables({ sort: 'attention', pageSize: '4', page: '2' }, { identity })
  assert.deepEqual(numbers(second).slice(0, 2), ['CI-D1', 'CI-P27'])
  // Every record once, in order, across the pages.
  const seen = []
  for (let page = 1; page <= 9; page += 1) seen.push(...numbers(await o2c(prisma).listReceivables({ sort: 'attention', pageSize: '4', page: String(page) }, { identity })))
  assert.equal(seen.length, 35)
  assert.equal(new Set(seen).size, 35)
  // Without sort=attention the soonest due comes first, as the assistant's tool reads it.
  const plain = await o2c(prisma).listReceivables({ pageSize: '3' }, { identity })
  assert.deepEqual(numbers(plain).map((number) => number.slice(0, 4)), ['CI-P', 'CI-P', 'CI-P'])
})

test('the receivable metric cards count every record, not the page', async () => {
  const result = await o2c(fakePrisma()).listReceivables({ sort: 'attention', pageSize: '2' }, { identity })
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.counts, { outstanding: 5, overdue: 2, disputed: 1, settled: 30 })
  assert.deepEqual(result.currencies, ['GBP'])
  // Each card's link lists what it counts.
  for (const [status, count] of [['outstanding', 5], ['overdue', 2], ['settled', 30]])
    assert.equal((await o2c(fakePrisma()).listReceivables({ status }, { identity })).total, count, status)
  assert.equal((await o2c(fakePrisma()).listReceivables({ disputeStatus: 'open' }, { identity })).total, 1)
})

test('the receivables search finds the invoice or receivable number and the customer', async () => {
  const byNumber = await o2c(fakePrisma()).listReceivables({ sort: 'attention', search: 'ci-n1' }, { identity })
  assert.deepEqual(numbers(byNumber), ['CI-N1'])
  assert.equal(byNumber.total, 1)
  assert.deepEqual(numbers(await o2c(fakePrisma()).listReceivables({ search: 'AR-CI-O2' }, { identity })), ['CI-O2'])
  const byCustomer = await o2c(fakePrisma()).listReceivables({ sort: 'attention', search: 'redwood' }, { identity })
  assert.deepEqual(numbers(byCustomer), ['CI-O2', 'CI-N1'])
  // The counts stay over the workspace while a search narrows the list.
  assert.equal(byCustomer.counts.settled, 30)
  // A role that cannot see customer names cannot find a record by one.
  const hidden = await o2c(fakePrisma({ permissions: PERMISSIONS.filter((code) => code !== 'finance.partner_snapshot.read') })).listReceivables({ search: 'redwood' }, { identity })
  assert.equal(hidden.total, 0)
  // LIKE wildcards are searched as typed.
  assert.equal((await o2c(fakePrisma()).listReceivables({ search: '%' }, { identity })).total, 0)
})

test('only a receivable with money owed offers an external reference', async () => {
  const result = await o2c(fakePrisma()).listReceivables({ sort: 'attention', pageSize: '100' }, { identity })
  const byNumber = Object.fromEntries(result.items.map((row) => [row.customerInvoiceNumber, row.availableActions]))
  assert.deepEqual(byNumber['CI-P01'], [])
  assert.ok(byNumber['CI-O1'].includes('record_external_reference'))
  assert.ok(byNumber['CI-O1'].includes('record_payment'))
})

test('the customer invoice cards count every invoice; past due is an issued invoice whose receivable is overdue', async () => {
  const result = await o2c(fakePrisma()).listCustomerInvoices({ pageSize: '5' }, { identity })
  assert.equal(result.items.length, 5)
  assert.equal(result.total, 35)
  // Paid invoices past their due date are not past due. Issued invoices are
  // also counted by where their payment stands (round 8b): the disputed one
  // has no payment state.
  assert.deepEqual(result.counts, { toApprove: 0, toIssue: 0, issued: 35, pastDue: 2, to_be_paid: 3, partially_settled: 1, settled: 30 })
  // Each row says where its payment stands, and the list filters by it.
  const byNumber = Object.fromEntries((await o2c(fakePrisma()).listCustomerInvoices({ pageSize: '100' }, { identity })).items.map((row) => [row.invoiceNumber, row.paymentStatus]))
  assert.equal(byNumber['CI-P01'], 'settled')
  assert.equal(byNumber['CI-O2'], 'partially_settled')
  assert.equal(byNumber['CI-N1'], 'to_be_paid')
  assert.equal(byNumber['CI-D1'], null)
  const toBePaid = await o2c(fakePrisma()).listCustomerInvoices({ status: 'to_be_paid', pageSize: '100' }, { identity })
  assert.deepEqual(toBePaid.items.map((row) => row.invoiceNumber).sort(), ['CI-N1', 'CI-N2', 'CI-O1'])
})

test('payables page like receivables: overdue first, true total, cards over every payable, search by number or supplier', async () => {
  const read = createOperationalFinanceReadService({ prisma: fakePrisma(), capabilities, now: () => NOW })
  const result = await read.listPayables({ sort: 'attention', pageSize: '50' }, { identity })
  assert.deepEqual(result.items.map((row) => row.obligationNumber), ['AP-LATE', 'AP-SOON', 'AP-HELD', 'AP-PAID'])
  assert.equal(result.total, 4)
  assert.deepEqual(result.counts, { outstanding: 3, overdue: 1, held: 1, settled: 1 })
  assert.deepEqual((await read.listPayables({ status: 'outstanding' }, { identity })).items.map((row) => row.obligationNumber).sort(), ['AP-HELD', 'AP-LATE', 'AP-SOON'])
  assert.deepEqual((await read.listPayables({ status: 'overdue' }, { identity })).items.map((row) => row.obligationNumber), ['AP-LATE'])
  assert.deepEqual((await read.listPayables({ search: 'sup-inv-2' }, { identity })).items.map((row) => row.obligationNumber), ['AP-LATE'])
  assert.deepEqual((await read.listPayables({ sort: 'attention', search: 'acme' }, { identity })).items.map((row) => row.obligationNumber), ['AP-SOON', 'AP-HELD', 'AP-PAID'])
  // A paid payable offers no payment.
  assert.deepEqual(result.items.find((row) => row.obligationNumber === 'AP-PAID').availableActions, [])
})

// 2026-11-11 walk: every approved supplier invoice read "Approved" in the
// list and its card read "Approved 4", though two were paid. The list now
// says where each approved invoice's payment stands, from its payable, and
// its cards count to pay, partly paid and paid; each card's filter lists
// what it counts. The stored status stays "approved".
test('the supplier invoice list shows and counts approved invoices by where their payment stands', async () => {
  const bill = (number, status, payableStatus, created) => ({
    id: `BILL-${number}`, tenantId: TENANT, invoiceNumber: number, supplierName: 'Foods 1 vendor', status, matchStatus: status === 'exception' ? 'variance_approved' : 'matched',
    currency: 'USD', totalAmount: '19.6000', invoiceDate: day('2026-11-11'), dueDate: day('2026-12-11'), createdAt: day(created), version: 2,
    payableObligation: payableStatus ? { status: payableStatus } : null,
  })
  const bills = [
    bill('INV-A001', 'approved', 'settled', '2026-11-01'),
    bill('INV-B002', 'approved', 'partially_settled', '2026-11-02'),
    bill('INV-C003', 'approved', 'approved', '2026-11-03'),
    bill('INV-D004', 'approved', 'held', '2026-11-04'),
    bill('INV-E005', 'approved', null, '2026-11-05'),
    bill('INV-F006', 'exception', null, '2026-11-06'),
    bill('INV-G007', 'approved', 'cancelled', '2026-11-07'),
  ]
  const calls = []
  const prisma = {
    tenant: { findUnique: async () => ({ timezone: 'Europe/London' }) },
    user: { findFirst: async () => structuredClone(userWith(PERMISSIONS)) },
    supplierInvoice: model(bills, calls, 'supplierInvoice'),
    financeMatchException: { groupBy: async () => [] },
  }
  const read = createOperationalFinanceReadService({ prisma, capabilities: { 'supplier-invoice': { enabled: true } }, now: () => NOW })
  const result = await read.listSupplierInvoices({ pageSize: '50' }, { identity })
  const shown = Object.fromEntries(result.items.map((row) => [row.invoiceNumber, [row.status, row.paymentStatus]]))
  assert.deepEqual(shown, {
    'INV-A001': ['approved', 'settled'],
    'INV-B002': ['approved', 'partially_settled'],
    'INV-C003': ['approved', 'to_pay'],
    // Held from payment: still to pay.
    'INV-D004': ['approved', 'to_pay'],
    // No payable (seeded or imported) or a cancelled one: no payment state.
    'INV-E005': ['approved', null],
    'INV-F006': ['exception', null],
    'INV-G007': ['approved', null],
  })
  assert.deepEqual(result.counts, { submitted: 0, exception: 1, matched: 0, approved: 6, to_pay: 2, partially_settled: 1, settled: 1 })
  // Each card's filter lists what it counts; "approved" is still every approved invoice.
  for (const [status, numbers] of [['to_pay', ['INV-D004', 'INV-C003']], ['partially_settled', ['INV-B002']], ['settled', ['INV-A001']]]) {
    const filtered = await read.listSupplierInvoices({ status }, { identity })
    assert.deepEqual(filtered.items.map((row) => row.invoiceNumber), numbers, status)
    assert.equal(filtered.total, numbers.length, status)
  }
  assert.equal((await read.listSupplierInvoices({ status: 'approved' }, { identity })).total, 6)
})

test('billPaymentStatus reads an approved invoice\'s payable, and nothing else', () => {
  assert.equal(billPaymentStatus('approved', 'settled'), 'settled')
  assert.equal(billPaymentStatus('approved', 'partially_settled'), 'partially_settled')
  for (const payable of ['approved', 'export_ready', 'held']) assert.equal(billPaymentStatus('approved', payable), 'to_pay', payable)
  assert.equal(billPaymentStatus('approved', 'cancelled'), null)
  assert.equal(billPaymentStatus('approved', undefined), null)
  // Only an approved invoice has a payment state.
  assert.equal(billPaymentStatus('exception', 'settled'), null)
  assert.equal(billPaymentStatus('cancelled', 'settled'), null)
})

test('pagedInGroups pages across groups without overlap', async () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: `R${index}`, group: index % 3, dueDate: day(`2026-01-0${index + 1}`), createdAt: day('2026-01-01') }))
  const calls = []
  const records = model(rows, calls, 'rows')
  const groups = [{ group: 2 }, { group: 0 }, { group: 1 }]
  const page = async (skip) => (await pagedInGroups(records, { where: {}, groups, orderBy: [{ dueDate: 'desc' }, { id: 'desc' }], skip, take: 3 })).rows.map((row) => row.id)
  assert.deepEqual([...(await page(0)), ...(await page(3)), ...(await page(6))], ['R5', 'R2', 'R6', 'R3', 'R0', 'R4', 'R1'])
  assert.equal((await pagedInGroups(records, { where: {}, groups, orderBy: [{ id: 'asc' }], skip: 0, take: 3 })).total, 7)
})
