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
const password = `rfq-response-api-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-rfq-response-api-"));
const database = "flowchain_rfq_response_api";
const tenantId = "tenant-rfq-response-api";
const url = `postgresql://flowchain_rfq_response_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_TEST: url,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
  FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: "true",
  FLOWCHAIN_LOCAL_SESSION_SECRET: "rfq-response-api-session-secret-at-least-32-characters",
  NODE_ENV: "test",
  SCM_API_PORT: String(apiPort),
};
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_rfq_response_api", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
let prisma;
let child;
let assertions = 0;

const check = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
};

async function startApi() {
  const processChild = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  processChild.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")));
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok) return processChild;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("RFQ Supplier Response API did not become ready.");
}

async function stopApi() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child = null;
}

async function request(path, { userId, role, method = "GET", body, rawBody, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-flowchain-user": userId, "x-flowchain-role": role } : {}),
      ...headers,
    },
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json() };
}

const responseBody = (supplierId, lines) => ({
  expectedVersion: 0,
  supplierId,
  submissionMode: "submitted",
  currency: "CNY",
  paymentTerms: "NET30",
  lines,
});
const linesA = [
  { rfqLineId: "rfq-response-api-line-1", quantity: "2.5000", unitPrice: "1.2345" },
  { rfqLineId: "rfq-response-api-line-2", quantity: "1.0000", unitPrice: "2.0000" },
];
const linesB = [
  { rfqLineId: "rfq-response-api-line-1", quantity: "2.5000", unitPrice: "1.3000" },
  { rfqLineId: "rfq-response-api-line-2", quantity: "1.0000", unitPrice: "1.9000" },
];

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.createMany({ data: [
    { id: tenantId, name: "RFQ Response API" },
    { id: "tenant-rfq-response-api-other", name: "RFQ Response API Other" },
  ] });
  await prisma.user.createMany({ data: [
    { id: "rfq-response-api-admin", tenantId, email: "admin@rfq-response-api.invalid", name: "RFQ API Admin", role: "admin", status: "active" },
    { id: "rfq-response-api-viewer", tenantId, email: "viewer@rfq-response-api.invalid", name: "RFQ API Viewer", role: "viewer", status: "active" },
  ] });
  await backfillTenantAuthorization(prisma, tenantId, { actorId: "rfq-response-api-admin", requestId: "rfq-response-api-gate" });
  await prisma.supplier.createMany({ data: [
    { id: "rfq-response-api-supplier-a", tenantId, code: "RFQ-API-A", name: "RFQ API Supplier A" },
    { id: "rfq-response-api-supplier-b", tenantId, code: "RFQ-API-B", name: "RFQ API Supplier B" },
  ] });
  await prisma.rfq.create({
    data: {
      id: "rfq-response-api-main",
      tenantId,
      title: "RFQ Response API Main",
      status: "collecting_quotes",
      currency: "CNY",
      lines: { create: [
        { id: "rfq-response-api-line-1", sku: "API-1", itemName: "API Item 1", quantity: "2.5000", unit: "EA" },
        { id: "rfq-response-api-line-2", sku: "API-2", itemName: "API Item 2", quantity: "1.0000", unit: "EA" },
      ] },
    },
  });
  await prisma.rfq.create({ data: { id: "rfq-response-api-other", tenantId: "tenant-rfq-response-api-other", title: "Other Tenant RFQ", status: "open" } });
  await prisma.$disconnect();
  prisma = null;
  child = await startApi();

  const initialPath = "/api/procurement/rfqs/rfq-response-api-main/supplier-responses";
  const comparisonPath = "/api/procurement/rfqs/rfq-response-api-main/comparison";
  const unauthenticated = await request(initialPath, { method: "POST", body: responseBody("rfq-response-api-supplier-a", linesA) });
  check(unauthenticated.status, 401, "initial response requires authentication");

  const denied = await request(initialPath, {
    userId: "rfq-response-api-viewer", role: "viewer", method: "POST",
    headers: { "idempotency-key": "viewer-denied" },
    body: responseBody("rfq-response-api-supplier-a", linesA),
  });
  check(denied.status, 403, "viewer cannot create response");
  check(denied.payload.code, "AUTHORIZATION_PERMISSION_DENIED", "create requires exact permission");

  const malformed = await request(initialPath, {
    userId: "rfq-response-api-admin", role: "admin", method: "POST",
    headers: { "idempotency-key": "malformed" }, rawBody: "{",
  });
  check(malformed.status, 422, "malformed JSON is rejected");
  check(malformed.payload.code, "RFQ_RESPONSE_PAYLOAD_INVALID", "malformed JSON has stable error");

  const initialA = await request(initialPath, {
    userId: "rfq-response-api-admin", role: "admin", method: "POST",
    headers: { "idempotency-key": "initial-a" },
    body: responseBody("rfq-response-api-supplier-a", linesA),
  });
  check(initialA.status, 201, "initial Supplier A response succeeds");
  check(initialA.payload.entityVersion, 1, "initial response creates Revision 1");
  check(initialA.payload.quotedAmount, "5.0863", "server calculates exact rounded amount");

  const replayA = await request(initialPath, {
    userId: "rfq-response-api-admin", role: "admin", method: "POST",
    headers: { "idempotency-key": "initial-a" },
    body: responseBody("rfq-response-api-supplier-a", [...linesA].reverse()),
  });
  check(replayA.status, 201, "canonical line ordering replays");
  check(replayA.payload.idempotentReplay, true, "replay is explicit");
  check(replayA.payload.revisionId, initialA.payload.revisionId, "replay returns original revision");

  const mismatchA = await request(initialPath, {
    userId: "rfq-response-api-admin", role: "admin", method: "POST",
    headers: { "idempotency-key": "initial-a" },
    body: { ...responseBody("rfq-response-api-supplier-a", linesA), paymentTerms: "NET45" },
  });
  check(mismatchA.status, 409, "idempotency payload mismatch conflicts");
  check(mismatchA.payload.code, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "mismatch has stable error");

  const appendA = await request("/api/procurement/rfqs/rfq-response-api-main/supplier-responses/rfq-response-api-supplier-a/revisions", {
    userId: "rfq-response-api-admin", role: "admin", method: "POST",
    headers: { "idempotency-key": "append-a-2" },
    body: {
      expectedVersion: 1,
      submissionMode: "draft",
      currency: "CNY",
      lines: [{ rfqLineId: "rfq-response-api-line-1", quantity: "2.5000", unitPrice: "1.1000" }],
    },
  });
  check(appendA.status, 201, "Supplier A append succeeds");
  check(appendA.payload.entityVersion, 2, "append creates Revision 2");
  check(appendA.payload.status, "incomplete", "partial draft remains incomplete");

  const initialB = await request(initialPath, {
    userId: "rfq-response-api-admin", role: "admin", method: "POST",
    headers: { "idempotency-key": "initial-b" },
    body: responseBody("rfq-response-api-supplier-b", linesB),
  });
  check(initialB.status, 201, "initial Supplier B response succeeds");

  const comparison = await request(comparisonPath, { userId: "rfq-response-api-admin", role: "admin" });
  check(comparison.status, 200, "comparison loads through full route dispatcher");
  check(comparison.payload.comparisonAvailability, "side_by_side_available", "two same-currency responses are side-by-side available");
  check(comparison.payload.responses.length, 2, "comparison returns both suppliers");
  check(comparison.payload.responses[0].latestRevision.revisionNumber, 2, "comparison selects maximum revision number");
  check(comparison.payload.responses[0].coverage.state, "partial", "comparison exposes latest coverage gap");
  check(comparison.payload.rankingAuthority, "unavailable", "comparison does not rank");
  check(comparison.payload.awardAuthority, "unavailable", "comparison does not award");

  const comparisonDenied = await request(comparisonPath, { userId: "rfq-response-api-viewer", role: "viewer" });
  check(comparisonDenied.status, 403, "comparison requires procurement price permission");
  const comparisonUnauthenticated = await request(comparisonPath);
  check(comparisonUnauthenticated.status, 401, "comparison requires authentication");
  const comparisonCrossTenant = await request("/api/procurement/rfqs/rfq-response-api-other/comparison", { userId: "rfq-response-api-admin", role: "admin" });
  check(comparisonCrossTenant.status, 404, "comparison masks cross-tenant RFQ existence");

  const detail = await request("/api/procurement/documents/rfq/rfq-response-api-main", { userId: "rfq-response-api-admin", role: "admin" });
  check(detail.status, 200, "canonical RFQ detail reads after writes");
  const quotationA = detail.payload.document.quotations.find((quotation) => quotation.supplierId === "rfq-response-api-supplier-a");
  check(quotationA.latestRevision.revisionNumber, 2, "canonical detail selects Revision 2");
  check(quotationA.historicalRevisions[0].revisionNumber, 1, "canonical detail retains Revision 1 history");

  prisma = await createPrismaClient(env);
  check(await prisma.supplierQuotation.count({ where: { tenantId, rfqId: "rfq-response-api-main" } }), 2, "two quotation aggregates persist");
  check(await prisma.supplierQuotationRevision.count({ where: { tenantId } }), 3, "three immutable revisions persist");
  check(await prisma.businessCommandExecution.count({ where: { tenantId, status: "completed" } }), 3, "only committed commands persist");
  check(await prisma.auditLog.count({ where: { tenantId, source: "rfq_supplier_response_command_service" } }), 3, "every command has one audit fact");
  check(await prisma.domainChangeFeed.count({ where: { tenantId, source: "rfq_supplier_response_command_service" } }), 3, "every command has one change-feed fact");
  console.log(`RFQ Supplier Response HTTP API gate: ${assertions} passed, 0 failed, 0 skipped`);
} finally {
  await stopApi();
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
