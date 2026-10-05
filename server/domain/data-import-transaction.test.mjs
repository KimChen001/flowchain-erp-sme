import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createScmServer } from '../bootstrap/scm-server.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../persistence/prisma-client.mjs'
import { realPostgresSuiteGate } from '../persistence/test-db-harness.mjs'

// The CSV import against PostgreSQL, through the HTTP routes and the real
// manual-entry and adjustment commands: replay, re-upload, audit rows,
// concurrent commits, opening stock drafts, warehouse scope and permissions.
const gate = realPostgresSuiteGate('npm run test:db:data-import')

if (!gate.enabled) {
  if (gate.failure) test('data import PostgreSQL suite is misconfigured', () => { throw new Error(gate.failure) })
  else test('data import PostgreSQL transactions run in the isolated test:db:data-import gate', { skip: gate.skipReason }, () => {})
} else {
  const tenantA = 'tenant-data-import-a'
  const tenantB = 'tenant-data-import-b'

  const csv = (lines) => Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8').toString('base64')

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
          resolve({ status: res.statusCode, payload, headers: res.headers })
        })
      })
      req.on('error', reject)
      req.end(raw)
    })
  }

  async function seed(prisma) {
    for (const [tenantId, tag] of [[tenantA, 'a'], [tenantB, 'b']]) {
      await prisma.tenant.create({ data: { id: tenantId, name: `Import ${tag}`, currency: 'USD' } })
      await prisma.user.createMany({ data: [
        { id: `${tenantId}-manager`, tenantId, email: `importer-${tag}@example.com`, name: `Importer ${tag}`, role: 'manager' },
        { id: `${tenantId}-viewer`, tenantId, email: `viewer-${tag}@example.com`, name: `Viewer ${tag}`, role: 'viewer' },
      ] })
    }
    // The other workspace already uses the same codes; they must not count.
    await prisma.item.create({ data: { id: 'ITEM-B-1', tenantId: tenantB, sku: 'IMP-1', name: 'Foreign item', unit: 'EA' } })
    await prisma.supplier.create({ data: { id: 'SUP-B-1', tenantId: tenantB, code: 'IMP-SUP-1', name: 'Foreign supplier', metadata: { defaultCurrency: 'EUR' } } })
    await prisma.paymentTerm.create({ data: { id: 'TERM-A-30', tenantId: tenantA, code: 'NET30', name: 'Net 30', days: 30 } })
    await prisma.warehouse.createMany({ data: [
      { id: 'WH-IMP-A', tenantId: tenantA, code: 'MAIN', name: 'Main', status: 'active' },
      { id: 'WH-IMP-B', tenantId: tenantA, code: 'EAST', name: 'East', status: 'active' },
      { id: 'WH-IMP-C', tenantId: tenantA, code: 'WEST', name: 'West', status: 'active' },
    ] })
    // The importer may operate Main and East, not West.
    await prisma.userWarehouseScope.createMany({ data: ['WH-IMP-A', 'WH-IMP-B'].map((warehouseId, index) => ({ id: `scope-imp-${index}`, tenantId: tenantA, userId: `${tenantA}-manager`, warehouseId, accessLevel: 'operate' })) })
  }

  test('the CSV import creates records through the manual-entry commands, once', async () => {
    const previous = { tenant: process.env.FLOWCHAIN_DEFAULT_TENANT_ID, importFlag: process.env.FLOWCHAIN_ENABLE_DATA_IMPORT, inventoryFlag: process.env.FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS }
    const prisma = await createPrismaClient(process.env)
    let server
    try {
      await seed(prisma)
      Object.assign(process.env, { FLOWCHAIN_DEFAULT_TENANT_ID: tenantA, FLOWCHAIN_ENABLE_DATA_IMPORT: 'true', FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true' })
      server = createScmServer()
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const signIn = async (email) => {
        const login = await request(port, 'POST', '/api/auth/login', { body: { email, name: 'Ignored', company: 'Ignored' } })
        assert.equal(login.status, 200, JSON.stringify(login.payload))
        assert.equal(login.payload.user.tenantId, tenantA)
        return (method, path, body) => request(port, method, path, { headers: { Authorization: `Bearer ${login.payload.token}` }, body })
      }
      const call = await signIn('importer-a@example.com')
      const preview = async (type, lines, extra = {}) => {
        const response = await call('POST', `/api/data-import/${type}/preview`, { fileName: `${type}.csv`, contentBase64: csv(lines), ...extra })
        assert.equal(response.status, 200, JSON.stringify(response.payload))
        return response.payload
      }
      const commitAll = async (type, checked) => {
        const rows = checked.rows.filter((row) => row.action !== 'error').map(({ rowNumber, values }) => ({ rowNumber, values }))
        const response = await call('POST', `/api/data-import/${type}/commit`, { fileSha256: checked.fileSha256, chunkIndex: 0, rows })
        assert.equal(response.status, 200, JSON.stringify(response.payload))
        return response.payload
      }

      // The template downloads as a CSV.
      const template = await call('GET', '/api/data-import/templates/items?language=zh-CN')
      assert.equal(template.status, 200)
      assert.match(template.headers['content-type'], /^text\/csv/)
      assert.ok(String(template.payload).startsWith('﻿SKU,物料名称,物料分类'))

      // Items: a preview writes nothing.
      const itemLines = ['SKU,Item name,Unit,Safety stock,Status', 'IMP-1,Gate valve,EA,5,Active', 'IMP-2,Check valve,EA,,Draft', 'IMP-3,Bad number,EA,"1,000",Active']
      const itemsChecked = await preview('items', itemLines)
      assert.deepEqual(itemsChecked.rows.map((row) => row.action), ['create', 'create', 'error'])
      assert.equal(await prisma.item.count({ where: { tenantId: tenantA } }), 0)
      const firstCommit = await commitAll('items', itemsChecked)
      assert.deepEqual(firstCommit.rows.map((row) => row.outcome), ['created', 'created'])
      assert.equal(firstCommit.idempotentReplay, false)
      const items = await prisma.item.findMany({ where: { tenantId: tenantA }, orderBy: { sku: 'asc' } })
      assert.deepEqual(items.map((row) => [row.sku, row.unit, row.status, row.safetyStock === null ? null : Number(row.safetyStock)]), [['IMP-1', 'EA', 'active', 5], ['IMP-2', 'EA', 'draft', null]])
      // Every created record has its own audit row, and the chunk has one.
      for (const item of items) assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantA, entityType: 'item', entityId: item.id, action: 'create' } }), 1)
      const chunkAudit = await prisma.auditLog.findMany({ where: { tenantId: tenantA, action: 'data_import_chunk_committed' } })
      assert.deepEqual([chunkAudit.length, chunkAudit[0].actorId, chunkAudit[0].metadata.type, chunkAudit[0].metadata.counts.created], [1, `${tenantA}-manager`, 'items', 2])
      // Committing the same chunk again replays the stored result.
      const replay = await commitAll('items', itemsChecked)
      assert.deepEqual([replay.idempotentReplay, replay.rows], [true, firstCommit.rows])
      assert.equal(await prisma.item.count({ where: { tenantId: tenantA } }), 2)
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantA, action: 'data_import_chunk_committed' } }), 1)
      // An edited file: existing rows are skipped and never updated.
      const edited = await preview('items', ['SKU,Item name,Unit', 'IMP-1,Renamed valve,EA', 'IMP-4,Ball valve,EA'])
      assert.deepEqual(edited.rows.map((row) => row.action), ['skip_existing', 'create'])
      const editedCommit = await commitAll('items', edited)
      assert.deepEqual(editedCommit.rows.map((row) => row.outcome), ['skipped_existing', 'created'])
      assert.equal((await prisma.item.findFirst({ where: { tenantId: tenantA, sku: 'IMP-1' } })).name, 'Gate valve')
      assert.equal(await prisma.item.count({ where: { tenantId: tenantA } }), 3)
      assert.equal((await prisma.item.findFirst({ where: { tenantId: tenantB, sku: 'IMP-1' } })).name, 'Foreign item')

      // Two commits of the same chunk at once: one runs, the other gets 409.
      const many = await preview('items', ['SKU,Item name,Unit', ...Array.from({ length: 120 }, (_, index) => `BULK-${index},Bulk item ${index},EA`)])
      const bulkRows = many.rows.map(({ rowNumber, values }) => ({ rowNumber, values }))
      const parallel = await Promise.all([0, 1].map(() => call('POST', '/api/data-import/items/commit', { fileSha256: many.fileSha256, chunkIndex: 0, rows: bulkRows })))
      assert.deepEqual(parallel.map((response) => response.status).sort(), [200, 409], JSON.stringify(parallel.map((response) => response.payload.code)))
      assert.equal(parallel.find((response) => response.status === 409).payload.code, 'DATA_IMPORT_IN_PROGRESS')
      assert.equal(await prisma.item.count({ where: { tenantId: tenantA, sku: { startsWith: 'BULK-' } } }), 120)

      // Suppliers, customers and item suppliers, in import order.
      const suppliers = await commitAll('suppliers', await preview('suppliers', ['Supplier code,Supplier name,Payment term code,Default currency', 'IMP-SUP-1,Boston Components,NET30,', 'IMP-SUP-2,Euro Parts,,EUR']))
      assert.deepEqual(suppliers.rows.map((row) => row.outcome), ['created', 'created'])
      const supplier = await prisma.supplier.findFirst({ where: { tenantId: tenantA, code: 'IMP-SUP-1' } })
      // An empty currency is the workspace currency; the term code is stored as its id.
      assert.deepEqual([supplier.metadata.defaultCurrency, supplier.metadata.paymentTermsId], ['USD', 'TERM-A-30'])
      const customers = await commitAll('customers', await preview('customers', ['Customer code,Customer name,Currency', 'IMP-CUST-1,Redwood Retail,']))
      assert.deepEqual(customers.rows.map((row) => row.outcome), ['created'])
      const customer = await prisma.runtimeRecord.findFirst({ where: { tenantId: tenantA, namespace: 'master-data.customers', recordKey: 'IMP-CUST-1' } })
      assert.equal(customer.payload.currency, undefined)
      const links = await commitAll('item-suppliers', await preview('item-suppliers', ['SKU,Supplier code,Reference price,Preferred', 'IMP-1,IMP-SUP-1,12.5,Yes', 'IMP-2,IMP-SUP-2,3,No']))
      assert.deepEqual(links.rows.map((row) => row.outcome), ['created', 'created'])
      assert.equal((await prisma.item.findFirst({ where: { tenantId: tenantA, sku: 'IMP-1' } })).preferredSupplierId, supplier.id)
      const relationships = await prisma.runtimeRecord.findMany({ where: { tenantId: tenantA, namespace: 'master-data.item-suppliers' }, orderBy: { recordKey: 'asc' } })
      assert.deepEqual(relationships.map((row) => row.payload.currency).sort(), ['EUR', 'USD'])

      // Opening stock: one draft adjustment per warehouse, nothing posted.
      const openingLines = ['SKU,Warehouse code,Location,Quantity,Unit', 'IMP-1,MAIN,A-01,12,EA', 'IMP-4,MAIN,A-02,3.5,', 'IMP-1,EAST,E-01,4,', 'IMP-1,WEST,W-01,9,', 'IMP-4,MAIN,A-03,2,PCS', 'IMP-2,MAIN,A-04,1,']
      const opening = await preview('opening-stock', openingLines)
      assert.deepEqual(opening.rows.map((row) => row.action), ['create', 'create', 'create', 'error', 'error', 'error'])
      assert.deepEqual(opening.rows[3].issues.map((entry) => entry.code), ['WAREHOUSE_SCOPE_DENIED'])
      assert.deepEqual(opening.rows[4].issues.map((entry) => entry.code), ['UNIT_MISMATCH'])
      // The draft item IMP-2 cannot take stock until someone activates it.
      assert.deepEqual(opening.rows[5].issues.map((entry) => entry.code), ['ITEM_INACTIVE'])
      const openingCommit = await commitAll('opening-stock', opening)
      assert.deepEqual(openingCommit.rows.map((row) => row.outcome), ['created', 'created', 'created'])
      assert.equal(openingCommit.documents.length, 2)
      const drafts = await prisma.inventoryAdjustmentDocument.findMany({ where: { tenantId: tenantA }, include: { lines: true }, orderBy: { adjustmentNumber: 'asc' } })
      assert.equal(drafts.length, 2)
      for (const draft of drafts) {
        assert.deepEqual([draft.reasonCode, draft.workflowStatus, draft.postingStatus], ['opening_balance', 'draft', 'unposted'])
        assert.ok(draft.lines.every((line) => line.inventoryBalanceId === null))
      }
      assert.deepEqual(drafts.map((draft) => draft.lines.length).sort(), [1, 2])
      assert.equal(await prisma.inventoryBalance.count({ where: { tenantId: tenantA } }), 0)
      assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: tenantA } }), 0)
      // Uploading the same file again returns the same documents.
      const openingAgain = await commitAll('opening-stock', opening)
      assert.equal(openingAgain.idempotentReplay, true)
      assert.deepEqual(openingAgain.documents.map((row) => row.id).sort(), drafts.map((row) => row.id).sort())
      // An edited file sees the rows already in a draft and links to it.
      const reupload = await preview('opening-stock', [...openingLines.slice(0, 3), 'IMP-1,MAIN,A-09,1,'])
      assert.deepEqual(reupload.rows.map((row) => row.action), ['skip_existing', 'skip_existing', 'create'])
      assert.equal(reupload.rows[0].existing.reason, 'IN_OPENING_DRAFT')
      assert.ok(drafts.some((draft) => draft.id === reupload.rows[0].existing.document.id))
      assert.equal(await prisma.inventoryAdjustmentDocument.count({ where: { tenantId: tenantA } }), 2)

      // A user without the permission is refused before anything is read.
      const viewer = await signIn('viewer-a@example.com')
      for (const type of ['items', 'suppliers', 'customers', 'item-suppliers', 'opening-stock']) {
        const refused = await viewer('POST', `/api/data-import/${type}/preview`, { fileName: 'x.csv', contentBase64: csv(['SKU,Item name,Unit', 'V-1,Valve,EA']) })
        assert.equal(refused.status, 403, `${type} ${JSON.stringify(refused.payload)}`)
        const refusedCommit = await viewer('POST', `/api/data-import/${type}/commit`, { fileSha256: 'c'.repeat(64), chunkIndex: 0, rows: [{ rowNumber: 2, values: { sku: 'V-1' } }] })
        assert.equal(refusedCommit.status, 403, type)
      }
      assert.equal(await prisma.item.count({ where: { tenantId: tenantA, sku: 'V-1' } }), 0)

      // The import is off without its flag; Universal Intake's route is untouched.
      process.env.FLOWCHAIN_ENABLE_DATA_IMPORT = 'false'
      const off = await call('POST', '/api/data-import/items/preview', { fileName: 'x.csv', contentBase64: csv(itemLines) })
      assert.deepEqual([off.status, off.payload.code], [409, 'DATA_IMPORT_NOT_ENABLED'])
      const legacy = await call('POST', '/api/imports/items/commit', {})
      assert.equal(legacy.status, 501)
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve))
      for (const [key, value] of [['FLOWCHAIN_DEFAULT_TENANT_ID', previous.tenant], ['FLOWCHAIN_ENABLE_DATA_IMPORT', previous.importFlag], ['FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS', previous.inventoryFlag]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await disconnectPrismaClient()
      await prisma.$disconnect()
    }
  })
}
