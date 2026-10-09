import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultRoleTemplates } from '../auth/permission-catalog.mjs'
import {
  CONTRACT_INPUT_FIELDS,
  ContractError,
  assertContractsEnabled,
  contractAccessFor,
  contractFieldIssues,
  contractHistoryDetails,
  contractMergedIssues,
  contractSnapshot,
  contractView,
  contractsEnabled,
  maskContract,
} from './contract-policy.mjs'

// The contract rules the commands and reads share: field checks, the view a
// reader gets, and the total value hidden without procurement.prices.read.

const roleActor = (roleKey) => ({ complete: true, authenticated: true, tenantId: 'tenant-c', userId: `user-${roleKey}`, user: { id: `user-${roleKey}` }, roleIds: [], inactiveRoleIds: [], permissionCodes: new Set(defaultRoleTemplates.find((role) => role.roleKey === roleKey).permissions), permissionSourceRoleIds: new Map() })
const fields = (result) => result.issues.map((issue) => `${issue.field}:${issue.code}`).sort()

test('a new contract needs a title, a type and a supplier, and gets the default renewal and reminder', () => {
  assert.deepEqual(fields(contractFieldIssues({}, { creating: true })), ['supplierId:REQUIRED', 'title:REQUIRED', 'type:REQUIRED'])
  const { values, issues } = contractFieldIssues({ title: '  2026 packaging supply  ', type: 'purchase_agreement', supplierId: 'SUP-1' }, { creating: true })
  assert.deepEqual(issues, [])
  assert.deepEqual(values, { title: '2026 packaging supply', type: 'purchase_agreement', supplierId: 'SUP-1', renewal: 'none', noticeDays: 0, reminderDays: 60 })
})

test('each field is checked: codes, real calendar days, whole days in range, currency and amount', () => {
  const result = contractFieldIssues({
    title: 'x'.repeat(201), type: 'lease', supplierId: 'SUP-1', startDate: '2026-02-30', endDate: '12/31/2026', signedOn: '2026-10-01',
    renewal: 'yearly', noticeDays: 731, reminderDays: -1, currency: 'XYZ', totalValue: '12.34567', notes: 'n'.repeat(4001), externalReference: 'r'.repeat(101),
  }, { creating: true })
  assert.deepEqual(fields(result), [
    'currency:CURRENCY_INVALID', 'endDate:DATE_INVALID', 'externalReference:TOO_LONG', 'notes:TOO_LONG', 'noticeDays:WHOLE_NUMBER_REQUIRED',
    'reminderDays:WHOLE_NUMBER_REQUIRED', 'renewal:INVALID', 'startDate:DATE_INVALID', 'title:TOO_LONG', 'totalValue:AMOUNT_INVALID', 'type:INVALID',
  ])
  assert.equal(result.values.signedOn, '2026-10-01')
  for (const totalValue of ['-1', '1e5', 'abc', '100000000000000']) assert.deepEqual(fields(contractFieldIssues({ totalValue })), ['totalValue:AMOUNT_INVALID'], totalValue)
  assert.equal(contractFieldIssues({ totalValue: '1250.5' }).values.totalValue, '1250.5000')
  assert.equal(contractFieldIssues({ totalValue: '99999999999999.9999' }).issues.length, 0)
  assert.equal(contractFieldIssues({ currency: 'eur' }).values.currency, 'EUR')
  assert.equal(contractFieldIssues({ noticeDays: '30' }).values.noticeDays, 30)
  assert.deepEqual(fields(contractFieldIssues({ noticeDays: 1.5 })), ['noticeDays:WHOLE_NUMBER_REQUIRED'])
})

test('an update carries only the fields sent, and an empty optional field clears it', () => {
  const { values, issues } = contractFieldIssues({ endDate: '', ownerId: '', totalValue: null, notes: '  ', externalReference: 'PO-77' })
  assert.deepEqual(issues, [])
  assert.deepEqual(values, { endDate: null, ownerId: null, totalValue: null, notes: null, externalReference: 'PO-77' })
  // The title, type and supplier cannot be emptied.
  assert.deepEqual(fields(contractFieldIssues({ title: ' ', type: '', supplierId: '' })), ['supplierId:REQUIRED', 'title:REQUIRED', 'type:REQUIRED'])
  assert.deepEqual(Object.keys(contractFieldIssues({ unknown: 1, status: 'active', version: 9 }).values), [])
  assert.ok(CONTRACT_INPUT_FIELDS.includes('reminderDays'))
})

test('across fields: the end date is on or after the start, and an active contract keeps its signed and start dates', () => {
  assert.deepEqual(contractMergedIssues({ startDate: '2026-01-01', endDate: '2025-12-31' }).map((issue) => issue.code), ['END_BEFORE_START'])
  assert.deepEqual(contractMergedIssues({ startDate: '2026-01-01', endDate: '2026-01-01' }), [])
  assert.deepEqual(contractMergedIssues({ status: 'active', startDate: null, signedOn: null }).map((issue) => issue.field), ['signedOn', 'startDate'])
  assert.deepEqual(contractMergedIssues({ status: 'draft', startDate: null, signedOn: null }), [])
})

const row = (overrides = {}) => ({
  id: 'C-1', number: 'CT-1A2B3C4D', title: 'Packaging supply', type: 'purchase_agreement', counterpartyType: 'supplier', supplierId: 'SUP-1', ownerId: 'U-1',
  status: 'active', startDate: new Date('2026-01-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), signedOn: new Date('2025-12-15T00:00:00.000Z'),
  renewal: 'none', noticeDays: 0, reminderDays: 60, paymentTermsId: 'NET30', currency: 'USD', totalValue: '125000', notes: null, externalReference: 'ACME-77',
  renewsContractId: null, terminatedOn: null, terminationReason: null, version: 3, createdById: 'U-1', createdAt: new Date('2025-12-01T15:00:00.000Z'), updatedAt: new Date('2026-01-02T15:00:00.000Z'),
  activatedAt: new Date('2025-12-15T15:00:00.000Z'), activatedById: 'U-1', terminatedAt: null,
  supplier: { id: 'SUP-1', code: 'ACME', name: 'Acme Packaging' }, owner: { id: 'U-1', name: 'Dana Buyer' }, renews: null, renewals: [],
  ...overrides,
})

test('the view carries calendar days as entered and the shown state on the workspace day', () => {
  const view = contractView(row(), { today: '2026-11-15' })
  assert.deepEqual([view.startDate, view.endDate, view.signedOn, view.totalValue], ['2026-01-01', '2026-12-31', '2025-12-15', '125000.0000'])
  assert.deepEqual([view.state, view.keyDate, view.daysUntilKeyDate, view.inReminderWindow], ['ending', '2026-12-31', 46, true])
  assert.deepEqual(view.supplier, { id: 'SUP-1', code: 'ACME', name: 'Acme Packaging' })
  // A draft renewal does not renew it yet; an activated one does.
  assert.equal(contractView(row({ renewals: [{ id: 'C-2', number: 'CT-00000002', status: 'draft', activatedAt: null }] }), { today: '2027-01-05' }).state, 'ended')
  const renewed = contractView(row({ renewals: [{ id: 'C-2', number: 'CT-00000002', status: 'active', activatedAt: new Date('2026-12-20T15:00:00.000Z') }] }), { today: '2027-01-05' })
  assert.deepEqual([renewed.state, renewed.renewals[0].number], ['renewed', 'CT-00000002'])
})

test('without procurement.prices.read the total value is null, never 0, and named as restricted', () => {
  const view = contractView(row(), { today: '2026-11-15' })
  const viewer = contractAccessFor(roleActor('read-only-viewer'))
  assert.deepEqual(viewer, { read: true, manage: false, prices: false, userId: 'user-read-only-viewer' })
  const masked = maskContract(view, viewer)
  assert.equal(masked.totalValue, null)
  assert.deepEqual(masked.restrictedFields, ['totalValue'])
  assert.equal(masked.currency, 'USD')
  assert.equal(JSON.stringify(masked).includes('125000'), false)
  const buyer = contractAccessFor(roleActor('procurement-specialist'))
  assert.deepEqual([buyer.read, buyer.manage, buyer.prices], [true, true, true])
  assert.equal(maskContract(view, buyer).totalValue, '125000.0000')
  const finance = contractAccessFor(roleActor('finance-specialist'))
  assert.deepEqual([finance.read, finance.manage, finance.prices], [true, false, false])
  assert.equal(contractAccessFor(roleActor('intake-uploader')).read, false)
})

test('history hides the total value from readers without prices and drops command bookkeeping', () => {
  const metadata = { commandType: 'contract.update', idempotencyKey: 'key-1', version: 4, changes: { totalValue: { before: '100.0000', after: '125.0000' }, notes: { before: null, after: 'Price review in May' } }, after: { title: 'T', totalValue: '125.0000' } }
  const hidden = contractHistoryDetails(metadata, { prices: false })
  assert.deepEqual(hidden, { version: 4, changes: { totalValue: { before: null, after: null, restricted: true }, notes: { before: null, after: 'Price review in May' } }, after: { title: 'T', totalValue: null } })
  assert.equal(JSON.stringify(hidden).includes('125.0000'), false)
  assert.deepEqual(contractHistoryDetails(metadata, { prices: true }).changes.totalValue, { before: '100.0000', after: '125.0000' })
  assert.equal('idempotencyKey' in contractHistoryDetails(metadata, { prices: true }), false)
  assert.deepEqual(contractHistoryDetails(null, { prices: false }), {})
})

test('the snapshot audited before and after is the entered form', () => {
  assert.deepEqual(contractSnapshot(row({ totalValue: '1.5', endDate: null })), {
    title: 'Packaging supply', externalReference: 'ACME-77', type: 'purchase_agreement', supplierId: 'SUP-1', ownerId: 'U-1', startDate: '2026-01-01', endDate: null, signedOn: '2025-12-15',
    renewal: 'none', noticeDays: 0, reminderDays: 60, paymentTermsId: 'NET30', currency: 'USD', totalValue: '1.5000', notes: null,
  })
})

test('contracts need FLOWCHAIN_ENABLE_CONTRACTS=true', () => {
  assert.equal(contractsEnabled({}), false)
  assert.equal(contractsEnabled({ FLOWCHAIN_ENABLE_CONTRACTS: 'true' }), true)
  assert.throws(() => assertContractsEnabled({}), (error) => error instanceof ContractError && error.status === 409 && error.code === 'CONTRACTS_CAPABILITY_NOT_AVAILABLE')
})
