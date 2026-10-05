import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import pg from 'pg'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { applyPromisedDateChanges } from '../../server/domain/purchase-order-promise-dates.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// A PO line keeps the date the supplier first promised, apart from the current
// expected date that moves with the shipment. Supplier scorecards measure
// against the first one, so it must be recorded at approval (or at issue, for
// a line dated after approval) and never change.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/purchase-order-original-promise.test.mjs

const migrationName = '20260930010000_purchase_order_original_promise'
const backfillName = '20261005010000_purchase_order_original_promise_backfill'
const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const migrationSql = (name) => readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), 'utf8')

const tenantA = 'tenant-original-promise-a'
const tenantB = 'tenant-original-promise-b'
const people = {
  buyer: { id: 'promise-buyer-a', tenantId: tenantA, email: 'buyer@original-promise.invalid', name: 'Blake Buyer', role: 'buyer' },
  viewer: { id: 'promise-viewer-a', tenantId: tenantA, email: 'viewer@original-promise.invalid', name: 'Vic Viewer', role: 'viewer' },
  otherBuyer: { id: 'promise-buyer-b', tenantId: tenantB, email: 'buyer@other-promise.invalid', name: 'Other Buyer', role: 'buyer' },
  approver: { id: 'promise-approver-a', tenantId: tenantA, email: 'approver@original-promise.invalid', name: 'Avery Approver', role: 'admin' },
}
const contextOf = (user) => ({ identity: { authenticated: true, tenantId: user.tenantId, userId: user.id, role: user.role } })
const day = (value) => value ? value.toISOString().slice(0, 10) : null
const at = (iso) => new Date(`${iso}T12:00:00Z`)

async function approvedPo(prisma, id, { tenantId = tenantA, expectedDate = '2026-10-10', status = 'approved', lines }) {
  await prisma.purchaseOrder.create({
    data: {
      id, tenantId, status, supplierId: 'promise-supplier', supplierName: 'Promise Supplier', currency: 'USD', amount: 1000, expectedDate: expectedDate ? at(expectedDate) : null,
      lines: { create: lines.map((line, index) => ({ id: `${id}-L${index + 1}`, sku: `SKU-${index + 1}`, itemName: `Item ${index + 1}`, orderedQuantity: 10, receivedQuantity: 0, unit: 'pcs', unitPrice: 50, amount: 500, metadata: line.promisedDate ? { promisedDate: line.promisedDate } : {} })) },
    },
  })
}

test('the migration adds an empty original promise to existing lines and guards it', async () => {
  // Replays the real upgrade on a second throwaway database on the runner's server.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  const upgradeDatabase = `flowchain_original_promise_${randomUUID().replace(/-/g, '')}`
  const upgradeUrl = new URL(process.env.DATABASE_URL_TEST)
  upgradeUrl.pathname = `/${upgradeDatabase}`
  const client = new pg.Client({ connectionString: upgradeUrl.toString() })
  try {
    await admin.connect()
    await admin.query(`CREATE DATABASE "${upgradeDatabase}"`)
    await client.connect()
    const earlier = readdirSync(migrationsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name < migrationName).map((entry) => entry.name).sort()
    assert.equal(earlier.at(-1), '20260929040000_email_link_sign_in')
    for (const name of earlier) await client.query(migrationSql(name))
    await client.query(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('upgrade-tenant', 'Upgrade', NOW())`)
    await client.query(`INSERT INTO "PurchaseOrder" (id, "tenantId", status, "expectedDate", "updatedAt") VALUES ('upgrade-po', 'upgrade-tenant', 'issued', '2026-08-01T12:00:00Z', NOW())`)
    await client.query(`INSERT INTO "PurchaseOrderLine" (id, "purchaseOrderId", "orderedQuantity", metadata) VALUES ('upgrade-line', 'upgrade-po', 5, '{"promisedDate":"2026-08-03"}')`)

    const migration = migrationSql(migrationName)
    assert.doesNotMatch(migration.replace(/--.*$/gm, ''), /^\s*UPDATE\b/im, 'the migration does not backfill')
    await client.query(migration)

    // Existing lines keep no original promise; nothing is guessed from their current date.
    const line = (await client.query(`SELECT "originalPromisedDate", metadata FROM "PurchaseOrderLine" WHERE id = 'upgrade-line'`)).rows[0]
    assert.equal(line.originalPromisedDate, null)
    assert.equal(line.metadata.promisedDate, '2026-08-03')
    // Set once, then fixed; other columns still change freely.
    await client.query(`UPDATE "PurchaseOrderLine" SET "originalPromisedDate" = '2026-08-03T12:00:00Z' WHERE id = 'upgrade-line'`)
    await assert.rejects(client.query(`UPDATE "PurchaseOrderLine" SET "originalPromisedDate" = '2026-08-09T12:00:00Z' WHERE id = 'upgrade-line'`), /cannot be changed/)
    await assert.rejects(client.query(`UPDATE "PurchaseOrderLine" SET "originalPromisedDate" = NULL WHERE id = 'upgrade-line'`), /cannot be changed/)
    await client.query(`UPDATE "PurchaseOrderLine" SET "receivedQuantity" = 5 WHERE id = 'upgrade-line'`)
    // Revisions are append-only.
    await client.query(`INSERT INTO "PurchaseOrderPromiseRevision" (id, "tenantId", "purchaseOrderId", "purchaseOrderLineId", "previousDate", "newDate", reason, source) VALUES ('upgrade-rev', 'upgrade-tenant', 'upgrade-po', 'upgrade-line', '2026-08-03T12:00:00Z', '2026-08-06T12:00:00Z', 'Carrier delay', 'test')`)
    await assert.rejects(client.query(`UPDATE "PurchaseOrderPromiseRevision" SET reason = 'edited' WHERE id = 'upgrade-rev'`), /append-only/)
    await assert.rejects(client.query(`DELETE FROM "PurchaseOrderPromiseRevision" WHERE id = 'upgrade-rev'`), /append-only/)
  } finally {
    await client.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`).catch(() => {})
    await admin.end().catch(() => {})
  }
})

// Replays every migration before the backfill on a throwaway database, then the
// backfill, and checks which lines it fills and from which date.
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
    await run(client)
  } finally {
    await client.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`).catch(() => {})
    await admin.end().catch(() => {})
  }
}

test('the backfill records the original promise of approved and later lines from the best date on record', async () => {
  await withUpgradeDatabase('flowchain_promise_backfill', async (client) => {
    const earlier = readdirSync(migrationsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name < backfillName).map((entry) => entry.name).sort()
    for (const name of earlier) await client.query(migrationSql(name))
    await client.query(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('upgrade-tenant', 'Upgrade', NOW())`)
    const po = (id, status, expectedDate) => client.query(`INSERT INTO "PurchaseOrder" (id, "tenantId", status, "expectedDate", "updatedAt") VALUES ($1, 'upgrade-tenant', $2, $3, NOW())`, [id, status, expectedDate])
    const line = (id, poId, metadata, original = null) => client.query(`INSERT INTO "PurchaseOrderLine" (id, "purchaseOrderId", "orderedQuantity", metadata, "originalPromisedDate") VALUES ($1, $2, 5, $3, $4)`, [id, poId, JSON.stringify(metadata), original])
    await po('po-issued', 'issued', '2026-08-01T12:00:00Z')
    await line('own-date', 'po-issued', { promisedDate: '2026-08-03' })
    await line('header-date', 'po-issued', {})
    await line('revised', 'po-issued', { promisedDate: '2026-08-09' })
    await line('recorded', 'po-issued', { promisedDate: '2026-08-05' }, '2026-07-30T12:00:00Z')
    await line('bad-date', 'po-issued', { promisedDate: '2026-02-30' })
    await po('po-approved', 'approved', '2026-09-15T00:00:00Z')
    await line('approved-line', 'po-approved', {})
    await po('po-approved-undated', 'approved', null)
    await line('undated', 'po-approved-undated', {})
    await po('po-received', 'fully_received', '2026-07-10T12:00:00Z')
    await line('received-line', 'po-received', {})
    await po('po-draft', 'draft', '2026-08-01T12:00:00Z')
    await line('draft-line', 'po-draft', { promisedDate: '2026-08-03' })
    await po('po-cancelled', 'cancelled', '2026-08-01T12:00:00Z')
    await line('cancelled-line', 'po-cancelled', { promisedDate: '2026-08-03' })
    // Two revisions moved 08-03 to 08-06, then to 08-09: the first date is the promise.
    const revision = (id, previousDate, newDate, createdAt) => client.query(`INSERT INTO "PurchaseOrderPromiseRevision" (id, "tenantId", "purchaseOrderId", "purchaseOrderLineId", "previousDate", "newDate", reason, source, "createdAt") VALUES ($1, 'upgrade-tenant', 'po-issued', 'revised', $2, $3, 'Carrier delay', 'test', $4)`, [id, previousDate, newDate, createdAt])
    await revision('rev-2', '2026-08-06T12:00:00Z', '2026-08-09T12:00:00Z', '2026-08-02T10:00:00Z')
    await revision('rev-1', '2026-08-03T12:00:00Z', '2026-08-06T12:00:00Z', '2026-08-01T10:00:00Z')

    await client.query(migrationSql(backfillName))

    const rows = (await client.query(`SELECT id, to_char("originalPromisedDate", 'YYYY-MM-DD HH24:MI') AS original FROM "PurchaseOrderLine" ORDER BY id`)).rows
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.original])), {
      'approved-line': '2026-09-15 12:00',
      'bad-date': '2026-08-01 12:00',
      'cancelled-line': null,
      'draft-line': null,
      'header-date': '2026-08-01 12:00',
      'own-date': '2026-08-03 12:00',
      'received-line': '2026-07-10 12:00',
      recorded: '2026-07-30 12:00',
      revised: '2026-08-03 12:00',
      undated: null,
    })
    // The helper function is gone and the promise is still fixed once set.
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_proc WHERE proname = 'flowchain_backfill_promise_day'`)).rows[0].count, 0)
    await assert.rejects(client.query(`UPDATE "PurchaseOrderLine" SET "originalPromisedDate" = '2026-08-20T12:00:00Z' WHERE id = 'own-date'`), /cannot be changed/)
  })
})

test('issuing records the original promise; a later revision keeps it and writes a revision and an audit row', async (t) => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  const service = createDbProcurementCommandService({ prisma, env: process.env })
  try {
    for (const tenantId of [tenantA, tenantB]) await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const user of Object.values(people)) await prisma.user.create({ data: user })
    await backfillTenantAuthorization(prisma, tenantA, { actorId: people.buyer.id })
    await backfillTenantAuthorization(prisma, tenantB, { actorId: people.otherBuyer.id })

    // L1 has its own date; L2 reads the header date; L3 has no date at all.
    await approvedPo(prisma, 'PROMISE-PO-1', { expectedDate: '2026-10-10', lines: [{ promisedDate: '2026-10-05' }, {}] })
    await approvedPo(prisma, 'PROMISE-PO-2', { expectedDate: null, lines: [{}] })

    await t.test('issue records each dated line’s promise and leaves an undated line empty', async () => {
      const issued = await service.issuePurchaseOrder('PROMISE-PO-1', { expectedVersion: 0, idempotencyKey: 'issue-1' }, contextOf(people.buyer))
      assert.deepEqual(issued.purchaseOrder.lines.map((line) => [line.id, line.originalPromisedDate, line.promisedDate]), [['PROMISE-PO-1-L1', '2026-10-05', '2026-10-05'], ['PROMISE-PO-1-L2', '2026-10-10', '2026-10-10']])
      const second = await service.issuePurchaseOrder('PROMISE-PO-2', { expectedVersion: 0, idempotencyKey: 'issue-2' }, contextOf(people.buyer))
      assert.equal(second.purchaseOrder.lines[0].originalPromisedDate, null)
      assert.equal(await prisma.purchaseOrderPromiseRevision.count(), 0, 'issuing is not a revision')
      const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: 'PROMISE-PO-1', action: 'purchase_order_issue' } })
      assert.deepEqual(audit.metadata.originalPromisesRecorded.map((row) => row.purchaseOrderLineId), ['PROMISE-PO-1-L1', 'PROMISE-PO-1-L2'])
    })

    await t.test('a revision needs a reason and writes nothing without one', async () => {
      await assert.rejects(service.revisePromisedDates('PROMISE-PO-1', { expectedVersion: 1, idempotencyKey: 'revise-no-reason', lines: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-10-12' }], reason: '  ' }, contextOf(people.buyer)), (error) => error.code === 'PROMISE_REVISION_REASON_REQUIRED' && error.status === 422)
      assert.equal(await prisma.purchaseOrderPromiseRevision.count(), 0)
      assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: 'PROMISE-PO-1-L1' } })).metadata.promisedDate, '2026-10-05')
    })

    await t.test('an edit after issue changes the current date, keeps the original and records who, when and why', async () => {
      const result = await service.revisePromisedDates('PROMISE-PO-1', { expectedVersion: 1, idempotencyKey: 'revise-1', lines: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-10-12' }], reason: 'Supplier moved the ship date' }, contextOf(people.buyer))
      const [l1, l2] = result.purchaseOrder.lines
      assert.deepEqual([l1.originalPromisedDate, l1.promisedDate], ['2026-10-05', '2026-10-12'])
      assert.deepEqual([l2.originalPromisedDate, l2.promisedDate], ['2026-10-10', '2026-10-10'], 'the untouched line keeps its date')
      assert.equal(result.entityVersion, 2)
      const revisions = await prisma.purchaseOrderPromiseRevision.findMany({ where: { tenantId: tenantA } })
      assert.equal(revisions.length, 1)
      assert.deepEqual([revisions[0].purchaseOrderLineId, day(revisions[0].previousDate), day(revisions[0].newDate), revisions[0].reason, revisions[0].actorId], ['PROMISE-PO-1-L1', '2026-10-05', '2026-10-12', 'Supplier moved the ship date', people.buyer.id])
      assert.deepEqual(result.purchaseOrder.promiseRevisions.map((row) => [row.previousDate, row.newDate]), [['2026-10-05', '2026-10-12']])
      const lineAudit = await prisma.auditLog.findMany({ where: { tenantId: tenantA, entityType: 'PurchaseOrderLine', entityId: 'PROMISE-PO-1-L1', action: 'purchase_order_promise_revised' } })
      assert.equal(lineAudit.length, 1)
      assert.equal(lineAudit[0].metadata.revisionId, revisions[0].id)
      // A second revision moves the date again; the original still does not move.
      await service.revisePromisedDates('PROMISE-PO-1', { expectedVersion: 2, idempotencyKey: 'revise-2', lines: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-10-20' }], reason: 'Port congestion' }, contextOf(people.buyer))
      const stored = await prisma.purchaseOrderLine.findUnique({ where: { id: 'PROMISE-PO-1-L1' } })
      assert.deepEqual([day(stored.originalPromisedDate), stored.metadata.promisedDate], ['2026-10-05', '2026-10-20'])
      assert.equal(await prisma.purchaseOrderPromiseRevision.count({ where: { purchaseOrderLineId: 'PROMISE-PO-1-L1' } }), 2)
      // Replaying the same command changes nothing.
      const replay = await service.revisePromisedDates('PROMISE-PO-1', { expectedVersion: 2, idempotencyKey: 'revise-2', lines: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-10-20' }], reason: 'Port congestion' }, contextOf(people.buyer))
      assert.equal(replay.idempotentReplay, true)
      assert.equal(await prisma.purchaseOrderPromiseRevision.count({ where: { purchaseOrderLineId: 'PROMISE-PO-1-L1' } }), 2)
      // Nothing can overwrite the original directly either.
      await assert.rejects(prisma.purchaseOrderLine.update({ where: { id: 'PROMISE-PO-1-L1' }, data: { originalPromisedDate: at('2026-10-20') } }), /cannot be changed/)
    })

    await t.test('the first date set on an issued PO becomes its original promise', async () => {
      const result = await service.revisePromisedDates('PROMISE-PO-2', { expectedVersion: 1, idempotencyKey: 'revise-first', lines: [{ purchaseOrderLineId: 'PROMISE-PO-2-L1', promisedDate: '2026-11-02' }], reason: 'Supplier confirmed the delivery date' }, contextOf(people.buyer))
      assert.deepEqual([result.purchaseOrder.lines[0].originalPromisedDate, result.purchaseOrder.lines[0].promisedDate], ['2026-11-02', '2026-11-02'])
      const revision = await prisma.purchaseOrderPromiseRevision.findFirst({ where: { purchaseOrderLineId: 'PROMISE-PO-2-L1' } })
      assert.equal(revision.previousDate, null)
      await service.revisePromisedDates('PROMISE-PO-2', { expectedVersion: 2, idempotencyKey: 'revise-first-2', lines: [{ purchaseOrderLineId: 'PROMISE-PO-2-L1', promisedDate: '2026-11-09' }], reason: 'Supplier production delay' }, contextOf(people.buyer))
      assert.equal(day((await prisma.purchaseOrderLine.findUnique({ where: { id: 'PROMISE-PO-2-L1' } })).originalPromisedDate), '2026-11-02')
    })

    await t.test('moving the header date does not silently move lines that read it', async () => {
      // L2 has no date of its own and reads the header 2026-10-10. Moving L1
      // earlier than that moves the header; L2 must keep 2026-10-10.
      const current = await prisma.purchaseOrder.findUnique({ where: { id: 'PROMISE-PO-1' } })
      await service.revisePromisedDates('PROMISE-PO-1', { expectedVersion: current.version, idempotencyKey: 'revise-earlier', lines: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-10-01' }], reason: 'Supplier can ship sooner' }, contextOf(people.buyer))
      const po = await service.readPurchaseOrder('PROMISE-PO-1', contextOf(people.buyer))
      assert.equal(day(new Date(po.expectedDate)), '2026-10-01')
      assert.deepEqual(po.lines.map((line) => line.promisedDate), ['2026-10-01', '2026-10-10'])
      assert.equal(await prisma.purchaseOrderPromiseRevision.count({ where: { purchaseOrderLineId: 'PROMISE-PO-1-L2' } }), 0)
    })

    await t.test('another workspace cannot see or revise the PO, and a read-only user cannot revise it', async () => {
      const before = await prisma.purchaseOrderPromiseRevision.count()
      await assert.rejects(service.revisePromisedDates('PROMISE-PO-1', { expectedVersion: 4, idempotencyKey: 'revise-other-tenant', lines: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-12-01' }], reason: 'Not mine' }, contextOf(people.otherBuyer)), (error) => error.code === 'PURCHASE_ORDER_NOT_FOUND' && error.status === 404)
      await assert.rejects(service.revisePromisedDates('PROMISE-PO-1', { expectedVersion: 4, idempotencyKey: 'revise-viewer', lines: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-12-01' }], reason: 'Read-only' }, contextOf(people.viewer)), (error) => error.status === 403)
      // The helper refuses a PO from another tenant even when called directly.
      const po = await prisma.purchaseOrder.findUnique({ where: { id: 'PROMISE-PO-1' }, include: { lines: true } })
      await assert.rejects(prisma.$transaction((tx) => applyPromisedDateChanges(tx, { tenantId: tenantB, purchaseOrder: po, changes: [{ purchaseOrderLineId: 'PROMISE-PO-1-L1', promisedDate: '2026-12-01' }], reason: 'x', source: 'test' })), (error) => error.code === 'PURCHASE_ORDER_NOT_FOUND')
      assert.equal(await prisma.purchaseOrderPromiseRevision.count(), before)
    })

    await t.test('a PO that is not issued yet is not revised through the command', async () => {
      await approvedPo(prisma, 'PROMISE-PO-3', { lines: [{ promisedDate: '2026-10-05' }] })
      await assert.rejects(service.revisePromisedDates('PROMISE-PO-3', { expectedVersion: 0, idempotencyKey: 'revise-approved', lines: [{ purchaseOrderLineId: 'PROMISE-PO-3-L1', promisedDate: '2026-10-08' }], reason: 'Too early' }, contextOf(people.buyer)), (error) => error.code === 'PURCHASE_ORDER_NOT_ISSUED')
    })

    await t.test('approval records the original promise; issue keeps it after the date moves', async () => {
      // L1 has its own date, L2 reads the header date.
      await approvedPo(prisma, 'PROMISE-PO-4', { status: 'pending_approval', expectedDate: '2026-10-20', lines: [{ promisedDate: '2026-10-12' }, {}] })
      await approvedPo(prisma, 'PROMISE-PO-5', { status: 'pending_approval', expectedDate: null, lines: [{}] })
      const approved = await service.approvePurchaseOrder('PROMISE-PO-4', { expectedVersion: 0, idempotencyKey: 'approve-4' }, contextOf(people.approver))
      assert.deepEqual(approved.purchaseOrder.lines.map((line) => [line.id, line.originalPromisedDate]), [['PROMISE-PO-4-L1', '2026-10-12'], ['PROMISE-PO-4-L2', '2026-10-20']])
      const approveAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: 'PROMISE-PO-4', action: 'purchase_order_approve' } })
      assert.deepEqual(approveAudit.metadata.originalPromisesRecorded.map((row) => row.originalPromisedDate), ['2026-10-12', '2026-10-20'])
      // An undated line has no promise to record.
      const undated = await service.approvePurchaseOrder('PROMISE-PO-5', { expectedVersion: 0, idempotencyKey: 'approve-5' }, contextOf(people.approver))
      assert.equal(undated.purchaseOrder.lines[0].originalPromisedDate, null)

      // Before issue a date simply moves: no revision, and the original stays.
      await prisma.$transaction(async (tx) => {
        const row = await tx.purchaseOrder.findUnique({ where: { id: 'PROMISE-PO-4' }, include: { lines: { orderBy: { id: 'asc' } } } })
        await applyPromisedDateChanges(tx, { tenantId: tenantA, purchaseOrder: row, changes: [{ purchaseOrderLineId: 'PROMISE-PO-4-L1', promisedDate: '2026-10-15' }], source: 'test' })
      })
      assert.equal(await prisma.purchaseOrderPromiseRevision.count({ where: { purchaseOrderId: 'PROMISE-PO-4' } }), 0)
      const current = await prisma.purchaseOrder.findUnique({ where: { id: 'PROMISE-PO-4' } })
      const issued = await service.issuePurchaseOrder('PROMISE-PO-4', { expectedVersion: current.version, idempotencyKey: 'issue-4' }, contextOf(people.buyer))
      assert.deepEqual(issued.purchaseOrder.lines.map((line) => [line.id, line.originalPromisedDate, line.promisedDate]), [['PROMISE-PO-4-L1', '2026-10-12', '2026-10-15'], ['PROMISE-PO-4-L2', '2026-10-20', '2026-10-20']])
      const issueAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, entityId: 'PROMISE-PO-4', action: 'purchase_order_issue' } })
      assert.deepEqual(issueAudit.metadata.originalPromisesRecorded, [])
    })
  } finally {
    await prisma.$disconnect()
  }
})
