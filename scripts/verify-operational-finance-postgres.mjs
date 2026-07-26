import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const migrationsRoot = join(root, "prisma", "migrations");
const phase4Migration = "20260718040000_operations_settings_closeout";
const phase5P2pMigration = "20260718050000_operational_finance_p2p";
const phase5O2cMigration = "20260718060000_operational_finance_o2c";
const latestMigration = "20260725010000_postgres_only_runtime_records";
const node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");

const sanitize = (value, secrets = []) =>
  secrets
    .reduce(
      (output, secret) => output.split(secret).join("[REDACTED]"),
      String(value || ""),
    )
    .replace(
      /postgres(?:ql)?:\/\/[^\s]+/gi,
      "[REDACTED_DATABASE_URL]",
    );

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });

async function run(command, args, env, secrets) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      env,
      maxBuffer: 30 * 1024 * 1024,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (output.trim()) process.stdout.write(sanitize(output, secrets));
    return output;
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`;
    if (output.trim()) process.stdout.write(sanitize(output, secrets));
    throw error;
  }
}

function url({ user, password, port, database }) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
}

function envFor(databaseUrl) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_TEST: databaseUrl,
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
    FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS: "true",
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    NODE_ENV: "test",
  };
}

async function query(pg, database, sql, params = []) {
  const client = pg.getPgClient(database, "127.0.0.1");
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function migrationNames() {
  return (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function applyThroughPhase4(pg, database, databaseUrl, secrets) {
  const names = (await migrationNames()).filter(
    (name) => name <= phase4Migration,
  );
  for (const name of names) {
    const sql = await readFile(
      join(migrationsRoot, name, "migration.sql"),
      "utf8",
    );
    await query(pg, database, sql);
    await run(
      node,
      [prismaCli, "migrate", "resolve", "--applied", name],
      envFor(databaseUrl),
      secrets,
    );
  }
  return names;
}

const pgPort = await freePort();
const password = `operational-finance-${randomUUID()}`;
const user = "flowchain_operational_finance";
const directory = await mkdtemp(
  join(tmpdir(), "flowchain-operational-finance-pg-"),
);
const freshDatabase = "flowchain_operational_finance_fresh";
const upgradeDatabase = "flowchain_operational_finance_upgrade";
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user,
  password,
  port: pgPort,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(freshDatabase);
  await pg.createDatabase(upgradeDatabase);
  const freshUrl = url({
    user,
    password,
    port: pgPort,
    database: freshDatabase,
  });
  await run(
    node,
    [prismaCli, "migrate", "deploy"],
    envFor(freshUrl),
    [password],
  );
  const output = await run(
    node,
    [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      "server/domain/operational-finance-transaction.test.mjs",
      "server/domain/operational-finance-o2c-transaction.test.mjs",
    ],
    envFor(freshUrl),
    [password],
  );
  assert.match(output, /# fail 0(?:\r?\n|$)/);
  assert.match(output, /# skipped 0(?:\r?\n|$)/);

  const upgradeUrl = url({
    user,
    password,
    port: pgPort,
    database: upgradeDatabase,
  });
  const applied = await applyThroughPhase4(
    pg,
    upgradeDatabase,
    upgradeUrl,
    [password],
  );
  assert.equal(applied.at(-1), phase4Migration);
  await query(
    pg,
    upgradeDatabase,
    `
      INSERT INTO "Tenant" ("id", "name", "updatedAt")
      VALUES ('legacy-finance-tenant', 'Legacy Finance Tenant', CURRENT_TIMESTAMP);
      INSERT INTO "SupplierInvoice"
        ("id", "tenantId", "currency", "status", "updatedAt")
      VALUES
        ('legacy-supplier-invoice', 'legacy-finance-tenant', 'USD', 'pending', CURRENT_TIMESTAMP);
      INSERT INTO "ThreeWayMatch"
        ("id", "tenantId", "invoiceId", "currency", "status", "updatedAt")
      VALUES
        ('legacy-three-way-match', 'legacy-finance-tenant', 'legacy-orphan-invoice', 'USD', 'pending', CURRENT_TIMESTAMP);
    `,
  );
  await run(
    node,
    [prismaCli, "migrate", "deploy"],
    envFor(upgradeUrl),
    [password],
  );
  const latest = await query(
    pg,
    upgradeDatabase,
    `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "finished_at" DESC, "migration_name" DESC LIMIT 1`,
  );
  assert.equal(latest.rows[0].migration_name, latestMigration);
  const legacy = await query(
    pg,
    upgradeDatabase,
    `
      SELECT
        si."id",
        si."status",
        si."version",
        twm."invoiceId",
        to_regclass('"PayableObligation"') IS NOT NULL AS "hasPayable",
        to_regclass('"SupplierCreditMemo"') IS NOT NULL AS "hasCreditMemo",
        to_regclass('"CustomerInvoice"') IS NOT NULL AS "hasCustomerInvoice",
        to_regclass('"ReceivableObligation"') IS NOT NULL AS "hasReceivable"
      FROM "SupplierInvoice" si
      JOIN "ThreeWayMatch" twm ON twm."tenantId" = si."tenantId"
      WHERE si."id" = 'legacy-supplier-invoice'
    `,
  );
  assert.deepEqual(legacy.rows, [
    {
      id: "legacy-supplier-invoice",
      status: "pending",
      version: 0,
      invoiceId: "legacy-orphan-invoice",
      hasPayable: true,
      hasCreditMemo: true,
      hasCustomerInvoice: true,
      hasReceivable: true,
    },
  ]);
  console.log(
    "PostgreSQL operational finance verification: fresh PASS; Phase 4 upgrade PASS; 0 failed; 0 skipped",
  );
} finally {
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
