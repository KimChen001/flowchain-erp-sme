import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import pg from 'pg'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { createPriceHistoryReadService, readPriceHistoryLines } from '../../server/domain/price-history-read-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// A purchase order keeps the instant it was issued to the supplier. The Issue
// action writes it once, a database trigger refuses a change, and POs issued
// before the column existed are backfilled from the records of the issue.
// Run with: npm run test:db:po-issued-at

const migrationName = '20261006010000_purchase_order_issued_at'
const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const migrationSql = (name) => readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), 'utf8')

const tenantA = 'tenant-issued-at-a'
const tenantB = 'tenant-issued-at-b'
const people = {
  buyer: { id: 'issued-buyer-a', tenantId: tenantA, email: 'buyer@issued-at.invalid', name: 'Blake Buyer', role: 'buyer' },
  manager: { id: 'issued-manager-a', tenantId: tenantA, email: 'manager@issued-at.invalid', name: 'Morgan Manager', role: 'admin' },
  viewer: { id: 'issued-viewer-a', tenantId: tenantA, email: 'viewer@issued-at.invalid', name: 'Vic Viewer', role: 'viewer' },
  finance: { id: 'issued-finance-a', tenantId: tenantA, email: 'finance@issued-at.invalid', name: 'Fin Finance', role: 'finance-specialist' },
  otherBuyer: { id: 'issued-buyer-b', tenantId: tenantB, email: 'buyer@other-issued-at.invalid', name: 'Other Buyer', role: 'buyer' },
}
const contextOf = (user) => ({ identity: { authenticated: true, tenantId: user.tenantId, userId: user.id, role: user.role } })

// Replays every migration before this one on a throwaway database.
async function withUpgradeDatabase(prefix, run) {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  const upgradeDatabase = `${prefix}_${randomUUID().replace(/-/g, '')}`
  const upgradeUrl = new URL(process.env.DATABASE_URL_TEST)
  upgradeUrl.pathname = `/${upgradeDatabase}`
  const client = new pg.Client({ connectionString: upgradeUrl.toString() })
  try {
    await admin.connect()
    await admin.query(`CREATE DATABASE "${upgradeDatabase}"`)
    await client.connect()
    const earlier = readdirSync(migrationsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name < migrationName).map((entry) => entry.name).sort()
    for (const name of earlier) await client.query(migrationSql(name))
    await run(client)
  } finally {
    await client.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`).catch(() => {})
    await admin.end().catch(() => {})
  }
}

test('the backfill takes the first record of the issue that exists, else leaves the date empty', async () => {
  await withUpgradeDatabase('flowchain_issued_at_backfill', async (client) => {
    await client.query(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('upgrade-tenant', 'Upgrade', NOW()), ('upgrade-other', 'Other', NOW())`)
    const po = (id, status, metadata, tenantId = 'upgrade-tenant') => client.query(`INSERT INTO "PurchaseOrder" (id, "tenantId", status, metadata, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, '2026-08-01T09:00:00Z', NOW())`, [id, tenantId, status, JSON.stringify(metadata)])
    const audit = (id, poId, createdAt, { tenantId = 'upgrade-tenant', action = 'purchase_order_issue', entityType = 'PurchaseOrder' } = {}) => client.query(`INSERT INTO "AuditLog" (id, "tenantId", source, action, "entityType", "entityId", summary, "createdAt") VALUES ($1, $2, 'test', $3, $4, $5, 'issue', $6)`, [id, tenantId, action, entityType, poId, createdAt])
    const issueStep = (at) => ({ action: 'issue', actorId: 'someone', at })

    // 1. metadata.issuedAt wins over the audit row and the timeline.
    await po('po-metadata', 'issued', { transmissionStatus: 'issued_outside_flowchain', issuedAt: '2026-08-02T14:30:00.000Z', approvalTimeline: [issueStep('2026-08-05T10:00:00.000Z')] })
    await audit('audit-metadata', 'po-metadata', '2026-08-04T10:00:00Z')
    // 2. Without metadata, the earliest issue audit row of the same workspace.
    await po('po-audit', 'partially_received', { issuedAt: 'not a date', approvalTimeline: [issueStep('2026-08-09T10:00:00.000Z')] })
    await audit('audit-late', 'po-audit', '2026-08-07T10:00:00Z')
    await audit('audit-early', 'po-audit', '2026-08-06T10:00:00Z')
    await audit('audit-approve', 'po-audit', '2026-08-03T10:00:00Z', { action: 'purchase_order_approve' })
    await audit('audit-other-tenant', 'po-audit', '2026-08-01T10:00:00Z', { tenantId: 'upgrade-other' })
    await audit('audit-other-entity', 'po-audit', '2026-08-01T11:00:00Z', { entityType: 'PurchaseRequest' })
    // 3. Without either, the first issue step of the approval timeline.
    await po('po-timeline', 'closed', { approvalTimeline: [{ action: 'approve', at: '2026-08-08T10:00:00.000Z' }, issueStep('bad'), issueStep('2026-08-10T16:45:00.000Z'), issueStep('2026-08-11T10:00:00.000Z')] })
    // Nothing on record: seeded as issued, and received without being issued.
    await po('po-seeded', 'issued', { transmissionStatus: 'sent' })
    await po('po-received-unissued', 'fully_received', { approvalTimeline: [{ action: 'approve', at: '2026-08-08T10:00:00.000Z' }] })
    await po('po-timeline-not-array', 'issued', { approvalTimeline: { action: 'issue', at: '2026-08-08T10:00:00.000Z' } })
    await po('po-draft', 'draft', {})

    await client.query(migrationSql(migrationName))

    const rows = (await client.query(`SELECT id, to_char("issuedAt", 'YYYY-MM-DD HH24:MI') AS issued FROM "PurchaseOrder" ORDER BY id`)).rows
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.issued])), {
      'po-audit': '2026-08-06 10:00',
      'po-draft': null,
      'po-metadata': '2026-08-02 14:30',
      'po-received-unissued': null,
      'po-seeded': null,
      'po-timeline': '2026-08-10 16:45',
      'po-timeline-not-array': null,
    })
    // The helper is gone; the date is fixed once set and other columns still change.
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_proc WHERE proname = 'flowchain_backfill_issued_instant'`)).rows[0].count, 0)
    await assert.rejects(client.query(`UPDATE "PurchaseOrder" SET "issuedAt" = '2026-09-01T00:00:00Z' WHERE id = 'po-metadata'`), /cannot be changed/)
    await assert.rejects(client.query(`UPDATE "PurchaseOrder" SET "issuedAt" = NULL WHERE id = 'po-metadata'`), /cannot be changed/)
    await client.query(`UPDATE "PurchaseOrder" SET status = 'closed' WHERE id = 'po-metadata'`)
    // An empty date can still be recorded once.
    await client.query(`UPDATE "PurchaseOrder" SET "issuedAt" = '2026-09-01T00:00:00Z' WHERE id = 'po-seeded'`)
  })
})

test('issuing writes the issue date once; a replay keeps it and nothing overwrites it', async (t) => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  let clock = new Date('2026-10-01T14:00:00.000Z')
  const service = createDbProcurementCommandService({ prisma, env: process.env, now: () => clock })
  const po = (id, status, tenantId = tenantA) => prisma.purchaseOrder.create({
    data: { id, tenantId, status, receivingBaseStatus: status, supplierId: 'issued-supplier', supplierName: 'Issued Supplier', currency: 'USD', amount: 100, lines: { create: [{ id: `${id}-L1`, sku: 'SKU-1', itemName: 'Item 1', orderedQuantity: 10, receivedQuantity: 0, unit: 'pcs', unitPrice: 10, amount: 100 }] } },
  })
  try {
    for (const tenantId of [tenantA, tenantB]) await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const user of Object.values(people)) await prisma.user.create({ data: user })
    await backfillTenantAuthorization(prisma, tenantA, { actorId: people.buyer.id })
    await backfillTenantAuthorization(prisma, tenantB, { actorId: people.otherBuyer.id })

    await t.test('the Issue action records the instant on the column, in metadata and on the read model', async () => {
      await po('ISSUED-AT-1', 'approved')
      const before = await service.readPurchaseOrder('ISSUED-AT-1', contextOf(people.buyer))
      assert.equal(before.issuedAt, null)
      const issued = await service.issuePurchaseOrder('ISSUED-AT-1', { expectedVersion: 0, idempotencyKey: 'issue-at-1' }, contextOf(people.buyer))
      assert.equal(issued.purchaseOrder.issuedAt, '2026-10-01T14:00:00.000Z')
      const row = await prisma.purchaseOrder.findUnique({ where: { id: 'ISSUED-AT-1' } })
      assert.equal(row.issuedAt.toISOString(), '2026-10-01T14:00:00.000Z')
      assert.equal(row.metadata.issuedAt, '2026-10-01T14:00:00.000Z')
    })

    await t.test('a replay of the same command returns the first result and keeps the date', async () => {
      clock = new Date('2026-10-03T09:00:00.000Z')
      const replay = await service.issuePurchaseOrder('ISSUED-AT-1', { expectedVersion: 0, idempotencyKey: 'issue-at-1' }, contextOf(people.buyer))
      assert.equal(replay.idempotentReplay, true)
      assert.equal(replay.purchaseOrder.issuedAt, '2026-10-01T14:00:00.000Z')
      // An issued PO cannot be issued again.
      await assert.rejects(service.issuePurchaseOrder('ISSUED-AT-1', { expectedVersion: 1, idempotencyKey: 'issue-at-1-again' }, contextOf(people.buyer)), (error) => error.code === 'PURCHASE_ORDER_WORKFLOW_CONFLICT' && error.status === 409)
      assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: 'ISSUED-AT-1' } })).issuedAt.toISOString(), '2026-10-01T14:00:00.000Z')
    })

    await t.test('the database refuses a change once the date is set; later commands leave it alone', async () => {
      await assert.rejects(prisma.purchaseOrder.update({ where: { id: 'ISSUED-AT-1' }, data: { issuedAt: new Date('2026-10-05T00:00:00Z') } }), /cannot be changed/)
      await assert.rejects(prisma.purchaseOrder.update({ where: { id: 'ISSUED-AT-1' }, data: { issuedAt: null } }), /cannot be changed/)
      clock = new Date('2026-10-04T09:00:00.000Z')
      const closed = await service.closePurchaseOrder('ISSUED-AT-1', { expectedVersion: 1, idempotencyKey: 'close-at-1', reason: 'Supplier cannot ship the rest' }, contextOf(people.manager))
      assert.equal(closed.status, 'closed')
      assert.equal(closed.purchaseOrder.issuedAt, '2026-10-01T14:00:00.000Z')
      assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: 'ISSUED-AT-1' } })).issuedAt.toISOString(), '2026-10-01T14:00:00.000Z')
    })

    await t.test('a PO received before it was issued has no issue date, and can no longer be issued', async () => {
      // Receiving accepts an approved PO, which then leaves "approved".
      await po('ISSUED-AT-2', 'partially_received')
      await prisma.purchaseOrder.update({ where: { id: 'ISSUED-AT-2' }, data: { receivingBaseStatus: 'approved' } })
      await assert.rejects(service.issuePurchaseOrder('ISSUED-AT-2', { expectedVersion: 0, idempotencyKey: 'issue-at-2' }, contextOf(people.buyer)), (error) => error.code === 'PURCHASE_ORDER_WORKFLOW_CONFLICT')
      assert.equal((await service.readPurchaseOrder('ISSUED-AT-2', contextOf(people.buyer))).issuedAt, null)
    })

    await t.test('another workspace cannot issue the PO', async () => {
      await po('ISSUED-AT-3', 'approved')
      await assert.rejects(service.issuePurchaseOrder('ISSUED-AT-3', { expectedVersion: 0, idempotencyKey: 'issue-at-3-other' }, contextOf(people.otherBuyer)), (error) => error.code === 'PURCHASE_ORDER_NOT_FOUND')
      assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: 'ISSUED-AT-3' } })).issuedAt, null)
    })
  } finally {
    await prisma.$disconnect()
  }
})

test('the price history query returns at most 3 lines per item, unit and currency, from this workspace only', async (t) => {
  // Runs after the test above, which created the tenants and users.
  const prisma = await createPrismaClient(process.env)
  const service = createPriceHistoryReadService({ prisma, env: process.env })
  let sequence = 0
  const po = async (tenantId, status, { issuedAt = null, createdAt = '2026-08-01T12:00:00Z', currency = 'USD', lines }) => {
    sequence += 1
    const id = `PH-PO-${String(sequence).padStart(3, '0')}`
    await prisma.purchaseOrder.create({
      data: { id, tenantId, status, supplierId: `sup-${tenantId}`, supplierName: tenantId === tenantA ? 'Acme' : 'Other Co', currency, issuedAt: issuedAt ? new Date(issuedAt) : null, createdAt: new Date(createdAt), metadata: { orderNumber: `PO-${String(sequence).padStart(4, '0')}` },
        lines: { create: lines.map((line, index) => ({ id: `${id}-L${index + 1}`, itemId: 'PH-ITEM', sku: 'PH-1', itemName: 'Widget', orderedQuantity: line.quantity ?? 10, receivedQuantity: 0, unit: line.unit ?? 'pcs', unitPrice: line.price, amount: 0 })) } },
    })
    return id
  }
  try {
    await prisma.item.create({ data: { id: 'PH-ITEM', tenantId: tenantA, sku: 'PH-1', name: 'Widget', unit: 'pcs' } })
    // Five issued lines in pcs/USD; the oldest two must not come back.
    for (const [day, price] of [['2026-09-01', 4.0], ['2026-09-05', 4.1], ['2026-09-09', 4.2], ['2026-09-13', 4.3], ['2026-09-17', 4.4]]) await po(tenantA, 'issued', { issuedAt: `${day}T15:00:00Z`, lines: [{ price }] })
    // Received without being issued: dated by its order date.
    await po(tenantA, 'fully_received', { createdAt: '2026-09-20T15:00:00Z', lines: [{ price: 4.5, quantity: 30 }] })
    // Never counted: draft, approved, cancelled, and a line without a price.
    await po(tenantA, 'draft', { issuedAt: null, createdAt: '2026-09-30T15:00:00Z', lines: [{ price: 1 }] })
    await po(tenantA, 'approved', { createdAt: '2026-09-30T15:00:00Z', lines: [{ price: 1 }] })
    await po(tenantA, 'cancelled', { createdAt: '2026-09-30T15:00:00Z', lines: [{ price: 1 }] })
    await po(tenantA, 'issued', { issuedAt: '2026-09-30T15:00:00Z', lines: [{ price: null }] })
    // Other units and currencies are named.
    await po(tenantA, 'closed', { issuedAt: '2026-09-02T15:00:00Z', currency: 'EUR', lines: [{ price: 3.9 }] })
    await po(tenantA, 'issued', { issuedAt: '2026-09-03T15:00:00Z', lines: [{ price: 40, unit: 'CASE' }] })
    // Another workspace bought the same item id.
    await po(tenantB, 'issued', { issuedAt: '2026-10-01T15:00:00Z', lines: [{ price: 0.01 }] })

    await t.test('the query keeps the latest 3 of each partition and leaves out other workspaces', async () => {
      const rows = await readPriceHistoryLines(prisma, { tenantId: tenantA, itemIds: ['PH-ITEM'] })
      const byPartition = Object.groupBy(rows, (row) => `${row.unit.toLowerCase()}|${row.currency}`)
      assert.deepEqual(Object.fromEntries(Object.entries(byPartition).map(([partition, list]) => [partition, list.map((row) => row.unitPrice).sort()])), {
        'case|USD': ['40.0000'],
        'pcs|EUR': ['3.9000'],
        'pcs|USD': ['4.3000', '4.4000', '4.5000'],
      })
      assert.ok(rows.every((row) => row.supplierName === 'Acme'))
      assert.deepEqual(await readPriceHistoryLines(prisma, { tenantId: tenantB, itemIds: ['PH-ITEM'] }).then((list) => list.map((row) => row.unitPrice)), ['0.0100'])
    })

    await t.test('a buyer reads the latest PO price, two earlier ones and the average of 3', async () => {
      const { histories: [history] } = await service.read(['PH-ITEM||USD'], contextOf(people.buyer))
      assert.deepEqual([history.latest.orderNumber, history.latest.unitPrice, history.latest.date, history.latest.dateSource], ['PO-0006', '4.5000', '2026-09-20', 'order_date'])
      assert.deepEqual(history.earlier.map((fact) => [fact.orderNumber, fact.date, fact.dateSource]), [['PO-0005', '2026-09-17', 'issue_date'], ['PO-0004', '2026-09-13', 'issue_date']])
      // (4.5 x 30 + 4.4 x 10 + 4.3 x 10) / 50 = 4.44
      assert.deepEqual(history.average, { unitPrice: '4.4400', n: 3 })
      assert.deepEqual([history.unit, history.unitSource, history.otherCurrencies, history.otherUnits], ['pcs', 'item', ['EUR'], ['CASE']])
      // A PO page leaves its own PO out of the history.
      const { histories: [withoutOwn] } = await service.read(['PH-ITEM||USD'], contextOf(people.buyer), { excludePurchaseOrderId: 'PH-PO-006' })
      assert.deepEqual([withoutOwn.latest.orderNumber, ...withoutOwn.earlier.map((fact) => fact.orderNumber)], ['PO-0005', 'PO-0004', 'PO-0003'])
    })

    await t.test('a viewer gets the facts without prices; a role without purchase orders is refused', async () => {
      const result = await service.read(['PH-ITEM|pcs|USD'], contextOf(people.viewer))
      assert.deepEqual(result.restrictedFields, ['unitPrice'])
      assert.deepEqual([result.histories[0].latest.unitPrice, result.histories[0].average.unitPrice, result.histories[0].latest.orderNumber], [null, null, 'PO-0006'])
      await assert.rejects(service.read(['PH-ITEM|pcs|USD'], contextOf(people.finance)), (error) => error.status === 403)
    })

    await t.test('another workspace sees only its own purchase', async () => {
      const { histories: [history] } = await service.read(['PH-ITEM|pcs|USD'], contextOf(people.otherBuyer))
      assert.deepEqual([history.latest.unitPrice, history.earlier.length, history.otherCurrencies], ['0.0100', 0, []])
    })

    await t.test('an issued PO page sees only POs dated before it; a draft sees the latest', async () => {
      // PH-PO-004 was issued on Sep 13: Sep 17 and the Sep 20 receipt come after it.
      const { histories: [issuedPage] } = await service.read(['PH-ITEM|pcs|USD'], contextOf(people.buyer), { excludePurchaseOrderId: 'PH-PO-004' })
      assert.deepEqual([issuedPage.latest.orderNumber, ...issuedPage.earlier.map((fact) => fact.orderNumber)], ['PO-0003', 'PO-0002', 'PO-0001'])
      assert.deepEqual([issuedPage.otherCurrencies, issuedPage.otherUnits], [['EUR'], ['CASE']])
      // PH-PO-007 is a draft: nothing issued is later than a PO not issued yet.
      const { histories: [draftPage] } = await service.read(['PH-ITEM|pcs|USD'], contextOf(people.buyer), { excludePurchaseOrderId: 'PH-PO-007' })
      assert.equal(draftPage.latest.orderNumber, 'PO-0006')
      // Another workspace's PO id sets no bound.
      const { histories: [foreign] } = await service.read(['PH-ITEM|pcs|USD'], contextOf(people.buyer), { excludePurchaseOrderId: 'PH-PO-013' })
      assert.equal(foreign.latest.orderNumber, 'PO-0006')
    })

    await t.test('every line without a unit is counted, beyond the 3 lines kept; a PO received from approval says it was not issued', async () => {
      const create = (id, data, lines) => prisma.purchaseOrder.create({ data: { id, tenantId: tenantA, supplierId: 'sup-a', supplierName: 'Acme', currency: 'USD', metadata: { orderNumber: id }, ...data, lines: { create: lines.map((line, index) => ({ id: `${id}-L${index + 1}`, itemId: 'PH-ITEM-2', sku: 'PH-2', itemName: 'Bracket', orderedQuantity: 5, receivedQuantity: 0, unitPrice: 2, amount: 10, ...line })) } } })
      for (let index = 1; index <= 5; index += 1) await create(`PH2-UNITLESS-${index}`, { status: 'issued', issuedAt: new Date(`2026-09-0${index}T15:00:00Z`) }, [{ unit: index % 2 ? null : '' }, { unit: ' ' }])
      await create('PH2-RECEIVED', { status: 'fully_received', receivingBaseStatus: 'approved', createdAt: new Date('2026-09-20T15:00:00Z') }, [{ unit: 'pcs', unitPrice: 2.5 }])
      const rows = await readPriceHistoryLines(prisma, { tenantId: tenantA, itemIds: ['PH-ITEM-2'] })
      assert.equal(rows.filter((row) => !String(row.unit || '').trim()).length, 6, 'the null, blank and space partitions keep 3 lines each at most')
      const { histories: [history] } = await service.read(['PH-ITEM-2|pcs|USD'], contextOf(people.buyer))
      assert.equal(history.unitNotRecordedCount, 10)
      assert.deepEqual([history.latest.orderNumber, history.latest.date, history.latest.dateSource], ['PH2-RECEIVED', '2026-09-20', 'order_date_not_issued'])
    })

    await t.test("a supplier's page reads that supplier's POs only, in the same query as any-supplier keys", async () => {
      const create = (id, tenantId, supplierId, issuedAt, unitPrice, line = {}) => prisma.purchaseOrder.create({ data: { id, tenantId, status: 'issued', supplierId, supplierName: supplierId, currency: 'USD', issuedAt: new Date(issuedAt), metadata: { orderNumber: id }, lines: { create: [{ id: `${id}-L1`, itemId: 'PH-ITEM-3', sku: 'PH-3', itemName: 'Clamp', orderedQuantity: 10, receivedQuantity: 0, unit: 'pcs', unitPrice, amount: 0, ...line }] } } })
      await create('PH3-ACME-1', tenantA, 'sup-acme', '2026-09-01T15:00:00Z', 2.0)
      // Four later lines from another supplier, the last in CASE: they fill the any-supplier cut.
      for (let index = 1; index <= 4; index += 1) await create(`PH3-BOLT-${index}`, tenantA, 'sup-bolt', `2026-09-1${index}T15:00:00Z`, 3 + index / 10, index === 4 ? { unit: 'CASE' } : {})
      // The same supplier id in another workspace is not this supplier.
      await create('PH3-OTHER', tenantB, 'sup-acme', '2026-09-30T15:00:00Z', 0.01)

      const rows = await readPriceHistoryLines(prisma, { tenantId: tenantA, scopes: [{ itemId: 'PH-ITEM-3', supplierId: '' }, { itemId: 'PH-ITEM-3', supplierId: 'sup-acme' }, { itemId: 'PH-ITEM-3', supplierId: 'sup-new' }] })
      const byScope = Object.groupBy(rows, (row) => row.scopeSupplierId)
      assert.deepEqual(Object.keys(byScope).sort(), ['', 'sup-acme'])
      assert.deepEqual(byScope['sup-acme'].map((row) => row.purchaseOrderId), ['PH3-ACME-1'])
      assert.deepEqual(byScope[''].filter((row) => row.unit === 'pcs').map((row) => row.purchaseOrderId).sort(), ['PH3-BOLT-1', 'PH3-BOLT-2', 'PH3-BOLT-3'])

      const { histories: [anySupplier, acme, newSupplier, again] } = await service.read(['PH-ITEM-3|pcs|USD', 'PH-ITEM-3|pcs|USD|sup-acme', 'PH-ITEM-3|pcs|USD|sup-new', 'PH-ITEM-3|pcs|USD|sup-acme'], contextOf(people.buyer))
      assert.deepEqual([anySupplier.supplierId, anySupplier.latest.orderNumber, anySupplier.latest.supplierName, anySupplier.otherUnits], [null, 'PH3-BOLT-3', 'sup-bolt', ['CASE']])
      assert.deepEqual([acme.key, acme.latest.orderNumber, acme.latest.unitPrice, acme.earlier, acme.average, acme.otherUnits], ['PH-ITEM-3|pcs|USD|sup-acme', 'PH3-ACME-1', '2.0000', [], null, []])
      assert.deepEqual([newSupplier.status, newSupplier.latest, newSupplier.otherUnits, newSupplier.otherCurrencies], ['none', null, [], []])
      assert.equal(again.latest.orderNumber, 'PH3-ACME-1', 'a key asked twice is read once and answered twice')
      // A supplierId given apart scopes the keys that name none.
      const { histories: [given] } = await service.read(['PH-ITEM-3|pcs|USD'], contextOf(people.buyer), { supplierId: 'sup-bolt' })
      assert.deepEqual([given.key, given.latest.orderNumber, given.earlier.map((fact) => fact.orderNumber), given.otherUnits], ['PH-ITEM-3|pcs|USD|sup-bolt', 'PH3-BOLT-3', ['PH3-BOLT-2', 'PH3-BOLT-1'], ['CASE']])
      // Another workspace's buyer sees its own sup-acme PO only.
      const { histories: [foreign] } = await service.read(['PH-ITEM-3|pcs|USD|sup-acme'], contextOf(people.otherBuyer))
      assert.equal(foreign.latest.orderNumber, 'PH3-OTHER')
    })
  } finally {
    await prisma.$disconnect()
  }
})
