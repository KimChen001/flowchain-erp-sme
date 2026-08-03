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
const tenantId = "tenant-returns-browser";
const warehouseId = "returns-browser-main";
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
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
const pgPort = await freePort();
const password = `local-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-returns-browser-"));
const database = "flowchain_returns_browser";
const url = `postgresql://flowchain_returns_browser:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "flowchain_returns_browser",
  password,
  port: pgPort,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});
let prisma;
let server;

async function cleanup() {
  await new Promise(
    (resolveClose) => server?.close(resolveClose) || resolveClose(),
  );
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function seed() {
  await prisma.tenant.create({
    data: { id: tenantId, name: "Returns Browser Tenant" },
  });
  await prisma.warehouse.createMany({
    data: [
      {
        id: warehouseId,
        tenantId,
        code: "RET-MAIN",
        name: "退货主仓",
      },
      {
        id: "returns-browser-hidden",
        tenantId,
        code: "RET-HIDDEN",
        name: "无权限仓",
      },
    ],
  });
  const users = [
    ["manager@example.com", "Returns Manager", "manager"],
    ["specialist@example.com", "Returns Specialist", "business-specialist"],
    ["viewer@example.com", "Returns Viewer", "viewer"],
    ["readonly@example.com", "No Scope Manager", "manager"],
  ];
  await prisma.user.createMany({
    data: users.map(([email, name, role]) => ({
      id: actorId(email),
      tenantId,
      email,
      name,
      role,
    })),
  });
  await prisma.userWarehouseScope.createMany({
    data: [
      ...["manager@example.com", "specialist@example.com"].map((email) => ({
        id: randomUUID(),
        tenantId,
        userId: actorId(email),
        warehouseId,
        accessLevel: "operate",
      })),
      {
        id: randomUUID(),
        tenantId,
        userId: actorId("viewer@example.com"),
        warehouseId,
        accessLevel: "read",
      },
    ],
  });
  await prisma.item.create({
    data: {
      id: "returns-browser-item",
      tenantId,
      sku: "RET-BROWSER-SKU",
      name: "浏览器退货物料",
      unit: "EA",
    },
  });
  await prisma.inventoryBalance.createMany({
    data: [
      {
        id: "returns-browser-available-source",
        tenantId,
        itemId: "returns-browser-item",
        sku: "RET-BROWSER-SKU",
        itemName: "浏览器退货物料",
        warehouseId,
        warehouseKey: warehouseId,
        location: "A-01",
        locationKey: "a-01",
        onHandQuantity: "20",
        reservedQuantity: "2",
        availableQuantity: "18",
        unit: "EA",
        status: "available",
      },
      {
        id: "returns-browser-available-destination",
        tenantId,
        itemId: "returns-browser-item",
        sku: "RET-BROWSER-SKU",
        itemName: "浏览器退货物料",
        warehouseId,
        warehouseKey: warehouseId,
        location: "Q-01",
        locationKey: "q-01",
        onHandQuantity: "0",
        reservedQuantity: "0",
        availableQuantity: "0",
        unit: "EA",
        status: "available",
      },
    ],
  });
  await prisma.quarantineInventoryBalance.create({
    data: {
      id: "returns-browser-quarantine",
      tenantId,
      itemId: "returns-browser-item",
      sku: "RET-BROWSER-SKU",
      itemName: "浏览器退货物料",
      warehouseId,
      warehouseKey: warehouseId,
      location: "Q-01",
      locationKey: "q-01",
      onHandQuantity: "0",
      unit: "EA",
      status: "active",
    },
  });
  await prisma.salesOrder.create({
    data: {
      id: "returns-browser-sales-order",
      tenantId,
      orderNumber: "SO-RET-BROWSER",
      customerId: "returns-browser-customer",
      customerName: "浏览器客户",
      workflowStatus: "confirmed",
      fulfillmentStatus: "fully_fulfilled",
      currency: "CNY",
      lines: {
        create: {
          id: "returns-browser-sales-line",
          itemId: "returns-browser-item",
          sku: "RET-BROWSER-SKU",
          itemName: "浏览器退货物料",
          orderedQuantity: "8",
          fulfilledQuantity: "8",
          unit: "EA",
        },
      },
    },
  });
  await prisma.inventoryReservation.create({
    data: {
      id: "returns-browser-reservation",
      tenantId,
      salesOrderId: "returns-browser-sales-order",
      salesOrderLineId: "returns-browser-sales-line",
      itemId: "returns-browser-item",
      sku: "RET-BROWSER-SKU",
      warehouseId,
      location: "A-01",
      locationKey: "a-01",
      reservedQuantity: "8",
      allocatedQuantity: "0",
      consumedQuantity: "8",
      releasedQuantity: "0",
      status: "consumed",
      reservedById: actorId("manager@example.com"),
    },
  });
  await prisma.shipmentDocument.create({
    data: {
      id: "returns-browser-shipment",
      tenantId,
      shipmentNumber: "SHIP-RET-BROWSER",
      salesOrderId: "returns-browser-sales-order",
      workflowStatus: "ready",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: actorId("manager@example.com"),
      lines: {
        create: {
          id: "returns-browser-shipment-line",
          salesOrderLineId: "returns-browser-sales-line",
          itemId: "returns-browser-item",
          sku: "RET-BROWSER-SKU",
          requestedQuantity: "8",
          postedQuantity: "8",
          unit: "EA",
          allocations: {
            create: {
              id: "returns-browser-allocation",
              tenantId,
              reservationId: "returns-browser-reservation",
              warehouseId,
              location: "A-01",
              locationKey: "a-01",
              quantity: "8",
              status: "consumed",
            },
          },
        },
      },
    },
  });
  await prisma.purchaseOrder.create({
    data: {
      id: "returns-browser-po",
      tenantId,
      status: "issued",
      supplierId: "returns-browser-supplier",
      supplierName: "浏览器供应商",
      currency: "CNY",
      lines: {
        create: {
          id: "returns-browser-po-line",
          itemId: "returns-browser-item",
          sku: "RET-BROWSER-SKU",
          itemName: "浏览器退货物料",
          orderedQuantity: "10",
          receivedQuantity: "10",
          unit: "EA",
        },
      },
    },
  });
  await prisma.receivingDocument.create({
    data: {
      id: "returns-browser-receiving",
      tenantId,
      documentNumber: "GRN-RET-BROWSER",
      poId: "returns-browser-po",
      supplierId: "returns-browser-supplier",
      supplierName: "浏览器供应商",
      workflowStatus: "approved",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: actorId("manager@example.com"),
      warehouseId,
      currency: "CNY",
      lines: {
        create: {
          id: "returns-browser-receiving-line",
          purchaseOrderLineId: "returns-browser-po-line",
          itemId: "returns-browser-item",
          sku: "RET-BROWSER-SKU",
          itemName: "浏览器退货物料",
          acceptedQty: "10",
          rejectedQty: "0",
          unit: "EA",
          warehouseId,
          location: "A-01",
          locationKey: "a-01",
        },
      },
    },
  });
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
    FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "true",
    FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE:
      process.env.PLAYWRIGHT_RETURNS_QUARANTINE_DISABLED === "true"
        ? "false"
        : "true",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `returns-browser-${randomUUID()}-secure`,
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
    FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
    FLOWCHAIN_COMMIT_SHA: "returns-browser-smoke",
    FLOWCHAIN_BRANCH: "test/returns-browser-smoke",
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
  await seed();
  const { createScmServer } = await import("../server/scm-api.mjs");
  server = createScmServer();
  server.listen(apiPort, "127.0.0.1", () =>
    console.log(`Returns browser API ready on ${apiPort}`),
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
