import test from 'node:test'
import assert from 'node:assert/strict'
import { itemRequestUnit, itemStockUnit, sameUnit, unitOtherThanStock } from './item-stock-unit.mjs'
import { buildReceivingPostingPlan } from './receiving-transaction-policy.mjs'
import { canonicalPurchaseRequestLines } from './procurement-workflow.mjs'
import { saveItemMaster } from './master-data-commands.mjs'

// No conversion between units is recorded, so purchase request lines,
// receipts and stock balances stay in the item's stock unit (design audit
// L1-02 = L3-01), and the stock unit is locked once stock or open orders
// hold it (L4-04). The database paths are covered in
// receiving-posting-transaction.test.mjs, tests/postgres/master-data-writes
// and tests/postgres/procurement-db-flow.

test('the stock unit is the recorded unit, and units compare ignoring case', () => {
  assert.equal(itemStockUnit({ unit: ' pcs ' }), 'pcs')
  assert.equal(itemStockUnit({ unit: null, metadata: { baseUom: 'box' } }), 'box')
  assert.equal(itemStockUnit({ metadata: { uom: 'kg' } }), 'kg')
  assert.equal(itemStockUnit(null), '')
  assert.equal(sameUnit('PCS', 'pcs'), true)
  assert.equal(sameUnit('CASE', 'pcs'), false)
  assert.equal(unitOtherThanStock('pcs', ['PCS', '', null, 'CASE']), 'CASE')
  assert.equal(unitOtherThanStock('pcs', ['pcs', undefined]), '')
  // A stock unit that is not recorded is not judged.
  assert.equal(unitOtherThanStock('', ['CASE']), '')
})

// The posting plan's reads, with one item, one active warehouse and the
// stock record given.
const planPrisma = ({ item, balance = null }) => ({
  item: { findFirst: async ({ where }) => (where.id === item.id && where.sku === item.sku ? item : null) },
  warehouse: { findFirst: async () => ({ id: 'WH-1' }) },
  inventoryBalance: { findUnique: async () => balance },
})
const receipt = ({ lineUnit, poUnit }) => ({
  receivingDocument: { id: 'GRN-1', postingStatus: 'unposted', workflowStatus: 'approved', warehouseId: 'WH-1', lines: [{ id: 'GRN-1-L1', purchaseOrderLineId: 'PO-1-L1', itemId: 'ITEM-1', sku: 'CAP-1', acceptedQty: '10', rejectedQty: '0', unit: lineUnit, warehouseId: 'WH-1', location: 'A-01' }] },
  purchaseOrder: { id: 'PO-1', status: 'issued', lines: [{ id: 'PO-1-L1', itemId: 'ITEM-1', sku: 'CAP-1', orderedQuantity: '10', receivedQuantity: '0', unit: poUnit }] },
})

test('a receipt in a unit other than the stock unit is blocked, not booked as stock units', async () => {
  const item = { id: 'ITEM-1', sku: 'CAP-1', unit: 'pcs', metadata: {} }
  const plan = await buildReceivingPostingPlan({ prisma: planPrisma({ item, balance: { onHandQuantity: '40', availableQuantity: '40', unit: 'pcs' } }), tenantId: 't-1', ...receipt({ lineUnit: 'CASE', poUnit: 'CASE' }) })
  assert.equal(plan.allowed, false)
  const blocked = plan.blockingIssues.find((issue) => issue.code === 'RECEIVING_UNIT_MISMATCH')
  assert.equal(blocked.status, 409)
  assert.deepEqual(blocked.details, { receivingLineId: 'GRN-1-L1', purchaseOrderLineId: 'PO-1-L1', sku: 'CAP-1', unit: 'CASE', stockUnit: 'pcs' })
  assert.match(blocked.message, /is in CASE, but CAP-1 is stocked in pcs/)

  // The PO line alone in another unit is enough; the receipt copies its unit.
  const poOnly = await buildReceivingPostingPlan({ prisma: planPrisma({ item }), tenantId: 't-1', ...receipt({ lineUnit: null, poUnit: 'box' }) })
  assert.deepEqual(poOnly.blockingIssues.map((issue) => issue.code), ['RECEIVING_UNIT_MISMATCH'])
})

test('a receipt in the stock unit posts, booked in the stock unit', async () => {
  const item = { id: 'ITEM-1', sku: 'CAP-1', unit: 'pcs', metadata: {} }
  const plan = await buildReceivingPostingPlan({ prisma: planPrisma({ item }), tenantId: 't-1', ...receipt({ lineUnit: 'PCS', poUnit: 'PCS' }) })
  assert.equal(plan.allowed, true)
  assert.equal(plan.quantityPlans[0].unit, 'pcs')
  // An item without a recorded unit is not judged; the line's unit is kept.
  const unrecorded = await buildReceivingPostingPlan({ prisma: planPrisma({ item: { ...item, unit: null } }), tenantId: 't-1', ...receipt({ lineUnit: 'CASE', poUnit: 'CASE' }) })
  assert.equal(unrecorded.allowed, true)
  assert.equal(unrecorded.quantityPlans[0].unit, 'CASE')
})

// The master data a purchase request line reads, as the repository maps an
// item: recordedUnit is the stock unit, purchaseUnit falls back to it.
const catalog = (item) => ({
  getSupplier: async (id) => ({ id, name: 'Acme Supply', status: 'active' }),
  getItem: async (id) => ({ itemId: id, sku: 'CAP-1', itemName: 'Cap', status: 'active', purchasable: true, defaultSupplierId: 'sup-a', ...item }),
})
const prLine = (overrides = {}) => ({ lineId: 'l-1', sourceType: 'catalog_item', lineBasis: 'quantity', itemId: 'item-1', supplierId: 'sup-a', quantity: 10, estimatedUnitPrice: 2, currency: 'USD', needByDate: '2026-12-01', ...overrides })

test('a purchase request line is built in the stock unit, whatever the purchase unit says', async () => {
  // Stocked in box, purchase unit pcs: the line is requested and saved in box.
  const boxItem = catalog({ recordedUnit: 'box', baseUnit: 'box', purchaseUnit: 'pcs' })
  for (const sent of ['box', 'BOX', undefined]) {
    const [line] = await canonicalPurchaseRequestLines([prLine({ unitSnapshot: sent })], boxItem)
    assert.equal(line.unitSnapshot, 'box', String(sent))
  }
  assert.deepEqual(itemRequestUnit({ recordedUnit: 'box', baseUnit: 'box', purchaseUnit: 'pcs' }), { stockUnit: 'box', unit: 'box' })
})

test('a purchase request line that names another unit than the stock unit is refused, not relabelled', async () => {
  for (const [item, sent] of [[{ recordedUnit: 'pcs', baseUnit: 'pcs', purchaseUnit: 'pcs' }, 'CASE'], [{ recordedUnit: 'box', baseUnit: 'box', purchaseUnit: 'pcs' }, 'pcs']]) {
    await assert.rejects(canonicalPurchaseRequestLines([prLine({ unitSnapshot: sent })], catalog(item)), (error) => {
      assert.equal(error.code, 'PURCHASE_UNIT_CONVERSION_MISSING')
      assert.equal(error.status, 400)
      assert.match(error.message, new RegExp(`^Line 1: CAP-1 is stocked in ${item.recordedUnit} and no conversion from ${sent} is recorded`))
      return true
    })
  }
  // An item without a recorded unit is not judged, as before.
  const [unrecorded] = await canonicalPurchaseRequestLines([prLine({ unitSnapshot: 'box' })], catalog({ recordedUnit: '', baseUnit: 'pcs', purchaseUnit: 'box' }))
  assert.equal(unrecorded.unitSnapshot, 'box')
})

// A transaction client holding one item in pcs, with what else is stored
// about it; it records the item writes.
function itemStore({ holders = {} } = {}) {
  const writes = []
  const found = (name) => async () => (holders[name] ? { id: `${name}-1` } : null)
  const tx = {
    item: { findFirst: async () => ({ id: 'ITEM-1', sku: 'CAP-1', name: 'Cap', unit: 'pcs', status: 'active', metadata: { version: 3, baseUom: 'pcs' } }), update: async ({ data }) => { writes.push(data); return { id: 'ITEM-1', ...data } } },
    supplier: { findFirst: async () => null },
    warehouse: { findFirst: async () => null },
    inventoryBalance: { findFirst: found('balance') },
    inventoryMovement: { findFirst: found('movement') },
    purchaseOrderLine: { findFirst: found('purchaseOrderLine') },
    salesOrderLine: { findFirst: found('salesOrderLine') },
    purchaseRequestLine: { findFirst: found('purchaseRequestLine') },
    auditLog: { create: async () => ({}) },
  }
  return { prisma: { $transaction: async (work) => work(tx) }, writes }
}
const scope = { tenantId: 'tenant-a' }

test('an item unit cannot change once stock or open orders hold it', async () => {
  for (const [holder, expected] of [['balance', 'stock_balance'], ['movement', 'stock_movement'], ['purchaseOrderLine', 'purchase_order_line'], ['salesOrderLine', 'sales_order_line'], ['purchaseRequestLine', 'purchase_request_line']]) {
    const store = itemStore({ holders: { [holder]: true } })
    const error = await saveItemMaster(store.prisma, 'ITEM-1', { baseUnit: 'box', expectedVersion: 3 }, 'user', scope).catch((cause) => cause)
    assert.equal(error.code, 'UNIT_LOCKED', holder)
    assert.equal(error.status, 409)
    assert.deepEqual(error.details.map(({ field, code, holder: held }) => ({ field, code, held })), [{ field: 'baseUnit', code: 'UNIT_LOCKED', held: expected }])
    assert.equal(store.writes.length, 0)
  }
  // The same unit in another case, or any other field, is not a change.
  const same = itemStore({ holders: { balance: true } })
  await saveItemMaster(same.prisma, 'ITEM-1', { baseUnit: 'PCS', itemName: 'Cap, red', expectedVersion: 3 }, 'user', scope)
  assert.equal(same.writes.length, 1)
  // An item nothing holds yet can still take another unit.
  const free = itemStore()
  await saveItemMaster(free.prisma, 'ITEM-1', { baseUnit: 'box', expectedVersion: 3 }, 'user', scope)
  assert.equal(free.writes[0].unit, 'box')
})
