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

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-postgres-only-contract";
const email = "postgres-only-contract@flowchain.invalid";
const userId = `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
const disabledRoutes = [
  ["GET", "/api/mrp-plan"],
  ["GET", "/api/sop-cycle"],
  ["POST", "/api/sop-cycle"],
  ["GET", "/api/supplier-performance"],
  ["GET", "/api/supplier-recommendations"],
  ["GET", "/api/forecast-plans"],
  ["POST", "/api/forecast-plans"],
  ["GET", "/api/external-signals"],
  ["GET", "/api/market-prices"],
  ["POST", "/api/market-prices/refresh"],
];

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer().on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(url) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("PostgreSQL-only API did not become ready.");
}

function startApi(env) {
  const child = spawn(node, ["server/index.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    const safe = String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]");
    process.stderr.write(safe);
  });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function request(base, pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

function assertNoBusinessFixtures(value, label) {
  const serialized = JSON.stringify(value);
  for (const pattern of [
    /RFQ-26-0042/,
    /PO-2026-1287/,
    /SKU-00412/,
    /深圳新元电气/,
    /江苏铝合金集团/,
    /supplierCapacityCalendar/,
    /exchangeRatesToCny/,
  ]) {
    assert.doesNotMatch(serialized, pattern, label);
  }
}

const pgPort = await freePort();
const apiPort = await freePort();
const password = `postgres-only-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-postgres-only-api-"));
const database = "flowchain_postgres_only_contract";
const url = `postgresql://flowchain_contract:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "flowchain_contract",
  password,
  port: pgPort,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});
let prisma;
let api;

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  const env = {
    ...process.env,
    DATABASE_URL: url,
    DATABASE_URL_TEST: url,
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `postgres-only-${randomUUID()}-secure-secret`,
    FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
    FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT: "true",
    SCM_API_PORT: String(apiPort),
    NODE_ENV: "production",
  };
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], {
    cwd: root,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  prisma = await createPrismaClient(env);
  await prisma.tenant.create({ data: { id: tenantId, name: "PostgreSQL-only Contract" } });
  await prisma.user.create({
    data: { id: userId, tenantId, email, name: "Contract Admin", role: "admin", status: "active" },
  });

  api = startApi(env);
  const base = `http://127.0.0.1:${apiPort}`;
  await waitFor(`${base}/api/health`);
  const login = await request(base, "/api/auth/login", {
    method: "POST",
    body: { email, name: "Ignored", company: "Ignored" },
  });
  assert.equal(login.status, 200);
  const token = login.payload.token;

  const reads = [
    ["/api/rfqs", (payload) => assert.deepEqual(payload, [])],
    ["/api/procurement/documents?type=po", (payload) => assert.deepEqual(payload.documents, [])],
    ["/api/master-data/suppliers", (payload) => assert.deepEqual(payload.suppliers, [])],
    ["/api/inventory-movements", (payload) => assert.deepEqual(payload, [])],
    ["/api/finance/supplier-invoices", (payload) => {
      assert.deepEqual(payload.items, []);
      assert.equal(payload.total, 0);
    }],
    ["/api/finance/payables", (payload) => {
      assert.deepEqual(payload.items, []);
      assert.equal(payload.total, 0);
    }],
  ];
  for (const [pathname, validate] of reads) {
    const result = await request(base, pathname, { token });
    assert.equal(result.status, 200, pathname);
    validate(result.payload);
    assertNoBusinessFixtures(result.payload, pathname);
  }

  for (const [method, pathname] of disabledRoutes) {
    const result = await request(base, pathname, {
      token,
      method,
      ...(method === "POST" ? { body: {} } : {}),
    });
    assert.equal(result.status, 501, `${method} ${pathname}`);
    assert.equal(result.payload.code, "FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED");
    assert.equal(typeof result.payload.capability, "string");
    assert.equal(typeof result.payload.message, "string");
    assert.ok(Array.isArray(result.payload.limitations));
    assert.ok(result.payload.limitations.length > 0);
    assertNoBusinessFixtures(result.payload, pathname);
  }

  console.log("PostgreSQL-only fresh database API gate: 16 passed, 0 failed, 0 skipped");
} finally {
  await stop(api);
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
