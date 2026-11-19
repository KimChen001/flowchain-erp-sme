// End-to-end walk of the customer return state machine on a fresh workspace
// (design audit batch A9). Nothing here inserts a quarantine balance: the
// receipt has to create its own (V-C-01 / L4-09).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createReturnGovernanceCommandService,
  ReturnGovernanceError,
} from "./return-governance-command-service.mjs";
import { createReturnGovernanceReadService } from "./return-governance-read-service.mjs";
import {
  createCustomerReturnCommandService,
  CustomerReturnCommandError,
} from "./customer-return-command-service.mjs";
import { createQuarantineReleaseCommandService } from "./quarantine-release-command-service.mjs";
import { createPrismaClient } from "../persistence/prisma-client.mjs";

const databaseUrl =
  process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
const enabled = Boolean(databaseUrl);
const tenantId = "tenant-return-state-a9";
const warehouseId = "warehouse-return-state-a9";
const itemId = "item-return-state-a9";
const managerId = "manager-return-state-a9";
const sku = "RET-STATE-A9";
const shipmentLineId = "shipment-line-return-state-a9";
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_URL_TEST: databaseUrl,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE: "true",
  FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
  NODE_ENV: "test",
};
const manager = {
  identity: {
    authenticated: true,
    tenantId,
    userId: managerId,
    role: "manager",
    source: "test",
  },
};
const capabilities = {
  "return-request": { enabled: true },
  "return-authorization": { enabled: true },
  "return-posting": { enabled: true },
};

async function seed(prisma) {
  await prisma.tenant.create({ data: { id: tenantId, name: "Return State A9" } });
  await prisma.warehouse.create({
    data: { id: warehouseId, tenantId, code: "RET-A9", name: "Returns A9" },
  });
  await prisma.user.create({
    data: {
      id: managerId,
      tenantId,
      email: "manager-return-state-a9@flowchain.invalid",
      name: "Manager",
      role: "manager",
    },
  });
  await prisma.userWarehouseScope.create({
    data: {
      id: randomUUID(),
      tenantId,
      userId: managerId,
      warehouseId,
      accessLevel: "operate",
    },
  });
  await prisma.item.create({
    data: { id: itemId, tenantId, sku, name: "Return State Item", unit: "EA" },
  });
  await prisma.salesOrder.create({
    data: {
      id: "sales-order-return-state-a9",
      tenantId,
      orderNumber: "SO-RET-A9",
      customerId: "customer-return-state-a9",
      customerName: "Return State Customer",
      workflowStatus: "confirmed",
      fulfillmentStatus: "partially_fulfilled",
      currency: "USD",
      lines: {
        create: {
          id: "sales-line-return-state-a9",
          itemId,
          sku,
          itemName: "Return State Item",
          orderedQuantity: "10",
          fulfilledQuantity: "8",
          unit: "EA",
        },
      },
    },
  });
  await prisma.inventoryReservation.create({
    data: {
      id: "reservation-return-state-a9",
      tenantId,
      salesOrderId: "sales-order-return-state-a9",
      salesOrderLineId: "sales-line-return-state-a9",
      itemId,
      sku,
      warehouseId,
      location: "A-01",
      locationKey: "a-01",
      reservedQuantity: "8",
      consumedQuantity: "8",
      status: "consumed",
      reservedById: managerId,
    },
  });
  await prisma.shipmentDocument.create({
    data: {
      id: "shipment-return-state-a9",
      tenantId,
      shipmentNumber: "SHIP-RET-A9",
      salesOrderId: "sales-order-return-state-a9",
      workflowStatus: "ready",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: managerId,
      lines: {
        create: {
          id: shipmentLineId,
          salesOrderLineId: "sales-line-return-state-a9",
          itemId,
          sku,
          requestedQuantity: "8",
          postedQuantity: "8",
          unit: "EA",
          allocations: {
            create: {
              id: "shipment-allocation-return-state-a9",
              tenantId,
              reservationId: "reservation-return-state-a9",
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
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });

test(
  "a customer return authorized for 5 and received 3 closes its remainder, creates its own quarantine balance and is released",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient({ ...env, DATABASE_URL: databaseUrl });
    let clock = new Date("2026-11-15T12:00:00Z");
    const now = () => new Date(clock);
    const governance = createReturnGovernanceCommandService({ prisma, env, now });
    const read = createReturnGovernanceReadService({ prisma, capabilities, now });
    const receipts = createCustomerReturnCommandService({ prisma, env, now });
    const releases = createQuarantineReleaseCommandService({ prisma, env, now });
    let step = 0;
    const idem = (name) => `a9-${name}-${(step += 1)}`;
    const current = async (requestId) => {
      const request = await prisma.returnRequest.findUnique({
        where: { id: requestId },
        include: {
          authorizations: {
            include: { lines: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      });
      return request;
    };
    const postingVersions = async (postingId) => {
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
    const readyAndPost = async (service, draft, postName) => {
      await service.readyPosting(
        draft.entityId,
        { expectedPostingVersion: draft.posting.version, idempotencyKey: idem("ready") },
        manager,
      );
      return service[postName](
        draft.entityId,
        { ...(await postingVersions(draft.entityId)), idempotencyKey: idem("post") },
        manager,
      );
    };
    try {
      await seed(prisma);

      // Request 5 of the 8 shipped, submit and authorize all 5 for receipt.
      const created = await governance.createRequest(
        {
          requestNumber: "RET-A9-001",
          returnType: "customer_return",
          contextDocumentType: "ShipmentDocument",
          contextDocumentId: "shipment-return-state-a9",
          reasonCode: "damaged",
          lines: [{ sourceDocumentLineId: shipmentLineId, requestedQuantity: "5" }],
          idempotencyKey: idem("create"),
        },
        manager,
      );
      const requestId = created.entityId;
      await governance.submitRequest(
        requestId,
        { expectedVersion: 0, idempotencyKey: idem("submit") },
        manager,
      );
      let request = await current(requestId);
      const requestLineId = (
        await prisma.returnRequestLine.findFirst({ where: { returnRequestId: requestId } })
      ).id;
      const receiptAuthorization = await governance.authorizeRequest(
        requestId,
        {
          expectedRequestVersion: request.version,
          authorizationNumber: "AUTH-A9-RECEIPT",
          idempotencyKey: idem("authorize"),
          lines: [
            {
              returnRequestLineId: requestLineId,
              authorizedQuantity: "5",
              dispositionRoute: "receive_to_quarantine",
            },
          ],
        },
        manager,
      );
      // No expiry was given, so the authorization does not expire.
      assert.equal(receiptAuthorization.authorization.expiresAt, null);
      const receiptAuthorizationId = receiptAuthorization.entityId;
      const receiptLineId = (
        await prisma.returnAuthorizationLine.findFirst({
          where: { returnAuthorizationId: receiptAuthorizationId },
        })
      ).id;

      // Nothing in the workspace created a quarantine balance.
      assert.equal(
        await prisma.quarantineInventoryBalance.count({ where: { tenantId } }),
        0,
      );

      // The customer sends back 3. The receipt names the warehouse and a
      // location, and its draft creates the quarantine stock record.
      const receiptDraft = await receipts.createDraft(
        {
          authorizationId: receiptAuthorizationId,
          postingNumber: "CRR-A9-001",
          expectedAuthorizationVersion: 0,
          lines: [
            {
              returnAuthorizationLineId: receiptLineId,
              quantity: "3",
              warehouseId,
              location: "RET-Q",
            },
          ],
          idempotencyKey: idem("receipt-draft"),
        },
        manager,
      );
      const quarantine = await prisma.quarantineInventoryBalance.findFirst({
        where: { tenantId },
      });
      assert.ok(quarantine, "the receipt created a quarantine balance");
      assert.equal(quarantine.warehouseId, warehouseId);
      assert.equal(quarantine.warehouseKey, warehouseId);
      assert.equal(quarantine.locationKey, "ret-q");
      assert.equal(quarantine.itemId, itemId);
      assert.equal(String(quarantine.onHandQuantity), "0");
      await readyAndPost(receipts, receiptDraft, "postReceipt");
      assert.equal(
        String(
          (await prisma.quarantineInventoryBalance.findUnique({ where: { id: quarantine.id } }))
            .onHandQuantity,
        ),
        "3",
      );
      request = await current(requestId);
      assert.equal(request.workflowStatus, "partially_executed");
      assert.equal(request.authorizations[0].workflowStatus, "partially_executed");

      // Before the fix nothing could move from here: no release while the
      // request is partly executed, and the authorization cannot be cancelled.
      await rejectsWith(
        governance.authorizeRequest(
          requestId,
          {
            expectedRequestVersion: request.version,
            authorizationNumber: "AUTH-A9-RELEASE-EARLY",
            idempotencyKey: idem("release-early"),
            lines: [
              {
                returnRequestLineId: requestLineId,
                authorizedQuantity: "3",
                dispositionRoute: "release_quarantine_to_available",
              },
            ],
          },
          manager,
        ),
        "RETURN_REQUEST_NOT_SUBMITTED",
      );
      await rejectsWith(
        governance.cancelAuthorization(
          receiptAuthorizationId,
          {
            expectedAuthorizationVersion: request.authorizations[0].version,
            expectedRequestVersion: request.version,
            reason: "Customer kept two",
            idempotencyKey: idem("cancel-partial"),
          },
          manager,
        ),
        "RETURN_AUTHORIZATION_CANNOT_CLOSE",
      );

      // An open draft blocks the close until it is cancelled (V-C-06 path).
      const strayDraft = await receipts.createDraft(
        {
          authorizationId: receiptAuthorizationId,
          postingNumber: "CRR-A9-002",
          expectedAuthorizationVersion: request.authorizations[0].version,
          lines: [
            {
              returnAuthorizationLineId: receiptLineId,
              quantity: "1",
              quarantineBalanceId: quarantine.id,
            },
          ],
          idempotencyKey: idem("stray-draft"),
        },
        manager,
      );
      const closeInput = async (name) => {
        const fresh = await current(requestId);
        return {
          expectedAuthorizationVersion: fresh.authorizations[0].version,
          expectedRequestVersion: fresh.version,
          reason: "The customer kept the other two",
          idempotencyKey: idem(name),
        };
      };
      await rejectsWith(
        governance.closeAuthorizationRemainder(
          receiptAuthorizationId,
          await closeInput("close-blocked"),
          manager,
        ),
        "RETURN_AUTHORIZATION_OPEN_POSTINGS",
      );
      await receipts.cancelPosting(
        strayDraft.entityId,
        {
          expectedPostingVersion: strayDraft.posting.version,
          reason: "Entered twice",
          idempotencyKey: idem("cancel-stray"),
        },
        manager,
      );

      // Close remaining: 2 closed, authorization and request executed.
      const closed = await governance.closeAuthorizationRemainder(
        receiptAuthorizationId,
        await closeInput("close-remainder"),
        manager,
      );
      assert.equal(closed.authorization.workflowStatus, "executed");
      assert.equal(closed.request.workflowStatus, "executed");
      request = await current(requestId);
      assert.equal(String(request.authorizations[0].lines[0].closedQuantity), "2");
      assert.ok(request.authorizations[0].remainderClosedAt);
      assert.equal(request.authorizations[0].remainderReason, "The customer kept the other two");
      const workbench = await read.authorizationWorkbench(receiptAuthorizationId, manager);
      assert.equal(workbench.authorization.lines[0].postedQuantity, "3.0000");
      assert.equal(workbench.authorization.lines[0].closedQuantity, "2.0000");

      // Nothing more can be received against the closed authorization.
      await rejectsWith(
        receipts.createDraft(
          {
            authorizationId: receiptAuthorizationId,
            postingNumber: "CRR-A9-003",
            expectedAuthorizationVersion: request.authorizations[0].version,
            lines: [
              {
                returnAuthorizationLineId: receiptLineId,
                quantity: "1",
                quarantineBalanceId: quarantine.id,
              },
            ],
            idempotencyKey: idem("receipt-after-close"),
          },
          manager,
        ),
        "RETURN_AUTHORIZATION_INVALID_STATE",
      );

      // The 3 received can now be released, to another location of the same
      // warehouse, with no available stock record there yet (L8-14).
      const releaseAuthorization = await governance.authorizeRequest(
        requestId,
        {
          expectedRequestVersion: request.version,
          authorizationNumber: "AUTH-A9-RELEASE",
          idempotencyKey: idem("release-authorize"),
          lines: [
            {
              returnRequestLineId: requestLineId,
              authorizedQuantity: "3",
              dispositionRoute: "release_quarantine_to_available",
            },
          ],
        },
        manager,
      );
      const releaseAuthorizationId = releaseAuthorization.entityId;
      const releaseLineId = (
        await prisma.returnAuthorizationLine.findFirst({
          where: { returnAuthorizationId: releaseAuthorizationId },
        })
      ).id;
      assert.equal(
        await prisma.inventoryBalance.count({ where: { tenantId, sku } }),
        0,
      );
      const releaseDraft = await releases.createDraft(
        {
          authorizationId: releaseAuthorizationId,
          postingNumber: "QR-A9-001",
          expectedAuthorizationVersion: 0,
          lines: [
            {
              returnAuthorizationLineId: releaseLineId,
              quantity: "3",
              quarantineBalanceId: quarantine.id,
              destinationLocation: "A-02",
            },
          ],
          idempotencyKey: idem("release-draft"),
        },
        manager,
      );
      const destination = await prisma.inventoryBalance.findFirst({
        where: { tenantId, sku },
      });
      assert.ok(destination, "the release created the available stock record");
      assert.equal(destination.locationKey, "a-02");
      const releasePostingLine = await prisma.returnPostingLine.findFirst({
        where: { returnPostingId: releaseDraft.entityId },
      });
      assert.equal(releasePostingLine.locationKey, "ret-q");
      assert.equal(releasePostingLine.destinationLocationKey, "a-02");
      await readyAndPost(releases, releaseDraft, "postRelease");
      let available = await prisma.inventoryBalance.findUnique({ where: { id: destination.id } });
      assert.equal(String(available.onHandQuantity), "3");
      assert.equal(String(available.availableQuantity), "3");
      assert.equal(
        String(
          (await prisma.quarantineInventoryBalance.findUnique({ where: { id: quarantine.id } }))
            .onHandQuantity,
        ),
        "0",
      );
      const inbound = await prisma.inventoryMovement.findFirst({
        where: {
          tenantId,
          sourceDocumentId: releaseDraft.entityId,
          movementType: "quarantine_release_available_in",
        },
      });
      assert.equal(inbound.locationKey, "a-02");
      request = await current(requestId);
      assert.equal(request.workflowStatus, "executed");
      assert.equal(request.authorizations[1].workflowStatus, "executed");

      // The release reverses at its own destination location.
      await releases.reverseRelease(
        releaseDraft.entityId,
        {
          ...(await postingVersions(releaseDraft.entityId)),
          reason: "Released by mistake",
          idempotencyKey: idem("reverse-release"),
        },
        manager,
      );
      available = await prisma.inventoryBalance.findUnique({ where: { id: destination.id } });
      assert.equal(String(available.onHandQuantity), "0");

      // L8-27: reversing the receipt while the release authorization is open
      // says what to do instead of reporting a concurrency conflict.
      await rejectsWith(
        receipts.reverseReceipt(
          receiptDraft.entityId,
          {
            ...(await postingVersions(receiptDraft.entityId)),
            reason: "Wrong customer",
            idempotencyKey: idem("reverse-receipt-blocked"),
          },
          manager,
        ),
        "RETURN_REVERSAL_BLOCKED_BY_ACTIVE_AUTHORIZATION",
      );

      // L8-04 / L8-06: the release authorization has a reversed posting only,
      // so it can be cancelled; the request stays executed because its 3
      // units are still in quarantine, not back to submitted.
      request = await current(requestId);
      const cancelledRelease = await governance.cancelAuthorization(
        releaseAuthorizationId,
        {
          expectedAuthorizationVersion: request.authorizations[1].version,
          expectedRequestVersion: request.version,
          reason: "Will return these to the supplier",
          idempotencyKey: idem("cancel-release"),
        },
        manager,
      );
      assert.equal(cancelledRelease.authorization.workflowStatus, "cancelled");
      assert.equal(cancelledRelease.request.workflowStatus, "executed");
      await assert.rejects(
        governance.cancelRequest(
          requestId,
          {
            expectedVersion: cancelledRelease.request.version,
            reason: "Not needed",
            idempotencyKey: idem("cancel-request-executed"),
          },
          manager,
        ),
        (error) =>
          error instanceof ReturnGovernanceError &&
          error.code === "RETURN_REQUEST_CANNOT_CANCEL",
      );

      // Reversing the receipt now reopens only what was posted (5 - 2 closed).
      const reversedReceipt = await receipts.reverseReceipt(
        receiptDraft.entityId,
        {
          ...(await postingVersions(receiptDraft.entityId)),
          reason: "Wrong customer",
          idempotencyKey: idem("reverse-receipt"),
        },
        manager,
      );
      assert.equal(reversedReceipt.returnAuthorization.workflowStatus, "approved");
      // The reversed receipt and the cancelled draft no longer block a cancel.
      request = await current(requestId);
      const cancelledReceipt = await governance.cancelAuthorization(
        receiptAuthorizationId,
        {
          expectedAuthorizationVersion: request.authorizations[0].version,
          expectedRequestVersion: request.version,
          reason: "Customer will send a new request",
          idempotencyKey: idem("cancel-receipt-auth"),
        },
        manager,
      );
      assert.equal(cancelledReceipt.request.workflowStatus, "submitted");

      // L8-06: an expiry date is optional; once it passes the authorization
      // can be expired and the request goes back to submitted.
      const expiring = await governance.authorizeRequest(
        requestId,
        {
          expectedRequestVersion: cancelledReceipt.request.version,
          authorizationNumber: "AUTH-A9-EXPIRING",
          expiresAt: new Date(clock.getTime() + 86_400_000).toISOString(),
          idempotencyKey: idem("authorize-expiring"),
          lines: [
            {
              returnRequestLineId: requestLineId,
              authorizedQuantity: "5",
              dispositionRoute: "receive_to_quarantine",
            },
          ],
        },
        manager,
      );
      clock = new Date(clock.getTime() + 2 * 86_400_000);
      const expired = await governance.expireAuthorization(
        expiring.entityId,
        {
          expectedAuthorizationVersion: 0,
          expectedRequestVersion: expiring.request.version,
          idempotencyKey: idem("expire"),
        },
        manager,
      );
      assert.equal(expired.authorization.workflowStatus, "expired");
      assert.equal(expired.request.workflowStatus, "submitted");
    } finally {
      await prisma.$disconnect();
    }
  },
);

test(
  "a new quarantine stock record is refused for an inactive warehouse",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient({ ...env, DATABASE_URL: databaseUrl });
    const receipts = createCustomerReturnCommandService({ prisma, env });
    try {
      const authorization = await prisma.returnAuthorization.findFirst({
        where: { tenantId, authorizationNumber: "AUTH-A9-RECEIPT" },
        include: { lines: true },
      });
      assert.ok(authorization, "runs after the walk above");
      // Reopen a fresh authorization on a fresh request for this check.
      const request = await prisma.returnRequest.findFirst({ where: { tenantId } });
      await prisma.warehouse.create({
        data: {
          id: "warehouse-return-state-a9-closed",
          tenantId,
          code: "RET-A9-X",
          name: "Closed warehouse",
          status: "inactive",
        },
      });
      const authorizationId = "authorization-return-state-a9-inactive";
      await prisma.returnAuthorization.create({
        data: {
          id: authorizationId,
          tenantId,
          authorizationNumber: "AUTH-A9-INACTIVE",
          returnRequestId: request.id,
          workflowStatus: "approved",
          authorizedAt: new Date(),
          authorizedById: managerId,
          lines: {
            create: {
              id: "authorization-line-return-state-a9-inactive",
              returnRequestLineId: authorization.lines[0].returnRequestLineId,
              authorizedQuantity: "1",
              dispositionRoute: "receive_to_quarantine",
            },
          },
        },
      });
      await assert.rejects(
        receipts.createDraft(
          {
            authorizationId,
            postingNumber: "CRR-A9-INACTIVE",
            expectedAuthorizationVersion: 0,
            lines: [
              {
                returnAuthorizationLineId: "authorization-line-return-state-a9-inactive",
                quantity: "1",
                warehouseId: "warehouse-return-state-a9-closed",
              },
            ],
            idempotencyKey: "a9-inactive-warehouse",
          },
          manager,
        ),
        (error) =>
          error instanceof CustomerReturnCommandError &&
          error.code === "RETURN_POSTING_BALANCE_CREATE_BLOCKED",
      );
      assert.equal(
        await prisma.quarantineInventoryBalance.count({
          where: { tenantId, warehouseId: "warehouse-return-state-a9-closed" },
        }),
        0,
      );
    } finally {
      await prisma.$disconnect();
    }
  },
);
