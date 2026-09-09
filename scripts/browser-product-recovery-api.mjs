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
const comparisonViewerEmail = "comparison-viewer@example.com";
const comparisonViewerActorId = `USR-${createHash("sha256").update(comparisonViewerEmail).digest("hex").slice(0, 16)}`;
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
const unsafeScaledDecimal = "90071992547409.1234";
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

async function seedComparisonQuotation(client, quote) {
  await client.supplierQuotation.create({
    data: {
      id: quote.id,
      tenantId,
      rfqId: quote.rfqId,
      supplierId: quote.supplierId,
      supplierName: quote.supplierName,
      status: quote.status,
      quotedAmount: quote.amount,
      currency: quote.currency,
      metadata: { browserAcceptance: true },
    },
  });
  await client.supplierQuotationRevision.create({
    data: {
      id: quote.revisionId,
      tenantId,
      quotationId: quote.id,
      revisionNumber: 1,
      status: quote.status,
      currency: quote.currency,
      quotedAmount: quote.amount,
      submittedAt: ["submitted", "shortlisted", "not_selected", "withdrawn"].includes(quote.status) ? new Date("2030-01-06T08:30:00.000Z") : null,
      validUntil: new Date("2030-03-31T00:00:00.000Z"),
      deliveryDate: new Date(`${quote.deliveryDate}T00:00:00.000Z`),
      paymentTerms: quote.paymentTerms,
      source: "internal_recording",
      metadata: { browserAcceptance: true },
      lines: {
        create: [{
          id: `${quote.revisionId}-LINE-001`,
          rfqLineId: quote.lineId,
          itemId: "LOCAL-DEMO-ITEM-001",
          skuSnapshot: "LDM-001",
          itemNameSnapshot: "本地演示控制器",
          quantity: 50,
          unit: "pcs",
          unitPrice: quote.unitPrice,
          amount: quote.amount,
          deliveryDate: new Date("2030-02-18T00:00:00.000Z"),
          metadata: { browserAcceptance: true },
        }],
      },
    },
  });
}

async function seedCanonicalRfqBrowserScenario(client) {
  const comparisonAcceptance = process.env.PLAYWRIGHT_CANONICAL_RFQ_COMPARISON === "true";
  const supplierResponseAcceptance = process.env.PLAYWRIGHT_CANONICAL_RFQ_SUPPLIER_RESPONSE === "true";
  await client.rfq.create({
    data: {
      id: "LOCAL-DEMO-RFQ-001",
      tenantId,
      title: "本地演示控制器询价",
      category: "控制器",
      status: "collecting_quotes",
      supplierCount: comparisonAcceptance ? 5 : 4,
      respondedSupplierCount: comparisonAcceptance ? 2 : 1,
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
        }, ...(supplierResponseAcceptance ? [{
          id: "LOCAL-DEMO-RFQL-002",
          itemId: "LOCAL-DEMO-ITEM-002",
          sku: "LDM-002",
          itemName: "本地演示传感器",
          quantity: 25,
          unit: "pcs",
          metadata: {
            browserAcceptance: true,
            targetUnitPrice: 40,
            requiredDate: "2030-01-16",
            deliveryLocation: "LOCAL-DEMO-WH-001",
          },
        }] : [])],
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
      quotedAmount: supplierResponseAcceptance ? unsafeScaledDecimal : 4900,
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
          quantity: supplierResponseAcceptance ? unsafeScaledDecimal : 50,
          unit: "pcs",
          unitPrice: supplierResponseAcceptance ? "1.0000" : 98,
          amount: supplierResponseAcceptance ? unsafeScaledDecimal : 4900,
          metadata: { browserAcceptance: true },
        }],
      },
    },
  });
  if (comparisonAcceptance) {
    await seedComparisonQuotation(client, { id: "LOCAL-DEMO-QUOTE-002", rfqId: "LOCAL-DEMO-RFQ-001", lineId: "LOCAL-DEMO-RFQL-001", supplierId: "LOCAL-DEMO-SUP-002", supplierName: "本地演示供应商 B", status: "submitted", currency: "CNY", amount: 4875, unitPrice: 97.5, revisionId: "LOCAL-DEMO-REV-003", paymentTerms: "NET45", deliveryDate: "2030-02-20" });
    for (const supplier of [
      { id: "LOCAL-DEMO-SUP-005", code: "LDS-005", name: "本地演示供应商 E" },
      { id: "LOCAL-DEMO-SUP-006", code: "LDS-006", name: "本地演示供应商 F" },
    ]) await client.supplier.create({ data: { ...supplier, tenantId, category: "服务", status: "active", metadata: { browserAcceptance: true } } }).catch((error) => {
      if (error?.code !== "P2002") throw error;
    });

    for (const scenario of [
      { id: "LOCAL-DEMO-RFQ-COMPARISON-SAME", lineId: "LOCAL-DEMO-RFQL-COMPARISON-SAME", title: "同币种供应商并列比价" },
      { id: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", lineId: "LOCAL-DEMO-RFQL-COMPARISON-MIXED", title: "多币种与历史状态比价" },
      { id: "LOCAL-DEMO-RFQ-COMPARISON-NO-QUOTE", lineId: "LOCAL-DEMO-RFQL-COMPARISON-NO-QUOTE", title: "已有参与但尚无报价" },
      { id: "LOCAL-DEMO-RFQ-COMPARISON-DRAFT", lineId: "LOCAL-DEMO-RFQL-COMPARISON-DRAFT", title: "仅有草稿报价" },
      { id: "LOCAL-DEMO-RFQ-COMPARISON-SINGLE", lineId: "LOCAL-DEMO-RFQL-COMPARISON-SINGLE", title: "仅有一个有效报价" },
      { id: "LOCAL-DEMO-RFQ-COMPARISON-HISTORICAL", lineId: "LOCAL-DEMO-RFQL-COMPARISON-HISTORICAL", title: "仅有历史与撤回报价" },
    ]) await client.rfq.create({ data: { id: scenario.id, tenantId, title: scenario.title, status: "collecting_quotes", supplierCount: 6, respondedSupplierCount: 2, currency: "CNY", metadata: { browserAcceptance: true }, lines: { create: [{ id: scenario.lineId, itemId: "LOCAL-DEMO-ITEM-001", sku: "LDM-001", itemName: "本地演示控制器", quantity: 50, unit: "pcs", metadata: { browserAcceptance: true } }] } } });

    for (const quote of [
      { id: "LOCAL-DEMO-QUOTE-SAME-A", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-SAME", lineId: "LOCAL-DEMO-RFQL-COMPARISON-SAME", supplierId: "LOCAL-DEMO-SUP-001", supplierName: "本地演示供应商 A", status: "submitted", currency: "CNY", amount: 4900, unitPrice: 98, revisionId: "LOCAL-DEMO-REV-SAME-A", paymentTerms: "NET30", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-SAME-B", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-SAME", lineId: "LOCAL-DEMO-RFQL-COMPARISON-SAME", supplierId: "LOCAL-DEMO-SUP-002", supplierName: "本地演示供应商 B", status: "submitted", currency: "CNY", amount: 4875, unitPrice: 97.5, revisionId: "LOCAL-DEMO-REV-SAME-B", paymentTerms: "NET45", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-MIXED-A", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", lineId: "LOCAL-DEMO-RFQL-COMPARISON-MIXED", supplierId: "LOCAL-DEMO-SUP-001", supplierName: "本地演示供应商 A", status: "submitted", currency: "CNY", amount: 4900, unitPrice: 98, revisionId: "LOCAL-DEMO-REV-MIXED-A", paymentTerms: "NET30", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-MIXED-B", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", lineId: "LOCAL-DEMO-RFQL-COMPARISON-MIXED", supplierId: "LOCAL-DEMO-SUP-002", supplierName: "本地演示供应商 B", status: "shortlisted", currency: "USD", amount: 1200, unitPrice: 24, revisionId: "LOCAL-DEMO-REV-MIXED-B", paymentTerms: "NET45", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-MIXED-C", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", lineId: "LOCAL-DEMO-RFQL-COMPARISON-MIXED", supplierId: "LOCAL-DEMO-SUP-003", supplierName: "本地演示供应商 C", status: "draft", currency: "CNY", amount: 4700, unitPrice: 94, revisionId: "LOCAL-DEMO-REV-MIXED-C", paymentTerms: "未提供", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-MIXED-D", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", lineId: "LOCAL-DEMO-RFQL-COMPARISON-MIXED", supplierId: "LOCAL-DEMO-SUP-004", supplierName: "本地演示供应商 D", status: "not_selected", currency: "CNY", amount: 4800, unitPrice: 96, revisionId: "LOCAL-DEMO-REV-MIXED-D", paymentTerms: "NET30", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-MIXED-E", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", lineId: null, supplierId: "LOCAL-DEMO-SUP-005", supplierName: "本地演示供应商 E", status: "withdrawn", currency: "CNY", amount: 4850, unitPrice: 97, revisionId: "LOCAL-DEMO-REV-MIXED-E", paymentTerms: "NET30", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-DRAFT-C", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-DRAFT", lineId: "LOCAL-DEMO-RFQL-COMPARISON-DRAFT", supplierId: "LOCAL-DEMO-SUP-003", supplierName: "本地演示供应商 C", status: "draft", currency: "CNY", amount: 4700, unitPrice: 94, revisionId: "LOCAL-DEMO-REV-DRAFT-C", paymentTerms: "未提供", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-SINGLE-A", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-SINGLE", lineId: "LOCAL-DEMO-RFQL-COMPARISON-SINGLE", supplierId: "LOCAL-DEMO-SUP-001", supplierName: "本地演示供应商 A", status: "submitted", currency: "CNY", amount: 4900, unitPrice: 98, revisionId: "LOCAL-DEMO-REV-SINGLE-A", paymentTerms: "NET30", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-HISTORICAL-D", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-HISTORICAL", lineId: "LOCAL-DEMO-RFQL-COMPARISON-HISTORICAL", supplierId: "LOCAL-DEMO-SUP-004", supplierName: "本地演示供应商 D", status: "not_selected", currency: "CNY", amount: 4800, unitPrice: 96, revisionId: "LOCAL-DEMO-REV-HISTORICAL-D", paymentTerms: "NET30", deliveryDate: "2030-02-20" },
      { id: "LOCAL-DEMO-QUOTE-HISTORICAL-E", rfqId: "LOCAL-DEMO-RFQ-COMPARISON-HISTORICAL", lineId: "LOCAL-DEMO-RFQL-COMPARISON-HISTORICAL", supplierId: "LOCAL-DEMO-SUP-005", supplierName: "本地演示供应商 E", status: "withdrawn", currency: "CNY", amount: 4850, unitPrice: 97, revisionId: "LOCAL-DEMO-REV-HISTORICAL-E", paymentTerms: "NET30", deliveryDate: "2030-02-20" },
    ]) await seedComparisonQuotation(client, quote);

    await client.rfqSupplierParticipation.createMany({ data: [
      ...["001", "002", "003", "004", "005"].map((suffix) => ({ id: `LOCAL-DEMO-RFQSP-MIXED-${suffix}`, tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", supplierId: `LOCAL-DEMO-SUP-${suffix}`, status: suffix === "003" ? "planned" : "response_recorded", metadata: { browserAcceptance: true } })),
      { id: "LOCAL-DEMO-RFQSP-MIXED-006", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-MIXED", supplierId: "LOCAL-DEMO-SUP-006", status: "planned", metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-NO-QUOTE-006", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-NO-QUOTE", supplierId: "LOCAL-DEMO-SUP-006", status: "planned", metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-SAME-001", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-SAME", supplierId: "LOCAL-DEMO-SUP-001", status: "response_recorded", metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-SAME-002", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-SAME", supplierId: "LOCAL-DEMO-SUP-002", status: "response_recorded", metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-DRAFT-003", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-DRAFT", supplierId: "LOCAL-DEMO-SUP-003", status: "planned", metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-SINGLE-001", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-SINGLE", supplierId: "LOCAL-DEMO-SUP-001", status: "response_recorded", metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-HISTORICAL-004", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-HISTORICAL", supplierId: "LOCAL-DEMO-SUP-004", status: "response_recorded", metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-HISTORICAL-005", tenantId, rfqId: "LOCAL-DEMO-RFQ-COMPARISON-HISTORICAL", supplierId: "LOCAL-DEMO-SUP-005", status: "response_recorded", metadata: { browserAcceptance: true } },
    ] });
  }
  await client.rfqSupplierParticipation.createMany({
    data: [
      { id: "LOCAL-DEMO-RFQSP-001", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-001", status: "response_recorded", invitedAt: new Date("2030-01-02T00:00:00.000Z"), respondedAt: new Date("2030-01-05T08:30:00.000Z"), metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-002", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-002", status: comparisonAcceptance ? "response_recorded" : supplierResponseAcceptance ? "planned" : "invited_internal", invitedAt: supplierResponseAcceptance ? null : new Date("2030-01-02T00:00:00.000Z"), respondedAt: comparisonAcceptance ? new Date("2030-01-06T08:30:00.000Z") : null, metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-003", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-003", status: "declined", invitedAt: new Date("2030-01-02T00:00:00.000Z"), metadata: { browserAcceptance: true } },
      { id: "LOCAL-DEMO-RFQSP-004", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-004", status: "withdrawn", invitedAt: new Date("2030-01-02T00:00:00.000Z"), withdrawnAt: new Date("2030-01-06T00:00:00.000Z"), metadata: { browserAcceptance: true } },
      ...(comparisonAcceptance ? [{ id: "LOCAL-DEMO-RFQSP-005", tenantId, rfqId: "LOCAL-DEMO-RFQ-001", supplierId: "LOCAL-DEMO-SUP-005", status: "planned", metadata: { browserAcceptance: true } }] : []),
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
  if (supplierResponseAcceptance) {
    await client.rfq.create({
      data: {
        id: "LOCAL-DEMO-RFQ-CLOSED",
        tenantId,
        title: "已关闭的供应商响应询价",
        status: "closed",
        currency: "CNY",
        metadata: { browserAcceptance: true },
        lines: { create: [{ id: "LOCAL-DEMO-RFQL-CLOSED", itemId: "LOCAL-DEMO-ITEM-001", sku: "LDM-001", itemName: "本地演示控制器", quantity: 1, unit: "pcs", metadata: { browserAcceptance: true } }] },
      },
    });
    await client.rfqSupplierParticipation.create({
      data: { id: "LOCAL-DEMO-RFQSP-CLOSED", tenantId, rfqId: "LOCAL-DEMO-RFQ-CLOSED", supplierId: "LOCAL-DEMO-SUP-002", status: "planned", metadata: { browserAcceptance: true } },
    });
  }
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
  await prisma.tenant.create({ data: { id: tenantId, name: "Product Recovery Browser Tenant", defaultLanguage: "zh-CN" } });
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
  if (process.env.PLAYWRIGHT_CANONICAL_RFQ_COMPARISON === "true") await prisma.user.create({
    data: {
      id: comparisonViewerActorId,
      tenantId,
      email: comparisonViewerEmail,
      name: "Comparison Viewer",
      role: "viewer",
      jobTitle: "只读查看者",
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
    if (process.env.PLAYWRIGHT_CANONICAL_RFQ_DETAIL === "true" || process.env.PLAYWRIGHT_CANONICAL_RFQ_COMPARISON === "true" || process.env.PLAYWRIGHT_CANONICAL_RFQ_SUPPLIER_RESPONSE === "true") {
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
