import { createHash, randomUUID } from "node:crypto";
import {
  assertWarehouseAccess,
  resolveProvisionedActor,
} from "./pilot-identity.mjs";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import {
  buildCycleCountPostingPlan,
  buildCycleCountReviewPlan,
  buildCycleCountSubmissionPlan,
  buildInventoryAdjustmentCancellationPlan,
  buildInventoryAdjustmentPostingPlan,
  buildInventoryAdjustmentReversalPlan,
  buildStockTransferCancellationPlan,
  buildStockTransferPostingPlan,
  buildStockTransferReversalPlan,
  inventoryOperationDecimalString as fixed,
  inventoryOperationDecimalUnits as units,
} from "./inventory-operations-policy.mjs";

export class InventoryOperationsError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "InventoryOperationsError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new InventoryOperationsError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const locationKey = (value) => text(value).toLowerCase();
const commandPermissions = Object.freeze({
  create_stock_transfer: "inventory.transfer.create",
  revise_stock_transfer: "inventory.transfer.create",
  ready_stock_transfer: "inventory.transfer.create",
  cancel_stock_transfer: "inventory.transfer.create",
  post_stock_transfer: "inventory.transfer.post",
  reverse_stock_transfer: "inventory.transfer.reverse",
  create_cycle_count: "inventory.count.create",
  revise_cycle_count: "inventory.count.create",
  submit_cycle_count: "inventory.count.submit",
  review_cycle_count: "inventory.count.review",
  post_cycle_count: "inventory.count.post",
  cancel_cycle_count: "inventory.count.create",
  create_inventory_adjustment: "inventory.adjustment.create",
  revise_inventory_adjustment: "inventory.adjustment.create",
  ready_inventory_adjustment: "inventory.adjustment.approve",
  cancel_inventory_adjustment: "inventory.adjustment.create",
  post_inventory_adjustment: "inventory.adjustment.post",
  reverse_inventory_adjustment: "inventory.adjustment.reverse",
});
const reasonCodes = new Set([
  "damage",
  "shrinkage",
  "found_stock",
  "data_correction",
  "quality_disposition",
  "other",
]);

function stable(value, parentKey = "") {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => stable(entry, parentKey));
    return ["lines", "counts", "balanceIds", "expectedLineIds"].includes(
      parentKey,
    )
      ? rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : rows;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key], key)]),
    );
  return value;
}

export const inventoryOperationsRequestHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const executionWhere = (tenantId, commandType, idempotencyKey) => ({
  tenantId_commandType_idempotencyKey: {
    tenantId,
    commandType,
    idempotencyKey,
  },
});
const replay = (execution, hash) => {
  if (!execution) return null;
  if (execution.requestHash !== hash)
    fail(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      "The idempotency key was already used with a different payload.",
      409,
    );
  if (execution.status !== "completed" || !execution.resultPayload)
    fail(
      "COMMAND_EXECUTION_IN_PROGRESS",
      "The command is already in progress.",
      409,
    );
  return { ...execution.resultPayload, idempotentReplay: true };
};
const concurrencyError = (error) =>
  error?.code === "P2034" ||
  /serialization|deadlock|write conflict/i.test(text(error?.message));
const uniqueError = (error) => error?.code === "P2002";

function assertEnabled(env) {
  if (
    text(env.FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS).toLowerCase() !== "true"
  )
    fail(
      "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
      "Inventory operations require database persistence and explicit enablement.",
      409,
    );
}

function enforce(plan) {
  if (!plan.allowed) {
    const first = plan.blockingIssues[0];
    fail(first.code, first.message, first.status, first.details);
  }
  return plan;
}

async function lockTenantRows(tx, table, tenantId, ids) {
  for (const id of [...new Set(ids.map(text).filter(Boolean))].sort()) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
      tenantId,
      id,
    );
    if (!rows.length) return false;
  }
  return true;
}

async function lockBalanceIds(tx, tenantId, ids) {
  return lockTenantRows(tx, "InventoryBalance", tenantId, ids);
}

function audit({
  idFactory,
  actor,
  action,
  entityType,
  entityId,
  summary,
  commandType,
  idempotencyKey,
  metadata,
}) {
  return {
    id: idFactory(),
    tenantId: actor.tenantId,
    actorId: actor.user.id,
    source: "inventory_operations_command_service",
    module: "inventory",
    action,
    entityType,
    entityId,
    summary,
    metadata: { commandType, idempotencyKey, ...(metadata || {}) },
  };
}

function commandResult(entityType, entityId, extra = {}) {
  return { entityType, entityId, ...extra };
}

export function createInventoryOperationsCommandService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function execute(commandType, input, context, work) {
    assertEnabled(env);
    const identity = context?.identity || context;
    if (!identity?.authenticated || !text(identity.tenantId))
      fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    await resolveProvisionedActor(prisma, identity);
    const idempotencyKey = text(input?.idempotencyKey);
    if (!idempotencyKey)
      fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const payload = { ...(input || {}), idempotencyKey };
    const requestHash = inventoryOperationsRequestHash(payload);
    const where = executionWhere(
      identity.tenantId,
      commandType,
      idempotencyKey,
    );
    const before = replay(
      await prisma.businessCommandExecution.findUnique({ where }),
      requestHash,
    );
    if (before) return before;
    try {
      return await prisma.$transaction(
        async (tx) => {
          const actor = await resolveProvisionedActor(tx, identity);
          assertAuthorized({ actor, permission: commandPermissions[commandType], tenantId: actor.tenantId });
          const inside = replay(
            await tx.businessCommandExecution.findUnique({ where }),
            requestHash,
          );
          if (inside) return inside;
          const execution = await tx.businessCommandExecution.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              commandType,
              idempotencyKey,
              requestHash,
              status: "pending",
            },
          });
          const result = await work(tx, actor, payload);
          await tx.businessCommandExecution.update({
            where: { id: execution.id },
            data: {
              status: "completed",
              entityType: result.entityType,
              entityId: result.entityId,
              resultPayload: result,
              completedAt: now(),
            },
          });
          return { ...result, idempotentReplay: false };
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (
        error instanceof InventoryOperationsError ||
        error?.name === "PilotIdentityError"
      )
        throw error;
      if (uniqueError(error)) {
        const result = replay(
          await prisma.businessCommandExecution.findUnique({ where }),
          requestHash,
        );
        if (result) return result;
      }
      if (concurrencyError(error) || uniqueError(error))
        fail(
          "INVENTORY_OPERATIONS_CONCURRENT_TRANSACTION_CONFLICT",
          "Inventory changed in another transaction. Refresh and retry.",
          409,
        );
      throw error;
    }
  }

  async function validateTransferLines(
    tx,
    actor,
    lines,
    { requireBalances = false } = {},
  ) {
    if (!Array.isArray(lines) || !lines.length)
      fail(
        "TRANSFER_INVALID_ROUTE",
        "At least one transfer line is required.",
        422,
      );
    const itemIds = [
      ...new Set(lines.map((line) => text(line.itemId)).filter(Boolean)),
    ];
    const warehouseIds = [
      ...new Set(
        lines
          .flatMap((line) => [
            text(line.source?.warehouseId),
            text(line.destination?.warehouseId),
          ])
          .filter(Boolean),
      ),
    ];
    const [items, warehouses] = await Promise.all([
      tx.item.findMany({
        where: {
          tenantId: actor.tenantId,
          id: { in: itemIds },
          status: "active",
        },
      }),
      tx.warehouse.findMany({
        where: {
          tenantId: actor.tenantId,
          id: { in: warehouseIds },
          status: "active",
        },
      }),
    ]);
    if (
      items.length !== itemIds.length ||
      warehouses.length !== warehouseIds.length
    )
      fail(
        "TRANSFER_INVALID_ROUTE",
        "Transfer items and warehouses must be active in the signed tenant.",
        422,
      );
    assertWarehouseAccess(actor, warehouseIds, "operate");
    const itemMap = new Map(items.map((row) => [row.id, row]));
    const normalized = lines.map((line) => {
      const item = itemMap.get(text(line.itemId)),
        quantity = units(line.quantity);
      const source = {
        warehouseId: text(line.source?.warehouseId),
        location: text(line.source?.location),
        locationKey: locationKey(line.source?.location),
      };
      const destination = {
        warehouseId: text(line.destination?.warehouseId),
        location: text(line.destination?.location),
        locationKey: locationKey(line.destination?.location),
      };
      if (
        !item ||
        quantity <= 0n ||
        `${source.warehouseId}|${source.locationKey}` ===
          `${destination.warehouseId}|${destination.locationKey}`
      )
        fail(
          "TRANSFER_INVALID_ROUTE",
          "Transfer lines require a positive quantity and distinct routes.",
          422,
        );
      return {
        itemId: item.id,
        sku: item.sku,
        itemName: item.name,
        unit: item.unit,
        quantity: fixed(quantity),
        source,
        destination,
      };
    });
    if (requireBalances) {
      const keys = normalized.flatMap((line) =>
        [line.source, line.destination].map((leg) => ({
          sku: line.sku,
          warehouseKey: leg.warehouseId,
          locationKey: leg.locationKey,
        })),
      );
      const balances = await tx.inventoryBalance.findMany({
        where: { tenantId: actor.tenantId, OR: keys },
      });
      const found = new Set(
        balances.map(
          (row) => `${row.sku}|${row.warehouseKey}|${row.locationKey}`,
        ),
      );
      for (const line of normalized) {
        if (
          !found.has(
            `${line.sku}|${line.source.warehouseId}|${line.source.locationKey}`,
          )
        )
          fail(
            "TRANSFER_SOURCE_BALANCE_NOT_FOUND",
            `Source balance for ${line.sku} was not found.`,
            409,
          );
        if (
          !found.has(
            `${line.sku}|${line.destination.warehouseId}|${line.destination.locationKey}`,
          )
        )
          fail(
            "TRANSFER_DESTINATION_BALANCE_NOT_FOUND",
            `Destination balance for ${line.sku} was not found.`,
            409,
          );
      }
    }
    return normalized;
  }

  async function createTransfer(input, context) {
    return execute(
      "create_stock_transfer",
      input,
      context,
      async (tx, actor, payload) => {
        const transferNumber = text(payload.transferNumber);
        if (!transferNumber)
          fail("TRANSFER_INVALID_ROUTE", "transferNumber is required.", 422);
        if (
          await tx.stockTransferDocument.findFirst({
            where: { tenantId: actor.tenantId, transferNumber },
          })
        )
          fail(
            "TRANSFER_NUMBER_CONFLICT",
            "Transfer number is already in use.",
            409,
          );
        const lines = await validateTransferLines(tx, actor, payload.lines);
        const transfer = await tx.stockTransferDocument.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            transferNumber,
            lines: {
              create: lines.map((line) => ({
                id: idFactory(),
                itemId: line.itemId,
                sku: line.sku,
                itemName: line.itemName,
                quantity: line.quantity,
                unit: line.unit,
                legs: {
                  create: [
                    {
                      id: idFactory(),
                      tenantId: actor.tenantId,
                      direction: "source",
                      ...line.source,
                    },
                    {
                      id: idFactory(),
                      tenantId: actor.tenantId,
                      direction: "destination",
                      ...line.destination,
                    },
                  ],
                },
              })),
            },
          },
          include: { lines: { include: { legs: true } } },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "stock_transfer_created",
            entityType: "StockTransferDocument",
            entityId: transfer.id,
            summary: `Stock transfer ${transfer.transferNumber} draft created.`,
            commandType: "create_stock_transfer",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("StockTransferDocument", transfer.id, {
          transfer,
        });
      },
    );
  }

  async function reviseTransfer(id, input, context) {
    return execute(
      "revise_stock_transfer",
      { ...input, transferId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "StockTransferDocument", actor.tenantId, [
            payload.transferId,
          ]))
        )
          fail("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404);
        const transfer = await tx.stockTransferDocument.findFirst({
          where: { id: payload.transferId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        if (
          transfer.workflowStatus !== "draft" ||
          transfer.postingStatus !== "unposted"
        )
          fail(
            "INVENTORY_OPERATION_INVALID_STATE",
            "Only draft transfers can be revised.",
            409,
          );
        if (transfer.version !== Number(payload.expectedTransferVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Transfer version does not match.",
            409,
          );
        const expected = Array.isArray(payload.expectedLineIds)
            ? payload.expectedLineIds.map(text).sort()
            : [],
          current = transfer.lines.map((line) => line.id).sort();
        if (
          payload.revisionMode !== "replace_all" ||
          expected.length !== current.length ||
          expected.some((value, index) => value !== current[index])
        )
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Transfer lines changed and an incomplete replacement was blocked.",
            409,
          );
        const lines = await validateTransferLines(tx, actor, payload.lines);
        await tx.stockTransferLine.deleteMany({
          where: { transferId: transfer.id },
        });
        const updated = await tx.stockTransferDocument.update({
          where: { id: transfer.id },
          data: {
            version: { increment: 1 },
            lines: {
              create: lines.map((line) => ({
                id: idFactory(),
                itemId: line.itemId,
                sku: line.sku,
                itemName: line.itemName,
                quantity: line.quantity,
                unit: line.unit,
                legs: {
                  create: [
                    {
                      id: idFactory(),
                      tenantId: actor.tenantId,
                      direction: "source",
                      ...line.source,
                    },
                    {
                      id: idFactory(),
                      tenantId: actor.tenantId,
                      direction: "destination",
                      ...line.destination,
                    },
                  ],
                },
              })),
            },
          },
          include: { lines: { include: { legs: true } } },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "stock_transfer_revised",
            entityType: "StockTransferDocument",
            entityId: transfer.id,
            summary: `Stock transfer ${transfer.transferNumber} revised.`,
            commandType: "revise_stock_transfer",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("StockTransferDocument", transfer.id, {
          transfer: updated,
        });
      },
    );
  }

  async function readyTransfer(id, input, context) {
    return execute(
      "ready_stock_transfer",
      { ...input, transferId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "StockTransferDocument", actor.tenantId, [
            payload.transferId,
          ]))
        )
          fail("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404);
        const transfer = await tx.stockTransferDocument.findFirst({
          where: { id: payload.transferId, tenantId: actor.tenantId },
          include: { lines: { include: { legs: true } } },
        });
        if (
          transfer.workflowStatus !== "draft" ||
          transfer.version !== Number(payload.expectedTransferVersion)
        )
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Transfer is no longer an editable draft.",
            409,
          );
        await validateTransferLines(
          tx,
          actor,
          transfer.lines.map((line) => {
            const source = line.legs.find((leg) => leg.direction === "source"),
              destination = line.legs.find(
                (leg) => leg.direction === "destination",
              );
            return {
              itemId: line.itemId,
              quantity: fixed(units(line.quantity)),
              source,
              destination,
            };
          }),
          { requireBalances: true },
        );
        const updated = await tx.stockTransferDocument.update({
          where: { id: transfer.id },
          data: { workflowStatus: "ready", version: { increment: 1 } },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "stock_transfer_ready",
            entityType: "StockTransferDocument",
            entityId: transfer.id,
            summary: `Stock transfer ${transfer.transferNumber} is ready.`,
            commandType: "ready_stock_transfer",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("StockTransferDocument", transfer.id, {
          transfer: updated,
        });
      },
    );
  }

  async function postTransfer(id, input, context) {
    return execute(
      "post_stock_transfer",
      { ...input, transferId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "StockTransferDocument", actor.tenantId, [
            payload.transferId,
          ]))
        )
          fail("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404);
        const aggregate = await tx.stockTransferDocument.findFirst({
          where: { id: payload.transferId, tenantId: actor.tenantId },
          include: { lines: { include: { legs: true } } },
        });
        if (aggregate.version !== Number(payload.expectedTransferVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Transfer version does not match.",
            409,
          );
        assertWarehouseAccess(
          actor,
          aggregate.lines.flatMap((line) =>
            line.legs.map((leg) => leg.warehouseId),
          ),
          "operate",
        );
        const balanceIds = (
          await buildStockTransferPostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            transferId: aggregate.id,
          })
        ).balanceImpacts.map((row) => row.balanceId);
        await lockBalanceIds(tx, actor.tenantId, balanceIds);
        const plan = enforce(
          await buildStockTransferPostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            transferId: aggregate.id,
          }),
        );
        const postingBatchId = idFactory(),
          movementIds = [];
        for (const impact of plan.balanceImpacts) {
          const updated = await tx.inventoryBalance.updateMany({
            where: {
              id: impact.balanceId,
              tenantId: actor.tenantId,
              version: impact.version,
            },
            data: {
              onHandQuantity: impact.onHandAfter,
              reservedQuantity: impact.reservedAfter,
              availableQuantity: impact.availableAfter,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1)
            fail(
              "INVENTORY_OPERATIONS_CONCURRENT_TRANSACTION_CONFLICT",
              "Inventory balance changed during transfer posting.",
              409,
            );
        }
        for (const fact of plan.movementFacts) {
          const movement = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              warehouseId: fact.warehouseId,
              location: fact.location || null,
              locationKey: fact.locationKey,
              movementType: fact.movementType,
              movementLabel: fact.movementType,
              sourceDocumentType: "StockTransferDocument",
              sourceDocumentId: aggregate.id,
              sourceDocumentLineId: fact.legId,
              postingBatchId,
              quantityIn: fact.quantityIn,
              quantityOut: fact.quantityOut,
              adjustmentQty: fact.adjustmentQty,
              status: "posted",
              unit: fact.unit,
              actorId: actor.user.id,
              occurredAt: now(),
              metadata: {
                balanceId: fact.balanceId,
                transferLineId: fact.lineId,
              },
            },
          });
          movementIds.push(movement.id);
        }
        const transfer = await tx.stockTransferDocument.update({
          where: { id: aggregate.id },
          data: {
            postingStatus: "posted",
            postedAt: now(),
            postedById: actor.user.id,
            version: { increment: 1 },
            metadata: { postingBatchId },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "stock_transfer_posted",
            entityType: "StockTransferDocument",
            entityId: aggregate.id,
            summary: `Stock transfer ${aggregate.transferNumber} posted.`,
            commandType: "post_stock_transfer",
            idempotencyKey: payload.idempotencyKey,
            metadata: { postingBatchId, movementIds },
          }),
        });
        return commandResult("StockTransferDocument", aggregate.id, {
          transfer,
          postingBatchId,
          movementIds,
        });
      },
    );
  }

  async function cancelTransfer(id, input, context) {
    return execute(
      "cancel_stock_transfer",
      { ...input, transferId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "StockTransferDocument", actor.tenantId, [
            payload.transferId,
          ]))
        )
          fail("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404);
        const plan = enforce(
          await buildStockTransferCancellationPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            transferId: payload.transferId,
            reason: payload.reason,
          }),
        );
        if (plan.transfer.version !== Number(payload.expectedTransferVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Transfer version does not match.",
            409,
          );
        const transfer = await tx.stockTransferDocument.update({
          where: { id: payload.transferId },
          data: {
            workflowStatus: "cancelled",
            cancellationReason: text(payload.reason),
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "stock_transfer_cancelled",
            entityType: "StockTransferDocument",
            entityId: transfer.id,
            summary: `Stock transfer ${transfer.transferNumber} cancelled.`,
            commandType: "cancel_stock_transfer",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("StockTransferDocument", transfer.id, {
          transfer,
        });
      },
    );
  }

  async function reverseTransfer(id, input, context) {
    return execute(
      "reverse_stock_transfer",
      { ...input, transferId: id },
      context,
      async (tx, actor, payload) => {
        if (!text(payload.reason))
          fail(
            "TRANSFER_REVERSAL_NOT_SAFE",
            "A reversal reason is required.",
            422,
          );
        if (
          !(await lockTenantRows(tx, "StockTransferDocument", actor.tenantId, [
            payload.transferId,
          ]))
        )
          fail("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404);
        const aggregate = await tx.stockTransferDocument.findFirst({
          where: { id: payload.transferId, tenantId: actor.tenantId },
          include: { lines: { include: { legs: true } } },
        });
        if (aggregate.version !== Number(payload.expectedTransferVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Transfer version does not match.",
            409,
          );
        assertWarehouseAccess(
          actor,
          aggregate.lines.flatMap((line) =>
            line.legs.map((leg) => leg.warehouseId),
          ),
          "operate",
        );
        const first = await buildStockTransferReversalPlan({
          prisma: tx,
          tenantId: actor.tenantId,
          transferId: aggregate.id,
        });
        await lockBalanceIds(
          tx,
          actor.tenantId,
          first.balanceImpacts.map((row) => row.balanceId),
        );
        const plan = enforce(
          await buildStockTransferReversalPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            transferId: aggregate.id,
          }),
        );
        const postingBatchId = idFactory(),
          movementIds = [];
        for (const impact of plan.balanceImpacts) {
          const updated = await tx.inventoryBalance.updateMany({
            where: {
              id: impact.balanceId,
              tenantId: actor.tenantId,
              version: impact.version,
            },
            data: {
              onHandQuantity: impact.onHandAfter,
              reservedQuantity: impact.reservedAfter,
              availableQuantity: impact.availableAfter,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1)
            fail(
              "INVENTORY_OPERATIONS_CONCURRENT_TRANSACTION_CONFLICT",
              "Inventory changed during transfer reversal.",
              409,
            );
        }
        for (const fact of plan.movementFacts) {
          const movement = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              warehouseId: fact.warehouseId,
              location: fact.location || null,
              locationKey: fact.locationKey,
              movementType: fact.movementType,
              movementLabel: fact.movementType,
              sourceDocumentType: "StockTransferDocument",
              sourceDocumentId: aggregate.id,
              sourceDocumentLineId: `${fact.legId}:reversal`,
              postingBatchId,
              reversalOfMovementId: fact.originalMovementId,
              quantityIn: fact.quantityIn,
              quantityOut: fact.quantityOut,
              adjustmentQty: fact.adjustmentQty,
              status: "posted",
              unit: fact.unit,
              actorId: actor.user.id,
              occurredAt: now(),
              metadata: {
                balanceId: fact.balanceId,
                transferLineId: fact.lineId,
              },
            },
          });
          await tx.inventoryMovement.update({
            where: { id: fact.originalMovementId },
            data: { reversedByMovementId: movement.id },
          });
          movementIds.push(movement.id);
        }
        const transfer = await tx.stockTransferDocument.update({
          where: { id: aggregate.id },
          data: {
            postingStatus: "reversed",
            reversedAt: now(),
            reversedById: actor.user.id,
            reversalReason: text(payload.reason),
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "stock_transfer_reversed",
            entityType: "StockTransferDocument",
            entityId: aggregate.id,
            summary: `Stock transfer ${aggregate.transferNumber} reversed.`,
            commandType: "reverse_stock_transfer",
            idempotencyKey: payload.idempotencyKey,
            metadata: { postingBatchId, movementIds },
          }),
        });
        return commandResult("StockTransferDocument", aggregate.id, {
          transfer,
          postingBatchId,
          movementIds,
        });
      },
    );
  }

  async function createCount(input, context) {
    return execute(
      "create_cycle_count",
      input,
      context,
      async (tx, actor, payload) => {
        const countNumber = text(payload.countNumber),
          warehouseId = text(payload.warehouseId),
          balanceIds = [
            ...new Set((payload.balanceIds || []).map(text).filter(Boolean)),
          ];
        if (!countNumber || !warehouseId || !balanceIds.length)
          fail(
            "COUNT_LINE_INCOMPLETE",
            "Count number, warehouse, and balance lines are required.",
            422,
          );
        assertWarehouseAccess(actor, [warehouseId], "operate");
        const warehouse = await tx.warehouse.findFirst({
          where: {
            id: warehouseId,
            tenantId: actor.tenantId,
            status: "active",
          },
        });
        if (!warehouse)
          fail("COUNT_NOT_FOUND", "Count warehouse was not found.", 404);
        if (
          await tx.cycleCountSession.findFirst({
            where: { tenantId: actor.tenantId, countNumber },
          })
        )
          fail("COUNT_NUMBER_CONFLICT", "Count number is already in use.", 409);
        const balances = await tx.inventoryBalance.findMany({
          where: {
            tenantId: actor.tenantId,
            warehouseId,
            id: { in: balanceIds },
          },
          orderBy: { id: "asc" },
        });
        if (balances.length !== balanceIds.length)
          fail(
            "COUNT_NOT_FOUND",
            "One or more count balances were not found.",
            404,
          );
        const session = await tx.cycleCountSession.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            countNumber,
            warehouseId,
            blindCount: payload.blindCount === true,
            lines: {
              create: balances.map((balance) => ({
                id: idFactory(),
                inventoryBalanceId: balance.id,
                itemId: balance.itemId,
                sku: balance.sku,
                itemName: balance.itemName,
                warehouseId,
                location: balance.location,
                locationKey: balance.locationKey,
                unit: balance.unit,
                recordedOnHandQuantity: fixed(units(balance.onHandQuantity)),
                recordedReservedQuantity: fixed(units(balance.reservedQuantity)),
                recordedAvailableQuantity: fixed(units(balance.availableQuantity)),
                recordedBalanceVersion: balance.version,
              })),
            },
          },
          include: { lines: true },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "cycle_count_created",
            entityType: "CycleCountSession",
            entityId: session.id,
            summary: `Cycle count ${session.countNumber} created.`,
            commandType: "create_cycle_count",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("CycleCountSession", session.id, { session });
      },
    );
  }

  async function reviseCount(id, input, context) {
    return execute(
      "revise_cycle_count",
      { ...input, countSessionId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "CycleCountSession", actor.tenantId, [
            payload.countSessionId,
          ]))
        )
          fail("COUNT_NOT_FOUND", "Cycle count was not found.", 404);
        const session = await tx.cycleCountSession.findFirst({
          where: { id: payload.countSessionId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        assertWarehouseAccess(actor, [session.warehouseId], "operate");
        if (!["draft", "in_progress"].includes(session.workflowStatus))
          fail(
            "COUNT_INVALID_STATE",
            "Only an active count can be edited.",
            409,
          );
        if (session.version !== Number(payload.expectedSessionVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Count version does not match.",
            409,
          );
        const lineMap = new Map(session.lines.map((line) => [line.id, line]));
        for (const entry of payload.counts || []) {
          const line = lineMap.get(text(entry.countLineId)),
            counted = units(entry.countedQuantity);
          if (!line || line.version !== Number(entry.expectedLineVersion))
            fail(
              "INVENTORY_OPERATION_VERSION_CONFLICT",
              "Count line version does not match.",
              409,
            );
          if (counted < 0n)
            fail(
              "COUNT_LINE_INCOMPLETE",
              "Counted quantity cannot be negative.",
              422,
            );
          await tx.cycleCountLine.update({
            where: { id: line.id },
            data: {
              countedQuantity: fixed(counted),
              varianceQuantity: fixed(
                counted - units(line.recordedOnHandQuantity),
              ),
              version: { increment: 1 },
            },
          });
        }
        const updated = await tx.cycleCountSession.update({
          where: { id: session.id },
          data: { workflowStatus: "in_progress", version: { increment: 1 } },
          include: { lines: true },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "cycle_count_updated",
            entityType: "CycleCountSession",
            entityId: session.id,
            summary: `Cycle count ${session.countNumber} updated.`,
            commandType: "revise_cycle_count",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("CycleCountSession", session.id, {
          session: updated,
        });
      },
    );
  }

  async function submitCount(id, input, context) {
    return execute(
      "submit_cycle_count",
      { ...input, countSessionId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "CycleCountSession", actor.tenantId, [
            payload.countSessionId,
          ]))
        )
          fail("COUNT_NOT_FOUND", "Cycle count was not found.", 404);
        const plan = enforce(
          await buildCycleCountSubmissionPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            countSessionId: payload.countSessionId,
          }),
        );
        assertWarehouseAccess(actor, [plan.session.warehouseId], "operate");
        if (plan.session.version !== Number(payload.expectedSessionVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Count version does not match.",
            409,
          );
        const session = await tx.cycleCountSession.update({
          where: { id: plan.session.id },
          data: {
            workflowStatus: "submitted",
            submittedAt: now(),
            submittedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "cycle_count_submitted",
            entityType: "CycleCountSession",
            entityId: session.id,
            summary: `Cycle count ${session.countNumber} submitted.`,
            commandType: "submit_cycle_count",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("CycleCountSession", session.id, { session });
      },
    );
  }

  async function reviewCount(id, input, context) {
    return execute(
      "review_cycle_count",
      { ...input, countSessionId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "CycleCountSession", actor.tenantId, [
            payload.countSessionId,
          ]))
        )
          fail("COUNT_NOT_FOUND", "Cycle count was not found.", 404);
        const plan = enforce(
          await buildCycleCountReviewPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            countSessionId: payload.countSessionId,
          }),
        );
        assertWarehouseAccess(actor, [plan.session.warehouseId], "operate");
        if (plan.session.version !== Number(payload.expectedSessionVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Count version does not match.",
            409,
          );
        const session = await tx.cycleCountSession.update({
          where: { id: plan.session.id },
          data: {
            workflowStatus: "reviewed",
            reviewedAt: now(),
            reviewedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "cycle_count_reviewed",
            entityType: "CycleCountSession",
            entityId: session.id,
            summary: `Cycle count ${session.countNumber} reviewed.`,
            commandType: "review_cycle_count",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("CycleCountSession", session.id, { session });
      },
    );
  }

  async function postCount(id, input, context) {
    return execute(
      "post_cycle_count",
      { ...input, countSessionId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(tx, "CycleCountSession", actor.tenantId, [
            payload.countSessionId,
          ]))
        )
          fail("COUNT_NOT_FOUND", "Cycle count was not found.", 404);
        const session = await tx.cycleCountSession.findFirst({
          where: { id: payload.countSessionId, tenantId: actor.tenantId },
        });
        assertWarehouseAccess(actor, [session.warehouseId], "operate");
        if (session.version !== Number(payload.expectedSessionVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Count version does not match.",
            409,
          );
        const first = await buildCycleCountPostingPlan({
          prisma: tx,
          tenantId: actor.tenantId,
          countSessionId: session.id,
        });
        await lockBalanceIds(
          tx,
          actor.tenantId,
          first.balanceImpacts.map((row) => row.balanceId),
        );
        const plan = enforce(
          await buildCycleCountPostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            countSessionId: session.id,
          }),
        );
        const postingBatchId = idFactory(),
          movementIds = [];
        for (const impact of plan.balanceImpacts) {
          const updated = await tx.inventoryBalance.updateMany({
            where: {
              id: impact.balanceId,
              tenantId: actor.tenantId,
              version: impact.version,
            },
            data: {
              onHandQuantity: impact.onHandAfter,
              reservedQuantity: impact.reservedAfter,
              availableQuantity: impact.availableAfter,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1)
            fail(
              "COUNT_BALANCE_CHANGED",
              "A count balance changed during posting.",
              409,
            );
        }
        for (const fact of plan.movementFacts) {
          const movement = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              warehouseId: fact.warehouseId,
              location: fact.location || null,
              locationKey: fact.locationKey,
              movementType: fact.movementType,
              movementLabel: fact.movementType,
              sourceDocumentType: "CycleCountSession",
              sourceDocumentId: session.id,
              sourceDocumentLineId: fact.lineId,
              postingBatchId,
              quantityIn: fact.quantityIn,
              quantityOut: fact.quantityOut,
              adjustmentQty: fact.adjustmentQty,
              status: "posted",
              unit: fact.unit,
              actorId: actor.user.id,
              occurredAt: now(),
              metadata: { balanceId: fact.balanceId },
            },
          });
          movementIds.push(movement.id);
        }
        const updatedSession = await tx.cycleCountSession.update({
          where: { id: session.id },
          data: {
            workflowStatus: "posted",
            postedAt: now(),
            postedById: actor.user.id,
            version: { increment: 1 },
            metadata: { postingBatchId },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "cycle_count_posted",
            entityType: "CycleCountSession",
            entityId: session.id,
            summary: `Cycle count ${session.countNumber} posted.`,
            commandType: "post_cycle_count",
            idempotencyKey: payload.idempotencyKey,
            metadata: { postingBatchId, movementIds },
          }),
        });
        return commandResult("CycleCountSession", session.id, {
          session: updatedSession,
          postingBatchId,
          movementIds,
        });
      },
    );
  }

  async function cancelCount(id, input, context) {
    return execute(
      "cancel_cycle_count",
      { ...input, countSessionId: id },
      context,
      async (tx, actor, payload) => {
        if (!text(payload.reason))
          fail(
            "COUNT_INVALID_STATE",
            "A cancellation reason is required.",
            422,
          );
        if (
          !(await lockTenantRows(tx, "CycleCountSession", actor.tenantId, [
            payload.countSessionId,
          ]))
        )
          fail("COUNT_NOT_FOUND", "Cycle count was not found.", 404);
        const session = await tx.cycleCountSession.findFirst({
          where: { id: payload.countSessionId, tenantId: actor.tenantId },
        });
        assertWarehouseAccess(actor, [session.warehouseId], "operate");
        if (
          session.workflowStatus === "posted" ||
          session.workflowStatus === "cancelled"
        )
          fail(
            "COUNT_INVALID_STATE",
            "Posted or cancelled counts cannot be cancelled.",
            409,
          );
        if (session.version !== Number(payload.expectedSessionVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Count version does not match.",
            409,
          );
        const updated = await tx.cycleCountSession.update({
          where: { id: session.id },
          data: {
            workflowStatus: "cancelled",
            cancellationReason: text(payload.reason),
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "cycle_count_cancelled",
            entityType: "CycleCountSession",
            entityId: session.id,
            summary: `Cycle count ${session.countNumber} cancelled.`,
            commandType: "cancel_cycle_count",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("CycleCountSession", session.id, {
          session: updated,
        });
      },
    );
  }

  async function validateAdjustment(tx, actor, payload) {
    const reasonCode = text(payload.reasonCode);
    if (
      !reasonCodes.has(reasonCode) ||
      (reasonCode === "other" && !text(payload.notes))
    )
      fail(
        "ADJUSTMENT_REASON_REQUIRED",
        "A supported reason is required; other also requires notes.",
        422,
      );
    if (!Array.isArray(payload.lines) || !payload.lines.length)
      fail(
        "ADJUSTMENT_REASON_REQUIRED",
        "At least one adjustment line is required.",
        422,
      );
    const ids = [
      ...new Set(
        payload.lines
          .map((line) => text(line.inventoryBalanceId))
          .filter(Boolean),
      ),
    ];
    const balances = await tx.inventoryBalance.findMany({
      where: { tenantId: actor.tenantId, id: { in: ids } },
      orderBy: { id: "asc" },
    });
    if (balances.length !== ids.length)
      fail(
        "ADJUSTMENT_NOT_FOUND",
        "One or more inventory balances were not found.",
        404,
      );
    assertWarehouseAccess(
      actor,
      balances.map((row) => row.warehouseId),
      "operate",
    );
    const map = new Map(balances.map((row) => [row.id, row]));
    return {
      reasonCode,
      notes: text(payload.notes) || null,
      lines: payload.lines.map((line) => {
        const balance = map.get(text(line.inventoryBalanceId)),
          delta = units(line.adjustmentQuantity);
        if (delta === 0n)
          fail(
            "ADJUSTMENT_NEGATIVE_INVENTORY",
            "Adjustment quantity cannot be zero.",
            422,
          );
        return {
          id: line.id,
          inventoryBalanceId: balance.id,
          itemId: balance.itemId,
          sku: balance.sku,
          itemName: balance.itemName,
          warehouseId: balance.warehouseId,
          location: balance.location,
          locationKey: balance.locationKey,
          adjustmentQuantity: fixed(delta),
          unit: balance.unit,
        };
      }),
    };
  }

  async function createAdjustment(input, context) {
    return execute(
      "create_inventory_adjustment",
      input,
      context,
      async (tx, actor, payload) => {
        const adjustmentNumber = text(payload.adjustmentNumber);
        if (!adjustmentNumber)
          fail(
            "ADJUSTMENT_REASON_REQUIRED",
            "adjustmentNumber is required.",
            422,
          );
        if (
          await tx.inventoryAdjustmentDocument.findFirst({
            where: { tenantId: actor.tenantId, adjustmentNumber },
          })
        )
          fail(
            "ADJUSTMENT_NUMBER_CONFLICT",
            "Adjustment number is already in use.",
            409,
          );
        const normalized = await validateAdjustment(tx, actor, payload);
        const adjustment = await tx.inventoryAdjustmentDocument.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            adjustmentNumber,
            reasonCode: normalized.reasonCode,
            notes: normalized.notes,
            lines: {
              create: normalized.lines.map(({ id: ignored, ...line }) => ({
                id: idFactory(),
                ...line,
              })),
            },
          },
          include: { lines: true },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "inventory_adjustment_created",
            entityType: "InventoryAdjustmentDocument",
            entityId: adjustment.id,
            summary: `Inventory adjustment ${adjustment.adjustmentNumber} created.`,
            commandType: "create_inventory_adjustment",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("InventoryAdjustmentDocument", adjustment.id, {
          adjustment,
        });
      },
    );
  }

  async function reviseAdjustment(id, input, context) {
    return execute(
      "revise_inventory_adjustment",
      { ...input, adjustmentId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(
            tx,
            "InventoryAdjustmentDocument",
            actor.tenantId,
            [payload.adjustmentId],
          ))
        )
          fail(
            "ADJUSTMENT_NOT_FOUND",
            "Inventory adjustment was not found.",
            404,
          );
        const current = await tx.inventoryAdjustmentDocument.findFirst({
          where: { id: payload.adjustmentId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        if (
          current.workflowStatus !== "draft" ||
          current.version !== Number(payload.expectedAdjustmentVersion)
        )
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Adjustment is no longer an editable draft.",
            409,
          );
        const normalized = await validateAdjustment(tx, actor, payload);
        await tx.inventoryAdjustmentLine.deleteMany({
          where: { adjustmentId: current.id },
        });
        const adjustment = await tx.inventoryAdjustmentDocument.update({
          where: { id: current.id },
          data: {
            reasonCode: normalized.reasonCode,
            notes: normalized.notes,
            version: { increment: 1 },
            lines: {
              create: normalized.lines.map(({ id: ignored, ...line }) => ({
                id: idFactory(),
                ...line,
              })),
            },
          },
          include: { lines: true },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "inventory_adjustment_revised",
            entityType: "InventoryAdjustmentDocument",
            entityId: adjustment.id,
            summary: `Inventory adjustment ${adjustment.adjustmentNumber} revised.`,
            commandType: "revise_inventory_adjustment",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("InventoryAdjustmentDocument", adjustment.id, {
          adjustment,
        });
      },
    );
  }

  async function readyAdjustment(id, input, context) {
    return execute(
      "ready_inventory_adjustment",
      { ...input, adjustmentId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(
            tx,
            "InventoryAdjustmentDocument",
            actor.tenantId,
            [payload.adjustmentId],
          ))
        )
          fail(
            "ADJUSTMENT_NOT_FOUND",
            "Inventory adjustment was not found.",
            404,
          );
        const current = await tx.inventoryAdjustmentDocument.findFirst({
          where: { id: payload.adjustmentId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        if (
          current.workflowStatus !== "draft" ||
          current.version !== Number(payload.expectedAdjustmentVersion)
        )
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Adjustment is no longer an editable draft.",
            409,
          );
        await validateAdjustment(tx, actor, {
          reasonCode: current.reasonCode,
          notes: current.notes,
          lines: current.lines,
        });
        const adjustment = await tx.inventoryAdjustmentDocument.update({
          where: { id: current.id },
          data: { workflowStatus: "ready", version: { increment: 1 } },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "inventory_adjustment_ready",
            entityType: "InventoryAdjustmentDocument",
            entityId: adjustment.id,
            summary: `Inventory adjustment ${adjustment.adjustmentNumber} is ready.`,
            commandType: "ready_inventory_adjustment",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("InventoryAdjustmentDocument", adjustment.id, {
          adjustment,
        });
      },
    );
  }

  async function postAdjustment(id, input, context) {
    return execute(
      "post_inventory_adjustment",
      { ...input, adjustmentId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(
            tx,
            "InventoryAdjustmentDocument",
            actor.tenantId,
            [payload.adjustmentId],
          ))
        )
          fail(
            "ADJUSTMENT_NOT_FOUND",
            "Inventory adjustment was not found.",
            404,
          );
        const current = await tx.inventoryAdjustmentDocument.findFirst({
          where: { id: payload.adjustmentId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        if (current.version !== Number(payload.expectedAdjustmentVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Adjustment version does not match.",
            409,
          );
        assertWarehouseAccess(
          actor,
          current.lines.map((line) => line.warehouseId),
          "operate",
        );
        const first = await buildInventoryAdjustmentPostingPlan({
          prisma: tx,
          tenantId: actor.tenantId,
          adjustmentId: current.id,
        });
        await lockBalanceIds(
          tx,
          actor.tenantId,
          first.balanceImpacts.map((row) => row.balanceId),
        );
        const plan = enforce(
          await buildInventoryAdjustmentPostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            adjustmentId: current.id,
          }),
        );
        const postingBatchId = idFactory(),
          movementIds = [];
        for (const impact of plan.balanceImpacts) {
          const updated = await tx.inventoryBalance.updateMany({
            where: {
              id: impact.balanceId,
              tenantId: actor.tenantId,
              version: impact.version,
            },
            data: {
              onHandQuantity: impact.onHandAfter,
              reservedQuantity: impact.reservedAfter,
              availableQuantity: impact.availableAfter,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1)
            fail(
              "INVENTORY_OPERATIONS_CONCURRENT_TRANSACTION_CONFLICT",
              "Inventory changed during adjustment posting.",
              409,
            );
        }
        for (const fact of plan.movementFacts) {
          const movement = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              warehouseId: fact.warehouseId,
              location: fact.location || null,
              locationKey: fact.locationKey,
              movementType: fact.movementType,
              movementLabel: fact.movementType,
              sourceDocumentType: "InventoryAdjustmentDocument",
              sourceDocumentId: current.id,
              sourceDocumentLineId: fact.lineId,
              postingBatchId,
              quantityIn: fact.quantityIn,
              quantityOut: fact.quantityOut,
              adjustmentQty: fact.adjustmentQty,
              status: "posted",
              unit: fact.unit,
              actorId: actor.user.id,
              occurredAt: now(),
              metadata: { balanceId: fact.balanceId },
            },
          });
          movementIds.push(movement.id);
        }
        const adjustment = await tx.inventoryAdjustmentDocument.update({
          where: { id: current.id },
          data: {
            postingStatus: "posted",
            postedAt: now(),
            postedById: actor.user.id,
            version: { increment: 1 },
            metadata: { postingBatchId },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "inventory_adjustment_posted",
            entityType: "InventoryAdjustmentDocument",
            entityId: current.id,
            summary: `Inventory adjustment ${current.adjustmentNumber} posted.`,
            commandType: "post_inventory_adjustment",
            idempotencyKey: payload.idempotencyKey,
            metadata: { postingBatchId, movementIds },
          }),
        });
        return commandResult("InventoryAdjustmentDocument", current.id, {
          adjustment,
          postingBatchId,
          movementIds,
        });
      },
    );
  }

  async function cancelAdjustment(id, input, context) {
    return execute(
      "cancel_inventory_adjustment",
      { ...input, adjustmentId: id },
      context,
      async (tx, actor, payload) => {
        if (
          !(await lockTenantRows(
            tx,
            "InventoryAdjustmentDocument",
            actor.tenantId,
            [payload.adjustmentId],
          ))
        )
          fail(
            "ADJUSTMENT_NOT_FOUND",
            "Inventory adjustment was not found.",
            404,
          );
        const plan = enforce(
          await buildInventoryAdjustmentCancellationPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            adjustmentId: payload.adjustmentId,
            reason: payload.reason,
          }),
        );
        assertWarehouseAccess(
          actor,
          (
            await tx.inventoryAdjustmentLine.findMany({
              where: { adjustmentId: payload.adjustmentId },
            })
          ).map((line) => line.warehouseId),
          "operate",
        );
        if (
          plan.adjustment.version !== Number(payload.expectedAdjustmentVersion)
        )
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Adjustment version does not match.",
            409,
          );
        const adjustment = await tx.inventoryAdjustmentDocument.update({
          where: { id: payload.adjustmentId },
          data: {
            workflowStatus: "cancelled",
            cancellationReason: text(payload.reason),
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "inventory_adjustment_cancelled",
            entityType: "InventoryAdjustmentDocument",
            entityId: adjustment.id,
            summary: `Inventory adjustment ${adjustment.adjustmentNumber} cancelled.`,
            commandType: "cancel_inventory_adjustment",
            idempotencyKey: payload.idempotencyKey,
          }),
        });
        return commandResult("InventoryAdjustmentDocument", adjustment.id, {
          adjustment,
        });
      },
    );
  }

  async function reverseAdjustment(id, input, context) {
    return execute(
      "reverse_inventory_adjustment",
      { ...input, adjustmentId: id },
      context,
      async (tx, actor, payload) => {
        if (!text(payload.reason))
          fail(
            "ADJUSTMENT_REVERSAL_NOT_SAFE",
            "A reversal reason is required.",
            422,
          );
        if (
          !(await lockTenantRows(
            tx,
            "InventoryAdjustmentDocument",
            actor.tenantId,
            [payload.adjustmentId],
          ))
        )
          fail(
            "ADJUSTMENT_NOT_FOUND",
            "Inventory adjustment was not found.",
            404,
          );
        const current = await tx.inventoryAdjustmentDocument.findFirst({
          where: { id: payload.adjustmentId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        if (current.version !== Number(payload.expectedAdjustmentVersion))
          fail(
            "INVENTORY_OPERATION_VERSION_CONFLICT",
            "Adjustment version does not match.",
            409,
          );
        assertWarehouseAccess(
          actor,
          current.lines.map((line) => line.warehouseId),
          "operate",
        );
        const first = await buildInventoryAdjustmentReversalPlan({
          prisma: tx,
          tenantId: actor.tenantId,
          adjustmentId: current.id,
        });
        await lockBalanceIds(
          tx,
          actor.tenantId,
          first.balanceImpacts.map((row) => row.balanceId),
        );
        const plan = enforce(
          await buildInventoryAdjustmentReversalPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            adjustmentId: current.id,
          }),
        );
        const postingBatchId = idFactory(),
          movementIds = [];
        for (const impact of plan.balanceImpacts) {
          const updated = await tx.inventoryBalance.updateMany({
            where: {
              id: impact.balanceId,
              tenantId: actor.tenantId,
              version: impact.version,
            },
            data: {
              onHandQuantity: impact.onHandAfter,
              reservedQuantity: impact.reservedAfter,
              availableQuantity: impact.availableAfter,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1)
            fail(
              "INVENTORY_OPERATIONS_CONCURRENT_TRANSACTION_CONFLICT",
              "Inventory changed during adjustment reversal.",
              409,
            );
        }
        for (const fact of plan.movementFacts) {
          const movement = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              warehouseId: fact.warehouseId,
              location: fact.location || null,
              locationKey: fact.locationKey,
              movementType: fact.movementType,
              movementLabel: fact.movementType,
              sourceDocumentType: "InventoryAdjustmentDocument",
              sourceDocumentId: current.id,
              sourceDocumentLineId: `${fact.lineId}:reversal`,
              postingBatchId,
              reversalOfMovementId: fact.originalMovementId,
              quantityIn: fact.quantityIn,
              quantityOut: fact.quantityOut,
              adjustmentQty: fact.adjustmentQty,
              status: "posted",
              unit: fact.unit,
              actorId: actor.user.id,
              occurredAt: now(),
              metadata: { balanceId: fact.balanceId },
            },
          });
          await tx.inventoryMovement.update({
            where: { id: fact.originalMovementId },
            data: { reversedByMovementId: movement.id },
          });
          movementIds.push(movement.id);
        }
        const adjustment = await tx.inventoryAdjustmentDocument.update({
          where: { id: current.id },
          data: {
            postingStatus: "reversed",
            reversedAt: now(),
            reversedById: actor.user.id,
            reversalReason: text(payload.reason),
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "inventory_adjustment_reversed",
            entityType: "InventoryAdjustmentDocument",
            entityId: current.id,
            summary: `Inventory adjustment ${current.adjustmentNumber} reversed.`,
            commandType: "reverse_inventory_adjustment",
            idempotencyKey: payload.idempotencyKey,
            metadata: { postingBatchId, movementIds },
          }),
        });
        return commandResult("InventoryAdjustmentDocument", current.id, {
          adjustment,
          postingBatchId,
          movementIds,
        });
      },
    );
  }

  return {
    createTransfer,
    reviseTransfer,
    readyTransfer,
    postTransfer,
    cancelTransfer,
    reverseTransfer,
    createCount,
    reviseCount,
    submitCount,
    reviewCount,
    postCount,
    cancelCount,
    createAdjustment,
    reviseAdjustment,
    readyAdjustment,
    postAdjustment,
    cancelAdjustment,
    reverseAdjustment,
  };
}
