import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// The supplier on a purchase request line, through the real HTTP server and
// the endpoints the purchase request panel calls:
//   - a line that skips the item's preferred supplier needs a reason; the
//     reason is kept in the line metadata, written to the audit row, read
//     back with the request, carried onto the PO line and read with the PO;
//   - GET /api/procurement/item-supplier-orders lists the last issued PO of
//     an item with each supplier (the order a person chooses from when none
//     is preferred), dated in the workspace timezone, for one workspace only.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/supplier-choice.test.mjs

const tenantA = 'tenant-supplier-choice-a'
const tenantB = 'tenant-supplier-choice-b'
const managerA = { id: 'choice-manager-a', email: 'manager-a@supplier-choice.invalid', name: 'Avery Manager', role: 'manager' }
const managerB = { id: 'choice-manager-b', email: 'manager-b@supplier-choice.invalid', name: 'Casey Other', role: 'manager' }
const warehouseA = 'choice-wh-a'
const acme = { id: 'choice-acme', code: 'SUP-ACME', name: 'Acme Supply' }
const bolt = { id: 'choice-bolt', code: 'SUP-BOLT', name: 'Bolt Parts' }
const crane = { id: 'choice-crane', code: 'SUP-CRANE', name: 'Crane Trading' }
// Preferred supplier Acme; Bolt also approved.
const wrap = { id: 'choice-item-wrap', sku: 'CHOICE-WRAP', name: 'Pallet wrap' }
// Bolt and Crane approved, none preferred.
const tape = { id: 'choice-item-tape', sku: 'CHOICE-TAPE', name: 'Carton tape' }
const needBy = '2026-10-20'

let prisma
let server
let base
const tokens = {}
const key = (label) => `${label}-${randomUUID()}`

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

async function login(user, tenantId) {
  const previous = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
  try {
    const result = await api(null, 'POST', '/api/auth/login', { email: user.email, name: user.name, company: 'Supplier Choice' })
    assert.equal(result.status, 200, describe(result))
    return result.body.token
  } finally {
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previous
  }
}

// The line shape the purchase request panel submits.
const prLine = (overrides = {}) => ({
  lineId: key('pr-line'), sourceType: 'catalog_item', lineBasis: 'quantity',
  itemId: wrap.id, sku: wrap.sku, itemNameSnapshot: wrap.name, unitSnapshot: 'EA',
  supplierId: bolt.id, quantity: 10, estimatedUnitPrice: 2.5, estimatedAmount: 25,
  currency: 'USD', targetWarehouseId: warehouseA, needByDate: needBy, ...overrides,
})
const prBody = (line) => ({ departmentId: 'operations', defaultCurrency: 'USD', defaultNeedByDate: needBy, lines: [prLine(line)] })

test.before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run through scripts/run-postgres-test-files.mjs against its disposable server.')
  Object.assign(process.env, {
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantA,
    FLOWCHAIN_LOCAL_SESSION_SECRET: `supplier-choice-${randomUUID()}`,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: 'false',
    FLOWCHAIN_COMMIT_SHA: 'supplier-choice',
    FLOWCHAIN_BRANCH: 'test/supplier-choice',
  })
  prisma = await createPrismaClient(process.env)
  await prisma.tenant.create({ data: { id: tenantA, name: 'Supplier Choice A', timezone: 'America/New_York' } })
  await prisma.tenant.create({ data: { id: tenantB, name: 'Supplier Choice B' } })
  await prisma.user.create({ data: { ...managerA, tenantId: tenantA } })
  await prisma.user.create({ data: { ...managerB, tenantId: tenantB } })
  await backfillTenantAuthorization(prisma, tenantA, { actorId: managerA.id })
  await backfillTenantAuthorization(prisma, tenantB, { actorId: managerB.id })
  await prisma.warehouse.create({ data: { id: warehouseA, tenantId: tenantA, code: 'CHOICE-A', name: 'Choice Warehouse A', status: 'active' } })
  await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: tenantA, userId: managerA.id, warehouseId: warehouseA, accessLevel: 'operate' } })
  for (const supplier of [acme, bolt, crane]) await prisma.supplier.create({ data: { ...supplier, tenantId: tenantA, status: 'active' } })
  for (const item of [wrap, tape]) await prisma.item.create({ data: { ...item, tenantId: tenantA, unit: 'EA', metadata: { defaultWarehouseId: warehouseA, purchasable: true } } })

  const { createScmServer } = await import('../../server/scm-api.mjs')
  server = createScmServer({ errorLogger: { error: () => {} } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  tokens.managerA = await login(managerA, tenantA)
  tokens.managerB = await login(managerB, tenantB)

  // The approved sources, saved as the item page saves them.
  for (const [item, supplierId, preferred] of [[wrap, acme.id, true], [wrap, bolt.id, false], [tape, bolt.id, false], [tape, crane.id, false]]) {
    const link = await api(tokens.managerA, 'POST', `/api/master-data/items/${item.id}/suppliers`, { supplierId, preferred, currency: 'USD' })
    assert.ok([200, 201].includes(link.status), describe(link))
  }
})

test.after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await prisma?.$disconnect()
})

test('a line that skips the preferred supplier is refused without a reason, and nothing is saved', async () => {
  const sources = await api(tokens.managerA, 'GET', `/api/master-data/items/${wrap.id}/suppliers`)
  assert.deepEqual(sources.body.suppliers.map((row) => [row.id, row.preferred]), [[acme.id, true], [bolt.id, false]])
  const missing = await api(tokens.managerA, 'POST', '/api/procurement/requests', prBody())
  assert.equal(missing.status, 400, describe(missing))
  assert.equal(missing.body.code, 'SUPPLIER_OVERRIDE_REASON_REQUIRED')
  assert.match(missing.body.message, /Acme Supply/)
  assert.deepEqual(missing.body.details.map((row) => [row.field, row.code]), [['lines.0.supplierOverride.reasonCode', 'REASON_REQUIRED']])
  const noNote = await api(tokens.managerA, 'POST', '/api/procurement/requests', prBody({ supplierOverride: { reasonCode: 'other' } }))
  assert.equal(noNote.status, 400, describe(noNote))
  assert.deepEqual(noNote.body.details.map((row) => [row.field, row.code]), [['lines.0.supplierOverride.note', 'NOTE_LENGTH']])
  assert.equal(await prisma.purchaseRequest.count({ where: { tenantId: tenantA } }), 0)
})

test('the preferred supplier, or an item with none preferred, needs no reason and stores none', async () => {
  const preferred = await api(tokens.managerA, 'POST', '/api/procurement/requests', prBody({ supplierId: acme.id, supplierOverride: { reasonCode: 'price' } }))
  assert.equal(preferred.status, 201, describe(preferred))
  assert.equal(preferred.body.lines[0].supplierOverride, null)
  const open = await api(tokens.managerA, 'POST', '/api/procurement/requests', prBody({ itemId: tape.id, sku: tape.sku, itemNameSnapshot: tape.name, supplierId: crane.id }))
  assert.equal(open.status, 201, describe(open))
  const lines = await prisma.purchaseRequestLine.findMany({ where: { purchaseRequestId: { in: [preferred.body.id, open.body.id] } } })
  assert.ok(lines.every((line) => !('supplierOverride' in (line.metadata || {}))))
  const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: open.body.id, action: 'purchase_request_created' } })
  assert.equal(audit.metadata.supplierOverrides, undefined)
})

// The item form's default supplier and a link flagged preferred can name two
// suppliers; either is preferred, so neither needs a reason.
test('when the default supplier and a flagged link differ, both count as preferred', async () => {
  const strap = { id: 'choice-item-strap', sku: 'CHOICE-STRAP', name: 'Strapping' }
  await prisma.item.create({ data: { ...strap, tenantId: tenantA, unit: 'EA', metadata: { defaultWarehouseId: warehouseA, purchasable: true } } })
  for (const [supplierId, preferred] of [[bolt.id, true], [acme.id, false]]) {
    const link = await api(tokens.managerA, 'POST', `/api/master-data/items/${strap.id}/suppliers`, { supplierId, preferred, currency: 'USD' })
    assert.ok([200, 201].includes(link.status), describe(link))
  }
  // The item form then sets Default supplier = Acme; Bolt's link keeps its flag.
  await prisma.item.update({ where: { id: strap.id }, data: { preferredSupplierId: acme.id } })
  const sources = await api(tokens.managerA, 'GET', `/api/master-data/items/${strap.id}/suppliers`)
  assert.deepEqual(sources.body.suppliers.map((row) => row.preferred), [true, true])
  for (const supplierId of [acme.id, bolt.id]) {
    const created = await api(tokens.managerA, 'POST', '/api/procurement/requests', prBody({ itemId: strap.id, sku: strap.sku, itemNameSnapshot: strap.name, supplierId }))
    assert.equal(created.status, 201, describe(created))
    assert.equal(created.body.lines[0].supplierOverride, null)
  }
})

test('a reason is stored with the line, audited, read back, carried onto the PO line and read with the PO', async () => {
  const created = await api(tokens.managerA, 'POST', '/api/procurement/requests', prBody({ supplierOverride: { reasonCode: 'lead_time', note: 'Acme is out until November', preferredSupplierName: 'not trusted' } }))
  assert.equal(created.status, 201, describe(created))
  const id = created.body.id
  const stored = { reasonCode: 'lead_time', note: 'Acme is out until November', preferredSupplierId: acme.id, preferredSupplierIds: [acme.id], preferredSupplierName: 'Acme Supply' }
  const [line] = await prisma.purchaseRequestLine.findMany({ where: { purchaseRequestId: id } })
  assert.deepEqual(line.metadata.supplierOverride, stored)
  const createdAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: id, action: 'purchase_request_created' } })
  assert.deepEqual(createdAudit.metadata.supplierOverrides, [{ clientLineId: line.metadata.clientLineId, itemId: wrap.id, supplierId: bolt.id, preferredSupplierId: acme.id, reasonCode: 'lead_time', note: 'Acme is out until November' }])

  // An edit with another reason replaces it and is audited too.
  const edited = await api(tokens.managerA, 'PATCH', `/api/procurement/requests/${id}`, { ...prBody({ supplierOverride: { reasonCode: 'other', note: 'Customer sample approved' } }), expectedVersion: 1 })
  assert.equal(edited.status, 200, describe(edited))
  const updatedAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: id, action: 'purchase_request_updated' } })
  assert.deepEqual(updatedAudit.metadata.supplierOverrides.map((row) => [row.reasonCode, row.note]), [['other', 'Customer sample approved']])
  const reason = { ...stored, reasonCode: 'other', note: 'Customer sample approved' }

  const read = await api(tokens.managerA, 'GET', `/api/procurement/requests/${id}`)
  assert.equal(read.status, 200, describe(read))
  assert.deepEqual(read.body.lines[0].supplierOverride, reason)
  const listed = await api(tokens.managerA, 'GET', '/api/procurement/requests')
  assert.deepEqual(listed.body.find((row) => row.id === id).lines[0].supplierOverride, reason)

  for (const [action, expectedVersion] of [['submit', 2], ['approve', 3]]) {
    const result = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/${action}`, { expectedVersion })
    assert.equal(result.status, 200, `${action}: ${describe(result)}`)
  }
  const converted = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 4 })
  assert.equal(converted.status, 201, describe(converted))
  const poId = converted.body.createdPurchaseOrders[0].id
  const [poLine] = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: poId } })
  assert.deepEqual(poLine.metadata.supplierOverride, reason)
  const convertedAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: id, action: 'purchase_request_converted_to_purchase_orders' } })
  assert.deepEqual(convertedAudit.metadata.supplierOverrides.map((row) => [row.purchaseOrderId, row.supplierId, row.preferredSupplierId, row.reasonCode]), [[poId, bolt.id, acme.id, 'other']])

  const order = await api(tokens.managerA, 'GET', `/api/procurement/orders/${poId}`)
  assert.equal(order.status, 200, describe(order))
  assert.deepEqual(order.body.lines[0].supplierOverride, reason)
  const orders = await api(tokens.managerA, 'GET', '/api/procurement/orders')
  assert.deepEqual(orders.body.find((row) => (row.po || row.id) === poId).lines[0].supplierOverride, reason)
  // Another workspace reads none of it.
  assert.equal((await api(tokens.managerB, 'GET', `/api/procurement/requests/${id}`)).status, 404)
})

// A draft saved before the item had a preferred supplier (or before reasons
// were asked) is never refused: submitting marks the line "no reason
// recorded" for the approver and the audit row, and the PO made from it
// carries the mark, even when the request was approved without one.
test('a draft saved before the item had a preferred supplier is submitted unblocked and marked for the approver', async () => {
  const glue = { id: 'choice-item-glue', sku: 'CHOICE-GLUE', name: 'Hot-melt glue' }
  await prisma.item.create({ data: { ...glue, tenantId: tenantA, unit: 'EA', metadata: { defaultWarehouseId: warehouseA, purchasable: true } } })
  for (const supplierId of [bolt.id, crane.id]) {
    const link = await api(tokens.managerA, 'POST', `/api/master-data/items/${glue.id}/suppliers`, { supplierId, preferred: false, currency: 'USD' })
    assert.ok([200, 201].includes(link.status), describe(link))
  }
  const created = await api(tokens.managerA, 'POST', '/api/procurement/requests', prBody({ itemId: glue.id, sku: glue.sku, itemNameSnapshot: glue.name, supplierId: bolt.id }))
  assert.equal(created.status, 201, describe(created))
  const id = created.body.id
  assert.equal(created.body.lines[0].supplierOverride, null)
  // Crane becomes the item's default supplier after the draft was saved.
  await prisma.item.update({ where: { id: glue.id }, data: { preferredSupplierId: crane.id } })

  const submitted = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/submit`, { expectedVersion: 1 })
  assert.equal(submitted.status, 200, describe(submitted))
  const mark = { reasonCode: null, note: null, missingReason: true, preferredSupplierId: crane.id, preferredSupplierIds: [crane.id], preferredSupplierName: 'Crane Trading' }
  assert.deepEqual(submitted.body.lines[0].supplierOverride, mark)
  const [line] = await prisma.purchaseRequestLine.findMany({ where: { purchaseRequestId: id } })
  assert.deepEqual(line.metadata.supplierOverride, mark)
  const submitAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: id, action: 'purchase_request_submit' } })
  assert.deepEqual(submitAudit.metadata.supplierOverridesMissing, [{ clientLineId: line.metadata.clientLineId, itemId: glue.id, supplierId: bolt.id, preferredSupplierId: crane.id, reasonCode: null, note: null, missingReason: true }])
  const listed = await api(tokens.managerA, 'GET', '/api/procurement/requests')
  assert.deepEqual(listed.body.find((row) => row.id === id).lines[0].supplierOverride, mark)

  const approved = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/approve`, { expectedVersion: 2 })
  assert.equal(approved.status, 200, describe(approved))
  // As if the request had been submitted and approved before reasons were asked.
  const { supplierOverride: _mark, ...unmarked } = line.metadata
  await prisma.purchaseRequestLine.update({ where: { id: line.id }, data: { metadata: unmarked } })
  const converted = await api(tokens.managerA, 'POST', `/api/procurement/requests/${id}/generate-purchase-orders`, { expectedVersion: 3 })
  assert.equal(converted.status, 201, describe(converted))
  const poId = converted.body.createdPurchaseOrders[0].id
  const [poLine] = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: poId } })
  assert.deepEqual(poLine.metadata.supplierOverride, mark)
  const convertedAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: id, action: 'purchase_request_converted_to_purchase_orders' } })
  assert.deepEqual(convertedAudit.metadata.supplierOverrides.map((row) => [row.purchaseOrderId, row.supplierId, row.preferredSupplierId, row.reasonCode, row.missingReason]), [[poId, bolt.id, crane.id, null, true]])
  const order = await api(tokens.managerA, 'GET', `/api/procurement/orders/${poId}`)
  assert.deepEqual(order.body.lines[0].supplierOverride, mark)
})

async function po(id, { tenantId = tenantA, supplier, status = 'issued', issuedAt = null, createdAt, item = tape }) {
  await prisma.purchaseOrder.create({ data: {
    id, tenantId, status, supplierId: supplier.id, supplierName: supplier.name, currency: 'USD', amount: '10', version: 0,
    issuedAt: issuedAt ? new Date(issuedAt) : null, createdAt: new Date(createdAt), metadata: { orderNumber: id },
    lines: { create: [{ id: `${id}-L1`, itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: '1', receivedQuantity: '0', unit: 'EA', unitPrice: '10', amount: '10' }] },
  } })
}

test("each supplier's last issued PO of an item is read for one workspace, dated in its timezone", async () => {
  // Bolt: two issued POs; the later one counts. 02:00 UTC is the evening before in New York.
  await po('CH-PO-BOLT-1', { supplier: bolt, issuedAt: '2026-08-02T15:00:00Z', createdAt: '2026-08-01T15:00:00Z' })
  await po('CH-PO-BOLT-2', { supplier: bolt, issuedAt: '2026-09-15T02:00:00Z', createdAt: '2026-09-10T15:00:00Z' })
  // Crane: received with no issue date recorded, so the order date stands in.
  await po('CH-PO-CRANE-1', { supplier: crane, status: 'fully_received', createdAt: '2026-07-20T15:00:00Z' })
  // A draft and another item never count.
  await po('CH-PO-CRANE-DRAFT', { supplier: crane, status: 'draft', createdAt: '2026-10-01T15:00:00Z' })
  await po('CH-PO-ACME-WRAP', { supplier: acme, issuedAt: '2026-09-20T15:00:00Z', createdAt: '2026-09-20T15:00:00Z', item: wrap })
  // Another workspace's PO of the same item id stays in that workspace.
  await prisma.supplier.create({ data: { id: 'choice-other-supplier', tenantId: tenantB, code: 'SUP-OTHER', name: 'Other Workspace Co.', status: 'active' } })
  await po('CH-PO-OTHER', { tenantId: tenantB, supplier: { id: 'choice-other-supplier', name: 'Other Workspace Co.' }, issuedAt: '2026-10-02T15:00:00Z', createdAt: '2026-10-02T15:00:00Z' })

  const read = await api(tokens.managerA, 'GET', `/api/procurement/item-supplier-orders?itemId=${tape.id}`)
  assert.equal(read.status, 200, describe(read))
  assert.equal(read.body.timeZone, 'America/New_York')
  assert.deepEqual(read.body.lastOrders, [
    { supplierId: bolt.id, purchaseOrderId: 'CH-PO-BOLT-2', orderNumber: 'CH-PO-BOLT-2', day: '2026-09-14', dateSource: 'issue_date' },
    { supplierId: crane.id, purchaseOrderId: 'CH-PO-CRANE-1', orderNumber: 'CH-PO-CRANE-1', day: '2026-07-20', dateSource: 'order_date' },
  ])
  assert.doesNotMatch(JSON.stringify(read.body), /unitPrice|amount/i)
  const other = await api(tokens.managerB, 'GET', `/api/procurement/item-supplier-orders?itemId=${tape.id}`)
  assert.equal(other.status, 200, describe(other))
  assert.deepEqual(other.body.lastOrders.map((row) => row.purchaseOrderId), ['CH-PO-OTHER'])
  const missing = await api(tokens.managerA, 'GET', '/api/procurement/item-supplier-orders')
  assert.equal(missing.status, 422, describe(missing))
})
