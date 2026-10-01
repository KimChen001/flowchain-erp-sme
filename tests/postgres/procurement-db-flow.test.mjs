import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// End-to-end procurement in database persistence mode, driven through the real
// HTTP server and the endpoints the browser calls:
//   PR   src/modules/purchase-requests/CanonicalProcurementPanel.tsx
//   RFQ  /api/procurement/requests/:id/rfqs, /api/procurement/rfqs/:id/open|cancel
//        (no page mounts an RFQ create form at the moment)
//   PO   /api/procurement/requests/:id/generate-purchase-orders (PR panel),
//        /api/procurement/orders/:id/submit|approve|issue|cancel
//        (PurchaseOrderWorkflowActions on the PO detail page),
//        /api/mobile/purchase-orders/:id/approve (src/modules/mobile)
//   GRN  /api/procurement/receiving, /api/procurement/receiving/:id(/submit)
//        (src/modules/procurement/ReceivingForm.tsx, from the PO detail page),
//        /api/mobile/receiving/drafts (src/modules/mobile),
//        /api/procurement/receiving/:id/post (ReceivingPostingWorkbench.tsx)
// Every step asserts the rows PostgreSQL holds afterwards.
//
// Steps with no PostgreSQL write path are marked `todo`: they still run, so the
// report shows the exact failure, but they do not fail the suite. Downstream
// steps start from rows seeded directly, standing in for the missing step.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/procurement-db-flow.test.mjs

// Flags a US trial workspace turns on (reports-ranking item 12). Desktop
// receiving needs only receiving posting; mobile operations stays available.
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
// Received on the desktop in step 5a, so its stock stays apart from itemA's.
const itemB = { id: 'flow-item-b', sku: 'FLOW-SKU-B', name: 'Walkthrough Corner Boards' }
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
    lines: { create: [{ id: `${id}-L1`, itemId: itemA.id, sku: itemA.sku, itemName: itemA.name, quantity, unit: 'EA', unitPrice, amount, metadata: { supplierId: supplierA, supplierSnapshot: { id: supplierA, supplierName: 'Walkthrough Packaging Co.' }, targetWarehouseId: warehouseA, currency: 'USD', needByDate: needBy } }] },
  } })
}

async function seedPurchaseOrder(id, { status, quantity = '10', unitPrice = '12.5', tenantId = tenantA, item = itemA } = {}) {
  const amount = (Number(quantity) * Number(unitPrice)).toFixed(4)
  await prisma.purchaseOrder.create({ data: {
    id, tenantId, status, supplierId: supplierA, supplierName: 'Walkthrough Packaging Co.', amount, currency: 'USD', version: 0,
    lines: { create: [{ id: `${id}-L1`, itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: quantity, receivedQuantity: '0', unit: 'EA', unitPrice, amount }] },
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
  await prisma.item.create({ data: { id: itemB.id, tenantId: tenantA, sku: itemB.sku, name: itemB.name, unit: 'EA', preferredSupplierId: supplierA, metadata: { defaultWarehouseId: warehouseA, purchasable: true } } })

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

test('without mobile operations the mobile facade is closed and a trial still approves POs on the desktop', async () => {
  process.env.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS = 'false'
  try {
    for (const [method, path] of [['GET', '/api/mobile/tasks'], ['POST', '/api/mobile/purchase-orders/any/approve'], ['POST', '/api/mobile/receiving/drafts']]) {
      const result = await api(tokens.managerA, method, path, method === 'POST' ? {} : undefined)
      assert.equal(result.status, 409, `${method} ${path}: ${describe(result)}`)
      assert.equal(result.body.code, 'MOBILE_OPERATIONS_CAPABILITY_NOT_AVAILABLE')
    }
    const id = 'PO-FLOW-DESKTOP-ONLY'
    await seedPurchaseOrder(id, { status: 'pending_approval' })
    const approved = await api(tokens.managerA, 'POST', `/api/procurement/orders/${id}/approve`, { expectedVersion: 0 })
    assert.equal(approved.status, 200, describe(approved))
    assert.equal((await prisma.purchaseOrder.findUnique({ where: { id } })).status, 'approved')
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

const audits = (entityType, entityId) => prisma.auditLog.count({ where: { tenantId: tenantA, entityType, entityId } })
const prVersion = async (id) => Number((await prisma.purchaseRequest.findUnique({ where: { id } })).metadata.version)

test('step 1: a signed-in manager saves and edits a PR draft (POST, PATCH /api/procurement/requests)', async () => {
  const idempotencyKey = key('pr-create')
  const body = { idempotencyKey, departmentId: 'operations', defaultCurrency: 'USD', defaultNeedByDate: needBy, lines: [uiPrLine()] }
  const created = await api(tokens.managerA, 'POST', '/api/procurement/requests', body)
  assert.equal(created.status, 201, describe(created))
  assert.equal(created.body.version, 1)
  const row = await prisma.purchaseRequest.findFirst({ where: { id: created.body.id, tenantId: tenantA }, include: { lines: true } })
  assert.ok(row, 'the PR is stored in PostgreSQL for the signed-in tenant')
  assert.equal(row.status, 'draft')
  assert.equal(row.requester, managerA.id)
  assert.equal(row.metadata.version, 1)
  assert.equal(row.currency, 'USD')
  assert.equal(dec(row.amount), '125')
  assert.equal(row.supplierId, supplierA)
  assert.equal(row.lines.length, 1)
  assert.equal(dec(row.lines[0].quantity), '10')
  assert.equal(dec(row.lines[0].unitPrice), '12.5')
  assert.equal(dec(row.lines[0].amount), '125')
  assert.equal(row.lines[0].metadata.supplierId, supplierA)
  assert.equal(row.lines[0].metadata.targetWarehouseId, warehouseA)
  assert.equal(await audits('PurchaseRequest', row.id), 1)

  const replay = await api(tokens.managerA, 'POST', '/api/procurement/requests', body)
  assert.equal(replay.body.id, row.id)
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal(await prisma.purchaseRequest.count({ where: { tenantId: tenantA, requester: managerA.id } }), 1)
  assert.equal(await audits('PurchaseRequest', row.id), 1)
  const reused = await api(tokens.managerA, 'POST', '/api/procurement/requests', { ...body, departmentId: 'finance' })
  assert.equal(reused.status, 409, describe(reused))
  assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')

  const listed = await api(tokens.managerA, 'GET', '/api/procurement/requests')
  const listedPr = listed.body.find((pr) => pr.id === row.id)
  assert.equal(listedPr?.status, 'draft')
  assert.equal(listedPr?.lines[0].supplierId, supplierA, 'the list returns what the edit form needs')
  const other = await api(tokens.managerB, 'GET', '/api/procurement/requests')
  assert.ok(!other.body.some((pr) => pr.id === row.id), 'another tenant does not see it')
  const otherDetail = await api(tokens.managerB, 'GET', `/api/procurement/requests/${row.id}`)
  assert.equal(otherDetail.status, 404, describe(otherDetail))

  // The edit form saves with PATCH and the version it loaded.
  const { idempotencyKey: _unused, ...editBody } = body
  const edited = await api(tokens.managerA, 'PATCH', `/api/procurement/requests/${row.id}`, { ...editBody, expectedVersion: 1, lines: [uiPrLine({ quantity: 8 })] })
  assert.equal(edited.status, 200, describe(edited))
  assert.equal(edited.body.version, 2)
  const editedRow = await prisma.purchaseRequest.findUnique({ where: { id: row.id }, include: { lines: true } })
  assert.equal(dec(editedRow.amount), '100')
  assert.equal(dec(editedRow.lines[0].quantity), '8')
  const stale = await api(tokens.managerA, 'PATCH', `/api/procurement/requests/${row.id}`, { ...editBody, expectedVersion: 1, lines: [uiPrLine({ quantity: 3 })] })
  assert.equal(stale.status, 409, describe(stale))
  assert.equal(stale.body.code, 'VERSION_CONFLICT')
  assert.equal(stale.body.currentVersion, 2)
  const foreignEdit = await api(tokens.managerB, 'PATCH', `/api/procurement/requests/${row.id}`, { expectedVersion: 2, departmentId: 'x' })
  assert.equal(foreignEdit.status, 404, describe(foreignEdit))
  assert.equal(await prVersion(row.id), 2)
  assert.equal(await audits('PurchaseRequest', row.id), 2)
})

test('step 1b: a signed-in buyer saves, submits and withdraws a PR but cannot approve or reject it', async () => {
  const body = { departmentId: 'operations', defaultNeedByDate: needBy, lines: [uiPrLine({ currency: undefined })] }
  const created = await api(tokens.buyerA, 'POST', '/api/procurement/requests', body)
  assert.equal(created.status, 201, describe(created))
  const row = await prisma.purchaseRequest.findUnique({ where: { id: created.body.id } })
  assert.equal(row.requester, buyerA.id)
  assert.equal(row.currency, 'USD', 'the workspace currency is the default')
  const submitted = await api(tokens.buyerA, 'POST', `/api/procurement/requests/${row.id}/submit`, { expectedVersion: 1 })
  assert.equal(submitted.status, 200, describe(submitted))
  const approve = await api(tokens.buyerA, 'POST', `/api/procurement/requests/${row.id}/approve`, { expectedVersion: 2 })
  assert.equal(approve.status, 403, describe(approve))
  const reject = await api(tokens.buyerA, 'POST', `/api/procurement/requests/${row.id}/reject`, { expectedVersion: 2, reason: 'Not needed' })
  assert.equal(reject.status, 403, describe(reject))
  const withdrawn = await api(tokens.buyerA, 'POST', `/api/procurement/requests/${row.id}/withdraw`, { expectedVersion: 2 })
  assert.equal(withdrawn.status, 200, describe(withdrawn))
  const after = await prisma.purchaseRequest.findUnique({ where: { id: row.id } })
  assert.equal(after.status, 'draft')
  assert.equal(after.metadata.version, 3)
  assert.equal(await audits('PurchaseRequest', row.id), 3, 'create, submit and withdraw; refused commands leave no audit row')
})

test('step 2: the manager submits and approves the PR (POST /api/procurement/requests/:id/submit|approve)', async () => {
  const id = 'PR-FLOW-SUBMIT'
  await seedPurchaseRequest(id, { status: 'draft' })
  const submitted = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/submit`, { expectedVersion: 1 })
  assert.equal(submitted.status, 200, describe(submitted))
  assert.equal(submitted.body.version, 2)
  assert.equal((await prisma.purchaseRequest.findUnique({ where: { id } })).status, 'submitted')

  const foreign = await api(tokens.managerB, 'POST', `/api/procurement/requests/${id}/approve`, { expectedVersion: 2 })
  assert.equal(foreign.status, 404, describe(foreign))
  const stale = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/approve`, { expectedVersion: 1 })
  assert.equal(stale.status, 409, describe(stale))
  assert.equal(stale.body.code, 'VERSION_CONFLICT')
  const rejectWithoutReason = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/reject`, { expectedVersion: 2 })
  assert.equal(rejectWithoutReason.status, 400, describe(rejectWithoutReason))
  assert.equal(await prVersion(id), 2)

  const approved = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/approve`, { expectedVersion: 2 })
  assert.equal(approved.status, 200, describe(approved))
  const row = await prisma.purchaseRequest.findUnique({ where: { id } })
  assert.equal(row.status, 'approved')
  assert.equal(row.metadata.version, 3)
  assert.equal(row.metadata.lastActorId, managerA.id)
  assert.equal(dec(row.amount), '125')
  assert.equal(row.currency, 'USD')
  const replay = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/approve`, { expectedVersion: 2 })
  assert.equal(replay.status, 200, describe(replay))
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal(await prVersion(id), 3)
  assert.equal(await audits('PurchaseRequest', id), 2, 'one audit row each for submit and approve')
  const again = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/submit`, { expectedVersion: 3 })
  assert.equal(again.status, 409, describe(again))
  assert.equal(again.body.code, 'INVALID_STATE_TRANSITION')
})

test('step 3a: an approved PR above the RFQ threshold opens an RFQ (POST /api/procurement/requests/:id/rfqs, /api/procurement/rfqs/:id/open)', async () => {
  const id = 'PR-FLOW-RFQ'
  await seedPurchaseRequest(id, { status: 'approved', quantity: '1000', unitPrice: '150' })
  const body = { expectedVersion: 1, title: 'Pallet wrap annual volume', dueDate: needBy, invitedSupplierIds: [supplierA] }
  const foreign = await api(tokens.managerB, 'POST', `/api/procurement/requests/${id}/rfqs`, body)
  assert.equal(foreign.status, 404, describe(foreign))
  const created = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/rfqs`, body)
  assert.equal(created.status, 201, describe(created))
  const rfq = await prisma.rfq.findFirst({ where: { tenantId: tenantA, sourceRequestId: id }, include: { lines: true, supplierParticipations: true } })
  assert.ok(rfq, 'the RFQ is stored in PostgreSQL')
  assert.equal(created.body.rfq.id, rfq.id)
  assert.equal(rfq.status, 'draft')
  assert.equal(rfq.metadata.version, 1)
  assert.equal(rfq.currency, 'USD')
  assert.equal(rfq.title, 'Pallet wrap annual volume')
  assert.equal(dec(rfq.lines[0].quantity), '1000')
  assert.equal(rfq.lines[0].metadata.targetUnitPrice, '150.0000')
  assert.deepEqual(rfq.supplierParticipations.map((row) => [row.supplierId, row.status]), [[supplierA, 'planned']])
  const pr = await prisma.purchaseRequest.findUnique({ where: { id } })
  assert.equal(pr.status, 'approved')
  assert.equal(pr.linkedRfqId, rfq.id)
  assert.equal(pr.metadata.version, 2)
  assert.equal(pr.metadata.procurementPath, 'rfq')
  assert.equal(await audits('Rfq', rfq.id), 1)

  const replay = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/rfqs`, body)
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal(replay.body.rfq.id, rfq.id)
  assert.equal(await prisma.rfq.count({ where: { tenantId: tenantA, sourceRequestId: id } }), 1)
  const stale = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/rfqs`, { ...body, title: 'Second try' })
  assert.equal(stale.status, 409, describe(stale))
  assert.equal(stale.body.code, 'VERSION_CONFLICT')
  const directPo = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 2 })
  assert.equal(directPo.status, 409, describe(directPo))
  assert.equal(directPo.body.code, 'DOWNSTREAM_OBJECT_ALREADY_EXISTS')

  const listed = await api(tokens.managerA, 'GET', '/api/procurement/rfqs')
  const listedRfq = listed.body.find((row) => row.id === rfq.id)
  assert.equal(listedRfq?.version, 1)
  assert.equal(listedRfq?.sourcePrId, id)
  const otherList = await api(tokens.managerB, 'GET', '/api/procurement/rfqs')
  assert.ok(!otherList.body.some((row) => row.id === rfq.id))

  const foreignOpen = await api(tokens.managerB, 'POST', `/api/procurement/rfqs/${rfq.id}/open`, { expectedVersion: 1 })
  assert.equal(foreignOpen.status, 404, describe(foreignOpen))
  const opened = await api(tokens.buyerA, 'POST', `/api/procurement/rfqs/${rfq.id}/open`, { expectedVersion: 1 })
  assert.equal(opened.status, 200, describe(opened))
  const openRow = await prisma.rfq.findUnique({ where: { id: rfq.id }, include: { supplierParticipations: true } })
  assert.equal(openRow.status, 'open')
  assert.equal(openRow.metadata.version, 2)
  assert.equal(openRow.supplierParticipations[0].status, 'invited_internal')
  assert.ok(openRow.supplierParticipations[0].invitedAt)
  const staleOpen = await api(tokens.buyerA, 'POST', `/api/procurement/rfqs/${rfq.id}/cancel`, { expectedVersion: 1 })
  assert.equal(staleOpen.status, 409, describe(staleOpen))
  assert.equal(await audits('Rfq', rfq.id), 2)
})

test('step 3b: an approved PR becomes a draft PO (POST /api/procurement/requests/:id/generate-purchase-orders)', async () => {
  const id = 'PR-FLOW-DIRECT'
  await seedPurchaseRequest(id, { status: 'approved' })
  const foreign = await api(tokens.managerB, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 1 })
  assert.equal(foreign.status, 404, describe(foreign))
  const stale = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 0 })
  assert.equal(stale.status, 409, describe(stale))
  assert.equal(stale.body.code, 'VERSION_CONFLICT')
  const created = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 1 })
  assert.equal(created.status, 201, describe(created))
  assert.equal(created.body.createdPurchaseOrders.length, 1)
  const po = await prisma.purchaseOrder.findFirst({ where: { tenantId: tenantA, sourceRequestId: id }, include: { lines: true } })
  assert.ok(po, 'the PO is stored in PostgreSQL')
  assert.equal(created.body.createdPurchaseOrders[0].id, po.id)
  assert.equal(po.status, 'draft')
  assert.equal(po.version, 0)
  assert.equal(po.supplierId, supplierA)
  assert.equal(po.currency, 'USD')
  assert.equal(dec(po.amount), '125')
  assert.equal(po.metadata.targetWarehouseId, warehouseA)
  assert.equal(dec(po.lines[0].orderedQuantity), '10')
  assert.equal(dec(po.lines[0].receivedQuantity), '0')
  assert.equal(dec(po.lines[0].unitPrice), '12.5')
  assert.equal(dec(po.lines[0].amount), '125')
  // The PR line's need-by date becomes the line's promised date through the
  // promise-date helper; the original promise waits for the PO to be issued.
  assert.equal(po.lines[0].metadata.promisedDate, needBy)
  assert.equal(po.lines[0].originalPromisedDate, null)
  assert.equal(po.lines[0].version, 0)
  assert.equal(po.expectedDate.toISOString().slice(0, 10), needBy)
  assert.equal(await prisma.purchaseOrderPromiseRevision.count({ where: { purchaseOrderId: po.id } }), 0)
  const pr = await prisma.purchaseRequest.findUnique({ where: { id } })
  assert.equal(pr.status, 'converted')
  assert.equal(pr.linkedPoId, po.id)
  assert.equal(pr.metadata.version, 2)
  assert.equal(await audits('PurchaseRequest', id), 1)
  assert.equal(await prisma.domainChangeFeed.count({ where: { tenantId: tenantA, entityType: 'PurchaseOrder', entityId: po.id } }), 1)

  const replay = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 1 })
  assert.equal(replay.status, 201, describe(replay))
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal(await prisma.purchaseOrder.count({ where: { tenantId: tenantA, sourceRequestId: id } }), 1)
  const again = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 2 })
  assert.equal(again.status, 409, describe(again))
  const orders = await api(tokens.managerA, 'GET', '/api/procurement/orders')
  assert.equal(orders.body.find((row) => row.id === po.id)?.status, 'draft')
  const otherOrders = await api(tokens.managerB, 'GET', '/api/procurement/orders')
  assert.ok(!otherOrders.body.some((row) => row.id === po.id))
})

test('step 3c: a buyer converts a two-supplier PR into one draft PO per supplier', async () => {
  const id = 'PR-FLOW-SPLIT'
  await prisma.purchaseRequest.create({ data: {
    id, tenantId: tenantA, status: 'approved', requester: buyerA.id, currency: 'USD', amount: '185.0000',
    metadata: { version: 1, requesterId: buyerA.id },
    lines: { create: [
      { id: `${id}-L1`, itemId: itemA.id, sku: itemA.sku, itemName: itemA.name, quantity: '10', unit: 'EA', unitPrice: '12.5', amount: '125', metadata: { supplierId: supplierA, supplierSnapshot: { supplierName: 'Walkthrough Packaging Co.' }, targetWarehouseId: warehouseA, currency: 'USD', needByDate: needBy } },
      { id: `${id}-L2`, itemName: 'Stretch film dispenser', quantity: '2', unit: 'EA', unitPrice: '30', amount: '60', metadata: { sourceType: 'non_catalog_item', supplierId: 'flow-supplier-a2', supplierSnapshot: { supplierName: 'Second Source Supply' }, targetWarehouseId: warehouseA, currency: 'USD', needByDate: '2026-10-20' } },
    ] },
  } })
  const created = await api(tokens.buyerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 1 })
  assert.equal(created.status, 201, describe(created))
  const pos = await prisma.purchaseOrder.findMany({ where: { tenantId: tenantA, sourceRequestId: id }, include: { lines: true }, orderBy: { amount: 'asc' } })
  assert.deepEqual(pos.map((po) => [po.supplierId, po.supplierName, dec(po.amount), po.currency, po.lines.length]), [
    ['flow-supplier-a2', 'Second Source Supply', '60', 'USD', 1],
    [supplierA, 'Walkthrough Packaging Co.', '125', 'USD', 1],
  ])
  assert.deepEqual((await prisma.purchaseRequest.findUnique({ where: { id } })).metadata.linkedPurchaseOrderIds.sort(), pos.map((po) => po.id).sort())
})

const poRow = (id) => prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true } })

test('step 4a: a buyer submits a draft PO and a manager approves it on the desktop (POST /api/procurement/orders/:id/submit|approve)', async () => {
  const id = 'PO-FLOW-SUBMIT'
  await seedPurchaseOrder(id, { status: 'draft' })
  const foreign = await api(tokens.managerB, 'POST', `/api/procurement/orders/${id}/submit`, { expectedVersion: 0 })
  assert.equal(foreign.status, 404, describe(foreign))
  const submitted = await api(tokens.buyerA, 'POST', `/api/procurement/orders/${id}/submit`, { expectedVersion: 0 })
  assert.equal(submitted.status, 200, describe(submitted))
  let row = await poRow(id)
  assert.equal(row.status, 'pending_approval')
  assert.equal(row.version, 1)
  assert.equal(row.currency, 'USD')
  assert.equal(dec(row.amount), '125')
  const replay = await api(tokens.buyerA, 'POST', `/api/procurement/orders/${id}/submit`, { expectedVersion: 0 })
  assert.equal(replay.status, 200, describe(replay))
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal((await poRow(id)).version, 1)

  const buyerApproval = await api(tokens.buyerA, 'POST', `/api/procurement/orders/${id}/approve`, { expectedVersion: 1 })
  assert.equal(buyerApproval.status, 403, describe(buyerApproval))
  const stale = await api(tokens.managerA, 'POST', `/api/procurement/orders/${id}/approve`, { expectedVersion: 0 })
  assert.equal(stale.status, 409, describe(stale))
  assert.equal(stale.body.code, 'SYNC_VERSION_CONFLICT')
  const approved = await api(tokens.managerA, 'POST', `/api/procurement/orders/${id}/approve`, { expectedVersion: 1 })
  assert.equal(approved.status, 200, describe(approved))
  row = await poRow(id)
  assert.equal(row.status, 'approved')
  assert.equal(row.receivingBaseStatus, 'approved')
  assert.equal(row.version, 2)
  assert.equal(await audits('PurchaseOrder', id), 2, 'one audit row each for submit and approve')
  const detail = await api(tokens.managerA, 'GET', `/api/procurement/orders/${id}`)
  assert.equal(detail.status, 200, describe(detail))
  assert.equal(detail.body.status, 'approved')
  const foreignDetail = await api(tokens.managerB, 'GET', `/api/procurement/orders/${id}`)
  assert.equal(foreignDetail.status, 404, describe(foreignDetail))
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

test('step 4c: an approved PO is issued to the supplier (POST /api/procurement/orders/:id/issue)', async () => {
  const id = 'PO-FLOW-ISSUE'
  await seedPurchaseOrder(id, { status: 'approved' })
  const early = await api(tokens.buyerA, 'POST', `/api/procurement/orders/PO-FLOW-SUBMIT/submit`, { expectedVersion: 2 })
  assert.equal(early.status, 409, describe(early))
  assert.equal(early.body.code, 'PURCHASE_ORDER_WORKFLOW_CONFLICT')
  const foreign = await api(tokens.managerB, 'POST', `/api/procurement/orders/${id}/issue`, { expectedVersion: 0 })
  assert.equal(foreign.status, 404, describe(foreign))
  const issued = await api(tokens.buyerA, 'POST', `/api/procurement/orders/${id}/issue`, { expectedVersion: 0 })
  assert.equal(issued.status, 200, describe(issued))
  const row = await poRow(id)
  assert.equal(row.status, 'issued')
  assert.equal(row.receivingBaseStatus, 'issued')
  assert.equal(row.version, 1)
  assert.equal(row.metadata.transmissionStatus, 'issued_outside_flowchain')
  assert.equal(await audits('PurchaseOrder', id), 1)
  const cancelIssued = await api(tokens.managerA, 'POST', `/api/procurement/orders/${id}/cancel`, { expectedVersion: 1 })
  assert.equal(cancelIssued.status, 409, describe(cancelIssued))

  // Receiving still accepts an issued PO, and reversal would restore "issued".
  const draft = await api(tokens.managerA, 'POST', '/api/mobile/receiving/drafts', { idempotencyKey: key('issued-draft'), poId: id, warehouseId: warehouseA, lines: [{ purchaseOrderLineId: `${id}-L1`, acceptedQuantity: '2', location: 'A-02' }] })
  assert.equal(draft.status, 201, describe(draft))
})

test('step 4d: a buyer cancels a draft PO; cancelling an approved PO needs a manager and no open receipt', async () => {
  const draftId = 'PO-FLOW-CANCEL-DRAFT'
  await seedPurchaseOrder(draftId, { status: 'draft' })
  const cancelled = await api(tokens.buyerA, 'POST', `/api/procurement/orders/${draftId}/cancel`, { expectedVersion: 0 })
  assert.equal(cancelled.status, 200, describe(cancelled))
  assert.equal((await poRow(draftId)).status, 'cancelled')

  const approvedId = 'PO-FLOW-CANCEL-APPROVED'
  await seedPurchaseOrder(approvedId, { status: 'approved' })
  const buyerCancel = await api(tokens.buyerA, 'POST', `/api/procurement/orders/${approvedId}/cancel`, { expectedVersion: 0 })
  assert.equal(buyerCancel.status, 403, describe(buyerCancel))
  const draft = await api(tokens.managerA, 'POST', '/api/mobile/receiving/drafts', { idempotencyKey: key('cancel-draft'), poId: approvedId, warehouseId: warehouseA, lines: [{ purchaseOrderLineId: `${approvedId}-L1`, acceptedQuantity: '1' }] })
  assert.equal(draft.status, 201, describe(draft))
  const blocked = await api(tokens.managerA, 'POST', `/api/procurement/orders/${approvedId}/cancel`, { expectedVersion: 0 })
  assert.equal(blocked.status, 409, describe(blocked))
  assert.equal(blocked.body.code, 'PURCHASE_ORDER_HAS_OPEN_RECEIPTS')
  await prisma.receivingDocument.update({ where: { id: draft.body.entityId }, data: { workflowStatus: 'cancelled' } })
  const managerCancel = await api(tokens.managerA, 'POST', `/api/procurement/orders/${approvedId}/cancel`, { expectedVersion: 0 })
  assert.equal(managerCancel.status, 200, describe(managerCancel))
  const row = await poRow(approvedId)
  assert.equal(row.status, 'cancelled')
  assert.equal(row.version, 1)
  assert.equal(await audits('PurchaseOrder', approvedId), 1, 'refused commands leave no audit row')
})

test('step 5a: a desktop user receives an issued PO and posts it with mobile operations off (/api/procurement/receiving)', async () => {
  process.env.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS = 'false'
  try {
    const id = 'PO-FLOW-DESKTOP-GRN'
    const lineId = `${id}-L1`
    await seedPurchaseOrder(id, { status: 'issued', item: itemB })
    const mobile = await api(tokens.managerA, 'POST', '/api/mobile/receiving/drafts', {})
    assert.equal(mobile.body.code, 'MOBILE_OPERATIONS_CAPABILITY_NOT_AVAILABLE')
    const receipts = () => prisma.receivingDocument.findMany({ where: { tenantId: tenantA, poId: id }, include: { lines: true }, orderBy: { createdAt: 'asc' } })

    // The receipt form reads the open quantities and the warehouses the user may receive into.
    const form = await api(tokens.managerA, 'GET', `/api/procurement/purchase-orders/${id}/receivable-lines`)
    assert.equal(form.status, 200, describe(form))
    assert.equal(form.body.purchaseOrder.receivable, true)
    assert.equal(form.body.purchaseOrder.currency, 'USD')
    assert.deepEqual(form.body.purchaseOrder.lines.map((line) => [line.id, line.remainingQuantity]), [[lineId, '10.0000']])
    assert.deepEqual(form.body.warehouses.map((warehouse) => warehouse.id), [warehouseA])
    assert.equal((await api(tokens.managerB, 'GET', `/api/procurement/purchase-orders/${id}/receivable-lines`)).status, 404)

    const line = (overrides = {}) => ({ purchaseOrderLineId: lineId, acceptedQuantity: '3', rejectedQuantity: '1', rejectionReason: 'Crushed carton', location: 'D-01', ...overrides })
    const createBody = { idempotencyKey: key('desk-create'), poId: id, warehouseId: warehouseA, arrivedAt: '2026-09-28T14:30:00.000Z', lines: [line()] }
    const refused = [
      [tokens.buyerA, { ...createBody, idempotencyKey: key('desk-buyer') }, 403, 'AUTHORIZATION_PERMISSION_DENIED'],
      [tokens.managerA, { ...createBody, idempotencyKey: key('desk-over'), lines: [line({ acceptedQuantity: '11' })] }, 409, 'RECEIVING_OVER_RECEIPT'],
      [tokens.managerA, { ...createBody, idempotencyKey: key('desk-reason'), lines: [line({ rejectionReason: '' })] }, 422, 'RECEIVING_REJECTION_REASON_REQUIRED'],
      [tokens.managerA, { ...createBody, idempotencyKey: key('desk-warehouse'), warehouseId: '' }, 422, 'RECEIVING_WAREHOUSE_REQUIRED'],
      [tokens.managerA, { ...createBody, idempotencyKey: '' }, 422, 'IDEMPOTENCY_KEY_REQUIRED'],
      [tokens.managerB, { ...createBody, idempotencyKey: key('desk-foreign'), warehouseId: 'flow-wh-b' }, 404, 'PURCHASE_ORDER_NOT_FOUND'],
    ]
    for (const [token, body, status, code] of refused) {
      const result = await api(token, 'POST', '/api/procurement/receiving', body)
      assert.equal(result.status, status, describe(result))
      assert.equal(result.body.code, code)
    }
    assert.equal((await receipts()).length, 0, 'refused commands write no receipt')

    const created = await api(tokens.managerA, 'POST', '/api/procurement/receiving', createBody)
    assert.equal(created.status, 201, describe(created))
    const grnId = created.body.entityId
    let [grn] = await receipts()
    assert.equal(grn.id, grnId)
    assert.equal(grn.workflowStatus, 'draft')
    assert.equal(grn.postingStatus, 'unposted')
    assert.equal(grn.version, 0)
    assert.equal(grn.warehouseId, warehouseA)
    assert.equal(grn.arrivedAt.toISOString(), '2026-09-28T14:30:00.000Z')
    assert.equal(grn.currency, 'USD')
    assert.equal(grn.receiver, managerA.name)
    assert.deepEqual(grn.lines.map((row) => [row.purchaseOrderLineId, dec(row.acceptedQty), dec(row.rejectedQty), row.location, row.metadata.rejectionReason]), [[lineId, '3', '1', 'D-01', 'Crushed carton']])
    assert.equal(await audits('ReceivingDocument', grnId), 1)
    const replay = await api(tokens.managerA, 'POST', '/api/procurement/receiving', createBody)
    assert.equal(replay.body.entityId, grnId)
    assert.equal(replay.body.idempotentReplay, true)
    assert.equal((await receipts()).length, 1)
    const reused = await api(tokens.managerA, 'POST', '/api/procurement/receiving', { ...createBody, warehouseId: warehouseA, note: 'changed' })
    assert.equal(reused.status, 409, describe(reused))
    assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')

    // The desktop receiving lists read PostgreSQL for the signed-in tenant.
    const listed = await api(tokens.managerA, 'GET', '/api/procurement/receiving')
    assert.equal(listed.status, 200, describe(listed))
    const listedGrn = listed.body.items.find((row) => row.id === grnId)
    assert.deepEqual([listedGrn?.poId, listedGrn?.workflowStatus, listedGrn?.acceptedQuantity, listedGrn?.rejectedQuantity, listedGrn?.warehouse?.code], [id, 'draft', '3.0000', '1.0000', 'FLOW-A'])
    assert.ok((await api(tokens.managerA, 'GET', '/api/receiving-docs')).body.some((row) => row.grn === grnId))
    assert.ok(!(await api(tokens.managerB, 'GET', '/api/procurement/receiving')).body.items.some((row) => row.id === grnId))
    assert.ok(!(await api(tokens.managerB, 'GET', '/api/receiving-docs')).body.some((row) => row.grn === grnId))

    // Revise the draft at the version it was loaded with.
    const reviseBody = { idempotencyKey: key('desk-revise'), expectedVersion: 0, warehouseId: warehouseA, lines: [line({ acceptedQuantity: '4' })] }
    assert.equal((await api(tokens.managerB, 'PATCH', `/api/procurement/receiving/${grnId}`, reviseBody)).status, 404)
    const overRevise = await api(tokens.managerA, 'PATCH', `/api/procurement/receiving/${grnId}`, { ...reviseBody, idempotencyKey: key('desk-revise-over'), lines: [line({ acceptedQuantity: '10.0001' })] })
    assert.equal(overRevise.status, 409, describe(overRevise))
    assert.equal(overRevise.body.code, 'RECEIVING_OVER_RECEIPT')
    const revised = await api(tokens.managerA, 'PATCH', `/api/procurement/receiving/${grnId}`, reviseBody)
    assert.equal(revised.status, 200, describe(revised))
    assert.equal(revised.body.receivingDocument.version, 1)
    const revisedReplay = await api(tokens.managerA, 'PATCH', `/api/procurement/receiving/${grnId}`, reviseBody)
    assert.equal(revisedReplay.body.idempotentReplay, true)
    const staleRevise = await api(tokens.managerA, 'PATCH', `/api/procurement/receiving/${grnId}`, { ...reviseBody, idempotencyKey: key('desk-revise-stale'), lines: [line({ acceptedQuantity: '2' })] })
    assert.equal(staleRevise.status, 409, describe(staleRevise))
    assert.equal(staleRevise.body.code, 'SYNC_VERSION_CONFLICT')
    ;[grn] = await receipts()
    assert.equal(grn.version, 1)
    assert.equal(dec(grn.lines[0].acceptedQty), '4')
    assert.equal(await audits('ReceivingDocument', grnId), 2)

    // Submit, then post.
    const staleSubmit = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${grnId}/submit`, { expectedVersion: 0 })
    assert.equal(staleSubmit.status, 409, describe(staleSubmit))
    assert.equal(staleSubmit.body.code, 'SYNC_VERSION_CONFLICT')
    const submitted = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${grnId}/submit`, { expectedVersion: 1 })
    assert.equal(submitted.status, 200, describe(submitted))
    assert.equal(submitted.body.receivingDocument.workflowStatus, 'ready_for_receiving')
    assert.equal((await api(tokens.managerA, 'POST', `/api/procurement/receiving/${grnId}/submit`, { expectedVersion: 1 })).body.idempotentReplay, true)
    const lateRevise = await api(tokens.managerA, 'PATCH', `/api/procurement/receiving/${grnId}`, { ...reviseBody, idempotencyKey: key('desk-revise-late'), expectedVersion: 2 })
    assert.equal(lateRevise.status, 409, describe(lateRevise))
    assert.equal(lateRevise.body.code, 'RECEIVING_IMMUTABLE')
    assert.equal(await audits('ReceivingDocument', grnId), 3)

    const detail = await api(tokens.managerA, 'GET', `/api/procurement/receiving/${grnId}`)
    assert.equal(detail.body.availableActions.canPost, true, JSON.stringify(detail.body.availableActions))
    const postKey = key('desk-post')
    const stalePost = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${grnId}/post`, { idempotencyKey: key('desk-post-stale'), expectedVersion: 1 })
    assert.equal(stalePost.status, 409, describe(stalePost))
    assert.equal((await api(tokens.managerB, 'POST', `/api/procurement/receiving/${grnId}/post`, { idempotencyKey: key('desk-post-foreign'), expectedVersion: 2 })).status, 404)
    const posted = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${grnId}/post`, { idempotencyKey: postKey, expectedVersion: 2 })
    assert.equal(posted.status, 200, describe(posted))
    assert.equal((await api(tokens.managerA, 'POST', `/api/procurement/receiving/${grnId}/post`, { idempotencyKey: postKey, expectedVersion: 2 })).body.idempotentReplay, true)
    let po = await poRow(id)
    assert.equal(dec(po.lines[0].receivedQuantity), '4')
    assert.equal(po.status, 'partially_received')
    const movements = await prisma.inventoryMovement.findMany({ where: { tenantId: tenantA, relatedGrnId: grnId } })
    assert.deepEqual(movements.map((row) => [row.movementType, row.sku, row.warehouseId, row.locationKey, dec(row.quantityIn)]), [['receipt_posting', itemB.sku, warehouseA, 'd-01', '4']])
    const balance = () => prisma.inventoryBalance.findFirst({ where: { tenantId: tenantA, sku: itemB.sku, warehouseId: warehouseA, locationKey: 'd-01' } })
    assert.equal(dec((await balance()).onHandQuantity), '4', 'rejected quantity stays out of stock')
    assert.equal(await audits('ReceivingDocument', grnId), 4, 'one audit row each for create, revise, submit and post')

    // A second receipt against the partially received PO closes it.
    const second = { idempotencyKey: key('desk-second'), poId: id, warehouseId: warehouseA, lines: [line({ acceptedQuantity: '6', rejectedQuantity: '0', rejectionReason: '' })] }
    const overSecond = await api(tokens.managerA, 'POST', '/api/procurement/receiving', { ...second, idempotencyKey: key('desk-second-over'), lines: [line({ acceptedQuantity: '7', rejectedQuantity: '0' })] })
    assert.equal(overSecond.status, 409, describe(overSecond))
    assert.equal(overSecond.body.code, 'RECEIVING_OVER_RECEIPT')
    assert.equal(overSecond.body.details.remainingQuantity, '6.0000')
    const secondDraft = await api(tokens.managerA, 'POST', '/api/procurement/receiving', second)
    assert.equal(secondDraft.status, 201, describe(secondDraft))
    const secondId = secondDraft.body.entityId
    const secondSubmit = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${secondId}/submit`, { expectedVersion: 0, idempotencyKey: key('desk-second-submit') })
    assert.equal(secondSubmit.status, 200, describe(secondSubmit))
    const secondPost = await api(tokens.managerA, 'POST', `/api/procurement/receiving/${secondId}/post`, { expectedVersion: secondSubmit.body.receivingDocument.version, idempotencyKey: key('desk-second-post') })
    assert.equal(secondPost.status, 200, describe(secondPost))
    po = await poRow(id)
    assert.equal(dec(po.lines[0].receivedQuantity), '10')
    assert.equal(po.status, 'fully_received')
    assert.equal(dec((await balance()).onHandQuantity), '10')
    assert.equal(await audits('ReceivingDocument', secondId), 3)
    const closed = await api(tokens.managerA, 'POST', '/api/procurement/receiving', { ...second, idempotencyKey: key('desk-closed'), lines: [line({ acceptedQuantity: '1', rejectedQuantity: '0' })] })
    assert.equal(closed.status, 409, describe(closed))
    assert.equal(closed.body.code, 'RECEIVING_PURCHASE_ORDER_NOT_RECEIVABLE')
    assert.equal(await prisma.receivingDocument.count({ where: { tenantId: tenantB } }), 0)
    assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: tenantB } }), 0)

    // Receiving posting is the only switch the desktop path needs.
    process.env.FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING = 'false'
    try {
      const off = await api(tokens.managerA, 'POST', '/api/procurement/receiving', { ...second, idempotencyKey: key('desk-off') })
      assert.equal(off.status, 409, describe(off))
      assert.equal(off.body.code, 'CAPABILITY_NOT_AVAILABLE')
    } finally {
      process.env.FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING = 'true'
    }
  } finally {
    process.env.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS = 'true'
  }
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
  assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantA, entityType: 'ReceivingDocument', entityId: { in: [postedGrnId, restId] }, action: 'receiving_posted' } }), 2)
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
