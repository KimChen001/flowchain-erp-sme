import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { backfillTenantAuthorization } from "../server/auth/authorization-backfill.mjs";
import { capabilityForEnvironment } from "../server/domain/capability-registry.mjs";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});
const pgPort = await freePort();
const apiPort = await freePort();
const password = `legacy-import-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-legacy-import-pg-"));
const storage = await mkdtemp(join(tmpdir(), "flowchain-legacy-import-storage-"));
const database = "flowchain_legacy_import_authority";
const tenantA = "tenant-legacy-import-a";
const tenantB = "tenant-legacy-import-b";
const url = `postgresql://flowchain_legacy_import:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_TEST: url,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_DEFAULT_TENANT_ID: tenantA,
  FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: "true",
  FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: "true",
  FLOWCHAIN_INTAKE_LOCAL_STORAGE_DIR: storage,
  FLOWCHAIN_LOCAL_SESSION_SECRET: "legacy-import-authority-session-secret-at-least-32-characters",
  NODE_ENV: "test",
  SCM_API_PORT: String(apiPort),
};
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_legacy_import", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
let prisma;
let child;
let assertions = 0;

function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

async function startApi() {
  const processChild = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  processChild.stderr.on("data", chunk => process.stderr.write(String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")));
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok) return processChild;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("Legacy Import Authority API did not become ready.");
}

async function stopApi() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolveExit => child.once("exit", resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child = null;
}

async function request(path, { userId, role = "admin", method = "GET", body, authenticated = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { "x-flowchain-user": userId || "legacy-admin-a", "x-flowchain-role": role } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json() };
}

async function businessCounts() {
  const [items, suppliers, warehouses, locations, purchaseOrders, purchaseOrderLines, movements, balances] = await Promise.all([
    prisma.item.count(), prisma.supplier.count(), prisma.warehouse.count(), prisma.warehouseLocation.count(),
    prisma.purchaseOrder.count(), prisma.purchaseOrderLine.count(), prisma.inventoryMovement.count(), prisma.inventoryBalance.count(),
  ]);
  return { items, suppliers, warehouses, locations, purchaseOrders, purchaseOrderLines, movements, balances };
}

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  await run(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.createMany({ data: [{ id: tenantA, name: "Legacy Import A" }, { id: tenantB, name: "Legacy Import B" }] });
  await prisma.user.createMany({ data: [
    { id: "legacy-admin-a", tenantId: tenantA, email: "admin-a@legacy.invalid", name: "Legacy Admin A", role: "admin", status: "active" },
    { id: "legacy-admin-b", tenantId: tenantB, email: "admin-b@legacy.invalid", name: "Legacy Admin B", role: "admin", status: "active" },
  ] });
  await backfillTenantAuthorization(prisma, tenantA, { actorId: "legacy-admin-a" });
  await backfillTenantAuthorization(prisma, tenantB, { actorId: "legacy-admin-b" });
  await prisma.importBatch.create({
    data: {
      id: "pilot-existing", tenantId: tenantA, importType: "items", fileName: "historical.csv",
      fileHash: "a".repeat(64), status: "ready", totalRows: 1, validRows: 1, createdById: "legacy-admin-a",
      normalizedRows: [{ rowNumber: 2, sku: "MUST-NOT-COMMIT", name: "Historical", unit: "EA", status: "active" }],
      summary: { legacy: true, authoritative: false },
    },
  });
  const before = await businessCounts();
  check(await prisma.importBatch.count(), 1, "one historical ImportBatch is seeded");
  const defaultIntake = capabilityForEnvironment("universal-intake", {});
  check(defaultIntake.enabled, false, "Universal Intake is disabled by default");
  await prisma.$disconnect();
  prisma = null;
  child = await startApi();

  const unauthenticated = await request("/api/imports/preview", { method: "POST", body: {}, authenticated: false });
  check(unauthenticated.status, 401, "legacy routes require authentication");
  check(unauthenticated.payload.code, "AUTHENTICATION_REQUIRED");

  for (const [method, path, body] of [
    ["POST", "/api/imports/preview", { importType: "items", rows: [{ sku: "NO-WRITE" }] }],
    ["GET", "/api/imports/pilot-existing"],
    ["GET", "/api/imports/pilot-existing/issues"],
    ["POST", "/api/imports/pilot-existing/commit", { idempotencyKey: "must-not-commit" }],
    ["POST", "/api/imports/pilot-existing/cancel", {}],
    ["GET", "/api/import-batches"],
    ["GET", "/api/import-batches/legacy-existing"],
    ["POST", "/api/import-batches/legacy-existing/rollback", { reason: "must-not-mutate" }],
  ]) {
    const retired = await request(path, { userId: "legacy-admin-a", method, body });
    check(retired.status, 501, `${method} ${path} is retired`);
    check(retired.payload.code, "FLOWCHAIN_LEGACY_IMPORT_PIPELINE_RETIRED");
    check(retired.payload.capability, "legacy-imports");
  }
  const crossTenantLegacy = await request("/api/imports/pilot-existing/commit", { userId: "legacy-admin-b", method: "POST", body: { idempotencyKey: "tenant-b" } });
  check(crossTenantLegacy.status, 501, "legacy commit remains retired for another tenant");

  const capabilities = await request("/api/capabilities", { userId: "legacy-admin-a" });
  const byId = Object.fromEntries(capabilities.payload.capabilities.map(row => [row.id, row]));
  check(byId.imports.maturity, "unavailable", "imports capability is unavailable");
  check(byId.imports.enabled, false);
  check(byId.imports.writeReady, false);
  check(byId.imports.businessCommitReady, false);
  check(byId["universal-intake"].enabled, true, "explicit Universal Intake preview is enabled");
  check(byId["universal-intake"].businessCommitReady, false);
  check((await request("/api/intake/artifacts", { userId: "legacy-admin-a" })).status, 200, "Universal Intake preview is accessible");

  const artifact = await request("/api/intake/artifacts", {
    userId: "legacy-admin-a", method: "POST",
    body: { sourceType: "manual_upload", originalFilename: "authority.csv", mimeType: "text/csv", contentBase64: Buffer.from("sku\nSAFE\n").toString("base64") },
  });
  check(artifact.status, 201, "Universal Intake artifact metadata writes remain preview-enabled");
  const crossTenantArtifact = await request(`/api/intake/artifacts/${artifact.payload.id}`, { userId: "legacy-admin-b" });
  assert.ok([403, 404].includes(crossTenantArtifact.status), "Universal Intake cross-tenant ID probing must fail closed");
  assertions += 1;
  const batch = await request("/api/intake/batches", { userId: "legacy-admin-a", method: "POST", body: { artifactId: artifact.payload.id, batchType: "generic" } });
  check(batch.status, 201);
  const commit = await request(`/api/intake/batches/${batch.payload.id}/commit`, {
    userId: "legacy-admin-a", method: "POST", body: { idempotencyKey: "universal-blocked" },
  });
  check(commit.status, 501, "Universal Intake business commit fails closed");
  check(commit.payload.code, "FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED");
  check(commit.payload.status, "blocked");

  await stopApi();
  prisma = await createPrismaClient(env);
  check(await prisma.importBatch.count(), 1, "legacy calls create no ImportBatch");
  check((await prisma.importBatch.findUnique({ where: { id: "pilot-existing" } })).status, "ready", "historical batch cannot be recommitted or cancelled");
  check(await businessCounts(), before, "legacy and Universal commit calls write no formal business tables");
  check(await prisma.commitAttempt.count({ where: { tenantId: tenantA, status: "blocked" } }), 1, "blocked CommitAttempt is durable");
  await assert.rejects(
    prisma.commitAttempt.create({
      data: {
        id: "forbidden-pending", tenantId: tenantA, batchId: batch.payload.id, status: "pending",
        idempotencyKey: "forbidden-pending", requestedByUserId: "legacy-admin-a",
      },
    }),
  );
  assertions += 1;

  console.log(`Legacy Import Authority gate: ${assertions} passed, 0 failed, 0 skipped`);
} finally {
  await stopApi();
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  await rm(storage, { recursive: true, force: true }).catch(() => {});
}
