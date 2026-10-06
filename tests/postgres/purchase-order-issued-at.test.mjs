import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import pg from 'pg'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
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
