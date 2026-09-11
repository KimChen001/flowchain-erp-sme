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
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
});
const pgPort = await freePort();
const apiPort = await freePort();
const password = `rfq-award-api-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-rfq-award-api-"));
const tenantId = "tenant-rfq-award-api";
const otherTenantId = "tenant-rfq-award-api-other";
const database = "flowchain_rfq_award_api";
const url = `postgresql://flowchain_rfq_award_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: "true",
  FLOWCHAIN_LOCAL_SESSION_SECRET: "rfq-award-api-session-secret-at-least-32-characters", NODE_ENV: "test", SCM_API_PORT: String(apiPort) };
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_rfq_award_api", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
let prisma;
let child;
let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions += 1; };

async function startApi() {
  const server = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")));
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok) return server; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("RFQ Award API did not become ready.");
}

async function stopApi() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function request(path, { userId, role, method = "GET", body, rawBody, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { "content-type": "application/json",
    ...(userId ? { "x-flowchain-user": userId, "x-flowchain-role": role } : {}), ...headers },
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, payload: await response.json() };
}

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database);
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: "Award API" }, { id: otherTenantId, name: "Award API Other" }] });
  await prisma.user.createMany({ data: [
    { id: "rfq-award-api-admin", tenantId, email: "admin@award-api.invalid", name: "Admin", role: "admin", status: "active" },
    { id: "rfq-award-api-manager", tenantId, email: "manager@award-api.invalid", name: "Manager", role: "manager", status: "active" },
    { id: "rfq-award-api-buyer", tenantId, email: "buyer@award-api.invalid", name: "Buyer", role: "buyer", status: "active" },
    { id: "rfq-award-api-operations", tenantId, email: "operations@award-api.invalid", name: "Operations", role: "business-specialist", status: "active" },
    { id: "rfq-award-api-finance", tenantId, email: "finance@award-api.invalid", name: "Finance", role: "finance-specialist", status: "active" },
    { id: "rfq-award-api-viewer", tenantId, email: "viewer@award-api.invalid", name: "Viewer", role: "viewer", status: "active" },
  ] });
  await backfillTenantAuthorization(prisma, tenantId, { actorId: "rfq-award-api-admin", requestId: "award-api-auth" });
  await prisma.supplier.create({ data: { id: "rfq-award-api-supplier", tenantId, code: "AWARD", name: "Award Supplier" } });
  await prisma.rfq.create({ data: { id: "rfq-award-api-main", tenantId, title: "Award API RFQ", status: "collecting_quotes", currency: "CNY",
    lines: { create: [{ id: "rfq-award-api-line", sku: "AWARD", quantity: "2.0000", unit: "EA" }] } } });
  await prisma.supplierQuotation.create({ data: { id: "rfq-award-api-quotation", tenantId, rfqId: "rfq-award-api-main", supplierId: "rfq-award-api-supplier", status: "submitted", currency: "CNY", quotedAmount: "5900.0000" } });
  await prisma.supplierQuotationRevision.create({ data: { id: "rfq-award-api-revision", tenantId, quotationId: "rfq-award-api-quotation", revisionNumber: 1,
    status: "submitted", currency: "CNY", quotedAmount: "5900.0000", source: "test",
    lines: { create: { id: "rfq-award-api-revision-line", rfqLineId: "rfq-award-api-line", quantity: "2.0000", unitPrice: "2950.0000", amount: "5900.0000" } } } });
  await prisma.rfq.create({ data: { id: "rfq-award-api-empty", tenantId, title: "No Award", status: "collecting_quotes" } });
  await prisma.rfq.create({ data: { id: "rfq-award-api-other", tenantId: otherTenantId, title: "Other", status: "collecting_quotes" } });
  await prisma.$disconnect(); prisma = null; child = await startApi();

  const createPath = "/api/procurement/rfqs/rfq-award-api-main/award-decisions";
  const readPath = "/api/procurement/rfqs/rfq-award-api-main/award-decision";
  const body = { supplierId: "rfq-award-api-supplier", quotationId: "rfq-award-api-quotation", quotationRevisionId: "rfq-award-api-revision",
    expectedQuotationRevisionNumber: 1, decisionReason: "Commercial terms and delivery commitment reviewed." };
  check((await request(createPath, { method: "POST", body })).status, 401, "POST requires authentication");
  const managerAuthorized = await request(createPath, { userId: "rfq-award-api-manager", role: "manager", method: "POST", body: { ...body, decisionReason: "" }, headers: { "idempotency-key": "manager-authorized" } });
  check(managerAuthorized.status, 422, "Operations Manager crosses the permission boundary before payload validation");
  check(managerAuthorized.payload.code, "RFQ_AWARD_REASON_REQUIRED", "Operations Manager has Award create permission");
  for (const [userId, role] of [
    ["rfq-award-api-buyer", "buyer"],
    ["rfq-award-api-operations", "business-specialist"],
    ["rfq-award-api-finance", "finance-specialist"],
    ["rfq-award-api-viewer", "viewer"],
  ]) {
    const denied = await request(createPath, { userId, role, method: "POST", body, headers: { "idempotency-key": `denied-${role}` } });
    check(denied.status, 403, `${role} cannot create an Award`);
    check(denied.payload.code, "AUTHORIZATION_PERMISSION_DENIED", `${role} denial is stable`);
  }
  const forbidden = await request(createPath, { userId: "rfq-award-api-admin", role: "admin", method: "POST", body: { ...body, quotedAmount: "1.0000" }, headers: { "idempotency-key": "forbidden" } });
  check(forbidden.status, 422, "client amount is rejected");
  const created = await request(createPath, { userId: "rfq-award-api-admin", role: "admin", method: "POST", body, headers: { "idempotency-key": "award-api-create" } });
  check(created.status, 201, "Award command succeeds");
  check(created.payload.quotedAmount, "5900.0000", "amount is exact server-derived Decimal");
  check(created.payload.currency, "CNY", "currency is server-derived");
  check(created.payload.idempotentReplay, false, "first command is not replay");
  const replay = await request(createPath, { userId: "rfq-award-api-admin", role: "admin", method: "POST", body, headers: { "idempotency-key": "award-api-create" } });
  check(replay.status, 201, "same command replays");
  check(replay.payload.idempotentReplay, true, "replay is explicit");
  check(replay.payload.entityId, created.payload.entityId, "replay returns original Award");
  const read = await request(readPath, { userId: "rfq-award-api-admin", role: "admin" });
  check(read.status, 200, "Award exact read succeeds");
  check(read.payload.awardDecision.quotationRevisionId, "rfq-award-api-revision", "read returns exact Revision");
  check(read.payload.awardDecision.quotedAmount, "5900.0000", "read preserves Decimal string");
  const absent = await request("/api/procurement/rfqs/rfq-award-api-empty/award-decision", { userId: "rfq-award-api-admin", role: "admin" });
  check(absent.status, 200, "absent Award read succeeds");
  check(absent.payload.awardDecision, null, "absent Award is explicit null");
  check((await request("/api/procurement/rfqs/rfq-award-api-other/award-decision", { userId: "rfq-award-api-admin", role: "admin" })).status, 404, "read masks cross-tenant RFQ");
  check((await request(readPath)).status, 401, "GET requires authentication");
  check((await request(readPath, { userId: "rfq-award-api-viewer", role: "viewer" })).status, 403, "GET requires price permission");

  prisma = await createPrismaClient(env);
  check(await prisma.rfqAwardDecision.count({ where: { tenantId } }), 1, "one Award row persists");
  check(await prisma.auditLog.count({ where: { tenantId, source: "rfq_award_decision_service" } }), 1, "one AuditLog persists");
  check(await prisma.domainChangeFeed.count({ where: { tenantId, source: "rfq_award_decision_service" } }), 1, "one ChangeFeed fact persists");
  console.log(`RFQ Award Decision HTTP API gate: ${assertions} passed, 0 failed, 0 skipped`);
} finally {
  await stopApi(); await prisma?.$disconnect().catch(() => {}); await pg.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {});
}
