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
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const execFileAsync = promisify(execFile);
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
const password = `intake-api-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-intake-api-"));
const storage = await mkdtemp(join(tmpdir(), "flowchain-intake-api-storage-"));
const database = "flowchain_intake_api";
const tenantId = "tenant-intake-api";
const url = `postgresql://flowchain_intake_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_TEST: url,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
  FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: "true",
  FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: "true",
  FLOWCHAIN_INTAKE_LOCAL_STORAGE_DIR: storage,
  FLOWCHAIN_LOCAL_SESSION_SECRET: "intake-api-session-secret-at-least-32-characters",
  NODE_ENV: "test",
  SCM_API_PORT: String(apiPort),
};
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_intake_api", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
let prisma;
let child;
let assertions = 0;

const check = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
};

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
  throw new Error("Intake API did not become ready.");
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

async function request(path, { userId, role, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-flowchain-user": userId, "x-flowchain-role": role } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json() };
}

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.create({ data: { id: tenantId, name: "Intake API Tenant" } });
  await prisma.user.createMany({ data: [
    { id: "intake-admin", tenantId, email: "admin@intake.invalid", name: "Intake Admin", role: "admin", status: "active" },
    { id: "intake-viewer", tenantId, email: "viewer@intake.invalid", name: "Intake Viewer", role: "viewer", status: "active" },
  ] });
  await backfillTenantAuthorization(prisma, tenantId, { actorId: "intake-admin" });
  await prisma.$disconnect();
  prisma = null;
  child = await startApi();

  const unauthenticated = await request("/api/intake/artifacts");
  check(unauthenticated.status, 401, "authentication is required");
  check(unauthenticated.payload.code, "AUTHENTICATION_REQUIRED");

  const contentBase64 = Buffer.from("code,name\nSUP-API-1,Suzhou Components\n").toString("base64");
  const denied = await request("/api/intake/artifacts", {
    userId: "intake-viewer", role: "viewer", method: "POST",
    body: { originalFilename: "denied.csv", mimeType: "text/csv", contentBase64 },
  });
  check(denied.status, 403, "viewer cannot upload");
  check(denied.payload.code, "AUTHORIZATION_PERMISSION_DENIED");

  const unsupported = await request("/api/intake/artifacts", {
    userId: "intake-admin", role: "admin", method: "POST",
    body: { originalFilename: "unsafe.exe", mimeType: "application/octet-stream", contentBase64 },
  });
  check(unsupported.status, 415, "unsupported MIME fails closed");
  check(unsupported.payload.code, "INTAKE_MIME_UNSUPPORTED");

  const artifact = await request("/api/intake/artifacts", {
    userId: "intake-admin", role: "admin", method: "POST",
    body: { sourceType: "manual_upload", originalFilename: "../../manual.csv", mimeType: "text/csv", contentBase64 },
  });
  check(artifact.status, 201, "manual artifact registration succeeds");
  check(artifact.payload.originalFilename, "manual.csv");
  check("storageKey" in artifact.payload, false, "storage key is not projected");
  check("storageProvider" in artifact.payload, false, "storage provider is not projected");

  const duplicate = await request("/api/intake/artifacts", {
    userId: "intake-admin", role: "admin", method: "POST",
    body: { originalFilename: "duplicate.csv", mimeType: "text/csv", contentBase64 },
  });
  check(duplicate.status, 409, "duplicate checksum is rejected");
  check(duplicate.payload.code, "INTAKE_ARTIFACT_DUPLICATE");

  const batch = await request("/api/intake/batches", {
    userId: "intake-admin", role: "admin", method: "POST",
    body: { artifactId: artifact.payload.id, batchType: "supplier" },
  });
  check(batch.status, 201, "batch creation succeeds");
  check(batch.payload.status, "uploaded");
  const profiled = await request("/api/intake/artifacts/profile", {
    userId: "intake-admin", role: "admin", method: "POST",
    body: { batchId: batch.payload.id, sourceFormat: "csv" },
  });
  check(profiled.status, 200, "artifact profiling creates parser-owned records");
  check(profiled.payload.profile.rowCount, 1);

  const retiredRecordInsert = await request(`/api/intake/batches/${batch.payload.id}/records`, {
    userId: "intake-admin", role: "admin", method: "POST",
    body: { records: [{ password: "not-allowed" }] },
  });
  check(retiredRecordInsert.status, 501, "public direct record insertion fails closed");
  check(retiredRecordInsert.payload.code, "FLOWCHAIN_INTAKE_DIRECT_RECORD_INSERT_RETIRED");

  const mapping = await request(`/api/intake/batches/${batch.payload.id}/mapping`, {
    userId: "intake-admin", role: "admin", method: "POST",
    body: { mappings: [
      { sourceField: "code", targetFieldPath: "supplier.code", transformType: "trim" },
      { sourceField: "name", targetFieldPath: "supplier.name", transformType: "trim" },
    ] },
  });
  check(mapping.status, 200, "schema-aware mapping is confirmed");
  const normalized = await request(`/api/intake/batches/${batch.payload.id}/normalize`, {
    userId: "intake-admin", role: "admin", method: "POST", body: {},
  });
  check(normalized.status, 200, "normalization is parser-owned");
  const validated = await request(`/api/intake/batches/${batch.payload.id}/validate`, {
    userId: "intake-admin", role: "admin", method: "POST", body: {},
  });
  check(validated.status, 200, "structured preview validates");
  check(validated.payload.counts.valid, 1);

  const commit = await request(`/api/intake/batches/${batch.payload.id}/commit`, {
    userId: "intake-admin", role: "admin", method: "POST",
    headers: { "idempotency-key": "api-commit-key" },
    body: {},
  });
  check(commit.status, 501, "commit endpoint fails closed");
  check(commit.payload.code, "FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED");
  check(commit.payload.status, "blocked");

  await stopApi();
  child = await startApi();
  const durable = await request(`/api/intake/batches/${batch.payload.id}`, { userId: "intake-admin", role: "admin" });
  check(durable.status, 200, "batch survives API restart");
  check(durable.payload.recordCount, 1);

  prisma = await createPrismaClient(env);
  check(await prisma.commitAttempt.count({ where: { tenantId, status: "blocked" } }), 1, "blocked commit attempt is durable");
  check(await prisma.supplier.count(), 0, "no Supplier rows are created");
  check(await prisma.item.count(), 0, "no Item rows are created");
  check(await prisma.purchaseOrder.count(), 0, "no PurchaseOrder rows are created");
  check(await prisma.inventoryMovement.count(), 0, "no InventoryMovement rows are created");
  console.log(`Universal Intake API gate: ${assertions} passed, 0 failed, 0 skipped`);
} finally {
  await stopApi();
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  await rm(storage, { recursive: true, force: true }).catch(() => {});
}
