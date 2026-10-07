import test from 'node:test'
import assert from 'node:assert/strict'
import XLSX from 'xlsx'
import { createDataImportService, DataImportError } from './data-import-service.mjs'

// The preview checks every row against the workspace's own records before
// anything is written. These tests use an in-memory PostgreSQL stand-in that
// honours the tenant filter of every query; the database suite
// (npm run test:db:data-import) covers the commit against real commands.

const TENANT = 'tenant-a'
const OTHER = 'tenant-b'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-a', role: 'manager' }
const context = { identity }
const allPermissions = ['master_data.item.manage', 'master_data.supplier.manage', 'master_data.customer.manage', 'inventory.adjustment.create']

function actorWith({ permissions = allPermissions, operate = ['WH-A'] } = {}) {
  return {
    tenantId: TENANT, complete: true, authenticated: true, allWarehouses: false,
    permissionCodes: new Set(permissions), roleIds: [], permissionSourceRoleIds: new Map(),
    operateWarehouseIds: new Set(operate), readWarehouseIds: new Set(operate),
  }
}

const seed = () => ({
  tenant: [{ id: TENANT, currency: 'CNY' }, { id: OTHER, currency: 'EUR' }],
  item: [
    { id: 'ITEM-1', tenantId: TENANT, sku: 'VALVE-100', name: 'Ball valve', unit: 'EA', status: 'active', preferredSupplierId: 'SUP-1' },
    { id: 'ITEM-2', tenantId: TENANT, sku: 'PIPE-200', name: 'Pipe', unit: 'm', status: 'active' },
    { id: 'ITEM-OLD', tenantId: TENANT, sku: 'OLD-1', name: 'Retired', unit: 'EA', status: 'inactive' },
    { id: 'ITEM-B', tenantId: OTHER, sku: 'FOREIGN-1', name: 'Other workspace item', unit: 'EA', status: 'active' },
  ],
  supplier: [
    { id: 'SUP-1', tenantId: TENANT, code: 'SUP-001', status: 'active', metadata: { defaultCurrency: 'USD' } },
    { id: 'SUP-5', tenantId: TENANT, code: 'SUP-005', status: 'active', metadata: { defaultCurrency: 'USD' } },
    { id: 'SUP-B', tenantId: OTHER, code: 'SUP-FOREIGN', status: 'active', metadata: { defaultCurrency: 'EUR' } },
  ],
  paymentTerm: [{ id: 'TERM-30', tenantId: TENANT, code: 'NET30' }, { id: 'TERM-B', tenantId: OTHER, code: 'NET60' }],
  runtimeRecord: [
    { id: 'RR-1', tenantId: TENANT, namespace: 'master-data.customers', recordKey: 'CUST-001', payload: { id: 'CUST-1' } },
    { id: 'RR-B', tenantId: OTHER, namespace: 'master-data.customers', recordKey: 'CUST-FOREIGN', payload: { id: 'CUST-B' } },
  ],
  warehouse: [
    { id: 'WH-A', tenantId: TENANT, code: 'MAIN', name: 'Main', status: 'active' },
    { id: 'WH-X', tenantId: TENANT, code: 'EAST', name: 'East', status: 'active' },
    { id: 'WH-B', tenantId: OTHER, code: 'FOREIGN', name: 'Foreign', status: 'active' },
  ],
  inventoryBalance: [
    { id: 'BAL-1', tenantId: TENANT, sku: 'VALVE-100', warehouseId: 'WH-A', warehouseKey: 'WH-A', location: 'A-01', locationKey: 'a-01', onHandQuantity: '4' },
    { id: 'BAL-0', tenantId: TENANT, sku: 'PIPE-200', warehouseId: 'WH-A', warehouseKey: 'WH-A', location: 'B-01', locationKey: 'b-01', onHandQuantity: '0' },
    // In East, which the importer cannot operate.
    { id: 'BAL-EAST', tenantId: TENANT, sku: 'VALVE-100', warehouseId: 'WH-X', warehouseKey: 'WH-X', location: 'A-01', locationKey: 'a-01', onHandQuantity: '9' },
  ],
  inventoryMovement: [],
  inventoryAdjustmentLine: [
    { sku: 'PIPE-200', warehouseId: 'WH-A', locationKey: 'c-01', adjustment: { id: 'ADJ-1', tenantId: TENANT, adjustmentNumber: 'OB-1', reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: 'draft' } },
    { sku: 'PIPE-200', warehouseId: 'WH-X', locationKey: 'e-01', adjustment: { id: 'ADJ-EAST', tenantId: TENANT, adjustmentNumber: 'OB-EAST', reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: 'draft' } },
  ],
  businessCommandExecution: [],
  auditLog: [],
})

// Matches the where clauses the service uses: equality, { in }, { not },
// { lt }, { startsWith }, OR and a nested relation filter.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((entry) => matches(row, entry))
    const value = row[key]
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition) return condition.in.includes(value)
      if ('startsWith' in condition) return String(value).startsWith(condition.startsWith)
      if ('not' in condition) return condition.not === null ? value !== null && value !== undefined : value !== condition.not
      if ('notIn' in condition) return !condition.notIn.includes(value)
      if ('lt' in condition) return value < condition.lt
      return value && typeof value === 'object' && matches(value, condition)
    }
    return value === condition
  })
}

function fakePrisma(data = seed()) {
  const queries = []
  const table = (name) => ({
    findMany: async ({ where } = {}) => { queries.push({ table: name, where }); return data[name].filter((row) => matches(row, where)) },
    findUnique: async ({ where } = {}) => {
      queries.push({ table: name, where })
      const key = where.tenantId_commandType_idempotencyKey || where
      return data[name].find((row) => matches(row, key)) || null
    },
    count: async ({ where } = {}) => data[name].filter((row) => matches(row, where)).length,
    create: async ({ data: row }) => {
      if (name === 'businessCommandExecution' && data[name].some((other) => other.tenantId === row.tenantId && other.commandType === row.commandType && other.idempotencyKey === row.idempotencyKey)) throw Object.assign(new Error('unique'), { code: 'P2002' })
      const stored = { createdAt: new Date(), ...row }
      data[name].push(stored)
      return stored
    },
    update: async ({ where, data: patch }) => { const row = data[name].find((entry) => entry.id === where.id); Object.assign(row, patch); return row },
    updateMany: async ({ where, data: patch }) => { const rows = data[name].filter((row) => matches(row, where)); rows.forEach((row) => Object.assign(row, patch)); return { count: rows.length } },
    deleteMany: async ({ where }) => { const before = data[name].length; data[name] = data[name].filter((row) => !matches(row, where)); return { count: before - data[name].length } },
  })
  return Object.assign(Object.fromEntries(Object.keys(data).map((name) => [name, table(name)])), { queries, data })
}

const csv = (lines) => Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8').toString('base64')
// Ids stay unique across service instances, as random ones would.
let nextId = 0
const service = (prisma, { actor = actorWith(), env = {}, commands } = {}) =>
  createDataImportService({ prisma, env: { FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true', ...env }, resolveActor: async () => actor, commands, idFactory: () => `id-${++nextId}` })
const byRow = (result) => Object.fromEntries(result.rows.map((row) => [row.rowNumber, row]))
const codes = (row) => row.issues.map((entry) => entry.code)

test('English and Chinese headers both match, in any case and spacing', async () => {
  const prisma = fakePrisma()
  const english = await service(prisma).preview('items', { fileName: 'items.csv', contentBase64: csv(['  sku ,ITEM NAME,Unit,Lead Time (Days),Status', 'NEW-1,Gate valve,EA,7,Active']) }, context)
  assert.deepEqual(english.columns.map((column) => column.key), ['sku', 'itemName', 'unit', 'leadTimeDays', 'status'])
  assert.deepEqual([english.rows[0].action, english.rows[0].key, english.rows[0].issues], ['create', 'NEW-1', []])
  // The Chinese export headers, with half-width brackets typed by hand.
  const chinese = await service(prisma).preview('items', { fileName: 'items.csv', contentBase64: csv(['SKU,物料名称,单位,采购提前期(天),批次管理,状态', 'NEW-2,闸阀,EA,7,是,启用']) }, context)
  assert.deepEqual(chinese.columns.map((column) => column.key), ['sku', 'itemName', 'unit', 'leadTimeDays', 'batchManaged', 'status'])
  assert.equal(chinese.rows[0].action, 'create')
  const supplier = await service(prisma).preview('suppliers', { fileName: 'suppliers.csv', contentBase64: csv(['供应商编号,供应商名称,联系电话,付款条款编码', 'SUP-NEW,新供应商,123,NET30']) }, context)
  assert.deepEqual(supplier.columns.map((column) => column.key), ['supplierCode', 'supplierName', 'telephone', 'paymentTermCode'])
  // A missing required column stops the file, before any row is read.
  await assert.rejects(service(prisma).preview('items', { fileName: 'items.csv', contentBase64: csv(['SKU,Unit', 'X,EA']) }, context),
    (error) => error.code === 'DATA_IMPORT_REQUIRED_COLUMN_MISSING' && error.details.columns[0].key === 'itemName')
})

test('re-importing the item export reports the columns it does not read', async () => {
  // Built the way the master data export builds its workbook.
  const rows = [{
    SKU: 'VALVE-100', 'Item name': 'Ball valve', Category: 'Valves', Specification: '2 in', Unit: 'EA', 'Default warehouse': 'MAIN', 'Default bin': 'A-01',
    'Safety stock': 5, 'Maximum stock': 50, 'Reorder point': 10, 'Lead time (days)': 7, 'Batch managed': 'No', 'Serial managed': 'No',
    'QA required': 'No', 'Default supplier': 'SUP-001', 'Default tax code': 'TX', Status: 'Active',
  }, {
    SKU: 'NEW-9', 'Item name': 'Check valve', Category: 'Valves', Specification: '', Unit: 'EA', 'Default warehouse': '', 'Default bin': '',
    'Safety stock': 0, 'Maximum stock': 0, 'Reorder point': 0, 'Lead time (days)': 0, 'Batch managed': 'Yes', 'Serial managed': 'No',
    'QA required': 'No', 'Default supplier': '', 'Default tax code': '', Status: 'Incomplete',
  }]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: Object.keys(rows[0]) }), '当前结果')
  const contentBase64 = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64')
  const result = await service(fakePrisma()).preview('items', { fileName: 'master-data-items-2026-10-05.xlsx', contentBase64 }, context)
  assert.equal(result.sourceFormat, 'xlsx')
  assert.deepEqual(result.ignoredColumns, ['Default warehouse', 'Default bin', 'Maximum stock', 'QA required', 'Default supplier', 'Default tax code'].map((header) => ({ header, reason: 'not_imported' })))
  const [existing, created] = result.rows
  assert.deepEqual([existing.action, existing.existing.entity.id], ['skip_existing', 'ITEM-1'])
  assert.deepEqual([created.action, created.issues], ['create', []])
  assert.equal(created.values.status, 'Incomplete')
  // An unknown header is ignored too, and said so.
  const unknown = await service(fakePrisma()).preview('items', { fileName: 'x.csv', contentBase64: csv(['SKU,Item name,Unit,Colour', 'N-1,Valve,EA,Red']) }, context)
  assert.deepEqual(unknown.ignoredColumns, [{ header: 'Colour', reason: 'unknown' }])
})

test('numbers are read the same in every language: digits and a decimal point only', async () => {
  const result = await service(fakePrisma()).preview('items', {
    fileName: 'items.csv',
    contentBase64: csv([
      'SKU,Item name,Unit,Safety stock,Reorder point,Lead time (days),Batch managed',
      'N-1,Valve,EA,"1,000",10,7,No',
      'N-2,Valve,EA,1.5,1e3,7,No',
      'N-3,Valve,EA,$5,10,2.5,maybe',
      'N-4,Valve,EA,-1,0.25,7,true',
    ]),
  }, context)
  const rows = byRow(result)
  assert.deepEqual(codes(rows[2]), ['NUMBER_FORMAT'])
  assert.deepEqual([codes(rows[3]), rows[3].issues[0].field], [['NUMBER_FORMAT'], 'reorderPoint'])
  assert.deepEqual(codes(rows[4]), ['NUMBER_FORMAT', 'YES_NO_INVALID', 'WHOLE_NUMBER_REQUIRED'])
  assert.deepEqual(rows[4].issues.map((entry) => entry.field), ['safetyStock', 'batchManaged', 'leadTimeDays'])
  // A well-formed negative number reaches the item's own range check.
  assert.deepEqual([codes(rows[5]), rows[5].issues[0].field], [['NUMBER_INVALID'], 'safetyStock'])
  assert.deepEqual(result.counts, { rows: 4, create: 0, skip_existing: 0, error: 4 })
})

test('opening stock never converts units and shows the item unit, new records and existing stock', async () => {
  const result = await service(fakePrisma()).preview('opening-stock', {
    fileName: 'opening.csv',
    contentBase64: csv([
      'SKU,Warehouse code,Location,Quantity,Unit',
      'VALVE-100,MAIN,A-02,12,EA',
      'PIPE-200,MAIN,A-02,30,ft',
      'VALVE-100,MAIN,A-01,5,',
      'PIPE-200,MAIN,B-01,8,m',
      'PIPE-200,MAIN,C-01,2,',
      'OLD-1,MAIN,A-03,1,',
      'VALVE-100,EAST,A-01,1,',
      'VALVE-100,FOREIGN,A-01,1,',
      'FOREIGN-1,MAIN,A-04,1,',
      'VALVE-100,MAIN,A-05,0,',
      'VALVE-100,MAIN,A-06,1.00001,',
    ]),
  }, context)
  const rows = byRow(result)
  assert.deepEqual([rows[2].action, rows[2].details.unit, rows[2].details.stockRecord], ['create', 'EA', 'new'])
  assert.deepEqual(codes(rows[3]), ['UNIT_MISMATCH'])
  assert.equal(rows[3].issues[0].message, 'This item is kept in m. Convert the quantity before importing.')
  assert.deepEqual(rows[3].issues[0].params, { unit: 'm' })
  // The location already holds stock: nothing to open there.
  assert.deepEqual([rows[4].action, rows[4].existing.reason], ['skip_existing', 'STOCK_RECORD_HAS_STOCK'])
  // An empty stock record with no history takes opening stock.
  assert.deepEqual([rows[5].action, rows[5].details.stockRecord], ['create', 'existing'])
  // Already in an opening draft: the same document, not a second one.
  assert.deepEqual([rows[6].action, rows[6].existing.reason, rows[6].existing.document.id], ['skip_existing', 'IN_OPENING_DRAFT', 'ADJ-1'])
  assert.deepEqual(codes(rows[7]), ['ITEM_INACTIVE'])
  // Nothing about a warehouse the importer cannot operate, or the stock in
  // it, beyond the code in the file.
  assert.deepEqual([codes(rows[8]), rows[8].existing, rows[8].details.stockRecord], [['WAREHOUSE_SCOPE_DENIED'], undefined, null])
  assert.deepEqual([rows[8].details.warehouseId, rows[8].details.warehouseCode, rows[8].details.warehouseName], [null, 'EAST', null])
  assert.deepEqual(result.warehouses.find((group) => group.warehouseCode === 'EAST'), { warehouseId: null, warehouseCode: 'EAST', warehouseName: null, rows: 1, create: 0, newStockRecords: 0 })
  assert.ok(!JSON.stringify(result).includes('WH-X') && !JSON.stringify(result).includes('"East"'))
  // Codes that match no warehouse are grouped by the code in the file.
  assert.deepEqual(result.warehouses.find((group) => group.warehouseCode === 'FOREIGN'), { warehouseId: null, warehouseCode: 'FOREIGN', warehouseName: null, rows: 1, create: 0, newStockRecords: 0 })
  assert.deepEqual(codes(rows[9]), ['WAREHOUSE_NOT_FOUND'])
  assert.deepEqual(codes(rows[10]), ['ITEM_NOT_FOUND'])
  assert.deepEqual(codes(rows[11]), ['QUANTITY_POSITIVE'])
  assert.deepEqual(codes(rows[12]), ['QUANTITY_PRECISION'])
  // Grouped by warehouse with row counts only; no quantities are added up.
  const main = result.warehouses.find((group) => group.warehouseCode === 'MAIN')
  assert.deepEqual(main, { warehouseId: 'WH-A', warehouseCode: 'MAIN', warehouseName: 'Main', rows: 9, create: 2, newStockRecords: 1 })
  assert.ok(result.warehouses.every((group) => !('quantity' in group)))
})

test('the same key twice fails both rows and nothing is added together', async () => {
  const items = await service(fakePrisma()).preview('items', { fileName: 'items.csv', contentBase64: csv(['SKU,Item name,Unit', 'N-1,Valve,EA', 'N-2,Pump,EA', 'N-1,Valve again,EA']) }, context)
  const rows = byRow(items)
  assert.deepEqual([codes(rows[2]), codes(rows[3]), codes(rows[4])], [['DUPLICATE_ROW'], [], ['DUPLICATE_ROW']])
  const stock = await service(fakePrisma()).preview('opening-stock', { fileName: 'o.csv', contentBase64: csv(['SKU,Warehouse code,Location,Quantity', 'VALVE-100,MAIN,a-09,5', 'VALVE-100,MAIN,A-09 ,7']) }, context)
  assert.deepEqual(stock.rows.map(codes), [['DUPLICATE_ROW'], ['DUPLICATE_ROW']])
  assert.ok(stock.rows.every((row) => row.details.quantity !== '12'))
  const links = await service(fakePrisma()).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'PIPE-200,SUP-001,Yes', 'PIPE-200,SUP-001,No']) }, context)
  assert.deepEqual(links.rows.map(codes), [['DUPLICATE_ROW'], ['DUPLICATE_ROW']])
})

test('existing keys are skipped, not updated', async () => {
  const prisma = fakePrisma()
  const suppliers = await service(prisma).preview('suppliers', { fileName: 's.csv', contentBase64: csv(['Supplier code,Supplier name,Default currency,Payment term code', 'SUP-001,Renamed,USD,NET30', 'SUP-002,New supplier,,NET30', 'SUP-003,Bad term,,NET90']) }, context)
  const rows = byRow(suppliers)
  assert.deepEqual([rows[2].action, rows[2].existing.entity.id], ['skip_existing', 'SUP-1'])
  // An empty supplier currency becomes the workspace currency, shown in the preview.
  assert.deepEqual([rows[3].action, rows[3].details.currency, rows[3].details.currencySource], ['create', 'CNY', 'workspace'])
  assert.deepEqual(codes(rows[4]), ['PAYMENT_TERM_NOT_FOUND'])
  const customers = await service(prisma).preview('customers', { fileName: 'c.csv', contentBase64: csv(['Customer code,Customer name', 'CUST-001,Existing', 'CUST-002,New']) }, context)
  assert.deepEqual(customers.rows.map((row) => row.action), ['skip_existing', 'create'])
  const links = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Reference price,Currency', 'VALVE-100,SUP-001,12.5,', 'PIPE-200,SUP-001,3,EUR', 'NOPE,SUP-001,1,', 'PIPE-200,SUP-404,1,']) }, context)
  const linkRows = byRow(links)
  // A reference price with no currency takes the supplier's default currency.
  assert.deepEqual([linkRows[2].action, linkRows[2].details.currency, linkRows[2].details.currencySource], ['create', 'USD', 'supplier'])
  assert.deepEqual([linkRows[3].details.currency, linkRows[3].details.currencySource], ['EUR', 'file'])
  assert.deepEqual(codes(linkRows[4]), ['ITEM_NOT_FOUND'])
  assert.deepEqual([codes(linkRows[5]), linkRows[5].issues[0].field], [['SUPPLIER_NOT_FOUND'], 'supplierCode'])
  prisma.data.runtimeRecord.push({ id: 'ISR-1', tenantId: TENANT, namespace: 'master-data.item-suppliers', recordKey: 'ITEM-1::SUP-1', payload: {} })
  const again = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code', 'VALVE-100,SUP-001']) }, context)
  assert.deepEqual([again.rows[0].action, again.rows[0].existing.entity.id], ['skip_existing', 'ISR-1'])
})

test('files over a limit are refused with 413 and a code', async () => {
  const prisma = fakePrisma()
  const refused = (code) => (error) => error instanceof DataImportError && error.status === 413 && error.code === code
  await assert.rejects(service(prisma, { env: { FLOWCHAIN_DATA_IMPORT_MAX_ROWS: '2' } }).preview('items', { fileName: 'i.csv', contentBase64: csv(['SKU,Item name,Unit', 'A,a,EA', 'B,b,EA', 'C,c,EA']) }, context), refused('DATA_IMPORT_TOO_MANY_ROWS'))
  await assert.rejects(service(prisma, { env: { FLOWCHAIN_DATA_IMPORT_MAX_FILE_BYTES: '64' } }).preview('items', { fileName: 'i.csv', contentBase64: csv(['SKU,Item name,Unit', ...Array.from({ length: 10 }, (_, index) => `SKU-${index},Item ${index},EA`)]) }, context), refused('DATA_IMPORT_FILE_TOO_LARGE'))
  const wide = Array.from({ length: 51 }, (_, index) => `Extra ${index}`)
  await assert.rejects(service(prisma).preview('items', { fileName: 'i.csv', contentBase64: csv([['SKU', 'Item name', 'Unit', ...wide].join(','), ['A', 'a', 'EA', ...wide.map(() => '')].join(',')]) }, context), refused('DATA_IMPORT_TOO_MANY_COLUMNS'))
  await assert.rejects(service(prisma).preview('items', { fileName: 'i.xls', contentBase64: Buffer.from('not a workbook').toString('base64') }, context), (error) => error.status === 415)
  await assert.rejects(service(prisma).preview('widgets', { fileName: 'i.csv', contentBase64: csv(['A,B', '1,2']) }, context), (error) => error.code === 'DATA_IMPORT_TYPE_UNSUPPORTED')
})

test("another workspace's keys are invisible", async () => {
  const prisma = fakePrisma()
  const items = await service(prisma).preview('items', { fileName: 'i.csv', contentBase64: csv(['SKU,Item name,Unit', 'FOREIGN-1,Same SKU here,EA']) }, context)
  assert.equal(items.rows[0].action, 'create')
  const suppliers = await service(prisma).preview('suppliers', { fileName: 's.csv', contentBase64: csv(['Supplier code,Supplier name,Payment term code', 'SUP-FOREIGN,Same code here,NET60']) }, context)
  assert.deepEqual(codes(suppliers.rows[0]), ['PAYMENT_TERM_NOT_FOUND'])
  assert.equal(suppliers.rows[0].existing, undefined)
  const customers = await service(prisma).preview('customers', { fileName: 'c.csv', contentBase64: csv(['Customer code,Customer name', 'CUST-FOREIGN,Same code here']) }, context)
  assert.equal(customers.rows[0].action, 'create')
  const links = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code', 'FOREIGN-1,SUP-FOREIGN']) }, context)
  assert.deepEqual(codes(links.rows[0]), ['ITEM_NOT_FOUND', 'SUPPLIER_NOT_FOUND'])
  // Every lookup named the session's workspace.
  for (const query of prisma.queries) {
    const tenantId = query.where?.tenantId ?? query.where?.adjustment?.tenantId ?? query.where?.id
    assert.equal(tenantId, TENANT, JSON.stringify(query))
  }
})

test('a customer currency is never guessed', async () => {
  const result = await service(fakePrisma()).preview('customers', { fileName: 'c.csv', contentBase64: csv(['Customer code,Customer name,Currency', 'CUST-010,No currency,', 'CUST-011,Lower case,eur', 'CUST-012,Unknown,ZZZ']) }, context)
  const rows = byRow(result)
  assert.deepEqual([rows[2].action, rows[2].details.currency], ['create', null])
  assert.deepEqual([rows[3].action, rows[3].details.currency], ['create', 'EUR'])
  assert.deepEqual(codes(rows[4]), ['CURRENCY_INVALID'])
  // The command receives no currency at all for the empty cell.
  let received
  const commands = { saveCustomerMaster: async (_prisma, _id, input) => { received = input; return { id: 'RR-NEW', recordKey: input.code, payload: { id: 'CUST-NEW' } } } }
  const prisma = fakePrisma()
  await service(prisma, { commands }).commit('customers', { fileSha256: 'a'.repeat(64), chunkIndex: 0, rows: [{ rowNumber: 2, values: { code: 'CUST-010', name: 'No currency', currency: '' } }] }, context)
  assert.deepEqual(received, { code: 'CUST-010', name: 'No currency' })
})

test('permissions follow the manual form for each record type', async () => {
  const actor = actorWith({ permissions: ['master_data.item.manage'] })
  const file = { fileName: 'c.csv', contentBase64: csv(['Customer code,Customer name', 'CUST-1,X']) }
  await assert.rejects(service(fakePrisma(), { actor }).preview('customers', file, context), (error) => error.status === 403)
  await assert.rejects(service(fakePrisma(), { actor }).preview('opening-stock', file, context), (error) => error.status === 403)
  await assert.rejects(service(fakePrisma(), { actor: actorWith(), env: { FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'false' } }).preview('opening-stock', file, context), (error) => error.code === 'DATA_IMPORT_OPENING_STOCK_UNAVAILABLE')
  await assert.rejects(service(fakePrisma()).preview('items', file, { identity: { authenticated: false } }), (error) => error.status === 401)
})

test('a committed chunk replays its results and a running one answers 409', async () => {
  const prisma = fakePrisma()
  const created = []
  const commands = {
    saveItemMaster: async (_prisma, id, input) => {
      assert.equal(id, null)
      if (input.sku === 'TAKEN') {
        // Another import created it after the check.
        prisma.data.item.push({ id: 'ITEM-TAKEN', tenantId: TENANT, sku: 'TAKEN', name: 'Raced', unit: 'EA', status: 'active' })
        throw Object.assign(new Error('This SKU is already in use.'), { status: 409, code: 'DUPLICATE_SKU' })
      }
      created.push(input.sku)
      prisma.data.item.push({ id: `ITEM-${input.sku}`, tenantId: TENANT, sku: input.sku, name: input.itemName, unit: input.baseUnit, status: 'active' })
      return { id: `ITEM-${input.sku}`, sku: input.sku }
    },
  }
  const body = {
    fileSha256: 'b'.repeat(64),
    chunkIndex: 0,
    rows: [
      { rowNumber: 2, values: { sku: 'NEW-1', itemName: 'Valve', unit: 'EA' } },
      { rowNumber: 3, values: { sku: 'VALVE-100', itemName: 'Existing', unit: 'EA' } },
      { rowNumber: 4, values: { sku: 'TAKEN', itemName: 'Raced', unit: 'EA' } },
    ],
  }
  const first = await service(prisma, { commands }).commit('items', body, context)
  assert.deepEqual(first.rows.map((row) => row.outcome), ['created', 'skipped_existing', 'skipped_existing'])
  assert.deepEqual(first.counts, { rows: 3, created: 1, skipped_existing: 2, error: 0 })
  assert.equal(first.idempotentReplay, false)
  const audit = prisma.data.auditLog.filter((row) => row.action === 'data_import_chunk_committed')
  assert.deepEqual([audit.length, audit[0].metadata.type, audit[0].metadata.fileSha256, audit[0].actorId, audit[0].tenantId], [1, 'items', 'b'.repeat(64), 'user-a', TENANT])
  const replay = await service(prisma, { commands }).commit('items', body, context)
  assert.deepEqual([replay.idempotentReplay, replay.rows], [true, first.rows])
  assert.deepEqual(created, ['NEW-1'])
  // A stored result whose record is gone no longer holds: the chunk runs again.
  prisma.data.item = prisma.data.item.filter((row) => row.sku !== 'NEW-1')
  const rerun = await service(prisma, { commands }).commit('items', body, context)
  assert.deepEqual([rerun.idempotentReplay, rerun.rows[0].outcome], [false, 'created'])
  assert.deepEqual(created, ['NEW-1', 'NEW-1'])
  // A second commit while the first still runs.
  prisma.data.businessCommandExecution.push({ id: 'running', tenantId: TENANT, commandType: 'data_import_items', idempotencyKey: 'x', status: 'pending', createdAt: new Date() })
  const running = prisma.data.businessCommandExecution.find((row) => row.id === 'running')
  const pendingBody = { ...body, chunkIndex: 1 }
  const realCreate = prisma.businessCommandExecution.create
  prisma.businessCommandExecution.create = async (args) => { running.idempotencyKey = args.data.idempotencyKey; running.commandType = args.data.commandType; return realCreate(args) }
  await assert.rejects(service(prisma, { commands }).commit('items', pendingBody, context), (error) => error.status === 409 && error.code === 'DATA_IMPORT_IN_PROGRESS')
  // Left pending by a crash long ago: it can run again, and rows it wrote are skipped.
  running.createdAt = new Date(Date.now() - 60 * 60 * 1000)
  const resumed = await service(prisma, { commands }).commit('items', pendingBody, context)
  assert.equal(resumed.idempotentReplay, false)
})

test('a chunk with a row refused at commit is not stored, so it runs again once the data is fixed', async () => {
  const prisma = fakePrisma()
  let fixed = false
  const commands = {
    saveItemMaster: async (_prisma, _id, input) => {
      if (input.sku === 'BAD' && !fixed) throw Object.assign(new Error('Check the highlighted fields.'), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'baseUnit', code: 'UNIT_REQUIRED', message: 'Enter a unit.' }] })
      prisma.data.item.push({ id: `ITEM-${input.sku}`, tenantId: TENANT, sku: input.sku, name: input.itemName, unit: input.baseUnit, status: 'active' })
      return { id: `ITEM-${input.sku}`, sku: input.sku }
    },
  }
  const body = { fileSha256: 'c'.repeat(64), chunkIndex: 0, rows: [{ rowNumber: 2, values: { sku: 'OK-1', itemName: 'Valve', unit: 'EA' } }, { rowNumber: 3, values: { sku: 'BAD', itemName: 'Broken', unit: 'EA' } }] }
  const first = await service(prisma, { commands }).commit('items', body, context)
  assert.deepEqual(first.rows.map((row) => row.outcome), ['created', 'error'])
  assert.deepEqual(first.rows[1].issues, [{ field: 'unit', code: 'UNIT_REQUIRED', message: 'Enter a unit.' }])
  assert.equal(prisma.data.businessCommandExecution.length, 0)
  fixed = true
  const again = await service(prisma, { commands }).commit('items', body, context)
  assert.deepEqual([again.idempotentReplay, again.rows.map((row) => row.outcome)], [false, ['skipped_existing', 'created']])
  assert.equal(prisma.data.businessCommandExecution[0].status, 'completed')
})

test('opening stock drafts follow the rows sent: a fixed row and a cancelled draft both make a new draft', async () => {
  const prisma = fakePrisma()
  const inputs = []
  const commands = {
    createInventoryAdjustment: async (input) => {
      // The real command refuses a reused key with other lines, and a used number.
      if (inputs.some((entry) => entry.idempotencyKey === input.idempotencyKey)) throw Object.assign(new Error('The idempotency key was already used with a different payload.'), { status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' })
      if (inputs.some((entry) => entry.adjustmentNumber === input.adjustmentNumber)) throw Object.assign(new Error('Number in use.'), { status: 409, code: 'ADJUSTMENT_NUMBER_CONFLICT' })
      inputs.push(input)
      const adjustment = { id: `ADJ-NEW-${inputs.length}`, tenantId: TENANT, adjustmentNumber: input.adjustmentNumber, reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: 'draft' }
      for (const line of input.lines) {
        const item = prisma.data.item.find((row) => row.id === line.itemId)
        prisma.data.inventoryAdjustmentLine.push({ sku: item.sku, warehouseId: line.warehouseId, locationKey: line.location.toLowerCase(), adjustment })
      }
      return { adjustment }
    },
  }
  const file = { fileName: 'opening.csv', contentBase64: csv(['SKU,Warehouse code,Location,Quantity', 'VALVE-100,MAIN,A-02,5', 'LATER-1,MAIN,A-03,2']) }
  const commitChecked = async () => {
    const checked = await service(prisma, { commands }).preview('opening-stock', file, context)
    const rows = checked.rows.filter((row) => row.action !== 'error').map(({ rowNumber, values }) => ({ rowNumber, values }))
    return { checked, result: await service(prisma, { commands }).commit('opening-stock', { fileSha256: checked.fileSha256, chunkIndex: 0, rows }, context) }
  }
  const first = await commitChecked()
  assert.deepEqual(codes(first.checked.rows[1]), ['ITEM_NOT_FOUND'])
  assert.deepEqual(first.result.rows.map((row) => row.outcome), ['created'])
  // The missing item is created and the same file is imported again.
  prisma.data.item.push({ id: 'ITEM-LATER', tenantId: TENANT, sku: 'LATER-1', name: 'Later', unit: 'EA', status: 'active' })
  const second = await commitChecked()
  assert.deepEqual(second.checked.rows.map((row) => row.action), ['skip_existing', 'create'])
  assert.deepEqual(second.result.rows.map((row) => row.outcome), ['skipped_existing', 'created'])
  assert.deepEqual(inputs.map((input) => input.lines.map((line) => line.itemId)), [['ITEM-1'], ['ITEM-LATER']])
  assert.notEqual(inputs[0].adjustmentNumber, inputs[1].adjustmentNumber)
  // The same rows again: the stored result is replayed while its drafts stand.
  assert.equal((await commitChecked()).result.idempotentReplay, true)
  // Both drafts are cancelled: the same file makes a new draft rather than
  // reporting the cancelled ones as created.
  for (const line of prisma.data.inventoryAdjustmentLine) if (line.adjustment.id.startsWith('ADJ-NEW')) line.adjustment.workflowStatus = 'cancelled'
  const afterCancel = await commitChecked()
  assert.equal(afterCancel.result.idempotentReplay, false)
  assert.deepEqual(afterCancel.result.rows.map((row) => row.outcome), ['created', 'created'])
  assert.deepEqual(afterCancel.result.documents.map((document) => document.id), ['ADJ-NEW-3'])
  // That draft is cancelled too and another draft now holds both locations:
  // the stored result is not replayed, the rows point at the other draft.
  for (const line of prisma.data.inventoryAdjustmentLine) if (line.adjustment.id === 'ADJ-NEW-3') line.adjustment.workflowStatus = 'cancelled'
  const other = { id: 'ADJ-OTHER', tenantId: TENANT, adjustmentNumber: 'OB-OTHER', reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: 'draft' }
  prisma.data.inventoryAdjustmentLine.push({ sku: 'VALVE-100', warehouseId: 'WH-A', locationKey: 'a-02', adjustment: other }, { sku: 'LATER-1', warehouseId: 'WH-A', locationKey: 'a-03', adjustment: other })
  const moved = await commitChecked()
  assert.deepEqual([moved.result.idempotentReplay, moved.result.rows.map((row) => [row.outcome, row.document?.id])], [false, [['skipped_existing', 'ADJ-OTHER'], ['skipped_existing', 'ADJ-OTHER']]])
  assert.equal(inputs.length, 3)
})

test('row numbers count blank rows, and an empty column is left out', async () => {
  const prisma = fakePrisma()
  const result = await service(prisma).preview('items', { fileName: 'items.csv', contentBase64: csv(['SKU,Item name,Unit,', 'A-1,Valve,EA,', ',,,', 'A-2,,EA,', '', 'A-3,Pump,EA,']) }, context)
  assert.deepEqual(result.rows.map((row) => [row.rowNumber, row.key]), [[2, 'A-1'], [4, 'A-2'], [6, 'A-3']])
  assert.deepEqual(codes(byRow(result)[4]), ['NAME_REQUIRED'])
  assert.deepEqual(result.columns.map((column) => column.header), ['SKU', 'Item name', 'Unit'])
  // A column with values but no header is named by its position.
  await assert.rejects(service(prisma).preview('items', { fileName: 'items.csv', contentBase64: csv(['SKU,Item name,,Unit', 'A-1,Valve,note,EA']) }, context),
    (error) => error.code === 'DATA_IMPORT_HEADER_BLANK' && error.details.column === 3)
  // A workbook with a blank spacer row.
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['SKU', 'Item name', 'Unit'], ['X-1', 'Valve', 'EA'], [], ['X-2', 'Pump', 'EA']]), 'Items')
  const xlsx = await service(prisma).preview('items', { fileName: 'items.xlsx', contentBase64: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64') }, context)
  assert.deepEqual(xlsx.rows.map((row) => row.rowNumber), [2, 4])
})

test('a workbook is read one sheet at a time, within a grid limit', async () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['SKU', 'Item name', 'Unit'], ['S-1', 'Valve', 'EA']]), 'Items')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['note']]), 'Notes')
  // The second sheet declares the whole Excel grid as its used range.
  const archive = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
  const part = archive.FileIndex[archive.FullPaths.indexOf('Root Entry/xl/worksheets/sheet2.xml')]
  part.content = Buffer.from(Buffer.from(part.content).toString('utf8').replace(/<dimension ref="[^"]*"/, '<dimension ref="A1:XFD1048576"'))
  part.size = part.content.length
  const contentBase64 = Buffer.from(XLSX.CFB.write(archive, { fileType: 'zip', type: 'buffer' })).toString('base64')
  const items = await service(fakePrisma()).preview('items', { fileName: 'w.xlsx', contentBase64, sheetName: 'Items' }, context)
  assert.deepEqual(items.rows.map((row) => row.key), ['S-1'])
  await assert.rejects(service(fakePrisma()).preview('items', { fileName: 'w.xlsx', contentBase64, sheetName: 'Notes' }, context), (error) => error.status === 413 && error.code === 'DATA_IMPORT_FILE_UNSAFE')
})

test('a preferred link never moves the preferred supplier an item already has', async () => {
  const prisma = fakePrisma()
  // PIPE-200 prefers SUP-001 through a link only.
  prisma.data.runtimeRecord.push({ id: 'ISR-P', tenantId: TENANT, namespace: 'master-data.item-suppliers', recordKey: 'ITEM-2::SUP-1', payload: { itemId: 'ITEM-2', supplierId: 'SUP-1', preferred: true } })
  const result = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'VALVE-100,SUP-005,Yes', 'PIPE-200,SUP-005,Yes', 'OLD-1,SUP-005,Yes']) }, context)
  const rows = byRow(result)
  assert.deepEqual([codes(rows[2]), rows[2].issues[0].params], [['PREFERRED_EXISTS'], { supplierCode: 'SUP-001' }])
  assert.deepEqual(codes(rows[3]), ['PREFERRED_EXISTS'])
  // An item with no preferred supplier can take one.
  assert.equal(rows[4].action, 'create')
  const notPreferred = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'VALVE-100,SUP-005,No']) }, context)
  assert.equal(notPreferred.rows[0].action, 'create')
  // The item's own preferred supplier is the row's, but a link prefers
  // another one: saving would demote that link, so the row is refused too.
  prisma.data.item.find((row) => row.id === 'ITEM-2').preferredSupplierId = 'SUP-5'
  const mixed = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'PIPE-200,SUP-005,Yes']) }, context)
  assert.deepEqual([codes(mixed.rows[0]), mixed.rows[0].issues[0].params], [['PREFERRED_EXISTS'], { supplierCode: 'SUP-001' }])
})

test('an XLSX file that unpacks to more than eight times the file limit is refused', async () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['SKU', 'Item name', 'Unit'], ['S-1', 'Valve', 'EA']]), 'Items')
  // About 400 KB of sheet XML that packs into a few KB.
  const archive = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
  const part = archive.FileIndex[archive.FullPaths.indexOf('Root Entry/xl/worksheets/sheet1.xml')]
  part.content = Buffer.from(Buffer.from(part.content).toString('utf8').replace('</worksheet>', `${' '.repeat(400000)}</worksheet>`))
  part.size = part.content.length
  const bytes = Buffer.from(XLSX.CFB.write(archive, { fileType: 'zip', type: 'buffer', compression: true }))
  assert.ok(bytes.length < 20000, String(bytes.length))
  const body = { fileName: 'w.xlsx', contentBase64: bytes.toString('base64') }
  await assert.rejects(service(fakePrisma(), { env: { FLOWCHAIN_DATA_IMPORT_MAX_FILE_BYTES: '20000' } }).preview('items', body, context), (error) => error.status === 413 && error.code === 'DATA_IMPORT_FILE_UNSAFE')
  // Under the default limit the same file is read.
  assert.deepEqual((await service(fakePrisma()).preview('items', body, context)).rows.map((row) => row.key), ['S-1'])
})

// A one-row items workbook as a ZIP archive whose parts a test can change.
function itemsArchive() {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['SKU', 'Item name', 'Unit'], ['S-1', 'Valve', 'EA']]), 'Items')
  return XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
}
const archivePart = (archive, name) => archive.FileIndex[archive.FullPaths.indexOf(`Root Entry/${name}`)]
function setArchivePart(archive, name, text) {
  const part = archivePart(archive, name)
  part.content = Buffer.from(text)
  part.size = part.content.length
}
const zipBytes = (archive) => Buffer.from(XLSX.CFB.write(archive, { fileType: 'zip', type: 'buffer', compression: true }))
// Writes a smaller uncompressed size for one entry into both its local and
// central headers, as a crafted archive would.
function misdeclare(bytes, name, size) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let offset = bytes.readUInt32LE(end + 16)
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    const nameLength = bytes.readUInt16LE(offset + 28)
    if (bytes.subarray(offset + 46, offset + 46 + nameLength).toString() === name) {
      bytes.writeUInt32LE(size, offset + 24)
      bytes.writeUInt32LE(size, bytes.readUInt32LE(offset + 42) + 22)
    }
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
  return bytes
}
// Moves the Items sheet to another part name, through the relationships.
function renameSheetPart(archive, target, transform = (xml) => xml) {
  const xml = Buffer.from(archivePart(archive, 'xl/worksheets/sheet1.xml').content).toString('utf8')
  XLSX.CFB.utils.cfb_del(archive, '/xl/worksheets/sheet1.xml')
  XLSX.CFB.utils.cfb_add(archive, `/xl/worksheets/${target}`, Buffer.from(transform(xml)))
  for (const name of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    setArchivePart(archive, name, Buffer.from(archivePart(archive, name).content).toString('utf8').replaceAll('worksheets/sheet1.xml', `worksheets/${target}`))
  }
  return archive
}

test('an XLSX part larger than it declares is refused before it is unpacked', async () => {
  const archive = itemsArchive()
  // 8 MB of XML declared as 4 KB, in a part the importer does not use.
  XLSX.CFB.utils.cfb_add(archive, '/xl/pad.xml', Buffer.alloc(8 * 1024 * 1024, 0x20))
  const bytes = misdeclare(zipBytes(archive), 'xl/pad.xml', 4096)
  assert.ok(bytes.length < 2 * 1024 * 1024, String(bytes.length))
  await assert.rejects(service(fakePrisma()).preview('items', { fileName: 'w.xlsx', contentBase64: bytes.toString('base64') }, context),
    (error) => error.status === 422 && error.code === 'DATA_IMPORT_FILE_UNREADABLE')
  // Declared truthfully, the same part counts against the unpacked limit.
  const honest = zipBytes(archive)
  await assert.rejects(service(fakePrisma(), { env: { FLOWCHAIN_DATA_IMPORT_MAX_FILE_BYTES: String(honest.length + 1) } }).preview('items', { fileName: 'w.xlsx', contentBase64: honest.toString('base64') }, context),
    (error) => error.status === 413 && error.code === 'DATA_IMPORT_FILE_UNSAFE')
})

test('the grid limit applies to the sheet part the relationships name', async () => {
  const preview = (archive) => service(fakePrisma()).preview('items', { fileName: 'w.xlsx', contentBase64: zipBytes(archive).toString('base64') }, context)
  const unsafe = (error) => error.status === 413 && error.code === 'DATA_IMPORT_FILE_UNSAFE'
  // A sheet part with another name is found and read.
  assert.deepEqual((await preview(renameSheetPart(itemsArchive(), 'data.xml'))).rows.map((row) => row.key), ['S-1'])
  // Its declared used range counts, whatever the part is called.
  for (const ref of ['A1:Z120000', 'A1:XFD1048576']) {
    await assert.rejects(preview(renameSheetPart(itemsArchive(), 'data.xml', (xml) => xml.replace(/<dimension ref="[^"]*"/, `<dimension ref="${ref}"`))), unsafe)
  }
  // A small decoy at sheet1.xml does not stand in for the real part.
  const decoy = renameSheetPart(itemsArchive(), 'sheet2.xml', (xml) => xml.replace(/<dimension ref="[^"]*"/, '<dimension ref="A1:Z120000"'))
  XLSX.CFB.utils.cfb_add(decoy, '/xl/worksheets/sheet1.xml', Buffer.from(archivePart(itemsArchive(), 'xl/worksheets/sheet1.xml').content))
  await assert.rejects(preview(decoy), unsafe)
  // A namespace prefix or an encoded reference does not hide a cell.
  await assert.rejects(preview(renameSheetPart(itemsArchive(), 'data.xml', (xml) => xml.replace('</sheetData>', '<row r="3"><x:c xmlns:x="urn:x" r="&#88;FD1048576"/></row></sheetData>'))), unsafe)
  // A sheet whose part is missing from the archive is refused.
  const missing = itemsArchive()
  XLSX.CFB.utils.cfb_del(missing, '/xl/worksheets/sheet1.xml')
  await assert.rejects(preview(missing), (error) => error.status === 422 && error.code === 'DATA_IMPORT_FILE_UNREADABLE')
})

test("a new link for the item's own preferred supplier never clears it", async () => {
  // VALVE-100 prefers SUP-001 on the item, with no link.
  const prisma = fakePrisma()
  const result = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'VALVE-100,SUP-001,']) }, context)
  assert.deepEqual([result.rows[0].action, result.rows[0].details.preferred, result.rows[0].details.preferredSource], ['create', true, 'item'])
  const no = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'VALVE-100,SUP-001,No']) }, context)
  assert.deepEqual([codes(no.rows[0]), no.rows[0].issues[0].params], [['PREFERRED_WOULD_CLEAR'], { supplierCode: 'SUP-001' }])
  // Without a Preferred column, the same.
  const noColumn = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code', 'VALVE-100,SUP-001']) }, context)
  assert.deepEqual([noColumn.rows[0].action, noColumn.rows[0].details.preferredSource], ['create', 'item'])
  // Yes is the file's own value; another supplier is not affected.
  const yes = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'VALVE-100,SUP-001,Yes', 'PIPE-200,SUP-005,']) }, context)
  assert.deepEqual(yes.rows.map((row) => [row.action, row.details.preferred, row.details.preferredSource]), [['create', true, 'file'], ['create', null, null]])
  // The command is asked to keep the supplier preferred.
  let received
  const commands = { saveItemSupplier: async (_prisma, _item, _id, input) => { received = input; return { relationshipId: 'ISR-NEW' } } }
  await service(prisma, { commands }).commit('item-suppliers', { fileSha256: 'b'.repeat(64), chunkIndex: 0, rows: [{ rowNumber: 2, values: { sku: 'VALVE-100', supplierCode: 'SUP-001', preferred: '' } }] }, context)
  assert.equal(received.preferred, true)
  // A link preferring another supplier still stops the row.
  prisma.data.runtimeRecord.push({ id: 'ISR-5', tenantId: TENANT, namespace: 'master-data.item-suppliers', recordKey: 'ITEM-1::SUP-5', payload: { itemId: 'ITEM-1', supplierId: 'SUP-5', preferred: true } })
  const conflicting = await service(prisma).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code', 'VALVE-100,SUP-001']) }, context)
  assert.deepEqual(codes(conflicting.rows[0]), ['PREFERRED_EXISTS'])
})

test('an inactive warehouse the importer cannot operate is reported as out of scope', async () => {
  const prisma = fakePrisma()
  prisma.data.warehouse.push({ id: 'WH-N', tenantId: TENANT, code: 'NORTH', name: 'North', status: 'inactive' })
  const result = await service(prisma).preview('opening-stock', { fileName: 'o.csv', contentBase64: csv(['SKU,Warehouse code,Location,Quantity', 'VALVE-100,NORTH,A-01,1']) }, context)
  assert.deepEqual([codes(result.rows[0]), result.rows[0].details.warehouseName], [['WAREHOUSE_SCOPE_DENIED'], null])
})
