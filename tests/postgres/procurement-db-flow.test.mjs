import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// End-to-end procurement in database persistence mode, driven through the real
// HTTP server and the endpoints the browser calls:
//   PR   src/modules/purchase-requests/CanonicalProcurementPanel.tsx
//   RFQ  src/components/procurement/CanonicalDownstreamPanel.tsx (create mode)
//   PO   /api/procurement/requests/:id/generate-purchase-orders (PR panel),
//        /api/mobile/purchase-orders/:id/approve (src/modules/mobile)
//   GRN  /api/receiving-docs (src/modules/receiving/Page.tsx),
//        /api/mobile/receiving/drafts (src/modules/mobile),
//        /api/procurement/receiving/:id/post (ReceivingPostingWorkbench.tsx)
// Every step asserts the rows PostgreSQL holds afterwards.
//
// Steps with no PostgreSQL write path are marked `todo`: they still run, so the
// report shows the exact failure, but they do not fail the suite. Downstream
// steps start from rows seeded directly, standing in for the missing step.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/procurement-db-flow.test.mjs

const MISSING_PR_COMMANDS = 'No PostgreSQL command service for purchase requests: procurement-workflow-service writes through procurementRuntime.transact(), which always answers 409 PROCUREMENT_DATABASE_COMMAND_REQUIRED in database mode.'
const PR_CREATE_BROKEN = `${MISSING_PR_COMMANDS} Before that, line validation looks suppliers and items up without a tenant, so db-master-data-repository falls back to tenant-flowchain-sme and answers SUPPLIER_NOT_FOUND for any other workspace.`
const PR_CONVERSION_BROKEN = `${MISSING_PR_COMMANDS} RFQ and PO creation fail even earlier with 500: the database repository has no idempotency() method.`
const MISSING_PO_COMMANDS = 'No PostgreSQL command creates, submits or issues a purchase order: procurement-db-command-service only approves, rejects and returns pending orders.'
const LEGACY_RECEIVING_CREATE = 'The desktop receiving page still posts to the retired /api/receiving-docs route (501); only the mobile facade creates receiving drafts in PostgreSQL.'
const BUYER_ROLE_GATE = 'procurement-workflow.routes.mjs gates on raw session roles and does not list "buyer", although the permission catalog maps buyer to procurement-specialist.'

// Flags a US trial workspace turns on (reports-ranking item 12), plus mobile
// operations, which hosts the only PostgreSQL PO approval and receiving draft
// commands today.
const TRIAL_FLAGS = {
  FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: 'true',
  FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true',
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true',
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true',
  FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: 'true',
}

const tenantA = 'tenant-procurement-flow-us'
const tenantB = 'tenant-procurement-flow-other'
const managerA = { id: 'flow-manager-a', email: 'manager-a@procurement-flow.invalid', name: 'Avery Manager', role: 'manager' }
const buyerA = { id: 'flow-buyer-a', email: 'buyer-a@procurement-flow.invalid', name: 'Blake Buyer', role: 'buyer' }
const managerB = { id: 'flow-manager-b', email: 'manager-b@procurement-flow.invalid', name: 'Casey Other', role: 'manager' }
const warehouseA = 'flow-wh-a'
const supplierA = 'flow-supplier-a'
const itemA = { id: 'flow-item-a', sku: 'FLOW-SKU-A', name: 'Walkthrough Pallet Wrap' }
const needBy = '2026-10-15'

let prisma
let server
let base
const serverErrors = []
const tokens = {}
const key = (label) => `${label}-${randomUUID()}`
const dec = (value) => value === null || value === undefined ? null : value.toString()

async function api(token, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : null } catch { payload = text }
  return { status: response.status, body: payload }
}

const describe = (result) => `${result.status} ${result.body?.code || ''} ${result.body?.message || ''}`.trim()

// Login binds the session to FLOWCHAIN_DEFAULT_TENANT_ID. Switching it only for
// the duration of one login lets a single server hold sessions for two tenants.
async function login(user, tenantId) {
  const previous = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
  try {
    const result = await api(null, 'POST', '/api/auth/login', { email: user.email, name: user.name, company: 'Procurement Flow' })
    assert.equal(result.status, 200, describe(result))
    assert.equal(result.body.user.tenantId, tenantId)
    return result.body.token
  } finally {
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previous
  }
}

// The canonical PR line shape the PR panel submits.
const uiPrLine = (overrides = {}) => ({
  lineId: key('pr-line'), sourceType: 'catalog_item', lineBasis: 'quantity',
  itemId: itemA.id, sku: itemA.sku, itemNameSnapshot: itemA.name, unitSnapshot: 'EA',
  supplierId: supplierA, quantity: 10, estimatedUnitPrice: 12.5, estimatedAmount: 125,
  currency: 'USD', targetWarehouseId: warehouseA, needByDate: needBy, ...overrides,
})

async function seedPurchaseRequest(id, { status, quantity = '10', unitPrice = '12.5', tenantId = tenantA } = {}) {
  const amount = (Number(quantity) * Number(unitPrice)).toFixed(4)
  await prisma.purchaseRequest.create({ data: {
    id, tenantId, status, requester: managerA.id, currency: 'USD', amount, requiredDate: new Date(`${needBy}T00:00:00Z`),
    metadata: { version: 1, requesterId: managerA.id, departmentId: 'operations' },
    lines: { create: [{ id: `${id}-L1`, itemId: itemA.id, sku: itemA.sku, itemName: itemA.name, quantity, unit: 'EA', unitPrice, amount, metadata: { supplierId: supplierA, targetWarehouseId: warehouseA, currency: 'USD', needByDate: needBy } }] },
  } })
}

async function seedPurchaseOrder(id, { status, quantity = '10', unitPrice = '12.5', tenantId = tenantA } = {}) {
  const amount = (Number(quantity) * Number(unitPrice)).toFixed(4)
  await prisma.purchaseOrder.create({ data: {
    id, tenantId, status, supplierId: supplierA, supplierName: 'Walkthrough Packaging Co.', amount, currency: 'USD', version: 0,
    lines: { create: [{ id: `${id}-L1`, itemId: itemA.id, sku: itemA.sku, itemName: itemA.name, orderedQuantity: quantity, receivedQuantity: '0', unit: 'EA', unitPrice, amount }] },
  } })
}

test.before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run through scripts/run-postgres-test-files.mjs against its disposable server.')
  Object.assign(process.env, TRIAL_FLAGS, {
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantA,
    FLOWCHAIN_LOCAL_SESSION_SECRET: `procurement-flow-${randomUUID()}`,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: 'false',
    FLOWCHAIN_COMMIT_SHA: 'procurement-db-flow',
    FLOWCHAIN_BRANCH: 'test/procurement-db-flow',
  })
  prisma = await createPrismaClient(process.env)
  await prisma.tenant.create({ data: { id: tenantA, name: 'Procurement Flow US' } })
  await prisma.tenant.create({ data: { id: tenantB, name: 'Procurement Flow Other' } })
  for (const [tenantId, user] of [[tenantA, managerA], [tenantA, buyerA], [tenantB, managerB]]) {
    await prisma.user.create({ data: { ...user, tenantId } })
  }
  await backfillTenantAuthorization(prisma, tenantA, { actorId: managerA.id })
  await backfillTenantAuthorization(prisma, tenantB, { actorId: managerB.id })
  await prisma.warehouse.create({ data: { id: warehouseA, tenantId: tenantA, code: 'FLOW-A', name: 'Flow Warehouse A', status: 'active' } })
  await prisma.warehouse.create({ data: { id: 'flow-wh-b', tenantId: tenantB, code: 'FLOW-B', name: 'Flow Warehouse B', status: 'active' } })
  await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: tenantA, userId: managerA.id, warehouseId: warehouseA, accessLevel: 'operate' } })
  await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: tenantB, userId: managerB.id, warehouseId: 'flow-wh-b', accessLevel: 'operate' } })
  await prisma.supplier.create({ data: { id: supplierA, tenantId: tenantA, code: 'SUP-FLOW-A', name: 'Walkthrough Packaging Co.', status: 'active' } })
  await prisma.supplier.create({ data: { id: 'flow-supplier-a2', tenantId: tenantA, code: 'SUP-FLOW-A2', name: 'Second Source Supply', status: 'active' } })
  await prisma.item.create({ data: { id: itemA.id, tenantId: tenantA, sku: itemA.sku, name: itemA.name, unit: 'EA', preferredSupplierId: supplierA, metadata: { defaultWarehouseId: warehouseA, purchasable: true } } })

  const { createScmServer } = await import('../../server/scm-api.mjs')
  server = createScmServer({ errorLogger: { error: (line) => serverErrors.push(String(line)) } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  tokens.managerA = await login(managerA, tenantA)
  tokens.buyerA = await login(buyerA, tenantA)
  tokens.managerB = await login(managerB, tenantB)
})

test.after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await prisma?.$disconnect()
})

test('the trial capability flags enable receiving posting and the mobile PO and receiving facades', async () => {
  const result = await api(tokens.managerA, 'GET', '/api/capabilities')
  assert.equal(result.status, 200, describe(result))
  const byId = Object.fromEntries(result.body.capabilities.map((entry) => [entry.id, entry]))
  for (const id of ['procurement', 'receiving-posting', 'receiving-reversal', 'mobile-operations', 'sales-shipment-posting', 'stock-transfer', 'supplier-invoice', 'finance']) {
    assert.equal(byId[id]?.enabled, true, `${id} should be enabled for the trial`)
  }
})

test('without mobile operations enabled a trial has no PostgreSQL path to approve a PO or draft a receipt', async () => {
  process.env.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS = 'false'
  try {
    for (const [method, path] of [['GET', '/api/mobile/tasks'], ['POST', '/api/mobile/purchase-orders/any/approve'], ['POST', '/api/mobile/receiving/drafts']]) {
      const result = await api(tokens.managerA, method, path, method === 'POST' ? {} : undefined)
      assert.equal(result.status, 409, `${method} ${path}: ${describe(result)}`)
      assert.equal(result.body.code, 'MOBILE_OPERATIONS_CAPABILITY_NOT_AVAILABLE')
    }
  } finally {
    process.env.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS = 'true'
  }
})

test('PR lines are validated against the suppliers and items of the signed-in workspace', async () => {
  const ownSuppliers = await api(tokens.managerA, 'GET', `/api/master-data/items/${itemA.id}/suppliers`)
  assert.equal(ownSuppliers.status, 200, describe(ownSuppliers))
  assert.deepEqual(ownSuppliers.body.suppliers.map((supplier) => [supplier.id, supplier.preferred]), [[supplierA, true]])
  const otherSuppliers = await api(tokens.managerB, 'GET', `/api/master-data/items/${itemA.id}/suppliers`)
  assert.equal(otherSuppliers.status, 200, describe(otherSuppliers))
  assert.deepEqual(otherSuppliers.body.suppliers, [])

  const body = (line) => ({ departmentId: 'operations', defaultCurrency: 'USD', defaultNeedByDate: needBy, lines: [uiPrLine(line)] })
  const foreign = await api(tokens.managerB, 'POST', '/api/procurement/requests', body())
  assert.equal(foreign.status, 400, describe(foreign))
  assert.equal(foreign.body.code, 'SUPPLIER_NOT_FOUND')
  const unapproved = await api(tokens.managerA, 'POST', '/api/procurement/requests', body({ supplierId: 'flow-supplier-a2' }))
  assert.equal(unapproved.status, 400, describe(unapproved))
  assert.equal(unapproved.body.code, 'ITEM_SUPPLIER_RELATIONSHIP_INVALID')
  assert.equal(await prisma.purchaseRequest.count(), 0)
})

test('step 1: a signed-in manager saves a PR draft (POST /api/procurement/requests)', { todo: PR_CREATE_BROKEN }, async () => {
  const body = { departmentId: 'operations', defaultCurrency: 'USD', defaultNeedByDate: needBy, lines: [uiPrLine()] }
  const created = await api(tokens.managerA, 'POST', '/api/procurement/requests', body)
  assert.equal(created.status, 201, describe(created))
  const row = await prisma.purchaseRequest.findFirst({ where: { id: created.body.id, tenantId: tenantA }, include: { lines: true } })
  assert.ok(row, 'the PR is stored in PostgreSQL for the signed-in tenant')
  assert.equal(row.status, 'draft')
  assert.equal(row.currency, 'USD')
  assert.equal(dec(row.amount), '125')
  assert.equal(row.lines.length, 1)
  assert.equal(dec(row.lines[0].quantity), '10')
  assert.equal(dec(row.lines[0].unitPrice), '12.5')
  const listed = await api(tokens.managerA, 'GET', '/api/procurement/requests')
  assert.ok(listed.body.some((pr) => pr.id === row.id), 'the PR list shows the new draft')
  const other = await api(tokens.managerB, 'GET', '/api/procurement/requests')
  assert.ok(!other.body.some((pr) => pr.id === row.id), 'another tenant does not see it')
})

test('step 1b: a signed-in buyer saves a PR draft', { todo: BUYER_ROLE_GATE }, async () => {
  const body = { departmentId: 'operations', defaultCurrency: 'USD', defaultNeedByDate: needBy, lines: [uiPrLine()] }
  const created = await api(tokens.buyerA, 'POST', '/api/procurement/requests', body)
  assert.notEqual(created.status, 403, describe(created))
})

test('step 2: the manager submits and approves the PR (POST /api/procurement/requests/:id/submit|approve)', { todo: MISSING_PR_COMMANDS }, async () => {
  const id = 'PR-FLOW-SUBMIT'
  await seedPurchaseRequest(id, { status: 'draft' })
  const submitted = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/submit`, { expectedVersion: 1 })
  assert.equal(submitted.status, 200, describe(submitted))
  assert.equal((await prisma.purchaseRequest.findUnique({ where: { id } })).status, 'submitted')
  const approved = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/approve`, { expectedVersion: submitted.body.version })
  assert.equal(approved.status, 200, describe(approved))
  assert.equal((await prisma.purchaseRequest.findUnique({ where: { id } })).status, 'approved')
})

test('step 3a: an approved PR above the RFQ threshold opens an RFQ (POST /api/procurement/requests/:id/rfqs)', { todo: PR_CONVERSION_BROKEN }, async () => {
  const id = 'PR-FLOW-RFQ'
  await seedPurchaseRequest(id, { status: 'approved', quantity: '1000', unitPrice: '150' })
  const created = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/rfqs`, { expectedVersion: 1, title: 'Pallet wrap annual volume', dueDate: needBy, invitedSupplierIds: [supplierA] })
  assert.equal(created.status, 201, describe(created))
  const rfq = await prisma.rfq.findFirst({ where: { tenantId: tenantA, sourceRequestId: id }, include: { lines: true } })
  assert.ok(rfq, 'the RFQ is stored in PostgreSQL')
  assert.equal(rfq.status, 'draft')
  assert.equal(rfq.currency, 'USD')
  assert.equal(dec(rfq.lines[0].quantity), '1000')
})

test('step 3b: an approved PR becomes a draft PO (POST /api/procurement/requests/:id/generate-purchase-orders)', { todo: PR_CONVERSION_BROKEN }, async () => {
  const id = 'PR-FLOW-DIRECT'
  await seedPurchaseRequest(id, { status: 'approved' })
  const created = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 1 })
  assert.equal(created.status, 201, describe(created))
  const po = await prisma.purchaseOrder.findFirst({ where: { tenantId: tenantA, sourceRequestId: id }, include: { lines: true } })
  assert.ok(po, 'the PO is stored in PostgreSQL')
  assert.equal(po.status, 'draft')
  assert.equal(po.supplierId, supplierA)
  assert.equal(po.currency, 'USD')
  assert.equal(dec(po.amount), '125')
  assert.equal(dec(po.lines[0].orderedQuantity), '10')
  assert.equal(dec(po.lines[0].receivedQuantity), '0')
  assert.equal((await prisma.purchaseRequest.findUnique({ where: { id } })).status, 'converted')
})

test('step 4a: a draft PO is submitted for approval (POST /api/procurement/orders/:id/submit)', { todo: MISSING_PO_COMMANDS }, async () => {
  const id = 'PO-FLOW-SUBMIT'
  await seedPurchaseOrder(id, { status: 'draft' })
  const submitted = await api(tokens.managerA, 'POST', `/api/procurement/orders/${id}/submit`, { expectedVersion: 0 })
  assert.equal(submitted.status, 200, describe(submitted))
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id } })).status, 'pending_approval')
})

let approvedPoId
test('step 4b: the manager approves a pending PO (POST /api/mobile/purchase-orders/:id/approve)', async () => {
  // Seeded: steps 3b and 4a cannot create a pending PO in PostgreSQL yet.
  approvedPoId = 'PO-FLOW-APPROVE'
  await seedPurchaseOrder(approvedPoId, { status: 'pending_approval' })
  const idempotencyKey = key('po-approve')
  const approved = await api(tokens.managerA, 'POST', `/api/mobile/purchase-orders/${approvedPoId}/approve`, { expectedVersion: 0, idempotencyKey })
  assert.equal(approved.status, 200, describe(approved))
  assert.equal(approved.body.status, 'approved')
  const row = await prisma.purchaseOrder.findUnique({ where: { id: approvedPoId }, include: { lines: true } })
  assert.equal(row.status, 'approved')
  assert.equal(row.receivingBaseStatus, 'approved')
  assert.equal(row.version, 1)
  assert.equal(row.currency, 'USD')
  assert.equal(dec(row.amount), '125')
  assert.equal(dec(row.lines[0].orderedQuantity), '10')
  assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantA, entityType: 'PurchaseOrder', entityId: approvedPoId } }), 1)
  assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: tenantA, entityId: approvedPoId, status: 'completed' } }), 1)
  const replay = await api(tokens.managerA, 'POST', `/api/mobile/purchase-orders/${approvedPoId}/approve`, { expectedVersion: 0, idempotencyKey })
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: approvedPoId } })).version, 1)
  const listed = await api(tokens.managerA, 'GET', '/api/procurement/orders')
  const listedPo = listed.body.find((po) => po.id === approvedPoId)
  assert.equal(listedPo?.status, 'approved')
  assert.equal(listedPo?.currency, 'USD')
})

test('step 4c: an approved PO is issued to the supplier (POST /api/procurement/orders/:id/issue)', { todo: MISSING_PO_COMMANDS }, async () => {
  const id = 'PO-FLOW-ISSUE'
  await seedPurchaseOrder(id, { status: 'approved' })
  const issued = await api(tokens.managerA, 'POST', `/api/procurement/orders/${id}/issue`, { expectedVersion: 0 })
  assert.equal(issued.status, 200, describe(issued))
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id } })).status, 'issued')
})

test('step 5a: the desktop receiving page creates a GRN (POST /api/receiving-docs)', { todo: LEGACY_RECEIVING_CREATE }, async () => {
  const id = 'PO-FLOW-DESKTOP-GRN'
  await seedPurchaseOrder(id, { status: 'approved' })
  const created = await api(tokens.managerA, 'POST', '/api/receiving-docs', { po: id, items: 2, passed: 2, failed: 0, lines: [{ poLineId: `${id}-L1`, sku: itemA.sku, receivedQty: 2, acceptedQty: 2, rejectedQty: 0 }], status: '质检中' })
  assert.equal(created.status, 201, describe(created))
  assert.equal(await prisma.receivingDocument.count({ where: { tenantId: tenantA, poId: id } }), 1)
})

let postedGrnId
test('step 5b: receiving drafts, submits and posts against the approved PO, then the PO closes', async () => {
  const draft = await api(tokens.managerA, 'POST', '/api/mobile/receiving/drafts', { idempotencyKey: key('grn-draft'), poId: approvedPoId, warehouseId: warehouseA, lines: [{ purchaseOrderLineId: `${approvedPoId}-L1`, acceptedQuantity: '6', location: 'A-01' }] })
  assert.equal(draft.status, 201, describe(draft))
  postedGrnId = draft.body.entityId
  let grn = await prisma.receivingDocument.findFirst({ where: { id: postedGrnId, tenantId: tenantA }, include: { lines: true } })
  assert.equal(grn.poId, approvedPoId)
  assert.equal(grn.workflowStatus, 'draft')
  assert.equal(grn.postingStatus, 'unposted')
  assert.equal(grn.currency, 'USD')
  assert.equal(dec(grn.lines[0].acceptedQty), '6')

  const submitted = await api(tokens.managerA, 'POST', `/api/mobile/receiving/drafts/${postedGrnId}/submit`, { expectedVersion: grn.version, idempotencyKey: key('grn-submit') })
  assert.equal(submitted.status, 200, describe(submitted))
  assert.equal((await prisma.receivingDocument.findUnique({ where: { id: postedGrnId } })).workflowStatus, 'ready_for_receiving')

  const detail = await api(tokens.managerA, 'GET', `/api/procurement/receiving/${postedGrnId}`)
  assert.equal(detail.status, 200, describe(detail))
  const posted = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${postedGrnId}/post`, { idempotencyKey: key('grn-post'), expectedVersion: detail.body.receivingDocument.version })
  assert.equal(posted.status, 200, describe(posted))
  grn = await prisma.receivingDocument.findUnique({ where: { id: postedGrnId } })
  assert.equal(grn.postingStatus, 'posted')
  let po = await prisma.purchaseOrder.findUnique({ where: { id: approvedPoId }, include: { lines: true } })
  assert.equal(dec(po.lines[0].receivedQuantity), '6')
  assert.equal(po.status, 'partially_received')
  const balance = await prisma.inventoryBalance.findFirst({ where: { tenantId: tenantA, sku: itemA.sku, warehouseId: warehouseA } })
  assert.equal(dec(balance.onHandQuantity), '6')
  const movements = await prisma.inventoryMovement.findMany({ where: { tenantId: tenantA, relatedGrnId: postedGrnId } })
  assert.equal(movements.length, 1)
  assert.equal(dec(movements[0].quantityIn), '6')

  const over = await api(tokens.managerA, 'POST', '/api/mobile/receiving/drafts', { idempotencyKey: key('grn-over'), poId: approvedPoId, warehouseId: warehouseA, lines: [{ purchaseOrderLineId: `${approvedPoId}-L1`, acceptedQuantity: '5' }] })
  assert.equal(over.status, 409, describe(over))
  assert.equal(over.body.code, 'RECEIVING_OVER_RECEIPT')

  const rest = await api(tokens.managerA, 'POST', '/api/mobile/receiving/drafts', { idempotencyKey: key('grn-rest'), poId: approvedPoId, warehouseId: warehouseA, lines: [{ purchaseOrderLineId: `${approvedPoId}-L1`, acceptedQuantity: '4', location: 'A-01' }] })
  assert.equal(rest.status, 201, describe(rest))
  const restId = rest.body.entityId
  const restSubmitted = await api(tokens.managerA, 'POST', `/api/mobile/receiving/drafts/${restId}/submit`, { expectedVersion: rest.body.receivingDocument.version, idempotencyKey: key('grn-rest-submit') })
  assert.equal(restSubmitted.status, 200, describe(restSubmitted))
  const restPosted = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${restId}/post`, { idempotencyKey: key('grn-rest-post'), expectedVersion: restSubmitted.body.receivingDocument.version })
  assert.equal(restPosted.status, 200, describe(restPosted))
  po = await prisma.purchaseOrder.findUnique({ where: { id: approvedPoId }, include: { lines: true } })
  assert.equal(dec(po.lines[0].receivedQuantity), '10')
  assert.equal(po.status, 'fully_received')
  assert.equal(dec((await prisma.inventoryBalance.findFirst({ where: { tenantId: tenantA, sku: itemA.sku, warehouseId: warehouseA } })).onHandQuantity), '10')
  assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantA, entityType: 'ReceivingDocument', action: 'receiving_posted' } }), 2)
})

test('a second tenant cannot see or change the first tenant\'s purchase orders and receipts', async () => {
  const pendingId = 'PO-FLOW-ISOLATION'
  await seedPurchaseOrder(pendingId, { status: 'pending_approval' })
  await seedPurchaseRequest('PR-FLOW-ISOLATION', { status: 'submitted' })
  const orders = await api(tokens.managerB, 'GET', '/api/procurement/orders')
  assert.equal(orders.status, 200, describe(orders))
  assert.deepEqual(orders.body.filter((po) => [approvedPoId, pendingId].includes(po.id)), [])
  const requests = await api(tokens.managerB, 'GET', '/api/procurement/requests')
  assert.ok(!requests.body.some((pr) => pr.id === 'PR-FLOW-ISOLATION'))
  const workbench = await api(tokens.managerB, 'GET', '/api/purchase-orders-workbench')
  assert.deepEqual(workbench.body.purchaseOrders.filter((po) => po.id.startsWith('PO-FLOW-')), [])
  assert.deepEqual(workbench.body.receivingDocs.filter((doc) => doc.poId === approvedPoId), [])

  const detail = await api(tokens.managerB, 'GET', `/api/mobile/purchase-orders/${pendingId}`)
  assert.equal(detail.status, 404, describe(detail))
  const approve = await api(tokens.managerB, 'POST', `/api/mobile/purchase-orders/${pendingId}/approve`, { expectedVersion: 0, idempotencyKey: key('iso-approve') })
  assert.equal(approve.status, 404, describe(approve))
  const untouched = await prisma.purchaseOrder.findUnique({ where: { id: pendingId } })
  assert.equal(untouched.status, 'pending_approval')
  assert.equal(untouched.version, 0)

  const grnRead = await api(tokens.managerB, 'GET', `/api/procurement/receiving/${postedGrnId}`)
  assert.equal(grnRead.status, 404, describe(grnRead))
  const reverse = await api(tokens.managerB, 'POST', `/api/procurement/receiving/${postedGrnId}/reverse`, { idempotencyKey: key('iso-reverse'), reason: 'Cross-tenant attempt' })
  assert.equal(reverse.status, 404, describe(reverse))
  assert.equal((await prisma.receivingDocument.findUnique({ where: { id: postedGrnId } })).postingStatus, 'posted')
  const foreignDraft = await api(tokens.managerB, 'POST', '/api/mobile/receiving/drafts', { idempotencyKey: key('iso-draft'), poId: approvedPoId, warehouseId: 'flow-wh-b', lines: [{ purchaseOrderLineId: `${approvedPoId}-L1`, acceptedQuantity: '1' }] })
  assert.equal(foreignDraft.status, 404, describe(foreignDraft))
  assert.equal(await prisma.receivingDocument.count({ where: { tenantId: tenantB } }), 0)
  assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: tenantB } }), 0)
})

test('the PO, PR and RFQ list endpoints answer once instead of falling through to later routes', async () => {
  // A route that sends a response but does not report the request as handled
  // lets the dispatcher run later routes, which write a second response and
  // log ERR_HTTP_HEADERS_SENT as a server error on every page load.
  for (const path of ['/api/purchase-orders-workbench', '/api/purchase-orders', '/api/purchase-requests', '/api/rfqs']) {
    const before = serverErrors.length
    const result = await api(tokens.managerA, 'GET', path)
    assert.equal(result.status, 200, `${path}: ${describe(result)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(serverErrors.slice(before), [], `${path} logged a server error`)
  }
})
