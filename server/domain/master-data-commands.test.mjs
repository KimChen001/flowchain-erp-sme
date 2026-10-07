import test from 'node:test'
import assert from 'node:assert/strict'
import {
  customerInputIssues,
  itemInputIssues,
  itemSupplierInputIssues,
  listItemSupplierRecords,
  saveCustomerMaster,
  saveItemMaster,
  saveItemSupplier,
} from './master-data-commands.mjs'

// The field checks moved out of the commands into pure functions so the CSV
// import can run them before any write. The commands still call them, so a
// manual save reports the same fields and messages as before; each issue now
// also carries a code the interface can translate.
const fieldsAndMessages = (issues) => issues.map(({ field, message }) => ({ field, message }))

// A transaction client that has nothing stored and refuses any write.
const emptyTransaction = (overrides = {}) => ({
  $transaction: async (work) => work({
    item: { findFirst: async () => null, create: async () => assert.fail('no write expected'), update: async () => assert.fail('no write expected') },
    supplier: { findFirst: async () => null },
    warehouse: { findFirst: async () => null },
    runtimeRecord: { findFirst: async () => null, findMany: async () => [], create: async () => assert.fail('no write expected') },
    auditLog: { create: async () => assert.fail('no write expected') },
    ...overrides,
  }),
})
const scope = { tenantId: 'tenant-a' }

test('item checks keep their fields and messages and add codes', () => {
  const { issues, values } = itemInputIssues({ sku: 'BAD SKU', itemName: '', baseUnit: '', status: 'retired', safetyStock: -1, reorderPoint: 'x', minimumOrderQuantity: 0, purchaseLeadTimeDays: 1.5 })
  assert.deepEqual(issues, [
    { field: 'sku', code: 'SKU_INVALID', message: 'A SKU has at most 64 characters and no spaces.' },
    { field: 'itemName', code: 'NAME_REQUIRED', message: 'Enter an item name.' },
    { field: 'status', code: 'STATUS_INVALID', message: 'Choose a valid status.' },
    { field: 'baseUnit', code: 'UNIT_REQUIRED', message: 'Enter a unit.' },
    { field: 'safetyStock', code: 'NUMBER_INVALID', message: 'Safety stock must be a number, zero or greater.' },
    { field: 'reorderPoint', code: 'NUMBER_INVALID', message: 'Reorder point must be a number, zero or greater.' },
    { field: 'minimumOrderQuantity', code: 'POSITIVE_NUMBER_REQUIRED', message: 'Minimum order quantity must be a number greater than zero.' },
    { field: 'purchaseLeadTimeDays', code: 'WHOLE_NUMBER_REQUIRED', message: 'Lead time must be a whole number, zero or greater.' },
  ])
  assert.equal(values.sku, 'BAD SKU')
  assert.deepEqual(itemInputIssues({}).issues.map((row) => row.code), ['SKU_REQUIRED', 'NAME_REQUIRED'])
  // An existing item keeps its SKU, unit and status unless they are sent.
  const edit = itemInputIssues({ sku: 'OTHER' }, { sku: 'SKU-1', name: 'Valve', unit: 'EA', status: 'active' })
  assert.deepEqual(edit.issues.map((row) => row.code), ['SKU_LOCKED'])
  assert.deepEqual([edit.values.sku, edit.values.unit, edit.values.status], ['SKU-1', 'EA', 'active'])
  // Empty number fields are "not recorded", never zero.
  const empty = itemInputIssues({ sku: 'SKU-2', itemName: 'Pump', safetyStock: '', reorderPoint: null })
  assert.deepEqual([empty.issues, empty.values.safetyStock, empty.values.reorderPoint, empty.values.leadTimeDays], [[], null, null, undefined])
})

test('saveItemMaster still refuses with the same fields and messages', async () => {
  const error = await saveItemMaster(emptyTransaction(), null, { sku: 'BAD 1', itemName: '', baseUnit: 'EA', safetyStock: -1, defaultSupplierId: 'SUP-B' }, 'user', scope).catch((cause) => cause)
  assert.equal(error.status, 422)
  assert.equal(error.code, 'VALIDATION_ERROR')
  assert.deepEqual(fieldsAndMessages(error.details), [
    { field: 'sku', message: 'A SKU has at most 64 characters and no spaces.' },
    { field: 'itemName', message: 'Enter an item name.' },
    { field: 'safetyStock', message: 'Safety stock must be a number, zero or greater.' },
    { field: 'defaultSupplierId', message: 'Choose a supplier of this workspace.' },
  ])
  assert.deepEqual(error.details.map((row) => row.code), ['SKU_INVALID', 'NAME_REQUIRED', 'NUMBER_INVALID', 'SUPPLIER_NOT_FOUND'])
})

test('customer checks keep their fields and messages and never guess a currency', () => {
  const { issues } = customerInputIssues({ code: '', name: '', status: 'x', email: 'not-an-email', currency: 'zzz' })
  assert.deepEqual(issues, [
    { field: 'code', code: 'CODE_REQUIRED', message: 'Enter a customer code.' },
    { field: 'name', code: 'NAME_REQUIRED', message: 'Enter a customer name.' },
    { field: 'status', code: 'STATUS_INVALID', message: 'Choose a valid status.' },
    { field: 'email', code: 'EMAIL_INVALID', message: 'Enter a valid email address.' },
    { field: 'currency', code: 'CURRENCY_INVALID', message: 'Choose a valid currency.' },
  ])
  assert.equal(customerInputIssues({ code: 'C'.repeat(65), name: 'X' }).issues[0].code, 'CODE_TOO_LONG')
  const noCurrency = customerInputIssues({ code: 'CUST-1', name: 'Redwood' })
  assert.deepEqual([noCurrency.issues, noCurrency.values.currency], [[], undefined])
  const emptyCurrency = customerInputIssues({ code: 'CUST-1', name: 'Redwood', currency: '' })
  assert.deepEqual([emptyCurrency.issues, emptyCurrency.values.currency], [[], ''])
  assert.equal(customerInputIssues({ code: 'CUST-1', name: 'Redwood', currency: 'usd' }).values.currency, 'USD')
  // The stored email is checked when the edit does not send one.
  const old = { recordKey: 'CUST-1', payload: { name: 'Redwood', email: 'broken' } }
  assert.deepEqual(customerInputIssues({ code: 'CUST-2' }, old).issues.map((row) => row.code), ['CODE_LOCKED', 'EMAIL_INVALID'])
})

test('saveCustomerMaster still refuses with the same fields and messages', async () => {
  const error = await saveCustomerMaster(emptyTransaction(), null, { code: 'CUST-X', name: 'X', email: 'not-an-email', currency: 'ZZZ' }, 'user', scope).catch((cause) => cause)
  assert.equal(error.status, 422)
  assert.deepEqual(fieldsAndMessages(error.details), [
    { field: 'email', message: 'Enter a valid email address.' },
    { field: 'currency', message: 'Choose a valid currency.' },
  ])
})

test('item-supplier checks keep their fields and messages, and an empty currency is the supplier default', () => {
  const missing = itemSupplierInputIssues({ leadTimeDays: 1.5, minimumOrderQuantity: 0, referencePrice: -2, currency: 'zzz' })
  assert.deepEqual(missing.issues, [
    { field: 'supplierId', code: 'SUPPLIER_NOT_FOUND', message: 'Choose a supplier of this workspace.' },
    { field: 'leadTimeDays', code: 'WHOLE_NUMBER_REQUIRED', message: 'Lead time must be a whole number, zero or greater.' },
    { field: 'minimumOrderQuantity', code: 'POSITIVE_NUMBER_REQUIRED', message: 'Minimum order quantity must be a number greater than zero.' },
    { field: 'referencePrice', code: 'NUMBER_INVALID', message: 'Reference price must be a number, zero or greater.' },
    { field: 'currency', code: 'CURRENCY_INVALID', message: 'Choose a valid currency.' },
  ])
  const inactive = itemSupplierInputIssues({}, { supplier: { status: 'inactive', metadata: { defaultCurrency: 'EUR' } } })
  assert.deepEqual(inactive.issues.map((row) => row.code), ['SUPPLIER_INACTIVE'])
  assert.equal(inactive.values.currency, 'EUR')
  // A zero reference price is "not recorded".
  const zero = itemSupplierInputIssues({ referencePrice: 0 }, { supplier: { status: 'active', metadata: {} } })
  assert.deepEqual([zero.issues, zero.values.referencePrice, zero.values.currency], [[], null, ''])
  // An edit that sends no currency keeps the stored one.
  const edit = itemSupplierInputIssues({ leadTimeDays: 3 }, { old: { id: 'ISR-1' }, supplier: { status: 'inactive' } })
  assert.deepEqual([edit.issues, edit.values.currency, edit.values.leadTimeDays], [[], undefined, 3])
})

test('saveItemSupplier still refuses with the same fields and messages', async () => {
  const prisma = emptyTransaction({ item: { findFirst: async () => ({ id: 'ITEM-1', sku: 'SKU-1', tenantId: 'tenant-a' }) } })
  const error = await saveItemSupplier(prisma, 'SKU-1', null, { supplierId: 'SUP-OTHER', leadTimeDays: -1 }, 'user', scope).catch((cause) => cause)
  assert.equal(error.status, 422)
  assert.deepEqual(fieldsAndMessages(error.details), [
    { field: 'supplierId', message: 'Choose a supplier of this workspace.' },
    { field: 'leadTimeDays', message: 'Lead time must be a whole number, zero or greater.' },
  ])
})

test("one item's or supplier's links are filtered in the database, past any cap", async () => {
  // 2,500 links of other items sort before the one asked for.
  const stored = [
    ...Array.from({ length: 2500 }, (_, index) => ({ id: `ISR-${index}`, recordKey: `ITEM-A${String(index).padStart(4, '0')}::SUP-1`, payload: { itemId: `ITEM-A${String(index).padStart(4, '0')}`, supplierId: 'SUP-1' } })),
    { id: 'ISR-X', recordKey: 'ITEM-Z::SUP-2', payload: { itemId: 'ITEM-Z', supplierId: 'SUP-2', preferred: true } },
  ]
  const calls = []
  const prisma = {
    runtimeRecord: {
      findMany: async (args) => {
        calls.push(args)
        const key = args.where.recordKey
        const rows = stored.filter((row) => !key || (typeof key === 'string' ? row.recordKey === key : key.startsWith ? row.recordKey.startsWith(key.startsWith) : row.recordKey.endsWith(key.endsWith)))
        return args.take ? rows.slice(0, args.take) : rows
      },
    },
  }
  assert.deepEqual((await listItemSupplierRecords(prisma, 'tenant-a', { itemId: 'ITEM-Z' })).map((row) => row.id), ['ISR-X'])
  assert.deepEqual([calls[0].where.recordKey, calls[0].take], [{ startsWith: 'ITEM-Z::' }, undefined])
  assert.deepEqual((await listItemSupplierRecords(prisma, 'tenant-a', { supplierId: 'SUP-2' })).map((row) => row.id), ['ISR-X'])
  assert.deepEqual(calls[1].where.recordKey, { endsWith: '::SUP-2' })
  assert.equal((await listItemSupplierRecords(prisma, 'tenant-a', { supplierId: 'SUP-1' })).length, 2500)
  assert.equal(calls[2].where.tenantId, 'tenant-a')
})
