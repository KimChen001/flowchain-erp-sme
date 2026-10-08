import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseProvisionArgs, provisionTenant } from '../../scripts/tenant-provision.mjs'
import { readOutbox } from '../../server/mail/outbox-mailer.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// The trial customer's golden path on a fresh workspace, from an empty
// database: the operator provisions the tenant (scripts/tenant-provision.mjs),
// the administrator signs in with an email link, imports items, suppliers,
// customers, item suppliers and opening stock from CSV, posts the opening
// stock, then buys (purchase request, approval, purchase order, approval,
// issue, receipt, bill, three-way match, approval, payment record) and sells
// (sales order, confirmation, reservation, shipment, invoice, payment record).
// Every business step goes through the HTTP API the browser calls; PostgreSQL
// is touched directly only for the operator's provisioning and to check that
// the database starts empty. At the end the stock balances, the inventory
// movements, the inventory report and the open purchase orders report must
// agree: stock = opening + received - shipped per SKU and location, and no
// quantity is totalled across SKUs or units.
//
// The steps run in order and share state. When one fails, the later ones are
// skipped with the name of the step that blocked them, so the report shows the
// first broken step of the path.
// Run with: npm run test:db:golden-path

// The US trial capability set from render.yaml; everything else is off.
const TRIAL_FLAGS = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: 'true',
  FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true',
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true',
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true',
  FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: 'true',
  FLOWCHAIN_ENABLE_DATA_IMPORT: 'true',
  FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: 'false',
  FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT: 'false',
  FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: 'false',
  FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: 'false',
}

const tenantId = 'golden-path-trial'
const adminEmail = 'owner@golden-path.invalid'
const timeZone = 'America/New_York'

// The workspace's calendar day, so payment and invoice dates are never in the
// workspace's future late in the US evening.
const workspaceDay = (offsetDays = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const date = new Date(`${today}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}
const midnight = (day) => `${day}T00:00:00.000Z`
const key = (label) => `golden-${label}-${randomUUID()}`
const num = (value) => (value === null || value === undefined ? null : Number(value))

// What the customer's files say.
const VALVE = { sku: 'GP-VALVE', name: 'Gate valve 2 in', unit: 'EA', price: '12.50' }
const GASKET = { sku: 'GP-GASKET', name: 'Gasket kit', unit: 'BOX', price: '8.00' }
const SUPPLIER = { code: 'GP-SUP-1', name: 'Harbor Valve Supply' }
const CUSTOMER = { code: 'GP-CUS-1', name: 'Redwood Plumbing' }
const OPENING = { [VALVE.sku]: { location: 'A-01', quantity: 20 }, [GASKET.sku]: { location: 'B-01', quantity: 6 } }
const ORDERED = { [VALVE.sku]: 10, [GASKET.sku]: 5 }
// The valves arrive in full at their opening location; three of the five
// gasket boxes arrive, and go to a second location.
const RECEIVED = { [VALVE.sku]: { location: 'A-01', quantity: 10 }, [GASKET.sku]: { location: 'B-02', quantity: 3 } }
const SHIPPED = { [VALVE.sku]: { location: 'A-01', quantity: 4 } }
const SALE_PRICE = '30.00'

let prisma
let server
let base
let directory
let outboxPath
let token
const state = {}
const serverErrors = []

async function api(method, path, body, { auth = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : null } catch { payload = text }
  return { status: response.status, body: payload }
}

const show = (result) => `${result.status} ${JSON.stringify(result.body)?.slice(0, 1500)}`
function expectStatus(result, status) {
  assert.equal(result.status, status, show(result))
  return result.body
}

let blockedBy = null
function step(name, fn) {
  test(name, async (t) => {
    if (blockedBy) {
      t.skip(`blocked by the earlier step "${blockedBy}"`)
      return
    }
    try {
      await fn(t)
    } catch (error) {
      blockedBy = name
      throw error
    }
  })
}

const csv = (lines) => Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8').toString('base64')
async function importFile(type, lines) {
  const preview = expectStatus(await api('POST', `/api/data-import/${type}/preview`, { fileName: `${type}.csv`, contentBase64: csv(lines) }), 200)
  assert.deepEqual(preview.rows.map((row) => [row.rowNumber, row.action, (row.issues || []).map((entry) => entry.code)]), preview.rows.map((row) => [row.rowNumber, 'create', []]), `${type} preview: ${JSON.stringify(preview.rows)}`)
  const rows = preview.rows.map(({ rowNumber, values }) => ({ rowNumber, values }))
  const committed = expectStatus(await api('POST', `/api/data-import/${type}/commit`, { fileSha256: preview.fileSha256, chunkIndex: 0, rows }), 200)
  assert.deepEqual(committed.rows.map((row) => row.outcome), rows.map(() => 'created'), `${type} commit: ${JSON.stringify(committed.rows)}`)
  return committed
}

test.before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with npm run test:db:golden-path, which starts a fresh PostgreSQL database.')
  directory = await mkdtemp(join(tmpdir(), 'flowchain-golden-path-'))
  outboxPath = join(directory, 'outbox.json')
  Object.assign(process.env, TRIAL_FLAGS, {
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_LOCAL_SESSION_SECRET: `golden-path-${randomUUID()}-secret`,
    FLOWCHAIN_MAIL_PROVIDER: 'outbox',
    FLOWCHAIN_MAIL_OUTBOX_PATH: outboxPath,
    FLOWCHAIN_PUBLIC_BASE_URL: 'https://flowchain.test',
    FLOWCHAIN_COMMIT_SHA: 'golden-path-fresh-tenant',
    FLOWCHAIN_BRANCH: 'test/golden-path-fresh-tenant',
  })
  prisma = await createPrismaClient(process.env)
  const { createScmServer } = await import('../../server/bootstrap/scm-server.mjs')
  server = createScmServer({ errorLogger: { error: (line) => serverErrors.push(String(line)), warn: () => {}, info: () => {} } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await prisma?.$disconnect()
  await disconnectPrismaClient().catch(() => {})
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
})

step('0. the database starts empty: no workspace, user or business record', async () => {
  for (const model of ['tenant', 'user', 'warehouse', 'item', 'supplier', 'purchaseOrder', 'salesOrder', 'inventoryBalance', 'inventoryMovement']) {
    assert.equal(await prisma[model].count(), 0, `${model} rows before provisioning`)
  }
})

step('1. the operator provisions the workspace with tenant:provision', async () => {
  const options = parseProvisionArgs([`--tenant-id=${tenantId}`, '--company-name=Golden Path Supply Co.', `--admin-email=${adminEmail}`, '--admin-name=Pat Lee'])
  const report = await provisionTenant(prisma, options)
  assert.equal(report.tenant, 'created')
  assert.equal(report.warehouse, 'created')
  assert.equal(report.admin, 'created')
  assert.equal(report.paymentTermsCreated, 5)
  state.warehouseId = report.warehouseId
  state.adminId = report.adminId
})

step('2. the administrator signs in with an email link', async () => {
  const requested = await api('POST', '/api/auth/email-link', { email: adminEmail }, { auth: false })
  assert.equal(requested.status, 202, show(requested))
  let message
  for (let attempt = 0; attempt < 100 && !message; attempt += 1) {
    message = (await readOutbox(outboxPath)).find((entry) => entry.to === adminEmail)
    if (!message) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(message, 'the sign-in email reached the outbox')
  assert.equal(message.subject, 'Your FlowChain sign-in link')
  const link = message.text.match(/https?:\/\/\S+\/sign-in\/confirm\?token=\S+/)
  assert.ok(link, message.text)
  const confirmed = expectStatus(await api('POST', '/api/auth/email-link/confirm', { token: new URL(link[0]).searchParams.get('token') }, { auth: false }), 200)
  assert.equal(confirmed.user.tenantId, tenantId)
  assert.equal(confirmed.user.id, state.adminId)
  token = confirmed.token
  const capabilities = expectStatus(await api('GET', '/api/capabilities'), 200)
  const enabled = Object.fromEntries(capabilities.capabilities.map((entry) => [entry.id, entry.enabled]))
  for (const id of ['data-import', 'receiving-posting', 'sales-order-lifecycle', 'sales-shipment-posting', 'inventory-adjustment-document', 'supplier-invoice', 'three-way-match', 'customer-invoice']) {
    assert.equal(enabled[id], true, `${id} is part of the trial`)
  }
})

step('3. the import creates items, suppliers, customers and item suppliers from CSV', async () => {
  const template = await api('GET', '/api/data-import/templates/items')
  assert.equal(template.status, 200)
  assert.ok(String(template.body).replace(/^﻿/, '').startsWith('SKU,Item name,Category,Specification,Unit'))
  await importFile('items', ['SKU,Item name,Unit,Safety stock,Reorder point,Status', `${VALVE.sku},${VALVE.name},${VALVE.unit},5,10,Active`, `${GASKET.sku},${GASKET.name},${GASKET.unit},2,4,Active`])
  await importFile('suppliers', ['Supplier code,Supplier name,Email,Default currency,Payment term code', `${SUPPLIER.code},${SUPPLIER.name},orders@harbor-valve.invalid,USD,NET30`])
  await importFile('customers', ['Customer code,Customer name,Currency,Payment terms', `${CUSTOMER.code},${CUSTOMER.name},USD,NET30`])
  await importFile('item-suppliers', ['SKU,Supplier code,Reference price,Currency,Preferred', `${VALVE.sku},${SUPPLIER.code},${VALVE.price},USD,Yes`, `${GASKET.sku},${SUPPLIER.code},${GASKET.price},USD,Yes`])

  const items = expectStatus(await api('GET', '/api/master-data/items'), 200).items
  state.items = {}
  for (const entry of [VALVE, GASKET]) {
    const row = items.find((item) => item.sku === entry.sku)
    assert.ok(row, `${entry.sku} is listed`)
    assert.equal(row.baseUnit, entry.unit)
    state.items[entry.sku] = row.itemId
    const suppliers = expectStatus(await api('GET', `/api/master-data/items/${encodeURIComponent(row.itemId)}/suppliers`), 200).suppliers
    assert.equal(suppliers.length, 1, JSON.stringify(suppliers))
    assert.equal(suppliers[0].preferred, true)
    state.supplierId = suppliers[0].id
  }
  const customers = expectStatus(await api('GET', '/api/master-data/customers'), 200)
  assert.ok(JSON.stringify(customers).includes(CUSTOMER.name), 'the imported customer is listed')
})

step('4. opening stock imports as a draft adjustment that a person readies and posts', async () => {
  const committed = await importFile('opening-stock', ['SKU,Warehouse code,Location,Quantity,Unit', ...[VALVE, GASKET].map((entry) => `${entry.sku},MAIN,${OPENING[entry.sku].location},${OPENING[entry.sku].quantity},${entry.unit}`)])
  assert.equal(committed.documents.length, 1, JSON.stringify(committed.documents))
  const [document] = committed.documents
  // Nothing is stock until the draft is posted.
  assert.deepEqual(expectStatus(await api('GET', `/api/inventory/balances?sku=${VALVE.sku}`), 200).balances, [])
  const draft = expectStatus(await api('GET', `/api/inventory/adjustments/${encodeURIComponent(document.id)}/workbench`), 200)
  const ready = expectStatus(await api('POST', `/api/inventory/adjustments/${encodeURIComponent(document.id)}/ready`, { expectedAdjustmentVersion: draft.adjustment.version, idempotencyKey: key('opening-ready') }), 200)
  const preview = expectStatus(await api('POST', `/api/inventory/adjustments/${encodeURIComponent(document.id)}/post-preview`, {}), 200)
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockingIssues))
  expectStatus(await api('POST', `/api/inventory/adjustments/${encodeURIComponent(document.id)}/post`, { expectedAdjustmentVersion: ready.adjustment.version, idempotencyKey: key('opening-post') }), 200)
  for (const entry of [VALVE, GASKET]) {
    const balances = expectStatus(await api('GET', `/api/inventory/balances?sku=${entry.sku}`), 200).balances
    assert.deepEqual(balances.map((row) => [row.locationKey, num(row.onHandQuantity)]), [[OPENING[entry.sku].location.toLowerCase(), OPENING[entry.sku].quantity]])
  }
})

step('5. a purchase request for both items is saved, submitted and approved', async () => {
  state.needBy = workspaceDay(14)
  const line = (entry) => ({
    lineId: key('pr-line'), sourceType: 'catalog_item', lineBasis: 'quantity',
    itemId: state.items[entry.sku], sku: entry.sku, itemNameSnapshot: entry.name, unitSnapshot: entry.unit,
    supplierId: state.supplierId, quantity: ORDERED[entry.sku], estimatedUnitPrice: Number(entry.price), estimatedAmount: ORDERED[entry.sku] * Number(entry.price),
    currency: 'USD', targetWarehouseId: state.warehouseId, needByDate: state.needBy,
  })
  const created = expectStatus(await api('POST', '/api/procurement/requests', { idempotencyKey: key('pr'), departmentId: 'operations', defaultCurrency: 'USD', defaultNeedByDate: state.needBy, lines: [line(VALVE), line(GASKET)] }), 201)
  state.prId = created.id
  const submitted = expectStatus(await api('POST', `/api/procurement/requests/${state.prId}/submit`, { expectedVersion: created.version }), 200)
  const approved = expectStatus(await api('POST', `/api/procurement/requests/${state.prId}/approve`, { expectedVersion: submitted.version }), 200)
  const detail = expectStatus(await api('GET', `/api/procurement/requests/${state.prId}`), 200)
  assert.equal(detail.status, 'approved')
  state.prVersion = approved.version ?? detail.version
})

step('6. the approved request becomes one purchase order, approved with the request, and issued', async () => {
  const generated = expectStatus(await api('POST', `/api/procurement/requests/${state.prId}/generate-purchase-orders`, { expectedVersion: state.prVersion }), 201)
  assert.equal(generated.createdPurchaseOrders.length, 1)
  state.poId = generated.createdPurchaseOrders[0].id
  // A new workspace has Review Policies' "approved with the request" on: the
  // PO is created approved, and its approval step names the request.
  const po = expectStatus(await api('GET', `/api/procurement/orders/${state.poId}`), 200)
  assert.equal(po.status, 'approved')
  // Issuing records that the buyer sent the order; FlowChain sends nothing.
  const issued = expectStatus(await api('POST', `/api/procurement/orders/${state.poId}/issue`, { expectedVersion: po.version }), 200)
  assert.equal(issued.purchaseOrder.status, 'issued')
  assert.equal(issued.purchaseOrder.metadata.transmissionStatus, 'issued_outside_flowchain')
  assert.ok(issued.purchaseOrder.issuedAt, 'the issue date is recorded')
  assert.equal((await readOutbox(outboxPath)).filter((entry) => entry.to !== adminEmail).length, 0, 'no email to the supplier')
})

step('7. the goods are received: valves in full, three of five gasket boxes, then the receipt is posted', async () => {
  const form = expectStatus(await api('GET', `/api/procurement/purchase-orders/${state.poId}/receivable-lines`), 200)
  assert.deepEqual(form.warehouses.map((warehouse) => warehouse.id), [state.warehouseId])
  const lineFor = (sku) => form.purchaseOrder.lines.find((row) => row.sku === sku)
  state.poLines = { [VALVE.sku]: lineFor(VALVE.sku).id, [GASKET.sku]: lineFor(GASKET.sku).id }
  const created = expectStatus(await api('POST', '/api/procurement/receiving', {
    idempotencyKey: key('grn'), poId: state.poId, warehouseId: state.warehouseId,
    lines: [VALVE, GASKET].map((entry) => ({ purchaseOrderLineId: state.poLines[entry.sku], acceptedQuantity: String(RECEIVED[entry.sku].quantity), rejectedQuantity: '0', location: RECEIVED[entry.sku].location })),
  }), 201)
  state.grnId = created.entityId
  const submitted = expectStatus(await api('POST', `/api/procurement/receiving/${state.grnId}/submit`, { expectedVersion: 0 }), 200)
  expectStatus(await api('POST', `/api/procurement/receiving/${state.grnId}/post`, { idempotencyKey: key('grn-post'), expectedVersion: submitted.receivingDocument.version }), 200)
  const po = expectStatus(await api('GET', `/api/procurement/orders/${state.poId}`), 200)
  assert.equal(po.status, 'partially_received')
})

step('8. the supplier bill for what arrived matches the order and the receipt, is approved and paid', async () => {
  const entry = expectStatus(await api('GET', '/api/finance/entry-data'), 200)
  const receipt = (entry.receivingDocuments || []).find((row) => row.id === state.grnId)
  assert.ok(receipt, `the posted receipt is offered for billing: ${JSON.stringify(entry.receivingDocuments)?.slice(0, 800)}`)
  const lines = receipt.lines.map((line) => {
    const entryItem = line.sku === VALVE.sku ? VALVE : GASKET
    const quantity = Number(line.acceptedQuantity).toFixed(4)
    return { purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.id, quantity, unitPrice: entryItem.price, lineAmount: (Number(quantity) * Number(entryItem.price)).toFixed(4), enteredTaxAmount: '0' }
  })
  const total = lines.reduce((sum, line) => sum + Number(line.lineAmount), 0)
  state.billTotal = total
  const bill = { invoiceNumber: 'HVS-1001', supplierId: state.supplierId, currency: 'USD', invoiceDate: midnight(workspaceDay()), dueDate: midnight(workspaceDay(30)), totalAmount: total.toFixed(4), lines }
  const preview = expectStatus(await api('POST', '/api/finance/supplier-invoices/preview', bill), 200)
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockingIssues))
  const created = expectStatus(await api('POST', '/api/finance/supplier-invoices', { ...bill, idempotencyKey: key('bill') }), 201)
  state.billId = created.entityId
  expectStatus(await api('POST', `/api/finance/supplier-invoices/${state.billId}/submit`, { expectedVersion: 0, idempotencyKey: key('bill-submit') }), 200)
  const matched = expectStatus(await api('POST', `/api/finance/supplier-invoices/${state.billId}/match`, { expectedVersion: 1, idempotencyKey: key('bill-match') }), 200)
  assert.equal(matched.invoice.status, 'matched', JSON.stringify(matched))
  const approved = expectStatus(await api('POST', `/api/finance/supplier-invoices/${state.billId}/approve`, { expectedVersion: 2, idempotencyKey: key('bill-approve') }), 200)
  const payableId = approved.payable.id
  const payment = { expectedVersion: 0, paymentDate: workspaceDay(), amount: total.toFixed(2), currency: 'USD', method: 'ach', reference: 'ACH-GP-1' }
  const paymentPreview = expectStatus(await api('POST', `/api/finance/payables/${payableId}/payments/preview`, payment), 200)
  assert.equal(paymentPreview.allowed, true, JSON.stringify(paymentPreview.blockingIssues))
  assert.equal(paymentPreview.paymentExecution, false, 'a payment record moves no money')
  const paid = expectStatus(await api('POST', `/api/finance/payables/${payableId}/payments`, { ...payment, idempotencyKey: key('bill-pay') }), 201)
  assert.equal(paid.obligation.status, 'settled')
  assert.equal(num(paid.obligation.outstandingAmount), 0)
})

step('9. a sales order for valves is entered, confirmed, reserved and shipped', async () => {
  const entry = expectStatus(await api('GET', '/api/sales/order-entry-data'), 200)
  assert.ok(entry.items.some((item) => item.id === state.items[VALVE.sku]))
  // The order form offers the imported customer with its recorded terms and
  // currency, and sends the chosen customer's id (OutboundWorkbench.tsx).
  const customer = entry.customers.find((row) => row.code === CUSTOMER.code)
  assert.ok(customer, 'the imported customer is offered on the order form')
  assert.equal(customer.name, CUSTOMER.name)
  assert.equal(customer.currency, 'USD')
  const created = expectStatus(await api('POST', '/api/sales/orders', { orderNumber: 'SO-GP-1001', customerId: customer.id, currency: customer.currency, idempotencyKey: key('so'), lines: [{ itemId: state.items[VALVE.sku], quantity: String(SHIPPED[VALVE.sku].quantity), unitPrice: SALE_PRICE }] }), 201)
  assert.equal(created.order.customerId, customer.id)
  assert.equal(created.order.customerName, CUSTOMER.name)
  state.soId = created.order.id
  state.soLineId = created.order.lines[0].id
  expectStatus(await api('POST', `/api/sales/orders/${state.soId}/confirm`, { expectedOrderVersion: created.order.version, idempotencyKey: key('so-confirm') }), 200)
  let workbench = expectStatus(await api('GET', `/api/sales/orders/${state.soId}/workbench`), 200)
  const allocation = { salesOrderLineId: state.soLineId, warehouseId: state.warehouseId, location: SHIPPED[VALVE.sku].location, quantity: String(SHIPPED[VALVE.sku].quantity) }
  const reservePreview = expectStatus(await api('POST', `/api/sales/orders/${state.soId}/reservations/preview`, { allocations: [allocation] }), 200)
  assert.equal(reservePreview.allowed, true, JSON.stringify(reservePreview.blockingIssues))
  const reserved = expectStatus(await api('POST', `/api/sales/orders/${state.soId}/reservations/reserve`, { expectedOrderVersion: workbench.order.version, idempotencyKey: key('so-reserve'), allocations: [allocation] }), 200)
  const reservationId = reserved.reservations[0].id
  workbench = expectStatus(await api('GET', `/api/sales/orders/${state.soId}/workbench`), 200)
  const shipment = { shipmentNumber: 'SHIP-GP-1001', lines: [{ salesOrderLineId: state.soLineId, allocations: [{ reservationId, quantity: String(SHIPPED[VALVE.sku].quantity) }] }] }
  const draftPreview = expectStatus(await api('POST', `/api/sales/orders/${state.soId}/shipments/preview`, shipment), 200)
  assert.equal(draftPreview.allowed, true, JSON.stringify(draftPreview.blockingIssues))
  const drafted = expectStatus(await api('POST', `/api/sales/orders/${state.soId}/shipments`, { ...shipment, expectedOrderVersion: workbench.order.version, idempotencyKey: key('ship') }), 201)
  state.shipmentId = drafted.shipment.id
  const postPreview = expectStatus(await api('POST', `/api/sales/shipments/${state.shipmentId}/post-preview`, {}), 200)
  assert.equal(postPreview.allowed, true, JSON.stringify(postPreview.blockingIssues))
  const posted = expectStatus(await api('POST', `/api/sales/shipments/${state.shipmentId}/post`, { expectedShipmentVersion: drafted.shipment.version, idempotencyKey: key('ship-post') }), 200)
  assert.equal(posted.shipment.postingStatus, 'posted')
})

step('10. the customer invoice for the shipment is issued and the customer payment recorded', async () => {
  const entry = expectStatus(await api('GET', '/api/finance/entry-data'), 200)
  const shipment = (entry.postedShipments || []).find((row) => row.id === state.shipmentId)
  assert.ok(shipment, `the posted shipment is offered for invoicing: ${JSON.stringify(entry.postedShipments)?.slice(0, 800)}`)
  const invoice = {
    invoiceNumber: 'INV-GP-1001', shipmentId: state.shipmentId, currency: shipment.currency || 'USD',
    invoiceDate: midnight(workspaceDay()), dueDate: midnight(workspaceDay(30)),
    lines: shipment.lines.map((line) => ({ shipmentLineId: line.id, quantity: String(SHIPPED[VALVE.sku].quantity), enteredTaxAmount: '0' })),
  }
  const preview = expectStatus(await api('POST', '/api/finance/customer-invoices/preview', invoice), 200)
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockingIssues))
  const expectedTotal = SHIPPED[VALVE.sku].quantity * Number(SALE_PRICE)
  assert.equal(num(preview.invoice.totalAmount), expectedTotal)
  const created = expectStatus(await api('POST', '/api/finance/customer-invoices', { ...invoice, idempotencyKey: key('inv') }), 201)
  const invoiceId = created.invoice?.id || created.entityId
  expectStatus(await api('POST', `/api/finance/customer-invoices/${invoiceId}/submit`, { expectedVersion: 0, idempotencyKey: key('inv-submit') }), 200)
  expectStatus(await api('POST', `/api/finance/customer-invoices/${invoiceId}/approve`, { expectedVersion: 1, idempotencyKey: key('inv-approve') }), 200)
  const issued = expectStatus(await api('POST', `/api/finance/customer-invoices/${invoiceId}/issue`, { expectedVersion: 2, idempotencyKey: key('inv-issue') }), 200)
  const receivableId = issued.receivable.id
  const paid = expectStatus(await api('POST', `/api/finance/receivables/${receivableId}/payments`, { expectedVersion: 0, paymentDate: workspaceDay(), amount: expectedTotal.toFixed(2), currency: 'USD', method: 'check', reference: 'CHK-GP-1', idempotencyKey: key('inv-pay') }), 201)
  assert.equal(paid.obligation.status, 'settled')
})

// stock = opening + received - shipped, per SKU and location.
const expectedStock = () => {
  const rows = new Map()
  const add = (sku, location, quantity) => {
    const id = `${sku}|${location.toLowerCase()}`
    rows.set(id, (rows.get(id) || 0) + quantity)
  }
  for (const [sku, entry] of Object.entries(OPENING)) add(sku, entry.location, entry.quantity)
  for (const [sku, entry] of Object.entries(RECEIVED)) add(sku, entry.location, entry.quantity)
  for (const [sku, entry] of Object.entries(SHIPPED)) add(sku, entry.location, -entry.quantity)
  return [...rows].map(([id, quantity]) => [...id.split('|'), quantity]).sort()
}

step('11. stock balances and movements equal opening + received - shipped per SKU and location', async () => {
  const expected = expectedStock()
  // GP-GASKET b-01 6, GP-GASKET b-02 3, GP-VALVE a-01 20 + 10 - 4 = 26
  assert.deepEqual(expected, [['GP-GASKET', 'b-01', 6], ['GP-GASKET', 'b-02', 3], ['GP-VALVE', 'a-01', 26]])
  const balances = []
  const moved = new Map()
  for (const entry of [VALVE, GASKET]) {
    for (const row of expectStatus(await api('GET', `/api/inventory/balances?sku=${entry.sku}`), 200).balances) {
      assert.equal(row.warehouseId, state.warehouseId)
      assert.equal(row.unit, entry.unit)
      balances.push([row.sku, row.locationKey, num(row.onHandQuantity)])
      assert.equal(num(row.availableQuantity), num(row.onHandQuantity), 'nothing is left reserved after shipping')
    }
    for (const row of expectStatus(await api('GET', `/api/inventory/movements?sku=${entry.sku}`), 200).movements) {
      const id = `${row.sku}|${row.locationKey || String(row.location).toLowerCase()}`
      // Every movement (opening adjustment, receipt, shipment) states its
      // quantity in and out; adjustmentQty repeats the same signed change.
      moved.set(id, (moved.get(id) || 0) + num(row.quantityIn || 0) - num(row.quantityOut || 0))
    }
  }
  assert.deepEqual(balances.sort(), expected)
  assert.deepEqual([...moved].map(([id, quantity]) => [...id.split('|'), quantity]).sort(), expected, 'the movements add up to the balances')
})

step('12. the inventory report shows each SKU in its own unit and no total across units', async () => {
  const report = expectStatus(await api('GET', '/api/reports/inventory'), 200)
  const bySku = Object.fromEntries(report.details.map((row) => [row.id, row]))
  assert.deepEqual([num(bySku[VALVE.sku]?.quantity), bySku[VALVE.sku]?.unit], [26, VALVE.unit])
  assert.deepEqual([num(bySku[GASKET.sku]?.quantity), bySku[GASKET.sku]?.unit], [9, GASKET.unit])
  const onHand = report.kpis.find((kpi) => kpi.id === 'inventory_on_hand')
  assert.equal(onHand.value, null, 'EA and BOX are never added together')
  assert.ok(onHand.limitations.some((code) => ['inventory_units_mixed', 'inventory_skus_mixed'].includes(code)), JSON.stringify(onHand.limitations))
})

step('13. the open purchase orders report shows the partly received order, its amount in USD and no mixed-unit quantity', async () => {
  const report = expectStatus(await api('GET', '/api/reports/open-purchase-orders'), 200)
  assert.equal(report.total, 1, JSON.stringify(report.rows))
  const [row] = report.rows
  assert.equal(row.id, state.poId)
  assert.equal(row.status, 'partially_received')
  assert.equal(row.supplier, SUPPLIER.name)
  assert.equal(row.currency, 'USD')
  const orderAmount = ORDERED[VALVE.sku] * Number(VALVE.price) + ORDERED[GASKET.sku] * Number(GASKET.price)
  assert.equal(row.amount, orderAmount)
  assert.deepEqual([row.unit, row.ordered, row.received, row.remaining], ['mixed', null, null, null])
  assert.deepEqual(report.summary.totals, [{ currency: 'USD', amount: orderAmount }])
  // The order's own lines agree with the receipt and the stock.
  const po = expectStatus(await api('GET', `/api/procurement/orders/${state.poId}`), 200)
  const received = Object.fromEntries((po.lines || po.items || []).map((line) => [line.sku, num(line.receivedQuantity ?? line.received)]))
  assert.deepEqual(received, { [VALVE.sku]: RECEIVED[VALVE.sku].quantity, [GASKET.sku]: RECEIVED[GASKET.sku].quantity })
})

step('14. the path logged no server error', async () => {
  assert.deepEqual(serverErrors, [])
})
