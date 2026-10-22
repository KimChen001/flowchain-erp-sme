import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { setWarehouseStatus } from '../../server/domain/warehouse-master-commands.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// A workspace administrator adds warehouses and bins, renames them and sets
// them inactive, only where they have operate access, never into another
// workspace, and never while stock or open work still depends on them.
const tenantA = 'tenant-warehouse-writes-a'
const tenantB = 'tenant-warehouse-writes-b'
const hasChinese = (value) => /[㐀-鿿]/.test(String(value))

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}`, currency: 'USD' } })
  await prisma.warehouse.create({ data: { id: `WH-MAIN-${tag}`, tenantId, code: 'MAIN', name: `Main ${tag}` } })
  // Legacy roles; the first request backfills each into its default role:
  // admin is Workspace Administrator, manager is Operations Manager.
  for (const [key, role] of [['admin', 'admin'], ['manager', 'manager'], ['viewer', 'viewer'], ['member', 'business-specialist']]) {
    await prisma.user.create({ data: { id: `${tenantId}-${key}`, tenantId, email: `${key}-${tag.toLowerCase()}@warehouses.example.com`, name: `${key} ${tag}`, role } })
  }
  for (const key of ['admin', 'manager']) {
    await prisma.userWarehouseScope.create({ data: { id: `${tenantId}-${key}-main`, tenantId, userId: `${tenantId}-${key}`, warehouseId: `WH-MAIN-${tag}`, accessLevel: 'operate' } })
  }
}

async function request(port, method, path, { headers = {}, body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = text
        try { payload = JSON.parse(text) } catch { /* keep text */ }
        resolve({ status: res.statusCode, payload })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

test('warehouses and bins are created, renamed and set inactive in PostgreSQL', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previousTenant = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await seedTenant(prisma, tenantA, 'A')
    await seedTenant(prisma, tenantB, 'B')
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantA
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    // Sign-in resolves the configured workspace; the session keeps it.
    const signIn = async (tenantId, email) => {
      process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
      const login = await request(port, 'POST', '/api/auth/login', { body: { email, name: 'Ignored', company: 'Ignored' } })
      assert.equal(login.status, 200, JSON.stringify(login.payload))
      assert.equal(login.payload.user.tenantId, tenantId)
      const headers = { Authorization: `Bearer ${login.payload.token}` }
      return (method, path, body) => request(port, method, path, { headers, body })
    }
    const asAdmin = await signIn(tenantA, 'admin-a@warehouses.example.com')
    const asManager = await signIn(tenantA, 'manager-a@warehouses.example.com')
    const asViewer = await signIn(tenantA, 'viewer-a@warehouses.example.com')
    const asAdminB = await signIn(tenantB, 'admin-b@warehouses.example.com')
    const auditCount = () => prisma.auditLog.count({ where: { tenantId: tenantA, source: 'master-data', entityType: { in: ['warehouse', 'warehouse_bin'] } } })

    // Create: the code is upper-cased, the creator gets operate access.
    const created = await asAdmin('POST', '/api/master-data/warehouses', { code: 'north-1', name: 'North Depot' })
    assert.equal(created.status, 201, JSON.stringify(created.payload))
    const north = created.payload.warehouse
    assert.deepEqual([north.code, north.name, north.status, north.version], ['NORTH-1', 'North Depot', 'active', 1])
    assert.match(north.id, /^WH-/)
    const scope = await prisma.userWarehouseScope.findFirst({ where: { tenantId: tenantA, userId: `${tenantA}-admin`, warehouseId: north.id } })
    assert.equal(scope?.accessLevel, 'operate')
    assert.equal(await auditCount(), 1)

    // Duplicate codes, invalid codes and a missing name are refused in English.
    const duplicate = await asAdmin('POST', '/api/master-data/warehouses', { code: 'NORTH-1', name: 'Again' })
    assert.deepEqual([duplicate.status, duplicate.payload.code, duplicate.payload.details[0].field], [409, 'DUPLICATE_CODE', 'code'])
    const invalid = await asAdmin('POST', '/api/master-data/warehouses', { code: 'bad code', name: '' })
    assert.equal(invalid.status, 422)
    assert.deepEqual(invalid.payload.details.map((issue) => issue.code).sort(), ['CODE_INVALID', 'NAME_REQUIRED'])
    assert.equal(invalid.payload.details.some((issue) => hasChinese(issue.message)), false)
    // The same code in another workspace is a different warehouse.
    const elsewhere = await asAdminB('POST', '/api/master-data/warehouses', { code: 'NORTH-1', name: 'North B' })
    assert.equal(elsewhere.status, 201, JSON.stringify(elsewhere.payload))
    assert.equal(await auditCount(), 1)

    // Rename with the version; a stale version is refused; the code stays.
    const renamed = await asAdmin('PATCH', `/api/master-data/warehouses/${north.id}`, { name: 'North Depot 2', expectedVersion: 1 })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.payload))
    assert.deepEqual([renamed.payload.warehouse.name, renamed.payload.warehouse.version], ['North Depot 2', 2])
    const stale = await asAdmin('PATCH', `/api/master-data/warehouses/${north.id}`, { name: 'Lost update', expectedVersion: 1 })
    assert.deepEqual([stale.status, stale.payload.code], [409, 'VERSION_CONFLICT'])
    const recode = await asAdmin('PATCH', `/api/master-data/warehouses/${north.id}`, { code: 'SOUTH', name: 'North Depot 2', expectedVersion: 2 })
    assert.deepEqual([recode.status, recode.payload.details[0].code], [422, 'CODE_IMMUTABLE'])
    assert.equal(await auditCount(), 2)

    // Another workspace's warehouse cannot be seen or changed: no operate
    // access, so refused the same way as one that does not exist.
    for (const [method, path, body] of [
      ['PATCH', `/api/master-data/warehouses/${north.id}`, { name: 'Hijack', expectedVersion: 2 }],
      ['POST', `/api/master-data/warehouses/${north.id}/deactivate`, { expectedVersion: 2 }],
      ['POST', `/api/master-data/warehouses/${north.id}/bins`, { code: 'X-1' }],
      ['GET', `/api/master-data/warehouses/${north.id}/bins`],
      ['PATCH', '/api/master-data/warehouses/WH-DOES-NOT-EXIST', { name: 'Ghost', expectedVersion: 1 }],
    ]) {
      const refused = await asAdminB(method, path, body)
      assert.deepEqual([refused.status, refused.payload.code], [403, 'WAREHOUSE_SCOPE_DENIED'], `${method} ${path}`)
    }
    assert.equal((await asAdminB('GET', '/api/master-data/warehouses')).payload.warehouses.some((row) => row.id === north.id), false)
    assert.equal((await prisma.warehouse.findUnique({ where: { id: north.id } })).name, 'North Depot 2')

    // Operations Manager and Read-only Viewer change no warehouse, even the
    // manager who has operate access to MAIN.
    for (const [as, label] of [[asManager, 'manager'], [asViewer, 'viewer']]) {
      for (const [method, path, body] of [
        ['POST', '/api/master-data/warehouses', { code: 'NOPE', name: 'Nope' }],
        ['PATCH', '/api/master-data/warehouses/WH-MAIN-A', { name: 'Renamed', expectedVersion: 1 }],
        ['POST', '/api/master-data/warehouses/WH-MAIN-A/deactivate', { expectedVersion: 1 }],
        ['POST', '/api/master-data/warehouses/WH-MAIN-A/bins', { code: 'NOPE' }],
      ]) {
        const refused = await as(method, path, body)
        assert.deepEqual([refused.status, refused.payload.code, refused.payload.permission], [403, 'PERMISSION_DENIED', 'settings.workspace.manage'], `${label} ${method} ${path}`)
        assert.equal(hasChinese(refused.payload.message), false)
      }
    }
    assert.equal(await auditCount(), 2)

    // Bins: the location key is the code in lower case, as on stock rows.
    const bin = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/bins`, { code: 'Rack A-01', name: 'Front rack' })
    assert.equal(bin.status, 201, JSON.stringify(bin.payload))
    assert.deepEqual([bin.payload.bin.code, bin.payload.bin.locationKey, bin.payload.bin.status], ['Rack A-01', 'rack a-01', 'active'])
    const binDuplicate = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/bins`, { code: 'RACK A-01' })
    assert.deepEqual([binDuplicate.status, binDuplicate.payload.code], [409, 'DUPLICATE_BIN'])
    const binRenamed = await asAdmin('PATCH', `/api/master-data/warehouses/${north.id}/bins/${bin.payload.bin.id}`, { name: 'Rack by the door', expectedUpdatedAt: bin.payload.bin.updatedAt })
    assert.equal(binRenamed.status, 200, JSON.stringify(binRenamed.payload))
    const binStale = await asAdmin('PATCH', `/api/master-data/warehouses/${north.id}/bins/${bin.payload.bin.id}`, { name: 'Lost', expectedUpdatedAt: bin.payload.bin.updatedAt })
    assert.deepEqual([binStale.status, binStale.payload.code], [409, 'VERSION_CONFLICT'])
    // The viewer, with read access, lists the bins but cannot add one.
    await prisma.userWarehouseScope.create({ data: { id: `${tenantA}-viewer-north`, tenantId: tenantA, userId: `${tenantA}-viewer`, warehouseId: north.id, accessLevel: 'read' } })
    const listed = await asViewer('GET', `/api/master-data/warehouses/${north.id}/bins`)
    assert.deepEqual(listed.payload.bins.map((row) => [row.code, row.name]), [['Rack A-01', 'Rack by the door']])
    assert.equal(await auditCount(), 4)

    // A bin with stock cannot be set inactive; once empty it can.
    const balance = await prisma.inventoryBalance.create({ data: { id: 'BAL-NORTH-1', tenantId: tenantA, sku: 'SKU-1', warehouseId: north.id, warehouseKey: north.id, location: 'Rack A-01', locationKey: 'rack a-01', onHandQuantity: '5', availableQuantity: '5', reservedQuantity: '0' } })
    let current = (await asAdmin('GET', `/api/master-data/warehouses/${north.id}/bins`)).payload.bins[0]
    const binBusy = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/bins/${current.id}/deactivate`, { expectedUpdatedAt: current.updatedAt })
    assert.deepEqual([binBusy.status, binBusy.payload.code, binBusy.payload.details], [409, 'BIN_IN_USE', [{ code: 'INVENTORY_ON_HAND', count: 1 }]])

    // The warehouse: refused while stock or an unposted receipt is in it.
    let version = 2
    const busy = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/deactivate`, { expectedVersion: version })
    assert.deepEqual([busy.status, busy.payload.code, busy.payload.details], [409, 'WAREHOUSE_IN_USE', [{ code: 'INVENTORY_ON_HAND', count: 1 }]])
    await prisma.inventoryBalance.update({ where: { id: balance.id }, data: { onHandQuantity: '0', availableQuantity: '0' } })
    await prisma.receivingDocument.create({ data: { id: 'GRN-NORTH-1', tenantId: tenantA, documentNumber: 'GRN-NORTH-1', warehouseId: north.id } })
    const receiving = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/deactivate`, { expectedVersion: version })
    assert.deepEqual([receiving.status, receiving.payload.code, receiving.payload.details], [409, 'WAREHOUSE_IN_USE', [{ code: 'UNPOSTED_RECEIVING', count: 1 }]])
    await prisma.receivingDocument.update({ where: { id: 'GRN-NORTH-1' }, data: { workflowStatus: 'cancelled' } })
    assert.equal(await auditCount(), 4)

    current = (await asAdmin('GET', `/api/master-data/warehouses/${north.id}/bins`)).payload.bins[0]
    const binOff = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/bins/${current.id}/deactivate`, { expectedUpdatedAt: current.updatedAt })
    assert.equal(binOff.status, 200, JSON.stringify(binOff.payload))
    assert.equal(binOff.payload.bin.status, 'inactive')

    // Setting it inactive clears it as anyone's default warehouse.
    await prisma.user.update({ where: { id: `${tenantA}-member` }, data: { defaultWarehouseId: north.id } })
    const memberVersion = (await prisma.user.findUnique({ where: { id: `${tenantA}-member` } })).version
    const off = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/deactivate`, { expectedVersion: version })
    assert.equal(off.status, 200, JSON.stringify(off.payload))
    assert.deepEqual([off.payload.warehouse.status, off.payload.warehouse.version, off.payload.clearedDefaults], ['inactive', 3, 1])
    version = 3
    const member = await prisma.user.findUnique({ where: { id: `${tenantA}-member` } })
    assert.deepEqual([member.defaultWarehouseId, member.version], [null, memberVersion + 1])
    assert.equal(await auditCount(), 6)

    // Inactive: gone from the pickers and from receiving's active check, still
    // listed (with its name) for history.
    const options = (await asAdmin('GET', '/api/master-data/warehouses/select')).payload.options
    assert.equal(options.some((row) => row.id === north.id), false)
    assert.ok(options.some((row) => row.id === 'WH-MAIN-A'))
    // The query receiving uses before it accepts a warehouse (receiving-draft-command-service.mjs assertActiveWarehouses).
    assert.equal(await prisma.warehouse.count({ where: { tenantId: tenantA, id: { in: [north.id] }, status: 'active' } }), 0)
    const all = (await asAdmin('GET', '/api/master-data/warehouses')).payload.warehouses
    assert.deepEqual(all.filter((row) => row.id === north.id).map((row) => [row.code, row.name, row.status]), [['NORTH-1', 'North Depot 2', 'inactive']])
    // No new bins in an inactive warehouse.
    const binInInactive = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/bins`, { code: 'B-02' })
    assert.deepEqual([binInInactive.status, binInInactive.payload.code], [409, 'WAREHOUSE_INACTIVE'])

    // MAIN is now the only active warehouse and cannot be set inactive.
    const last = await asAdmin('POST', '/api/master-data/warehouses/WH-MAIN-A/deactivate', { expectedVersion: 1 })
    assert.deepEqual([last.status, last.payload.code], [409, 'LAST_ACTIVE_WAREHOUSE'])

    // And back again.
    const on = await asAdmin('POST', `/api/master-data/warehouses/${north.id}/activate`, { expectedVersion: version })
    assert.equal(on.status, 200, JSON.stringify(on.payload))
    assert.deepEqual([on.payload.warehouse.status, on.payload.warehouse.version, on.payload.clearedDefaults], ['active', 4, 0])
    assert.ok((await asAdmin('GET', '/api/master-data/warehouses/select')).payload.options.some((row) => row.id === north.id))

    // One audit row per write, each in its own workspace, attributed to the admin.
    const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantA, source: 'master-data', entityType: { in: ['warehouse', 'warehouse_bin'] } }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(audits.map((row) => `${row.entityType}:${row.action}`), [
      'warehouse:create', 'warehouse:update', 'warehouse_bin:create', 'warehouse_bin:update', 'warehouse_bin:deactivate', 'warehouse:deactivate', 'warehouse:activate',
    ])
    assert.ok(audits.every((row) => row.actorId === `${tenantA}-admin`))
    assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantB, source: 'master-data', entityType: 'warehouse' } }), 1)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (previousTenant === undefined) delete process.env.FLOWCHAIN_DEFAULT_TENANT_ID
    else process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previousTenant
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})

// Each kind of open work blocks setting a warehouse inactive until it is
// cleared, counted from real rows. Called on the command directly: the HTTP
// path and its authorization are covered above.
test('quarantine stock, reservations, counts, adjustments and open purchase orders block setting a warehouse inactive', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(process.env)
  const tenantId = 'tenant-warehouse-writes-blockers'
  const scope = { tenantId }
  const actorId = `${tenantId}-admin`
  const warehouseId = 'WH-BLOCK-1'
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Blockers workspace', currency: 'USD' } })
    await prisma.user.create({ data: { id: actorId, tenantId, email: 'admin@blockers.example.com', name: 'Blockers admin', role: 'admin' } })
    await prisma.warehouse.create({ data: { id: warehouseId, tenantId, code: 'BLOCK-1', name: 'Blocked' } })
    // A second active warehouse, so "last active warehouse" never applies.
    await prisma.warehouse.create({ data: { id: 'WH-BLOCK-2', tenantId, code: 'BLOCK-2', name: 'Other' } })
    await prisma.item.create({ data: { id: 'ITEM-BLOCK', tenantId, sku: 'SKU-BLOCK', name: 'Blocked item', unit: 'EA' } })
    const refusedFor = async (code) => {
      await assert.rejects(setWarehouseStatus(prisma, warehouseId, { status: 'inactive', expectedVersion: 1 }, actorId, scope), (error) => {
        assert.equal(error.status, 409, code)
        assert.equal(error.code, 'WAREHOUSE_IN_USE', code)
        assert.deepEqual(error.details, [{ code, count: 1 }], code)
        return true
      })
      assert.equal((await prisma.warehouse.findUnique({ where: { id: warehouseId } })).status, 'active', code)
    }

    // Quarantined stock with quantity; then released to zero.
    await prisma.quarantineInventoryBalance.create({ data: { id: 'QB-BLOCK', tenantId, itemId: 'ITEM-BLOCK', sku: 'SKU-BLOCK', warehouseId, onHandQuantity: '3' } })
    await refusedFor('QUARANTINE_ON_HAND')
    await prisma.quarantineInventoryBalance.update({ where: { id: 'QB-BLOCK' }, data: { onHandQuantity: '0' } })

    // A reservation still active for a sales order; then released.
    await prisma.salesOrder.create({ data: { id: 'SO-BLOCK', tenantId, orderNumber: 'SO-BLOCK', customerName: 'Customer', currency: 'USD' } })
    await prisma.salesOrderLine.create({ data: { id: 'SOL-BLOCK', salesOrderId: 'SO-BLOCK', itemId: 'ITEM-BLOCK', sku: 'SKU-BLOCK', itemName: 'Blocked item', orderedQuantity: '1', unit: 'EA' } })
    await prisma.inventoryReservation.create({ data: { id: 'RES-BLOCK', tenantId, salesOrderId: 'SO-BLOCK', salesOrderLineId: 'SOL-BLOCK', itemId: 'ITEM-BLOCK', sku: 'SKU-BLOCK', warehouseId, reservedQuantity: '1', reservedById: actorId } })
    await refusedFor('ACTIVE_RESERVATIONS')
    await prisma.inventoryReservation.update({ where: { id: 'RES-BLOCK' }, data: { status: 'released', releasedQuantity: '1' } })

    // A cycle count not yet posted; then cancelled.
    await prisma.cycleCountSession.create({ data: { id: 'CC-BLOCK', tenantId, countNumber: 'CC-BLOCK', warehouseId } })
    await refusedFor('OPEN_COUNTS')
    await prisma.cycleCountSession.update({ where: { id: 'CC-BLOCK' }, data: { workflowStatus: 'cancelled' } })

    // An unposted inventory adjustment with a line in the warehouse; then cancelled.
    await prisma.inventoryAdjustmentDocument.create({ data: { id: 'ADJ-BLOCK', tenantId, adjustmentNumber: 'ADJ-BLOCK', reasonCode: 'count_correction', lines: { create: [{ id: 'ADJL-BLOCK', inventoryBalanceId: 'BAL-BLOCK', sku: 'SKU-BLOCK', warehouseId, adjustmentQuantity: '1' }] } } })
    await refusedFor('UNPOSTED_ADJUSTMENTS')
    await prisma.inventoryAdjustmentDocument.update({ where: { id: 'ADJ-BLOCK' }, data: { workflowStatus: 'cancelled' } })

    // A purchase order still open for receiving into the warehouse; a
    // cancelled one aimed at it does not count. Then the open one is closed.
    await prisma.purchaseOrder.create({ data: { id: 'PO-BLOCK-OPEN', tenantId, status: 'issued', metadata: { targetWarehouseId: warehouseId } } })
    await prisma.purchaseOrder.create({ data: { id: 'PO-BLOCK-CANCELLED', tenantId, status: 'cancelled', metadata: { targetWarehouseId: warehouseId } } })
    await prisma.purchaseOrder.create({ data: { id: 'PO-BLOCK-ELSEWHERE', tenantId, status: 'issued', metadata: { targetWarehouseId: 'WH-BLOCK-2' } } })
    await refusedFor('OPEN_PURCHASE_ORDERS')
    await prisma.purchaseOrder.update({ where: { id: 'PO-BLOCK-OPEN' }, data: { status: 'closed' } })

    // Nothing left: it can be set inactive.
    const result = await setWarehouseStatus(prisma, warehouseId, { status: 'inactive', expectedVersion: 1 }, actorId, scope)
    assert.deepEqual([result.warehouse.status, result.clearedDefaults], ['inactive', 0])
    assert.equal(await prisma.auditLog.count({ where: { tenantId, entityType: 'warehouse', action: 'deactivate' } }), 1)
  } finally {
    await prisma.$disconnect()
  }
})
