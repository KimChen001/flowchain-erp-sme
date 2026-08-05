import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { backfillTenantAuthorization } from "../server/auth/authorization-backfill.mjs";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";
import { seedLocalDemo } from "./setup-local-demo.mjs";
import { seedLocalScenario } from "./setup-local-scenario.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-flowchain-local";
const email = "kim@example.com";
const actorId = `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
const adminEmail = "admin@flowchain.local";
const adminActorId = `USR-${createHash("sha256").update(adminEmail).digest("hex").slice(0, 16)}`;
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
const freePort = () => new Promise((resolvePort, reject) => {
  const socket = createNetServer().on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => resolvePort(port));
  });
});
const pgPort = await freePort();
const password = `local-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-product-recovery-"));
const database = "flowchain_product_recovery_browser";
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
let prisma;
let server;

async function seedCanonicalRfqBrowserScenario(client) {
  await client.rfq.create({
    data: {
      id: "LOCAL-DEMO-RFQ-001",
      tenantId,
      title: "本地演示控制器询价",
      category: "控制器",
      status: "collecting_quotes",
      supplierCount: 4,
      respondedSupplierCount: 1,
      dueDate: new Date("2030-01-10T00:00:00.000Z"),
      sourceRequestId: "LOCAL-DEMO-PR-001",
      linkedPoId: "LOCAL-DEMO-PO-001",
      currency: "CNY",
      metadata: {
        browserAcceptance: true,
        description: "用于验证 RFQ 权威详情读取的 PostgreSQL 场景记录。",
      },
      lines: {
        create: [{
          id: "LOCAL-DEMO-RFQL-001",
          itemId: "LOCAL-DEMO-ITEM-001",
          sku: "LDM-001",
          itemName: "本地演示控制器",
          quantity: 50,
          unit: "pcs",
          metadata: {
            browserAcceptance: true,
            targetUnitPrice: 100,
            requiredDate: "2030-01-15",
            deliveryLocation: "LOCAL-DEMO-WH-001",
          },
        }],
      },
    },
  });
  await client.supplierQuotation.create({
    data: {
      id: "LOCAL-DEMO-QUOTE-001",
      tenantId,
      rfqId: "LOCAL-DEMO-RFQ-001",
      supplierId: "LOCAL-DEMO-SUP-001",
      supplierName: "本地演示供应商 A",
      status: "submitted",
      quotedAmount: 4900,
      currency: "CNY",
      submittedAt: new Date("2030-01-05T08:30:00.000Z"),
      metadata: {
        browserAcceptance: true,
        deliveryDate: "2030-01-14",
        paymentTerms: "NET30",
        validity: "2030-01-20",
      },
      lines: {
        create: [{
          id: "LOCAL-DEMO-QUOTEL-001",
          itemId: "LOCAL-DEMO-ITEM-001",
          sku: "LDM-001",
          itemName: "本地演示控制器",
          quantity: 50,
          unit: "pcs",
          unitPrice: 98,
          amount: 4900,
          metadata: { browserAcceptance: true },
        }],
      },
    },
  });
  await client.supplierQuotationRevision.create({
    data: {
      id: "LOCAL-DEMO-REV-001",
      tenantId,
      quotationId: "LOCAL-DEMO-QUOTE-001",
      revisionNumber: 1,
      status: "submitted",
      quotedAmount: 5000,
      currency: "CNY",
      submittedAt: new Date("2030-01-04T08:30:00.000Z"),
      deliveryDate: new Date("2030-01-16T00:00:00.000Z"),
      paymentTerms: "NET15",
      source: "internal_recording",
      metadata: { browserAcceptance: true },
      lines: {
        create: [{
          id: "LOCAL-DEMO-REVLINE-001",
          sourceQuotationLineId: "LOCAL-DEMO-QUOTEL-001",
          rfqLineId: "LOCAL-DEMO-RFQL-001",
          itemId: "LOCAL-DEMO-ITEM-001",
          skuSnapshot: "LDM-001",
          itemNameSnapshot: "本地演示控制器",
          quantity: 50,
          unit: "pcs",
          unitPrice: 100,
          amount: 5000,
          metadata: { browserAcceptance: true },
        }],
      },
    },
  });
  await client.supplierQuotationRevision.create({
    data: {
      id: "LOCAL-DEMO-REV-002",
      tenantId,
      quotationId: "LOCAL-DEMO-QUOTE-001",
      revisionNumber: 2,
      status: "submitted",
      quotedAmount: 4900,
      currency: "CNY",
      submittedAt: new Date("2030-01-05T08:30:00.000Z"),
      deliveryDate: new Date("2030-01-14T00:00:00.000Z"),
      paymentTerms: "NET30",
      validUntil: new Date("2030-01-20T00:00:00.000Z"),
      source: "internal_recording",
      metadata: { browserAcceptance: true },
      lines: {
        create: [{
          id: "LOCAL-DEMO-REVLINE-002",
          sourceQuotationLineId: "LOCAL-DEMO-QUOTEL-001",
          rfqLineId: "LOCAL-DEMO-RFQL-001",
          itemId: "LOCAL-DEMO-ITEM-001",
          skuSnapshot: "LDM-001",
          itemNameSnapshot: "本地演示控制器",
          quantity: 50,
          unit: "pcs",
          unitPrice: 98,
          amount: 4900,
          metadata: { browserAcceptance: true },
        }],
      },
    },
  });
  await client.rfqSupplierParticipation.createMany({
    data: [
      { id: "LOCAL-DEMO-RFQSP-001", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-001", status: "response_recorded", invitedAt: new Date("2030-01-02T00:00:00.000Z"), respondedAt: new Date("2030-01-05T08:30:00.000Z"), metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-002", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-002", status: "invited_internal", invitedAt: new Date("2030-01-02T00:00:00.000Z"), metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-003", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-003", status: "declined", invitedAt: new Date("2030-01-02T00:00:00.000Z"), metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-004", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-004", status: "withdrawn", invitedAt: new Date("2030-01-02T00:00:00.000Z"), withdrawnAt: new Date("2030-01-06T00:00:00.000Z"), metadata: { browserAcceptance: true } },
    ],
  });
  await client.rfq.create({
    data: {
      id: "LOCAL-DEMO-RFQ EMPTY",
      tenantId,
      title: "无行项目与报价的合法询价",
      status: "draft",
      dueDate: new Date("2030-02-01T00:00:00.000Z"),
      currency: "CNY",
      metadata: { browserAcceptance: true },
    },
  });
}

async function cleanup() {
  await new Promise((resolveClose) => server?.close(resolveClose) || resolveClose());
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
    FLOWCHAIN_DEV_LOCAL: "true",
    FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "false",
    FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `product-recovery-${randomUUID()}-secure`,
    SCM_API_PORT: String(apiPort),
    NODE_ENV: "development",
  });
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: root,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  prisma = await createPrismaClient(process.env);
  await prisma.tenant.create({ data: { id: tenantId, name: "Product Recovery Browser Tenant" } });
  await prisma.user.create({
    data: {
      id: adminActorId,
      tenantId,
      email: adminEmail,
      name: "Initial Admin",
      role: "admin",
      jobTitle: "工作区管理员",
    },
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
  await seedLocalDemo(prisma, process.env);
  if (process.env.PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY !== "true") {
    await seedLocalScenario(prisma, process.env);
    if (process.env.PLAYWRIGHT_CANONICAL_RFQ_DETAIL === "true") {
      await seedCanonicalRfqBrowserScenario(prisma);
    }
  }
  await backfillTenantAuthorization(prisma, tenantId, { actorId: adminActorId });
  const { createScmServer } = await import("../server/scm-api.mjs");
  server = createScmServer();
  server.listen(apiPort, "127.0.0.1", () => {
    console.log(`Product Recovery browser API ready on ${apiPort}`);
  });
} catch (error) {
  console.error(String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]"));
  await cleanup();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await cleanup();
    process.exit(0);
  });
}
