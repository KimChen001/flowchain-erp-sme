import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createPrismaClient } from "../persistence/prisma-client.mjs";
import { realPostgresSuiteGate } from "../persistence/test-db-harness.mjs";
import {
  createOutboundPostingCommandService,
  outboundRequestHash,
} from "./outbound-posting-command-service.mjs";
import { createOutboundQueryService } from "./outbound-query-service.mjs";
import {
  buildSalesOrderReservationPlan,
  buildShipmentReversalPlan,
  outboundDecimalString,
  outboundDecimalUnits,
} from "./outbound-transaction-policy.mjs";
import {
  createSalesOrderReadService,
  createSalesOrderWorkbenchService,
} from "./sales-order-workbench-service.mjs";
import { createOutboundWorkbenchReadService } from "./outbound-workbench-read-service.mjs";
import { createInventoryAuthoritativeReadService } from "./inventory-authoritative-read-service.mjs";

const gate = realPostgresSuiteGate("npm run test:db:outbound");
const realPostgres = gate.enabled;
const env = {
  ...process.env,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "true",
};
let prisma;
if (!realPostgres) {
  // Must report SKIP, not a pass. This suite is the outbound quantity,
  // reservation and concurrency coverage; a green line for a suite that never
  // executed is worse than no line at all.
  if (gate.failure) {
    test("outbound PostgreSQL transaction suite is misconfigured", () => {
      throw new Error(gate.failure);
    });
  } else {
    test("outbound PostgreSQL transactions run in the isolated test:db:outbound gate", { skip: gate.skipReason }, () => {});
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
  const command = (client = prisma) =>
    createOutboundPostingCommandService({ prisma: client, env });
  const fixed = (value) => outboundDecimalString(outboundDecimalUnits(value));
  const enabledWorkbenchCapabilities = {
    lifecycle: { enabled: true },
    reservation: { enabled: true },
    shipmentDraft: { enabled: true },
    shipmentPosting: { enabled: true },
    shipmentReversal: { enabled: true },
  };
  const enabledQueryCapabilities = {
    "sales-reservation": { enabled: true },
    "sales-shipment-draft": { enabled: true },
    "sales-shipment-posting": { enabled: true },
    "sales-shipment-reversal": { enabled: true },
  };

  test("stable request hashing ignores object insertion and business-array order", () => {
    const a = {
      salesOrderId: "SO-1",
      allocations: [
        { warehouseId: "B", quantity: "1" },
        { quantity: "2", warehouseId: "A" },
      ],
    };
    const b = {
      allocations: [
        { warehouseId: "A", quantity: "2" },
        { quantity: "1", warehouseId: "B" },
      ],
      salesOrderId: "SO-1",
    };
    assert.equal(outboundRequestHash(a), outboundRequestHash(b));
  });

  test("authoritative sales order lifecycle creates, revises, confirms, holds, resumes, and paginates", async () => {
    const base = await seed(),
      ctx = identity(base.tenantId, base.actorId),
      service = createSalesOrderWorkbenchService({ prisma });
    const created = await service.createOrder(
      {
        orderNumber: `SO-LIFECYCLE-${randomUUID()}`,
        customerName: "Lifecycle Customer",
        currency: "USD",
        idempotencyKey: "lifecycle-create",
        lines: [{ itemId: base.itemId, quantity: "2.5000" }],
      },
      ctx,
    );
    assert.equal(created.order.workflowStatus, "draft");
    assert.deepEqual(
      [
        created.order.lines[0].sku,
        created.order.lines[0].itemName,
        created.order.lines[0].orderedQuantity,
      ],
      [
        (await prisma.item.findUnique({ where: { id: base.itemId } })).sku,
        "出库测试物料",
        "2.5000",
      ],
    );
    assert.equal(
      (
        await service.createOrder(
          {
            orderNumber: created.order.orderNumber,
            customerName: "Lifecycle Customer",
            currency: "USD",
            idempotencyKey: "lifecycle-create",
            lines: [{ itemId: base.itemId, quantity: "2.5000" }],
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    const revised = await service.reviseOrder(
      created.order.id,
      {
        expectedOrderVersion: 0,
        idempotencyKey: "lifecycle-revise",
        revisionMode: "replace_all",
        expectedLineIds: created.order.lines.map((line) => line.id),
        header: { customerName: "Lifecycle Revised", currency: "CNY" },
        lines: [{ itemId: base.itemId, quantity: "3" }],
      },
      ctx,
    );
    const confirmed = await service.confirmOrder(
      created.order.id,
      {
        expectedOrderVersion: revised.order.version,
        idempotencyKey: "lifecycle-confirm",
      },
      ctx,
    );
    assert.equal(
      (
        await service.confirmOrder(
          created.order.id,
          {
            expectedOrderVersion: revised.order.version,
            idempotencyKey: "lifecycle-confirm",
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    await assert.rejects(
      () =>
        service.confirmOrder(
          created.order.id,
          {
            expectedOrderVersion: confirmed.order.version,
            idempotencyKey: "lifecycle-confirm",
          },
          ctx,
        ),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );
    const held = await service.holdOrder(
      created.order.id,
      {
        expectedOrderVersion: confirmed.order.version,
        idempotencyKey: "lifecycle-hold",
      },
      ctx,
    );
    assert.equal(
      (
        await service.holdOrder(
          created.order.id,
          {
            expectedOrderVersion: confirmed.order.version,
            idempotencyKey: "lifecycle-hold",
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    const resumed = await service.resumeOrder(
      created.order.id,
      {
        expectedOrderVersion: held.order.version,
        idempotencyKey: "lifecycle-resume",
      },
      ctx,
    );
    assert.equal(
      (
        await service.resumeOrder(
          created.order.id,
          {
            expectedOrderVersion: held.order.version,
            idempotencyKey: "lifecycle-resume",
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    assert.equal(resumed.order.workflowStatus, "confirmed");
    await assert.rejects(
      () =>
        service.reviseOrder(
          created.order.id,
          {
            expectedOrderVersion: resumed.order.version,
            idempotencyKey: "lifecycle-invalid-edit",
            revisionMode: "replace_all",
            expectedLineIds: revised.order.lines.map((line) => line.id),
            header: {},
            lines: [{ itemId: base.itemId, quantity: "1" }],
          },
          ctx,
        ),
      (error) => error.code === "SALES_ORDER_INVALID_STATE",
    );
    const listed = await createSalesOrderReadService({ prisma }).listOrders(
      { page: 1, pageSize: 1, search: "Lifecycle Revised" },
      ctx,
    );
    assert.deepEqual(
      [listed.total, listed.orders.length, listed.dataSource],
      [1, 1, "Authoritative PostgreSQL"],
    );
    assert.equal(
      await prisma.auditLog.count({
        where: { tenantId: base.tenantId, entityId: created.order.id },
      }),
      5,
    );
    assert.equal(
      await prisma.businessCommandExecution.count({
        where: {
          tenantId: base.tenantId,
          commandType: {
            in: [
              "confirm_sales_order",
              "hold_sales_order",
              "resume_sales_order",
            ],
          },
        },
      }),
      3,
    );
  });

  test("multi-line draft replacement requires a complete replace_all line identity contract", async () => {
    const base = await seed(),
      ctx = identity(base.tenantId, base.actorId),
      service = createSalesOrderWorkbenchService({ prisma });
    const created = await service.createOrder(
      {
        orderNumber: `SO-MULTI-DRAFT-${randomUUID()}`,
        customerName: "Multi Draft",
        currency: "CNY",
        idempotencyKey: "multi-draft-create",
        lines: [
          { itemId: base.itemId, quantity: "1" },
          { itemId: base.itemId, quantity: "2" },
          { itemId: base.itemId, quantity: "3" },
        ],
      },
      ctx,
    );
    const originalIds = created.order.lines.map((line) => line.id),
      originalQuantities = created.order.lines.map(
        (line) => line.orderedQuantity,
      );
    const foreign = await service.createOrder(
      {
        orderNumber: `SO-FOREIGN-DRAFT-${randomUUID()}`,
        customerName: "Foreign Draft",
        currency: "CNY",
        idempotencyKey: "foreign-draft-create",
        lines: [{ itemId: base.itemId, quantity: "1" }],
      },
      ctx,
    );
    const incompleteCases = [
      { key: "missing-mode", revisionMode: "", expectedLineIds: originalIds },
      { key: "missing-ids", revisionMode: "replace_all", expectedLineIds: [] },
      {
        key: "one-id",
        revisionMode: "replace_all",
        expectedLineIds: originalIds.slice(0, 1),
      },
      {
        key: "extra-id",
        revisionMode: "replace_all",
        expectedLineIds: [...originalIds, "unknown-line"],
      },
      {
        key: "foreign-id",
        revisionMode: "replace_all",
        expectedLineIds: [
          originalIds[0],
          originalIds[1],
          foreign.order.lines[0].id,
        ],
      },
    ];
    for (const item of incompleteCases) {
      await assert.rejects(
        () =>
          service.reviseOrder(
            created.order.id,
            {
              expectedOrderVersion: 0,
              idempotencyKey: `multi-${item.key}`,
              revisionMode: item.revisionMode,
              expectedLineIds: item.expectedLineIds,
              header: { customerName: "Unsafe replacement" },
              lines: [{ itemId: base.itemId, quantity: "9" }],
            },
            ctx,
          ),
        (error) =>
          error.code === "SALES_ORDER_DRAFT_REVISION_INCOMPLETE" &&
          error.status === 409,
      );
      const unchanged = await prisma.salesOrder.findUnique({
        where: { id: created.order.id },
        include: { lines: { orderBy: { id: "asc" } } },
      });
      assert.deepEqual(
        unchanged.lines.map((line) => line.id),
        originalIds,
      );
      assert.deepEqual(
        unchanged.lines.map((line) => fixed(line.orderedQuantity)),
        originalQuantities,
      );
    }
    const workbench = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    }).orderWorkbench(created.order.id, ctx);
    assert.equal(workbench.availableActions.canEditDraft, false);
    assert.ok(
      workbench.availableActions.blockingReasonCodes.includes(
        "MULTI_LINE_DRAFT_EDITOR_NOT_AVAILABLE",
      ),
    );
    const completeInput = {
      expectedOrderVersion: 0,
      idempotencyKey: "multi-complete-replace",
      revisionMode: "replace_all",
      expectedLineIds: originalIds,
      header: { customerName: "Safe replacement" },
      lines: [
        { itemId: base.itemId, quantity: "4" },
        { itemId: base.itemId, quantity: "5" },
        { itemId: base.itemId, quantity: "6" },
      ],
    };
    const revised = await service.reviseOrder(
      created.order.id,
      completeInput,
      ctx,
    );
    assert.deepEqual(
      revised.order.lines.map((line) => line.orderedQuantity).sort(),
      ["4.0000", "5.0000", "6.0000"],
    );
    assert.equal(
      (await service.reviseOrder(created.order.id, completeInput, ctx))
        .idempotentReplay,
      true,
    );
    assert.equal(
      await prisma.businessCommandExecution.count({
        where: {
          tenantId: base.tenantId,
          commandType: "revise_sales_order_draft",
          idempotencyKey: "multi-complete-replace",
        },
      }),
      1,
    );
  });

  async function seed({
    stock = "10.0000",
    ordered = "10.0000",
    actorRole = "manager",
    scope = "operate",
    suffix = randomUUID(),
  } = {}) {
    const ids = {
      tenantId: `tenant-${suffix}`,
      actorId: `actor-${suffix}`,
      warehouseId: `wh-${suffix}`,
      itemId: `item-${suffix}`,
      balanceId: `bal-${suffix}`,
      salesOrderId: `so-${suffix}`,
      salesOrderLineId: `sol-${suffix}`,
    };
    await prisma.tenant.create({
      data: { id: ids.tenantId, name: `Tenant ${suffix}` },
    });
    await prisma.user.create({
      data: {
        id: ids.actorId,
        tenantId: ids.tenantId,
        email: `${ids.actorId}@example.com`,
        name: "Outbound Manager",
        role: actorRole,
      },
    });
    await prisma.warehouse.create({
      data: {
        id: ids.warehouseId,
        tenantId: ids.tenantId,
        code: `WH-${suffix}`,
        name: "Main Warehouse",
        status: "active",
      },
    });
    if (scope)
      await prisma.userWarehouseScope.create({
        data: {
          id: `scope-${suffix}`,
          tenantId: ids.tenantId,
          userId: ids.actorId,
          warehouseId: ids.warehouseId,
          accessLevel: scope,
        },
      });
    await prisma.item.create({
      data: {
        id: ids.itemId,
        tenantId: ids.tenantId,
        sku: `SKU-${suffix}`,
        name: "出库测试物料",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        id: ids.balanceId,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: `SKU-${suffix}`,
        itemName: "出库测试物料",
        warehouseId: ids.warehouseId,
        warehouseKey: ids.warehouseId,
        location: "A-01",
        locationKey: "a-01",
        onHandQuantity: stock,
        reservedQuantity: "0",
        availableQuantity: stock,
        unit: "EA",
        status: "available",
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        id: `opening-${suffix}`,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: `SKU-${suffix}`,
        itemName: "出库测试物料",
        warehouseId: ids.warehouseId,
        location: "A-01",
        locationKey: "a-01",
        movementType: "opening_balance",
        movementLabel: "Opening balance",
        sourceDocument: "test-seed",
        sourceDocumentType: "TestSeed",
        sourceDocumentId: ids.balanceId,
        sourceDocumentLineId: ids.balanceId,
        quantityIn: stock,
        quantityOut: "0",
        adjustmentQty: "0",
        status: "posted",
        unit: "EA",
      },
    });
    await prisma.salesOrder.create({
      data: {
        id: ids.salesOrderId,
        tenantId: ids.tenantId,
        orderNumber: `SO-${suffix}`,
        customerName: "Test Customer",
        workflowStatus: "confirmed",
        reservationStatus: "not_reserved",
        fulfillmentStatus: "not_fulfilled",
        currency: "CNY",
        lines: {
          create: {
            id: ids.salesOrderLineId,
            itemId: ids.itemId,
            sku: `SKU-${suffix}`,
            itemName: "出库测试物料",
            orderedQuantity: ordered,
            reservedQuantity: "0",
            fulfilledQuantity: "0",
            unit: "EA",
          },
        },
      },
    });
    return ids;
  }

  const reserveInput = (
    ids,
    quantity = "4.0000",
    key = `reserve-${randomUUID()}`,
  ) => ({
    salesOrderId: ids.salesOrderId,
    expectedOrderVersion: 0,
    idempotencyKey: key,
    allocations: [
      {
        salesOrderLineId: ids.salesOrderLineId,
        warehouseId: ids.warehouseId,
        location: "A-01",
        quantity,
      },
    ],
  });

  async function assertReconciled(ids) {
    const [balance, line, reservations] = await Promise.all([
      prisma.inventoryBalance.findUnique({ where: { id: ids.balanceId } }),
      prisma.salesOrderLine.findUnique({ where: { id: ids.salesOrderLineId } }),
      prisma.inventoryReservation.findMany({
        where: { tenantId: ids.tenantId, salesOrderId: ids.salesOrderId },
      }),
    ]);
    const d = (value) => BigInt(String(value).replace(".", ""));
    assert.equal(
      d(balance.availableQuantity),
      d(balance.onHandQuantity) - d(balance.reservedQuantity),
    );
    assert.ok(
      d(line.reservedQuantity) >= 0n && d(line.fulfilledQuantity) >= 0n,
    );
    assert.ok(
      d(line.reservedQuantity) + d(line.fulfilledQuantity) <=
        d(line.orderedQuantity),
    );
    for (const reservation of reservations) {
      assert.ok(
        d(reservation.consumedQuantity) + d(reservation.releasedQuantity) <=
          d(reservation.reservedQuantity),
      );
      assert.ok(
        d(reservation.allocatedQuantity) <=
          d(reservation.reservedQuantity) -
            d(reservation.consumedQuantity) -
            d(reservation.releasedQuantity),
      );
    }
  }

  test("authoritative reserve, draft, post, replay, and reversal close the PostgreSQL transaction loop", async () => {
    const ids = await seed();
    const service = command();
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "4.0000", "reserve-main"),
      identity(ids.tenantId, ids.actorId),
    );
    assert.equal(reserved.reservations.length, 1);
    let balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { tenantId: ids.tenantId, movementType: "shipment_posting" },
      }),
      0,
    );
    const reservationId = reserved.reservations[0].id;

    const drafted = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: "SHIP-MAIN",
        expectedOrderVersion: 1,
        idempotencyKey: "draft-main",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [{ reservationId, quantity: "4.0000" }],
          },
        ],
      },
      identity(ids.tenantId, ids.actorId),
    );
    const shipmentId = drafted.shipment.id;
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    assert.equal(
      fixed(
        (
          await prisma.inventoryReservation.findUnique({
            where: { id: reservationId },
          })
        ).allocatedQuantity,
      ),
      "4.0000",
    );

    const posted = await service.postShipment(
      { shipmentId, expectedShipmentVersion: 0, idempotencyKey: "post-main" },
      identity(ids.tenantId, ids.actorId),
    );
    assert.equal(posted.movementIds.length, 1);
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["6.0000", "0.0000", "6.0000"],
    );
    let reservation = await prisma.inventoryReservation.findUnique({
      where: { id: reservationId },
    });
    assert.deepEqual(
      [
        fixed(reservation.allocatedQuantity),
        fixed(reservation.consumedQuantity),
        reservation.status,
      ],
      ["0.0000", "4.0000", "consumed"],
    );
    let line = await prisma.salesOrderLine.findUnique({
      where: { id: ids.salesOrderLineId },
    });
    assert.deepEqual(
      [fixed(line.reservedQuantity), fixed(line.fulfilledQuantity)],
      ["0.0000", "4.0000"],
    );
    assert.equal(
      (
        await service.postShipment(
          {
            shipmentId,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-main",
          },
          identity(ids.tenantId, ids.actorId),
        )
      ).idempotentReplay,
      true,
    );

    const reversed = await service.reverseShipment(
      {
        shipmentId,
        expectedShipmentVersion: 1,
        idempotencyKey: "reverse-main",
        reason: "Customer correction",
      },
      identity(ids.tenantId, ids.actorId),
    );
    assert.equal(reversed.movementIds.length, 1);
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    reservation = await prisma.inventoryReservation.findUnique({
      where: { id: reservationId },
    });
    assert.deepEqual(
      [
        fixed(reservation.allocatedQuantity),
        fixed(reservation.consumedQuantity),
        reservation.status,
      ],
      ["0.0000", "0.0000", "active"],
    );
    line = await prisma.salesOrderLine.findUnique({
      where: { id: ids.salesOrderLineId },
    });
    assert.deepEqual(
      [fixed(line.reservedQuantity), fixed(line.fulfilledQuantity)],
      ["4.0000", "0.0000"],
    );
    const original = await prisma.inventoryMovement.findUnique({
      where: { id: posted.movementIds[0] },
    });
    const reversal = await prisma.inventoryMovement.findUnique({
      where: { id: reversed.movementIds[0] },
    });
    assert.equal(original.itemName, "出库测试物料");
    assert.equal(reversal.itemName, "出库测试物料");
    assert.equal(original.reversedByMovementId, reversal.id);
    assert.equal(reversal.reversalOfMovementId, original.id);
    assert.deepEqual(
      [fixed(original.quantityIn), fixed(original.quantityOut)],
      ["0.0000", "4.0000"],
    );
    assert.equal(
      await prisma.auditLog.count({ where: { tenantId: ids.tenantId, module: "sales_outbound" } }),
      4,
    );
    assert.equal(
      await prisma.businessCommandExecution.count({
        where: { tenantId: ids.tenantId, status: "completed" },
      }),
      4,
    );
    assert.equal(
      await prisma.inventoryReservationEvent.count({
        where: { tenantId: ids.tenantId },
      }),
      4,
    );
    const linkedEvents = await prisma.inventoryReservationEvent.findMany({
      where: { tenantId: ids.tenantId },
      include: { commandExecution: true },
    });
    assert.ok(
      linkedEvents.every(
        (event) =>
          event.commandExecutionId &&
          event.commandExecution?.commandType === event.commandType &&
          event.commandExecution?.idempotencyKey,
      ),
    );
    const workbench = await createOutboundWorkbenchReadService({
      prisma,
    }).orderWorkbench(ids.salesOrderId, identity(ids.tenantId, ids.actorId));
    assert.equal(workbench.dataSource, "Authoritative PostgreSQL");
    assert.equal(workbench.reconciliation.status, "matched");
    assert.ok(
      workbench.evidence.some(
        (event) => event.commandExecutionId && event.idempotencyKey,
      ),
    );
    assert.ok(
      workbench.smartLinks.some(
        (link) =>
          link.targetRouteId === "inventory:movements" &&
          link.filter.relatedSalesOrderId === ids.salesOrderId,
      ),
    );
    assert.equal(
      workbench.smartLinks.find((link) => link.targetType === "shipment")
        .targetId,
      shipmentId,
    );
    const shipmentWorkbench = await createOutboundWorkbenchReadService({
      prisma,
    }).shipmentWorkbench(shipmentId, identity(ids.tenantId, ids.actorId));
    assert.equal(shipmentWorkbench.availableActions.canReverse, false);
    assert.equal(shipmentWorkbench.movements.length, 2);
    await assertReconciled(ids);
  });

  test("holding a sales order blocks shipment posting without writes, resume permits posting, and reversal remains safe on hold", async () => {
    const ids = await seed(),
      ctx = identity(ids.tenantId, ids.actorId),
      service = command(),
      lifecycle = createSalesOrderWorkbenchService({ prisma });
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "3", "hold-reserve"),
      ctx,
    );
    const drafted = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: `HOLD-${randomUUID()}`,
        expectedOrderVersion: 1,
        idempotencyKey: "hold-draft",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [
              { reservationId: reserved.reservations[0].id, quantity: "3" },
            ],
          },
        ],
      },
      ctx,
    );
    const beforeHold = await prisma.salesOrder.findUnique({
      where: { id: ids.salesOrderId },
    });
    await lifecycle.holdOrder(
      ids.salesOrderId,
      {
        expectedOrderVersion: beforeHold.version,
        idempotencyKey: "hold-before-post",
      },
      ctx,
    );
    const snapshot = async () => ({
      balance: await prisma.inventoryBalance.findUnique({
        where: { id: ids.balanceId },
      }),
      reservation: await prisma.inventoryReservation.findUnique({
        where: { id: reserved.reservations[0].id },
      }),
      shipment: await prisma.shipmentDocument.findUnique({
        where: { id: drafted.shipment.id },
      }),
      movements: await prisma.inventoryMovement.count({
        where: { tenantId: ids.tenantId, movementType: "shipment_posting" },
      }),
    });
    const beforeRejectedPost = await snapshot();
    const preview = await createOutboundQueryService({
      prisma,
      capabilities: enabledQueryCapabilities,
    }).previewShipmentPosting({ shipmentId: drafted.shipment.id }, ctx);
    assert.equal(preview.allowed, false);
    assert.ok(
      preview.blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ON_HOLD",
      ),
    );
    await assert.rejects(
      () =>
        service.postShipment(
          {
            shipmentId: drafted.shipment.id,
            expectedShipmentVersion: 0,
            idempotencyKey: "hold-post-rejected",
          },
          ctx,
        ),
      (error) => error.code === "SALES_ORDER_ON_HOLD" && error.status === 409,
    );
    const afterRejectedPost = await snapshot();
    assert.deepEqual(
      [
        fixed(afterRejectedPost.balance.onHandQuantity),
        fixed(afterRejectedPost.balance.reservedQuantity),
        fixed(afterRejectedPost.reservation.consumedQuantity),
        afterRejectedPost.shipment.postingStatus,
        afterRejectedPost.movements,
      ],
      [
        fixed(beforeRejectedPost.balance.onHandQuantity),
        fixed(beforeRejectedPost.balance.reservedQuantity),
        fixed(beforeRejectedPost.reservation.consumedQuantity),
        beforeRejectedPost.shipment.postingStatus,
        beforeRejectedPost.movements,
      ],
    );
    const held = await prisma.salesOrder.findUnique({
      where: { id: ids.salesOrderId },
    });
    await lifecycle.resumeOrder(
      ids.salesOrderId,
      {
        expectedOrderVersion: held.version,
        idempotencyKey: "resume-before-post",
      },
      ctx,
    );
    await service.postShipment(
      {
        shipmentId: drafted.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "hold-post-success",
      },
      ctx,
    );
    const postedOrder = await prisma.salesOrder.findUnique({
      where: { id: ids.salesOrderId },
    });
    await lifecycle.holdOrder(
      ids.salesOrderId,
      {
        expectedOrderVersion: postedOrder.version,
        idempotencyKey: "hold-before-reverse",
      },
      ctx,
    );
    const shipmentWorkbench = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    }).shipmentWorkbench(drafted.shipment.id, ctx);
    assert.equal(shipmentWorkbench.availableActions.canReverse, true);
    await service.reverseShipment(
      {
        shipmentId: drafted.shipment.id,
        expectedShipmentVersion: 1,
        idempotencyKey: "reverse-while-held",
        reason: "Safe correction while order is held",
      },
      ctx,
    );
    assert.equal(
      (
        await prisma.shipmentDocument.findUnique({
          where: { id: drafted.shipment.id },
        })
      ).postingStatus,
      "reversed",
    );
    await assertReconciled(ids);
  });

  test("outbound workbench capability contract keeps reads available while every disabled mutation action fails closed", async () => {
    const ids = await seed(),
      ctx = identity(ids.tenantId, ids.actorId);
    const disabled = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: {},
    }).orderWorkbench(ids.salesOrderId, ctx);
    assert.equal(disabled.dataSource, "Authoritative PostgreSQL");
    assert.deepEqual(
      [
        disabled.availableActions.canEditDraft,
        disabled.availableActions.canConfirm,
        disabled.availableActions.canHold,
        disabled.availableActions.canResume,
        disabled.availableActions.canReserve,
        disabled.availableActions.canRelease,
        disabled.availableActions.canCreateShipment,
      ],
      [false, false, false, false, false, false, false],
    );
    assert.ok(
      disabled.availableActions.blockingReasonCodes.includes(
        "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
      ),
    );
    const enabled = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    }).orderWorkbench(ids.salesOrderId, ctx);
    assert.equal(enabled.availableActions.canHold, true);
    assert.equal(enabled.availableActions.canReserve, true);
  });

  test("warehouse-scoped outbound projection hides cross-warehouse facts and marks reconciliation incomplete", async () => {
    const ids = await seed({ stock: "10", ordered: "10" }),
      suffix = randomUUID(),
      ctx = identity(ids.tenantId, ids.actorId);
    const warehouseB = `wh-b-${suffix}`,
      balanceB = `bal-b-${suffix}`;
    await prisma.warehouse.create({
      data: {
        id: warehouseB,
        tenantId: ids.tenantId,
        code: `WH-B-${suffix}`,
        name: "Restricted Warehouse",
        status: "active",
      },
    });
    await prisma.userWarehouseScope.create({
      data: {
        id: `scope-b-${suffix}`,
        tenantId: ids.tenantId,
        userId: ids.actorId,
        warehouseId: warehouseB,
        accessLevel: "operate",
      },
    });
    const item = await prisma.item.findUnique({ where: { id: ids.itemId } });
    await prisma.inventoryBalance.create({
      data: {
        id: balanceB,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: warehouseB,
        warehouseKey: warehouseB,
        location: "B-01",
        locationKey: "b-01",
        onHandQuantity: "10",
        reservedQuantity: "0",
        availableQuantity: "10",
        unit: "EA",
        status: "available",
      },
    });
    const hiddenOpeningMovement = `opening-b-${suffix}`;
    await prisma.inventoryMovement.create({
      data: {
        id: hiddenOpeningMovement,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: warehouseB,
        location: "B-01",
        locationKey: "b-01",
        movementType: "opening_balance",
        movementLabel: "Opening balance",
        sourceDocument: "test-seed",
        sourceDocumentType: "TestSeed",
        sourceDocumentId: balanceB,
        sourceDocumentLineId: balanceB,
        quantityIn: "10",
        quantityOut: "0",
        adjustmentQty: "0",
        status: "posted",
        unit: "EA",
      },
    });
    const service = command();
    const reserved = await service.reserveSalesOrderInventory(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 0,
        idempotencyKey: "scope-reserve",
        allocations: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            warehouseId: ids.warehouseId,
            location: "A-01",
            quantity: "2",
          },
          {
            salesOrderLineId: ids.salesOrderLineId,
            warehouseId: warehouseB,
            location: "B-01",
            quantity: "2",
          },
        ],
      },
      ctx,
    );
    const reservationA = reserved.reservations.find(
      (row) => row.warehouseId === ids.warehouseId,
    );
    const reservationB = reserved.reservations.find(
      (row) => row.warehouseId === warehouseB,
    );
    const shipmentA = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: `VISIBLE-${suffix}`,
        expectedOrderVersion: 1,
        idempotencyKey: "scope-draft-a",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [{ reservationId: reservationA.id, quantity: "1" }],
          },
        ],
      },
      ctx,
    );
    const shipmentB = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: `HIDDEN-${suffix}`,
        expectedOrderVersion: 2,
        idempotencyKey: "scope-draft-b",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [{ reservationId: reservationB.id, quantity: "1" }],
          },
        ],
      },
      ctx,
    );
    const hiddenPost = await service.postShipment(
      {
        shipmentId: shipmentB.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "scope-post-b",
      },
      ctx,
    );
    const viewerId = `viewer-a-${suffix}`,
      adminId = `admin-${suffix}`;
    await prisma.user.createMany({
      data: [
        {
          id: viewerId,
          tenantId: ids.tenantId,
          email: `${viewerId}@example.com`,
          name: "Warehouse A Viewer",
          role: "manager",
        },
        {
          id: adminId,
          tenantId: ids.tenantId,
          email: `${adminId}@example.com`,
          name: "Workspace Admin",
          role: "admin",
        },
      ],
    });
    await prisma.userWarehouseScope.create({
      data: {
        id: `scope-viewer-a-${suffix}`,
        tenantId: ids.tenantId,
        userId: viewerId,
        warehouseId: ids.warehouseId,
        accessLevel: "read",
      },
    });
    const read = createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    });
    const partial = await read.orderWorkbench(
      ids.salesOrderId,
      identity(ids.tenantId, viewerId),
    );
    assert.deepEqual(
      [
        partial.scopeCoverage.status,
        partial.scopeCoverage.hiddenWarehouseFacts,
        partial.reconciliation.status,
        partial.reconciliation.reasonCode,
      ],
      ["partial", true, "unavailable", "PARTIAL_WAREHOUSE_SCOPE"],
    );
    assert.equal(partial.lines[0].quantityScope, "visible_warehouses_only");
    assert.equal(partial.lines[0].remainingToReserve, null);
    assert.deepEqual(
      partial.reservations.map((row) => row.id),
      [reservationA.id],
    );
    assert.deepEqual(
      partial.shipments.map((row) => row.id),
      [shipmentA.shipment.id],
    );
    assert.equal(
      partial.smartLinks.find((link) => link.targetType === "shipment")
        .targetId,
      shipmentA.shipment.id,
    );
    assert.ok(
      partial.availability.every((row) =>
        row.balances.every(
          (balance) => balance.warehouseId === ids.warehouseId,
        ),
      ),
    );
    assert.ok(
      partial.evidence.some(
        (event) =>
          event.eventType === "shipment_draft_created" &&
          event.entityId === shipmentA.shipment.id,
      ),
    );
    assert.equal(
      partial.evidence.some(
        (event) => event.eventType === "sales_inventory_reserved",
      ),
      false,
    );
    assert.equal(
      partial.evidence.some(
        (event) => event.entityId === shipmentB.shipment.id,
      ),
      false,
    );
    const serialized = JSON.stringify(partial);
    for (const hiddenId of [
      warehouseB,
      balanceB,
      reservationB.id,
      shipmentB.shipment.id,
      hiddenOpeningMovement,
      ...hiddenPost.movementIds,
    ])
      assert.equal(serialized.includes(hiddenId), false, hiddenId);
    await assert.rejects(
      () =>
        read.shipmentWorkbench(
          shipmentB.shipment.id,
          identity(ids.tenantId, viewerId),
        ),
      (error) =>
        error.code === "WAREHOUSE_SCOPE_DENIED" && error.status === 404,
    );
    const full = await read.orderWorkbench(
      ids.salesOrderId,
      identity(ids.tenantId, adminId, "admin"),
    );
    assert.equal(full.scopeCoverage.status, "full");
    assert.equal(full.reconciliation.status, "matched");
    assert.equal(full.reservations.length, 2);
    assert.equal(full.shipments.length, 2);
    assert.ok(
      full.evidence.some(
        (event) => event.eventType === "sales_inventory_reserved",
      ),
    );
    assert.ok(
      full.evidence.some((event) => event.entityId === shipmentB.shipment.id),
    );
    const multipleShipmentLink = full.smartLinks.find(
      (link) => link.targetType === "shipment",
    );
    assert.deepEqual(
      [
        multipleShipmentLink.targetRouteId,
        multipleShipmentLink.targetId,
        multipleShipmentLink.filter.section,
      ],
      ["sales:order-detail", ids.salesOrderId, "shipments"],
    );

    const inventory = createInventoryAuthoritativeReadService({ prisma });
    const visibleMovement = await prisma.inventoryMovement.create({
      data: {
        id: `movement-a-${suffix}`,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: ids.warehouseId,
        location: "A-01",
        locationKey: "a-01",
        movementType: "shipment_posting",
        movementLabel: "Shipment posting",
        sourceDocumentType: "ShipmentDocument",
        sourceDocumentId: shipmentA.shipment.id,
        sourceDocumentLineId: `movement-line-a-${suffix}`,
        relatedSalesOrderId: ids.salesOrderId,
        postingBatchId: `batch-a-${suffix}`,
        quantityIn: "0",
        quantityOut: "1",
        adjustmentQty: "-1",
        status: "posted",
        unit: "EA",
      },
    });
    const filterContext = identity(ids.tenantId, viewerId);
    const byOrder = await inventory.listMovements(
      { relatedSalesOrderId: ids.salesOrderId, tenantId: "forged-tenant" },
      filterContext,
    );
    assert.deepEqual(
      byOrder.movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.equal(byOrder.movements[0].quantityOut, "1.0000");
    assert.deepEqual(
      (
        await inventory.listMovements(
          { postingBatchId: `batch-a-${suffix}` },
          filterContext,
        )
      ).movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.deepEqual(
      (
        await inventory.listMovements(
          { sourceDocumentId: shipmentA.shipment.id },
          filterContext,
        )
      ).movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.deepEqual(
      (
        await inventory.listMovements(
          {
            warehouseId: ids.warehouseId,
            locationKey: "a-01",
            movementType: "shipment_posting",
          },
          filterContext,
        )
      ).movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.equal(
      (
        await inventory.listMovements(
          { warehouseId: warehouseB },
          filterContext,
        )
      ).total,
      0,
    );
    const balances = await inventory.listBalances(
      {
        sku: item.sku,
        warehouseId: ids.warehouseId,
        locationKey: "a-01",
        tenantId: "forged-tenant",
      },
      filterContext,
    );
    assert.deepEqual(
      balances.balances.map((row) => row.id),
      [ids.balanceId],
    );
    assert.equal(balances.balances[0].availableQuantity, "8.0000");
  });

  test("partial/full release, cancellation, authorization, version, and idempotency conflicts are stable", async () => {
    const ids = await seed();
    const service = command(),
      ctx = identity(ids.tenantId, ids.actorId);
    const first = await service.reserveSalesOrderInventory(
      reserveInput(ids, "6", "reserve-guards"),
      ctx,
    );
    await assert.rejects(
      () =>
        service.reserveSalesOrderInventory(
          {
            ...reserveInput(ids, "5", "reserve-over"),
            expectedOrderVersion: 1,
          },
          ctx,
        ),
      (error) =>
        error.code === "RESERVATION_INSUFFICIENT_AVAILABLE" ||
        error.code === "RESERVATION_OVER_ORDERED",
    );
    await assert.rejects(
      () =>
        service.reserveSalesOrderInventory(
          {
            ...reserveInput(ids, "6", "reserve-guards"),
            allocations: reserveInput(ids, "5").allocations,
          },
          ctx,
        ),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );
    await assert.rejects(
      () =>
        service.releaseSalesOrderReservation(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 0,
            idempotencyKey: "stale-release",
            reason: "Correction",
            releases: [
              {
                reservationId: first.reservations[0].id,
                quantity: "1",
                expectedReservationVersion: 0,
              },
            ],
          },
          ctx,
        ),
      (error) => error.code === "SALES_ORDER_VERSION_CONFLICT",
    );
    const released = await service.releaseSalesOrderReservation(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 1,
        idempotencyKey: "release-partial",
        reason: "Correction",
        releases: [
          {
            reservationId: first.reservations[0].id,
            quantity: "2",
            expectedReservationVersion: 0,
          },
        ],
      },
      ctx,
    );
    assert.equal(released.reservations[0].releasedQuantity, "2.0000");
    const draft = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: "SHIP-CANCEL",
        expectedOrderVersion: 2,
        idempotencyKey: "draft-cancel",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [
              { reservationId: first.reservations[0].id, quantity: "2" },
            ],
          },
        ],
      },
      ctx,
    );
    await assert.rejects(
      () =>
        service.releaseSalesOrderReservation(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 3,
            idempotencyKey: "release-allocated",
            reason: "Not allowed",
            releases: [
              {
                reservationId: first.reservations[0].id,
                quantity: "3",
                expectedReservationVersion: 2,
              },
            ],
          },
          ctx,
        ),
      (error) => error.code === "RESERVATION_ALREADY_ALLOCATED",
    );
    await service.cancelShipmentDraft(
      {
        shipmentId: draft.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "cancel-draft",
        reason: "Draft abandoned",
      },
      ctx,
    );
    await assert.rejects(
      () =>
        service.createShipmentDraft(
          {
            salesOrderId: ids.salesOrderId,
            shipmentNumber: "SHIP-CANCEL",
            expectedOrderVersion: 3,
            idempotencyKey: "draft-duplicate-number",
            lines: [
              {
                salesOrderLineId: ids.salesOrderLineId,
                allocations: [
                  { reservationId: first.reservations[0].id, quantity: "1" },
                ],
              },
            ],
          },
          ctx,
        ),
      (error) =>
        error.code === "SHIPMENT_NUMBER_CONFLICT" && error.status === 409,
    );
    assert.equal(
      fixed(
        (
          await prisma.inventoryReservation.findUnique({
            where: { id: first.reservations[0].id },
          })
        ).allocatedQuantity,
      ),
      "0.0000",
    );
    const balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    await assert.rejects(
      () =>
        service.postShipment(
          {
            shipmentId: draft.shipment.id,
            expectedShipmentVersion: 1,
            idempotencyKey: "post-cancelled",
          },
          ctx,
        ),
      (error) => error.code === "SHIPMENT_ALREADY_CANCELLED",
    );

    for (const [role, scope] of [
      ["viewer", "operate"],
      ["buyer", "operate"],
      ["manager", "read"],
      ["manager", null],
    ]) {
      const denied = await seed({ actorRole: role, scope });
      await assert.rejects(
        () =>
          command().reserveSalesOrderInventory(
            reserveInput(denied),
            identity(denied.tenantId, denied.actorId, role),
          ),
        (error) =>
          ["PERMISSION_DENIED", "AUTHORIZATION_PERMISSION_DENIED", "WAREHOUSE_SCOPE_DENIED"].includes(error.code),
      );
    }
    await assertReconciled(ids);
  });

  test("reservation policy rejects cross-tenant, SKU, inactive item, and balance identity corruption", async () => {
    const ids = await seed(),
      item = await prisma.item.findUnique({ where: { id: ids.itemId } });
    const input = reserveInput(ids, "1", "integrity-preview");
    const plan = () =>
      buildSalesOrderReservationPlan({
        prisma,
        tenantId: ids.tenantId,
        ...input,
      });
    assert.equal((await plan()).allowed, true);

    const foreign = await seed();
    await prisma.salesOrderLine.update({
      where: { id: ids.salesOrderLineId },
      data: { itemId: foreign.itemId },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.salesOrderLine.update({
      where: { id: ids.salesOrderLineId },
      data: { itemId: ids.itemId, sku: `${item.sku}-CORRUPT` },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.salesOrderLine.update({
      where: { id: ids.salesOrderLineId },
      data: { sku: item.sku },
    });
    await prisma.item.update({
      where: { id: ids.itemId },
      data: { status: "inactive" },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.item.update({
      where: { id: ids.itemId },
      data: { status: "active" },
    });

    const alternateItemId = `item-alt-${randomUUID()}`;
    await prisma.item.create({
      data: {
        id: alternateItemId,
        tenantId: ids.tenantId,
        sku: `ALT-${randomUUID()}`,
        name: "Alternate",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.update({
      where: { id: ids.balanceId },
      data: { itemId: alternateItemId },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.inventoryBalance.update({
      where: { id: ids.balanceId },
      data: { itemId: ids.itemId, sku: `${item.sku}-CORRUPT` },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.inventoryBalance.update({
      where: { id: ids.balanceId },
      data: { sku: item.sku },
    });
    assert.equal((await plan()).allowed, true);
  });

  test("reservation preview masks warehouse facts unless the signed actor has read scope", async () => {
    const ids = await seed(),
      suffix = randomUUID();
    const otherWarehouseId = `wh-other-${suffix}`;
    await prisma.warehouse.create({
      data: {
        id: otherWarehouseId,
        tenantId: ids.tenantId,
        code: `OTHER-${suffix}`,
        name: "Other",
        status: "active",
      },
    });
    const users = [
      ["none", "manager", null],
      ["other", "manager", ["read", otherWarehouseId]],
      ["read", "manager", ["read", ids.warehouseId]],
      ["operate", "manager", ["operate", ids.warehouseId]],
      ["viewer", "viewer", ["read", ids.warehouseId]],
      ["admin", "admin", null],
    ];
    for (const [name, role, scopeData] of users) {
      const userId = `preview-${name}-${suffix}`;
      await prisma.user.create({
        data: {
          id: userId,
          tenantId: ids.tenantId,
          email: `${userId}@example.com`,
          name,
          role,
        },
      });
      if (scopeData)
        await prisma.userWarehouseScope.create({
          data: {
            id: `scope-${name}-${suffix}`,
            tenantId: ids.tenantId,
            userId,
            accessLevel: scopeData[0],
            warehouseId: scopeData[1],
          },
        });
    }
    const query = createOutboundQueryService({
      prisma,
      capabilities: { "sales-reservation": { enabled: true } },
    });
    const preview = (name, role, warehouseId = ids.warehouseId) =>
      query.previewSalesOrderReservation(
        {
          ...reserveInput(ids, "1"),
          allocations: [
            {
              salesOrderLineId: ids.salesOrderLineId,
              warehouseId,
              location: "A-01",
              quantity: "1",
            },
          ],
        },
        identity(ids.tenantId, `preview-${name}-${suffix}`, role),
      );
    for (const [name, role] of [
      ["none", "manager"],
      ["other", "manager"],
    ])
      await assert.rejects(
        () => preview(name, role),
        (error) =>
          error.code === "WAREHOUSE_SCOPE_DENIED" &&
          error.status === 404 &&
          !JSON.stringify(error).includes(ids.balanceId),
      );
    for (const [name, role] of [
      ["read", "manager"],
      ["operate", "manager"],
      ["viewer", "viewer"],
      ["admin", "admin"],
    ])
      assert.equal((await preview(name, role)).allowed, true);
    const foreign = await seed();
    await assert.rejects(
      () => preview("admin", "admin", foreign.warehouseId),
      (error) =>
        error.code === "WAREHOUSE_SCOPE_DENIED" && error.status === 404,
    );
  });

  test("shipment reversal fails closed when original movement or allocation facts are corrupted", async () => {
    const ids = await seed(),
      ctx = identity(ids.tenantId, ids.actorId),
      service = command();
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "3", "tamper-reserve"),
      ctx,
    );
    const drafted = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: `TAMPER-${randomUUID()}`,
        expectedOrderVersion: 1,
        idempotencyKey: "tamper-draft",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [
              { reservationId: reserved.reservations[0].id, quantity: "3" },
            ],
          },
        ],
      },
      ctx,
    );
    const posted = await service.postShipment(
      {
        shipmentId: drafted.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "tamper-post",
      },
      ctx,
    );
    const movementId = posted.movementIds[0];
    const allocation = await prisma.shipmentAllocation.findFirst({
      where: { shipmentLine: { shipmentId: drafted.shipment.id } },
    });
    const assertUnsafe = async () =>
      assert.ok(
        (
          await buildShipmentReversalPlan({
            prisma,
            tenantId: ids.tenantId,
            shipmentId: drafted.shipment.id,
            reason: "Integrity test",
          })
        ).blockingIssues.some(
          (issue) => issue.code === "SHIPMENT_REVERSAL_NOT_SAFE",
        ),
      );
    const movementCases = [
      ["quantityOut", "2"],
      ["sku", "CORRUPT-SKU"],
      ["warehouseId", "wrong-warehouse"],
      ["locationKey", "wrong-location"],
      ["relatedSalesOrderId", "wrong-order"],
      ["reversedByMovementId", `already-reversed-${randomUUID()}`],
    ];
    const original = await prisma.inventoryMovement.findUnique({
      where: { id: movementId },
    });
    for (const [field, value] of movementCases) {
      await prisma.inventoryMovement.update({
        where: { id: movementId },
        data: { [field]: value },
      });
      await assertUnsafe();
      await prisma.inventoryMovement.update({
        where: { id: movementId },
        data: { [field]: original[field] },
      });
    }
    await prisma.shipmentAllocation.update({
      where: { id: allocation.id },
      data: { status: "allocated" },
    });
    await assertUnsafe();
    await prisma.shipmentAllocation.update({
      where: { id: allocation.id },
      data: { status: "consumed" },
    });
    assert.equal(
      (
        await buildShipmentReversalPlan({
          prisma,
          tenantId: ids.tenantId,
          shipmentId: drafted.shipment.id,
          reason: "Valid reversal",
        })
      ).allowed,
      true,
    );
  });

  test("two independent clients cannot over-reserve the same inventory balance", async () => {
    const firstIds = await seed({ stock: "10", ordered: "8" });
    const secondOrderId = `so-2-${randomUUID()}`,
      secondLineId = `sol-2-${randomUUID()}`;
    await prisma.salesOrder.create({
      data: {
        id: secondOrderId,
        tenantId: firstIds.tenantId,
        orderNumber: `SO-2-${randomUUID()}`,
        customerName: "Second",
        workflowStatus: "confirmed",
        currency: "CNY",
        lines: {
          create: {
            id: secondLineId,
            itemId: firstIds.itemId,
            sku: (
              await prisma.item.findUnique({ where: { id: firstIds.itemId } })
            ).sku,
            itemName: "Outbound Item",
            orderedQuantity: "8",
            unit: "EA",
          },
        },
      },
    });
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const outcomes = await Promise.allSettled([
        command(clientA).reserveSalesOrderInventory(
          reserveInput(firstIds, "8", "race-a"),
          identity(firstIds.tenantId, firstIds.actorId),
        ),
        command(clientB).reserveSalesOrderInventory(
          {
            salesOrderId: secondOrderId,
            expectedOrderVersion: 0,
            idempotencyKey: "race-b",
            allocations: [
              {
                salesOrderLineId: secondLineId,
                warehouseId: firstIds.warehouseId,
                location: "A-01",
                quantity: "8",
              },
            ],
          },
          identity(firstIds.tenantId, firstIds.actorId),
        ),
      ]);
      assert.equal(
        outcomes.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      const failure = outcomes.find(
        (entry) => entry.status === "rejected",
      ).reason;
      assert.ok(
        [
          "OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT",
          "RESERVATION_INSUFFICIENT_AVAILABLE",
        ].includes(failure.code),
        failure.code,
      );
      const total = await prisma.inventoryReservation.aggregate({
        where: { tenantId: firstIds.tenantId },
        _sum: { reservedQuantity: true },
      });
      assert.equal(fixed(total._sum.reservedQuantity), "8.0000");
      await assertReconciled(firstIds);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  test("independent clients serialize draft allocation and shipment posting exactly once", async () => {
    const ids = await seed();
    const service = command(),
      ctx = identity(ids.tenantId, ids.actorId);
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "4", "reserve-races"),
      ctx,
    );
    const reservationId = reserved.reservations[0].id;
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const drafts = await Promise.allSettled([
        command(clientA).createShipmentDraft(
          {
            salesOrderId: ids.salesOrderId,
            shipmentNumber: "SHIP-RACE-A",
            expectedOrderVersion: 1,
            idempotencyKey: "draft-race-a",
            lines: [
              {
                salesOrderLineId: ids.salesOrderLineId,
                allocations: [{ reservationId, quantity: "4" }],
              },
            ],
          },
          ctx,
        ),
        command(clientB).createShipmentDraft(
          {
            salesOrderId: ids.salesOrderId,
            shipmentNumber: "SHIP-RACE-B",
            expectedOrderVersion: 1,
            idempotencyKey: "draft-race-b",
            lines: [
              {
                salesOrderLineId: ids.salesOrderLineId,
                allocations: [{ reservationId, quantity: "4" }],
              },
            ],
          },
          ctx,
        ),
      ]);
      assert.equal(
        drafts.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      const shipmentId = drafts.find((entry) => entry.status === "fulfilled")
        .value.shipment.id;
      const posts = await Promise.allSettled([
        command(clientA).postShipment(
          {
            shipmentId,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-race-a",
          },
          ctx,
        ),
        command(clientB).postShipment(
          {
            shipmentId,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-race-b",
          },
          ctx,
        ),
      ]);
      assert.equal(
        posts.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      assert.equal(
        await prisma.inventoryMovement.count({
          where: { tenantId: ids.tenantId, movementType: "shipment_posting" },
        }),
        1,
      );
      assert.equal(
        fixed(
          (
            await prisma.inventoryReservation.findUnique({
              where: { id: reservationId },
            })
          ).consumedQuantity,
        ),
        "4.0000",
      );
      await assertReconciled(ids);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  test("same-order reserve and concurrent post-versus-release never produce negative quantities", async () => {
    const ids = await seed({ stock: "20", ordered: "10" }),
      ctx = identity(ids.tenantId, ids.actorId);
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const sameOrder = await Promise.allSettled([
        command(clientA).reserveSalesOrderInventory(
          reserveInput(ids, "6", "same-order-a"),
          ctx,
        ),
        command(clientB).reserveSalesOrderInventory(
          reserveInput(ids, "6", "same-order-b"),
          ctx,
        ),
      ]);
      assert.equal(
        sameOrder.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      const reservationId = sameOrder.find(
        (entry) => entry.status === "fulfilled",
      ).value.reservations[0].id;
      const draft = await command(clientA).createShipmentDraft(
        {
          salesOrderId: ids.salesOrderId,
          shipmentNumber: "SHIP-POST-RELEASE",
          expectedOrderVersion: 1,
          idempotencyKey: "draft-post-release",
          lines: [
            {
              salesOrderLineId: ids.salesOrderLineId,
              allocations: [{ reservationId, quantity: "4" }],
            },
          ],
        },
        ctx,
      );
      const race = await Promise.allSettled([
        command(clientA).postShipment(
          {
            shipmentId: draft.shipment.id,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-release-post",
          },
          ctx,
        ),
        command(clientB).releaseSalesOrderReservation(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 2,
            idempotencyKey: "post-release-release",
            reason: "Concurrent correction",
            releases: [
              { reservationId, quantity: "2", expectedReservationVersion: 1 },
            ],
          },
          ctx,
        ),
      ]);
      assert.ok(race.some((entry) => entry.status === "fulfilled"));
      for (const entry of race.filter((item) => item.status === "rejected"))
        assert.ok(
          [
            "OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT",
            "SALES_ORDER_VERSION_CONFLICT",
            "RESERVATION_VERSION_CONFLICT",
            "RESERVATION_QUANTITY_CONFLICT",
          ].includes(entry.reason.code),
          entry.reason.code,
        );
      await assertReconciled(ids);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  test("multi-balance requests acquire natural keys in stable order without uncontrolled deadlock", async () => {
    const ids = await seed({ stock: "4", ordered: "8" }),
      suffix = randomUUID(),
      ctx = identity(ids.tenantId, ids.actorId);
    const warehouse2 = `wh-2-${suffix}`,
      balance2 = `bal-2-${suffix}`;
    await prisma.warehouse.create({
      data: {
        id: warehouse2,
        tenantId: ids.tenantId,
        code: `WH2-${suffix}`,
        name: "Second Warehouse",
        status: "active",
      },
    });
    await prisma.userWarehouseScope.create({
      data: {
        id: `scope-2-${suffix}`,
        tenantId: ids.tenantId,
        userId: ids.actorId,
        warehouseId: warehouse2,
        accessLevel: "operate",
      },
    });
    const item = await prisma.item.findUnique({ where: { id: ids.itemId } });
    await prisma.inventoryBalance.create({
      data: {
        id: balance2,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: warehouse2,
        warehouseKey: warehouse2,
        location: "B-01",
        locationKey: "b-01",
        onHandQuantity: "4",
        reservedQuantity: "0",
        availableQuantity: "4",
        unit: "EA",
      },
    });
    const order2 = `so-2-${suffix}`,
      line2 = `sol-2-${suffix}`;
    await prisma.salesOrder.create({
      data: {
        id: order2,
        tenantId: ids.tenantId,
        orderNumber: `SO-MULTI-${suffix}`,
        customerName: "Multi Balance",
        workflowStatus: "confirmed",
        currency: "CNY",
        lines: {
          create: {
            id: line2,
            itemId: ids.itemId,
            sku: item.sku,
            itemName: item.name,
            orderedQuantity: "8",
            unit: "EA",
          },
        },
      },
    });
    const allocationsA = [
      {
        salesOrderLineId: ids.salesOrderLineId,
        warehouseId: ids.warehouseId,
        location: "A-01",
        quantity: "2",
      },
      {
        salesOrderLineId: ids.salesOrderLineId,
        warehouseId: warehouse2,
        location: "B-01",
        quantity: "2",
      },
    ];
    const allocationsB = [
      {
        salesOrderLineId: line2,
        warehouseId: warehouse2,
        location: "B-01",
        quantity: "2",
      },
      {
        salesOrderLineId: line2,
        warehouseId: ids.warehouseId,
        location: "A-01",
        quantity: "2",
      },
    ];
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const outcomes = await Promise.allSettled([
        command(clientA).reserveSalesOrderInventory(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 0,
            idempotencyKey: "multi-key-a",
            allocations: allocationsA,
          },
          ctx,
        ),
        command(clientB).reserveSalesOrderInventory(
          {
            salesOrderId: order2,
            expectedOrderVersion: 0,
            idempotencyKey: "multi-key-b",
            allocations: allocationsB,
          },
          ctx,
        ),
      ]);
      assert.ok(outcomes.some((entry) => entry.status === "fulfilled"));
      for (const entry of outcomes.filter((item) => item.status === "rejected"))
        assert.equal(
          entry.reason.code,
          "OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT",
        );
      for (const id of [ids.balanceId, balance2]) {
        const row = await prisma.inventoryBalance.findUnique({ where: { id } });
        assert.equal(
          fixed(row.availableQuantity),
          outboundDecimalString(
            outboundDecimalUnits(row.onHandQuantity) -
              outboundDecimalUnits(row.reservedQuantity),
          ),
        );
      }
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });
}
