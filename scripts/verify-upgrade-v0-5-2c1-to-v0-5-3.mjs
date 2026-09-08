import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const migrations = join(root, "prisma", "migrations");
const baseline = "20260722010000_mobile_authority_evidence_hardening";
const target = "20260722020000_bank_statement_reconciliation_foundation";
const hardening = "20260722030000_bank_reconciliation_control_hardening";
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});
const port = await freePort();
const password = `phase53-upgrade-${randomUUID()}`;
const user = "flowchain_phase53_upgrade", database = "flowchain_phase53_upgrade";
const directory = await mkdtemp(join(tmpdir(), "flowchain-phase53-upgrade-"));
const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_PERSISTENCE_MODE: "database", NODE_ENV: "test" };
const pg = new EmbeddedPostgres({ databaseDir: directory, user, password, port, persistent: false, onLog: () => {}, onError: () => {} });

async function query(sql, params = []) {
  const client = pg.getPgClient(database, "127.0.0.1");
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database);
  const names = (await readdir(migrations, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name <= baseline).map((entry) => entry.name).sort();
  assert.equal(names.at(-1), baseline);
  for (const name of names) {
    await query(await readFile(join(migrations, name, "migration.sql"), "utf8"));
    await run(process.execPath, [prismaCli, "migrate", "resolve", "--applied", name], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  }
  await query(`INSERT INTO "Tenant" ("id","name","version","updatedAt") VALUES ('phase53-upgrade-tenant','Phase 5.2C.1 Preserved Tenant',3,CURRENT_TIMESTAMP)`);
  await query(`INSERT INTO "User" ("id","tenantId","email","name","role","version","updatedAt") VALUES ('phase53-upgrade-user','phase53-upgrade-tenant','upgrade@phase53.invalid','Upgrade User','admin',2,CURRENT_TIMESTAMP)`);
  await query(`INSERT INTO "CashbookAccount" ("id","tenantId","accountCode","name","accountType","currency","openingBalance","currentBalance","status","version","updatedAt") VALUES ('phase53-upgrade-account','phase53-upgrade-tenant','UPGRADE-CNY','Preserved Bank','bank','CNY',100,100,'active',4,CURRENT_TIMESTAMP)`);
  const before = (await query(`SELECT "name","version" FROM "Tenant" WHERE "id"='phase53-upgrade-tenant'`)).rows[0];
  await run(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  assert.deepEqual((await query(`SELECT "name","version" FROM "Tenant" WHERE "id"='phase53-upgrade-tenant'`)).rows[0], { ...before, version: before.version + 1 });
  // Deploy includes the one-time English interface migration, which versions the tenant.
  assert.equal((await query(`SELECT "defaultLanguage" FROM "Tenant" WHERE "id"='phase53-upgrade-tenant'`)).rows[0].defaultLanguage, "en-US");
  assert.equal((await query(`SELECT "version" FROM "CashbookAccount" WHERE "id"='phase53-upgrade-account'`)).rows[0].version, 4);
  const applied = (await query(`SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`)).rows.map((row) => row.migration_name);
  assert.ok(applied.includes(target));
  assert.ok(applied.indexOf(target) < applied.indexOf(hardening));
  for (const table of ["BankStatementMappingTemplate", "BankStatementImportBatch", "BankStatementLine", "BankReconciliationGroup", "BankReconciliationException"]) {
    assert.equal((await query(`SELECT to_regclass('"${table}"') IS NOT NULL AS present`)).rows[0].present, true);
  }
  await query(`INSERT INTO "TenantRole" ("id","tenantId","roleKey","name","status","version","updatedAt") VALUES ('phase53-upgrade-role','phase53-upgrade-tenant','phase53-upgrade-role','Upgrade Role','active',1,CURRENT_TIMESTAMP)`);
  await query(`INSERT INTO "TenantRolePermission" ("id","tenantId","roleId","permissionCode") VALUES ('phase53-upgrade-grant','phase53-upgrade-tenant','phase53-upgrade-role','finance.bank_reconciliation.confirm')`);
  assert.equal(Number((await query(`SELECT COUNT(*) FROM "TenantRolePermission" WHERE "id"='phase53-upgrade-grant'`)).rows[0].count), 1);
  console.log("Exact v0.5.2C.1 -> v0.5.3 upgrade gate: 1 passed; 0 failed; 0 skipped");
} finally {
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
