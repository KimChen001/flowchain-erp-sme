import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test('English rollout resets existing UI preferences and allows later Chinese selection', async () => {
  // Run only with scripts/run-postgres-test-files.mjs against its disposable DB.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  await client.connect()
  const id = `language-${randomUUID()}`
  try {
    await client.query(`INSERT INTO "Tenant" (id, name, "defaultLanguage", locale, timezone, currency, "updatedAt") VALUES ($1, 'Language test', 'zh-CN', 'zh-CN', 'Asia/Shanghai', 'CNY', NOW())`, [id])
    await client.query(`INSERT INTO "User" (id, "tenantId", email, name, "languagePreference", "updatedAt") VALUES ($1, $2, 'language@example.com', '中文姓名', 'zh-CN', NOW())`, [`${id}-user`, id])
    const migration = readFileSync(new URL('../../prisma/migrations/20260908120000_english_default_interface/migration.sql', import.meta.url), 'utf8')
    await client.query(migration)
    const tenant = (await client.query('SELECT * FROM "Tenant" WHERE id = $1', [id])).rows[0]
    const user = (await client.query('SELECT * FROM "User" WHERE id = $1', [`${id}-user`])).rows[0]
    assert.equal(tenant.defaultLanguage, 'en-US')
    assert.equal(user.languagePreference, 'en-US')
    assert.equal(tenant.version, 1)
    assert.equal(user.version, 1)
    assert.deepEqual([tenant.locale, tenant.timezone, tenant.currency, user.name], ['zh-CN', 'Asia/Shanghai', 'CNY', '中文姓名'])
    await client.query(`UPDATE "User" SET "languagePreference" = 'zh-CN' WHERE id = $1`, [`${id}-user`])
    assert.equal((await client.query('SELECT "languagePreference" FROM "User" WHERE id = $1', [`${id}-user`])).rows[0].languagePreference, 'zh-CN')
    await client.query(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ($1, 'New workspace', NOW())`, [`${id}-new`])
    assert.equal((await client.query('SELECT "defaultLanguage" FROM "Tenant" WHERE id = $1', [`${id}-new`])).rows[0].defaultLanguage, 'en-US')
  } finally {
    await client.query('DELETE FROM "User" WHERE "tenantId" = $1', [id])
    await client.query('DELETE FROM "Tenant" WHERE id = ANY($1)', [[id, `${id}-new`]])
    await client.end()
  }
})
