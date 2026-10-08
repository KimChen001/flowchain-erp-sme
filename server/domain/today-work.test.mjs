import test from 'node:test'
import assert from 'node:assert/strict'
import { billNextStep, buildFirstRunChecklist, buildTodayWork, compareTodayWork, countDocumentsUpdatedToday } from './today-work.mjs'
import { buildReorderList } from './reorder-list.mjs'
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { buildHomeOverview } from '../services/business-read-context-service.mjs'
import { handleBusinessReadContextRoute } from '../routes/business-read-context.routes.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { defaultRoleTemplates, permissionCodes } from '../auth/permission-catalog.mjs'

// The new customer's first day (walkthrough of 2026-10-07, New York): a PO due
// today with 20 of 50 still to come, three items at or below their reorder
// point, a matched and paid bill, a bill waiting for its match, an invoice
// with money owed but not yet due, and the overdue and pending finance work a
// later day brings.
const NY = 'America/New_York'
const MORNING = new Date('2026-10-07T16:00:00Z') // 12:00 in New York
const EVENING = new Date('2026-10-08T00:00:00Z') // 20:00 in New York, already Oct 8 in UTC
const AFTER_MIDNIGHT = new Date('2026-10-08T04:30:00Z') // 00:30 in New York on Oct 8

const items = [
  { id: 'ITEM-V', itemId: 'ITEM-V', sku: 'VALVE-150', name: 'Ball valve 1.5 in', unit: 'EA', safetyStock: 10, reorderPoint: 20, status: 'active' },
  { id: 'ITEM-F', itemId: 'ITEM-F', sku: 'FIT-300', name: 'Pipe fitting', unit: 'EA', reorderPoint: 50, status: 'active' },
  { id: 'ITEM-S', itemId: 'ITEM-S', sku: 'SEAL-400', name: 'Seal kit', unit: 'EA', reorderPoint: 100, status: 'active' },
  { id: 'ITEM-G', itemId: 'ITEM-G', sku: 'GASKET-500', name: 'Gasket', unit: 'EA', reorderPoint: 10, status: 'active' },
]
const balances = [
  { sku: 'VALVE-150', itemId: 'ITEM-V', onHandQuantity: 0, reservedQuantity: 0, warehouseId: 'WH-1' },
  { sku: 'FIT-300', itemId: 'ITEM-F', onHandQuantity: 40, reservedQuantity: 0, warehouseId: 'WH-1' },
  { sku: 'SEAL-400', itemId: 'ITEM-S', onHandQuantity: 100, reservedQuantity: 0, warehouseId: 'WH-1' },
  { sku: 'GASKET-500', itemId: 'ITEM-G', onHandQuantity: 500, reservedQuantity: 0, warehouseId: 'WH-1' },
]
const po = (overrides = {}, line = {}) => ({
  id: 'PO-ID-1', orderNumber: 'PO-42AA497A', status: 'partially_received', supplierId: 'SUP-1', supplierSnapshot: { id: 'SUP-1', supplierName: 'Valve Supply Co' },
  currency: 'USD', totalAmount: '500.0000', createdAt: '2026-10-07T13:00:00.000Z', updatedAt: '2026-10-07T18:00:00.000Z',
  lines: [{ id: 'POL-1', sku: 'VALVE-150', itemId: 'ITEM-V', orderedQuantity: '50.0000', receivedQuantity: '30.0000', unit: 'EA', promisedDate: '2026-10-07T00:00:00.000Z', ...line }],
  ...overrides,
})
const supplierInvoices = [
  { id: 'BILL-PAID', invoiceNumber: 'INV-7781', supplierName: 'Valve Supply Co', status: 'approved', matchStatus: 'matched', poId: 'PO-ID-1', receiptId: 'GRN-1', totalAmount: '300.0000', currency: 'USD', invoiceDate: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T19:00:00.000Z' },
  { id: 'BILL-MATCH', invoiceNumber: 'INV-7790', supplierName: 'Fitting Works', status: 'submitted', poId: 'PO-OTHER', receiptId: 'GRN-2', totalAmount: '80.0000', currency: 'USD', invoiceDate: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-07T15:00:00.000Z' },
]
const salesOrders = [
  { id: 'SO-ID-1', orderNumber: 'SO-1001', customerName: 'Redwood Retail', workflowStatus: 'confirmed', fulfillmentStatus: 'not_fulfilled', promisedDate: '2026-10-09', currency: 'USD', totalAmount: 240, updatedAt: '2026-10-07T17:00:00.000Z',
    lines: [{ sku: 'GASKET-500', itemId: 'ITEM-G', orderedQuantity: 10, reservedQuantity: 0, fulfilledQuantity: 0, unit: 'EA' }] },
]
const customerInvoices = [
  { id: 'CI-ID-1', invoiceNumber: 'CI-2001', customerName: 'Redwood Retail', status: 'approved', invoiceDate: '2026-10-07T00:00:00.000Z', totalAmount: '240', currency: 'USD', updatedAt: '2026-10-07T20:00:00.000Z' },
]
const receivables = [
  { id: 'AR-1', obligationNumber: 'AR-0001', customerInvoiceId: 'CI-ID-0', customerInvoiceNumber: 'CI-1999', customerName: 'Redwood Retail', status: 'open', dueDate: '2026-10-05T00:00:00.000Z', outstandingAmount: '120', currency: 'USD' },
  // $120 still owed, due next month: not overdue, so not work today.
  { id: 'AR-2', obligationNumber: 'AR-0002', customerInvoiceId: 'CI-ID-2', customerInvoiceNumber: 'CI-2000', customerName: 'Redwood Retail', status: 'open', dueDate: '2026-11-06T00:00:00.000Z', outstandingAmount: '120', currency: 'USD' },
]

function reorderFor(purchaseOrders, today = '2026-10-07') {
  const allocation = buildRuntimeInventoryAllocation({ items, inventoryItems: balances, salesOrders: [], purchaseOrders })
  return { allocation, reorder: buildReorderList({ allocationRows: allocation.availability, items, today, timeZone: NY }) }
}

function firstDay(now = MORNING, overrides = {}) {
  const purchaseOrders = overrides.purchaseOrders || [po()]
  const { allocation, reorder } = reorderFor(purchaseOrders)
  return buildTodayWork({ purchaseOrders, purchaseRequests: [], supplierInvoices, salesOrders, allocationRows: allocation.availability, reorder, customerInvoices, receivables, ...overrides }, { now, timeZone: NY })
}

test('a purchase order due today with 20 of 50 still to come is due today, not overdue', () => {
  const work = firstDay()
  assert.equal(work.today, '2026-10-07')
  const order = work.items.find((item) => item.recordId === 'PO-ID-1')
  assert.equal(order.kind, 'purchase_order_due')
  assert.equal(order.label, 'PO-42AA497A')
  assert.equal(order.href, '/app/procurement/orders/PO-ID-1')
  assert.equal(order.date, '2026-10-07')
  assert.equal(order.overdueDays, 0)
  assert.deepEqual({ remaining: order.detail.remaining, unit: order.detail.unit, received: order.detail.received, ordered: order.detail.ordered, dueInDays: order.detail.dueInDays }, { remaining: 20, unit: 'EA', received: 30, ordered: 50, dueInDays: 0 })
  assert.equal(order.name, 'Valve Supply Co')
})

test('at 20:00 in New York a purchase order due today is still due today, wherever its date was stored', () => {
  for (const promisedDate of ['2026-10-07T00:00:00.000Z', '2026-10-07T12:00:00.000Z', '2026-10-07']) {
    const work = firstDay(EVENING, { purchaseOrders: [po({}, { promisedDate })] })
    assert.equal(work.today, '2026-10-07', promisedDate)
    const order = work.items.find((item) => item.recordId === 'PO-ID-1')
    assert.equal(order.kind, 'purchase_order_due', promisedDate)
    assert.equal(order.overdueDays, 0, promisedDate)
    assert.equal(work.overdue, 1, 'only the receivable from Oct 5 is overdue')
  }
  // After midnight in New York the same order is one day late.
  const late = firstDay(AFTER_MIDNIGHT).items.find((item) => item.recordId === 'PO-ID-1')
  assert.equal(late.kind, 'purchase_order_overdue')
  assert.equal(late.overdueDays, 1)
})

test('only open orders due within 7 days or overdue are listed, by the open purchase orders rule', () => {
  const purchaseOrders = [
    po(),
    po({ id: 'PO-ID-2', orderNumber: 'PO-LATER' }, { promisedDate: '2026-10-15T00:00:00.000Z' }), // 8 days out
    po({ id: 'PO-ID-3', orderNumber: 'PO-WEEK' }, { promisedDate: '2026-10-14T00:00:00.000Z' }), // 7 days out
    po({ id: 'PO-ID-4', orderNumber: 'PO-DONE', status: 'fully_received' }, { receivedQuantity: '50.0000', promisedDate: '2026-10-01T00:00:00.000Z' }),
    po({ id: 'PO-ID-5', orderNumber: 'PO-DRAFT', status: 'draft' }, { receivedQuantity: '0', promisedDate: '2026-10-01T00:00:00.000Z' }),
    po({ id: 'PO-ID-6', orderNumber: 'PO-NOT-SENT', status: 'approved' }, { receivedQuantity: '0', promisedDate: '2026-10-03T00:00:00.000Z' }),
  ]
  const work = firstDay(MORNING, { purchaseOrders })
  const byLabel = new Map(work.items.filter((item) => item.entityType === 'purchase_order').map((item) => [item.label, item]))
  assert.equal(byLabel.get('PO-42AA497A').kind, 'purchase_order_due')
  assert.equal(byLabel.get('PO-WEEK').kind, 'purchase_order_due')
  assert.equal(byLabel.has('PO-LATER'), false)
  assert.equal(byLabel.has('PO-DONE'), false)
  // A draft is work to review, not an order the supplier owes.
  assert.equal(byLabel.get('PO-DRAFT').kind, 'draft_purchase_order')
  // Approved and not yet issued: open, overdue, and marked not issued.
  assert.equal(byLabel.get('PO-NOT-SENT').kind, 'purchase_order_overdue')
  assert.equal(byLabel.get('PO-NOT-SENT').overdueDays, 4)
  assert.equal(byLabel.get('PO-NOT-SENT').detail.notIssued, true)
})

test('items at or below their reorder point are listed from the reorder list, labelled by the assistant signal', () => {
  const work = firstDay()
  const reorder = work.items.filter((item) => item.kind === 'reorder_now')
  assert.deepEqual(reorder.map((item) => item.label), ['FIT-300', 'SEAL-400', 'VALVE-150'])
  assert.ok(reorder.every((item) => item.date === '2026-10-07' && item.actionHref === '/app/inventory/reorder'))
  const valve = reorder.find((item) => item.label === 'VALVE-150')
  assert.equal(valve.href, '/app/master-data/items/ITEM-V')
  assert.deepEqual({ position: valve.detail.position, reorderPoint: valve.detail.reorderPoint, unit: valve.detail.unit }, { position: 20, reorderPoint: 20, unit: 'EA' })
  assert.equal(valve.detail.stockSignal, 'stock_below_safety')
  assert.equal(reorder.find((item) => item.label === 'FIT-300').detail.stockSignal, 'stock_below_reorder')
  // GASKET-500 is well above its reorder point.
  assert.equal(work.items.some((item) => item.label === 'GASKET-500'), false)
})

test('an overdue receivable is listed with what is owed; one due next month is not', () => {
  const work = firstDay()
  const overdue = work.items.filter((item) => item.kind === 'receivable_overdue')
  assert.equal(overdue.length, 1)
  assert.equal(overdue[0].label, 'CI-1999')
  assert.equal(overdue[0].href, '/app/sales/invoices/CI-ID-0')
  assert.equal(overdue[0].overdueDays, 2)
  assert.equal(overdue[0].detail.outstanding, 120)
  // Due today is not overdue, even in the New York evening.
  const dueToday = [{ ...receivables[0], id: 'AR-3', customerInvoiceNumber: 'CI-TODAY', dueDate: '2026-10-07T00:00:00.000Z' }]
  assert.equal(firstDay(EVENING, { receivables: dueToday }).items.some((item) => item.kind === 'receivable_overdue'), false)
  // Without the amount permission the amount is hidden, and the row stays.
  const hidden = firstDay(MORNING, { receivables: [{ ...receivables[0], outstandingAmount: null, amountHidden: true }] }).items.find((item) => item.kind === 'receivable_overdue')
  assert.equal(hidden.detail.outstanding, null)
})

test('bills, invoices and sales orders follow their pages\' next step', () => {
  assert.equal(billNextStep({ status: 'submitted', poId: 'PO-1', receiptId: null }), 'bill_awaiting_receipt')
  assert.equal(billNextStep({ status: 'submitted', poId: 'PO-1', receiptId: 'GRN-1' }), 'bill_to_match')
  assert.equal(billNextStep({ status: 'matched' }), 'bill_to_approve')
  assert.equal(billNextStep({ status: 'exception' }), 'bill_exception')
  assert.equal(billNextStep({ status: 'approved' }), null)
  assert.equal(billNextStep({ status: 'draft' }), null)
  const work = firstDay()
  assert.equal(work.items.some((item) => item.recordId === 'BILL-PAID'), false, 'a matched and paid bill is done')
  assert.equal(work.items.find((item) => item.recordId === 'BILL-MATCH').kind, 'bill_to_match')
  assert.equal(work.items.find((item) => item.recordId === 'CI-ID-1').kind, 'customer_invoice_to_issue')
  const order = work.items.find((item) => item.recordId === 'SO-ID-1')
  assert.equal(order.kind, 'sales_order_to_reserve')
  assert.deepEqual(order.detail, { quantity: 10, unit: 'EA', lines: 1 })
  const reserved = [{ ...salesOrders[0], lines: [{ ...salesOrders[0].lines[0], reservedQuantity: 10 }] }]
  assert.equal(firstDay(MORNING, { salesOrders: reserved }).items.find((item) => item.recordId === 'SO-ID-1').kind, 'sales_order_to_ship')
  const shipped = [{ ...salesOrders[0], fulfillmentStatus: 'fulfilled' }]
  assert.equal(firstDay(MORNING, { salesOrders: shipped }).items.some((item) => item.recordId === 'SO-ID-1'), false)
  const draft = [{ ...salesOrders[0], workflowStatus: 'draft' }]
  assert.equal(firstDay(MORNING, { salesOrders: draft }).items.some((item) => item.recordId === 'SO-ID-1'), false)
})

test('the list is ordered by date, earliest first, with no score', () => {
  const work = firstDay()
  assert.deepEqual(work.items.map((item) => [item.date, item.kind, item.label]), [
    ['2026-10-05', 'receivable_overdue', 'CI-1999'],
    ['2026-10-06', 'bill_to_match', 'INV-7790'],
    ['2026-10-07', 'purchase_order_due', 'PO-42AA497A'],
    ['2026-10-07', 'reorder_now', 'FIT-300'],
    ['2026-10-07', 'reorder_now', 'SEAL-400'],
    ['2026-10-07', 'reorder_now', 'VALVE-150'],
    ['2026-10-07', 'customer_invoice_to_issue', 'CI-2001'],
    ['2026-10-09', 'sales_order_to_reserve', 'SO-1001'],
  ])
  assert.equal(work.total, 8)
  assert.equal(work.overdue, 1)
  // Rows without a date come last.
  const undated = { date: null, kind: 'purchase_request_to_approve', label: 'PR-1', recordId: 'PR-1' }
  const dated = { date: '2026-12-31', kind: 'draft_purchase_order', label: 'PO-9', recordId: 'PO-9' }
  assert.deepEqual([undated, dated].sort(compareTodayWork), [dated, undated])
})

test('an empty workspace has no work and shows every first-day step open', () => {
  const overview = buildHomeOverview({ purchaseRequests: [], rfqs: [], purchaseOrders: [], dataLimitations: [] }, {
    now: MORNING,
    timeZone: NY,
    setup: { items: 0, suppliers: 0, customers: 0, stockedItems: 0, activeUsers: 1, pendingInvitations: 0 },
    setupOptions: { importEnabled: true, permissions: { items: true, suppliers: true, customers: true, openingStock: true, teammates: true } },
  })
  assert.deepEqual(overview.workItems, [])
  assert.equal(overview.workTotal, 0)
  assert.equal(overview.todayChanges, 0)
  assert.deepEqual(overview.recentDocuments, [])
  assert.deepEqual(overview.firstRun.steps.map((step) => [step.id, step.done, step.href, step.blocked]), [
    ['items', false, '/app/master-data/import?type=items', null],
    ['suppliers', false, '/app/master-data/import?type=suppliers', null],
    ['customers', false, '/app/master-data/import?type=customers', null],
    ['opening_stock', false, '/app/master-data/import?type=opening-stock', null],
    ['teammates', false, '/app/settings/roles', null],
  ])
  assert.equal(overview.firstRun.done, 0)
})

test('the checklist marks steps done from real counts and goes away when all are done', () => {
  const permissions = { items: true, suppliers: false, customers: true, openingStock: true, teammates: false }
  const half = buildFirstRunChecklist({ items: 12, suppliers: 3, customers: 0, stockedItems: 0, activeUsers: 1, pendingInvitations: 1 }, { permissions, importEnabled: false })
  assert.deepEqual(half.steps.map((step) => [step.id, step.done, step.count]), [['items', true, 12], ['suppliers', true, 3], ['customers', false, 0], ['opening_stock', false, 0], ['teammates', true, 1]])
  // Without import turned on, a step opens the record's own page; a step the
  // reader may not do has no link; opening stock without import or
  // adjustments has nowhere to go.
  assert.equal(half.steps.find((step) => step.id === 'customers').href, '/app/master-data/customers')
  assert.deepEqual(half.steps.find((step) => step.id === 'opening_stock'), { id: 'opening_stock', count: 0, done: false, href: null, blocked: 'unavailable' })
  assert.deepEqual([half.steps.find((step) => step.id === 'suppliers').href, half.steps.find((step) => step.id === 'suppliers').blocked], [null, 'permission'])
  const adjustments = buildFirstRunChecklist({ items: 1, suppliers: 1, customers: 1, stockedItems: 0, activeUsers: 2 }, { permissions, adjustmentsEnabled: true })
  assert.equal(adjustments.steps.find((step) => step.id === 'opening_stock').href, '/app/inventory/adjustments/new')
  assert.equal(buildFirstRunChecklist({ items: 1, suppliers: 1, customers: 1, stockedItems: 1, activeUsers: 2, pendingInvitations: 0 }), null)
  assert.equal(buildFirstRunChecklist(null), null)
})

test('documents updated today count each document the reader can open once, on the workspace day', () => {
  const documents = [
    { type: 'purchase_order', id: 'A', updatedAt: '2026-10-07T13:00:00.000Z' },
    { type: 'purchase_order', id: 'A', updatedAt: '2026-10-07T14:00:00.000Z' },
    { type: 'sales_order', id: 'A', updatedAt: '2026-10-07T23:30:00.000Z' }, // 19:30 in New York
    { type: 'supplier_invoice', id: 'B', updatedAt: '2026-10-08T03:00:00.000Z' }, // 23:00 Oct 7 in New York
    { type: 'customer_invoice', id: 'C', updatedAt: '2026-10-07T02:00:00.000Z' }, // 22:00 Oct 6 in New York
  ]
  assert.equal(countDocumentsUpdatedToday(documents, { now: EVENING, timeZone: NY }), 3)
  assert.equal(countDocumentsUpdatedToday(documents, { now: EVENING, timeZone: 'UTC' }), 1)
})

test('recent documents include sales orders, bills and invoices, newest change first, with the instant of the change', () => {
  const overview = buildHomeOverview({
    purchaseRequests: [{ id: 'PR-1', status: 'submitted', totalAmount: 5000, defaultCurrency: 'USD', updatedAt: '2026-10-07', updatedAtInstant: '2026-10-07T04:59:00.000Z', lines: [] }],
    rfqs: [],
    purchaseOrders: [po()],
    receipts: [{ id: 'GRN-1', documentNumber: 'GRN-0001', postingStatus: 'posted', supplierName: 'Valve Supply Co', updatedAt: '2026-10-07T18:30:00.000Z' }],
    supplierInvoices,
    salesOrders,
    dataLimitations: [],
  }, { now: EVENING, timeZone: NY, sources: { recentCustomerInvoices: customerInvoices } })
  assert.deepEqual(overview.recentDocuments.map((row) => [row.type, row.number, row.updatedAt]), [
    ['customer_invoice', 'CI-2001', '2026-10-07T20:00:00.000Z'],
    ['supplier_invoice', 'INV-7781', '2026-10-07T19:00:00.000Z'],
    ['receipt', 'GRN-0001', '2026-10-07T18:30:00.000Z'],
    ['purchase_order', 'PO-42AA497A', '2026-10-07T18:00:00.000Z'],
    ['sales_order', 'SO-1001', '2026-10-07T17:00:00.000Z'],
    ['supplier_invoice', 'INV-7790', '2026-10-07T15:00:00.000Z'],
    ['purchase_request', 'PR-1', '2026-10-07T04:59:00.000Z'],
  ])
  assert.equal(overview.recentDocuments.find((row) => row.type === 'sales_order').canonicalRoute, '/app/sales/orders/SO-ID-1')
  assert.equal(overview.recentDocuments.find((row) => row.type === 'customer_invoice').canonicalRoute, '/app/sales/invoices/CI-ID-1')
  // Every one of them was last changed on Oct 7 in New York except the
  // purchase request, changed at 00:59 on Oct 7 in New York: all seven count.
  assert.equal(overview.todayChanges, 7)
})

// The route, with the reader's permissions, against repositories and a
// database stand-in holding the first day's records.
const roleAccess = (roleKey, extra = {}) => ({
  ...reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-t', permissionCodes: new Set(roleKey === '*' ? permissionCodes : defaultRoleTemplates.find((role) => role.roleKey === roleKey).permissions) }),
  ...extra,
})

function fakeDatabase({ warehouses = [{ id: 'WH-1' }] } = {}) {
  const financeInvoices = [...customerInvoices.map((row) => ({ ...row, customerNameSnapshot: row.customerName, invoiceDate: new Date(row.invoiceDate), createdAt: new Date(row.updatedAt), updatedAt: new Date(row.updatedAt) }))]
  const obligations = receivables.map((row) => ({ ...row, dueDate: new Date(row.dueDate), disputeStatus: 'none', customerInvoice: { id: row.customerInvoiceId, invoiceNumber: row.customerInvoiceNumber, customerNameSnapshot: row.customerName } }))
  return {
    warehouse: { findMany: async () => warehouses },
    item: { findMany: async () => items.map(({ itemId, ...row }) => row), count: async () => items.length },
    shipmentLine: { findMany: async () => [] },
    runtimeRecord: { findMany: async () => [], count: async () => 1 },
    supplier: { findMany: async () => [], count: async () => 2 },
    customerInvoice: { findMany: async ({ where }) => financeInvoices.filter((row) => !where.status || row.status === where.status) },
    receivableObligation: {
      findMany: async ({ where }) => obligations.filter((row) => row.dueDate < where.dueDate.lt && where.status.in.includes(row.status) && Number(row.outstandingAmount) > where.outstandingAmount.gt),
    },
    inventoryBalance: { count: async () => 3 },
    user: { count: async () => 1 },
    workspaceInvitation: { count: async () => 0 },
  }
}

function repositories() {
  const purchaseOrders = [po()]
  return {
    masterData: { listItems: async () => items, listSuppliers: async () => [], listCustomers: async () => [], listAllItemSupplierRelationships: async () => [] },
    inventoryRuntime: { listItems: async () => balances },
    salesOrders: { listOrders: async () => salesOrders },
    procurementRuntime: {
      snapshot: async () => ({ purchaseRequests: [], rfqs: [], purchaseOrders, receipts: [], supplierInvoices }),
      listForReport: async () => purchaseOrders,
    },
  }
}

async function homeFor(access, { now = MORNING, database = fakeDatabase() } = {}) {
  let response
  await handleBusinessReadContextRoute({
    req: { method: 'GET' }, res: {}, url: new URL('http://local/api/home/overview'), repositories: repositories(), dataMode: 'user',
    identity: { authenticated: true, tenantId: 'tenant-t' }, reportReadAccess: access, tenantTimezone: NY, homeOverviewNow: now, homeOverviewPrisma: database,
    env: {},
    send: (_res, status, payload) => { response = { status, payload: JSON.parse(JSON.stringify(payload)) } },
  })
  return response
}

test('the home overview lists the first day\'s work for a reader who may see everything', async () => {
  const { status, payload } = await homeFor(roleAccess('*'))
  assert.equal(status, 200)
  assert.equal(payload.today, '2026-10-07')
  assert.deepEqual(payload.workItems.map((item) => item.label), ['CI-1999', 'INV-7790', 'PO-42AA497A', 'FIT-300', 'SEAL-400', 'VALVE-150', 'CI-2001', 'SO-1001'])
  assert.equal(payload.overdue, 1)
  assert.deepEqual(payload.hidden, [])
  // One user, no invitation yet: the checklist stays with that step open.
  assert.deepEqual(payload.firstRun.steps.filter((step) => !step.done).map((step) => step.id), ['teammates'])
  assert.equal(payload.firstRun.steps.find((step) => step.id === 'teammates').href, '/app/settings/roles')
})

test('a role without purchasing sees no purchase order items; one without finance sees no bills or invoices', async () => {
  const finance = (await homeFor(roleAccess('finance-specialist'))).payload
  assert.equal(finance.workItems.some((item) => item.entityType === 'purchase_order' || item.entityType === 'purchase_request'), false)
  assert.equal(finance.workItems.some((item) => item.kind === 'reorder_now'), false)
  assert.equal(finance.workItems.some((item) => item.kind === 'sales_order_to_reserve'), false)
  assert.deepEqual(finance.workItems.map((item) => item.kind).sort(), ['bill_to_match', 'customer_invoice_to_issue', 'receivable_overdue'])
  assert.deepEqual(finance.hidden, ['purchasing', 'inventory', 'sales_orders'])
  assert.equal(finance.recentDocuments.some((row) => row.type === 'purchase_order'), false)

  const buyer = (await homeFor(roleAccess('procurement-specialist'))).payload
  assert.deepEqual(buyer.workItems.map((item) => item.kind), ['purchase_order_due', 'reorder_now', 'reorder_now', 'reorder_now'])
  assert.deepEqual(buyer.hidden, ['bills', 'sales_orders', 'customer_invoices', 'receivables'])
  // The setup steps a buyer may not do have no link.
  assert.equal(buyer.firstRun.steps.find((step) => step.id === 'teammates').href, null)
})

test('amounts and customer names follow the finance permissions', async () => {
  const viewer = (await homeFor(roleAccess('read-only-viewer'))).payload
  const receivable = viewer.workItems.find((item) => item.kind === 'receivable_overdue')
  assert.equal(receivable.detail.outstanding, null)
  assert.equal(receivable.name, null)
  assert.equal(viewer.workItems.find((item) => item.kind === 'customer_invoice_to_issue').detail.amount, null)
  assert.equal(JSON.stringify(viewer).includes('Redwood Retail') && viewer.workItems.some((item) => item.kind === 'sales_order_to_reserve' && item.name === 'Redwood Retail'), true, 'the sales order keeps its customer, as on the sales pages')
  assert.equal(JSON.stringify(viewer.workItems.filter((item) => item.entityType === 'customer_invoice')).includes('Redwood Retail'), false)
})

test('a reader of only some warehouses gets no reorder items and a note, as on the reorder list', async () => {
  const scoped = roleAccess('*', { warehouseIds: ['WH-1'] })
  const { payload } = await homeFor(scoped, { database: fakeDatabase({ warehouses: [{ id: 'WH-1' }, { id: 'WH-2' }] }) })
  assert.equal(payload.workItems.some((item) => item.kind === 'reorder_now'), false)
  assert.ok(payload.limitations.includes('reorder_not_checked_for_warehouse_scope'))
  // The purchase order is still listed.
  assert.ok(payload.workItems.some((item) => item.kind === 'purchase_order_due'))
})

test('the route reads receivables overdue from the start of the workspace day', async () => {
  const evening = (await homeFor(roleAccess('*'), { now: EVENING })).payload
  assert.deepEqual(evening.workItems.filter((item) => item.kind === 'receivable_overdue').map((item) => item.label), ['CI-1999'])
  assert.equal(evening.workItems.find((item) => item.label === 'PO-42AA497A').kind, 'purchase_order_due')
})

test('a source that cannot be read is named instead of failing the page', async () => {
  const database = fakeDatabase()
  database.receivableObligation.findMany = async () => { throw new Error('relation does not exist') }
  const { status, payload } = await homeFor(roleAccess('*'), { database })
  assert.equal(status, 200)
  assert.ok(payload.limitations.includes('today_source_unavailable:receivables'))
  assert.ok(payload.workItems.some((item) => item.kind === 'purchase_order_due'))
  // Without a database the page still lists what the read context holds.
  let response
  await handleBusinessReadContextRoute({
    req: { method: 'GET' }, res: {}, url: new URL('http://local/api/home/overview'), repositories: repositories(), dataMode: 'user',
    identity: { authenticated: true, tenantId: 'tenant-t' }, reportReadAccess: roleAccess('*'), tenantTimezone: NY, homeOverviewNow: MORNING, env: {},
    send: (_res, statusCode, body) => { response = { status: statusCode, payload: body } },
  })
  assert.equal(response.status, 200)
  assert.ok(response.payload.limitations.includes('today_database_sources_unavailable'))
  assert.equal(response.payload.firstRun, null)
  assert.ok(response.payload.workItems.some((item) => item.kind === 'purchase_order_due'))
})
