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
    { id: 'ITEM-1', tenantId: TENANT, sku: 'VALVE-100', name: 'Ball valve', unit: 'EA', status: 'active' },
    { id: 'ITEM-2', tenantId: TENANT, sku: 'PIPE-200', name: 'Pipe', unit: 'm', status: 'active' },
    { id: 'ITEM-OLD', tenantId: TENANT, sku: 'OLD-1', name: 'Retired', unit: 'EA', status: 'inactive' },
    { id: 'ITEM-B', tenantId: OTHER, sku: 'FOREIGN-1', name: 'Other workspace item', unit: 'EA', status: 'active' },
  ],
  supplier: [
    { id: 'SUP-1', tenantId: TENANT, code: 'SUP-001', status: 'active', metadata: { defaultCurrency: 'USD' } },
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
  ],
  inventoryMovement: [],
  inventoryAdjustmentLine: [
    { sku: 'PIPE-200', warehouseId: 'WH-A', locationKey: 'c-01', adjustment: { id: 'ADJ-1', tenantId: TENANT, adjustmentNumber: 'OB-1', reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: 'draft' } },
  ],
  businessCommandExecution: [],
  auditLog: [],
})

// Matches the where clauses the service uses: equality, { in }, { not },
// { lt } and a nested relation filter.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key]
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition) return condition.in.includes(value)
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
const service = (prisma, { actor = actorWith(), env = {}, commands } = {}) =>
  createDataImportService({ prisma, env: { FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true', ...env }, resolveActor: async () => actor, commands, idFactory: (() => { let id = 0; return () => `id-${++id}` })() })
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
  assert.deepEqual(codes(rows[8]), ['WAREHOUSE_SCOPE_DENIED'])
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
  const links = await service(fakePrisma()).preview('item-suppliers', { fileName: 'l.csv', contentBase64: csv(['SKU,Supplier code,Preferred', 'VALVE-100,SUP-001,Yes', 'VALVE-100,SUP-001,No']) }, context)
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
      if (input.sku === 'TAKEN') throw Object.assign(new Error('This SKU is already in use.'), { status: 409, code: 'DUPLICATE_SKU' })
      if (input.sku === 'BAD') throw Object.assign(new Error('Check the highlighted fields.'), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'baseUnit', code: 'UNIT_REQUIRED', message: 'Enter a unit.' }] })
      created.push(input.sku)
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
      { rowNumber: 5, values: { sku: 'BAD', itemName: 'Broken', unit: 'EA' } },
    ],
  }
  const first = await service(prisma, { commands }).commit('items', body, context)
  assert.deepEqual(first.rows.map((row) => row.outcome), ['created', 'skipped_existing', 'skipped_existing', 'error'])
  assert.deepEqual(first.rows[3].issues, [{ field: 'unit', code: 'UNIT_REQUIRED', message: 'Enter a unit.' }])
  assert.deepEqual(first.counts, { rows: 4, created: 1, skipped_existing: 2, error: 1 })
  assert.equal(first.idempotentReplay, false)
  const audit = prisma.data.auditLog.filter((row) => row.action === 'data_import_chunk_committed')
  assert.deepEqual([audit.length, audit[0].metadata.type, audit[0].metadata.fileSha256, audit[0].actorId, audit[0].tenantId], [1, 'items', 'b'.repeat(64), 'user-a', TENANT])
  const replay = await service(prisma, { commands }).commit('items', body, context)
  assert.deepEqual([replay.idempotentReplay, replay.rows], [true, first.rows])
  assert.deepEqual(created, ['NEW-1'])
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
