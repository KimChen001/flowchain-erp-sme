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

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-operational-finance-api";
const managerId = "manager-operational-finance-api";
const specialistId = "specialist-operational-finance-api";
const viewerId = "viewer-operational-finance-api";

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer().on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

const waitFor = async (url) => {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Operational finance API server did not become ready.");
};

const startApi = (env) => {
  const child = spawn(node, ["server/index.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    if (/error|failed|exception/i.test(String(chunk)))
      process.stderr.write(String(chunk));
  });
  child.stderr.on("data", (chunk) =>
    process.stderr.write(
      String(chunk).replace(
        /postgres(?:ql)?:\/\/[^\s]+/gi,
        "[REDACTED_DATABASE_URL]",
      ),
    ),
  );
  return child;
};

const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

async function raw(base, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(responseText);
  } catch {
    payload = { message: responseText };
  }
  return { status: response.status, payload };
}

async function request(base, path, options) {
  const result = await raw(base, path, options);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${options?.method || "GET"} ${path}: ${result.status} ${JSON.stringify(result.payload)}`,
  );
  return result.payload;
}

async function seed(prisma) {
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: "Operational Finance API",
      operationalSettings: {
        review: {
          quantityTolerance: "0.0000",
          pricePercentageTolerance: "0.0000",
          priceAbsoluteTolerance: "0.0000",
          amountTolerance: "0.0000",
        },
      },
    },
  });
  await prisma.user.createMany({
    data: [
      {
        id: managerId,
        tenantId,
        email: "finance-api-manager@flowchain.invalid",
        name: "Finance API Manager",
        role: "manager",
      },
      {
        id: specialistId,
        tenantId,
        email: "finance-api-specialist@flowchain.invalid",
        name: "Finance API Specialist",
        role: "business-specialist",
      },
      {
        id: viewerId,
        tenantId,
        email: "finance-api-viewer@flowchain.invalid",
        name: "Finance API Viewer",
        role: "viewer",
      },
    ],
  });
  await prisma.supplier.create({
    data: {
      id: "supplier-operational-finance-api",
      tenantId,
      code: "SUP-FIN-API",
      name: "Finance API Supplier",
    },
  });
  await prisma.item.create({
    data: {
      id: "item-operational-finance-api",
      tenantId,
      sku: "FIN-API",
      name: "Finance API Item",
      unit: "EA",
    },
  });
  await prisma.warehouse.create({
    data: {
      id: "warehouse-operational-finance-api",
      tenantId,
      code: "FIN-API",
      name: "Finance API Warehouse",
    },
  });
  await prisma.purchaseOrder.create({
    data: {
      id: "PO-FIN-API",
      tenantId,
      status: "approved",
      supplierId: "supplier-operational-finance-api",
      supplierName: "Finance API Supplier",
      currency: "USD",
      lines: {
        create: {
          id: "POL-FIN-API",
          itemId: "item-operational-finance-api",
          sku: "FIN-API",
          itemName: "Finance API Item",
          orderedQuantity: "10.0000",
          receivedQuantity: "10.0000",
          unit: "EA",
          unitPrice: "12.5000",
        },
      },
    },
  });
  await prisma.receivingDocument.create({
    data: {
      id: "GRN-FIN-API",
      tenantId,
      documentNumber: "GRN-FIN-API",
      poId: "PO-FIN-API",
      supplierId: "supplier-operational-finance-api",
      supplierName: "Finance API Supplier",
      status: "received",
      workflowStatus: "posted",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: managerId,
      warehouseId: "warehouse-operational-finance-api",
      currency: "USD",
      lines: {
        create: {
          id: "GRNL-FIN-API",
          purchaseOrderLineId: "POL-FIN-API",
          itemId: "item-operational-finance-api",
          sku: "FIN-API",
          itemName: "Finance API Item",
          acceptedQty: "10.0000",
          rejectedQty: "0.0000",
          unit: "EA",
          warehouseId: "warehouse-operational-finance-api",
          location: "A-01",
          locationKey: "a-01",
        },
      },
    },
  });
  await prisma.salesOrder.create({
    data: {
      id: "SO-FIN-API",
      tenantId,
      orderNumber: "SO-FIN-API",
      customerId: "customer-finance-api",
      customerName: "Finance API Customer",
      workflowStatus: "confirmed",
      reservationStatus: "fully_reserved",
      fulfillmentStatus: "fully_fulfilled",
      currency: "USD",
      lines: {
        create: {
          id: "SOL-FIN-API",
          itemId: "item-operational-finance-api",
          sku: "FIN-API",
          itemName: "Finance API Item",
          orderedQuantity: "10.0000",
          fulfilledQuantity: "10.0000",
          unit: "EA",
          unitPrice: "12.5000",
          amount: "125.0000",
        },
      },
    },
  });
  await prisma.shipmentDocument.create({
    data: {
      id: "SHIP-FIN-API",
      tenantId,
      shipmentNumber: "SHIP-FIN-API",
      salesOrderId: "SO-FIN-API",
      workflowStatus: "ready",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: managerId,
      lines: {
        create: {
          id: "SHIPL-FIN-API",
          salesOrderLineId: "SOL-FIN-API",
          itemId: "item-operational-finance-api",
          sku: "FIN-API",
          requestedQuantity: "10.0000",
          postedQuantity: "10.0000",
          unit: "EA",
        },
      },
    },
  });
}

const pgPort = await freePort();
const apiPort = await freePort();
const password = `finance-api-${randomUUID()}`;
const directory = await mkdtemp(
  join(tmpdir(), "flowchain-operational-finance-api-"),
);
const database = "flowchain_operational_finance_api";
const databaseUrl = `postgresql://flowchain_operational_finance_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "flowchain_operational_finance_api",
  password,
  port: pgPort,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});
let prisma;
let server;

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  const baseEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_TEST: databaseUrl,
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `finance-api-${randomUUID()}-secure-secret`,
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
    FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
    FLOWCHAIN_COMMIT_SHA: "operational-finance-api-smoke",
    FLOWCHAIN_BRANCH: "test/operational-finance-api-smoke",
    FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "false",
    SCM_API_PORT: String(apiPort),
    NODE_ENV: "production",
  };
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], {
    cwd: root,
    env: baseEnv,
    maxBuffer: 20 * 1024 * 1024,
  });
  prisma = await createPrismaClient(baseEnv);
  await seed(prisma);
  const base = `http://127.0.0.1:${apiPort}`;

  server = startApi({
    ...baseEnv,
    FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "false",
  });
  await waitFor(`${base}/api/health`);
  const disabledLogin = await request(base, "/api/auth/login", {
    method: "POST",
    body: {
      email: "finance-api-specialist@flowchain.invalid",
      name: "Ignored",
      company: "Ignored",
    },
  });
  const disabledRead = await request(base, "/api/finance/supplier-invoices", {
    token: disabledLogin.token,
  });
  assert.equal(disabledRead.capabilities["supplier-invoice"].enabled, false);
  const disabledWrite = await raw(
    base,
    "/api/finance/supplier-invoices/preview",
    {
      token: disabledLogin.token,
      method: "POST",
      body: {},
    },
  );
  assert.equal(disabledWrite.status, 409);
  assert.equal(
    disabledWrite.payload.code,
    "OPERATIONAL_FINANCE_CAPABILITY_NOT_AVAILABLE",
  );
  const disabledO2cWrite = await raw(
    base,
    "/api/finance/customer-invoices/preview",
    { token: disabledLogin.token, method: "POST", body: {} },
  );
  assert.equal(disabledO2cWrite.status, 409);
  assert.equal(
    disabledO2cWrite.payload.details.capability,
    "customer-invoice",
  );
  await stop(server);
  server = null;

  server = startApi({
    ...baseEnv,
    FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  });
  await waitFor(`${base}/api/health`);
  const specialistLogin = await request(base, "/api/auth/login", {
    method: "POST",
    body: {
      email: "finance-api-specialist@flowchain.invalid",
      name: "Ignored",
      company: "Ignored",
    },
  });
  const managerLogin = await request(base, "/api/auth/login", {
    method: "POST",
    body: {
      email: "finance-api-manager@flowchain.invalid",
      name: "Ignored",
      company: "Ignored",
    },
  });
  const viewerLogin = await request(base, "/api/auth/login", {
    method: "POST",
    body: {
      email: "finance-api-viewer@flowchain.invalid",
      name: "Ignored",
      company: "Ignored",
    },
  });
  const invoice = {
    tenantId: "forged-tenant",
    invoiceNumber: "SUP-INV-API-001",
    supplierId: "supplier-operational-finance-api",
    currency: "USD",
    invoiceDate: "2026-07-17T00:00:00.000Z",
    dueDate: "2026-08-16T00:00:00.000Z",
    totalAmount: "51.0000",
    lines: [
      {
        purchaseOrderLineId: "POL-FIN-API",
        receivingLineId: "GRNL-FIN-API",
        quantity: "4.0000",
        unitPrice: "12.5000",
        lineAmount: "50.0000",
        enteredTaxAmount: "1.0000",
      },
    ],
  };
  const preview = await request(
    base,
    "/api/finance/supplier-invoices/preview",
    {
      token: specialistLogin.token,
      method: "POST",
      body: invoice,
    },
  );
  assert.equal(preview.allowed, true);
  assert.equal(preview.invoice.totalAmount, "51.0000");
  const created = await request(base, "/api/finance/supplier-invoices", {
    token: specialistLogin.token,
    method: "POST",
    body: { ...invoice, idempotencyKey: "api-create-invoice" },
  });
  assert.equal(created.invoice.status, "draft");
  const stored = await prisma.supplierInvoice.findUnique({
    where: { id: created.entityId },
  });
  assert.equal(stored.tenantId, tenantId);

  const staleSubmitPreview = await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}/submit-preview`,
    {
      token: specialistLogin.token,
      method: "POST",
      body: { expectedVersion: 99 },
    },
  );
  assert.equal(staleSubmitPreview.allowed, false);
  assert.ok(
    staleSubmitPreview.blockingIssues.some(
      (entry) => entry.code === "FINANCE_VERSION_CONFLICT",
    ),
  );
  assert.equal(
    (
      await request(
        base,
        `/api/finance/supplier-invoices/${created.entityId}/submit-preview`,
        {
          token: specialistLogin.token,
          method: "POST",
          body: { expectedVersion: 0 },
        },
      )
    ).allowed,
    true,
  );
  await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}/submit`,
    {
      token: specialistLogin.token,
      method: "POST",
      body: { expectedVersion: 0, idempotencyKey: "api-submit-invoice" },
    },
  );
  const staleMatchPreview = await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}/match-preview`,
    {
      token: specialistLogin.token,
      method: "POST",
      body: { expectedVersion: 99 },
    },
  );
  assert.equal(staleMatchPreview.allowed, false);
  assert.ok(
    staleMatchPreview.blockingIssues.some(
      (entry) => entry.code === "FINANCE_VERSION_CONFLICT",
    ),
  );
  const matchPreview = await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}/match-preview`,
    {
      token: specialistLogin.token,
      method: "POST",
      body: { expectedVersion: 1 },
    },
  );
  assert.equal(matchPreview.allowed, true);
  assert.equal(matchPreview.exceptions.length, 0);
  const matched = await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}/match`,
    {
      token: specialistLogin.token,
      method: "POST",
      body: {
        expectedVersion: 1,
        matchNumber: "MATCH-API-001",
        idempotencyKey: "api-match-invoice",
      },
    },
  );
  assert.equal(matched.invoice.status, "matched");
  const approvalPreview = await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}/approve-preview`,
    {
      token: managerLogin.token,
      method: "POST",
      body: { expectedVersion: 2, obligationNumber: "AP-API-001" },
    },
  );
  assert.equal(approvalPreview.allowed, true);
  const approved = await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}/approve`,
    {
      token: managerLogin.token,
      method: "POST",
      body: {
        expectedVersion: 2,
        obligationNumber: "AP-API-001",
        idempotencyKey: "api-approve-invoice",
      },
    },
  );
  assert.equal(approved.payable.status, "approved");
  const payablePreview = await request(
    base,
    `/api/finance/payables/${approved.payable.id}/hold-preview`,
    {
      token: managerLogin.token,
      method: "POST",
      body: { expectedVersion: 0, reason: "API hold test" },
    },
  );
  assert.equal(payablePreview.allowed, true);
  const held = await request(
    base,
    `/api/finance/payables/${approved.payable.id}/hold`,
    {
      token: managerLogin.token,
      method: "POST",
      body: {
        expectedVersion: 0,
        reason: "API hold test",
        idempotencyKey: "api-hold-payable",
      },
    },
  );
  assert.equal(held.payable.status, "held");

  const detail = await request(
    base,
    `/api/finance/supplier-invoices/${created.entityId}`,
    { token: viewerLogin.token },
  );
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.reconciliation[0].matched, true);
  assert.equal(detail.payable.settlementExecuted, false);
  const viewerWrite = await raw(
    base,
    "/api/finance/supplier-invoices/preview",
    { token: viewerLogin.token, method: "POST", body: invoice },
  );
  assert.equal(viewerWrite.status, 403);
  assert.equal(viewerWrite.payload.code, "AUTHORIZATION_PERMISSION_DENIED");
  assert.doesNotMatch(JSON.stringify(viewerWrite.payload), /P20(?:02|25|34)/);
  const unauthenticated = await raw(
    base,
    "/api/finance/supplier-invoices",
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(
    await prisma.inventoryMovement.count({ where: { tenantId } }),
    0,
  );
  const customerInvoiceInput = {
    invoiceNumber: "CUS-INV-API-001",
    shipmentId: "SHIP-FIN-API",
    currency: "USD",
    invoiceDate: "2026-07-17T00:00:00.000Z",
    dueDate: "2026-08-16T00:00:00.000Z",
    totalAmount: "51.0000",
    lines: [
      {
        shipmentLineId: "SHIPL-FIN-API",
        quantity: "4.0000",
        enteredTaxAmount: "1.0000",
      },
    ],
  };
  const customerPreview = await request(
    base,
    "/api/finance/customer-invoices/preview",
    {
      token: specialistLogin.token,
      method: "POST",
      body: customerInvoiceInput,
    },
  );
  assert.equal(customerPreview.allowed, true);
  assert.equal(customerPreview.source.shipmentId, "SHIP-FIN-API");
  const customerCreated = await request(
    base,
    "/api/finance/customer-invoices",
    {
      token: specialistLogin.token,
      method: "POST",
      body: {
        ...customerInvoiceInput,
        idempotencyKey: "api-create-customer-invoice",
      },
    },
  );
  await request(
    base,
    `/api/finance/customer-invoices/${customerCreated.entityId}/submit`,
    {
      token: specialistLogin.token,
      method: "POST",
      body: {
        expectedVersion: 0,
        idempotencyKey: "api-submit-customer-invoice",
      },
    },
  );
  await request(
    base,
    `/api/finance/customer-invoices/${customerCreated.entityId}/approve`,
    {
      token: managerLogin.token,
      method: "POST",
      body: {
        expectedVersion: 1,
        idempotencyKey: "api-approve-customer-invoice",
      },
    },
  );
  const customerIssued = await request(
    base,
    `/api/finance/customer-invoices/${customerCreated.entityId}/issue`,
    {
      token: managerLogin.token,
      method: "POST",
      body: {
        expectedVersion: 2,
        obligationNumber: "AR-API-001",
        idempotencyKey: "api-issue-customer-invoice",
      },
    },
  );
  assert.equal(customerIssued.receivable.status, "open");
  assert.equal(customerIssued.receivable.settlementVerified, false);
  const customerDetail = await request(
    base,
    `/api/finance/customer-invoices/${customerCreated.entityId}`,
    { token: viewerLogin.token },
  );
  assert.equal(customerDetail.evidence[1].postingStatus, "posted");
  assert.equal(customerDetail.reconciliation.fxConverted, false);
  const aging = await request(base, "/api/finance/aging", {
    token: viewerLogin.token,
  });
  assert.deepEqual(aging.currencies, ["USD"]);
  assert.equal(aging.currencyAggregationStatus, "single_currency");
  assert.equal(aging.fxConverted, false);
  const disputed = await request(
    base,
    `/api/finance/receivables/${customerIssued.receivable.id}/dispute`,
    {
      token: managerLogin.token,
      method: "POST",
      body: {
        expectedVersion: 0,
        reason: "API customer dispute",
        idempotencyKey: "api-dispute-receivable",
      },
    },
  );
  assert.equal(disputed.receivable.status, "disputed");
  const externalReference = await request(
    base,
    `/api/finance/receivables/${customerIssued.receivable.id}/record-external-reference`,
    {
      token: managerLogin.token,
      method: "POST",
      body: {
        expectedVersion: 1,
        externalReference: "BANK-UNVERIFIED-API",
        idempotencyKey: "api-reference-receivable",
      },
    },
  );
  assert.equal(externalReference.receivable.status, "disputed");
  assert.equal(externalReference.receivable.settlementVerified, false);
  const landing = await request(base, "/api/finance/landing", {
    token: viewerLogin.token,
  });
  assert.equal(landing.cards.approvedPayableObligations, 1);
  assert.equal(landing.cards.disputedReceivables, 1);
  assert.equal(landing.settlementClaims.payableMeansPaid, false);
  assert.equal(landing.settlementClaims.receivableMeansCollected, false);
  assert.equal(landing.currencyLimitations.fxConverted, false);
  console.log(
    "Operational finance API acceptance: P2P + O2C passed, 0 failed, 0 skipped",
  );
} finally {
  await stop(server);
  if (prisma) await prisma.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
