import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";
import { productionHarnessMailEnv, signInThroughEmailLink } from "./test-support/production-harness.mjs";

// The CSV import against a real server in production mode: download a
// template, preview and commit items, then opening stock, which lands as a
// draft adjustment for a person to ready and post.
const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-data-import-api";
const email = "data-import@flowchain.invalid";
const actorId = `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});
async function waitFor(url) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try { if ((await fetch(url)).ok) return; } catch { /* not listening yet */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("API did not become ready");
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function call(base, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = text;
  try { payload = JSON.parse(text); } catch { /* a CSV template */ }
  return { status: response.status, payload, contentType: response.headers.get("content-type") || "" };
}
const csv = (lines) => Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8").toString("base64");
const committable = (preview) => preview.rows.filter((row) => row.action !== "error").map(({ rowNumber, values }) => ({ rowNumber, values }));

const pgPort = await freePort();
const apiPort = await freePort();
const password = `local-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-data-import-api-"));
const database = "flowchain_data_import_api";
const url = `postgresql://flowchain_data_import_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_data_import_api", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_TEST: url,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DATA_IMPORT: "true",
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "true",
  FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
  FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
  FLOWCHAIN_LOCAL_SESSION_SECRET: `data-import-api-${randomUUID()}-secure`,
  FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
  FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
  FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
  FLOWCHAIN_COMMIT_SHA: "data-import-api-smoke",
  FLOWCHAIN_BRANCH: "test/data-import-api-smoke",
  FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "false",
  SCM_API_PORT: String(apiPort),
  ...productionHarnessMailEnv(),
  NODE_ENV: "production",
};
const base = `http://127.0.0.1:${apiPort}`;
let api;
let prisma;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 10 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.create({ data: { id: tenantId, name: "Data Import API", currency: "USD" } });
  await prisma.user.create({ data: { id: actorId, tenantId, email, name: "Import Manager", role: "manager" } });
  await prisma.warehouse.create({ data: { id: "warehouse-main", tenantId, code: "MAIN", name: "Main warehouse" } });
  await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId, userId: actorId, warehouseId: "warehouse-main", accessLevel: "operate" } });
  api = spawn(node, ["server/index.mjs"], { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
  await waitFor(`${base}/api/health`);
  const { token } = await signInThroughEmailLink(base, prisma, { tenantId, email });

  const capabilities = await call(base, "/api/capabilities", { token });
  assert.equal(capabilities.payload.capabilities.find((entry) => entry.id === "data-import")?.enabled, true);
  const template = await call(base, "/api/data-import/templates/items", { token });
  assert.equal(template.status, 200);
  assert.match(template.contentType, /^text\/csv/);
  // fetch drops the byte order mark when it decodes the text.
  assert.ok(template.payload.replace(/^﻿/, "").startsWith("SKU,Item name,Category,Specification,Unit"));

  // Items: preview writes nothing; commit creates; a second commit replays.
  const itemsPreview = await call(base, "/api/data-import/items/preview", {
    token,
    method: "POST",
    body: { fileName: "items.csv", tenantId: "forged", contentBase64: csv(["SKU,Item name,Unit,Status", "SMOKE-1,Smoke valve,EA,Active", "SMOKE-2,Smoke pump,EA,Active", "SMOKE-3,,EA,Active"]) },
  });
  assert.equal(itemsPreview.status, 200, JSON.stringify(itemsPreview.payload));
  assert.deepEqual(itemsPreview.payload.counts, { rows: 3, create: 2, skip_existing: 0, error: 1 });
  assert.equal(await prisma.item.count({ where: { tenantId } }), 0);
  const itemsBody = { fileSha256: itemsPreview.payload.fileSha256, chunkIndex: 0, rows: committable(itemsPreview.payload) };
  const itemsCommit = await call(base, "/api/data-import/items/commit", { token, method: "POST", body: itemsBody });
  assert.equal(itemsCommit.status, 200, JSON.stringify(itemsCommit.payload));
  assert.deepEqual(itemsCommit.payload.counts, { rows: 2, created: 2, skipped_existing: 0, error: 0 });
  const itemsReplay = await call(base, "/api/data-import/items/commit", { token, method: "POST", body: itemsBody });
  assert.equal(itemsReplay.payload.idempotentReplay, true);
  assert.equal(await prisma.item.count({ where: { tenantId } }), 2);

  // Opening stock: one draft adjustment, readied and posted by a person.
  const openingPreview = await call(base, "/api/data-import/opening-stock/preview", {
    token,
    method: "POST",
    body: { fileName: "opening.csv", contentBase64: csv(["SKU,Warehouse code,Location,Quantity,Unit", "SMOKE-1,MAIN,A-01,12,EA", "SMOKE-2,MAIN,A-02,3,KG"]) },
  });
  assert.equal(openingPreview.status, 200, JSON.stringify(openingPreview.payload));
  assert.deepEqual(openingPreview.payload.rows.map((row) => row.action), ["create", "error"]);
  assert.equal(openingPreview.payload.rows[1].issues[0].code, "UNIT_MISMATCH");
  const openingCommit = await call(base, "/api/data-import/opening-stock/commit", {
    token,
    method: "POST",
    body: { fileSha256: openingPreview.payload.fileSha256, chunkIndex: 0, rows: committable(openingPreview.payload) },
  });
  assert.equal(openingCommit.status, 200, JSON.stringify(openingCommit.payload));
  assert.equal(openingCommit.payload.documents.length, 1);
  const [document] = openingCommit.payload.documents;
  const draft = await prisma.inventoryAdjustmentDocument.findUnique({ where: { id: document.id } });
  assert.deepEqual([draft.reasonCode, draft.workflowStatus, draft.postingStatus], ["opening_balance", "draft", "unposted"]);
  assert.equal(await prisma.inventoryBalance.count({ where: { tenantId } }), 0);
  const ready = await call(base, `/api/inventory/adjustments/${document.id}/ready`, { token, method: "POST", body: { expectedAdjustmentVersion: draft.version, idempotencyKey: "smoke-ready" } });
  assert.equal(ready.status, 200, JSON.stringify(ready.payload));
  const posted = await call(base, `/api/inventory/adjustments/${document.id}/post`, { token, method: "POST", body: { expectedAdjustmentVersion: ready.payload.adjustment.version, idempotencyKey: "smoke-post" } });
  assert.equal(posted.status, 200, JSON.stringify(posted.payload));
  const balance = await prisma.inventoryBalance.findFirst({ where: { tenantId, sku: "SMOKE-1" } });
  assert.equal(Number(balance.onHandQuantity), 12);
  // After posting, the same row is skipped: the location already holds stock.
  const afterPosting = await call(base, "/api/data-import/opening-stock/preview", { token, method: "POST", body: { fileName: "opening.csv", contentBase64: csv(["SKU,Warehouse code,Location,Quantity", "SMOKE-1,MAIN,a-01,12"]) } });
  assert.deepEqual([afterPosting.payload.rows[0].action, afterPosting.payload.rows[0].existing.reason], ["skip_existing", "STOCK_RECORD_HAS_STOCK"]);
  console.log("Data import API smoke: PASS (real server, PostgreSQL, signed session, items and opening stock)");
} finally {
  await stop(api);
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
