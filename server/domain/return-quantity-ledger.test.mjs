// The returns quantity ledger (design audit batch A10), walked through the
// real return, finance and reversal kernels on Postgres. Returns stay
// switched off in the product; these are the fixes that must hold before
// they are switched on (December step 7).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createReturnGovernanceCommandService } from "./return-governance-command-service.mjs";
import { buildReturnRequestPlan } from "./return-governance-policy.mjs";
import { createCustomerReturnCommandService } from "./customer-return-command-service.mjs";
import { buildCustomerReturnReversalPlan } from "./customer-return-transaction-policy.mjs";
import { createQuarantineReleaseCommandService } from "./quarantine-release-command-service.mjs";
import { createSupplierReturnCommandService } from "./supplier-return-command-service.mjs";
import { buildSupplierReturnReversalPlan } from "./supplier-return-transaction-policy.mjs";
import { createOperationalFinanceCommandService } from "./operational-finance-command-service.mjs";
import { buildCustomerInvoicePlan } from "./operational-finance-o2c-policy.mjs";
import { buildShipmentReversalPlan } from "./outbound-transaction-policy.mjs";
import { buildReceivingReversalPlan } from "./receiving-transaction-policy.mjs";
import { uncreditedReturnedQuantities } from "./return-quantity-ledger.mjs";
import { createPrismaClient } from "../persistence/prisma-client.mjs";

const databaseUrl =
  process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
const enabled = Boolean(databaseUrl);
const tenantId = "tenant-return-ledger-a10";
const warehouseId = "warehouse-return-ledger-a10";
const itemId = "item-return-ledger-a10";
const managerId = "manager-return-ledger-a10";
const clerkId = "clerk-return-ledger-a10";
const supplierId = "supplier-return-ledger-a10";
const sku = "RET-LEDGER-A10";
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_URL_TEST: databaseUrl,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE: "true",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
  NODE_ENV: "test",
};
const actor = (userId, role) => ({
  identity: { authenticated: true, tenantId, userId, role, source: "test" },
});
const manager = actor(managerId, "manager");
const clerk = actor(clerkId, "business-specialist");
const codes = (plan) => (plan.blockingIssues || []).map((row) => row.code);

async function seed(prisma) {
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: "Return Ledger A10",
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
  await prisma.warehouse.create({
    data: { id: warehouseId, tenantId, code: "RET-A10", name: "Returns A10" },
  });
  await prisma.user.createMany({
    data: [
      { id: managerId, tenantId, email: "manager-return-ledger-a10@flowchain.invalid", name: "Manager", role: "manager" },
      { id: clerkId, tenantId, email: "clerk-return-ledger-a10@flowchain.invalid", name: "Clerk", role: "business-specialist" },
    ],
  });
  await prisma.userWarehouseScope.create({
    data: { id: randomUUID(), tenantId, userId: managerId, warehouseId, accessLevel: "operate" },
  });
  await prisma.item.create({
    data: { id: itemId, tenantId, sku, name: "Return Ledger Item", unit: "EA" },
  });
  await prisma.supplier.create({
    data: { id: supplierId, tenantId, code: "SUP-A10", name: "Ledger Supplier" },
  });
}

// A posted shipment of `quantity` units, priced 5.0000 a unit.
async function shipped(prisma, suffix, quantity) {
  const ids = {
    salesOrderId: `so-a10-${suffix}`,
    salesLineId: `so-line-a10-${suffix}`,
    shipmentId: `shipment-a10-${suffix}`,
    shipmentLineId: `shipment-line-a10-${suffix}`,
  };
  await prisma.salesOrder.create({
    data: {
      id: ids.salesOrderId,
      tenantId,
      orderNumber: `SO-A10-${suffix}`,
      customerId: "customer-a10",
      customerName: "Ledger Customer",
      workflowStatus: "confirmed",
      fulfillmentStatus: "fully_fulfilled",
      currency: "USD",
      lines: {
        create: {
          id: ids.salesLineId,
          itemId,
          sku,
          itemName: "Return Ledger Item",
          orderedQuantity: quantity,
          fulfilledQuantity: quantity,
          unit: "EA",
          unitPrice: "5.0000",
        },
      },
    },
  });
  await prisma.inventoryReservation.create({
    data: {
      id: `reservation-a10-${suffix}`,
      tenantId,
      salesOrderId: ids.salesOrderId,
      salesOrderLineId: ids.salesLineId,
      itemId,
      sku,
      warehouseId,
      location: "A-01",
      locationKey: "a-01",
      reservedQuantity: quantity,
      consumedQuantity: quantity,
      status: "consumed",
      reservedById: managerId,
    },
  });
  await prisma.shipmentDocument.create({
    data: {
      id: ids.shipmentId,
      tenantId,
      shipmentNumber: `SHIP-A10-${suffix}`,
      salesOrderId: ids.salesOrderId,
      workflowStatus: "ready",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: managerId,
      lines: {
        create: {
          id: ids.shipmentLineId,
          salesOrderLineId: ids.salesLineId,
          itemId,
          sku,
          requestedQuantity: quantity,
          postedQuantity: quantity,
          unit: "EA",
          allocations: {
            create: {
              id: `shipment-allocation-a10-${suffix}`,
              tenantId,
              reservationId: `reservation-a10-${suffix}`,
              warehouseId,
              location: "A-01",
              locationKey: "a-01",
              quantity,
              status: "consumed",
            },
          },
        },
      },
    },
  });
  return ids;
}

// A fully received purchase order line and its posted receipt, priced
// 10.0000 a unit, with the received goods on hand at A-01.
async function received(prisma, suffix, quantity) {
  const ids = {
    poId: `po-a10-${suffix}`,
    poLineId: `po-line-a10-${suffix}`,
    grnId: `grn-a10-${suffix}`,
    receivingLineId: `grn-line-a10-${suffix}`,
    balanceId: `balance-a10-${suffix}`,
  };
  await prisma.purchaseOrder.create({
    data: {
      id: ids.poId,
      tenantId,
      status: "fully_received",
      receivingBaseStatus: "approved",
      supplierId,
      supplierName: "Ledger Supplier",
      currency: "USD",
      lines: {
        create: {
          id: ids.poLineId,
          itemId,
          sku,
          itemName: "Return Ledger Item",
          orderedQuantity: quantity,
          receivedQuantity: quantity,
          unit: "EA",
          unitPrice: "10.0000",
        },
      },
    },
  });
  await prisma.receivingDocument.create({
    data: {
      id: ids.grnId,
      tenantId,
      documentNumber: `GRN-A10-${suffix}`,
      poId: ids.poId,
      supplierId,
      supplierName: "Ledger Supplier",
      status: "received",
      workflowStatus: "posted",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: managerId,
      warehouseId,
      currency: "USD",
      lines: {
        create: {
          id: ids.receivingLineId,
          purchaseOrderLineId: ids.poLineId,
          itemId,
          sku,
          itemName: "Return Ledger Item",
          acceptedQty: quantity,
          rejectedQty: "0.0000",
          unit: "EA",
          warehouseId,
          location: `L-${suffix}`,
          locationKey: `l-${suffix}`.toLowerCase(),
        },
      },
    },
  });
  await prisma.inventoryBalance.create({
    data: {
      id: ids.balanceId,
      tenantId,
      itemId,
      sku,
      itemName: "Return Ledger Item",
      warehouseId,
      warehouseKey: warehouseId,
      location: `L-${suffix}`,
      locationKey: `l-${suffix}`.toLowerCase(),
      onHandQuantity: quantity,
      reservedQuantity: "0.0000",
      availableQuantity: quantity,
      unit: "EA",
      status: "available",
    },
  });
  return ids;
}

function services(prisma, label) {
  let clock = new Date("2026-11-15T12:00:00Z");
  const now = () => {
    clock = new Date(clock.getTime() + 1000);
    return new Date(clock);
  };
  let step = 0;
  const idem = (name) => `a10-${label}-${name}-${(step += 1)}`;
  const governance = createReturnGovernanceCommandService({ prisma, env, now });
  const receipts = createCustomerReturnCommandService({ prisma, env, now });
  const releases = createQuarantineReleaseCommandService({ prisma, env, now });
  const supplierReturns = createSupplierReturnCommandService({ prisma, env, now });
  const finance = createOperationalFinanceCommandService({ prisma, env, now });
  const versions = async (postingId) => {
    const posting = await prisma.returnPostingDocument.findUnique({
      where: { id: postingId },
      include: { returnAuthorization: { include: { returnRequest: true } } },
    });
    return {
      expectedPostingVersion: posting.version,
      expectedAuthorizationVersion: posting.returnAuthorization.version,
      expectedRequestVersion: posting.returnAuthorization.returnRequest.version,
    };
  };
  const readyAndPost = async (service, postingId, postName) => {
    const posting = await prisma.returnPostingDocument.findUnique({ where: { id: postingId } });
    await service.readyPosting(
      postingId,
      { expectedPostingVersion: posting.version, idempotencyKey: idem("ready") },
      manager,
    );
    return service[postName](
      postingId,
      { ...(await versions(postingId)), idempotencyKey: idem("post") },
      manager,
    );
  };
  // Create, submit and authorize a request; returns the ids the next steps need.
  const authorizedRequest = async ({ requestNumber, returnType, contextDocumentType, contextDocumentId, sourceDocumentLineId, quantity, route, resolution }) => {
    const created = await governance.createRequest(
      {
        requestNumber,
        returnType,
        contextDocumentType,
        contextDocumentId,
        reasonCode: "damaged",
        ...(resolution ? { resolution } : {}),
        lines: [{ sourceDocumentLineId, requestedQuantity: quantity }],
        idempotencyKey: idem("create"),
      },
      manager,
    );
    const requestId = created.entityId;
    await governance.submitRequest(requestId, { expectedVersion: 0, idempotencyKey: idem("submit") }, manager);
    const authorization = await authorize(requestId, `${requestNumber}-AUTH`, quantity, route);
    return { requestId, ...authorization };
  };
  const authorize = async (requestId, authorizationNumber, quantity, route) => {
    const request = await prisma.returnRequest.findUnique({ where: { id: requestId }, include: { lines: true } });
    const authorization = await governance.authorizeRequest(
      requestId,
      {
        expectedRequestVersion: request.version,
        authorizationNumber,
        idempotencyKey: idem("authorize"),
        lines: [{ returnRequestLineId: request.lines[0].id, authorizedQuantity: quantity, dispositionRoute: route }],
      },
      manager,
    );
    const line = await prisma.returnAuthorizationLine.findFirst({ where: { returnAuthorizationId: authorization.entityId } });
    return { requestLineId: request.lines[0].id, authorizationId: authorization.entityId, authorizationLineId: line.id };
  };
  // Customer return receipt into quarantine, posted.
  const receive = async (request, postingNumber, quantity, target) => {
    const authorization = await prisma.returnAuthorization.findUnique({ where: { id: request.authorizationId } });
    const draft = await receipts.createDraft(
      {
        authorizationId: request.authorizationId,
        postingNumber,
        expectedAuthorizationVersion: authorization.version,
        lines: [{ returnAuthorizationLineId: request.authorizationLineId, quantity, ...target }],
        idempotencyKey: idem("receipt-draft"),
      },
      manager,
    );
    await readyAndPost(receipts, draft.entityId, "postReceipt");
    return draft.entityId;
  };
  const release = async (release, postingNumber, quantity, quarantineBalanceId) => {
    const authorization = await prisma.returnAuthorization.findUnique({ where: { id: release.authorizationId } });
    const draft = await releases.createDraft(
      {
        authorizationId: release.authorizationId,
        postingNumber,
        expectedAuthorizationVersion: authorization.version,
        lines: [{ returnAuthorizationLineId: release.authorizationLineId, quantity, quarantineBalanceId, destinationLocation: "A-02" }],
        idempotencyKey: idem("release-draft"),
      },
      manager,
    );
    await readyAndPost(releases, draft.entityId, "postRelease");
    return draft.entityId;
  };
  const dispatch = async (request, postingNumber, quantity, balance) => {
    const authorization = await prisma.returnAuthorization.findUnique({ where: { id: request.authorizationId } });
    const draft = await supplierReturns.createPostingDraft(
      {
        authorizationId: request.authorizationId,
        postingNumber,
        expectedAuthorizationVersion: authorization.version,
        lines: [{ returnAuthorizationLineId: request.authorizationLineId, quantity, ...balance }],
        idempotencyKey: idem("dispatch-draft"),
      },
      manager,
    );
    await readyAndPost(supplierReturns, draft.entityId, "postSupplierReturn");
    return draft.entityId;
  };
  return { governance, receipts, releases, supplierReturns, finance, idem, versions, authorizedRequest, authorize, receive, release, dispatch };
}

const requestPlan = (prisma, input) =>
  buildReturnRequestPlan({
    prisma,
    tenantId,
    input: { requestNumber: "PREVIEW", reasonCode: "damaged", ...input },
  });

test(
  "a customer return that was received and released is counted once, holds its shipment and is not invoiced",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient(env);
    try {
      await seed(prisma);
      const run = services(prisma, "A");
      const source = await shipped(prisma, "A", "10");
      const customerReturn = (requestedQuantity) =>
        requestPlan(prisma, {
          returnType: "customer_return",
          contextDocumentType: "ShipmentDocument",
          contextDocumentId: source.shipmentId,
          lines: [{ sourceDocumentLineId: source.shipmentLineId, requestedQuantity }],
        });

      // Ship 10; the customer returns 4, received to quarantine, then released.
      const first = await run.authorizedRequest({
        requestNumber: "RET-A10-A1",
        returnType: "customer_return",
        contextDocumentType: "ShipmentDocument",
        contextDocumentId: source.shipmentId,
        sourceDocumentLineId: source.shipmentLineId,
        quantity: "4",
        route: "receive_to_quarantine",
      });
      await run.receive(first, "CRR-A10-A1", "4", { warehouseId, location: "RET-Q" });
      const quarantine = await prisma.quarantineInventoryBalance.findFirst({ where: { tenantId, sku } });
      const releaseAuthorization = await run.authorize(first.requestId, "RET-A10-A1-REL", "4", "release_quarantine_to_available");

      // While the release is authorized, the request does not count its 4 again.
      assert.equal((await customerReturn("6")).allowed, true);
      await run.release(releaseAuthorization, "QR-A10-A1", "4", quarantine.id);

      // L8-05: 6 can still be returned, not 2 (receipt 4 + release 4 counted as 8).
      assert.equal((await customerReturn("6")).allowed, true);
      const tooMany = await customerReturn("7");
      assert.deepEqual(codes(tooMany), ["RETURN_QUANTITY_EXCEEDS_SOURCE"]);
      assert.equal(tooMany.blockingIssues[0].details.remainingQuantity, "6.0000");
      assert.equal(tooMany.blockingIssues[0].details.executedReturnQuantity, "4.0000");

      // L8-07: the shipment a return names cannot be reversed.
      const reversal = await buildShipmentReversalPlan({ prisma, tenantId, shipmentId: source.shipmentId, reason: "Entered twice" });
      assert.ok(codes(reversal).includes("SHIPMENT_REVERSAL_BLOCKED_BY_RETURN"), codes(reversal).join(","));
      assert.deepEqual(
        reversal.blockingIssues.find((row) => row.code === "SHIPMENT_REVERSAL_BLOCKED_BY_RETURN").details.returnRequests.map((row) => row.requestNumber),
        ["RET-A10-A1"],
      );

      // L8-08: the 4 returned are not invoiced; 6 are.
      const invoice = (quantity) =>
        buildCustomerInvoicePlan({
          prisma,
          tenantId,
          input: {
            shipmentId: source.shipmentId,
            currency: "USD",
            invoiceDate: "2026-11-15",
            dueDate: "2026-12-15",
            lines: [{ shipmentLineId: source.shipmentLineId, quantity, enteredTaxAmount: "0" }],
          },
          consumeExisting: true,
        });
      const full = await invoice("10");
      assert.deepEqual(codes(full), ["CUSTOMER_INVOICE_QUANTITY_EXCEEDS_SHIPPED"]);
      assert.equal(full.blockingIssues[0].details.returnedNotCreditedQuantity, "4.0000");
      assert.equal((await invoice("6")).allowed, true);
    } finally {
      await prisma.$disconnect();
    }
  },
);

test(
  "a release uses its own return's goods, and a supplier return from quarantine lowers what can be released",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient(env);
    try {
      const run = services(prisma, "B");
      const source = await shipped(prisma, "B", "10");
      const request = (requestNumber, quantity) =>
        run.authorizedRequest({
          requestNumber,
          returnType: "customer_return",
          contextDocumentType: "ShipmentDocument",
          contextDocumentId: source.shipmentId,
          sourceDocumentLineId: source.shipmentLineId,
          quantity,
          route: "receive_to_quarantine",
        });
      // R1 (4) and then R2 (3) come back into the same quarantine stock record.
      const first = await request("RET-A10-B1", "4");
      const firstReceipt = await run.receive(first, "CRR-A10-B1", "4", { warehouseId, location: "RET-B" });
      const quarantine = await prisma.quarantineInventoryBalance.findFirst({ where: { tenantId, sku, locationKey: "ret-b" } });
      const second = await request("RET-A10-B2", "3");
      const secondReceipt = await run.receive(second, "CRR-A10-B2", "3", { quarantineBalanceId: quarantine.id });

      // Releasing R2 takes R2's goods, not R1's older layer (L8-09).
      const secondRelease = await run.authorize(second.requestId, "RET-A10-B2-REL", "3", "release_quarantine_to_available");
      await run.release(secondRelease, "QR-A10-B2", "3", quarantine.id);
      const allocations = await prisma.quarantineDispositionAllocation.findMany({ where: { tenantId, quarantineBalanceId: quarantine.id, status: "active" } });
      const sources = await prisma.inventoryMovement.findMany({ where: { id: { in: allocations.map((row) => row.sourceMovementId) } } });
      assert.deepEqual([...new Set(sources.map((row) => row.sourceDocumentId))], [secondReceipt]);
      // So R1's receipt can still be reversed, and R2's cannot.
      const firstReversal = await buildCustomerReturnReversalPlan({ prisma, tenantId, postingId: firstReceipt });
      assert.deepEqual(codes(firstReversal), []);
      const secondReversal = await buildCustomerReturnReversalPlan({ prisma, tenantId, postingId: secondReceipt });
      assert.ok(codes(secondReversal).includes("RETURN_REVERSAL_NOT_SAFE"));

      // A supplier return sends 2 units back from quarantine. It takes the
      // oldest layer, R1's, so only 2 of R1's 4 can still be released.
      const receipt = await received(prisma, "B", "10");
      const toSupplier = await run.authorizedRequest({
        requestNumber: "RET-A10-B-SUP",
        returnType: "supplier_return",
        contextDocumentType: "ReceivingDocument",
        contextDocumentId: receipt.grnId,
        sourceDocumentLineId: receipt.receivingLineId,
        quantity: "2",
        route: "return_from_quarantine",
      });
      await run.dispatch(toSupplier, "SRD-A10-B", "2", { quarantineBalanceId: quarantine.id });
      const request1 = await prisma.returnRequest.findUnique({ where: { id: first.requestId }, include: { lines: true } });
      const releaseInput = (quantity) => ({
        expectedRequestVersion: request1.version,
        authorizationNumber: `RET-A10-B1-REL-${quantity}`,
        idempotencyKey: run.idem("release-authorize"),
        lines: [{ returnRequestLineId: request1.lines[0].id, authorizedQuantity: quantity, dispositionRoute: "release_quarantine_to_available" }],
      });
      await assert.rejects(
        run.governance.authorizeRequest(first.requestId, releaseInput("4"), manager),
        (error) => {
          assert.equal(error.code, "RETURN_RELEASE_EXCEEDS_RECEIVED_QUARANTINE", error.message);
          assert.equal(error.details.releasableQuantity, "2.0000");
          return true;
        },
      );
      const firstRelease = await run.governance.authorizeRequest(first.requestId, releaseInput("2"), manager);
      assert.ok(firstRelease.entityId);
    } finally {
      await prisma.$disconnect();
    }
  },
);

test(
  "a supplier return holds its receipt, counts once while partly dispatched, and a bill for all received goods is an exception",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient(env);
    try {
      const run = services(prisma, "C");
      const receipt = await received(prisma, "C", "100");
      const supplierReturn = (requestedQuantity) =>
        requestPlan(prisma, {
          returnType: "supplier_return",
          contextDocumentType: "ReceivingDocument",
          contextDocumentId: receipt.grnId,
          lines: [{ sourceDocumentLineId: receipt.receivingLineId, requestedQuantity }],
        });

      // 20 of the 100 received go back to the supplier, for a credit.
      const credited = await run.authorizedRequest({
        requestNumber: "RET-A10-C1",
        returnType: "supplier_return",
        contextDocumentType: "ReceivingDocument",
        contextDocumentId: receipt.grnId,
        sourceDocumentLineId: receipt.receivingLineId,
        quantity: "20",
        route: "return_from_available",
      });
      const creditedDispatch = await run.dispatch(credited, "SRD-A10-C1", "20", { inventoryBalanceId: receipt.balanceId });

      // L8-07: the receipt a return names cannot be reversed.
      const loaded = async () => ({
        receivingDocument: await prisma.receivingDocument.findUnique({ where: { id: receipt.grnId }, include: { lines: true } }),
        purchaseOrder: await prisma.purchaseOrder.findUnique({ where: { id: receipt.poId }, include: { lines: true } }),
      });
      const receiptReversal = await buildReceivingReversalPlan({ prisma, tenantId, ...(await loaded()) });
      assert.ok(codes(receiptReversal).includes("RECEIVING_REVERSAL_BLOCKED_BY_RETURN"), codes(receiptReversal).join(","));

      // L2-06: after 20 went back, a bill for all 100 received is a quantity
      // exception against the 80 still received.
      const bill = {
        invoiceNumber: "SUP-INV-A10-C",
        supplierId,
        currency: "USD",
        invoiceDate: "2026-11-15T00:00:00.000Z",
        dueDate: "2026-12-15T00:00:00.000Z",
        totalAmount: "1000.0000",
        lines: [{ purchaseOrderLineId: receipt.poLineId, receivingLineId: receipt.receivingLineId, quantity: "100.0000", unitPrice: "10.0000", lineAmount: "1000.0000", enteredTaxAmount: "0.0000" }],
      };
      const created = await run.finance.createSupplierInvoice({ ...bill, idempotencyKey: run.idem("bill") }, clerk);
      await run.finance.submitSupplierInvoice(created.entityId, { expectedVersion: 0, idempotencyKey: run.idem("submit-bill") }, clerk);
      const matched = await run.finance.matchSupplierInvoice(
        created.entityId,
        { expectedVersion: 1, matchNumber: "MATCH-A10-C", idempotencyKey: run.idem("match") },
        clerk,
      );
      const exceptions = await prisma.financeMatchException.findMany({ where: { supplierInvoiceId: created.entityId } });
      assert.deepEqual(exceptions.map((row) => row.exceptionType), ["quantity"]);
      assert.equal(String(exceptions[0].expectedValue), "80");
      assert.equal(String(exceptions[0].actualValue), "100");
      const matchLine = await prisma.threeWayMatchLine.findFirst({ where: { match: { invoiceId: created.entityId } } });
      assert.equal(matchLine.metadata.returnedQuantity, "20.0000");
      assert.ok(matched);

      // An approved credit memo for the 20 takes them off the bill, so they
      // no longer count as returned-but-unsettled.
      const invoice = await prisma.supplierInvoice.findUnique({ where: { id: created.entityId }, include: { lines: true } });
      const postingLine = await prisma.returnPostingLine.findFirst({ where: { returnPostingId: creditedDispatch } });
      const memo = await run.finance.createSupplierCreditMemo(
        {
          creditMemoNumber: "SCM-A10-C1",
          supplierInvoiceId: invoice.id,
          returnPostingId: creditedDispatch,
          currency: "USD",
          lines: [{ supplierInvoiceLineId: invoice.lines[0].id, returnPostingLineId: postingLine.id, quantity: "20.0000", pricingSource: "original_invoice", enteredTaxAmount: "0.0000" }],
          idempotencyKey: run.idem("credit"),
        },
        clerk,
      );
      await run.finance.approveSupplierCreditMemo(memo.entityId, { expectedVersion: 0, idempotencyKey: run.idem("approve-credit") }, manager);
      const ledger = await uncreditedReturnedQuantities({ prisma, tenantId, sourceDocumentType: "ReceivingDocument", sourceLineIds: [receipt.receivingLineId] });
      const line = ledger.get(receipt.receivingLineId);
      assert.deepEqual([line.returned, line.credited, line.uncredited], [200000n, 200000n, 0n]);

      // L8-05 (supplier side): a request for 10 with 6 dispatched counts 10, not 16.
      const partly = await run.authorizedRequest({
        requestNumber: "RET-A10-C2",
        returnType: "supplier_return",
        contextDocumentType: "ReceivingDocument",
        contextDocumentId: receipt.grnId,
        sourceDocumentLineId: receipt.receivingLineId,
        quantity: "10",
        route: "return_from_available",
      });
      await run.dispatch(partly, "SRD-A10-C2", "6", { inventoryBalanceId: receipt.balanceId });
      assert.equal((await prisma.returnRequest.findUnique({ where: { id: partly.requestId } })).workflowStatus, "partially_executed");
      // 100 - 20 returned - 6 dispatched - 4 still to dispatch = 70.
      assert.equal((await supplierReturn("70")).allowed, true);
      const over = await supplierReturn("71");
      assert.equal(over.blockingIssues[0].details.remainingQuantity, "70.0000");
    } finally {
      await prisma.$disconnect();
    }
  },
);

test(
  "a supplier return for a replacement reopens the purchase order line and cannot also be credited",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient(env);
    try {
      const run = services(prisma, "D");
      const receipt = await received(prisma, "D", "50");
      // A customer return cannot ask for a replacement.
      const shipment = await shipped(prisma, "D", "5");
      const customerReplacement = await requestPlan(prisma, {
        returnType: "customer_return",
        contextDocumentType: "ShipmentDocument",
        contextDocumentId: shipment.shipmentId,
        resolution: "replacement",
        lines: [{ sourceDocumentLineId: shipment.shipmentLineId, requestedQuantity: "1" }],
      });
      assert.deepEqual(codes(customerReplacement), ["RETURN_RESOLUTION_INVALID"]);

      const replacement = await run.authorizedRequest({
        requestNumber: "RET-A10-D1",
        returnType: "supplier_return",
        contextDocumentType: "ReceivingDocument",
        contextDocumentId: receipt.grnId,
        sourceDocumentLineId: receipt.receivingLineId,
        quantity: "15",
        route: "return_from_available",
        resolution: "replacement",
      });
      assert.equal((await prisma.returnRequest.findUnique({ where: { id: replacement.requestId } })).resolution, "replacement");
      const dispatched = await run.dispatch(replacement, "SRD-A10-D1", "15", { inventoryBalanceId: receipt.balanceId });

      // L3-23: the 15 are on order again.
      let order = await prisma.purchaseOrder.findUnique({ where: { id: receipt.poId }, include: { lines: true } });
      assert.equal(String(order.lines[0].receivedQuantity), "35");
      assert.equal(order.status, "partially_received");

      // The replacement is not credited as well.
      const bill = await run.finance.createSupplierInvoice(
        {
          invoiceNumber: "SUP-INV-A10-D",
          supplierId,
          currency: "USD",
          invoiceDate: "2026-11-15T00:00:00.000Z",
          dueDate: "2026-12-15T00:00:00.000Z",
          totalAmount: "350.0000",
          lines: [{ purchaseOrderLineId: receipt.poLineId, receivingLineId: receipt.receivingLineId, quantity: "35.0000", unitPrice: "10.0000", lineAmount: "350.0000", enteredTaxAmount: "0.0000" }],
          idempotencyKey: run.idem("bill-d"),
        },
        clerk,
      );
      await run.finance.submitSupplierInvoice(bill.entityId, { expectedVersion: 0, idempotencyKey: run.idem("submit-d") }, clerk);
      const billLines = await prisma.supplierInvoiceLine.findMany({ where: { supplierInvoiceId: bill.entityId } });
      const postingLine = await prisma.returnPostingLine.findFirst({ where: { returnPostingId: dispatched } });
      const creditPreview = await run.finance.previewSupplierCreditMemo(
        {
          creditMemoNumber: "SCM-A10-D1",
          supplierInvoiceId: bill.entityId,
          returnPostingId: dispatched,
          currency: "USD",
          lines: [{ supplierInvoiceLineId: billLines[0].id, returnPostingLineId: postingLine.id, quantity: "15.0000", pricingSource: "original_invoice", enteredTaxAmount: "0.0000" }],
        },
        clerk,
      );
      assert.ok(codes(creditPreview).includes("SUPPLIER_CREDIT_REPLACEMENT_RETURN"), codes(creditPreview).join(","));

      // Before the replacement arrives the dispatch can be reversed, and the
      // order is fully received again.
      const reversalPlan = await buildSupplierReturnReversalPlan({ prisma, tenantId, postingId: dispatched });
      assert.deepEqual(codes(reversalPlan), []);
      assert.equal(reversalPlan.purchaseOrderImpact.statusAfter, "fully_received");
      // Once the replacement was received, it cannot.
      await prisma.purchaseOrderLine.update({ where: { id: receipt.poLineId }, data: { receivedQuantity: "50" } });
      const lateReversal = await buildSupplierReturnReversalPlan({ prisma, tenantId, postingId: dispatched });
      assert.ok(codes(lateReversal).includes("RETURN_REVERSAL_REPLACEMENT_RECEIVED"), codes(lateReversal).join(","));
      await prisma.purchaseOrderLine.update({ where: { id: receipt.poLineId }, data: { receivedQuantity: "35" } });
      await run.supplierReturns.reverseSupplierReturn(
        dispatched,
        { ...(await run.versions(dispatched)), reason: "Sent back by mistake", idempotencyKey: run.idem("reverse-d") },
        manager,
      );
      order = await prisma.purchaseOrder.findUnique({ where: { id: receipt.poId }, include: { lines: true } });
      assert.equal(String(order.lines[0].receivedQuantity), "50");
      assert.equal(order.status, "fully_received");
    } finally {
      await prisma.$disconnect();
    }
  },
);
