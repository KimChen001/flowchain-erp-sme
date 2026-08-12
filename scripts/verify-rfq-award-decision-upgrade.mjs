import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pgModule from "pg";

const { Client } = pgModule;
const root = resolve(import.meta.dirname, "..");
const awardMigrationName = "20260812010000_rfq_reviewed_award_decision";
const migrationsRoot = join(root, "prisma", "migrations");
const awardMigration = join(root, "prisma", "migrations", awardMigrationName, "migration.sql");
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
});

const port = await freePort();
const password = `rfq-award-upgrade-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-rfq-award-upgrade-"));
const database = "flowchain_rfq_award_upgrade";
const user = "flowchain_rfq_award_upgrade";
const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, NODE_ENV: "test" };
const pg = new EmbeddedPostgres({ databaseDir: directory, user, password, port, persistent: false, onLog: () => {}, onError: () => {} });
let client;

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database);
  client = new Client({ connectionString: url });
  await client.connect();
  const mainMigrations = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== awardMigrationName)
    .map((entry) => entry.name)
    .sort();
  for (const migrationName of mainMigrations) {
    await client.query(await readFile(join(migrationsRoot, migrationName, "migration.sql"), "utf8"));
  }
  await client.query(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ('award-upgrade-tenant', 'Award Upgrade Tenant', now())`);
  for (const roleKey of ["workspace-administrator", "operations-manager", "procurement-specialist"]) {
    await client.query(`INSERT INTO "TenantRole" ("id", "tenantId", "roleKey", "name", "isDefaultTemplate", "status", "updatedAt") VALUES ($1, 'award-upgrade-tenant', $2, $2, true, 'active', now())`, [`award-upgrade-${roleKey}`, roleKey]);
  }
  await client.query(await readFile(awardMigration, "utf8"));
  const grants = await client.query(`SELECT role."roleKey" FROM "TenantRolePermission" grant_row JOIN "TenantRole" role ON role."id" = grant_row."roleId" WHERE grant_row."permissionCode" = 'procurement.rfq_award.create' ORDER BY role."roleKey"`);
  assert.deepEqual(grants.rows.map((row) => row.roleKey), ["operations-manager", "workspace-administrator"]);
  await client.query(`INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode") VALUES ('award-upgrade-catalog-proof', 'award-upgrade-tenant', 'award-upgrade-procurement-specialist', 'procurement.rfq_award.create')`);
  await assert.rejects(client.query(`INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode") VALUES ('award-upgrade-unknown', 'award-upgrade-tenant', 'award-upgrade-procurement-specialist', 'unknown.permission')`));
  assert.equal((await client.query(`SELECT to_regclass('public."RfqAwardDecision"') IS NOT NULL AS present`)).rows[0].present, true);
  console.log("RFQ Award Decision current-main upgrade gate: passed");
} finally {
  await client?.end().catch(() => {}); await pg.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {});
}
