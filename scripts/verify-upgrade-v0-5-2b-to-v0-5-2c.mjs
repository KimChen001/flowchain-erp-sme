import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createAttachmentService } from "../server/domain/attachment-service.mjs";
import { createMobileSyncService } from "../server/domain/mobile-sync-service.mjs";
import { createDbProcurementCommandService } from "../server/domain/procurement-db-command-service.mjs";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const migrationsRoot = join(root, "prisma", "migrations");
const baselineMigration = "20260720020000_settlement_workflow_mobile_foundation";
const targetMigration = "20260725010000_postgres_only_runtime_records";
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});

const port = await freePort();
const password = `phase-52b-upgrade-${randomUUID()}`;
const user = "flowchain_phase52b_upgrade";
const database = "flowchain_phase52b_exact_upgrade";
const directory = await mkdtemp(join(tmpdir(), "flowchain-phase52b-exact-upgrade-"));
const storageRoot = join(directory, "attachments");
const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "true", FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: "true", FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true", FLOWCHAIN_SYNC_CURSOR_CURRENT_KEY_ID: "upgrade-current", FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET: "upgrade-current-secret-at-least-32-characters", FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local", FLOWCHAIN_UPLOAD_STORAGE_DIR: storageRoot, FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true", NODE_ENV: "test" };
const pg = new EmbeddedPostgres({ databaseDir: directory, user, password, port, persistent: false, onLog: () => {}, onError: () => {} });
const tenantId = "tenant-exact-52b-upgrade", actorId = "user-exact-52b-upgrade", rawDeviceId = "exact-52b-device";
const attachmentBytes = Buffer.from("exact-v0.5.2B-attachment-evidence");
const attachmentHash = createHash("sha256").update(attachmentBytes).digest("hex");
const deviceHash = createHash("sha256").update(rawDeviceId).digest("hex");
let prisma;

async function query(sql, params = []) {
  const client = pg.getPgClient(database, "127.0.0.1");
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

async function queryStatements(sql, params = []) {
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
    const indexes = [...new Set([...statement.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((left, right) => left - right);
    const positions = new Map(indexes.map((original, index) => [original, index + 1]));
    const normalized = statement.replace(/\$(\d+)/g, (_match, value) => `$${positions.get(Number(value))}`);
    await query(normalized, indexes.map((index) => params[index - 1]));
  }
}

async function applyThroughBaseline() {
  const names = (await readdir(migrationsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name <= baselineMigration).map((entry) => entry.name).sort();
  assert.equal(names.at(-1), baselineMigration);
  for (const name of names) {
    await query(await readFile(join(migrationsRoot, name, "migration.sql"), "utf8"));
    await execFileAsync(process.execPath, [prismaCli, "migrate", "resolve", "--applied", name], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  }
}

async function latestMigrationName() {
  return (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .at(-1);
}

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  await applyThroughBaseline();
  await mkdir(join(storageRoot, tenantId), { recursive: true });
  await writeFile(join(storageRoot, tenantId, "upgrade-upload"), attachmentBytes);
  await queryStatements(`
    INSERT INTO "Tenant" ("id","name","version","updatedAt") VALUES ($1,'Exact v0.5.2B Upgrade',2,CURRENT_TIMESTAMP);
    INSERT INTO "User" ("id","tenantId","email","name","role","version","updatedAt") VALUES ($2,$1,'upgrade@example.invalid','Upgrade Actor','custom',4,CURRENT_TIMESTAMP);
    INSERT INTO "TenantRole" ("id","tenantId","roleKey","name","status","version","updatedAt") VALUES ('upgrade-role',$1,'upgrade-role','Upgrade Role','active',1,CURRENT_TIMESTAMP);
    INSERT INTO "TenantRolePermission" ("id","tenantId","roleId","permissionCode") VALUES
      ('upgrade-grant-mobile',$1,'upgrade-role','mobile.sync.use'),
      ('upgrade-grant-po-read',$1,'upgrade-role','procurement.purchase_order.read'),
      ('upgrade-grant-po-approve',$1,'upgrade-role','procurement.purchase_order.approve'),
      ('upgrade-grant-receiving-read',$1,'upgrade-role','receiving.read');
    INSERT INTO "UserRoleAssignment" ("id","tenantId","userId","roleId","status") VALUES ('upgrade-assignment',$1,$2,'upgrade-role','active');
    INSERT INTO "PurchaseOrder" ("id","tenantId","status","supplierId","supplierName","amount","currency","version","updatedAt") VALUES ('upgrade-po',$1,'pending_approval','upgrade-supplier','Upgrade Supplier',123.45,'CNY',3,CURRENT_TIMESTAMP);
    INSERT INTO "PurchaseOrderLine" ("id","purchaseOrderId","sku","itemName","orderedQuantity","receivedQuantity","unit","unitPrice","amount","version") VALUES ('upgrade-po-line','upgrade-po','UPGRADE-SKU','Upgrade Item',2,0,'EA',61.725,123.45,2);
    INSERT INTO "ReceivingDocument" ("id","tenantId","documentNumber","poId","status","workflowStatus","postingStatus","version","warehouseId","currency","updatedAt") VALUES ('upgrade-receiving',$1,'GRN-UPGRADE','upgrade-po','receiving','draft','unposted',5,'upgrade-warehouse','CNY',CURRENT_TIMESTAMP);
    INSERT INTO "ReceivingLine" ("id","receivingDocumentId","purchaseOrderLineId","sku","itemName","acceptedQty","rejectedQty","unit","warehouseId","locationKey","version") VALUES ('upgrade-receiving-line','upgrade-receiving','upgrade-po-line','UPGRADE-SKU','Upgrade Item',0.5,0,'EA','upgrade-warehouse','a-01',1);
    INSERT INTO "CashbookAccount" ("id","tenantId","accountCode","name","accountType","currency","openingBalance","currentBalance","status","version","updatedAt") VALUES ('upgrade-cashbook',$1,'UPGRADE-CNY','Upgrade Cashbook','bank','CNY',500,460,'active',2,CURRENT_TIMESTAMP);
    INSERT INTO "SettlementDocument" ("id","tenantId","settlementNumber","direction","counterpartyType","counterpartyId","cashbookAccountId","currency","amount","settlementDate","status","workflowStatus","postingStatus","cashAmount","totalSettlementAmount","version","updatedAt") VALUES ('upgrade-settlement',$1,'SET-UPGRADE','disbursement','supplier','upgrade-supplier','upgrade-cashbook','CNY',40,CURRENT_TIMESTAMP,'posted','posted','posted',40,40,6,CURRENT_TIMESTAMP);
    INSERT INTO "PartnerAdvance" ("id","tenantId","advanceNumber","advanceType","supplierId","currency","originalAmount","appliedAmount","remainingAmount","sourceSettlementId","status","version","updatedAt") VALUES ('upgrade-advance',$1,'ADV-UPGRADE','supplier_advance','upgrade-supplier','CNY',10,2,8,'upgrade-settlement','partially_applied',3,CURRENT_TIMESTAMP);
    INSERT INTO "SyncClient" ("id","tenantId","userId","deviceIdHash","platform","status","lastAcknowledgedSequence","authorizationFingerprint","updatedAt") VALUES ('upgrade-sync-client',$1,$2,$3,'pwa','active',0,'legacy-fingerprint',CURRENT_TIMESTAMP);
    INSERT INTO "DomainChangeFeed" ("tenantId","entityType","entityId","operation","entityVersion","source","payloadHash","sensitivityGroups") VALUES ($1,'PurchaseOrder','upgrade-po','upsert',3,'v0.5.2b-upgrade',$4,ARRAY[]::TEXT[]);
    INSERT INTO "StagedUpload" ("id","tenantId","fileName","mimeType","sizeBytes","sha256","storageKey","status","createdById","expiresAt","metadata") VALUES ('upgrade-upload',$1,'upgrade-proof.txt','text/plain',$5,$6,$7,'bound',$2,CURRENT_TIMESTAMP + INTERVAL '1 day','{}'::jsonb);
    INSERT INTO "ReceivingAttachment" ("id","tenantId","receivingDocumentId","uploadId","fileName","mimeType","sizeBytes","sha256","status","createdById") VALUES ('upgrade-attachment',$1,'upgrade-receiving','upgrade-upload','upgrade-proof.txt','text/plain',$5,$6,'active',$2);
  `, [tenantId, actorId, deviceHash, createHash("sha256").update("upgrade-feed").digest("hex"), attachmentBytes.length, attachmentHash, `${tenantId}/upgrade-upload`]);

  const before = (await query(`SELECT
    (SELECT "status" FROM "PurchaseOrder" WHERE "id"='upgrade-po') AS po_status,
    (SELECT "version" FROM "PurchaseOrder" WHERE "id"='upgrade-po') AS po_version,
    (SELECT "amount"::text FROM "PurchaseOrder" WHERE "id"='upgrade-po') AS po_amount,
    (SELECT "version" FROM "ReceivingDocument" WHERE "id"='upgrade-receiving') AS receiving_version,
    (SELECT "postingStatus" FROM "SettlementDocument" WHERE "id"='upgrade-settlement') AS settlement_status,
    (SELECT "remainingAmount"::text FROM "PartnerAdvance" WHERE "id"='upgrade-advance') AS advance_remaining,
    (SELECT "version" FROM "User" WHERE "id"=$1) AS user_version`, [actorId])).rows[0];

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  const appliedMigrations = await query(`SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`);
  assert.ok(appliedMigrations.rows.some((row) => row.migration_name === targetMigration));
  const latest = await query(`SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "finished_at" DESC, "migration_name" DESC LIMIT 1`);
  assert.equal(latest.rows[0].migration_name, await latestMigrationName());
  const after = (await query(`SELECT
    (SELECT "status" FROM "PurchaseOrder" WHERE "id"='upgrade-po') AS po_status,
    (SELECT "version" FROM "PurchaseOrder" WHERE "id"='upgrade-po') AS po_version,
    (SELECT "amount"::text FROM "PurchaseOrder" WHERE "id"='upgrade-po') AS po_amount,
    (SELECT "version" FROM "ReceivingDocument" WHERE "id"='upgrade-receiving') AS receiving_version,
    (SELECT "postingStatus" FROM "SettlementDocument" WHERE "id"='upgrade-settlement') AS settlement_status,
    (SELECT "remainingAmount"::text FROM "PartnerAdvance" WHERE "id"='upgrade-advance') AS advance_remaining,
    (SELECT "version" FROM "User" WHERE "id"=$1) AS user_version`, [actorId])).rows[0];
  assert.deepEqual(after, before);

  const feed = (await query(`SELECT "moduleKey", "authorizationClass", "resourceTenantId", "scopeWarehouseIds" FROM "DomainChangeFeed" WHERE "entityId"='upgrade-po' ORDER BY "sequence" LIMIT 1`)).rows[0];
  assert.deepEqual(feed, { moduleKey: null, authorizationClass: null, resourceTenantId: null, scopeWarehouseIds: [] });
  const upload = (await query(`SELECT "storageProvider", "storageVersion", "persistedAt" IS NOT NULL AS persisted, "storageHealthStatus" FROM "StagedUpload" WHERE "id"='upgrade-upload'`)).rows[0];
  assert.deepEqual(upload, { storageProvider: "local", storageVersion: "v1", persisted: true, storageHealthStatus: "unknown" });
  assert.equal((await query(`SELECT to_regclass('"SyncSnapshotSession"') IS NOT NULL AS present`)).rows[0].present, true);
  assert.ok(Number((await query(`SELECT COUNT(*) FROM pg_indexes WHERE tablename='SyncSnapshotSession'`)).rows[0].count) >= 3);
  assert.ok(Number((await query(`SELECT COUNT(*) FROM pg_constraint WHERE conrelid='"SyncSnapshotSession"'::regclass AND contype='f'`)).rows[0].count) >= 3);

  prisma = await createPrismaClient(env);
  const identity = { authenticated: true, tenantId, userId: actorId, role: "custom" };
  const sync = createMobileSyncService({ prisma, env });
  const registered = await sync.register({ deviceId: rawDeviceId, platform: "pwa", appVersion: "0.5.2c1" }, { identity });
  let initial = await sync.initial({ clientId: registered.clientId, deviceId: rawDeviceId, pageSize: 10 }, { identity });
  const initialChanges = [...initial.changes];
  while (initial.hasMore) {
    initial = await sync.initial({ clientId: registered.clientId, deviceId: rawDeviceId, snapshotSessionId: initial.snapshotSessionId, snapshotCursor: initial.snapshotCursor }, { identity });
    initialChanges.push(...initial.changes);
  }
  assert.ok(initialChanges.some((change) => change.entityType === "PurchaseOrder" && change.entityId === "upgrade-po"));

  const procurement = createDbProcurementCommandService({ prisma, env });
  const approved = await procurement.approvePurchaseOrder("upgrade-po", { expectedVersion: 3, idempotencyKey: "upgrade-po-approve" }, { identity });
  assert.equal(approved.status, "approved");
  assert.equal(approved.entityVersion, 4);

  const attachments = createAttachmentService({ prisma, env });
  const downloaded = await attachments.download("upgrade-attachment", { identity });
  assert.equal(downloaded.fileName, "upgrade-proof.txt");
  assert.equal(downloaded.mimeType, "text/plain");
  assert.equal(downloaded.sha256, attachmentHash);
  assert.deepEqual(downloaded.bytes, attachmentBytes);
  assert.equal(await prisma.auditLog.count({ where: { tenantId, action: "attachment_downloaded", entityId: "upgrade-attachment" } }), 1);
  console.log("v0.5.2B -> current additive upgrade regression gate: 1 passed; 0 failed; 0 skipped");
} finally {
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
