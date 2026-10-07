import test from 'node:test'
import assert from 'node:assert/strict'
import { RECEIVABLE_PURCHASE_ORDER_INPUTS } from './procurement-status-authority.mjs'
import { receivingLocationKey } from './receiving-transaction-policy.mjs'
import { saveWarehouse, saveWarehouseBin, setWarehouseBinStatus, setWarehouseStatus } from './warehouse-master-commands.mjs'

const scope = { tenantId: 'tenant-a' }
const actorId = 'user-admin'

// An in-memory stand-in for the Prisma transaction: just the reads and writes
// the warehouse commands make. `usage` sets what each guard count returns.
function fakePrisma({ warehouses = [], bins = [], users = [], usage = {} } = {}) {
  const state = { warehouses: warehouses.map((row) => ({ ...row })), bins: bins.map((row) => ({ ...row })), users: users.map((row) => ({ ...row })), scopes: [], audits: [], counted: [] }
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not
    return row[key] === value
  })
  // Reads return copies, as Prisma does, so a write never changes a row read earlier.
  const copy = (row) => (row ? { ...row } : null)
  const touch = (row) => Object.assign(row, { updatedAt: new Date(Date.now() + state.audits.length + 1) })
  const counter = (model) => async ({ where }) => { state.counted.push({ model, where }); return usage[model] || 0 }
  const tx = {
    warehouse: {
      findFirst: async ({ where }) => copy(state.warehouses.find((row) => matches(row, where))),
      count: async ({ where }) => state.warehouses.filter((row) => matches(row, where)).length,
      create: async ({ data }) => {
        if (state.warehouses.some((row) => row.tenantId === data.tenantId && row.code === data.code)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        const row = touch({ ...data }); state.warehouses.push(row); return row
      },
      update: async ({ where, data }) => touch(Object.assign(state.warehouses.find((row) => row.id === where.id), data)),
    },
    warehouseLocation: {
      findFirst: async ({ where }) => copy(state.bins.find((row) => matches(row, where))),
      create: async ({ data }) => {
        if (state.bins.some((row) => row.tenantId === data.tenantId && row.warehouseId === data.warehouseId && row.locationKey === data.locationKey)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        const row = touch({ ...data }); state.bins.push(row); return row
      },
      update: async ({ where, data }) => touch(Object.assign(state.bins.find((row) => row.id === where.id), data)),
    },
    userWarehouseScope: { create: async ({ data }) => { state.scopes.push(data); return data } },
    user: {
      updateMany: async ({ where, data }) => {
        const rows = state.users.filter((row) => matches(row, where))
        for (const row of rows) { row.defaultWarehouseId = data.defaultWarehouseId; row.version += data.version.increment }
        return { count: rows.length }
      },
    },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data } },
    inventoryBalance: { count: counter('inventoryBalance') },
    quarantineInventoryBalance: { count: counter('quarantineInventoryBalance') },
    inventoryReservation: { count: counter('inventoryReservation') },
    cycleCountSession: { count: counter('cycleCountSession') },
    receivingDocument: { count: counter('receivingDocument') },
    stockTransferDocument: { count: counter('stockTransferDocument') },
    inventoryAdjustmentDocument: { count: counter('inventoryAdjustmentDocument') },
    returnPostingDocument: { count: counter('returnPostingDocument') },
    purchaseOrder: { count: counter('purchaseOrder') },
  }
  return { state, prisma: { $transaction: async (work, options) => { assert.equal(options?.isolationLevel, 'Serializable'); return work(tx) } } }
}

const warehouse = (overrides = {}) => ({ id: 'WH-1', tenantId: 'tenant-a', code: 'MAIN', name: 'Main', status: 'active', metadata: { version: 3 }, updatedAt: new Date('2026-10-01T00:00:00Z'), ...overrides })
const issueCodes = (error) => error.details.map((detail) => `${detail.field}:${detail.code}`)

test('a new warehouse is validated, upper-cased, versioned and gives its creator operate access', async () => {
  const { prisma, state } = fakePrisma()
  for (const [input, expected] of [
    [{ name: 'North' }, ['code:CODE_REQUIRED']],
    [{ code: '-bad', name: 'North' }, ['code:CODE_INVALID']],
    [{ code: 'has space', name: 'North' }, ['code:CODE_INVALID']],
    [{ code: 'X'.repeat(33), name: 'North' }, ['code:CODE_INVALID']],
    [{ code: 'north' }, ['name:NAME_REQUIRED']],
    [{ code: 'north', name: 'N'.repeat(121) }, ['name:NAME_TOO_LONG']],
  ]) {
    await assert.rejects(saveWarehouse(prisma, null, input, actorId, scope), (error) => error.status === 422 && error.code === 'VALIDATION_ERROR' && assert.deepEqual(issueCodes(error), expected) === undefined, JSON.stringify(input))
  }
  assert.equal(state.warehouses.length, 0)

  const saved = await saveWarehouse(prisma, null, { code: ' north-2 ', name: ' North ' }, actorId, scope)
  assert.match(saved.id, /^WH-/)
  assert.deepEqual([saved.code, saved.name, saved.status, saved.metadata.version, saved.metadata.createdBy], ['NORTH-2', 'North', 'active', 1, actorId])
  assert.deepEqual(state.scopes.map((row) => [row.tenantId, row.userId, row.warehouseId, row.accessLevel]), [['tenant-a', actorId, saved.id, 'operate']])
  assert.deepEqual(state.audits.map((row) => [row.action, row.entityType, row.entityId, row.source]), [['create', 'warehouse', saved.id, 'master-data']])

  await assert.rejects(saveWarehouse(prisma, null, { code: 'NORTH-2', name: 'Again' }, actorId, scope), (error) => error.status === 409 && error.code === 'DUPLICATE_CODE' && error.details[0].field === 'code')
  await assert.rejects(saveWarehouse(prisma, null, { code: 'X', name: 'Y' }, actorId, {}), { status: 403, code: 'TENANT_REQUIRED' })
})

test('a warehouse rename keeps the code, checks the version and is tenant-scoped', async () => {
  const { prisma, state } = fakePrisma({ warehouses: [warehouse()] })
  await assert.rejects(saveWarehouse(prisma, 'WH-1', { name: 'Stale', expectedVersion: 2 }, actorId, scope), { status: 409, code: 'VERSION_CONFLICT' })
  await assert.rejects(saveWarehouse(prisma, 'WH-1', { code: 'OTHER', name: 'Main 2', expectedVersion: 3 }, actorId, scope), (error) => error.status === 422 && issueCodes(error).includes('code:CODE_IMMUTABLE'))
  await assert.rejects(saveWarehouse(prisma, 'WH-1', { name: 'Elsewhere', expectedVersion: 3 }, actorId, { tenantId: 'tenant-b' }), { status: 404, code: 'NOT_FOUND' })
  // Repeating the code in any case is not a change.
  const saved = await saveWarehouse(prisma, 'WH-1', { code: 'main', name: 'Main Hall', expectedVersion: 3 }, actorId, scope)
  assert.deepEqual([saved.code, saved.name, saved.metadata.version], ['MAIN', 'Main Hall', 4])
  assert.equal(state.scopes.length, 0, 'a rename grants nobody access')
  assert.deepEqual(state.audits.map((row) => [row.action, row.metadata.before, row.metadata.after]), [['update', { name: 'Main' }, { name: 'Main Hall' }]])
})

test('setting a warehouse inactive is refused while anything depends on it', async () => {
  for (const [model, code] of [
    ['inventoryBalance', 'INVENTORY_ON_HAND'],
    ['quarantineInventoryBalance', 'QUARANTINE_ON_HAND'],
    ['inventoryReservation', 'ACTIVE_RESERVATIONS'],
    ['cycleCountSession', 'OPEN_COUNTS'],
    ['receivingDocument', 'UNPOSTED_RECEIVING'],
    ['stockTransferDocument', 'UNPOSTED_TRANSFERS'],
    ['inventoryAdjustmentDocument', 'UNPOSTED_ADJUSTMENTS'],
    ['returnPostingDocument', 'UNPOSTED_RETURNS'],
    ['purchaseOrder', 'OPEN_PURCHASE_ORDERS'],
  ]) {
    const { prisma, state } = fakePrisma({ warehouses: [warehouse(), warehouse({ id: 'WH-2', code: 'SECOND' })], usage: { [model]: 2 } })
    await assert.rejects(setWarehouseStatus(prisma, 'WH-1', { status: 'inactive', expectedVersion: 3 }, actorId, scope), (error) => error.status === 409 && error.code === 'WAREHOUSE_IN_USE' && assert.deepEqual(error.details, [{ code, count: 2 }]) === undefined, model)
    assert.equal(state.warehouses[0].status, 'active')
    assert.equal(state.audits.length, 0)
  }
  // The guards count the recorded rows of this warehouse in this workspace.
  const { prisma, state } = fakePrisma({ warehouses: [warehouse(), warehouse({ id: 'WH-2', code: 'SECOND' })] })
  await setWarehouseStatus(prisma, 'WH-1', { status: 'inactive', expectedVersion: 3 }, actorId, scope)
  const where = Object.fromEntries(state.counted.map((row) => [row.model, row.where]))
  assert.deepEqual(where.inventoryBalance, { tenantId: 'tenant-a', OR: [{ warehouseId: 'WH-1' }, { warehouseKey: 'WH-1' }], onHandQuantity: { not: 0 } })
  assert.deepEqual(where.inventoryReservation.status, { notIn: ['consumed', 'released'] })
  assert.deepEqual(where.cycleCountSession.workflowStatus, { notIn: ['posted', 'cancelled'] })
  assert.deepEqual([where.receivingDocument.postingStatus, where.receivingDocument.workflowStatus], ['unposted', { not: 'cancelled' }])
  // Transfers, adjustments and returns: unposted and not cancelled, in this
  // warehouse (either leg of a transfer).
  assert.deepEqual(where.stockTransferDocument, { tenantId: 'tenant-a', postingStatus: 'unposted', workflowStatus: { not: 'cancelled' }, lines: { some: { legs: { some: { warehouseId: 'WH-1' } } } } })
  assert.deepEqual(where.inventoryAdjustmentDocument, { tenantId: 'tenant-a', postingStatus: 'unposted', workflowStatus: { not: 'cancelled' }, lines: { some: { warehouseId: 'WH-1' } } })
  assert.deepEqual(where.returnPostingDocument, { tenantId: 'tenant-a', postingStatus: 'unposted', workflowStatus: { not: 'cancelled' }, warehouseId: 'WH-1' })
  // Purchase orders still open for receiving, in the statuses receiving
  // offers, whose target warehouse is this one.
  assert.deepEqual(where.purchaseOrder, { tenantId: 'tenant-a', status: { in: [...RECEIVABLE_PURCHASE_ORDER_INPUTS] }, metadata: { path: ['targetWarehouseId'], equals: 'WH-1' } })
  for (const closed of ['closed', 'cancelled', 'received', 'draft']) assert.equal(RECEIVABLE_PURCHASE_ORDER_INPUTS.includes(closed), false, closed)
  for (const open of ['approved', 'issued', 'partially_received']) assert.equal(RECEIVABLE_PURCHASE_ORDER_INPUTS.includes(open), true, open)
})

test('every reason that blocks a warehouse is reported with its count', async () => {
  const usage = { inventoryBalance: 1, stockTransferDocument: 2, inventoryAdjustmentDocument: 3, returnPostingDocument: 4, purchaseOrder: 5 }
  const { prisma } = fakePrisma({ warehouses: [warehouse(), warehouse({ id: 'WH-2', code: 'SECOND' })], usage })
  await assert.rejects(setWarehouseStatus(prisma, 'WH-1', { status: 'inactive', expectedVersion: 3 }, actorId, scope), (error) => error.code === 'WAREHOUSE_IN_USE' && assert.deepEqual(error.details, [
    { code: 'INVENTORY_ON_HAND', count: 1 },
    { code: 'UNPOSTED_TRANSFERS', count: 2 },
    { code: 'UNPOSTED_ADJUSTMENTS', count: 3 },
    { code: 'UNPOSTED_RETURNS', count: 4 },
    { code: 'OPEN_PURCHASE_ORDERS', count: 5 },
  ]) === undefined)
})

test('the last active warehouse cannot be set inactive', async () => {
  const { prisma } = fakePrisma({ warehouses: [warehouse(), warehouse({ id: 'WH-2', code: 'OLD', status: 'inactive' })] })
  await assert.rejects(setWarehouseStatus(prisma, 'WH-1', { status: 'inactive', expectedVersion: 3 }, actorId, scope), { status: 409, code: 'LAST_ACTIVE_WAREHOUSE' })
})

test('setting a warehouse inactive clears it as a default warehouse and can be undone', async () => {
  const { prisma, state } = fakePrisma({
    warehouses: [warehouse(), warehouse({ id: 'WH-2', code: 'SECOND' })],
    users: [{ id: 'u1', tenantId: 'tenant-a', defaultWarehouseId: 'WH-1', version: 1 }, { id: 'u2', tenantId: 'tenant-a', defaultWarehouseId: 'WH-2', version: 5 }, { id: 'u3', tenantId: 'tenant-b', defaultWarehouseId: 'WH-1', version: 1 }],
  })
  await assert.rejects(setWarehouseStatus(prisma, 'WH-1', { status: 'inactive', expectedVersion: 1 }, actorId, scope), { status: 409, code: 'VERSION_CONFLICT' })
  await assert.rejects(setWarehouseStatus(prisma, 'WH-1', { status: 'closed', expectedVersion: 3 }, actorId, scope), (error) => error.status === 422 && issueCodes(error)[0] === 'status:STATUS_INVALID')
  const result = await setWarehouseStatus(prisma, 'WH-1', { status: 'inactive', expectedVersion: 3 }, actorId, scope)
  assert.deepEqual([result.warehouse.status, result.warehouse.metadata.version, result.clearedDefaults], ['inactive', 4, 1])
  assert.deepEqual(state.users.map((row) => [row.id, row.defaultWarehouseId, row.version]), [['u1', null, 2], ['u2', 'WH-2', 5], ['u3', 'WH-1', 1]])
  assert.deepEqual(state.audits.map((row) => [row.action, row.metadata.clearedDefaults]), [['deactivate', 1]])

  const again = await setWarehouseStatus(prisma, 'WH-1', { status: 'active', expectedVersion: 4 }, actorId, scope)
  assert.deepEqual([again.warehouse.status, again.warehouse.metadata.version, again.clearedDefaults], ['active', 5, 0])
  assert.equal(state.audits.length, 2)
  // Asking for the status it already has changes and records nothing.
  await setWarehouseStatus(prisma, 'WH-1', { status: 'active', expectedVersion: 5 }, actorId, scope)
  assert.equal(state.audits.length, 2)
})

test('a bin takes its location key from its code, the way stock rows do', async () => {
  const { prisma, state } = fakePrisma({ warehouses: [warehouse(), warehouse({ id: 'WH-OFF', code: 'OFF', status: 'inactive' })] })
  await assert.rejects(saveWarehouseBin(prisma, 'WH-1', null, { name: 'No code' }, actorId, scope), (error) => error.status === 422 && issueCodes(error)[0] === 'code:CODE_REQUIRED')
  await assert.rejects(saveWarehouseBin(prisma, 'WH-1', null, { code: 'B'.repeat(65) }, actorId, scope), (error) => error.status === 422 && issueCodes(error)[0] === 'code:CODE_TOO_LONG')
  await assert.rejects(saveWarehouseBin(prisma, 'WH-MISSING', null, { code: 'A-01' }, actorId, scope), { status: 404, code: 'NOT_FOUND' })
  await assert.rejects(saveWarehouseBin(prisma, 'WH-1', null, { code: 'A-01' }, actorId, { tenantId: 'tenant-b' }), { status: 404, code: 'NOT_FOUND' })
  await assert.rejects(saveWarehouseBin(prisma, 'WH-OFF', null, { code: 'A-01' }, actorId, scope), { status: 409, code: 'WAREHOUSE_INACTIVE' })

  const bin = await saveWarehouseBin(prisma, 'WH-1', null, { code: ' Rack A-01 ', name: '' }, actorId, scope)
  assert.match(bin.id, /^BIN-/)
  assert.deepEqual([bin.warehouseId, bin.code, bin.locationKey, bin.name, bin.status], ['WH-1', 'Rack A-01', receivingLocationKey('Rack A-01'), null, 'active'])
  assert.equal(bin.locationKey, 'rack a-01')
  // The same location in another case is the same bin.
  await assert.rejects(saveWarehouseBin(prisma, 'WH-1', null, { code: 'RACK A-01' }, actorId, scope), (error) => error.status === 409 && error.code === 'DUPLICATE_BIN' && error.details[0].field === 'code')

  await assert.rejects(saveWarehouseBin(prisma, 'WH-1', bin.id, { name: 'Stale', expectedUpdatedAt: '2020-01-01T00:00:00Z' }, actorId, scope), { status: 409, code: 'VERSION_CONFLICT' })
  await assert.rejects(saveWarehouseBin(prisma, 'WH-1', bin.id, { code: 'B-02', expectedUpdatedAt: bin.updatedAt.toISOString() }, actorId, scope), (error) => error.status === 422 && issueCodes(error)[0] === 'code:CODE_IMMUTABLE')
  const renamed = await saveWarehouseBin(prisma, 'WH-1', bin.id, { name: 'Front rack', expectedUpdatedAt: bin.updatedAt.toISOString() }, actorId, scope)
  assert.deepEqual([renamed.code, renamed.locationKey, renamed.name], ['Rack A-01', 'rack a-01', 'Front rack'])
  assert.deepEqual(state.audits.map((row) => [row.action, row.entityType]), [['create', 'warehouse_bin'], ['update', 'warehouse_bin']])
})

test('a bin with stock cannot be set inactive', async () => {
  const bins = [{ id: 'BIN-1', tenantId: 'tenant-a', warehouseId: 'WH-1', code: 'A-01', locationKey: 'a-01', name: null, status: 'active', updatedAt: new Date('2026-10-02T00:00:00Z') }]
  const busy = fakePrisma({ warehouses: [warehouse()], bins, usage: { inventoryBalance: 1 } })
  await assert.rejects(setWarehouseBinStatus(busy.prisma, 'WH-1', 'BIN-1', { status: 'inactive', expectedUpdatedAt: '2026-10-02T00:00:00Z' }, actorId, scope), (error) => error.status === 409 && error.code === 'BIN_IN_USE' && assert.deepEqual(error.details, [{ code: 'INVENTORY_ON_HAND', count: 1 }]) === undefined)
  assert.deepEqual(busy.state.counted.find((row) => row.model === 'inventoryBalance').where, { tenantId: 'tenant-a', OR: [{ warehouseId: 'WH-1' }, { warehouseKey: 'WH-1' }], locationKey: 'a-01', onHandQuantity: { not: 0 } })

  const { prisma, state } = fakePrisma({ warehouses: [warehouse()], bins })
  await assert.rejects(setWarehouseBinStatus(prisma, 'WH-1', 'BIN-1', { status: 'inactive', expectedUpdatedAt: '2026-10-01T00:00:00Z' }, actorId, scope), { status: 409, code: 'VERSION_CONFLICT' })
  await assert.rejects(setWarehouseBinStatus(prisma, 'WH-2', 'BIN-1', { status: 'inactive', expectedUpdatedAt: '2026-10-02T00:00:00Z' }, actorId, scope), { status: 404, code: 'NOT_FOUND' })
  const saved = await setWarehouseBinStatus(prisma, 'WH-1', 'BIN-1', { status: 'inactive', expectedUpdatedAt: '2026-10-02T00:00:00Z' }, actorId, scope)
  assert.equal(saved.status, 'inactive')
  assert.deepEqual(state.audits.map((row) => [row.action, row.entityType, row.entityId]), [['deactivate', 'warehouse_bin', 'BIN-1']])
})
