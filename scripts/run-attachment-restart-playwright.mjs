import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const playwrightCli = join(root, "node_modules", "playwright", "cli.js");
const config = join(root, "playwright.attachment-restart.config.ts");
const freePort = () => new Promise((resolvePort, reject) => { const server = createServer().on("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)); }); });
const pgPort = await freePort(), apiPort = await freePort();
const directory = await mkdtemp(join(tmpdir(), "flowchain-browser-attachment-restart-"));
const storage = join(directory, "uploads"), statePath = join(directory, "state.json");
const password = `attachment-browser-${randomUUID()}`, user = "flowchain_attachment_browser", database = "flowchain_attachment_browser";
const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: "true", FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true", FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local", FLOWCHAIN_UPLOAD_STORAGE_DIR: storage, FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true", FLOWCHAIN_DEFAULT_TENANT_ID: "attachment-browser-tenant", FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false", FLOWCHAIN_LOCAL_SESSION_SECRET: "attachment-browser-session-secret-at-least-32-chars", SCM_API_PORT: String(apiPort), NODE_ENV: "test", ATTACHMENT_RESTART_API_PORT: String(apiPort), ATTACHMENT_RESTART_STATE_PATH: statePath };
const pg = new EmbeddedPostgres({ databaseDir: directory, user, password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
let prisma, api;

async function startApi() {
  const child = spawn(process.execPath, [join(root, "server", "index.mjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; child.stdout.on("data", (chunk) => diagnostics += chunk); child.stderr.on("data", (chunk) => diagnostics += chunk);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Attachment API exited during startup: ${diagnostics}`);
    try { const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`); if (response.ok) return child; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill(); throw new Error(`Attachment API did not become healthy: ${diagnostics}`);
}
async function stopApi(child) { if (!child || child.exitCode != null) return; child.kill(); await new Promise((resolveExit) => { child.once("exit", resolveExit); setTimeout(resolveExit, 5_000); }); }
async function runPhase(phase) {
  const grep = phase === "write" ? "process A" : "process B";
  return new Promise((resolveExit) => { const child = spawn(process.execPath, [playwrightCli, "test", "tests/browser/attachment-process-restart.spec.ts", `--config=${config}`, "--grep", grep], { cwd: root, stdio: "inherit", env }); child.once("exit", (code) => resolveExit(code ?? 1)); });
}

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database);
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 30 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.create({ data: { id: "attachment-browser-tenant", name: "Attachment Browser Restart" } });
  await prisma.user.create({ data: { id: "attachment-browser-admin", tenantId: "attachment-browser-tenant", email: "attachment-browser-admin@example.invalid", name: "Attachment Browser Admin", role: "admin" } });
  await prisma.warehouse.create({ data: { id: "attachment-browser-warehouse", tenantId: "attachment-browser-tenant", code: "ATT-BROWSER", name: "Attachment Browser Warehouse" } });
  await backfillTenantAuthorization(prisma, "attachment-browser-tenant", { actorId: "attachment-browser-admin" });
  await prisma.receivingDocument.create({ data: { id: "attachment-browser-receiving", tenantId: "attachment-browser-tenant", documentNumber: "RCV-ATT-BROWSER", warehouseId: "attachment-browser-warehouse" } });
  await prisma.$disconnect(); prisma = null;
  api = await startApi(); assert.equal(await runPhase("write"), 0); await stopApi(api); api = null;
  api = await startApi(); assert.equal(await runPhase("read"), 0); await stopApi(api); api = null;
  prisma = await createPrismaClient(env);
  const expected = JSON.parse(await readFile(statePath, "utf8"));
  const row = await prisma.receivingAttachment.findUnique({ where: { id: expected.attachmentId }, include: { upload: true } });
  assert.equal(row.fileName, expected.fileName); assert.equal(row.sha256, expected.sha256); assert.equal(row.upload.storageHealthStatus, "healthy");
  assert.equal(await prisma.auditLog.count({ where: { tenantId: "attachment-browser-tenant", entityId: expected.attachmentId, action: "attachment_downloaded" } }), 3);
  console.log("Browser attachment API process restart gate: bytes/hash/metadata/audit passed; 0 failed; 0 skipped");
} finally {
  await stopApi(api).catch(() => {}); await prisma?.$disconnect().catch(() => {}); await pg.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {});
}
