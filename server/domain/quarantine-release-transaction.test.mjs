import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createQuarantineReleaseCommandService,
  QuarantineReleaseCommandError,
} from "./quarantine-release-command-service.mjs";
import { quarantineReleaseDecimalUnits as units } from "./quarantine-release-transaction-policy.mjs";
import { createPrismaClient } from "../persistence/prisma-client.mjs";

const databaseUrl =
  process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
const enabled = Boolean(databaseUrl);
const tenantId = "tenant-quarantine-release-b4";
const otherTenantId = "tenant-quarantine-release-other-b4";
const warehouseId = "warehouse-quarantine-release-b4";
const itemId = "item-quarantine-release-b4";
const managerId = "manager-quarantine-release-b4";
const scopedUserId = "scoped-quarantine-release-b4";
const otherManagerId = "manager-quarantine-release-other-b4";
const sku = "QUAR-REL-B4";
const availableId = "available-quarantine-release-b4";
const quarantineId = "quarantine-release-b4";
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_URL_TEST: databaseUrl,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE: "true",
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

async function seed(prisma) {
  await prisma.tenant.createMany({
    data: [
      { id: tenantId, name: "Quarantine Release B4" },
      { id: otherTenantId, name: "Other Quarantine Release B4" },
    ],
  });
  await prisma.warehouse.create({
    data: {
      id: warehouseId,
      tenantId,
      code: "QUAR-REL-B4",
      name: "Quarantine Release Warehouse",
    },
  });
  for (const user of [
    {
      id: managerId,
      tenantId,
      email: "manager-release-b4@flowchain.invalid",
      name: "Manager",
      role: "manager",
    },
    {
      id: scopedUserId,
      tenantId,
      email: "scoped-release-b4@flowchain.invalid",
      name: "Scoped",
      role: "business-specialist",
    },
    {
      id: otherManagerId,
      tenantId: otherTenantId,
      email: "other-release-b4@flowchain.invalid",
      name: "Other",
      role: "manager",
    },
  ])
    await prisma.user.create({ data: user });
  await prisma.userWarehouseScope.createMany({
    data: [
      {
        id: randomUUID(),
        tenantId,
        userId: managerId,
        warehouseId,
        accessLevel: "operate",
      },
      {
        id: randomUUID(),
        tenantId,
        userId: scopedUserId,
        warehouseId,
        accessLevel: "read",
      },
    ],
  });
  await prisma.item.create({
    data: {
      id: itemId,
      tenantId,
      sku,
      name: "Quarantine Release Item",
      unit: "EA",
    },
  });
  await prisma.inventoryBalance.create({
    data: {
      id: availableId,
      tenantId,
      itemId,
      sku,
      itemName: "Quarantine Release Item",
      warehouseId,
      warehouseKey: warehouseId,
      location: "A-01",
      locationKey: "a-01",
      onHandQuantity: "10",
      reservedQuantity: "2",
      availableQuantity: "8",
      unit: "EA",
      status: "available",
    },
  });
  await prisma.quarantineInventoryBalance.create({
    data: {
      id: quarantineId,
      tenantId,
      itemId,
      sku,
      itemName: "Quarantine Release Item",
      warehouseId,
      warehouseKey: warehouseId,
      location: "A-01",
      locationKey: "a-01",
      onHandQuantity: "8",
      unit: "EA",
    },
  });
}

async function createAuthorization(
  prisma,
  { suffix, quantities = ["2"] },
) {
  const requestId = `request-release-b4-${suffix}`;
  const authorizationId = `authorization-release-b4-${suffix}`;
  await prisma.returnRequest.create({
    data: {
      id: requestId,
      tenantId,
      requestNumber: `RET-REL-B4-${suffix}`,
      returnType: "customer_return",
      partnerId: "customer-release-b4",
      partnerNameSnapshot: "Customer Release B4",
      sourceDocumentType: "ShipmentDocument",
      sourceDocumentId: `shipment-release-b4-${suffix}`,
      sourceDocumentNumber: `SHIP-REL-B4-${suffix}`,
      reasonCode: "quarantine_release",
      workflowStatus: "authorized",
      requestedById: managerId,
      submittedAt: new Date(),
      submittedById: managerId,
      lines: {
        create: quantities.map((quantity, index) => ({
          id: `request-line-release-b4-${suffix}-${index + 1}`,
          sourceDocumentType: "ShipmentDocument",
          sourceDocumentId: `shipment-release-b4-${suffix}`,
          sourceDocumentLineId: `shipment-line-release-b4-${suffix}-${index + 1}`,
          sourceQuantity: "20",
          sourceWarehouseIds: [warehouseId],
          itemId,
          sku,
          itemName: "Quarantine Release Item",
          requestedQuantity: quantity,
          unit: "EA",
          reasonCode: "quarantine_release",
        })),
      },
    },
  });
  // A release takes the return's own received goods (design audit L8-09), so
  // each request has a posted receipt into the quarantine balance: an
  // executed receipt authorization, its posting and one quarantine-in
  // movement per line. The balance's on-hand is seeded separately.
  const receiptAuthorizationId = `receipt-authorization-release-b4-${suffix}`;
  const receiptPostingId = `receipt-posting-release-b4-${suffix}`;
  await prisma.returnAuthorization.create({
    data: {
      id: receiptAuthorizationId,
      tenantId,
      authorizationNumber: `AUTH-RCV-B4-${suffix}`,
      returnRequestId: requestId,
      workflowStatus: "executed",
      authorizedAt: new Date("2026-07-01T00:00:00Z"),
      authorizedById: managerId,
      lines: {
        create: quantities.map((quantity, index) => ({
          id: `receipt-authorization-line-release-b4-${suffix}-${index + 1}`,
          returnRequestLineId: `request-line-release-b4-${suffix}-${index + 1}`,
          authorizedQuantity: quantity,
          dispositionRoute: "receive_to_quarantine",
        })),
      },
    },
  });
  await prisma.returnPostingDocument.create({
    data: {
      id: receiptPostingId,
      tenantId,
      postingNumber: `CRR-REL-B4-${suffix}`,
      returnAuthorizationId: receiptAuthorizationId,
      postingType: "customer_return_receipt",
      workflowStatus: "ready",
      postingStatus: "posted",
      warehouseId,
      readyAt: new Date("2026-07-01T00:00:00Z"),
      readyById: managerId,
      postedAt: new Date("2026-07-01T00:00:00Z"),
      postedById: managerId,
      metadata: { postingBatchId: `receipt-batch-release-b4-${suffix}` },
      lines: {
        create: quantities.map((quantity, index) => ({
          id: `receipt-posting-line-release-b4-${suffix}-${index + 1}`,
          returnAuthorizationLineId: `receipt-authorization-line-release-b4-${suffix}-${index + 1}`,
          itemId,
          sku,
          itemName: "Quarantine Release Item",
          quantity,
          unit: "EA",
          warehouseId,
          location: "A-01",
          locationKey: "a-01",
          quarantineBalanceId: quarantineId,
        })),
      },
    },
  });
  await prisma.inventoryMovement.createMany({
    data: quantities.map((quantity, index) => ({
      id: `receipt-movement-release-b4-${suffix}-${index + 1}`,
      tenantId,
      itemId,
      sku,
      itemName: "Quarantine Release Item",
      warehouseId,
      location: "A-01",
      locationKey: "a-01",
      movementType: "customer_return_quarantine_in",
      occurredAt: new Date("2026-07-01T00:00:00Z"),
      sourceDocument: `CRR-REL-B4-${suffix}`,
      sourceDocumentType: "ReturnPostingDocument",
      sourceDocumentId: receiptPostingId,
      sourceDocumentLineId: `receipt-posting-line-release-b4-${suffix}-${index + 1}`,
      quantityIn: quantity,
      quantityOut: "0",
      adjustmentQty: "0",
      status: "posted",
      unit: "EA",
      relatedReturnId: requestId,
      postingBatchId: `receipt-batch-release-b4-${suffix}`,
      metadata: { balanceType: "quarantine", balanceId: quarantineId },
    })),
  });
  return prisma.returnAuthorization.create({
    data: {
      id: authorizationId,
      tenantId,
      authorizationNumber: `AUTH-REL-B4-${suffix}`,
      returnRequestId: requestId,
      workflowStatus: "approved",
      authorizedAt: new Date(),
      authorizedById: managerId,
      lines: {
        create: quantities.map((quantity, index) => ({
          id: `authorization-line-release-b4-${suffix}-${index + 1}`,
          returnRequestLineId: `request-line-release-b4-${suffix}-${index + 1}`,
          authorizedQuantity: quantity,
          dispositionRoute: "release_quarantine_to_available",
        })),
      },
    },
    include: { lines: true, returnRequest: true },
  });
}

const releaseLines = (authorization, quantities) =>
  authorization.lines.map((line, index) => ({
    returnAuthorizationLineId: line.id,
    quantity: quantities[index],
    quarantineBalanceId: quarantineId,
    destinationInventoryBalanceId: availableId,
  }));

async function versions(prisma, postingId, authorization) {
  const [posting, auth, request] = await Promise.all([
    prisma.returnPostingDocument.findUnique({ where: { id: postingId } }),
    prisma.returnAuthorization.findUnique({
      where: { id: authorization.id },
    }),
    prisma.returnRequest.findUnique({
      where: { id: authorization.returnRequestId },
    }),
  ]);
  return { posting, auth, request };
}

async function createReady(
  service,
  authorization,
  suffix,
  quantities,
) {
  const draft = await service.createDraft(
    {
      authorizationId: authorization.id,
      postingNumber: `POST-REL-B4-${suffix}`,
      expectedAuthorizationVersion: authorization.version,
      lines: releaseLines(authorization, quantities),
      idempotencyKey: `create-release-b4-${suffix}`,
    },
    manager,
  );
  await service.readyPosting(
    draft.entityId,
    {
      expectedPostingVersion: draft.posting.version,
      idempotencyKey: `ready-release-b4-${suffix}`,
    },
    manager,
  );
  return draft;
}

async function post(service, prisma, draft, authorization, suffix) {
  const current = await versions(prisma, draft.entityId, authorization);
  return service.postRelease(
    draft.entityId,
    {
      expectedPostingVersion: current.posting.version,
      expectedAuthorizationVersion: current.auth.version,
      expectedRequestVersion: current.request.version,
      idempotencyKey: `post-release-b4-${suffix}`,
    },
    manager,
  );
}

async function reverse(
  service,
  prisma,
  draft,
  authorization,
  suffix,
) {
  const current = await versions(prisma, draft.entityId, authorization);
  return service.reverseRelease(
    draft.entityId,
    {
      expectedPostingVersion: current.posting.version,
      expectedAuthorizationVersion: current.auth.version,
      expectedRequestVersion: current.request.version,
      reason: "Governed quarantine release reversal",
      idempotencyKey: `reverse-release-b4-${suffix}`,
    },
    manager,
  );
}

test(
  "quarantine release posts paired zero-net movements, aggregates balances, and reverses fail-closed",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient({
      ...env,
      DATABASE_URL: databaseUrl,
    });
    const prismaB = await createPrismaClient({
      ...env,
      DATABASE_URL: databaseUrl,
    });
    const service = createQuarantineReleaseCommandService({ prisma, env });
    const serviceB = createQuarantineReleaseCommandService({
      prisma: prismaB,
      env,
    });
    try {
      await seed(prisma);

      const aggregateAuthorization = await createAuthorization(prisma, {
        suffix: "AGGREGATE",
        quantities: ["1", "3"],
      });
      await assert.rejects(
        service.createDraft(
          {
            authorizationId: aggregateAuthorization.id,
            postingNumber: "POST-REL-B4-MISSING-DESTINATION",
            expectedAuthorizationVersion: 0,
            lines: aggregateAuthorization.lines.map((line) => ({
              returnAuthorizationLineId: line.id,
              quantity: "0.5000",
              quarantineBalanceId: quarantineId,
            })),
            idempotencyKey: "create-release-b4-missing-destination",
          },
          manager,
        ),
        (error) =>
          error instanceof QuarantineReleaseCommandError &&
          error.code === "RETURN_POSTING_BALANCE_SELECTION_INVALID",
      );
      const aggregateDraft = await createReady(
        service,
        aggregateAuthorization,
        "AGGREGATE",
        ["1", "1"],
      );
      const posted = await post(
        service,
        prisma,
        aggregateDraft,
        aggregateAuthorization,
        "AGGREGATE",
      );
      assert.equal(posted.tenantNetQuantity, "0.0000");
      assert.equal(
        posted.returnAuthorization.workflowStatus,
        "partially_executed",
      );
      let [available, quarantine] = await Promise.all([
        prisma.inventoryBalance.findUnique({ where: { id: availableId } }),
        prisma.quarantineInventoryBalance.findUnique({
          where: { id: quarantineId },
        }),
      ]);
      assert.deepEqual(
        {
          onHand: String(available.onHandQuantity),
          reserved: String(available.reservedQuantity),
          available: String(available.availableQuantity),
          version: available.version,
        },
        {
          onHand: "12",
          reserved: "2",
          available: "10",
          version: 1,
        },
      );
      assert.equal(String(quarantine.onHandQuantity), "6");
      assert.equal(quarantine.version, 1);
      const movements = await prisma.inventoryMovement.findMany({
        where: { sourceDocumentId: aggregateDraft.entityId },
        orderBy: [{ sourceDocumentLineId: "asc" }, { movementType: "asc" }],
      });
      assert.equal(movements.length, 4);
      assert.equal(new Set(movements.map((row) => row.postingBatchId)).size, 1);
      assert.equal(
        movements.reduce(
          (sum, row) =>
            sum +
            units(row.quantityIn || 0) -
            units(row.quantityOut || 0),
          0n,
        ),
        0n,
      );
      await reverse(
        service,
        prisma,
        aggregateDraft,
        aggregateAuthorization,
        "AGGREGATE",
      );
      [available, quarantine] = await Promise.all([
        prisma.inventoryBalance.findUnique({ where: { id: availableId } }),
        prisma.quarantineInventoryBalance.findUnique({
          where: { id: quarantineId },
        }),
      ]);
      assert.equal(String(available.onHandQuantity), "10");
      assert.equal(String(available.reservedQuantity), "2");
      assert.equal(String(available.availableQuantity), "8");
      assert.equal(String(quarantine.onHandQuantity), "8");

      const idempotentAuthorization = await createAuthorization(prisma, {
        suffix: "IDEMPOTENT",
        quantities: ["1"],
      });
      const idempotentDraft = await createReady(
        service,
        idempotentAuthorization,
        "IDEMPOTENT",
        ["1"],
      );
      await post(
        service,
        prisma,
        idempotentDraft,
        idempotentAuthorization,
        "IDEMPOTENT",
      );
      const replay = await service.postRelease(
        idempotentDraft.entityId,
        {
          expectedPostingVersion: 1,
          expectedAuthorizationVersion: 0,
          expectedRequestVersion: 0,
          idempotencyKey: "post-release-b4-IDEMPOTENT",
        },
        manager,
      );
      assert.equal(replay.idempotentReplay, true);
      await reverse(
        service,
        prisma,
        idempotentDraft,
        idempotentAuthorization,
        "IDEMPOTENT",
      );

      const consumedAuthorization = await createAuthorization(prisma, {
        suffix: "CONSUMED",
        quantities: ["1"],
      });
      const consumedDraft = await createReady(
        service,
        consumedAuthorization,
        "CONSUMED",
        ["1"],
      );
      await post(
        service,
        prisma,
        consumedDraft,
        consumedAuthorization,
        "CONSUMED",
      );
      await prisma.inventoryBalance.update({
        where: { id: availableId },
        data: {
          onHandQuantity: { decrement: "0.5000" },
          availableQuantity: { decrement: "0.5000" },
          version: { increment: 1 },
        },
      });
      await assert.rejects(
        reverse(
          service,
          prisma,
          consumedDraft,
          consumedAuthorization,
          "CONSUMED-BLOCKED",
        ),
        (error) =>
          error instanceof QuarantineReleaseCommandError &&
          error.code === "RETURN_REVERSAL_NOT_SAFE",
      );
      await prisma.inventoryBalance.update({
        where: { id: availableId },
        data: {
          onHandQuantity: { increment: "0.5000" },
          availableQuantity: { increment: "0.5000" },
        },
      });

      const tamperAuthorization = await createAuthorization(prisma, {
        suffix: "TAMPER",
        quantities: ["1"],
      });
      const tamperDraft = await createReady(
        service,
        tamperAuthorization,
        "TAMPER",
        ["1"],
      );
      await post(
        service,
        prisma,
        tamperDraft,
        tamperAuthorization,
        "TAMPER",
      );
      const tampered = await prisma.inventoryMovement.findFirst({
        where: {
          sourceDocumentId: tamperDraft.entityId,
          movementType: "quarantine_release_out",
        },
      });
      await prisma.inventoryMovement.update({
        where: { id: tampered.id },
        data: {
          metadata: { ...tampered.metadata, balanceId: "tampered" },
        },
      });
      await assert.rejects(
        reverse(
          service,
          prisma,
          tamperDraft,
          tamperAuthorization,
          "TAMPER-BLOCKED",
        ),
        (error) =>
          error instanceof QuarantineReleaseCommandError &&
          error.code === "RETURN_REVERSAL_NOT_SAFE",
      );

      const concurrentAuthorization = await createAuthorization(prisma, {
        suffix: "CONCURRENT",
        quantities: ["2"],
      });
      const concurrentDrafts = [];
      for (const suffix of ["CONCURRENT-1", "CONCURRENT-2"])
        concurrentDrafts.push(
          await createReady(
            service,
            concurrentAuthorization,
            suffix,
            ["2"],
          ),
        );
      const current = await versions(
        prisma,
        concurrentDrafts[0].entityId,
        concurrentAuthorization,
      );
      const concurrent = await Promise.allSettled([
        service.postRelease(
          concurrentDrafts[0].entityId,
          {
            expectedPostingVersion: 1,
            expectedAuthorizationVersion: current.auth.version,
            expectedRequestVersion: current.request.version,
            idempotencyKey: "post-release-b4-CONCURRENT-1",
          },
          manager,
        ),
        serviceB.postRelease(
          concurrentDrafts[1].entityId,
          {
            expectedPostingVersion: 1,
            expectedAuthorizationVersion: current.auth.version,
            expectedRequestVersion: current.request.version,
            idempotencyKey: "post-release-b4-CONCURRENT-2",
          },
          manager,
        ),
      ]);
      assert.equal(
        concurrent.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      assert.equal(
        concurrent.filter((entry) => entry.status === "rejected").length,
        1,
      );

      const scopeAuthorization = await createAuthorization(prisma, {
        suffix: "SCOPE",
        quantities: ["1"],
      });
      await assert.rejects(
        service.createDraft(
          {
            authorizationId: scopeAuthorization.id,
            postingNumber: "POST-REL-B4-SCOPE",
            expectedAuthorizationVersion: 0,
            lines: releaseLines(scopeAuthorization, ["1"]),
            idempotencyKey: "create-release-b4-scope",
          },
          {
            identity: identity(
              scopedUserId,
              "business-specialist",
            ),
          },
        ),
        (error) => error.code === "WAREHOUSE_SCOPE_DENIED",
      );
      await assert.rejects(
        service.createDraft(
          {
            authorizationId: scopeAuthorization.id,
            postingNumber: "POST-REL-B4-CROSS-TENANT",
            expectedAuthorizationVersion: 0,
            lines: releaseLines(scopeAuthorization, ["1"]),
            idempotencyKey: "create-release-b4-cross-tenant",
          },
          {
            identity: identity(
              otherManagerId,
              "manager",
              otherTenantId,
            ),
          },
        ),
        (error) =>
          error instanceof QuarantineReleaseCommandError &&
          error.code === "RETURN_AUTHORIZATION_NOT_FOUND",
      );
    } finally {
      await prismaB.$disconnect();
      await prisma.$disconnect();
    }
  },
);
