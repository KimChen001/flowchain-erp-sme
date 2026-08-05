import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const root = resolve(import.meta.dirname, "..");
const migrationsDirectory = join(root, "prisma", "migrations");
const targetMigration = "20260728010000_rfq_participation_revision_authority";
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolvePort(port));
  });
});

const port = await freePort();
const password = `rfq-revision-upgrade-${randomUUID()}`;
const user = "flowchain_rfq_revision_upgrade";
const directory = await mkdtemp(join(tmpdir(), "flowchain-rfq-revision-upgrade-"));
const pg = new EmbeddedPostgres({ databaseDir: directory, user, password, port, persistent: false, onLog: () => {}, onError: () => {} });

async function query(database, sql, params = []) {
  const client = pg.getPgClient(database, "127.0.0.1");
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const migrationNames = (await readdir(migrationsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name < targetMigration)
  .map((entry) => entry.name)
  .sort();
const targetSql = await readFile(join(migrationsDirectory, targetMigration, "migration.sql"), "utf8");

async function prepare(database) {
  await pg.createDatabase(database);
  for (const name of migrationNames) {
    await query(database, await readFile(join(migrationsDirectory, name, "migration.sql"), "utf8"));
  }
}

async function seedBase(database, suffix = "") {
  const tenantId = `tenant-rfq-upgrade${suffix}`;
  const supplierId = `supplier-rfq-upgrade${suffix}`;
  const rfqId = `rfq-upgrade${suffix}`;
  await query(database, `INSERT INTO "Tenant" ("id","name","updatedAt") VALUES ($1,'RFQ Upgrade Tenant',CURRENT_TIMESTAMP)`, [tenantId]);
  await query(database, `INSERT INTO "Supplier" ("id","tenantId","code","name","updatedAt") VALUES ($2,$1,$2,'RFQ Upgrade Supplier',CURRENT_TIMESTAMP)`, [tenantId, supplierId]);
  await query(database, `INSERT INTO "Rfq" ("id","tenantId","title","status","currency","updatedAt") VALUES ($2,$1,'RFQ Upgrade','collecting_quotes','CNY',CURRENT_TIMESTAMP)`, [tenantId, rfqId]);
  return { tenantId, supplierId, rfqId };
}

async function expectPreflight(name, seed, expected) {
  const database = `rfq_upgrade_${name}`;
  await prepare(database);
  await seed(database);
  await assert.rejects(() => query(database, targetSql), (error) => String(error.message).includes(expected));
  assert.equal((await query(database, `SELECT to_regclass('"SupplierQuotationRevision"') IS NULL AS absent`)).rows[0].absent, true);
}

try {
  await pg.initialise();
  await pg.start();

  const successDatabase = "rfq_upgrade_success";
  await prepare(successDatabase);
  const ids = await seedBase(successDatabase);
  await query(successDatabase, `INSERT INTO "RfqLine" ("id","rfqId","itemId","sku","itemName","quantity","unit","metadata") VALUES ('rfq-line-upgrade',$1,'item-upgrade','SKU-UPGRADE','Upgrade Item',3.2500,'EA','{"preserved":"rfq-line"}')`, [ids.rfqId]);
  await query(successDatabase, `INSERT INTO "SupplierQuotation" ("id","tenantId","rfqId","supplierId","supplierName","status","quotedAmount","currency","submittedAt","metadata","updatedAt") VALUES ('quotation-upgrade',$1,$3,$2,'RFQ Upgrade Supplier','received',123.4567,'CNY','2026-07-27T08:30:00Z','{"paymentTerms":"NET30","preserved":"header"}',CURRENT_TIMESTAMP)`, [ids.tenantId, ids.supplierId, ids.rfqId]);
  await query(successDatabase, `INSERT INTO "SupplierQuotationLine" ("id","supplierQuotationId","itemId","sku","itemName","quantity","unit","unitPrice","amount","metadata") VALUES ('quotation-line-upgrade','quotation-upgrade','item-upgrade','SKU-UPGRADE','Upgrade Item',3.2500,'EA',37.9867,123.4567,'{"preserved":"line"}')`);
  const legacyBefore = (await query(successDatabase, `SELECT "quotedAmount"::text AS amount,"metadata" FROM "SupplierQuotation" WHERE "id"='quotation-upgrade'`)).rows[0];
  const legacyLineBefore = (await query(successDatabase, `SELECT "quantity"::text AS quantity,"unitPrice"::text AS "unitPrice","amount"::text AS amount,"metadata" FROM "SupplierQuotationLine" WHERE "id"='quotation-line-upgrade'`)).rows[0];

  await query(successDatabase, targetSql);

  const revision = (await query(successDatabase, `SELECT * FROM "SupplierQuotationRevision" WHERE "quotationId"='quotation-upgrade'`)).rows[0];
  assert.equal(revision.revisionNumber, 1);
  assert.equal(revision.status, "submitted");
  assert.equal(revision.quotedAmount, legacyBefore.amount);
  assert.deepEqual(revision.metadata, legacyBefore.metadata);
  assert.equal(revision.source, "legacy_backfill");
  const revisionLine = (await query(successDatabase, `SELECT "sourceQuotationLineId","quantity"::text AS quantity,"unitPrice"::text AS "unitPrice","amount"::text AS amount,"metadata" FROM "SupplierQuotationRevisionLine"`)).rows[0];
  assert.equal(revisionLine.sourceQuotationLineId, "quotation-line-upgrade");
  assert.deepEqual({ quantity: revisionLine.quantity, unitPrice: revisionLine.unitPrice, amount: revisionLine.amount, metadata: revisionLine.metadata }, legacyLineBefore);
  const participation = (await query(successDatabase, `SELECT * FROM "RfqSupplierParticipation" WHERE "rfqId"=$1`, [ids.rfqId])).rows[0];
  assert.equal(participation.supplierId, ids.supplierId);
  assert.equal(participation.status, "response_recorded");
  assert.equal(participation.metadata.backfilledFromQuotationId, "quotation-upgrade");
  assert.deepEqual((await query(successDatabase, `SELECT "quotedAmount"::text AS amount,"metadata" FROM "SupplierQuotation" WHERE "id"='quotation-upgrade'`)).rows[0], legacyBefore);
  assert.deepEqual((await query(successDatabase, `SELECT "quantity"::text AS quantity,"unitPrice"::text AS "unitPrice","amount"::text AS amount,"metadata" FROM "SupplierQuotationLine" WHERE "id"='quotation-line-upgrade'`)).rows[0], legacyLineBefore);

  await assert.rejects(() => query(successDatabase, `UPDATE "SupplierQuotationRevision" SET "status"='withdrawn' WHERE "id"=$1`, [revision.id]), /append-only/);
  const revisionLineId = (await query(successDatabase, `SELECT "id" FROM "SupplierQuotationRevisionLine"`)).rows[0].id;
  await assert.rejects(() => query(successDatabase, `DELETE FROM "SupplierQuotationRevisionLine" WHERE "id"=$1`, [revisionLineId]), /append-only/);
  await query(successDatabase, `INSERT INTO "SupplierQuotationRevision" ("id","tenantId","quotationId","revisionNumber","status","currency","quotedAmount","source") VALUES ('revision-two',$1,'quotation-upgrade',2,'submitted','CNY',120.0000,'internal_recording')`, [ids.tenantId]);
  assert.equal((await query(successDatabase, `SELECT max("revisionNumber") AS latest FROM "SupplierQuotationRevision" WHERE "quotationId"='quotation-upgrade'`)).rows[0].latest, 2);

  await expectPreflight("missing", async (database) => {
    const base = await seedBase(database, "-missing");
    await query(database, `INSERT INTO "SupplierQuotation" ("id","tenantId","rfqId","supplierId","status","currency","updatedAt") VALUES ('quotation-missing',$1,$2,'','submitted','CNY',CURRENT_TIMESTAMP)`, [base.tenantId, base.rfqId]);
  }, "RFQ_REVISION_MISSING_RELATION");

  await expectPreflight("duplicate", async (database) => {
    const base = await seedBase(database, "-duplicate");
    await query(database, `INSERT INTO "SupplierQuotation" ("id","tenantId","rfqId","supplierId","status","currency","updatedAt") VALUES ('quotation-duplicate-a',$1,$3,$2,'submitted','CNY',CURRENT_TIMESTAMP),('quotation-duplicate-b',$1,$3,$2,'submitted','CNY',CURRENT_TIMESTAMP)`, [base.tenantId, base.supplierId, base.rfqId]);
  }, "RFQ_REVISION_DUPLICATE_SUPPLIER_RESPONSE");

  await expectPreflight("cross_tenant", async (database) => {
    const base = await seedBase(database, "-cross-a");
    await query(database, `INSERT INTO "Tenant" ("id","name","updatedAt") VALUES ('tenant-rfq-upgrade-cross-b','Other Tenant',CURRENT_TIMESTAMP)`);
    await query(database, `INSERT INTO "Rfq" ("id","tenantId","title","status","currency","updatedAt") VALUES ('rfq-upgrade-cross-b','tenant-rfq-upgrade-cross-b','Other RFQ','open','CNY',CURRENT_TIMESTAMP)`);
    await query(database, `INSERT INTO "SupplierQuotation" ("id","tenantId","rfqId","supplierId","status","currency","updatedAt") VALUES ('quotation-cross',$1,'rfq-upgrade-cross-b',$2,'submitted','CNY',CURRENT_TIMESTAMP)`, [base.tenantId, base.supplierId]);
  }, "RFQ_REVISION_TENANT_RELATION_MISMATCH");

  await expectPreflight("unknown_status", async (database) => {
    const base = await seedBase(database, "-status");
    await query(database, `INSERT INTO "SupplierQuotation" ("id","tenantId","rfqId","supplierId","status","currency","updatedAt") VALUES ('quotation-status',$1,$3,$2,'future_status','CNY',CURRENT_TIMESTAMP)`, [base.tenantId, base.supplierId, base.rfqId]);
  }, "RFQ_REVISION_UNKNOWN_STATUS");

  await expectPreflight("negative", async (database) => {
    const base = await seedBase(database, "-negative");
    await query(database, `INSERT INTO "SupplierQuotation" ("id","tenantId","rfqId","supplierId","status","quotedAmount","currency","updatedAt") VALUES ('quotation-negative',$1,$3,$2,'submitted',-1.0000,'CNY',CURRENT_TIMESTAMP)`, [base.tenantId, base.supplierId, base.rfqId]);
  }, "RFQ_REVISION_NEGATIVE_DECIMAL");

  console.log("RFQ participation/revision upgrade gate: 6 passed; 0 failed; 0 skipped");
} finally {
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
