import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'

// The inventory report's "mixed units" note (inventory_units_mixed) checks
// the units of every item the allocation read (allocationInputs, design audit
// C1), as its stock rows, units column and truncation notice do since #362,
// not only the 500 rows of the read context's capped inventory list.

const now = new Date('2026-11-17T12:00:00Z')
const sku = n => `SKU-${String(n).padStart(4, '0')}`
const stockRow = n => ({ sku: sku(n), itemId: `ITEM-${n}`, onHandQuantity: 1, availableQuantity: 1, reservedQuantity: 0 })
const range = count => Array.from({ length: count }, (_, index) => index + 1)

// The context as the route serves it: the first 500 inventory rows, all in EA.
const scoped = () => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: range(500).map(n => ({ ...stockRow(n), unit: 'EA' })),
  purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [], itemSupplierRelationships: [],
  dataLimitations: [], truncatedSubjects: [{ subject: 'inventory_items', limit: 500 }],
})
// The allocation's read over every record: 501 items, item 501 kept in unit501.
const withInputs = (unit501, itemUnits = range(501).map(n => ({ sku: sku(n), itemId: `ITEM-${n}`, unit: n === 501 ? unit501 : 'EA' }))) => ({
  ...scoped(),
  allocationInputs: {
    inventoryItems: range(501).map(stockRow),
    items: [],
    itemUnits,
    salesDemand: [],
    purchaseOrders: [],
    purchaseOrderKeys: [],
    truncatedSubjects: [],
  },
})
const inventoryReport = allocationContext => buildRuntimeGovernedReport(scoped(), { subject: 'inventory' }, { now, allocationContext })
const onHand = report => report.kpis.find(item => item.id === 'inventory_on_hand')

test('item 501 in another unit sets the mixed-units note', () => {
  const report = inventoryReport(withInputs('KG'))
  assert.ok(report.limitations.includes('inventory_units_mixed'), JSON.stringify(report.limitations))
  assert.ok(onHand(report).limitations.includes('inventory_units_mixed'), JSON.stringify(onHand(report).limitations))
})

test('501 items in one unit set no mixed-units note', () => {
  const report = inventoryReport(withInputs('EA'))
  assert.equal(report.limitations.includes('inventory_units_mixed'), false)
  assert.equal(onHand(report).limitations.includes('inventory_units_mixed'), false)
})

test('an item whose unit is not recorded adds no unit', () => {
  const report = inventoryReport(withInputs(''))
  assert.equal(report.limitations.includes('inventory_units_mixed'), false)
  // Keyed by item id when the SKU is not listed.
  const byItemId = withInputs('KG', range(501).map(n => ({ sku: '', itemId: `ITEM-${n}`, unit: n === 501 ? 'KG' : 'EA' })))
  assert.ok(inventoryReport(byItemId).limitations.includes('inventory_units_mixed'))
})

test('without allocation inputs the capped list is checked as before', () => {
  assert.equal(inventoryReport(undefined).limitations.includes('inventory_units_mixed'), false)
  const mixed = scoped()
  mixed.inventoryItems[499] = { ...mixed.inventoryItems[499], unit: 'KG' }
  assert.ok(buildRuntimeGovernedReport(mixed, { subject: 'inventory' }, { now }).limitations.includes('inventory_units_mixed'))
})
