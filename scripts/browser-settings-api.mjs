import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-settings-browser";
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
const actorId = email => `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createNetServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});
const pgPort = await freePort();
const password = `settings-browser-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-settings-browser-"));
const artifactDirectory = await mkdtemp(join(tmpdir(), "flowchain-intake-browser-artifacts-"));
const database = "flowchain_settings_browser";
const url = `postgresql://flowchain_settings_browser:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_settings_browser", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
let prisma;
let server;

async function cleanup() {
  await new Promise(resolveClose => server?.close(resolveClose) || resolveClose());
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  await rm(artifactDirectory, { recursive: true, force: true }).catch(() => {});
}

async function seed() {
  await prisma.tenant.create({ data: { id: tenantId, name: "FlowChain Operations", legalName: "FlowChain Manufacturing", defaultLanguage: "zh-CN", locale: "zh-CN", timezone: "Asia/Shanghai", currency: "CNY" } });
  await prisma.warehouse.create({ data: { id: "settings-browser-warehouse", tenantId, code: "MAIN", name: "Main Warehouse", status: "active" } });
  await prisma.user.createMany({ data: [
    { id: actorId("admin@example.com"), tenantId, email: "admin@example.com", name: "Settings Admin", role: "admin", status: "active", jobTitle: "Operations Administrator", profileCompletedAt: new Date() },
    { id: actorId("manager@example.com"), tenantId, email: "manager@example.com", name: "Operations Manager", role: "manager", status: "active" },
    { id: actorId("viewer@example.com"), tenantId, email: "viewer@example.com", name: "Read-only Viewer", role: "viewer", status: "active" },
  ] });
  await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId, userId: actorId("manager@example.com"), warehouseId: "settings-browser-warehouse", accessLevel: "operate" } });
}

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  Object.assign(process.env, {
    DATABASE_URL: url,
    DATABASE_URL_TEST: url,
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `settings-browser-${randomUUID()}-secure-secret`,
    SCM_API_PORT: String(apiPort),
    NODE_ENV: "test",
    FLOWCHAIN_INTAKE_LOCAL_STORAGE_DIR: artifactDirectory,
  });
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 });
  prisma = await createPrismaClient(process.env);
  await seed();
  const { createScmServer } = await import("../server/scm-api.mjs");
  server = createScmServer();
  server.listen(apiPort, "127.0.0.1", () => console.log(`Settings browser API ready on ${apiPort}`));
} catch (error) {
  console.error(String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]"));
  await cleanup();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  await cleanup();
  process.exit(0);
});
