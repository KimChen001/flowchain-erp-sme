import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTodayWork, TODAY_WORK_KINDS } from './today-work.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { handleBusinessReadContextRoute } from '../routes/business-read-context.routes.mjs'
import { defaultRoleTemplates } from '../auth/permission-catalog.mjs'

// Contracts on Today (docs/contracts-module-design.md §5): notice due, ending
// and past its end, ordered by date with the other work, for the contract's
// owner and for readers who manage contracts, only with the capability on.

const NY = 'America/New_York'
// 20:00 in New York on Oct 9, already Oct 10 in UTC.
const EVENING = new Date('2026-10-10T00:00:00.000Z')
const ON = { FLOWCHAIN_ENABLE_CONTRACTS: 'true' }

const contract = (id, overrides = {}) => ({
  id, tenantId: 'tenant-t', number: `CT-0000000${id.slice(-1)}`, title: `Agreement ${id}`, type: 'purchase_agreement', counterpartyType: 'supplier', supplierId: 'SUP-1', ownerId: 'user-owner',
  status: 'active', startDate: new Date('2026-01-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), signedOn: new Date('2025-12-15T00:00:00.000Z'),
  renewal: 'none', noticeDays: 0, reminderDays: 60, paymentTermsId: null, currency: null, totalValue: null, notes: null, externalReference: null, renewsContractId: null,
  terminatedOn: null, terminationReason: null, version: 2, createdById: 'user-owner', createdAt: new Date('2025-12-01T00:00:00.000Z'), updatedAt: new Date('2025-12-15T00:00:00.000Z'),
  activatedAt: new Date('2025-12-15T00:00:00.000Z'), activatedById: 'user-owner', terminatedAt: null,
  supplier: { id: 'SUP-1', code: 'ACME', name: 'Acme Packaging' }, owner: { id: 'user-owner', name: 'Owner' }, renews: null, renewals: [],
  ...overrides,
})
// On Oct 9 in New York:
const rows = [
  // ends Oct 30: inside its 60-day window.
  contract('C-1', { endDate: new Date('2026-10-30T00:00:00.000Z') }),
  // renews automatically on Dec 31 with 60 days' notice: give notice by Nov 1, inside the window.
  contract('C-2', { renewal: 'automatic', noticeDays: 60, ownerId: 'user-other', owner: { id: 'user-other', name: 'Other' } }),
  // renews automatically and its end date, Oct 8, has passed: nobody recorded the new end date.
  contract('C-3', { renewal: 'automatic', endDate: new Date('2026-10-08T00:00:00.000Z') }),
  // ended Oct 1 with no renewal and nothing recorded.
  contract('C-4', { endDate: new Date('2026-10-01T00:00:00.000Z') }),
  // ended, but its renewal was activated: renewed, not work.
  contract('C-5', { endDate: new Date('2026-10-01T00:00:00.000Z'), renewals: [{ id: 'C-9', number: 'CT-00000009', status: 'active', activatedAt: new Date('2026-09-20T00:00:00.000Z') }] }),
  // ends in 2027: outside its window.
  contract('C-6', { endDate: new Date('2027-06-30T00:00:00.000Z') }),
  // ends today, Oct 9, in New York, although it is Oct 10 in UTC.
  contract('C-7', { endDate: new Date('2026-10-09T00:00:00.000Z'), reminderDays: 0 }),
]

test('contract rows name the number, title, supplier and key date, and open the contract', () => {
  for (const kind of ['contract_notice_due', 'contract_ending', 'contract_past_end']) assert.ok(TODAY_WORK_KINDS.includes(kind))
  const work = buildTodayWork({
    contracts: [
      { id: 'C-1', number: 'CT-00000001', title: 'Packaging supply', supplierName: 'Acme Packaging', state: 'ending', keyDate: '2026-10-30', endDate: '2026-10-30', noticeDeadline: null, renewal: 'none' },
      { id: 'C-2', number: 'CT-00000002', title: 'Freight', supplierName: 'Gamma Freight', state: 'notice_due', keyDate: '2026-11-01', endDate: '2026-12-31', noticeDeadline: '2026-11-01', renewal: 'automatic' },
      { id: 'C-3', number: 'CT-00000003', title: 'Cleaning', supplierName: null, state: 'past_end', keyDate: '2026-10-08', endDate: '2026-10-08', noticeDeadline: '2026-10-08', renewal: 'automatic' },
      { id: 'C-4', number: 'CT-00000004', title: 'Labels', supplierName: 'Beta Labels', state: 'ended', keyDate: '2026-10-01', endDate: '2026-10-01', noticeDeadline: null, renewal: 'by_agreement' },
      { id: 'C-5', number: 'CT-00000005', title: 'Renewed', supplierName: 'Acme Packaging', state: 'renewed', keyDate: '2026-10-01' },
      { id: 'C-6', number: 'CT-00000006', title: 'Later', supplierName: 'Acme Packaging', state: 'active', keyDate: '2027-06-30' },
    ],
  }, { now: EVENING, timeZone: NY })
  assert.equal(work.today, '2026-10-09')
  assert.deepEqual(work.items.map((item) => [item.kind, item.label, item.date, item.dateKind, item.overdueDays]), [
    ['contract_past_end', 'CT-00000004', '2026-10-01', 'ended', 8],
    ['contract_past_end', 'CT-00000003', '2026-10-08', 'ended', 1],
    ['contract_ending', 'CT-00000001', '2026-10-30', 'ends', 0],
    ['contract_notice_due', 'CT-00000002', '2026-11-01', 'notice_by', 0],
  ])
  const ending = work.items.find((item) => item.recordId === 'C-1')
  assert.deepEqual([ending.entityType, ending.name, ending.href, ending.actionHref, ending.detail], ['contract', 'Acme Packaging', '/app/contracts/C-1', null, { title: 'Packaging supply', renewal: 'none', endDate: '2026-10-30', noticeDeadline: null }])
  assert.equal(work.overdue, 2)
})

test('contract rows sort by date among the other work', () => {
  const work = buildTodayWork({
    purchaseRequests: [{ id: 'PR-1', status: 'submitted', requiredDate: '2026-10-20' }],
    contracts: [{ id: 'C-1', number: 'CT-00000001', title: 'T', supplierName: 'S', state: 'ending', keyDate: '2026-10-15', endDate: '2026-10-15' }, { id: 'C-2', number: 'CT-00000002', title: 'T', supplierName: 'S', state: 'ending', keyDate: '2026-10-25', endDate: '2026-10-25' }],
  }, { now: EVENING, timeZone: NY })
  assert.deepEqual(work.items.map((item) => item.label), ['CT-00000001', 'PR-1', 'CT-00000002'])
})

// The route, with each reader's permissions, against a database stand-in.
const reader = (roleKey, userId) => reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-t', userId, user: { id: userId }, permissionCodes: new Set(defaultRoleTemplates.find((role) => role.roleKey === roleKey).permissions) })

function database(queries) {
  return {
    contract: {
      findMany: async (args) => {
        queries.push(args.where)
        return rows.filter((row) => row.status === args.where.status && row.endDate && row.endDate <= args.where.endDate.lte && (!args.where.ownerId || row.ownerId === args.where.ownerId))
      },
    },
    customerInvoice: { findMany: async () => [] },
    receivableObligation: { findMany: async () => [] },
    item: { count: async () => 1 },
    supplier: { count: async () => 1 },
    runtimeRecord: { count: async () => 1 },
    inventoryBalance: { count: async () => 1 },
    user: { count: async () => 2 },
    workspaceInvitation: { count: async () => 0 },
  }
}
const repositories = {
  masterData: { listItems: async () => [], listSuppliers: async () => [], listCustomers: async () => [], listAllItemSupplierRelationships: async () => [] },
  inventoryRuntime: { listItems: async () => [] },
  salesOrders: { listOrders: async () => [] },
  procurementRuntime: { snapshot: async () => ({ purchaseRequests: [], rfqs: [], purchaseOrders: [], receipts: [], supplierInvoices: [] }), listForReport: async () => [] },
}

async function homeFor(access, env = ON) {
  const queries = []
  let response
  await handleBusinessReadContextRoute({
    req: { method: 'GET' }, res: {}, url: new URL('http://local/api/home/overview'), repositories, dataMode: 'user',
    identity: { authenticated: true, tenantId: 'tenant-t' }, reportReadAccess: access, tenantTimezone: NY, homeOverviewNow: EVENING, homeOverviewPrisma: database(queries), env,
    send: (_res, status, payload) => { response = { status, payload: JSON.parse(JSON.stringify(payload)) } },
  })
  return { ...response, queries }
}
const contractRows = (payload) => payload.workItems.filter((item) => item.entityType === 'contract').map((item) => [item.kind, item.recordId])

test('a reader who manages contracts sees every contract that needs attention, on the workspace day', async () => {
  const { status, payload, queries } = await homeFor(reader('procurement-specialist', 'user-buyer'))
  assert.equal(status, 200)
  assert.equal(payload.today, '2026-10-09')
  assert.deepEqual(contractRows(payload), [
    ['contract_past_end', 'C-4'],
    ['contract_past_end', 'C-3'],
    ['contract_ending', 'C-7'],
    ['contract_ending', 'C-1'],
    ['contract_notice_due', 'C-2'],
  ])
  assert.equal(queries[0].ownerId, undefined)
  assert.equal(queries[0].tenantId, 'tenant-t')
  assert.equal(payload.hidden.includes('contracts'), false)
})

test('a reader who only reads contracts sees the ones they own', async () => {
  const { payload, queries } = await homeFor(reader('finance-specialist', 'user-owner'))
  assert.equal(queries[0].ownerId, 'user-owner')
  assert.deepEqual(contractRows(payload).map(([, id]) => id).sort(), ['C-1', 'C-3', 'C-4', 'C-7'])
  const other = await homeFor(reader('read-only-viewer', 'user-nobody'))
  assert.deepEqual(contractRows(other.payload), [])
})

test('without the capability or the read permission there are no contract rows', async () => {
  const off = await homeFor(reader('procurement-specialist', 'user-buyer'), {})
  assert.deepEqual([contractRows(off.payload), off.queries, off.payload.hidden.includes('contracts')], [[], [], false])
  const noRead = reader('intake-uploader', 'user-intake')
  const denied = await homeFor(noRead)
  assert.deepEqual([contractRows(denied.payload), denied.queries], [[], []])
  assert.ok(denied.payload.hidden.includes('contracts'))
  // A reader without a user id (a test header identity) and without manage reads nothing.
  const anonymous = await homeFor(reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-t', permissionCodes: new Set(['contracts.contract.read']) }))
  assert.deepEqual(anonymous.queries, [])
})

test('a contract source that cannot be read is named instead of failing the page', async () => {
  let response
  const broken = database([])
  broken.contract.findMany = async () => { throw new Error('relation "Contract" does not exist') }
  await handleBusinessReadContextRoute({
    req: { method: 'GET' }, res: {}, url: new URL('http://local/api/home/overview'), repositories, dataMode: 'user',
    identity: { authenticated: true, tenantId: 'tenant-t' }, reportReadAccess: reader('operations-manager', 'user-manager'), tenantTimezone: NY, homeOverviewNow: EVENING, homeOverviewPrisma: broken, env: ON,
    send: (_res, status, payload) => { response = { status, payload } },
  })
  assert.equal(response.status, 200)
  assert.ok(response.payload.limitations.includes('today_source_unavailable:contracts'))
})
