import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { allocationTruncatedSubjects } from './reorder-list-read-service.mjs'

// The inventory report's stock figures come from the allocation model, which
// reads its inputs over every record (allocationInputs, design audit C1). Its
// truncation notice takes the allocation's own cuts, as the reorder list does,
// not the 500-row lists of the read context. Figures over those lists (the
// overview's purchase orders, invoices and sales cards) still name them.

const now = new Date('2026-11-17T12:00:00Z')
const cappedLists = [
  { subject: 'purchase_orders', limit: 500 },
  { subject: 'inventory_items', limit: 500 },
  { subject: 'sales_orders', limit: 500 },
  { subject: 'supplier_invoices', limit: 500 },
  { subject: 'items', limit: 200 },
]
// The context as the route serves it to a reader: capped lists, no allocationInputs.
const scoped = (overrides = {}) => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [{ sku: 'SKU-1', itemId: 'ITEM-1', unit: 'EA', onHandQuantity: 5, availableQuantity: 5, reservedQuantity: 0 }],
  purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [], itemSupplierRelationships: [],
  dataLimitations: [], truncatedSubjects: cappedLists, ...overrides,
})
// The unscoped context the allocation reads, with its inputs over every record.
// SKU-2 is past the capped lists: only the allocation's item units name its unit.
const withInputs = (truncatedSubjects = []) => ({
  ...scoped(),
  allocationInputs: {
    inventoryItems: [
      { sku: 'SKU-1', itemId: 'ITEM-1', onHandQuantity: 5, availableQuantity: 5, reservedQuantity: 0 },
      { sku: 'SKU-2', itemId: 'ITEM-2', onHandQuantity: 0, availableQuantity: 0, reservedQuantity: 0 },
    ],
    items: [],
    itemUnits: [{ sku: 'SKU-1', itemId: 'ITEM-1', unit: 'EA' }, { sku: 'SKU-2', itemId: 'ITEM-2', unit: 'KG' }],
    salesDemand: [],
    purchaseOrders: [],
    purchaseOrderKeys: [],
    truncatedSubjects,
  },
})
const report = (subject, allocationContext) => buildRuntimeGovernedReport(scoped(), { subject }, { now, allocationContext })
const subjects = result => result.truncatedSubjects.map(entry => `${entry.subject}:${entry.limit}`).sort()

test('the inventory report names no cut list when the allocation read every record', () => {
  const inventory = report('inventory', withInputs())
  assert.deepEqual(inventory.truncatedSubjects, [])
  // It says what the reorder list says.
  assert.deepEqual(allocationTruncatedSubjects(withInputs()), [])
  // Its rows are the allocation's, each in its recorded unit.
  assert.deepEqual(inventory.details.map(row => [row.id, row.unit]), [['SKU-1', 'EA'], ['SKU-2', 'KG']])
})

test('the inventory report names the cuts of the allocation read', () => {
  const cut = [{ subject: 'purchase_orders', limit: 10000 }, { subject: 'inventory_items', limit: 10000 }, { subject: 'sales_orders', limit: 10000 }]
  assert.deepEqual(subjects(report('inventory', withInputs(cut))), ['inventory_items:10000', 'purchase_orders:10000', 'sales_orders:10000'])
  assert.deepEqual(subjects(report('inventory', withInputs([cut[0]]))), ['purchase_orders:10000'])
})

test('the overview names cut lists only for the figures that read them', () => {
  // Purchase orders, invoices and the unfulfilled sales card read the capped
  // lists; its stock figures read the allocation, so items are not named.
  assert.deepEqual(subjects(report('overview', withInputs())), ['purchase_orders:500', 'sales_orders:500', 'supplier_invoices:500'])
  // A cut of the allocation read adds the stock subject it changes, once.
  const cut = [{ subject: 'inventory_items', limit: 10000 }, { subject: 'purchase_orders', limit: 10000 }]
  assert.deepEqual(subjects(report('overview', withInputs(cut))), ['inventory_items:10000', 'purchase_orders:500', 'sales_orders:500', 'supplier_invoices:500'])
})

test('without allocation inputs the report keeps naming the capped lists', () => {
  assert.deepEqual(subjects(report('inventory', scoped())), ['inventory_items:500', 'items:200', 'purchase_orders:500', 'sales_orders:500'])
  assert.deepEqual(subjects(report('inventory', undefined)), ['inventory_items:500', 'items:200', 'purchase_orders:500', 'sales_orders:500'])
})

test('the other dashboards keep their notices', () => {
  for (const [subject, named] of Object.entries({
    procurement: ['purchase_orders:500', 'supplier_invoices:500'],
    sales: ['sales_orders:500'],
    finance: ['supplier_invoices:500'],
    suppliers: ['purchase_orders:500', 'supplier_invoices:500'],
  })) assert.deepEqual(subjects(report(subject, withInputs([{ subject: 'purchase_orders', limit: 10000 }]))), named, subject)
})
