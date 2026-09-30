import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const migrationName = '20260929040000_email_link_sign_in'
const newTables = ['SignInRateLimitEvent', 'WorkspaceSession', 'WorkspaceSignInLink']
const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const migrationSql = (name) => readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), 'utf8')

const tableNames = async (client) => (await client.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
)).rows.map((row) => row.table_name)

// Every column definition and a digest of every row, per table, so the test
// notices any change to an existing table, not only the ones it seeded.
async function snapshot(client, tables) {
  const columns = (await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY table_name, ordinal_position`,
    [tables],
  )).rows
  const rows = {}
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) AS digest FROM "${table}" t`)
    rows[table] = result.rows[0]
  }
  return { columns, rows }
}

test('the email sign-in migration only adds tables and leaves existing rows and columns unchanged', async () => {
  // Run only with scripts/run-postgres-test-files.mjs against its disposable server.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  // The runner has already deployed every migration. To replay the real upgrade,
  // build a second throwaway database on the same server with every migration
  // before this one, add rows, then apply this migration on top.
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  const upgradeDatabase = `flowchain_email_link_${randomUUID().replace(/-/g, '')}`
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
    assert.equal(earlier.at(-1), '20260929030000_us_business_defaults')
    for (const name of earlier) await client.query(migrationSql(name))

    await client.query(`INSERT INTO "Tenant" (id, name, "countryCode", locale, currency, timezone, "defaultLanguage", "updatedAt") VALUES ('email-link-cn', 'Existing workspace', 'CN', 'zh-CN', 'CNY', 'Asia/Shanghai', 'zh-CN', NOW())`)
    await client.query(`INSERT INTO "User" (id, "tenantId", email, name, role, status, "languagePreference", "updatedAt") VALUES
      ('email-link-admin', 'email-link-cn', 'admin@example.com', 'Existing Admin', 'admin', 'active', 'zh-CN', NOW()),
      ('email-link-disabled', 'email-link-cn', 'disabled@example.com', 'Disabled User', 'viewer', 'disabled', NULL, NOW())`)
    await client.query(`INSERT INTO "WorkspaceInvitation" (id, "tenantId", email, role, "tokenHash", "expiresAt", "invitedById") VALUES ('email-link-invite', 'email-link-cn', 'new@example.com', 'viewer', 'existing-hash', NOW() + interval '1 day', 'email-link-admin')`)
    await client.query(`INSERT INTO "AuditLog" (id, "tenantId", source, action, "entityType", "entityId", "actorId", summary) VALUES ('email-link-audit', 'email-link-cn', 'workspace_settings', 'profile_settings_updated', 'User', 'email-link-admin', 'email-link-admin', 'Existing audit row.')`)

    const existingTables = await tableNames(client)
    for (const table of newTables) assert.equal(existingTables.includes(table), false, `${table} must not exist before the migration`)
    const before = await snapshot(client, existingTables)
    assert.equal(before.rows.User.count, 2)

    // Every statement creates a new table, an index on one, or a foreign key
    // from one: nothing updates, deletes or alters an existing table.
    const statements = migrationSql(migrationName).replace(/--.*$/gm, '').split(';').map((statement) => statement.replace(/\s+/g, ' ').trim()).filter(Boolean)
    const newTable = `"(?:${newTables.join('|')})"`
    const additive = new RegExp(`^(CREATE TABLE ${newTable} |CREATE (UNIQUE )?INDEX "[^"]+" ON ${newTable}\\(|ALTER TABLE ${newTable} ADD CONSTRAINT "[^"]+" FOREIGN KEY )`)
    assert.ok(statements.length > 0)
    for (const statement of statements) assert.match(statement, additive)
    await client.query(migrationSql(migrationName))

    assert.deepEqual(await snapshot(client, existingTables), before)
    const after = await tableNames(client)
    assert.deepEqual(after.filter((table) => !existingTables.includes(table)).sort(), newTables)
    for (const table of newTables) assert.equal((await client.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows[0].count, 0, table)

    // Sessions and links belong to a user: they go when the user or tenant goes,
    // so existing cleanup of users and tenants keeps working.
    await client.query(`INSERT INTO "WorkspaceSession" (id, "tenantId", "userId", "sessionIdHash", "expiresAt") VALUES ('email-link-session', 'email-link-cn', 'email-link-disabled', 'hash-1', NOW() + interval '1 hour')`)
    await client.query(`INSERT INTO "WorkspaceSignInLink" (id, "tenantId", "userId", "tokenHash", "expiresAt") VALUES ('email-link-link', 'email-link-cn', 'email-link-disabled', 'hash-2', NOW() + interval '15 minutes')`)
    await client.query(`DELETE FROM "User" WHERE id = 'email-link-disabled'`)
    assert.equal((await client.query('SELECT count(*)::int AS count FROM "WorkspaceSession"')).rows[0].count, 0)
    assert.equal((await client.query('SELECT count(*)::int AS count FROM "WorkspaceSignInLink"')).rows[0].count, 0)
    await assert.rejects(
      client.query(`INSERT INTO "WorkspaceSession" (id, "tenantId", "userId", "sessionIdHash", "expiresAt") VALUES ('dup', 'email-link-cn', 'email-link-admin', 'hash-3', NOW()), ('dup-2', 'email-link-cn', 'email-link-admin', 'hash-3', NOW())`),
      /duplicate key/,
    )
  } finally {
    await client.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`).catch(() => {})
    await admin.end().catch(() => {})
  }
})
