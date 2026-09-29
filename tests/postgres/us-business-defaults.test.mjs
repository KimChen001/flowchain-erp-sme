import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const migrationName = '20260929030000_us_business_defaults'
const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const documentTables = ['PurchaseRequest', 'Rfq', 'SupplierQuotation', 'PurchaseOrder', 'ReceivingDocument', 'SupplierInvoice', 'ThreeWayMatch']
const migrationSql = (name) => readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), 'utf8')
const tenantSettings = async (client, id) => {
  const row = (await client.query('SELECT "countryCode", locale, currency, timezone, version, "updatedAt" FROM "Tenant" WHERE id = $1', [id])).rows[0]
  return { ...row, updatedAt: row.updatedAt.toISOString() }
}
const poCurrency = async (client, id) => (await client.query('SELECT currency FROM "PurchaseOrder" WHERE id = $1', [id])).rows[0].currency

test('US business defaults apply to new rows only and leave existing tenants and documents unchanged', async () => {
  // Run only with scripts/run-postgres-test-files.mjs against its disposable server.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  // The runner has already deployed every migration. To replay the real upgrade,
  // build a second throwaway database on the same server with every migration
  // before this one, add rows, then apply this migration on top.
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  const upgradeDatabase = `flowchain_us_defaults_${randomUUID().replace(/-/g, '')}`
  const upgradeUrl = new URL(process.env.DATABASE_URL_TEST)
  upgradeUrl.pathname = `/${upgradeDatabase}`
  const client = new pg.Client({ connectionString: upgradeUrl.toString() })
  try {
    await admin.connect()
    await admin.query(`CREATE DATABASE "${upgradeDatabase}"`)
    await client.connect()
    const earlier = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < migrationName)
      .map((entry) => entry.name)
      .sort()
    assert.equal(earlier.at(-1), '20260929020000_bank_line_allocation_index_name')
    for (const name of earlier) await client.query(migrationSql(name))

    await client.query(`INSERT INTO "Tenant" (id, name, "countryCode", locale, currency, timezone, "updatedAt") VALUES ('us-defaults-cn', 'Chinese tenant', 'CN', 'zh-CN', 'CNY', 'Asia/Shanghai', NOW())`)
    await client.query(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('us-defaults-legacy', 'Legacy default tenant', NOW())`)
    await client.query(`INSERT INTO "PurchaseOrder" (id, "tenantId", "updatedAt") VALUES ('us-defaults-legacy-po', 'us-defaults-legacy', NOW())`)
    const cnBefore = await tenantSettings(client, 'us-defaults-cn')
    const legacyBefore = await tenantSettings(client, 'us-defaults-legacy')
    assert.deepEqual([cnBefore.countryCode, cnBefore.locale, cnBefore.currency, cnBefore.timezone], ['CN', 'zh-CN', 'CNY', 'Asia/Shanghai'])
    assert.deepEqual([legacyBefore.countryCode, legacyBefore.locale, legacyBefore.currency, legacyBefore.timezone], ['CN', 'zh-CN', 'CNY', 'Asia/Shanghai'])
    assert.equal(await poCurrency(client, 'us-defaults-legacy-po'), 'CNY')

    const migration = migrationSql(migrationName)
    assert.doesNotMatch(migration.replace(/--.*$/gm, ''), /\bUPDATE\b/i)
    await client.query(migration)

    assert.deepEqual(await tenantSettings(client, 'us-defaults-cn'), cnBefore)
    assert.deepEqual(await tenantSettings(client, 'us-defaults-legacy'), legacyBefore)
    assert.equal(await poCurrency(client, 'us-defaults-legacy-po'), 'CNY')

    await client.query(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('us-defaults-new', 'New workspace', NOW())`)
    await client.query(`INSERT INTO "PurchaseOrder" (id, "tenantId", "updatedAt") VALUES ('us-defaults-new-po', 'us-defaults-new', NOW())`)
    const created = await tenantSettings(client, 'us-defaults-new')
    assert.deepEqual([created.countryCode, created.locale, created.currency, created.timezone], ['US', 'en-US', 'USD', 'America/New_York'])
    assert.equal(await poCurrency(client, 'us-defaults-new-po'), 'USD')
  } finally {
    await client.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`).catch(() => {})
    await admin.end().catch(() => {})
  }
})

test('a database deployed through prisma migrate has US defaults on Tenant and all document currencies', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  await client.connect()
  const id = `us-defaults-${randomUUID()}`
  try {
    const columns = await client.query(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND ((table_name = 'Tenant' AND column_name IN ('countryCode', 'locale', 'currency', 'timezone')) OR (table_name = ANY($1) AND column_name = 'currency'))`,
      [documentTables],
    )
    const defaults = Object.fromEntries(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.column_default]))
    assert.equal(defaults['Tenant.countryCode'], "'US'::text")
    assert.equal(defaults['Tenant.locale'], "'en-US'::text")
    assert.equal(defaults['Tenant.currency'], "'USD'::text")
    assert.equal(defaults['Tenant.timezone'], "'America/New_York'::text")
    for (const table of documentTables) assert.equal(defaults[`${table}.currency`], "'USD'::text", table)

    await client.query(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ($1, 'New workspace', NOW())`, [id])
    await client.query(`INSERT INTO "PurchaseOrder" (id, "tenantId", "updatedAt") VALUES ($1, $2, NOW())`, [`${id}-po`, id])
    const tenant = await tenantSettings(client, id)
    assert.deepEqual([tenant.countryCode, tenant.locale, tenant.currency, tenant.timezone], ['US', 'en-US', 'USD', 'America/New_York'])
    assert.equal(await poCurrency(client, `${id}-po`), 'USD')
  } finally {
    await client.query('DELETE FROM "PurchaseOrder" WHERE "tenantId" = $1', [id])
    await client.query('DELETE FROM "Tenant" WHERE id = $1', [id])
    await client.end()
  }
})
