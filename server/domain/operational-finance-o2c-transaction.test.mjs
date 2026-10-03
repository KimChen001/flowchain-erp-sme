import assert from "node:assert/strict";
import test from "node:test";
import { createPrismaClient } from "../persistence/prisma-client.mjs";
import { createOperationalFinanceO2cCommandService } from "./operational-finance-o2c-command-service.mjs";
import {
  agingBucket,
  agingDays,
  createOperationalFinanceO2cReadService,
} from "./operational-finance-o2c-read-service.mjs";

const databaseUrl =
  process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
const enabled = Boolean(databaseUrl);
const tenantId = "tenant-operational-finance-o2c";
const otherTenantId = "tenant-operational-finance-o2c-other";
const managerId = "manager-operational-finance-o2c";
const specialistId = "specialist-operational-finance-o2c";
const viewerId = "viewer-operational-finance-o2c";
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_URL_TEST: databaseUrl,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
  NODE_ENV: "test",
};
const identity = (userId, role, currentTenantId = tenantId) => ({
  authenticated: true,
  tenantId: currentTenantId,
  userId,
  role,
  source: "test",
});
const manager = { identity: identity(managerId, "manager") };
const specialist = {
  identity: identity(specialistId, "business-specialist"),
};
const viewer = { identity: identity(viewerId, "viewer") };
const capabilities = Object.fromEntries(
  ["customer-invoice", "receivable-obligation", "customer-credit-note"].map(
    (id) => [id, { id, enabled: true, maturity: "beta" }],
  ),
);

async function seed(prisma) {
  await prisma.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: "Operational Finance O2C",
        timezone: "America/New_York",
      },
      { id: otherTenantId, name: "Other O2C Tenant" },
    ],
  });
  await prisma.user.createMany({
    data: [
      {
        id: managerId,
        tenantId,
        email: "manager-o2c@flowchain.invalid",
        name: "O2C Manager",
        role: "manager",
      },
      {
        id: specialistId,
        tenantId,
        email: "specialist-o2c@flowchain.invalid",
        name: "O2C Specialist",
        role: "business-specialist",
      },
      {
        id: viewerId,
        tenantId,
        email: "viewer-o2c@flowchain.invalid",
        name: "O2C Viewer",
        role: "viewer",
      },
      {
        id: "other-o2c-manager",
        tenantId: otherTenantId,
        email: "other-o2c@flowchain.invalid",
        name: "Other O2C Manager",
        role: "manager",
      },
    ],
  });
  await prisma.item.create({
    data: {
      id: "item-operational-finance-o2c",
      tenantId,
      sku: "FIN-O2C",
      name: "O2C Item",
      unit: "EA",
    },
  });
  await prisma.warehouse.create({
    data: {
      id: "warehouse-operational-finance-o2c",
      tenantId,
      code: "O2C-WH",
      name: "O2C Warehouse",
    },
  });
  await prisma.quarantineInventoryBalance.create({
    data: {
      id: "quarantine-operational-finance-o2c",
      tenantId,
      itemId: "item-operational-finance-o2c",
      sku: "FIN-O2C",
      itemName: "O2C Item",
      warehouseId: "warehouse-operational-finance-o2c",
      warehouseKey: "warehouse-operational-finance-o2c",
      location: "Q-01",
      locationKey: "q-01",
      onHandQuantity: "2.0000",
      unit: "EA",
    },
  });
}

async function shipment(prisma, suffix, currency = "CNY") {
  const orderId = `SO-O2C-${suffix}`;
  const orderLineId = `SOL-O2C-${suffix}`;
  const shipmentId = `SHIP-O2C-${suffix}`;
  const shipmentLineId = `SHIPL-O2C-${suffix}`;
  await prisma.salesOrder.create({
    data: {
      id: orderId,
      tenantId,
      orderNumber: `SO-${suffix}`,
      customerId: `customer-${suffix}`,
      customerName: `Customer ${suffix}`,
      workflowStatus: "confirmed",
      reservationStatus: "fully_reserved",
      fulfillmentStatus: "fully_fulfilled",
      currency,
      lines: {
        create: {
          id: orderLineId,
          itemId: "item-operational-finance-o2c",
          sku: "FIN-O2C",
          itemName: "O2C Item",
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
      shipmentNumber: `SHIP-${suffix}`,
      salesOrderId: orderId,
      workflowStatus: "ready",
      postingStatus: "posted",
      postedAt: new Date("2026-07-01T12:00:00.000Z"),
      postedById: managerId,
      lines: {
        create: {
          id: shipmentLineId,
          salesOrderLineId: orderLineId,
          itemId: "item-operational-finance-o2c",
          sku: "FIN-O2C",
          requestedQuantity: "10.0000",
          postedQuantity: "10.0000",
          unit: "EA",
        },
      },
    },
  });
  return { orderId, orderLineId, shipmentId, shipmentLineId, currency };
}

const invoiceInput = (source, suffix, quantity = "4.0000") => ({
  invoiceNumber: `CUS-INV-${suffix}`,
  shipmentId: source.shipmentId,
  currency: source.currency,
  invoiceDate: "2026-07-01T00:00:00.000Z",
  dueDate: "2026-07-10T00:00:00.000Z",
  totalAmount: String(Number(quantity) * 12.5 + 2),
  lines: [
    {
      shipmentLineId: source.shipmentLineId,
      quantity,
      enteredTaxAmount: "2.0000",
    },
  ],
});

async function issueInvoice(command, input, suffix) {
  const created = await command.createCustomerInvoice(
    { ...input, idempotencyKey: `create-${suffix}` },
    specialist,
  );
  await command.submitCustomerInvoice(
    created.invoice.id,
    {
      expectedVersion: 0,
      idempotencyKey: `submit-${suffix}`,
    },
    specialist,
  );
  await command.approveCustomerInvoice(
    created.invoice.id,
    {
      expectedVersion: 1,
      idempotencyKey: `approve-${suffix}`,
    },
    manager,
  );
  return command.issueCustomerInvoice(
    created.invoice.id,
    {
      expectedVersion: 2,
      obligationNumber: `AR-${suffix}`,
      idempotencyKey: `issue-${suffix}`,
    },
    manager,
  );
}

async function postedCustomerReturn(prisma, source, suffix) {
  const requestId = `RR-O2C-${suffix}`;
  const requestLineId = `RRL-O2C-${suffix}`;
  const authorizationId = `RA-O2C-${suffix}`;
  const authorizationLineId = `RAL-O2C-${suffix}`;
  const postingId = `RP-O2C-${suffix}`;
  const postingLineId = `RPL-O2C-${suffix}`;
  await prisma.returnRequest.create({
    data: {
      id: requestId,
      tenantId,
      requestNumber: `RR-${suffix}`,
      returnType: "customer_return",
      partnerId: `customer-${suffix}`,
      partnerNameSnapshot: `Customer ${suffix}`,
      sourceDocumentType: "ShipmentDocument",
      sourceDocumentId: source.shipmentId,
      sourceDocumentNumber: `SHIP-${suffix}`,
      reasonCode: "customer_return",
      workflowStatus: "authorized",
      requestedById: managerId,
      submittedAt: new Date(),
      submittedById: managerId,
      lines: {
        create: {
          id: requestLineId,
          sourceDocumentType: "ShipmentDocument",
          sourceDocumentId: source.shipmentId,
          sourceDocumentLineId: source.shipmentLineId,
          sourceQuantity: "10.0000",
          itemId: "item-operational-finance-o2c",
          sku: "FIN-O2C",
          itemName: "O2C Item",
          requestedQuantity: "2.0000",
          unit: "EA",
          reasonCode: "customer_return",
        },
      },
    },
  });
  await prisma.returnAuthorization.create({
    data: {
      id: authorizationId,
      tenantId,
      authorizationNumber: `RA-${suffix}`,
      returnRequestId: requestId,
      workflowStatus: "executed",
      authorizedAt: new Date(),
      authorizedById: managerId,
      lines: {
        create: {
          id: authorizationLineId,
          returnRequestLineId: requestLineId,
          authorizedQuantity: "2.0000",
          dispositionRoute: "receive_to_quarantine",
        },
      },
    },
  });
  await prisma.returnPostingDocument.create({
    data: {
      id: postingId,
      tenantId,
      postingNumber: `RP-${suffix}`,
      returnAuthorizationId: authorizationId,
      postingType: "customer_return_receipt",
      workflowStatus: "ready",
      postingStatus: "posted",
      warehouseId: "warehouse-operational-finance-o2c",
      readyAt: new Date(),
      readyById: managerId,
      postedAt: new Date(),
      postedById: managerId,
      lines: {
        create: {
          id: postingLineId,
          returnAuthorizationLineId: authorizationLineId,
          itemId: "item-operational-finance-o2c",
          sku: "FIN-O2C",
          itemName: "O2C Item",
          quantity: "2.0000",
          unit: "EA",
          warehouseId: "warehouse-operational-finance-o2c",
          location: "Q-01",
          locationKey: "q-01",
          quarantineBalanceId: "quarantine-operational-finance-o2c",
        },
      },
    },
  });
  return { postingId, postingLineId };
}

test(
  "O2C invoice and receivable lifecycle is shipment-backed, idempotent, tenant-safe, and collection-free",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient(env);
    try {
      await seed(prisma);
      const command = createOperationalFinanceO2cCommandService({
        prisma,
        env,
        now: () => new Date("2026-07-17T16:00:00.000Z"),
      });
      const read = createOperationalFinanceO2cReadService({
        prisma,
        capabilities,
        now: () => new Date("2026-07-17T16:00:00.000Z"),
      });
      const cny = await shipment(prisma, "CNY", "CNY");
      const payload = invoiceInput(cny, "CNY");
      const preview = await command.previewCustomerInvoice(payload, specialist);
      assert.equal(preview.allowed, true);
      assert.equal(preview.invoice.totalAmount, "52.0000");
      assert.equal(preview.source.shipmentId, cny.shipmentId);
      assert.equal(preview.fxConverted, false);

      await assert.rejects(
        command.createCustomerInvoice(
          { ...payload, idempotencyKey: "viewer-create" },
          viewer,
        ),
        (error) => error.code === "AUTHORIZATION_PERMISSION_DENIED",
      );
      const issued = await issueInvoice(command, payload, "CNY");
      assert.equal(issued.invoice.status, "issued");
      assert.equal(issued.receivable.status, "open");
      assert.equal(issued.receivable.outstandingAmount, "52");
      assert.equal(issued.receivable.settlementVerified, false);
      const replay = await command.issueCustomerInvoice(
        issued.invoice.id,
        {
          expectedVersion: 2,
          obligationNumber: "AR-CNY",
          idempotencyKey: "issue-CNY",
        },
        manager,
      );
      assert.equal(replay.idempotentReplay, true);
      assert.equal(
        await prisma.receivableObligation.count({
          where: { customerInvoiceId: issued.invoice.id },
        }),
        1,
      );

      const excess = await command.previewCustomerInvoice(
        invoiceInput(cny, "EXCESS", "7.0000"),
        specialist,
      );
      assert.equal(excess.allowed, true);
      const excessDraft = await command.createCustomerInvoice(
        {
          ...invoiceInput(cny, "EXCESS", "7.0000"),
          idempotencyKey: "create-excess",
        },
        specialist,
      );
      await assert.rejects(
        command.submitCustomerInvoice(
          excessDraft.invoice.id,
          { expectedVersion: 0, idempotencyKey: "submit-excess" },
          specialist,
        ),
        (error) =>
          error.code === "CUSTOMER_INVOICE_QUANTITY_EXCEEDS_SHIPPED",
      );

      const detail = await read.customerInvoiceDetail(
        issued.invoice.id,
        viewer,
      );
      assert.equal(detail.evidence[1].postingStatus, "posted");
      assert.equal(detail.reconciliation.fxConverted, false);
      assert.deepEqual(detail.availableActions, []);
      const returned = await postedCustomerReturn(prisma, cny, "CNY");
      const creditInput = {
        creditNoteNumber: "CUS-CN-CNY",
        customerInvoiceId: issued.invoice.id,
        returnPostingId: returned.postingId,
        currency: "CNY",
        lines: [
          {
            customerInvoiceLineId: detail.lines[0].id,
            returnPostingLineId: returned.postingLineId,
            quantity: "2.0000",
            pricingSource: "original_invoice",
            enteredTaxAmount: "0.0000",
          },
        ],
      };
      const creditPreview = await command.previewCustomerCreditNote(
        creditInput,
        specialist,
      );
      assert.equal(creditPreview.allowed, true);
      assert.equal(creditPreview.creditNote.totalAmount, "25.0000");
      assert.equal(creditPreview.refundExecution, false);
      const credit = await command.createCustomerCreditNote(
        { ...creditInput, idempotencyKey: "create-customer-credit-cny" },
        specialist,
      );
      const approvedCredit = await command.approveCustomerCreditNote(
        credit.creditNote.id,
        {
          expectedVersion: 0,
          idempotencyKey: "approve-customer-credit-cny",
        },
        manager,
      );
      assert.equal(approvedCredit.creditNote.status, "approved");
      const receivableAfterCredit =
        await prisma.receivableObligation.findUnique({
          where: { id: issued.receivable.id },
        });
      assert.equal(String(receivableAfterCredit.outstandingAmount), "27");
      assert.equal(String(receivableAfterCredit.approvedCreditAmount), "25");
      const creditList = await read.listCustomerCreditNotes({}, viewer);
      assert.equal(creditList.total, 1);
      assert.equal(creditList.items[0].returnPostingId, returned.postingId);
      assert.equal(creditList.items[0].refundExecuted, false);

      const receivableId = issued.receivable.id;
      const disputePreview = await command.previewReceivableAction(
        "dispute",
        receivableId,
        { expectedVersion: 1, reason: "Customer contests quantity" },
        manager,
      );
      assert.equal(disputePreview.allowed, true);
      const disputed = await command.disputeReceivable(
        receivableId,
        {
          expectedVersion: 1,
          reason: "Customer contests quantity",
          idempotencyKey: "dispute-cny",
        },
        manager,
      );
      assert.equal(disputed.receivable.status, "disputed");
      assert.equal(disputed.receivable.disputeStatus, "open");
      const resolved = await command.resolveReceivableDispute(
        receivableId,
        {
          expectedVersion: 2,
          reason: "Evidence accepted",
          idempotencyKey: "resolve-cny",
        },
        manager,
      );
      assert.equal(resolved.receivable.status, "overdue");
      assert.equal(resolved.receivable.disputeStatus, "resolved");
      const referenced = await command.recordExternalSettlementReference(
        receivableId,
        {
          expectedVersion: 3,
          externalReference: "BANK-UNVERIFIED-001",
          idempotencyKey: "reference-cny",
        },
        manager,
      );
      assert.equal(referenced.receivable.status, "overdue");
      assert.equal(referenced.receivable.outstandingAmount, "27");
      assert.equal(referenced.receivable.settlementVerified, false);

      const usd = await shipment(prisma, "USD", "USD");
      await issueInvoice(command, invoiceInput(usd, "USD"), "USD");
      // The viewer reads the aging buckets but not their amounts.
      const hiddenAging = await read.aging({}, viewer);
      assert.deepEqual(hiddenAging.currencies, ["CNY", "USD"]);
      assert.ok(hiddenAging.groups.every((group) => group.total === null && group.current === null && group.count > 0));
      assert.ok(hiddenAging.items.every((item) => item.outstandingAmount === null));
      const aging = await read.aging({}, manager);
      assert.equal(aging.timezone, "America/New_York");
      assert.equal(
        aging.currencyAggregationStatus,
        "multi_currency_unconverted",
      );
      assert.equal(aging.fxConverted, false);
      assert.deepEqual(aging.currencies, ["CNY", "USD"]);
      assert.equal(aging.groups.length, 2);
      assert.equal(
        aging.groups.find((group) => group.currency === "CNY").total,
        "27.0000",
      );
      assert.equal(
        aging.groups.find((group) => group.currency === "USD").total,
        "52.0000",
      );
      const landing = await read.landing(viewer);
      assert.equal(landing.cards.customerCreditNotes, 1);
      assert.equal(landing.cards.disputedReceivables, 0);
      assert.equal(
        landing.currencyLimitations.aggregationStatus,
        "multi_currency_unconverted",
      );
      assert.equal(landing.currencyLimitations.fxConverted, false);
      assert.equal(landing.settlementClaims.receivableMeansCollected, false);
      assert.equal(landing.settlementClaims.payableMeansPaid, false);
      assert.equal(
        await prisma.inventoryMovement.count({ where: { tenantId } }),
        0,
      );
      assert.equal(
        await prisma.auditLog.count({
          where: {
            tenantId,
            module: "finance",
          },
        }),
        14,
      );

      const otherRead = await createOperationalFinanceO2cReadService({
        prisma,
        capabilities,
      }).listCustomerInvoices(
        {},
        {
          identity: identity(
            "other-o2c-manager",
            "manager",
            otherTenantId,
          ),
        },
      );
      assert.equal(otherRead.total, 0);
    } finally {
      await prisma.$disconnect();
    }
  },
);

test("aging uses workspace-local calendar boundaries", () => {
  const asOf = new Date("2026-03-09T03:30:00.000Z");
  const due = new Date("2026-03-08T04:30:00.000Z");
  assert.equal(agingDays(due, asOf, "America/New_York"), 1);
  assert.equal(agingBucket(0), "current");
  assert.equal(agingBucket(30), "1_30");
  assert.equal(agingBucket(31), "31_60");
  assert.equal(agingBucket(91), "90_plus");
});
