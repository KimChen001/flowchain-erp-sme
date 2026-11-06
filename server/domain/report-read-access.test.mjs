import test from 'node:test'
import assert from 'node:assert/strict'
import { permissionCodes, defaultRoleTemplates } from '../auth/permission-catalog.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { handleReportsAnalyticsRoute } from '../routes/reports-analytics.routes.mjs'
import { handleBusinessReadContextRoute } from '../routes/business-read-context.routes.mjs'

// Reports, the home overview and the business read context show each reader
// only the records and amounts their role may read. Hidden figures are
// restricted (null), never 0, and the charts count documents instead.

const roleAccess = (roleKey) => reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-r', permissionCodes: new Set(roleKey === '*' ? permissionCodes : defaultRoleTemplates.find(role => role.roleKey === roleKey).permissions) })
const db = {
  __dataMode: 'user',
  suppliers: [{ id: 'SUP-1', name: 'Harbor Supply', bankAccountNumber: '000123456789', taxIdentificationNumber: '12-3456789' }],
  products: [{ sku: 'SKU-1', name: 'Valve' }],
  inventoryItems: [{ sku: 'SKU-1', onHandQuantity: 10, unit: 'EA' }],
  purchaseOrders: [{ id: 'PO-1', status: 'approved', supplierId: 'SUP-1', supplierName: 'Harbor Supply', currency: 'USD', totalAmount: 12500, orderDate: '2026-09-02', lines: [{ sku: 'SKU-1', orderedQty: 10, quantity: 10, unitPrice: 1250, amount: 12500 }] }],
  receivingDocs: [],
  supplierInvoices: [{ id: 'INV-1', invoiceNumber: 'INV-1', status: 'submitted', supplierName: 'Harbor Supply', currency: 'USD', totalAmount: 9800, invoiceDate: '2026-09-05' }],
  salesOrders: [{ id: 'SO-1', salesOrderId: 'SO-1', customerName: 'Redwood Retail', sku: 'SKU-1', orderedQty: 4, fulfilledQty: 0, status: 'confirmed', totalAmount: 720, currency: 'USD', orderDate: '2026-09-03' }],
}

async function report(subject, access) {
  let response
  await handleReportsAnalyticsRoute({ req: { method: 'GET', headers: {} }, res: {}, url: new URL(`http://local/api/reports/${subject}?currency=USD`), db, reportReadAccess: access, send: (_res, status, payload) => { response = { status, payload: JSON.parse(JSON.stringify(payload)) } } })
  return response
}
const kpi = (payload, id) => payload.kpis.find(item => item.id === id)

test('a reader with every permission sees the amounts', async () => {
  const procurement = await report('procurement', roleAccess('*'))
  assert.equal(kpi(procurement.payload, 'purchase_order_amount').currentValue, 12500)
  const finance = await report('finance', roleAccess('*'))
  assert.equal(kpi(finance.payload, 'invoice_amount').currentValue, 9800)
})

test('the read-only viewer sees counts but no purchase order or invoice amount anywhere', async () => {
  const viewer = roleAccess('read-only-viewer')
  for (const subject of ['overview', 'procurement', 'suppliers']) {
    const { status, payload } = await report(subject, viewer)
    assert.equal(status, 200)
    const amount = kpi(payload, 'purchase_order_amount')
    assert.equal(amount.currentValue, null, subject)
    assert.equal(amount.dataStatus, 'restricted', subject)
    assert.ok(amount.currencyAmounts.every(group => group.amount === null), subject)
    assert.equal(payload.dataScope.currencyAmounts.every(group => group.amount === null), true, subject)
    assert.equal(JSON.stringify(payload).includes('12500'), false, `${subject} leaks the PO amount`)
    assert.ok(payload.restrictedAmounts.includes('purchase_orders'), subject)
  }
  const procurement = await report('procurement', viewer)
  assert.equal(kpi(procurement.payload, 'open_po_count').currentValue, 1)
  const trend = procurement.payload.charts.find(chart => chart.id === 'procurement_spend_trend')
  assert.ok(trend.limitations.includes('amount_restricted'))
  assert.equal(trend.unit, 'number')
  const bridge = procurement.payload.charts.find(chart => chart.id === 'procurement_value_bridge')
  assert.equal(bridge.emptyState, 'Your role cannot view amounts.')
  const finance = await report('finance', viewer)
  assert.equal(kpi(finance.payload, 'invoice_amount').dataStatus, 'restricted')
  assert.equal(JSON.stringify(finance.payload).includes('9800'), false)
  // The supplier on an invoice needs finance.partner_snapshot.read.
  assert.ok(finance.payload.details.length > 0)
  assert.ok(finance.payload.details.every(row => row.supplier !== 'Harbor Supply'))
})

test('the operations specialist sees invoices without amounts; the procurement specialist sees no invoices or sales orders', async () => {
  const specialist = await report('finance', roleAccess('operations-specialist'))
  assert.equal(kpi(specialist.payload, 'invoice_amount').dataStatus, 'restricted')
  assert.equal(kpi(specialist.payload, 'invoices_awaiting_match').currentValue, 1)

  const buyer = roleAccess('procurement-specialist')
  const finance = await report('finance', buyer)
  assert.equal(finance.status, 200)
  for (const id of ['invoice_amount', 'invoice_match_rate', 'invoices_awaiting_match', 'invoices_with_exception']) assert.equal(kpi(finance.payload, id).dataStatus, 'restricted', id)
  assert.deepEqual(finance.payload.details, [])
  assert.ok(finance.payload.restrictedSubjects.includes('supplier_invoices'))
  assert.equal(JSON.stringify(finance.payload).includes('INV-1'), false)
  const sales = await report('sales', buyer)
  assert.equal(kpi(sales.payload, 'sales_order_count').dataStatus, 'restricted')
  assert.equal(JSON.stringify(sales.payload).includes('Redwood Retail'), false)
  // The buyer may read prices, so the purchase order amount is shown.
  const procurement = await report('procurement', buyer)
  assert.equal(kpi(procurement.payload, 'purchase_order_amount').currentValue, 12500)
  // Inventory still counts every order's demand, without showing the orders.
  const inventory = await report('inventory', buyer)
  assert.equal(inventory.payload.details.find(row => row.id === 'SKU-1').reserved !== undefined, true)
})

test('the open purchase orders report needs purchase order read and hides amounts without prices', async () => {
  const call = async (access) => {
    let response
    await handleReportsAnalyticsRoute({ req: { method: 'GET' }, res: {}, url: new URL('http://local/api/reports/open-purchase-orders'), identity: { tenantId: 'tenant-r' }, reportReadAccess: access, repositories: { procurementRuntime: { listForReport: async () => db.purchaseOrders } }, send: (_res, status, payload) => { response = { status, payload } } })
    return response
  }
  const finance = await call(roleAccess('finance-specialist'))
  assert.equal(finance.status, 403)
  const viewer = await call(roleAccess('read-only-viewer'))
  assert.equal(viewer.status, 200)
  assert.ok(viewer.payload.summary.totals.every(total => total.amount === null))
  assert.ok(viewer.payload.rows.every(row => row.amount === null))
  const buyer = await call(roleAccess('procurement-specialist'))
  assert.equal(buyer.payload.summary.totals[0].amount, 12500)
})

test('the business read context and home overview are scoped to the reader', async () => {
  const snapshot = { purchaseRequests: [{ id: 'PR-1', status: 'submitted', totalAmount: 300, lines: [{ unitPrice: 30 }] }], rfqs: [], purchaseOrders: db.purchaseOrders, receipts: [], supplierInvoices: db.supplierInvoices }
  const repositories = {
    masterData: { listItems: async () => db.products, listSuppliers: async () => db.suppliers, listCustomers: async () => [], listAllItemSupplierRelationships: async () => [{ itemId: 'SKU-1', supplierId: 'SUP-1', referencePrice: 1250 }] },
    inventoryRuntime: { listItems: async () => db.inventoryItems },
    salesOrders: { listOrders: async () => db.salesOrders },
    procurementRuntime: { snapshot: async () => snapshot },
  }
  const call = async (pathname, access) => {
    let response
    await handleBusinessReadContextRoute({ req: { method: 'GET' }, res: {}, url: new URL(`http://local${pathname}`), repositories, dataMode: 'user', identity: { authenticated: true, tenantId: 'tenant-r' }, reportReadAccess: access, tenantTimezone: 'America/New_York', send: (_res, status, payload) => { response = { status, payload: JSON.parse(JSON.stringify(payload)) } } })
    return response
  }
  const viewer = await call('/api/business/read-context', roleAccess('read-only-viewer'))
  const text = JSON.stringify(viewer.payload)
  for (const secret of ['12500', '9800', '1250', '000123456789', '12-3456789']) assert.equal(text.includes(secret), false, secret)
  assert.equal(viewer.payload.purchaseOrders[0].totalAmount, null)
  assert.equal(viewer.payload.purchaseRequests[0].lines[0].unitPrice, null)
  const buyer = await call('/api/business/read-context', roleAccess('procurement-specialist'))
  assert.deepEqual([buyer.payload.supplierInvoices, buyer.payload.salesOrders], [[], []])
  assert.ok(buyer.payload.restrictedSubjects.includes('sales_orders'))
  const home = await call('/api/home/overview', roleAccess('read-only-viewer'))
  assert.equal(home.status, 200)
  assert.equal(JSON.stringify(home.payload).includes('12500'), false)
})
