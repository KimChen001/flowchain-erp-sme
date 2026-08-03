import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const execFileAsync = promisify(execFile),
  root = resolve(import.meta.dirname, ".."),
  node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js"),
  tenantId = "tenant-outbound-browser",
  email = "kim@example.com";
const actorId = `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
  apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createNetServer().on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
const pgPort = await freePort(),
  password = `local-${randomUUID()}`,
  directory = await mkdtemp(join(tmpdir(), "flowchain-outbound-browser-")),
  database = "flowchain_outbound_browser_test";
const url = `postgresql://flowchain_browser:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "flowchain_browser",
  password,
  port: pgPort,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});
let prisma, server;
async function cleanup() {
  await new Promise(
    (resolveClose) => server?.close(resolveClose) || resolveClose(),
  );
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  Object.assign(process.env, {
    DATABASE_URL: url,
    DATABASE_URL_TEST: url,
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true",
    FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING:
      process.env.PLAYWRIGHT_OUTBOUND_CAPABILITY_DISABLED === "true"
        ? "false"
        : "true",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `browser-${randomUUID()}`,
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
    FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
    FLOWCHAIN_COMMIT_SHA: "outbound-browser-smoke",
    FLOWCHAIN_BRANCH: "test/outbound-browser-smoke",
    FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "false",
    SCM_API_PORT: String(apiPort),
    NODE_ENV: "production",
  });
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], {
    cwd: root,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  prisma = await createPrismaClient(process.env);
  await prisma.tenant.create({
    data: { id: tenantId, name: "Outbound Browser Tenant" },
  });
  await prisma.user.create({
    data: {
      id: actorId,
      tenantId,
      email,
      name: "Kim",
      role: "manager",
      jobTitle: "供应链经理",
    },
  });
  await prisma.user.createMany({
    data: [
      {
        id: "outbound-browser-viewer",
        tenantId,
        email: "viewer@example.com",
        name: "Viewer",
        role: "viewer",
      },
      {
        id: "outbound-browser-read-manager",
        tenantId,
        email: "readonly@example.com",
        name: "Read Manager",
        role: "manager",
      },
    ],
  });
  await prisma.warehouse.create({
    data: {
      id: "outbound-browser-warehouse",
      tenantId,
      code: "OUT-BROWSER",
      name: "华东成品仓",
      status: "active",
    },
  });
  await prisma.userWarehouseScope.create({
    data: {
      id: randomUUID(),
      tenantId,
      userId: actorId,
      warehouseId: "outbound-browser-warehouse",
      accessLevel: "operate",
    },
  });
  await prisma.userWarehouseScope.create({
    data: {
      id: randomUUID(),
      tenantId,
      userId: "outbound-browser-viewer",
      warehouseId: "outbound-browser-warehouse",
      accessLevel: "read",
    },
  });
  await prisma.item.create({
    data: {
      id: "outbound-browser-item",
      tenantId,
      sku: "OUT-BROWSER-SKU",
      name: "浏览器出库物料",
      unit: "EA",
    },
  });
  await prisma.inventoryBalance.create({
    data: {
      id: "outbound-browser-balance",
      tenantId,
      itemId: "outbound-browser-item",
      sku: "OUT-BROWSER-SKU",
      itemName: "浏览器出库物料",
      warehouseId: "outbound-browser-warehouse",
      warehouseKey: "outbound-browser-warehouse",
      location: "A-01",
      locationKey: "a-01",
      onHandQuantity: "10",
      reservedQuantity: "0",
      availableQuantity: "10",
      unit: "EA",
      status: "available",
    },
  });
  await prisma.inventoryMovement.create({
    data: {
      id: "outbound-browser-opening",
      tenantId,
      itemId: "outbound-browser-item",
      sku: "OUT-BROWSER-SKU",
      itemName: "浏览器出库物料",
      warehouseId: "outbound-browser-warehouse",
      location: "A-01",
      locationKey: "a-01",
      movementType: "opening_balance",
      sourceDocument: "Browser Seed",
      sourceDocumentType: "TestSeed",
      sourceDocumentId: "outbound-browser-balance",
      sourceDocumentLineId: "outbound-browser-balance",
      quantityIn: "10",
      quantityOut: "0",
      adjustmentQty: "0",
      status: "posted",
      unit: "EA",
    },
  });
  await prisma.salesOrder.create({
    data: {
      id: "outbound-browser-permission-order",
      tenantId,
      orderNumber: "SO-PERMISSION",
      customerName: "Permission Customer",
      workflowStatus: "confirmed",
      currency: "CNY",
      lines: {
        create: {
          id: "outbound-browser-permission-line",
          itemId: "outbound-browser-item",
          sku: "OUT-BROWSER-SKU",
          itemName: "浏览器出库物料",
          orderedQuantity: "2",
          unit: "EA",
        },
      },
    },
  });
  const { createScmServer } = await import("../server/scm-api.mjs");
  server = createScmServer();
  server.listen(apiPort, "127.0.0.1", () =>
    console.log(`Outbound browser API ready on ${apiPort}`),
  );
} catch (error) {
  console.error(
    String(error?.stack || error).replace(
      /postgres(?:ql)?:\/\/[^\s]+/gi,
      "[REDACTED_DATABASE_URL]",
    ),
  );
  await cleanup();
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await cleanup();
    process.exit(0);
  });
