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
const tenantId = "tenant-operational-finance-browser";
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
const warehouseId = "finance-browser-warehouse";
const settlementScenario = ["PLAYWRIGHT_INTERNAL_SETTLEMENT_DB", "PLAYWRIGHT_SETTLEMENT_WORKFLOW_DB", "PLAYWRIGHT_MOBILE_OPERATIONS_DB"].some((key) => process.env[key] === "true");
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
const password = `finance-browser-${randomUUID()}`;
const directory = await mkdtemp(
  join(tmpdir(), "flowchain-operational-finance-browser-"),
);
const database = "flowchain_operational_finance_browser";
const url = `postgresql://flowchain_operational_finance_browser:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "flowchain_operational_finance_browser",
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

async function seedReturn({
  suffix,
  type,
  sourceType,
  sourceId,
  sourceLineId,
  route,
  postingType,
  target,
}) {
  const requestId = `finance-browser-return-request-${suffix}`;
  const requestLineId = `finance-browser-return-request-line-${suffix}`;
  const authorizationId = `finance-browser-return-auth-${suffix}`;
  const authorizationLineId = `finance-browser-return-auth-line-${suffix}`;
  const postingId = `finance-browser-return-posting-${suffix}`;
  const postingLineId = `finance-browser-return-posting-line-${suffix}`;
  await prisma.returnRequest.create({
    data: {
      id: requestId,
      tenantId,
      requestNumber: `RR-FIN-BROWSER-${suffix}`,
      returnType: type,
      partnerId:
        type === "supplier_return"
          ? "finance-browser-supplier"
          : "finance-browser-customer-cny",
      partnerNameSnapshot:
        type === "supplier_return"
          ? "Finance Browser Supplier"
          : "Finance Browser Customer CNY",
      sourceDocumentType: sourceType,
      sourceDocumentId: sourceId,
      reasonCode: "finance_credit",
      workflowStatus: "executed",
      requestedById: actorId("specialist@example.com"),
      lines: {
        create: {
          id: requestLineId,
          sourceDocumentType: sourceType,
          sourceDocumentId: sourceId,
          sourceDocumentLineId: sourceLineId,
          sourceQuantity: "10.0000",
          itemId: "finance-browser-item",
          sku: "FIN-BROWSER",
          itemName: "Finance Browser Item",
          requestedQuantity: "2.0000",
          unit: "EA",
          reasonCode: "finance_credit",
        },
      },
    },
  });
  await prisma.returnAuthorization.create({
    data: {
      id: authorizationId,
      tenantId,
      authorizationNumber: `RA-FIN-BROWSER-${suffix}`,
      returnRequestId: requestId,
      workflowStatus: "executed",
      authorizedAt: new Date(),
      authorizedById: actorId("manager@example.com"),
      lines: {
        create: {
          id: authorizationLineId,
          returnRequestLineId: requestLineId,
          authorizedQuantity: "2.0000",
          dispositionRoute: route,
        },
      },
    },
  });
  await prisma.returnPostingDocument.create({
    data: {
      id: postingId,
      tenantId,
      postingNumber: `RP-FIN-BROWSER-${suffix}`,
      returnAuthorizationId: authorizationId,
      postingType,
      workflowStatus: "ready",
      postingStatus: "posted",
      warehouseId,
      readyAt: new Date(),
      readyById: actorId("manager@example.com"),
      postedAt: new Date(),
      postedById: actorId("manager@example.com"),
      lines: {
        create: {
          id: postingLineId,
          returnAuthorizationLineId: authorizationLineId,
          itemId: "finance-browser-item",
          sku: "FIN-BROWSER",
          itemName: "Finance Browser Item",
          quantity: "2.0000",
          unit: "EA",
          warehouseId,
          location: target.location,
          locationKey: target.locationKey,
          ...(target.inventoryBalanceId
            ? { inventoryBalanceId: target.inventoryBalanceId }
            : { quarantineBalanceId: target.quarantineBalanceId }),
        },
      },
    },
  });
  return { postingId, postingLineId };
}

async function seedSales(currency, suffix) {
  const orderId = `finance-browser-sales-order-${suffix}`;
  const orderLineId = `finance-browser-sales-line-${suffix}`;
  const shipmentId = `finance-browser-shipment-${suffix}`;
  const shipmentLineId = `finance-browser-shipment-line-${suffix}`;
  await prisma.salesOrder.create({
    data: {
      id: orderId,
      tenantId,
      orderNumber: `SO-FIN-BROWSER-${suffix}`,
      customerId: `finance-browser-customer-${suffix.toLowerCase()}`,
      customerName: `Finance Browser Customer ${suffix}`,
      workflowStatus: "confirmed",
      fulfillmentStatus: "fully_fulfilled",
      currency,
      lines: {
        create: {
          id: orderLineId,
          itemId: "finance-browser-item",
          sku: "FIN-BROWSER",
          itemName: "Finance Browser Item",
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
      id: shipmentId,
      tenantId,
      shipmentNumber: `SHIP-FIN-BROWSER-${suffix}`,
      salesOrderId: orderId,
      workflowStatus: "ready",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: actorId("manager@example.com"),
      lines: {
        create: {
          id: shipmentLineId,
          salesOrderLineId: orderLineId,
          itemId: "finance-browser-item",
          sku: "FIN-BROWSER",
          requestedQuantity: "10.0000",
          postedQuantity: "10.0000",
          unit: "EA",
        },
      },
    },
  });
  return { shipmentId, shipmentLineId };
}

async function seed() {
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: "Operational Finance Browser",
      timezone: "America/New_York",
      operationalSettings: {
        settlementPolicy: {
          settlementApprovalRequired: true,
          settlementSelfApprovalAllowed: false,
          settlementSelfPostingAllowed: true,
          settlementApprovalThreshold: "0",
          settlementDiscountThreshold: "0",
        },
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
      ["manager@example.com", "Finance Manager", "manager"],
      ["specialist@example.com", "Finance Specialist", "business-specialist"],
      ["viewer@example.com", "Finance Viewer", "viewer"],
      ...(settlementScenario
        ? [["settlement@example.com", "Settlement Specialist", "finance-specialist"], ["settlement-en@example.com", "Settlement Specialist EN", "finance-specialist"]]
        : []),
      ...(process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true"
        ? [["mobile@example.com", "Mobile Operations Manager", "manager"], ["mobile-en@example.com", "Mobile Operations Manager EN", "manager"]]
        : []),
      ...(process.env.PLAYWRIGHT_MOBILE_SYNC_CONTROLS === "true"
        ? [["admin@example.com", "Sync Controls Admin", "admin"], ["sync-create@example.com", "Sync Create Only", "viewer"], ["sync-warehouse-a@example.com", "Sync Warehouse A", "viewer"], ["sync-warehouse-b@example.com", "Sync Warehouse B", "viewer"]]
        : []),
      ...(process.env.PLAYWRIGHT_BANK_RECONCILIATION === "true" && process.env.PLAYWRIGHT_MOBILE_SYNC_CONTROLS !== "true"
        ? [["admin@example.com", "Bank Reconciliation Admin", "admin"], ["bank-en@example.com", "Bank Reconciliation Admin EN", "admin"]]
        : []),
    ].map(([email, name, role]) => ({
      id: actorId(email),
      tenantId,
      email,
      name,
      role,
      languagePreference: ["viewer@example.com", "mobile-en@example.com", "settlement-en@example.com", "bank-en@example.com"].includes(email) ? "en-US" : null,
    })),
  });
  if (process.env.PLAYWRIGHT_BANK_RECONCILIATION === "true") {
    await prisma.cashbookAccount.create({ data: { id: "bank-browser-account", tenantId, accountCode: "BANK-BROWSER-CNY", name: "Browser Fictitious Bank", accountType: "bank", currency: "CNY", openingBalance: "1000.0000", currentBalance: "1125.5000" } });
    await prisma.settlementDocument.create({ data: { id: "bank-browser-settlement", tenantId, settlementNumber: "SET-BANK-BROWSER", direction: "receipt", counterpartyType: "customer", counterpartyId: "bank-browser-customer", counterpartyNameSnapshot: "Fictitious Customer", cashbookAccountId: "bank-browser-account", currency: "CNY", amount: "125.5000", cashAmount: "125.5000", totalSettlementAmount: "125.5000", settlementDate: new Date("2026-07-21"), status: "posted", workflowStatus: "posted", postingStatus: "posted", externalReference: "REF-BROWSER-001" } });
    await prisma.cashbookEntry.create({ data: { id: "bank-browser-entry", tenantId, cashbookAccountId: "bank-browser-account", settlementId: "bank-browser-settlement", entryNumber: "CB-BANK-BROWSER", entryType: "settlement", direction: "inflow", amount: "125.5000", currency: "CNY", occurredAt: new Date("2026-07-21"), balanceBefore: "1000.0000", balanceAfter: "1125.5000", postingBatchId: "bank-browser-posting", metadata: { externalReference: "REF-BROWSER-001" } } });
  }
  await prisma.supplier.create({
    data: {
      id: "finance-browser-supplier",
      tenantId,
      code: "FIN-BROWSER-SUP",
      name: "Finance Browser Supplier",
    },
  });
  if (settlementScenario) {
    await prisma.supplierInvoice.create({
      data: {
        id: "finance-browser-settlement-invoice",
        tenantId,
        invoiceNumber: "SI-BROWSER-SETTLEMENT",
        supplierId: "finance-browser-supplier",
        supplierName: "Finance Browser Supplier",
        totalAmount: "60.0000",
        amount: "60.0000",
        currency: "CNY",
        status: "approved",
      },
    });
    await prisma.payableObligation.create({
      data: {
        id: "finance-browser-settlement-payable",
        tenantId,
        supplierInvoiceId: "finance-browser-settlement-invoice",
        obligationNumber: "AP-BROWSER-SETTLEMENT",
        originalAmount: "60.0000",
        outstandingAmount: "60.0000",
        currency: "CNY",
        dueDate: new Date("2026-08-01T00:00:00.000Z"),
        status: "approved",
      },
    });
  }
  await prisma.item.create({
    data: {
      id: "finance-browser-item",
      tenantId,
      sku: "FIN-BROWSER",
      name: "Finance Browser Item",
      unit: "EA",
      preferredSupplierId: "finance-browser-supplier",
    },
  });
  await prisma.warehouse.create({
    data: {
      id: warehouseId,
      tenantId,
      code: "FIN-BROWSER-WH",
      name: "Finance Browser Warehouse",
    },
  });
  if (process.env.PLAYWRIGHT_MOBILE_SYNC_CONTROLS === "true") {
    await prisma.warehouse.create({ data: { id: "finance-browser-warehouse-b", tenantId, code: "FIN-BROWSER-WH-B", name: "Finance Browser Warehouse B" } });
  }
  if (process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true") {
    await prisma.userWarehouseScope.createMany({ data: [
      { id: "mobile-browser-warehouse-scope", tenantId, userId: actorId("mobile@example.com"), warehouseId, accessLevel: "operate" },
      { id: "mobile-browser-en-warehouse-scope", tenantId, userId: actorId("mobile-en@example.com"), warehouseId, accessLevel: "operate" },
      ...(process.env.PLAYWRIGHT_MOBILE_SYNC_CONTROLS === "true" ? [
        { id: "sync-browser-warehouse-a-scope", tenantId, userId: actorId("sync-warehouse-a@example.com"), warehouseId, accessLevel: "operate" },
        { id: "sync-browser-warehouse-b-scope", tenantId, userId: actorId("sync-warehouse-b@example.com"), warehouseId: "finance-browser-warehouse-b", accessLevel: "operate" },
      ] : []),
    ] });
  }
  await prisma.inventoryBalance.create({
    data: {
      id: "finance-browser-balance",
      tenantId,
      itemId: "finance-browser-item",
      sku: "FIN-BROWSER",
      itemName: "Finance Browser Item",
      warehouseId,
      warehouseKey: warehouseId,
      location: "A-01",
      locationKey: "a-01",
      onHandQuantity: "100.0000",
      reservedQuantity: "0.0000",
      availableQuantity: "100.0000",
      unit: "EA",
      status: "available",
    },
  });
  await prisma.quarantineInventoryBalance.create({
    data: {
      id: "finance-browser-quarantine",
      tenantId,
      itemId: "finance-browser-item",
      sku: "FIN-BROWSER",
      itemName: "Finance Browser Item",
      warehouseId,
      warehouseKey: warehouseId,
      location: "Q-01",
      locationKey: "q-01",
      onHandQuantity: "2.0000",
      unit: "EA",
    },
  });
  await prisma.purchaseOrder.create({
    data: {
      id: "finance-browser-po",
      tenantId,
      status: "approved",
      supplierId: "finance-browser-supplier",
      supplierName: "Finance Browser Supplier",
      currency: "CNY",
      lines: {
        create: {
          id: "finance-browser-po-line",
          itemId: "finance-browser-item",
          sku: "FIN-BROWSER",
          itemName: "Finance Browser Item",
          orderedQuantity: "10.0000",
          receivedQuantity: "10.0000",
          unit: "EA",
          unitPrice: "10.0000",
        },
      },
    },
  });
  if (process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true") {
    await prisma.purchaseOrder.create({
      data: {
        id: "mobile-browser-receiving-po",
        tenantId,
        status: "approved",
        supplierId: "finance-browser-supplier",
        supplierName: "Finance Browser Supplier",
        currency: "CNY",
        lines: {
          create: {
            id: "mobile-browser-receiving-po-line",
            itemId: "finance-browser-item",
            sku: "FIN-BROWSER",
            itemName: "Finance Browser Item",
            orderedQuantity: "10.0000",
            receivedQuantity: "0.0000",
            unit: "EA",
            unitPrice: "10.0000",
          },
        },
      },
    });
    for (const [poId, lineId] of [["PO-MOBILE-APPROVE", "mobile-browser-po-approve-line"], ["PO-MOBILE-REJECT", "mobile-browser-po-reject-line"], ["PO-MOBILE-RACE", "mobile-browser-po-race-line"]]) {
      await prisma.purchaseOrder.create({ data: { id: poId, tenantId, status: "pending_approval", supplierId: "finance-browser-supplier", supplierName: "Finance Browser Supplier", sourceRequestId: "PR-MOBILE-BROWSER", sourceRfqId: "RFQ-MOBILE-BROWSER", amount: "100.0000", currency: "CNY", version: 1, metadata: { orderNumber: poId }, lines: { create: { id: lineId, itemId: "finance-browser-item", sku: "FIN-BROWSER", itemName: "Finance Browser Item", orderedQuantity: "10.0000", receivedQuantity: "0.0000", unit: "EA", unitPrice: "10.0000", amount: "100.0000" } } } });
    }
    if (process.env.PLAYWRIGHT_MOBILE_SYNC_CONTROLS === "true") {
      await prisma.receivingDocument.createMany({ data: [
        { id: "sync-browser-receiving-a", tenantId, documentNumber: "GRN-SYNC-A", status: "receiving", workflowStatus: "draft", postingStatus: "unposted", warehouseId, currency: "CNY" },
        { id: "sync-browser-receiving-b", tenantId, documentNumber: "GRN-SYNC-B", status: "receiving", workflowStatus: "draft", postingStatus: "unposted", warehouseId: "finance-browser-warehouse-b", currency: "CNY" },
      ] });
    }
  }
  await prisma.receivingDocument.create({
    data: {
      id: "finance-browser-grn",
      tenantId,
      documentNumber: "GRN-FIN-BROWSER",
      poId: "finance-browser-po",
      supplierId: "finance-browser-supplier",
      supplierName: "Finance Browser Supplier",
      status: "received",
      workflowStatus: "posted",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: actorId("manager@example.com"),
      warehouseId,
      currency: "CNY",
      lines: {
        create: {
          id: "finance-browser-grn-line",
          purchaseOrderLineId: "finance-browser-po-line",
          itemId: "finance-browser-item",
          sku: "FIN-BROWSER",
          itemName: "Finance Browser Item",
          acceptedQty: "10.0000",
          rejectedQty: "0.0000",
          unit: "EA",
          warehouseId,
          location: "A-01",
          locationKey: "a-01",
        },
      },
    },
  });
  const cny = await seedSales("CNY", "CNY");
  if (settlementScenario) {
    await prisma.customerInvoice.create({ data: { id: "finance-browser-customer-settlement-invoice", tenantId, invoiceNumber: "CI-BROWSER-SETTLEMENT", salesOrderId: "finance-browser-sales-order-CNY", shipmentId: cny.shipmentId, customerId: "finance-browser-customer-cny", customerNameSnapshot: "Finance Browser Customer CNY", invoiceDate: new Date("2026-07-01T00:00:00.000Z"), dueDate: new Date("2026-08-01T00:00:00.000Z"), subtotalAmount: "80.0000", totalAmount: "80.0000", currency: "CNY", status: "issued" } });
    await prisma.receivableObligation.create({ data: { id: "finance-browser-settlement-receivable", tenantId, customerInvoiceId: "finance-browser-customer-settlement-invoice", obligationNumber: "AR-BROWSER-SETTLEMENT", originalAmount: "80.0000", outstandingAmount: "80.0000", currency: "CNY", dueDate: new Date("2026-08-01T00:00:00.000Z"), status: "open" } });
  }
  await seedSales("USD", "USD");
  await seedReturn({
    suffix: "SUP",
    type: "supplier_return",
    sourceType: "ReceivingDocument",
    sourceId: "finance-browser-grn",
    sourceLineId: "finance-browser-grn-line",
    route: "return_from_available",
    postingType: "supplier_return_dispatch",
    target: {
      location: "A-01",
      locationKey: "a-01",
      inventoryBalanceId: "finance-browser-balance",
    },
  });
  await seedReturn({
    suffix: "CUST",
    type: "customer_return",
    sourceType: "ShipmentDocument",
    sourceId: cny.shipmentId,
    sourceLineId: cny.shipmentLineId,
    route: "receive_to_quarantine",
    postingType: "customer_return_receipt",
    target: {
      location: "Q-01",
      locationKey: "q-01",
      quarantineBalanceId: "finance-browser-quarantine",
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
    FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE:
      process.env.PLAYWRIGHT_OPERATIONAL_FINANCE_DISABLED === "true"
        ? "false"
        : "true",
    FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT:
      process.env.PLAYWRIGHT_INTERNAL_SETTLEMENT_DB === "true" || process.env.PLAYWRIGHT_SETTLEMENT_WORKFLOW_DB === "true" || process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true" || process.env.PLAYWRIGHT_BANK_RECONCILIATION === "true"
        ? "true"
        : "false",
    FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW:
      process.env.PLAYWRIGHT_SETTLEMENT_WORKFLOW_DISABLED === "true" ? "false" : (process.env.PLAYWRIGHT_SETTLEMENT_WORKFLOW_DB === "true" || process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true" ? "true" : "false"),
    FLOWCHAIN_ENABLE_DB_MOBILE_SYNC:
      process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true" ? "true" : "false",
    FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS:
      process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true" ? "true" : "false",
    FLOWCHAIN_ENABLE_DB_BANK_RECONCILIATION:
      process.env.PLAYWRIGHT_BANK_RECONCILIATION === "true" ? "true" : "false",
    FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING:
      process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true" ? "true" : (process.env.FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING || "false"),
    FLOWCHAIN_SYNC_CURSOR_SECRET: `mobile-browser-${randomUUID()}-cursor-secret`,
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "uploads"),
    FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `finance-browser-${randomUUID()}-secure`,
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
    console.log(`Operational finance browser API ready on ${apiPort}`),
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
