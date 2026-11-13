import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGING_BUCKETS, ageByCurrency, agingBucket, agingDays, createOperationalFinanceO2cReadService } from './operational-finance-o2c-read-service.mjs'

// UI review round 8 (2026-11-12): the Payables & receivables overview showed
// eight counts and no money; "52 Overdue receivables" never said how much was
// owed. The landing now returns, per currency and never added across
// currencies, what we owe (and what falls due within 7 days), what we are
// owed, what is overdue and the aging buckets, by the aging page's own rules.
// Amounts need the records' read permission and finance.amounts.read; without
// them the counts stay and the amounts are null.

const TENANT = 'tenant-finance-landing'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const FULL = [
  'finance.overview.read', 'finance.payable.read', 'finance.receivable.read', 'finance.amounts.read',
  'finance.partner_snapshot.read',
]
const userWith = (permissions) => ({
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'finance', name: 'Finance', status: 'active', permissions: permissions.map((permissionCode) => ({ permissionCode })) } }],
})

// An in-memory stand-in for the Prisma where clauses the landing uses.
const comparable = (value) => (value instanceof Date ? value.getTime() : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value)
function matchesField(value, condition) {
  if (condition === null || typeof condition !== 'object' || condition instanceof Date) return comparable(value) === comparable(condition)
  if ('is' in condition) return value ? matches(value, condition.is) : false
  return Object.entries(condition).every(([operator, operand]) => {
    if (operator === 'mode') return true
    if (operator === 'in') return operand.includes(value)
    if (operator === 'notIn') return !operand.includes(value)
    if (operator === 'not') return operand === null ? value !== null && value !== undefined : comparable(value) !== comparable(operand)
    if (operator === 'gt') return comparable(value) > comparable(operand)
    if (operator === 'lt') return comparable(value) < comparable(operand)
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
function model(rows) {
  const filtered = (where) => rows.filter((row) => matches(row, where))
  return {
    count: async ({ where } = {}) => filtered(where).length,
    findMany: async ({ where, distinct, select } = {}) => {
      let found = filtered(where)
      if (distinct) found = found.filter((row, index) => found.findIndex((other) => distinct.every((field) => other[field] === row[field])) === index)
      return select ? found.map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))) : found
    },
  }
}

// Today in the workspace (Europe/London) is 2026-11-10.
const NOW = new Date('2026-11-10T12:00:00Z')
const day = (text) => new Date(`${text}T00:00:00.000Z`)
const receivable = (id, currency, due, status, outstanding, disputeStatus = 'none') => ({
  id, tenantId: TENANT, obligationNumber: `AR-${id}`, currency, dueDate: day(due), status, disputeStatus,
  originalAmount: outstanding, outstandingAmount: outstanding, approvedCreditAmount: '0.0000', version: 1,
  customerInvoice: { id: `CI-${id}`, invoiceNumber: `CI-${id}`, customerNameSnapshot: 'Customer' },
})
const payable = (id, currency, due, status, outstanding) => ({
  id, tenantId: TENANT, obligationNumber: `AP-${id}`, currency, dueDate: day(due), status, outstandingAmount: outstanding,
})
function fakePrisma(permissions = FULL) {
  return {
    tenant: { findUnique: async () => ({ timezone: 'Europe/London' }) },
    user: { findFirst: async () => structuredClone(userWith(permissions)) },
    receivableObligation: model([
      receivable('R1', 'GBP', '2026-11-20', 'open', '100.0000'), // not yet due
      receivable('R2', 'GBP', '2026-11-01', 'open', '50.0000'), // 9 days past due
      receivable('R3', 'GBP', '2026-08-01', 'partially_settled', '25.5000'), // 101 days
      receivable('R4', 'GBP', '2026-10-01', 'disputed', '75.0000', 'open'), // owed, disputed: in aging, not "overdue"
      receivable('R5', 'USD', '2026-09-01', 'open', '40.0000'), // 70 days
      receivable('R6', 'GBP', '2026-01-01', 'settled', '0.0000'), // paid
    ]),
    payableObligation: model([
      payable('P1', 'GBP', '2026-11-12', 'approved', '80.0000'), // due in 2 days
      payable('P2', 'GBP', '2026-11-17', 'held', '20.0000'), // due in 7 days
      payable('P3', 'GBP', '2026-11-18', 'export_ready', '30.0000'), // due in 8 days
      payable('P4', 'GBP', '2026-11-05', 'approved', '10.0000'), // 5 days past due
      payable('P5', 'USD', '2026-11-10', 'partially_settled', '60.0000'), // due today
      payable('P6', 'GBP', '2026-09-01', 'settled', '0.0000'),
    ]),
    supplierInvoice: model([{ tenantId: TENANT, status: 'approved', currency: 'GBP' }]),
    customerInvoice: model([{ tenantId: TENANT, status: 'issued', currency: 'GBP' }]),
    financeMatchException: model([{ tenantId: TENANT, status: 'open' }]),
    supplierCreditMemo: model([]),
    customerCreditNote: model([]),
  }
}
const capabilities = { 'receivable-obligation': { enabled: true } }
const landing = (permissions) => createOperationalFinanceO2cReadService({ prisma: fakePrisma(permissions), capabilities, now: () => NOW }).landing({ identity })
const byCurrency = (rows) => Object.fromEntries(rows.map((row) => [row.currency, row]))
const buckets = (group) => Object.fromEntries(group.buckets.map((row) => [row.bucket, [row.count, row.amount]]))

test('the overview totals what we owe and are owed per currency, never across currencies', async () => {
  const result = await landing()
  assert.equal(result.timezone, 'Europe/London')
  assert.equal(result.cards.openReceivables, 5)
  assert.equal(result.cards.overdueReceivables, 3)
  assert.equal(result.cards.approvedPayableObligations, 5)
  const owed = byCurrency(result.money.receivables.byCurrency)
  assert.deepEqual(Object.keys(owed), ['GBP', 'USD'])
  assert.deepEqual([owed.GBP.count, owed.GBP.amount], [4, '250.5000'])
  assert.deepEqual([owed.USD.count, owed.USD.amount], [1, '40.0000'])
  // Overdue by the receivables list's own rule: the disputed one is owed but
  // not overdue, so the amount matches the count and the list it opens.
  const overdue = byCurrency(result.money.overdueReceivables.byCurrency)
  assert.deepEqual([overdue.GBP.count, overdue.GBP.amount], [2, '75.5000'])
  assert.deepEqual([overdue.USD.count, overdue.USD.amount], [1, '40.0000'])
  assert.equal(result.money.overdueReceivables.byCurrency.reduce((sum, row) => sum + row.count, 0), result.cards.overdueReceivables)
  // To pay: every approved payable not paid in full, held or not, and what
  // falls due from today through the next 7 days.
  assert.equal(result.money.dueSoonDays, 7)
  const toPay = byCurrency(result.money.payables.byCurrency)
  assert.deepEqual([toPay.GBP.count, toPay.GBP.amount, toPay.GBP.dueSoonCount, toPay.GBP.dueSoonAmount], [4, '140.0000', 2, '100.0000'])
  assert.deepEqual([toPay.USD.count, toPay.USD.amount, toPay.USD.dueSoonCount, toPay.USD.dueSoonAmount], [1, '60.0000', 1, '60.0000'])
  assert.equal(result.money.payables.byCurrency.reduce((sum, row) => sum + row.count, 0), result.cards.approvedPayableObligations)
  for (const block of [result.money.payables, result.money.receivables, result.money.overdueReceivables]) {
    assert.equal(block.readable, true)
    assert.equal(block.amountsVisible, true)
  }
})

test('the aging strip uses the aging page buckets and agrees with the aging page', async () => {
  const result = await landing()
  assert.deepEqual(result.aging.receivables.groups.map((group) => group.currency), ['GBP', 'USD'])
  const [gbp, usd] = result.aging.receivables.groups
  assert.deepEqual(buckets(gbp), {
    current: [1, '100.0000'], '1_30': [1, '50.0000'], '31_60': [1, '75.0000'], '61_90': [0, '0.0000'], '90_plus': [1, '25.5000'],
  })
  assert.equal(gbp.amount, '250.5000')
  assert.deepEqual(buckets(usd)['61_90'], [1, '40.0000'])
  // The aging page reads the same receivables into the same buckets.
  const page = await createOperationalFinanceO2cReadService({ prisma: fakePrisma(), capabilities, now: () => NOW }).aging({}, { identity })
  for (const group of page.groups) {
    const strip = result.aging.receivables.groups.find((entry) => entry.currency === group.currency)
    for (const bucket of AGING_BUCKETS) assert.equal(buckets(strip)[bucket][1], group[bucket], `${group.currency} ${bucket}`)
    assert.equal(strip.amount, group.total)
    assert.equal(strip.count, group.count)
  }
  // Payables age by the same days.
  const [payGbp] = result.aging.payables.groups
  assert.deepEqual(buckets(payGbp), {
    current: [3, '130.0000'], '1_30': [1, '10.0000'], '31_60': [0, '0.0000'], '61_90': [0, '0.0000'], '90_plus': [0, '0.0000'],
  })
})

test('ageByCurrency is the aging page rule: agingBucket(agingDays(due))', () => {
  const rows = [
    { currency: 'GBP', dueDate: day('2026-11-10'), outstandingAmount: '1.0000' },
    { currency: 'GBP', dueDate: day('2026-11-09'), outstandingAmount: '2.0000' },
    { currency: 'GBP', dueDate: day('2026-08-11'), outstandingAmount: '4.0000' },
    { currency: 'GBP', dueDate: day('2026-08-12'), outstandingAmount: '8.0000' },
  ]
  for (const row of rows) assert.ok(AGING_BUCKETS.includes(agingBucket(agingDays(row.dueDate, NOW, 'Europe/London'))))
  const group = ageByCurrency(rows, NOW, 'Europe/London').get('GBP')
  // Due today is current; yesterday is 1-30; 91 days is over 90; 90 days is 61-90.
  assert.deepEqual(group.counts, { current: 1, '1_30': 1, '31_60': 0, '61_90': 1, '90_plus': 1 })
  assert.equal(group.total, 150000n)
})

test('a reader without finance.amounts.read keeps the counts and gets no amount', async () => {
  const result = await landing(FULL.filter((code) => code !== 'finance.amounts.read'))
  assert.equal(result.cards.overdueReceivables, 3)
  assert.equal(result.cards.openReceivables, 5)
  for (const block of [result.money.payables, result.money.receivables, result.money.overdueReceivables]) {
    assert.equal(block.readable, true)
    assert.equal(block.amountsVisible, false)
    assert.ok(block.byCurrency.length > 0)
    for (const row of block.byCurrency) {
      assert.equal(row.amount, null)
      assert.ok(row.count > 0)
    }
  }
  for (const row of result.money.payables.byCurrency) assert.equal(row.dueSoonAmount, null)
  for (const view of [result.aging.receivables, result.aging.payables]) {
    assert.equal(view.amountsVisible, false)
    for (const group of view.groups) {
      assert.equal(group.amount, null)
      for (const row of group.buckets) assert.equal(row.amount, null)
    }
  }
  // Bucket counts stay, for the bar.
  assert.deepEqual(buckets(result.aging.receivables.groups[0]).current, [1, null])
  assert.ok(!/"(amount|dueSoonAmount)":"/.test(JSON.stringify({ money: result.money, aging: result.aging })), 'no amount in the payload')
})

test('a reader who may not read receivables or payables gets no rows from them, only the overview counts', async () => {
  const noReceivables = await landing(FULL.filter((code) => code !== 'finance.receivable.read'))
  assert.equal(noReceivables.cards.overdueReceivables, 3)
  for (const block of [noReceivables.money.receivables, noReceivables.money.overdueReceivables, noReceivables.aging.receivables]) {
    assert.equal(block.readable, false)
    assert.equal(block.amountsVisible, false)
  }
  assert.deepEqual(noReceivables.money.receivables.byCurrency, [])
  assert.deepEqual(noReceivables.aging.receivables.groups, [])
  // Payables are still readable with their amounts.
  assert.equal(noReceivables.money.payables.amountsVisible, true)
  assert.equal(byCurrency(noReceivables.money.payables.byCurrency).GBP.amount, '140.0000')

  const noPayables = await landing(FULL.filter((code) => code !== 'finance.payable.read'))
  assert.equal(noPayables.cards.approvedPayableObligations, 5)
  assert.equal(noPayables.money.payables.readable, false)
  assert.deepEqual(noPayables.money.payables.byCurrency, [])
  assert.deepEqual(noPayables.aging.payables.groups, [])
  assert.equal(noPayables.money.receivables.amountsVisible, true)

  // No finance.overview.read: no landing at all.
  await assert.rejects(landing(FULL.filter((code) => code !== 'finance.overview.read')), { code: 'PERMISSION_DENIED' })
})

test('the overview page shows amounts per currency, the aging strip, decision counts and quiet tiles', () => {
  const page = readFileSync(new URL('../../src/modules/finance/OperationalFinanceP2pWorkbench.tsx', import.meta.url), 'utf8')
  // Amount tiles open the list they total, with the same filter.
  for (const to of ['/app/finance/payables?status=outstanding', '/app/finance/receivables?status=outstanding', '/app/finance/receivables?status=overdue', '/app/procurement/bills?status=exception'])
    assert.ok(page.includes(`to="${to}"`), to)
  // Amounts are joined per currency, never summed.
  assert.match(page, /formatMetric\(Number\(row\.amount\), "currency", row\.currency, \{ locale, language \}\)\)\.join\(" · "\)/)
  // A hidden amount says so; the count stays.
  assert.match(page, /\$\{say\(plain\)\} · \$\{say\("amountHidden"\)\}/)
  // The aging strip: the aging page's buckets in the report palette, linking to the aging page.
  assert.match(page, /import \{ PALETTE \} from "\.\.\/reports\/charts\/chartOptions"/)
  for (const bucket of ['current', '1_30', '31_60', '61_90', '90_plus']) assert.ok(page.includes(`["${bucket}", `), bucket)
  assert.match(page, /"\/app\/finance\/aging"/)
  // Quiet tiles, shown at 0, and the notice as a caption.
  assert.match(page, /data-testid="finance-overview-secondary"/)
  assert.match(page, /value=\{data\.cards\[key\] \?\? 0\}/)
  assert.match(page, /data-testid="finance-overview-notice"/)
  assert.match(page, /\{t\("finance\.noMoneyMoved"\)\}/)
  // The currency card became one line.
  assert.doesNotMatch(page, /t\("finance\.currency"\)/)
  assert.match(page, /data-testid="finance-currency-limitation"/)
})
