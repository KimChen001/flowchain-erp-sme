import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createPrismaClient } from "../persistence/prisma-client.mjs";
import { realPostgresSuiteGate } from "../persistence/test-db-harness.mjs";
import { createInventoryOperationsCommandService } from "./inventory-operations-command-service.mjs";
import { createInventoryOperationsReadService } from "./inventory-operations-read-service.mjs";
import {
  buildInventoryAdjustmentPostingPlan,
  buildStockTransferPostingPlan,
  inventoryOperationDecimalUnits as units,
} from "./inventory-operations-policy.mjs";

const gate = realPostgresSuiteGate("npm run test:db:inventory-operations");
const realPostgres = gate.enabled;
const env = {
  ...process.env,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "true",
};
let prisma;
if (!realPostgres) {
  // Must report SKIP, not a pass. See the same guard in
  // outbound-posting-transaction.test.mjs.
  if (gate.failure) {
    test("inventory operations PostgreSQL transaction suite is misconfigured", () => {
      throw new Error(gate.failure);
    });
  } else {
    test("inventory operations PostgreSQL transactions run in the isolated test:db:inventory-operations gate", { skip: gate.skipReason }, () => {});
  }
} else {
  before(async () => {
    prisma = await createPrismaClient(env);
  });
  after(async () => {
    await prisma?.$disconnect();
  });

  const identity = (tenantId, userId, role = "manager") => ({
    identity: {
      authenticated: true,
      tenantId,
      userId,
      role,
      source: "signed-session",
    },
  });
  const capabilities = {
    "stock-transfer": { enabled: true },
    "cycle-count": { enabled: true },
    "inventory-adjustment-document": { enabled: true },
  };

  async function seed() {
    const suffix = randomUUID(),
      tenantId = `tenant-${suffix}`,
      managerId = `manager-${suffix}`,
      specialistId = `specialist-${suffix}`,
      viewerId = `viewer-${suffix}`;
    const warehouseA = `warehouse-a-${suffix}`,
      warehouseB = `warehouse-b-${suffix}`,
      itemId = `item-${suffix}`,
      balanceA = `balance-a-${suffix}`,
      balanceB = `balance-b-${suffix}`;
    await prisma.tenant.create({
      data: { id: tenantId, name: "Inventory Operations Test" },
    });
    await prisma.user.createMany({
      data: [
        {
          id: managerId,
          tenantId,
          email: `${managerId}@example.com`,
          name: "Manager",
          role: "manager",
        },
        {
          id: specialistId,
          tenantId,
          email: `${specialistId}@example.com`,
          name: "Specialist",
          role: "business-specialist",
        },
        {
          id: viewerId,
          tenantId,
          email: `${viewerId}@example.com`,
          name: "Viewer",
          role: "viewer",
        },
      ],
    });
    await prisma.warehouse.createMany({
      data: [
        {
          id: warehouseA,
          tenantId,
          code: `A-${suffix}`,
          name: "Warehouse A",
          status: "active",
        },
        {
          id: warehouseB,
          tenantId,
          code: `B-${suffix}`,
          name: "Warehouse B",
          status: "active",
        },
      ],
    });
    await prisma.userWarehouseScope.createMany({
      data: [
        ...[managerId, specialistId].flatMap((userId) =>
          [warehouseA, warehouseB].map((warehouseId) => ({
            id: randomUUID(),
            tenantId,
            userId,
            warehouseId,
            accessLevel: "operate",
          })),
        ),
        {
          id: randomUUID(),
          tenantId,
          userId: viewerId,
          warehouseId: warehouseA,
          accessLevel: "read",
        },
      ],
    });
    await prisma.item.create({
      data: {
        id: itemId,
        tenantId,
        sku: `SKU-${suffix}`,
        name: "Inventory Test Item",
        unit: "EA",
        status: "active",
      },
    });
    await prisma.inventoryBalance.createMany({
      data: [
        {
          id: balanceA,
          tenantId,
          itemId,
          sku: `SKU-${suffix}`,
          itemName: "Inventory Test Item",
          warehouseId: warehouseA,
          warehouseKey: warehouseA,
          location: "A-01",
          locationKey: "a-01",
          onHandQuantity: "10",
          reservedQuantity: "2",
          availableQuantity: "8",
          unit: "EA",
          status: "available",
        },
        {
          id: balanceB,
          tenantId,
          itemId,
          sku: `SKU-${suffix}`,
          itemName: "Inventory Test Item",
          warehouseId: warehouseB,
          warehouseKey: warehouseB,
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
    return {
      tenantId,
      managerId,
      specialistId,
      viewerId,
      warehouseA,
      warehouseB,
      itemId,
      balanceA,
      balanceB,
      sku: `SKU-${suffix}`,
    };
  }

  test("stock transfer posts two balanced movements, replays once, and reverses safely", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env }),
      ctx = identity(ids.tenantId, ids.managerId);
    const created = await service.createTransfer(
      {
        transferNumber: `TR-${randomUUID()}`,
        idempotencyKey: "transfer-create",
        lines: [
          {
            itemId: ids.itemId,
            quantity: "3",
            source: { warehouseId: ids.warehouseA, location: "A-01" },
            destination: { warehouseId: ids.warehouseB, location: "B-01" },
          },
        ],
      },
      ctx,
    );
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { tenantId: ids.tenantId },
      }),
      0,
    );
    const ready = await service.readyTransfer(
      created.transfer.id,
      { expectedTransferVersion: 0, idempotencyKey: "transfer-ready" },
      ctx,
    );
    const posted = await service.postTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: ready.transfer.version,
        idempotencyKey: "transfer-post",
      },
      ctx,
    );
    assert.equal(posted.movementIds.length, 2);
    assert.equal(
      (
        await service.postTransfer(
          created.transfer.id,
          {
            expectedTransferVersion: ready.transfer.version,
            idempotencyKey: "transfer-post",
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    const [a, b] = await Promise.all([
      prisma.inventoryBalance.findUnique({ where: { id: ids.balanceA } }),
      prisma.inventoryBalance.findUnique({ where: { id: ids.balanceB } }),
    ]);
    assert.deepEqual(
      [
        a.onHandQuantity.toString(),
        a.reservedQuantity.toString(),
        a.availableQuantity.toString(),
      ],
      ["7", "2", "5"],
    );
    assert.deepEqual(
      [
        b.onHandQuantity.toString(),
        b.reservedQuantity.toString(),
        b.availableQuantity.toString(),
      ],
      ["8", "0", "8"],
    );
    const movements = await prisma.inventoryMovement.findMany({
      where: { tenantId: ids.tenantId, sourceDocumentId: created.transfer.id },
    });
    assert.deepEqual(
      new Set(movements.map((row) => row.postingBatchId)),
      new Set([posted.postingBatchId]),
    );
    const reversed = await service.reverseTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: posted.transfer.version,
        idempotencyKey: "transfer-reverse",
        reason: "Test correction",
      },
      ctx,
    );
    assert.equal(reversed.movementIds.length, 2);
    const [restoredA, restoredB] = await Promise.all([
      prisma.inventoryBalance.findUnique({ where: { id: ids.balanceA } }),
      prisma.inventoryBalance.findUnique({ where: { id: ids.balanceB } }),
    ]);
    assert.deepEqual(
      [
        restoredA.onHandQuantity.toString(),
        restoredA.reservedQuantity.toString(),
        restoredA.availableQuantity.toString(),
      ],
      ["10", "2", "8"],
    );
    assert.deepEqual(
      [
        restoredB.onHandQuantity.toString(),
        restoredB.availableQuantity.toString(),
      ],
      ["5", "5"],
    );
    await assert.rejects(
      () =>
        service.reverseTransfer(
          created.transfer.id,
          {
            expectedTransferVersion: reversed.transfer.version,
            idempotencyKey: "transfer-reverse-again",
            reason: "Again",
          },
          ctx,
        ),
      (error) => error.code === "TRANSFER_ALREADY_REVERSED",
    );
    const workbench = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).transferWorkbench(created.transfer.id, ctx);
    assert.equal(workbench.reconciliation.status, "matched");
    assert.equal(workbench.movements.length, 4);
  });

  test("transfer posting aggregates repeated balances and uses the same cumulative preview plan", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env }),
      ctx = identity(ids.tenantId, ids.managerId);
    const created = await service.createTransfer(
      {
        transferNumber: `TR-AGG-${randomUUID()}`,
        idempotencyKey: "transfer-aggregate-create",
        lines: ["3", "4"].map((quantity) => ({
          itemId: ids.itemId,
          quantity,
          source: { warehouseId: ids.warehouseA, location: "A-01" },
          destination: { warehouseId: ids.warehouseB, location: "B-01" },
        })),
      },
      ctx,
    );
    const ready = await service.readyTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: created.transfer.version,
        idempotencyKey: "transfer-aggregate-ready",
      },
      ctx,
    );
    const preview = await buildStockTransferPostingPlan({
      prisma,
      tenantId: ids.tenantId,
      transferId: created.transfer.id,
    });
    assert.equal(preview.allowed, true);
    assert.equal(preview.balanceImpacts.length, 2);
    assert.equal(
      preview.balanceImpacts.find((row) => row.balanceId === ids.balanceA)
        .totalOut,
      "7.0000",
    );
    const before = await prisma.inventoryBalance.findMany({
      where: { id: { in: [ids.balanceA, ids.balanceB] } },
      orderBy: { id: "asc" },
    });
    const posted = await service.postTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: ready.transfer.version,
        idempotencyKey: "transfer-aggregate-post",
      },
      ctx,
    );
    assert.equal(posted.movementIds.length, 4);
    const after = await prisma.inventoryBalance.findMany({
      where: { id: { in: [ids.balanceA, ids.balanceB] } },
      orderBy: { id: "asc" },
    });
    assert.deepEqual(
      after.map((row, index) => row.version - before[index].version),
      [1, 1],
    );
    assert.deepEqual(
      after.map((row) => row.onHandQuantity.toString()),
      ["3", "12"],
    );
    const workbench = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).transferWorkbench(created.transfer.id, ctx);
    assert.equal(workbench.reconciliation.status, "matched");
    const reversed = await service.reverseTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: posted.transfer.version,
        idempotencyKey: "transfer-aggregate-reverse",
        reason: "Aggregate reversal",
      },
      ctx,
    );
    assert.equal(reversed.movementIds.length, 4);
    const restored = await prisma.inventoryBalance.findMany({
      where: { id: { in: [ids.balanceA, ids.balanceB] } },
      orderBy: { id: "asc" },
    });
    assert.deepEqual(
      restored.map((row) => row.onHandQuantity.toString()),
      ["10", "5"],
    );

    const insufficient = await service.createTransfer(
      {
        transferNumber: `TR-AGG-FAIL-${randomUUID()}`,
        idempotencyKey: "transfer-aggregate-fail-create",
        lines: ["5", "4"].map((quantity) => ({
          itemId: ids.itemId,
          quantity,
          source: { warehouseId: ids.warehouseA, location: "A-01" },
          destination: { warehouseId: ids.warehouseB, location: "B-01" },
        })),
      },
      ctx,
    );
    const insufficientReady = await service.readyTransfer(
      insufficient.transfer.id,
      {
        expectedTransferVersion: insufficient.transfer.version,
        idempotencyKey: "transfer-aggregate-fail-ready",
      },
      ctx,
    );
    const deniedPreview = await buildStockTransferPostingPlan({
      prisma,
      tenantId: ids.tenantId,
      transferId: insufficient.transfer.id,
    });
    assert.equal(deniedPreview.allowed, false);
    assert.equal(
      deniedPreview.blockingIssues[0].code,
      "TRANSFER_INSUFFICIENT_AVAILABLE",
    );
    await assert.rejects(
      () =>
        service.postTransfer(
          insufficient.transfer.id,
          {
            expectedTransferVersion: insufficientReady.transfer.version,
            idempotencyKey: "transfer-aggregate-fail-post",
          },
          ctx,
        ),
      (error) => error.code === "TRANSFER_INSUFFICIENT_AVAILABLE",
    );
  });

  test("transfer aggregation handles balances used by multiple source and destination legs deterministically", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env }),
      ctx = identity(ids.tenantId, ids.managerId);
    const created = await service.createTransfer(
      {
        transferNumber: `TR-NET-${randomUUID()}`,
        idempotencyKey: "transfer-net-create",
        lines: [
          {
            itemId: ids.itemId,
            quantity: "3",
            source: { warehouseId: ids.warehouseA, location: "A-01" },
            destination: { warehouseId: ids.warehouseB, location: "B-01" },
          },
          {
            itemId: ids.itemId,
            quantity: "1",
            source: { warehouseId: ids.warehouseB, location: "B-01" },
            destination: { warehouseId: ids.warehouseA, location: "A-01" },
          },
        ],
      },
      ctx,
    );
    const ready = await service.readyTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: created.transfer.version,
        idempotencyKey: "transfer-net-ready",
      },
      ctx,
    );
    const preview = await buildStockTransferPostingPlan({
      prisma,
      tenantId: ids.tenantId,
      transferId: created.transfer.id,
    });
    assert.equal(preview.balanceImpacts.length, 2);
    assert.equal(
      preview.balanceImpacts.find((row) => row.balanceId === ids.balanceA)
        .quantity,
      "-2.0000",
    );
    assert.equal(
      preview.balanceImpacts.find((row) => row.balanceId === ids.balanceB)
        .quantity,
      "2.0000",
    );
    await service.postTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: ready.transfer.version,
        idempotencyKey: "transfer-net-post",
      },
      ctx,
    );
    const workbench = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).transferWorkbench(created.transfer.id, ctx);
    assert.equal(workbench.reconciliation.status, "matched");
  });

  test("transfer reversal fails closed when any original movement fact is corrupted", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env }),
      ctx = identity(ids.tenantId, ids.managerId);
    const created = await service.createTransfer(
      {
        transferNumber: `TR-INTEGRITY-${randomUUID()}`,
        idempotencyKey: "transfer-integrity-create",
        lines: [
          {
            itemId: ids.itemId,
            quantity: "3",
            source: { warehouseId: ids.warehouseA, location: "A-01" },
            destination: { warehouseId: ids.warehouseB, location: "B-01" },
          },
        ],
      },
      ctx,
    );
    const ready = await service.readyTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: created.transfer.version,
        idempotencyKey: "transfer-integrity-ready",
      },
      ctx,
    );
    const posted = await service.postTransfer(
      created.transfer.id,
      {
        expectedTransferVersion: ready.transfer.version,
        idempotencyKey: "transfer-integrity-post",
      },
      ctx,
    );
    const original = await prisma.inventoryMovement.findFirst({
      where: {
        sourceDocumentId: created.transfer.id,
        movementType: "stock_transfer_out",
      },
    });
    const corruptions = [
      { quantityOut: "4" },
      { movementType: "inventory_adjustment" },
      { warehouseId: ids.warehouseB },
      { metadata: { balanceId: ids.balanceB } },
      { postingBatchId: randomUUID() },
    ];
    for (const [index, data] of corruptions.entries()) {
      await prisma.inventoryMovement.update({
        where: { id: original.id },
        data,
      });
      const corruptedWorkbench = await createInventoryOperationsReadService({
        prisma,
        capabilities,
      }).transferWorkbench(created.transfer.id, ctx);
      assert.equal(corruptedWorkbench.reconciliation.status, "mismatch");
      await assert.rejects(
        () =>
          service.reverseTransfer(
            created.transfer.id,
            {
              expectedTransferVersion: posted.transfer.version,
              idempotencyKey: `transfer-integrity-reverse-${index}`,
              reason: "Integrity test",
            },
            ctx,
          ),
        (error) =>
          error.code === "TRANSFER_REVERSAL_NOT_SAFE" && error.status === 409,
      );
      assert.equal(
        await prisma.inventoryMovement.count({
          where: {
            sourceDocumentId: created.transfer.id,
            reversalOfMovementId: { not: null },
          },
        }),
        0,
      );
      await prisma.inventoryMovement.update({
        where: { id: original.id },
        data: {
          quantityOut: original.quantityOut,
          movementType: original.movementType,
          warehouseId: original.warehouseId,
          metadata: original.metadata,
          postingBatchId: original.postingBatchId,
        },
      });
    }
  });

  test("blind cycle count protects snapshot, requires review, and posts fixed-scale variance", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env });
    const specialist = identity(
        ids.tenantId,
        ids.specialistId,
        "business-specialist",
      ),
      manager = identity(ids.tenantId, ids.managerId);
    const created = await service.createCount(
      {
        countNumber: `CC-${randomUUID()}`,
        warehouseId: ids.warehouseA,
        blindCount: true,
        balanceIds: [ids.balanceA],
        idempotencyKey: "count-create",
      },
      specialist,
    );
    const blind = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).countWorkbench(created.session.id, specialist);
    assert.equal(blind.lines[0].recordedOnHandQuantity, null);
    const managerDraft = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).countWorkbench(created.session.id, manager);
    assert.equal(managerDraft.lines[0].recordedOnHandQuantity, null);
    const entered = await service.reviseCount(
      created.session.id,
      {
        expectedSessionVersion: 0,
        idempotencyKey: "count-enter",
        counts: [
          {
            countLineId: created.session.lines[0].id,
            countedQuantity: "11",
            expectedLineVersion: 0,
          },
        ],
      },
      specialist,
    );
    const submitted = await service.submitCount(
      created.session.id,
      {
        expectedSessionVersion: entered.session.version,
        idempotencyKey: "count-submit",
      },
      specialist,
    );
    const specialistSubmitted = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).countWorkbench(created.session.id, specialist);
    assert.equal(specialistSubmitted.lines[0].recordedOnHandQuantity, null);
    const managerSubmitted = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).countWorkbench(created.session.id, manager);
    assert.equal(managerSubmitted.lines[0].recordedOnHandQuantity, "10.0000");
    await assert.rejects(
      () =>
        service.postCount(
          created.session.id,
          {
            expectedSessionVersion: submitted.session.version,
            idempotencyKey: "count-specialist-post",
          },
          specialist,
        ),
      (error) => error.code === "AUTHORIZATION_PERMISSION_DENIED",
    );
    const reviewed = await service.reviewCount(
      created.session.id,
      {
        expectedSessionVersion: submitted.session.version,
        idempotencyKey: "count-review",
      },
      manager,
    );
    const [snapshotLine, currentBalance] = await Promise.all([
      prisma.cycleCountLine.findUnique({
        where: { id: created.session.lines[0].id },
      }),
      prisma.inventoryBalance.findUnique({ where: { id: ids.balanceA } }),
    ]);
    assert.deepEqual(
      [
        currentBalance.version,
        currentBalance.onHandQuantity.toString(),
        currentBalance.reservedQuantity.toString(),
        currentBalance.availableQuantity.toString(),
      ],
      [
        snapshotLine.recordedBalanceVersion,
        snapshotLine.recordedOnHandQuantity.toString(),
        snapshotLine.recordedReservedQuantity.toString(),
        snapshotLine.recordedAvailableQuantity.toString(),
      ],
    );
    const posted = await service.postCount(
      created.session.id,
      {
        expectedSessionVersion: reviewed.session.version,
        idempotencyKey: "count-post",
      },
      manager,
    );
    assert.equal(posted.movementIds.length, 1);
    const balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceA },
    });
    assert.deepEqual(
      [
        balance.onHandQuantity.toString(),
        balance.reservedQuantity.toString(),
        balance.availableQuantity.toString(),
      ],
      ["11", "2", "9"],
    );
    const workbench = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).countWorkbench(created.session.id, manager);
    assert.equal(workbench.reconciliation.status, "matched");
    assert.equal(workbench.lines[0].varianceQuantity, "1.0000");
  });

  test("cycle count fails closed when balance changes after snapshot", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env }),
      ctx = identity(ids.tenantId, ids.managerId);
    const created = await service.createCount(
      {
        countNumber: `CC-STALE-${randomUUID()}`,
        warehouseId: ids.warehouseA,
        blindCount: false,
        balanceIds: [ids.balanceA],
        idempotencyKey: "stale-count-create",
      },
      ctx,
    );
    const entered = await service.reviseCount(
      created.session.id,
      {
        expectedSessionVersion: 0,
        idempotencyKey: "stale-count-enter",
        counts: [
          {
            countLineId: created.session.lines[0].id,
            countedQuantity: "10",
            expectedLineVersion: 0,
          },
        ],
      },
      ctx,
    );
    const submitted = await service.submitCount(
      created.session.id,
      {
        expectedSessionVersion: entered.session.version,
        idempotencyKey: "stale-count-submit",
      },
      ctx,
    );
    const reviewed = await service.reviewCount(
      created.session.id,
      {
        expectedSessionVersion: submitted.session.version,
        idempotencyKey: "stale-count-review",
      },
      ctx,
    );
    await prisma.inventoryBalance.update({
      where: { id: ids.balanceA },
      data: {
        onHandQuantity: "9",
        availableQuantity: "7",
        version: { increment: 1 },
      },
    });
    await assert.rejects(
      () =>
        service.postCount(
          created.session.id,
          {
            expectedSessionVersion: reviewed.session.version,
            idempotencyKey: "stale-count-post",
          },
          ctx,
        ),
      (error) => error.code === "COUNT_BALANCE_CHANGED",
    );
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { tenantId: ids.tenantId, sourceDocumentId: created.session.id },
      }),
      0,
    );
  });

  test("governed adjustment posts, enforces roles and reserved inventory, then reverses", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env });
    const specialist = identity(
        ids.tenantId,
        ids.specialistId,
        "business-specialist",
      ),
      manager = identity(ids.tenantId, ids.managerId);
    const created = await service.createAdjustment(
      {
        adjustmentNumber: `ADJ-${randomUUID()}`,
        reasonCode: "damage",
        notes: "Damaged stock",
        idempotencyKey: "adjust-create",
        lines: [{ inventoryBalanceId: ids.balanceA, adjustmentQuantity: "-2" }],
      },
      specialist,
    );
    assert.equal(
      (
        await prisma.inventoryBalance.findUnique({
          where: { id: ids.balanceA },
        })
      ).onHandQuantity.toString(),
      "10",
    );
    const ready = await service.readyAdjustment(
      created.adjustment.id,
      { expectedAdjustmentVersion: 0, idempotencyKey: "adjust-ready" },
      specialist,
    );
    await assert.rejects(
      () =>
        service.postAdjustment(
          created.adjustment.id,
          {
            expectedAdjustmentVersion: ready.adjustment.version,
            idempotencyKey: "adjust-specialist-post",
          },
          specialist,
        ),
      (error) => error.code === "AUTHORIZATION_PERMISSION_DENIED",
    );
    const posted = await service.postAdjustment(
      created.adjustment.id,
      {
        expectedAdjustmentVersion: ready.adjustment.version,
        idempotencyKey: "adjust-post",
      },
      manager,
    );
    let balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceA },
    });
    assert.deepEqual(
      [
        balance.onHandQuantity.toString(),
        balance.reservedQuantity.toString(),
        balance.availableQuantity.toString(),
      ],
      ["8", "2", "6"],
    );
    const reversed = await service.reverseAdjustment(
      created.adjustment.id,
      {
        expectedAdjustmentVersion: posted.adjustment.version,
        idempotencyKey: "adjust-reverse",
        reason: "Correction",
      },
      manager,
    );
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceA },
    });
    assert.deepEqual(
      [
        balance.onHandQuantity.toString(),
        balance.reservedQuantity.toString(),
        balance.availableQuantity.toString(),
      ],
      ["10", "2", "8"],
    );
    assert.equal(reversed.movementIds.length, 1);
    const workbench = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).adjustmentWorkbench(created.adjustment.id, manager);
    assert.equal(workbench.reconciliation.status, "matched");
  });

  test("adjustment posting aggregates duplicate balances and rejects net-zero plans", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env }),
      ctx = identity(ids.tenantId, ids.managerId);
    const created = await service.createAdjustment(
      {
        adjustmentNumber: `ADJ-AGG-${randomUUID()}`,
        reasonCode: "data_correction",
        notes: "Aggregate duplicate balance lines",
        idempotencyKey: "adjust-aggregate-create",
        lines: [
          { inventoryBalanceId: ids.balanceA, adjustmentQuantity: "3" },
          { inventoryBalanceId: ids.balanceA, adjustmentQuantity: "-1" },
        ],
      },
      ctx,
    );
    const ready = await service.readyAdjustment(
      created.adjustment.id,
      {
        expectedAdjustmentVersion: created.adjustment.version,
        idempotencyKey: "adjust-aggregate-ready",
      },
      ctx,
    );
    const preview = await buildInventoryAdjustmentPostingPlan({
      prisma,
      tenantId: ids.tenantId,
      adjustmentId: created.adjustment.id,
    });
    assert.equal(preview.allowed, true);
    assert.equal(preview.balanceImpacts.length, 1);
    assert.equal(preview.balanceImpacts[0].quantity, "2.0000");
    const before = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceA },
    });
    const posted = await service.postAdjustment(
      created.adjustment.id,
      {
        expectedAdjustmentVersion: ready.adjustment.version,
        idempotencyKey: "adjust-aggregate-post",
      },
      ctx,
    );
    assert.equal(posted.movementIds.length, 2);
    const after = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceA },
    });
    assert.equal(after.onHandQuantity.toString(), "12");
    assert.equal(after.version, before.version + 1);
    await service.reverseAdjustment(
      created.adjustment.id,
      {
        expectedAdjustmentVersion: posted.adjustment.version,
        idempotencyKey: "adjust-aggregate-reverse",
        reason: "Reverse aggregate",
      },
      ctx,
    );
    assert.equal(
      (
        await prisma.inventoryBalance.findUnique({
          where: { id: ids.balanceA },
        })
      ).onHandQuantity.toString(),
      "10",
    );

    const zero = await service.createAdjustment(
      {
        adjustmentNumber: `ADJ-ZERO-${randomUUID()}`,
        reasonCode: "data_correction",
        notes: "Net-zero duplicate balance lines",
        idempotencyKey: "adjust-zero-create",
        lines: [
          { inventoryBalanceId: ids.balanceA, adjustmentQuantity: "1" },
          { inventoryBalanceId: ids.balanceA, adjustmentQuantity: "-1" },
        ],
      },
      ctx,
    );
    const zeroReady = await service.readyAdjustment(
      zero.adjustment.id,
      {
        expectedAdjustmentVersion: zero.adjustment.version,
        idempotencyKey: "adjust-zero-ready",
      },
      ctx,
    );
    const zeroPreview = await buildInventoryAdjustmentPostingPlan({
      prisma,
      tenantId: ids.tenantId,
      adjustmentId: zero.adjustment.id,
    });
    assert.equal(zeroPreview.allowed, false);
    assert.equal(
      zeroPreview.blockingIssues[0].code,
      "ADJUSTMENT_NET_ZERO_NOT_ALLOWED",
    );
    assert.equal(
      zeroPreview.movementFacts.some((row) => units(row.adjustmentQty) === 0n),
      false,
    );
    await assert.rejects(
      () =>
        service.postAdjustment(
          zero.adjustment.id,
          {
            expectedAdjustmentVersion: zeroReady.adjustment.version,
            idempotencyKey: "adjust-zero-post",
          },
          ctx,
        ),
      (error) => error.code === "ADJUSTMENT_NET_ZERO_NOT_ALLOWED",
    );
  });

  test("adjustment reversal and reconciliation fail closed on corrupted movement facts", async () => {
    const ids = await seed(),
      service = createInventoryOperationsCommandService({ prisma, env }),
      ctx = identity(ids.tenantId, ids.managerId);
    const created = await service.createAdjustment(
      {
        adjustmentNumber: `ADJ-INTEGRITY-${randomUUID()}`,
        reasonCode: "damage",
        notes: "Integrity test",
        idempotencyKey: "adjust-integrity-create",
        lines: [{ inventoryBalanceId: ids.balanceA, adjustmentQuantity: "-2" }],
      },
      ctx,
    );
    const ready = await service.readyAdjustment(
      created.adjustment.id,
      {
        expectedAdjustmentVersion: created.adjustment.version,
        idempotencyKey: "adjust-integrity-ready",
      },
      ctx,
    );
    const posted = await service.postAdjustment(
      created.adjustment.id,
      {
        expectedAdjustmentVersion: ready.adjustment.version,
        idempotencyKey: "adjust-integrity-post",
      },
      ctx,
    );
    const movement = await prisma.inventoryMovement.findFirst({
      where: {
        sourceDocumentId: created.adjustment.id,
        movementType: "inventory_adjustment",
      },
    });
    await prisma.inventoryMovement.update({
      where: { id: movement.id },
      data: { adjustmentQty: "-3", quantityOut: "3" },
    });
    const workbench = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).adjustmentWorkbench(created.adjustment.id, ctx);
    assert.equal(workbench.reconciliation.status, "mismatch");
    await assert.rejects(
      () =>
        service.reverseAdjustment(
          created.adjustment.id,
          {
            expectedAdjustmentVersion: posted.adjustment.version,
            idempotencyKey: "adjust-integrity-reverse",
            reason: "Integrity test",
          },
          ctx,
        ),
      (error) =>
        error.code === "ADJUSTMENT_REVERSAL_NOT_SAFE" && error.status === 409,
    );
    assert.equal(
      await prisma.inventoryMovement.count({
        where: {
          sourceDocumentId: created.adjustment.id,
          reversalOfMovementId: { not: null },
        },
      }),
      0,
    );
  });

  test("capability, role, tenant, and warehouse boundaries fail closed", async () => {
    const ids = await seed(),
      disabled = createInventoryOperationsCommandService({
        prisma,
        env: { ...env, FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "false" },
      });
    await assert.rejects(
      () =>
        disabled.createAdjustment(
          {
            adjustmentNumber: "DISABLED",
            reasonCode: "damage",
            idempotencyKey: "disabled",
            lines: [
              { inventoryBalanceId: ids.balanceA, adjustmentQuantity: "1" },
            ],
          },
          identity(ids.tenantId, ids.managerId),
        ),
      (error) => error.code === "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
    );
    const service = createInventoryOperationsCommandService({ prisma, env });
    const readable = await service.createTransfer(
      {
        transferNumber: `TR-CAP-${randomUUID()}`,
        idempotencyKey: "capability-read-create",
        lines: [
          {
            itemId: ids.itemId,
            quantity: "1",
            source: { warehouseId: ids.warehouseA, location: "A-01" },
            destination: { warehouseId: ids.warehouseB, location: "B-01" },
          },
        ],
      },
      identity(ids.tenantId, ids.managerId),
    );
    const failClosedRead = createInventoryOperationsReadService({
      prisma,
      capabilities: {},
    });
    const failClosedWorkbench = await failClosedRead.transferWorkbench(
      readable.transfer.id,
      identity(ids.tenantId, ids.managerId),
    );
    assert.equal(failClosedWorkbench.availableActions.canEdit, false);
    assert.ok(
      failClosedWorkbench.availableActions.blockingReasonCodes.includes(
        "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
      ),
    );
    const partialWorkbench = await createInventoryOperationsReadService({
      prisma,
      capabilities,
    }).transferWorkbench(
      readable.transfer.id,
      identity(ids.tenantId, ids.viewerId, "viewer"),
    );
    assert.equal(partialWorkbench.reconciliation.status, "unavailable");
    assert.deepEqual(partialWorkbench.reconciliation.limitationCodes, [
      "PARTIAL_WAREHOUSE_SCOPE",
    ]);
    assert.equal(partialWorkbench.lines[0].destination, null);
    await assert.rejects(
      () =>
        service.createCount(
          {
            countNumber: "VIEWER",
            warehouseId: ids.warehouseA,
            balanceIds: [ids.balanceA],
            idempotencyKey: "viewer",
          },
          identity(ids.tenantId, ids.viewerId, "viewer"),
        ),
      (error) => error.code === "AUTHORIZATION_PERMISSION_DENIED",
    );
    const read = createInventoryOperationsReadService({ prisma, capabilities });
    await assert.rejects(
      () =>
        read.adjustmentWorkbench(
          "missing",
          identity(ids.tenantId, ids.viewerId, "viewer"),
        ),
      (error) => error.code === "ADJUSTMENT_NOT_FOUND" && error.status === 404,
    );
  });
}
