import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const execFileAsync = promisify(execFile), root = resolve(import.meta.dirname, ".."), prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-settlement-api";
const freePort = () => new Promise((resolvePort, reject) => { const server = createServer().on("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)); }); });
const waitFor = async (url) => { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 100)); } throw new Error("Internal settlement API server did not become ready."); };
const stop = async (child) => { if (!child || child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); };
async function raw(base, path, { token, method = "GET", body } = {}) { const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.text(); let payload; try { payload = JSON.parse(value); } catch { payload = { message: value }; } return { status: response.status, payload }; }
async function request(base, path, options = {}) { const result = await raw(base, path, options); assert.ok(result.status >= 200 && result.status < 300, `${options.method || "GET"} ${path}: ${result.status} ${JSON.stringify(result.payload)}`); return result.payload; }

const port = await freePort(), apiPort = await freePort(), password = `local-${randomUUID()}`, directory = await mkdtemp(join(tmpdir(), "flowchain-settlement-api-pg-")), database = "flowchain_settlement_api";
const url = `postgresql://flowchain_settlement_api:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_APPROVAL_EMAILS: process.env.FLOWCHAIN_APPROVAL_EMAILS || "off", SCM_API_PORT: String(apiPort), HOST: "127.0.0.1", FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true", FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT: "true", FLOWCHAIN_LOCAL_SESSION_SECRET: "internal-settlement-api-secret-32-characters", FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false", NODE_ENV: "test" };
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_settlement_api", password, port, persistent: false, onLog: () => {}, onError: () => {} });
let prisma, server;
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database);
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.create({ data: { id: tenantId, name: "Settlement API" } });
  await prisma.user.createMany({ data: [
    { id: "settlement-api-admin", tenantId, email: "admin-settlement-api@flowchain.invalid", name: "Settlement API Admin", role: "admin" },
    { id: "settlement-api-finance", tenantId, email: "finance-settlement-api@flowchain.invalid", name: "Settlement API Finance", role: "finance-specialist" },
    { id: "settlement-api-viewer", tenantId, email: "viewer-settlement-api@flowchain.invalid", name: "Settlement API Viewer", role: "viewer" },
  ] });
  await prisma.supplierInvoice.create({ data: { id: "settlement-api-invoice", tenantId, invoiceNumber: "SI-API", supplierId: "supplier-api", supplierName: "API Supplier", totalAmount: "75", amount: "75", currency: "CNY", status: "approved" } });
  await prisma.payableObligation.create({ data: { id: "settlement-api-payable", tenantId, supplierInvoiceId: "settlement-api-invoice", obligationNumber: "AP-API", originalAmount: "75", outstandingAmount: "75", currency: "CNY", dueDate: new Date("2026-08-01"), status: "approved" } });
  server = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); server.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")));
  const base = `http://127.0.0.1:${apiPort}`; await waitFor(`${base}/api/health`);
  const login = async (email) => request(base, "/api/auth/login", { method: "POST", body: { email, name: "Ignored", company: "Ignored" } });
  const [admin, finance, viewer] = await Promise.all([login("admin-settlement-api@flowchain.invalid"), login("finance-settlement-api@flowchain.invalid"), login("viewer-settlement-api@flowchain.invalid")]);
  const account = await request(base, "/api/finance/cashbook/accounts", { token: admin.token, method: "POST", body: { accountCode: "API-CNY", name: "API Cash", accountType: "bank", currency: "CNY", openingBalance: "100", idempotencyKey: "api-account" } });
  const settlementInput = { settlementNumber: "SET-API-001", direction: "disbursement", counterpartyType: "supplier", counterpartyId: "supplier-api", cashbookAccountId: account.entityId, currency: "CNY", amount: "75", settlementDate: "2026-07-20", externalReference: "BANK-UNVERIFIED-API", allocations: [{ obligationType: "payable", obligationId: "settlement-api-payable", amount: "75" }] };
  assert.equal((await request(base, "/api/finance/settlements/preview", { token: finance.token, method: "POST", body: settlementInput })).allowed, true);
  const created = await request(base, "/api/finance/settlements", { token: finance.token, method: "POST", body: { ...settlementInput, tenantId: "forged", idempotencyKey: "api-create-settlement" } });
  const posted = await request(base, `/api/finance/settlements/${created.entityId}/post`, { token: finance.token, method: "POST", body: { expectedVersion: 0, idempotencyKey: "api-post-settlement" } });
  assert.equal(posted.cashbookEntry.balanceAfter, "25.0000");
  assert.equal((await request(base, `/api/finance/settlements/${created.entityId}/reconciliation`, { token: finance.token })).status, "matched");
  const viewerDetail = await request(base, `/api/finance/settlements/${created.entityId}`, { token: viewer.token });
  assert.equal(viewerDetail.amount, null); assert.equal(viewerDetail.externalReference, null); assert.deepEqual(viewerDetail.availableActions, []);
  const denied = await raw(base, `/api/finance/settlements/${created.entityId}/reverse`, { token: viewer.token, method: "POST", body: { expectedVersion: 1, reason: "forbidden", idempotencyKey: "viewer-reverse" } });
  assert.equal(denied.status, 403); assert.equal(denied.payload.code, "AUTHORIZATION_PERMISSION_DENIED");
  const reversed = await request(base, `/api/finance/settlements/${created.entityId}/reverse`, { token: finance.token, method: "POST", body: { expectedVersion: 1, reason: "API correction", idempotencyKey: "api-reverse-settlement" } });
  assert.equal(reversed.cashbookEntry.balanceAfter, "100.0000");
  assert.equal((await request(base, `/api/finance/settlements/${created.entityId}/reconciliation`, { token: finance.token })).status, "matched");
  assert.equal((await request(base, "/api/finance/cashbook/entries", { token: finance.token })).total, 2);
  const unauthenticated = await raw(base, "/api/finance/settlements"); assert.equal(unauthenticated.status, 401);
  console.log("Internal Settlement API gate: PASS (0 failed, 0 skipped)");
} finally {
  await stop(server); await prisma?.$disconnect().catch(() => {}); await pg.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {});
}
