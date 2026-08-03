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
  tenantId = "tenant-inventory-browser",
  apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
const actorId = (email) =>
  `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
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
  directory = await mkdtemp(join(tmpdir(), "flowchain-inventory-browser-")),
  database = "flowchain_inventory_browser";
const url = `postgresql://flowchain_inventory_browser:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "flowchain_inventory_browser",
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
    FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "true",
    FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS:
      process.env.PLAYWRIGHT_INVENTORY_OPERATIONS_DISABLED === "true"
        ? "false"
        : "true",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `inventory-browser-${randomUUID()}-secure`,
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
    FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
    FLOWCHAIN_COMMIT_SHA: "inventory-operations-browser-smoke",
    FLOWCHAIN_BRANCH: "test/inventory-operations-browser-smoke",
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
    data: { id: tenantId, name: "Inventory Browser Tenant" },
  });
  const users = [
    { email: "kim@example.com", name: "Kim", role: "manager" },
    {
      email: "specialist@example.com",
      name: "Specialist",
      role: "business-specialist",
    },
    { email: "viewer@example.com", name: "Viewer", role: "viewer" },
    { email: "readonly@example.com", name: "Read Manager", role: "manager" },
  ];
  await prisma.user.createMany({
    data: users.map((row) => ({ id: actorId(row.email), tenantId, ...row })),
  });
  await prisma.warehouse.createMany({
    data: [
      { id: "inventory-browser-a", tenantId, code: "WH-A", name: "华东仓" },
      { id: "inventory-browser-b", tenantId, code: "WH-B", name: "华南仓" },
    ],
  });
  await prisma.userWarehouseScope.createMany({
    data: [
      ...["kim@example.com", "specialist@example.com"].flatMap((email) =>
        ["inventory-browser-a", "inventory-browser-b"].map((warehouseId) => ({
          id: randomUUID(),
          tenantId,
          userId: actorId(email),
          warehouseId,
          accessLevel: "operate",
        })),
      ),
      {
        id: randomUUID(),
        tenantId,
        userId: actorId("viewer@example.com"),
        warehouseId: "inventory-browser-a",
        accessLevel: "read",
      },
    ],
  });
  await prisma.item.create({
    data: {
      id: "inventory-browser-item",
      tenantId,
      sku: "INV-BROWSER-SKU",
      name: "浏览器库存物料",
      unit: "EA",
    },
  });
  await prisma.inventoryBalance.createMany({
    data: [
      {
        id: "inventory-browser-balance-a",
        tenantId,
        itemId: "inventory-browser-item",
        sku: "INV-BROWSER-SKU",
        itemName: "浏览器库存物料",
        warehouseId: "inventory-browser-a",
        warehouseKey: "inventory-browser-a",
        location: "A-01",
        locationKey: "a-01",
        onHandQuantity: "10",
        reservedQuantity: "2",
        availableQuantity: "8",
        unit: "EA",
        status: "available",
      },
      {
        id: "inventory-browser-balance-b",
        tenantId,
        itemId: "inventory-browser-item",
        sku: "INV-BROWSER-SKU",
        itemName: "浏览器库存物料",
        warehouseId: "inventory-browser-b",
        warehouseKey: "inventory-browser-b",
        location: "B-01",
        locationKey: "b-01",
        onHandQuantity: "5",
        reservedQuantity: "0",
        availableQuantity: "5",
        unit: "EA",
        status: "available",
      },
    ],
  });
  const { createScmServer } = await import("../server/scm-api.mjs");
  server = createScmServer();
  server.listen(apiPort, "127.0.0.1", () =>
    console.log(`Inventory operations browser API ready on ${apiPort}`),
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
