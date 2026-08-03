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

const execFileAsync = promisify(execFile),
  root = resolve(import.meta.dirname, ".."),
  node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js"),
  tenantId = "tenant-inventory-operations-api",
  email = "inventory-operations@flowchain.invalid";
const actorId = `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer().on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
async function waitFor(url) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("API did not become ready");
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
const start = (env) =>
  spawn(node, ["server/index.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
async function raw(base, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}
async function request(base, path, options) {
  const result = await raw(base, path, options);
  if (!result.response.ok)
    throw new Error(
      `${options?.method || "GET"} ${path}: ${result.payload.code || result.response.status} ${result.payload.message || ""}`,
    );
  return result.payload;
}

const pgPort = await freePort(),
  apiPort = await freePort(),
  password = `local-${randomUUID()}`,
  directory = await mkdtemp(
    join(tmpdir(), "flowchain-inventory-operations-api-"),
  ),
  database = "flowchain_inventory_operations_api";
const url = `postgresql://flowchain_inventory_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "flowchain_inventory_api",
  password,
  port: pgPort,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});
const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_TEST: url,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "true",
  FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
  FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
  FLOWCHAIN_LOCAL_SESSION_SECRET: `inventory-api-${randomUUID()}-secure`,
  FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
  FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
  FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
  FLOWCHAIN_COMMIT_SHA: "inventory-operations-api-smoke",
  FLOWCHAIN_BRANCH: "test/inventory-operations-api-smoke",
  FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "false",
  SCM_API_PORT: String(apiPort),
  NODE_ENV: "production",
};
const base = `http://127.0.0.1:${apiPort}`;
let api, prisma;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], {
    cwd: root,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  prisma = await createPrismaClient(env);
  await prisma.tenant.create({
    data: { id: tenantId, name: "Inventory Operations API" },
  });
  await prisma.user.create({
    data: {
      id: actorId,
      tenantId,
      email,
      name: "Inventory Manager",
      role: "manager",
    },
  });
  await prisma.warehouse.createMany({
    data: [
      { id: "warehouse-a", tenantId, code: "WH-A", name: "Warehouse A" },
      { id: "warehouse-b", tenantId, code: "WH-B", name: "Warehouse B" },
    ],
  });
  await prisma.userWarehouseScope.createMany({
    data: ["warehouse-a", "warehouse-b"].map((warehouseId) => ({
      id: randomUUID(),
      tenantId,
      userId: actorId,
      warehouseId,
      accessLevel: "operate",
    })),
  });
  await prisma.item.create({
    data: {
      id: "inventory-item",
      tenantId,
      sku: "INV-OPS-SKU",
      name: "Inventory Operations Item",
      unit: "EA",
    },
  });
  await prisma.inventoryBalance.createMany({
    data: [
      {
        id: "balance-a",
        tenantId,
        itemId: "inventory-item",
        sku: "INV-OPS-SKU",
        itemName: "Inventory Operations Item",
        warehouseId: "warehouse-a",
        warehouseKey: "warehouse-a",
        location: "A-01",
        locationKey: "a-01",
        onHandQuantity: "10",
        reservedQuantity: "2",
        availableQuantity: "8",
        unit: "EA",
      },
      {
        id: "balance-b",
        tenantId,
        itemId: "inventory-item",
        sku: "INV-OPS-SKU",
        itemName: "Inventory Operations Item",
        warehouseId: "warehouse-b",
        warehouseKey: "warehouse-b",
        location: "B-01",
        locationKey: "b-01",
        onHandQuantity: "5",
        reservedQuantity: "0",
        availableQuantity: "5",
        unit: "EA",
      },
    ],
  });
  api = start(env);
  await waitFor(`${base}/api/health`);
  const login = await request(base, "/api/auth/login", {
      method: "POST",
      body: { email, name: "Ignored", company: "Ignored" },
    }),
    token = login.token;
  const entry = await request(base, "/api/inventory/operations/entry-data", {
    token,
  });
  assert.equal(entry.balances.length, 2);

  const transferCreated = await request(base, "/api/inventory/transfers", {
    token,
    method: "POST",
    body: {
      transferNumber: "TR-API-001",
      idempotencyKey: "tr-create",
      tenantId: "forged",
      lines: [
        {
          itemId: "inventory-item",
          quantity: "3",
          source: { warehouseId: "warehouse-a", location: "A-01" },
          destination: { warehouseId: "warehouse-b", location: "B-01" },
        },
      ],
    },
  });
  const transferReady = await request(
    base,
    `/api/inventory/transfers/${transferCreated.transfer.id}/ready`,
    {
      token,
      method: "POST",
      body: { expectedTransferVersion: 0, idempotencyKey: "tr-ready" },
    },
  );
  assert.equal(
    (
      await request(
        base,
        `/api/inventory/transfers/${transferCreated.transfer.id}/post-preview`,
        { token, method: "POST", body: {} },
      )
    ).allowed,
    true,
  );
  const transferPosted = await request(
    base,
    `/api/inventory/transfers/${transferCreated.transfer.id}/post`,
    {
      token,
      method: "POST",
      body: {
        expectedTransferVersion: transferReady.transfer.version,
        idempotencyKey: "tr-post",
      },
    },
  );
  assert.equal(transferPosted.movementIds.length, 2);
  assert.equal(
    (
      await request(
        base,
        `/api/inventory/transfers/${transferCreated.transfer.id}/post`,
        {
          token,
          method: "POST",
          body: {
            expectedTransferVersion: transferReady.transfer.version,
            idempotencyKey: "tr-post",
          },
        },
      )
    ).idempotentReplay,
    true,
  );
  const transferReversed = await request(
    base,
    `/api/inventory/transfers/${transferCreated.transfer.id}/reverse`,
    {
      token,
      method: "POST",
      body: {
        expectedTransferVersion: transferPosted.transfer.version,
        idempotencyKey: "tr-reverse",
        reason: "API correction",
      },
    },
  );
  assert.equal(transferReversed.movementIds.length, 2);

  const countCreated = await request(base, "/api/inventory/counts", {
    token,
    method: "POST",
    body: {
      countNumber: "CC-API-001",
      warehouseId: "warehouse-a",
      blindCount: true,
      balanceIds: ["balance-a"],
      idempotencyKey: "cc-create",
    },
  });
  const countEntered = await request(
    base,
    `/api/inventory/counts/${countCreated.session.id}`,
    {
      token,
      method: "PATCH",
      body: {
        expectedSessionVersion: 0,
        idempotencyKey: "cc-enter",
        counts: [
          {
            countLineId: countCreated.session.lines[0].id,
            countedQuantity: "11",
            expectedLineVersion: 0,
          },
        ],
      },
    },
  );
  const countSubmitted = await request(
    base,
    `/api/inventory/counts/${countCreated.session.id}/submit`,
    {
      token,
      method: "POST",
      body: {
        expectedSessionVersion: countEntered.session.version,
        idempotencyKey: "cc-submit",
      },
    },
  );
  const countReviewed = await request(
    base,
    `/api/inventory/counts/${countCreated.session.id}/review`,
    {
      token,
      method: "POST",
      body: {
        expectedSessionVersion: countSubmitted.session.version,
        idempotencyKey: "cc-review",
      },
    },
  );
  assert.equal(
    (
      await request(
        base,
        `/api/inventory/counts/${countCreated.session.id}/post-preview`,
        { token, method: "POST", body: {} },
      )
    ).allowed,
    true,
  );
  const countPosted = await request(
    base,
    `/api/inventory/counts/${countCreated.session.id}/post`,
    {
      token,
      method: "POST",
      body: {
        expectedSessionVersion: countReviewed.session.version,
        idempotencyKey: "cc-post",
      },
    },
  );
  assert.equal(countPosted.movementIds.length, 1);

  const adjustmentCreated = await request(base, "/api/inventory/adjustments", {
    token,
    method: "POST",
    body: {
      adjustmentNumber: "ADJ-API-001",
      reasonCode: "damage",
      notes: "Damaged",
      idempotencyKey: "adj-create",
      lines: [{ inventoryBalanceId: "balance-b", adjustmentQuantity: "-1" }],
    },
  });
  const adjustmentReady = await request(
    base,
    `/api/inventory/adjustments/${adjustmentCreated.adjustment.id}/ready`,
    {
      token,
      method: "POST",
      body: { expectedAdjustmentVersion: 0, idempotencyKey: "adj-ready" },
    },
  );
  assert.equal(
    (
      await request(
        base,
        `/api/inventory/adjustments/${adjustmentCreated.adjustment.id}/post-preview`,
        { token, method: "POST", body: {} },
      )
    ).allowed,
    true,
  );
  const adjustmentPosted = await request(
    base,
    `/api/inventory/adjustments/${adjustmentCreated.adjustment.id}/post`,
    {
      token,
      method: "POST",
      body: {
        expectedAdjustmentVersion: adjustmentReady.adjustment.version,
        idempotencyKey: "adj-post",
      },
    },
  );
  const adjustmentReversed = await request(
    base,
    `/api/inventory/adjustments/${adjustmentCreated.adjustment.id}/reverse`,
    {
      token,
      method: "POST",
      body: {
        expectedAdjustmentVersion: adjustmentPosted.adjustment.version,
        idempotencyKey: "adj-reverse",
        reason: "API correction",
      },
    },
  );
  assert.equal(adjustmentReversed.movementIds.length, 1);

  await stop(api);
  api = start(env);
  await waitFor(`${base}/api/health`);
  const relogin = await request(base, "/api/auth/login", {
    method: "POST",
    body: { email, name: "Ignored", company: "Ignored" },
  });
  assert.equal(
    (
      await request(
        base,
        `/api/inventory/transfers/${transferCreated.transfer.id}/workbench`,
        { token: relogin.token },
      )
    ).transfer.postingStatus,
    "reversed",
  );
  assert.equal(
    (
      await request(
        base,
        `/api/inventory/counts/${countCreated.session.id}/workbench`,
        { token: relogin.token },
      )
    ).session.workflowStatus,
    "posted",
  );
  assert.equal(
    (
      await request(
        base,
        `/api/inventory/adjustments/${adjustmentCreated.adjustment.id}/workbench`,
        { token: relogin.token },
      )
    ).adjustment.postingStatus,
    "reversed",
  );

  await stop(api);
  api = start({ ...env, FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "false" });
  await waitFor(`${base}/api/health`);
  const disabledLogin = await request(base, "/api/auth/login", {
    method: "POST",
    body: { email, name: "Ignored", company: "Ignored" },
  });
  const disabledRead = await request(
    base,
    `/api/inventory/transfers/${transferCreated.transfer.id}/workbench`,
    { token: disabledLogin.token },
  );
  assert.ok(
    Object.entries(disabledRead.availableActions)
      .filter(([, value]) => typeof value === "boolean")
      .every(([, value]) => value === false),
  );
  const disabledMutation = await raw(base, "/api/inventory/adjustments", {
    token: disabledLogin.token,
    method: "POST",
    body: {
      adjustmentNumber: "DISABLED",
      reasonCode: "damage",
      idempotencyKey: "disabled",
      lines: [{ inventoryBalanceId: "balance-a", adjustmentQuantity: "1" }],
    },
  });
  assert.equal(disabledMutation.response.status, 409);
  assert.equal(
    disabledMutation.payload.code,
    "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
  );
  console.log(
    "Inventory operations API smoke: PASS (real server, PostgreSQL, signed session, restart persistence)",
  );
} finally {
  await stop(api);
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
