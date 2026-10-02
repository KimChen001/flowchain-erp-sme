import test from 'node:test'
import assert from 'node:assert/strict'
import { businessContextToReadDb } from '../services/runtime-business-read-service.mjs'
import { reportReadAccessFor, scopeBusinessContext } from './report-read-access.mjs'
import { buildAiReadContext } from './ai-read-context.mjs'
import { defaultRoleTemplates, permissionCodes } from '../auth/permission-catalog.mjs'

// The read db the legacy assistant handlers answer from is built from the
// business read context after it was scoped to the reader, so no handler can
// show a hidden amount, invoice partner or record.

const roleAccess = (roleKey, warehouseIds = null) => ({
  ...reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-ai', permissionCodes: new Set(roleKey === '*' ? permissionCodes : defaultRoleTemplates.find(role => role.roleKey === roleKey).permissions) }),
  warehouseIds,
})

const context = () => ({
  dataMode: 'user',
  items: [{ id: 'SKU-1', sku: 'SKU-1', name: 'Valve' }],
  suppliers: [{ id: 'SUP-1', name: 'Harbor Supply', bankAccountNumber: '000123456789', bankAccountName: 'Harbor Supply LLC', taxIdentificationNumber: '12-3456789' }],
  customers: [], warehouses: [], bins: [],
  inventoryItems: [{ sku: 'SKU-1', warehouseId: 'WH-EAST', onHandQuantity: 150 }],
  salesOrders: [{ id: 'SO-1', customerName: 'Redwood Retail', totalAmount: 720 }],
  purchaseRequests: [{ id: 'PR-1', totalAmount: 48125, lines: [{ sku: 'SKU-1', unitPrice: 4812.5 }] }],
  rfqs: [{ id: 'RFQ-1', bestPrice: 4700 }],
  purchaseOrders: [{ id: 'PO-1', supplierId: 'SUP-1', supplierSnapshot: { supplierName: 'Harbor Supply' }, totalAmount: 48125, lines: [{ sku: 'SKU-1', unitPrice: 4812.5, amount: 48125 }] }],
  receipts: [{ id: 'GRN-1', poId: 'PO-1' }],
  supplierInvoices: [{ id: 'INV-1', supplierId: 'SUP-1', supplierName: 'Harbor Supply', supplierSnapshot: { supplierName: 'Harbor Supply' }, poId: 'PO-1', totalAmount: 37950, varianceAmount: 1200 }],
  itemSupplierRelationships: [{ itemId: 'SKU-1', supplierId: 'SUP-1', referencePrice: 4812.5 }],
  dataLimitations: [], truncatedSubjects: [],
})

const readDb = (access) => businessContextToReadDb(scopeBusinessContext(context(), access))

test('the read db keeps every amount and record for a reader with every permission', () => {
  const db = readDb(roleAccess('*'))
  assert.equal(db.purchaseOrders[0].amount, 48125)
  assert.equal(db.purchaseRequests[0].amount, 48125)
  assert.equal(db.supplierInvoices[0].totalAmount, 37950)
  assert.equal(db.supplierInvoices[0].supplierId, 'SUP-1')
  assert.equal(db.suppliers[0].bankAccountNumber, '000123456789')
  assert.equal(db.salesOrders[0].id, 'SO-1')
})

test('the read-only viewer read db has no purchase order or invoice amounts', () => {
  const db = readDb(roleAccess('read-only-viewer'))
  const text = JSON.stringify(db)
  for (const secret of ['48125', '4812.5', '4700', '37950', '1200', '000123456789', '12-3456789', 'Harbor Supply LLC']) assert.equal(text.includes(secret), false, secret)
  // The derived amount fields stay hidden too, never 0.
  assert.equal(db.purchaseOrders[0].amount, null)
  assert.equal(db.purchaseRequests[0].amount, null)
  // The invoice is still there, without its supplier.
  assert.deepEqual([db.supplierInvoices[0].invoiceNumber, db.supplierInvoices[0].supplierId, db.supplierInvoices[0].supplierName, db.supplierInvoices[0].totalAmount], ['INV-1', null, null, null])
})

test('the procurement specialist read db has no supplier invoices or sales orders', () => {
  const db = readDb(roleAccess('procurement-specialist'))
  assert.deepEqual(db.supplierInvoices, [])
  assert.deepEqual(db.salesOrders, [])
  assert.equal(JSON.stringify(db).includes('Redwood'), false)
  assert.equal(db.purchaseOrders[0].amount, 48125)
})

// The legacy route's evidence cache reads repositories that see every
// warehouse, collection and amount. For a restricted reader they are not read.
function trackedRepositories(reads) {
  const track = (name, value) => async () => { reads.push(name); return value }
  return {
    procurementRead: { listDocuments: track('procurement', [{ id: 'INV-1', amount: 37950 }]), listFollowups: track('procurement', []), getSummary: track('procurement', {}) },
    inventoryRead: { listItems: track('inventory', []), listExceptions: track('inventory', []), getSummary: track('inventory', {}) },
    masterData: { listItems: track('masterData', []), listSuppliers: track('masterData', [{ id: 'SUP-1', bankAccountNumber: '000123456789' }]) },
  }
}

test('the AI read context reads past the scope only for a reader who may see everything', async () => {
  for (const [access, expected] of [[null, true], [roleAccess('*'), true], [roleAccess('*', ['WH-EAST']), false], [roleAccess('read-only-viewer'), false], [roleAccess('procurement-specialist'), false]]) {
    const reads = []
    const db = readDb(access || roleAccess('*'))
    const result = await buildAiReadContext(db, { repositories: trackedRepositories(reads), identity: { tenantId: 'tenant-ai' }, dataMode: 'user', businessReadDb: db, readAccess: access })
    assert.equal(reads.length > 0, expected, JSON.stringify(access?.collections))
    if (!expected) {
      assert.deepEqual(result.cache, {})
      if (!access.partner) assert.equal(JSON.stringify(result).includes('000123456789'), false)
    }
  }
})
