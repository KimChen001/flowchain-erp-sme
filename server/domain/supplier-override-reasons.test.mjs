import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SUPPLIER_OVERRIDE_REASONS, overrideNeeded, validateSupplierOverride } from '../../shared/supplier-override-reasons.mjs'
import { canonicalPurchaseRequestLines, missingSupplierOverrides } from './procurement-workflow.mjs'

test('a reason is needed only when a preferred supplier exists and another one is chosen', () => {
  assert.equal(overrideNeeded({ supplierId: 'sup-b', preferredId: 'sup-a' }), true)
  assert.equal(overrideNeeded({ supplierId: 'sup-a', preferredId: 'sup-a' }), false)
  assert.equal(overrideNeeded({ supplierId: ' sup-a ', preferredId: 'sup-a' }), false)
  assert.equal(overrideNeeded({ supplierId: 'sup-b', preferredId: '' }), false)
  assert.equal(overrideNeeded({ supplierId: 'sup-b', preferredId: null }), false)
  assert.equal(overrideNeeded({ supplierId: 'sup-b' }), false)
  assert.equal(overrideNeeded(), false)
})

test('when master data marks two sources preferred, choosing either needs no reason', () => {
  assert.equal(overrideNeeded({ supplierId: 'sup-a', preferredIds: ['sup-a', 'sup-b'] }), false)
  assert.equal(overrideNeeded({ supplierId: 'sup-b', preferredIds: ['sup-a', 'sup-b'] }), false)
  assert.equal(overrideNeeded({ supplierId: 'sup-c', preferredIds: ['sup-a', 'sup-b'] }), true)
  assert.equal(overrideNeeded({ supplierId: 'sup-c', preferredIds: [] }), false)
})

test('the reason list is fixed and in its agreed order', () => {
  assert.deepEqual(SUPPLIER_OVERRIDE_REASONS, ['price', 'lead_time', 'stock_now', 'quality', 'moq_fit', 'customer_specified', 'other'])
  assert.throws(() => SUPPLIER_OVERRIDE_REASONS.push('cheapest'))
})

test('a needed reason must be a known code; Other needs a note of at least 3 characters', () => {
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'lead_time' }, true), { value: { reasonCode: 'lead_time', note: null }, issues: [] })
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'price', note: '  Quoted 8% lower  ' }, true).value, { reasonCode: 'price', note: 'Quoted 8% lower' })
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'other', note: 'Sample approved' }, true).value, { reasonCode: 'other', note: 'Sample approved' })
  assert.deepEqual(validateSupplierOverride(undefined, true), { value: null, issues: [{ field: 'reasonCode', code: 'REASON_REQUIRED' }] })
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'cheapest' }, true).issues, [{ field: 'reasonCode', code: 'REASON_UNKNOWN' }])
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'other' }, true).issues, [{ field: 'note', code: 'NOTE_LENGTH' }])
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'other', note: 'ok' }, true).issues, [{ field: 'note', code: 'NOTE_LENGTH' }])
  assert.equal(validateSupplierOverride({ reasonCode: 'other', note: 'x'.repeat(500) }, true).issues.length, 0)
  // An optional note is never refused for being short.
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'price', note: 'ok' }, true), { value: { reasonCode: 'price', note: 'ok' }, issues: [] })
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'lead_time', note: '2d' }, true).value, { reasonCode: 'lead_time', note: '2d' })
  assert.deepEqual(validateSupplierOverride('lead_time', true).issues, [{ field: 'reasonCode', code: 'REASON_REQUIRED' }])
})

test('a note is kept to its first 500 characters and never refused for its length', () => {
  for (const reasonCode of ['quality', 'lead_time', 'other']) {
    const result = validateSupplierOverride({ reasonCode, note: `${'x'.repeat(500)}${'y'.repeat(100)}` }, true)
    assert.deepEqual(result.issues, [], reasonCode)
    assert.equal(result.value.note, 'x'.repeat(500), reasonCode)
  }
  // Cutting never leaves trailing spaces, and Other still needs 3 characters.
  assert.equal(validateSupplierOverride({ reasonCode: 'price', note: `${'x'.repeat(498)}   tail` }, true).value.note, 'x'.repeat(498))
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'other', note: '  ok  ' }, true).issues, [{ field: 'note', code: 'NOTE_LENGTH' }])
})

test('when no reason is needed, anything sent is dropped', () => {
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'price', note: 'kept?' }, false), { value: null, issues: [] })
  assert.deepEqual(validateSupplierOverride({ reasonCode: 'nonsense' }, false), { value: null, issues: [] })
})

// A master data stub scoped to one workspace, as tenantScopedProcurementMasterData returns it.
const repository = (approved) => ({
  getSupplier: async (id) => ({ id, name: { 'sup-a': 'Acme Supply', 'sup-b': 'Bolt Parts' }[id] || id, status: 'active' }),
  getItem: async (id) => ({ itemId: id, sku: `SKU-${id}`, itemName: 'Pallet wrap', purchaseUnit: 'EA', status: 'active', purchasable: true }),
  approvedSuppliersForItem: async () => approved,
})
const line = (overrides = {}) => ({ lineId: 'l-1', sourceType: 'catalog_item', lineBasis: 'quantity', itemId: 'item-1', supplierId: 'sup-b', quantity: 10, estimatedUnitPrice: 2, currency: 'USD', needByDate: '2026-10-20', ...overrides })
const withPreferred = [{ id: 'sup-a', name: 'Acme Supply', preferred: true }, { id: 'sup-b', name: 'Bolt Parts', preferred: false }]

test('a line with a non-preferred supplier and no reason is refused with the field to fix', async () => {
  await assert.rejects(canonicalPurchaseRequestLines([line({ lineId: 'l-0', supplierId: 'sup-a' }), line()], repository(withPreferred)), (error) => {
    assert.equal(error.code, 'SUPPLIER_OVERRIDE_REASON_REQUIRED')
    assert.equal(error.status, 400)
    assert.match(error.message, /^Line 2 does not use the item's preferred supplier \(Acme Supply\)\. Choose a reason from the list\.$/)
    assert.deepEqual(error.details, [{ field: 'lines.1.supplierOverride.reasonCode', code: 'REASON_REQUIRED', message: 'Choose a reason' }])
    return true
  })
  await assert.rejects(canonicalPurchaseRequestLines([line({ supplierOverride: { reasonCode: 'other', note: '' } })], repository(withPreferred)), (error) => {
    assert.deepEqual(error.details, [{ field: 'lines.0.supplierOverride.note', code: 'NOTE_LENGTH', message: 'Other needs a note of at least 3 characters' }])
    assert.match(error.message, /Other needs a note of at least 3 characters\.$/)
    return true
  })
  // A long note under a chosen reason is saved, cut to 500 characters.
  const [long] = await canonicalPurchaseRequestLines([line({ supplierOverride: { reasonCode: 'lead_time', note: 'z'.repeat(600) } })], repository(withPreferred))
  assert.equal(long.supplierOverride.note, 'z'.repeat(500))
})

test('a given reason is stored with the preferred supplier as it was at save time', async () => {
  const [saved] = await canonicalPurchaseRequestLines([line({ supplierOverride: { reasonCode: 'lead_time', note: 'Needed this week', preferredSupplierName: 'spoofed' } })], repository(withPreferred))
  assert.deepEqual(saved.supplierOverride, { reasonCode: 'lead_time', note: 'Needed this week', preferredSupplierId: 'sup-a', preferredSupplierIds: ['sup-a'], preferredSupplierName: 'Acme Supply' })
})

test('with two sources marked preferred, neither needs a reason and a third names both', async () => {
  const twoPreferred = [{ id: 'sup-a', name: 'Acme Supply', preferred: true }, { id: 'sup-b', name: 'Bolt Parts', preferred: true }, { id: 'sup-c', name: 'Crane', preferred: false }]
  const [bolt] = await canonicalPurchaseRequestLines([line({ supplierId: 'sup-b' })], repository(twoPreferred))
  assert.equal(bolt.supplierOverride, null)
  const [acme] = await canonicalPurchaseRequestLines([line({ supplierId: 'sup-a' })], repository(twoPreferred))
  assert.equal(acme.supplierOverride, null)
  await assert.rejects(canonicalPurchaseRequestLines([line({ supplierId: 'sup-c' })], repository(twoPreferred)), (error) => {
    assert.match(error.message, /one of the item's preferred suppliers \(Acme Supply, Bolt Parts\)/)
    return true
  })
  const [crane] = await canonicalPurchaseRequestLines([line({ supplierId: 'sup-c', supplierOverride: { reasonCode: 'price', note: 'ok' } })], repository(twoPreferred))
  assert.deepEqual(crane.supplierOverride, { reasonCode: 'price', note: 'ok', preferredSupplierId: 'sup-a', preferredSupplierIds: ['sup-a', 'sup-b'], preferredSupplierName: 'Acme Supply, Bolt Parts' })
})

// The approver's flag names the preferred supplier the line does not use;
// the Chinese must say "not used", never call that supplier non-preferred.
test('the approver flag and count say which supplier was skipped, in both languages', () => {
  const source = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..', '..'), 'src', 'components', 'procurement', 'SupplierOverrideReason.tsx'), 'utf8')
  assert.match(source, /flag: "Not preferred \(\{name\}\)\. Reason: \{reason\}"/)
  assert.match(source, /flag: "未使用首选供应商（\{name\}）。原因：\{reason\}"/)
  assert.match(source, /flagNoName: "未使用首选供应商。原因：\{reason\}"/)
  assert.match(source, /countOne: "1 行未使用首选供应商"/)
  assert.match(source, /countMany: "\{n\} 行未使用首选供应商"/)
  assert.match(source, /countOne: "1 line skips the preferred supplier"/)
  // More than one preferred source reads in the plural, and a line saved
  // before reasons were asked says that none was recorded.
  assert.match(source, /questionMany: "Why not one of the preferred suppliers \(\{name\}\)\?"/)
  assert.match(source, /flagMany: "None of the preferred suppliers \(\{name\}\)\. Reason: \{reason\}"/)
  assert.match(source, /missing: "Not preferred \(\{name\}\)\. No reason recorded"/)
  assert.match(source, /missing: "未使用首选供应商（\{name\}）。未记录原因"/)
  assert.match(source, /flagMany: "未使用任一首选供应商（\{name\}）。原因：\{reason\}"/)
  assert.doesNotMatch(source, /非首选/)
})

test('choosing the preferred supplier, an item with none preferred, or a non-catalog line stores no reason', async () => {
  const sent = { reasonCode: 'price' }
  const [preferred] = await canonicalPurchaseRequestLines([line({ supplierId: 'sup-a', supplierOverride: sent })], repository(withPreferred))
  assert.equal(preferred.supplierOverride, null)
  const nonePreferred = withPreferred.map((row) => ({ ...row, preferred: false }))
  const [open] = await canonicalPurchaseRequestLines([line({ supplierOverride: sent })], repository(nonePreferred))
  assert.equal(open.supplierOverride, null)
  const [other] = await canonicalPurchaseRequestLines([line({ sourceType: 'non_catalog_item', itemId: null, itemNameSnapshot: 'Dispenser', unitSnapshot: 'EA', supplierOverride: sent })], repository(withPreferred))
  assert.equal(other.supplierOverride, null)
})

// Saved lines as PurchaseRequestLine rows.
const saved = (overrides = {}, metadata = {}) => ({ id: 'row-1', itemId: 'item-1', ...overrides, metadata: { sourceType: 'catalog_item', supplierId: 'sup-b', ...metadata } })

test('a saved line that skips the preferred supplier with no reason is marked, never refused', async () => {
  const rows = [
    saved(),
    saved({ id: 'row-2' }, { supplierId: 'sup-a' }),
    saved({ id: 'row-3' }, { supplierOverride: { reasonCode: 'price', note: null, preferredSupplierId: 'sup-a', preferredSupplierName: 'Acme Supply' } }),
    saved({ id: 'row-4', itemId: null }, { sourceType: 'non_catalog_item' }),
  ]
  const result = await missingSupplierOverrides(rows, repository(withPreferred))
  assert.deepEqual(result[0], { reasonCode: null, note: null, missingReason: true, preferredSupplierId: 'sup-a', preferredSupplierIds: ['sup-a'], preferredSupplierName: 'Acme Supply' })
  assert.equal(result[1], null)
  // A recorded reason stays as it was recorded.
  assert.equal(result[2], rows[2].metadata.supplierOverride)
  assert.equal(result[3], null)
  // A draft saved before the item had a preferred supplier needs nothing until one exists.
  assert.deepEqual(await missingSupplierOverrides([saved()], repository(withPreferred.map((row) => ({ ...row, preferred: false })))), [null])
  // Sources that cannot be read leave the line as it is.
  const failing = { approvedSuppliersForItem: async () => { throw new Error('down') } }
  assert.deepEqual(await missingSupplierOverrides([saved()], failing), [undefined])
  assert.deepEqual(await missingSupplierOverrides([saved()], undefined), [undefined])
})
