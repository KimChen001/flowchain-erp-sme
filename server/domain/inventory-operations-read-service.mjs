import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { can } from "../auth/authorization-service.mjs";
import {
  inventoryOperationDecimalString as fixed,
  inventoryOperationDecimalUnits as units,
} from "./inventory-operations-policy.mjs";

const text = (value) => String(value ?? "").trim();
const iso = (value) => (value ? new Date(value).toISOString() : null);
const canRead = (actor, warehouseId) =>
  actor.allWarehouses || actor.readWarehouseIds?.has(text(warehouseId));
const canOperate = (actor, warehouseId) =>
  actor.allWarehouses || actor.operateWarehouseIds?.has(text(warehouseId));
const permission = (actor, code) => can({ actor, permission: code, tenantId: actor.tenantId });
const capabilityIds = [
  "stock-transfer",
  "cycle-count",
  "inventory-adjustment-document",
];

export class InventoryOperationsReadError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "InventoryOperationsReadError";
    this.code = code;
    this.status = status;
  }
}

function page(query = {}) {
  const number = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const size = Math.min(
    100,
    Math.max(1, Number.parseInt(query.pageSize, 10) || 20),
  );
  return { page: number, pageSize: size, skip: (number - 1) * size };
}

function scopeWhere(actor, field = "warehouseId") {
  if (actor.allWarehouses) return {};
  return { [field]: { in: [...(actor.readWarehouseIds || [])] } };
}

function transferWarehouses(transfer) {
  return [
    ...new Set(
      transfer.lines.flatMap((line) => line.legs.map((leg) => leg.warehouseId)),
    ),
  ];
}

function movementModel(row) {
  return {
    id: row.id,
    movementType: row.movementType,
    sku: row.sku,
    warehouseId: row.warehouseId,
    location: row.location || "",
    locationKey: row.locationKey,
    quantityIn: fixed(units(row.quantityIn)),
    quantityOut: fixed(units(row.quantityOut)),
    adjustmentQty: fixed(units(row.adjustmentQty)),
    postingBatchId: row.postingBatchId,
    sourceDocumentLineId: row.sourceDocumentLineId,
    reversalOfMovementId: row.reversalOfMovementId,
    reversedByMovementId: row.reversedByMovementId,
    occurredAt: iso(row.occurredAt),
  };
}

function capabilitiesEnabled(capabilities) {
  return capabilityIds.every(
    (id) =>
      Object.prototype.hasOwnProperty.call(capabilities, id) &&
      capabilities[id]?.enabled === true,
  );
}

function countSnapshotVisible(session, actor) {
  if (!session.blindCount) return true;
  if (["draft", "in_progress"].includes(session.workflowStatus)) return false;
  if (session.workflowStatus === "submitted") return permission(actor, "inventory.count.review");
  if (["reviewed", "posted"].includes(session.workflowStatus)) return true;
  if (session.workflowStatus === "cancelled") return permission(actor, "inventory.count.review");
  return false;
}

function movementMatchesIdentity(row, expected) {
  const expectedUnits = (value) =>
    typeof value === "bigint" ? value : units(value || 0);
  return Boolean(
    row &&
    row.sourceDocumentType === expected.sourceDocumentType &&
    row.sourceDocumentId === expected.sourceDocumentId &&
    row.sourceDocumentLineId === expected.sourceDocumentLineId &&
    row.movementType === expected.movementType &&
    row.itemId === expected.itemId &&
    row.sku === expected.sku &&
    row.warehouseId === expected.warehouseId &&
    text(row.locationKey) === text(expected.locationKey) &&
    text(row.metadata?.balanceId) === text(expected.balanceId) &&
    (!expected.postingBatchId ||
      text(row.postingBatchId) === text(expected.postingBatchId)) &&
    units(row.quantityIn || 0) === expectedUnits(expected.quantityIn) &&
    units(row.quantityOut || 0) === expectedUnits(expected.quantityOut) &&
    units(row.adjustmentQty || 0) === expectedUnits(expected.adjustmentQty),
  );
}

function oneBySourceLine(movements, sourceDocumentLineId, movementType) {
  const matches = movements.filter(
    (row) =>
      row.sourceDocumentLineId === sourceDocumentLineId &&
      (!movementType || row.movementType === movementType),
  );
  return matches.length === 1 ? matches[0] : null;
}

async function evidence(prisma, actor, entityType, entityId, warehouseIds) {
  if (!warehouseIds.every((id) => canRead(actor, id))) return [];
  return (
    await prisma.auditLog.findMany({
      where: { tenantId: actor.tenantId, entityType, entityId },
      include: { actor: true },
      orderBy: { createdAt: "asc" },
    })
  ).map((row) => ({
    eventType: row.action,
    title: row.summary,
    summary: row.summary,
    occurredAt: iso(row.createdAt),
    actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
    entityType,
    entityId,
    commandType: row.metadata?.commandType || row.action,
    idempotencyKey: row.metadata?.idempotencyKey || null,
  }));
}

export function createInventoryOperationsReadService({
  prisma,
  capabilities = {},
} = {}) {
  if (!prisma) throw new Error("prisma is required");
  const enabled = capabilitiesEnabled(capabilities);

  async function entryData(context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const warehouseWhere = actor.allWarehouses
      ? { tenantId: actor.tenantId, status: "active" }
      : {
          tenantId: actor.tenantId,
          status: "active",
          id: { in: [...(actor.readWarehouseIds || [])] },
        };
    const [warehouses, balances, items] = await Promise.all([
      prisma.warehouse.findMany({
        where: warehouseWhere,
        orderBy: { code: "asc" },
      }),
      prisma.inventoryBalance.findMany({
        where: { tenantId: actor.tenantId, ...scopeWhere(actor) },
        orderBy: [
          { sku: "asc" },
          { warehouseId: "asc" },
          { locationKey: "asc" },
        ],
      }),
      prisma.item.findMany({
        where: { tenantId: actor.tenantId, status: "active" },
        orderBy: { sku: "asc" },
      }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      capabilities,
      warehouses: warehouses.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        canOperate: canOperate(actor, row.id),
      })),
      items: items.map((row) => ({
        id: row.id,
        sku: row.sku,
        name: row.name,
        unit: row.unit,
      })),
      balances: balances.map((row) => ({
        id: row.id,
        itemId: row.itemId,
        sku: row.sku,
        itemName: row.itemName,
        warehouseId: row.warehouseId,
        location: row.location || "",
        locationKey: row.locationKey,
        onHandQuantity: fixed(units(row.onHandQuantity)),
        reservedQuantity: fixed(units(row.reservedQuantity)),
        availableQuantity: fixed(units(row.availableQuantity)),
        unit: row.unit,
        version: row.version,
        canOperate: canOperate(actor, row.warehouseId),
      })),
    };
  }

  async function listTransfers(query, context) {
    const actor = await resolveProvisionedActor(
        prisma,
        context?.identity || context,
      ),
      paging = page(query);
    const where = {
      tenantId: actor.tenantId,
      ...(text(query.workflowStatus)
        ? { workflowStatus: text(query.workflowStatus) }
        : {}),
      ...(text(query.postingStatus)
        ? { postingStatus: text(query.postingStatus) }
        : {}),
    };
    const candidates = await prisma.stockTransferDocument.findMany({
      where,
      include: { lines: { include: { legs: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    const visible = candidates.filter((row) =>
      transferWarehouses(row).every((id) => canRead(actor, id)),
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      page: paging.page,
      pageSize: paging.pageSize,
      total: visible.length,
      capabilities,
      transfers: visible
        .slice(paging.skip, paging.skip + paging.pageSize)
        .map((row) => ({
          id: row.id,
          transferNumber: row.transferNumber,
          workflowStatus: row.workflowStatus,
          postingStatus: row.postingStatus,
          version: row.version,
          lineCount: row.lines.length,
          sourceWarehouses: [
            ...new Set(
              row.lines.flatMap((line) =>
                line.legs
                  .filter((leg) => leg.direction === "source")
                  .map((leg) => leg.warehouseId),
              ),
            ),
          ],
          destinationWarehouses: [
            ...new Set(
              row.lines.flatMap((line) =>
                line.legs
                  .filter((leg) => leg.direction === "destination")
                  .map((leg) => leg.warehouseId),
              ),
            ),
          ],
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        })),
    };
  }

  async function transferWorkbench(id, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const transfer = await prisma.stockTransferDocument.findFirst({
      where: { id: text(id), tenantId: actor.tenantId },
      include: {
        lines: {
          include: { legs: { orderBy: { direction: "asc" } } },
          orderBy: { id: "asc" },
        },
      },
    });
    const allWarehouses = transfer ? transferWarehouses(transfer) : [];
    const fullScope =
      Boolean(transfer) &&
      allWarehouses.every((warehouseId) => canRead(actor, warehouseId));
    const anyScope =
      Boolean(transfer) &&
      allWarehouses.some((warehouseId) => canRead(actor, warehouseId));
    if (!transfer || !anyScope) {
      throw new InventoryOperationsReadError(
        "TRANSFER_NOT_FOUND",
        "Stock transfer was not found.",
        404,
      );
    }
    const allMovements = await prisma.inventoryMovement.findMany({
      where: {
        tenantId: actor.tenantId,
        sourceDocumentType: "StockTransferDocument",
        sourceDocumentId: transfer.id,
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    const movements = allMovements.filter((row) =>
        canRead(actor, row.warehouseId),
      ),
      warehouses = allWarehouses,
      operate =
        fullScope &&
        warehouses.every((warehouseId) => canOperate(actor, warehouseId));
    const availableActions = {
      canEdit:
        enabled &&
        permission(actor, "inventory.transfer.create") &&
        operate &&
        transfer.workflowStatus === "draft" &&
        transfer.postingStatus === "unposted",
      canReady:
        enabled &&
        permission(actor, "inventory.transfer.create") &&
        operate &&
        transfer.workflowStatus === "draft" &&
        transfer.postingStatus === "unposted",
      canCancel:
        enabled &&
        permission(actor, "inventory.transfer.create") &&
        operate &&
        ["draft", "ready"].includes(transfer.workflowStatus) &&
        transfer.postingStatus === "unposted",
      canPost:
        enabled &&
        permission(actor, "inventory.transfer.post") &&
        operate &&
        transfer.workflowStatus === "ready" &&
        transfer.postingStatus === "unposted",
      canReverse:
        enabled &&
        permission(actor, "inventory.transfer.reverse") &&
        operate &&
        transfer.postingStatus === "posted",
      blockingReasonCodes: [],
    };
    if (!enabled)
      availableActions.blockingReasonCodes.push(
        "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
      );
    if (!operate)
      availableActions.blockingReasonCodes.push("WAREHOUSE_SCOPE_DENIED");
    const posted = allMovements.filter((row) =>
        ["stock_transfer_out", "stock_transfer_in"].includes(row.movementType),
      ),
      reversals = allMovements.filter((row) =>
        row.movementType.includes("reversal"),
      );
    const transferNet = allMovements.reduce(
      (sum, row) => sum + units(row.quantityIn) - units(row.quantityOut),
      0n,
    );
    const postingBatchId = text(transfer.metadata?.postingBatchId);
    const movementBalanceIds = [
      ...new Set(
        allMovements
          .map((row) => text(row.metadata?.balanceId))
          .filter(Boolean),
      ),
    ];
    const movementBalances = movementBalanceIds.length
      ? await prisma.inventoryBalance.findMany({
          where: {
            tenantId: actor.tenantId,
            id: { in: movementBalanceIds },
          },
        })
      : [];
    const movementBalanceMap = new Map(
      movementBalances.map((row) => [row.id, row]),
    );
    const lineChecks = transfer.lines.map((line) => {
      const source = line.legs.find((leg) => leg.direction === "source");
      const destination = line.legs.find(
        (leg) => leg.direction === "destination",
      );
      const sourceMovement = source
        ? oneBySourceLine(allMovements, source.id, "stock_transfer_out")
        : null;
      const destinationMovement = destination
        ? oneBySourceLine(allMovements, destination.id, "stock_transfer_in")
        : null;
      const sourceBalance = movementBalanceMap.get(
        text(sourceMovement?.metadata?.balanceId),
      );
      const destinationBalance = movementBalanceMap.get(
        text(destinationMovement?.metadata?.balanceId),
      );
      const sourceBalanceMatched =
        sourceBalance?.itemId === line.itemId &&
        sourceBalance?.sku === line.sku &&
        sourceBalance?.warehouseId === source?.warehouseId &&
        text(sourceBalance?.locationKey) === text(source?.locationKey);
      const destinationBalanceMatched =
        destinationBalance?.itemId === line.itemId &&
        destinationBalance?.sku === line.sku &&
        destinationBalance?.warehouseId === destination?.warehouseId &&
        text(destinationBalance?.locationKey) ===
          text(destination?.locationKey);
      const originalMatched =
        Boolean(source && destination) &&
        sourceBalanceMatched &&
        destinationBalanceMatched &&
        movementMatchesIdentity(sourceMovement, {
          sourceDocumentType: "StockTransferDocument",
          sourceDocumentId: transfer.id,
          sourceDocumentLineId: source.id,
          movementType: "stock_transfer_out",
          itemId: line.itemId,
          sku: line.sku,
          warehouseId: source.warehouseId,
          locationKey: source.locationKey,
          balanceId: sourceMovement?.metadata?.balanceId,
          postingBatchId,
          quantityIn: 0,
          quantityOut: line.quantity,
          adjustmentQty: 0,
        }) &&
        movementMatchesIdentity(destinationMovement, {
          sourceDocumentType: "StockTransferDocument",
          sourceDocumentId: transfer.id,
          sourceDocumentLineId: destination.id,
          movementType: "stock_transfer_in",
          itemId: line.itemId,
          sku: line.sku,
          warehouseId: destination.warehouseId,
          locationKey: destination.locationKey,
          balanceId: destinationMovement?.metadata?.balanceId,
          postingBatchId,
          quantityIn: line.quantity,
          quantityOut: 0,
          adjustmentQty: 0,
        });
      let reversalMatched = transfer.postingStatus !== "reversed";
      if (transfer.postingStatus === "reversed") {
        const sourceReverse = source
          ? oneBySourceLine(
              allMovements,
              `${source.id}:reversal`,
              "stock_transfer_reversal_in",
            )
          : null;
        const destinationReverse = destination
          ? oneBySourceLine(
              allMovements,
              `${destination.id}:reversal`,
              "stock_transfer_reversal_out",
            )
          : null;
        reversalMatched =
          movementMatchesIdentity(sourceReverse, {
            sourceDocumentType: "StockTransferDocument",
            sourceDocumentId: transfer.id,
            sourceDocumentLineId: `${source?.id}:reversal`,
            movementType: "stock_transfer_reversal_in",
            itemId: line.itemId,
            sku: line.sku,
            warehouseId: source?.warehouseId,
            locationKey: source?.locationKey,
            balanceId: sourceMovement?.metadata?.balanceId,
            quantityIn: line.quantity,
            quantityOut: 0,
            adjustmentQty: 0,
          }) &&
          sourceReverse?.reversalOfMovementId === sourceMovement?.id &&
          sourceMovement?.reversedByMovementId === sourceReverse?.id &&
          movementMatchesIdentity(destinationReverse, {
            sourceDocumentType: "StockTransferDocument",
            sourceDocumentId: transfer.id,
            sourceDocumentLineId: `${destination?.id}:reversal`,
            movementType: "stock_transfer_reversal_out",
            itemId: line.itemId,
            sku: line.sku,
            warehouseId: destination?.warehouseId,
            locationKey: destination?.locationKey,
            balanceId: destinationMovement?.metadata?.balanceId,
            quantityIn: 0,
            quantityOut: line.quantity,
            adjustmentQty: 0,
          }) &&
          destinationReverse?.reversalOfMovementId ===
            destinationMovement?.id &&
          destinationMovement?.reversedByMovementId === destinationReverse?.id;
      }
      return {
        rule: "transfer line movement chain",
        lineId: line.id,
        status:
          originalMatched && reversalMatched && postingBatchId
            ? "matched"
            : "mismatch",
      };
    });
    const reconciliation = {
      status: !fullScope
        ? "unavailable"
        : transfer.postingStatus === "unposted"
          ? "unavailable"
          : transferNet === 0n &&
              lineChecks.every((row) => row.status === "matched") &&
              posted.length === transfer.lines.length * 2 &&
              (transfer.postingStatus !== "reversed" ||
                reversals.length === transfer.lines.length * 2)
            ? "matched"
            : "mismatch",
      limitationCodes: fullScope ? [] : ["PARTIAL_WAREHOUSE_SCOPE"],
      checks: [
        ...lineChecks,
        {
          rule: "transfer net inventory change = 0",
          recorded: fixed(transferNet),
        },
        {
          rule: "two posting movements per line",
          recorded: String(posted.length),
          expected: String(transfer.lines.length * 2),
        },
      ],
    };
    const smartLinks = movements.map((row) => ({
      id: `movement-${row.id}`,
      label: row.movementType,
      count: 1,
      targetRouteId: "inventory:movements",
      targetType: "inventory_movement",
      targetId: row.id,
      filter: {
        sourceDocumentId: transfer.id,
        sourceDocumentLineId: row.sourceDocumentLineId,
      },
      enabled: true,
      unavailableReason: null,
    }));
    return {
      dataSource: "Authoritative PostgreSQL",
      transfer: {
        ...transfer,
        createdAt: iso(transfer.createdAt),
        updatedAt: iso(transfer.updatedAt),
        postedAt: iso(transfer.postedAt),
        reversedAt: iso(transfer.reversedAt),
      },
      lines: transfer.lines.map((line) => ({
        id: line.id,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        quantity: fixed(units(line.quantity)),
        unit: line.unit,
        version: line.version,
        source:
          line.legs.find(
            (leg) =>
              leg.direction === "source" && canRead(actor, leg.warehouseId),
          ) || null,
        destination:
          line.legs.find(
            (leg) =>
              leg.direction === "destination" &&
              canRead(actor, leg.warehouseId),
          ) || null,
      })),
      movements: movements.map(movementModel),
      availableActions,
      capabilities,
      evidence: await evidence(
        prisma,
        actor,
        "StockTransferDocument",
        transfer.id,
        warehouses,
      ),
      smartLinks,
      reconciliation,
      limitations: [
        "Atomic source-to-destination transfer; in-transit workflow is not supported.",
      ],
    };
  }

  async function listCountSessions(query, context) {
    const actor = await resolveProvisionedActor(
        prisma,
        context?.identity || context,
      ),
      paging = page(query);
    const where = {
      tenantId: actor.tenantId,
      ...scopeWhere(actor),
      ...(text(query.workflowStatus)
        ? { workflowStatus: text(query.workflowStatus) }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.cycleCountSession.count({ where }),
      prisma.cycleCountSession.findMany({
        where,
        include: { lines: true },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: paging.skip,
        take: paging.pageSize,
      }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      ...paging,
      total,
      capabilities,
      counts: rows.map((row) => ({
        id: row.id,
        countNumber: row.countNumber,
        warehouseId: row.warehouseId,
        workflowStatus: row.workflowStatus,
        blindCount: row.blindCount,
        version: row.version,
        lineCount: row.lines.length,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      })),
    };
  }

  async function countWorkbench(id, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const session = await prisma.cycleCountSession.findFirst({
      where: { id: text(id), tenantId: actor.tenantId },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    if (!session || !canRead(actor, session.warehouseId)) {
      throw new InventoryOperationsReadError(
        "COUNT_NOT_FOUND",
        "Cycle count was not found.",
        404,
      );
    }
    const reveal = countSnapshotVisible(session, actor);
    const movements = await prisma.inventoryMovement.findMany({
      where: {
        tenantId: actor.tenantId,
        sourceDocumentType: "CycleCountSession",
        sourceDocumentId: session.id,
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    const operate = canOperate(actor, session.warehouseId);
    const availableActions = {
      canEdit:
        enabled &&
        permission(actor, "inventory.count.create") &&
        operate &&
        ["draft", "in_progress"].includes(session.workflowStatus),
      canSubmit:
        enabled &&
        permission(actor, "inventory.count.submit") &&
        operate &&
        ["draft", "in_progress"].includes(session.workflowStatus) &&
        session.lines.every((line) => line.countedQuantity !== null),
      canReview:
        enabled &&
        permission(actor, "inventory.count.review") &&
        operate &&
        session.workflowStatus === "submitted",
      canPost:
        enabled &&
        permission(actor, "inventory.count.post") &&
        operate &&
        session.workflowStatus === "reviewed",
      canCancel:
        enabled &&
        permission(actor, "inventory.count.create") &&
        operate &&
        !["posted", "cancelled"].includes(session.workflowStatus),
      blockingReasonCodes: [],
    };
    if (!enabled)
      availableActions.blockingReasonCodes.push(
        "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
      );
    const balances = await prisma.inventoryBalance.findMany({
      where: {
        tenantId: actor.tenantId,
        id: { in: session.lines.map((line) => line.inventoryBalanceId) },
      },
    });
    const balanceMap = new Map(balances.map((row) => [row.id, row]));
    const checks = session.lines.map((line) => {
      if (line.countedQuantity === null)
        return {
          rule: "count line reconciliation",
          lineId: line.id,
          status: "unavailable",
        };
      const variance =
        units(line.countedQuantity) - units(line.recordedOnHandQuantity);
      const movement = oneBySourceLine(
        movements,
        line.id,
        "cycle_count_adjustment",
      );
      const balance = balanceMap.get(line.inventoryBalanceId);
      const zeroVariance = variance === 0n;
      const movementMatched = zeroVariance
        ? !movement
        : movementMatchesIdentity(movement, {
            sourceDocumentType: "CycleCountSession",
            sourceDocumentId: session.id,
            sourceDocumentLineId: line.id,
            movementType: "cycle_count_adjustment",
            itemId: line.itemId,
            sku: line.sku,
            warehouseId: line.warehouseId,
            locationKey: line.locationKey,
            balanceId: line.inventoryBalanceId,
            adjustmentQty: variance,
            quantityIn: variance > 0n ? variance : 0,
            quantityOut: variance < 0n ? -variance : 0,
          });
      const balanceMatched =
        balance &&
        units(balance.onHandQuantity) === units(line.countedQuantity) &&
        units(balance.reservedQuantity) ===
          units(line.recordedReservedQuantity) &&
        units(balance.availableQuantity) ===
          units(balance.onHandQuantity) - units(balance.reservedQuantity);
      return {
        rule: "count line reconciliation",
        lineId: line.id,
        status:
          variance === units(line.varianceQuantity) &&
          movementMatched &&
          balanceMatched
            ? "matched"
            : "mismatch",
        movementStatus: zeroVariance
          ? "no_movement_required"
          : movementMatched
            ? "matched"
            : "mismatch",
      };
    });
    return {
      dataSource: "Authoritative PostgreSQL",
      session: {
        ...session,
        submittedAt: iso(session.submittedAt),
        reviewedAt: iso(session.reviewedAt),
        postedAt: iso(session.postedAt),
        createdAt: iso(session.createdAt),
        updatedAt: iso(session.updatedAt),
      },
      lines: session.lines.map((line) => ({
        id: line.id,
        inventoryBalanceId: line.inventoryBalanceId,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        warehouseId: line.warehouseId,
        location: line.location || "",
        locationKey: line.locationKey,
        unit: line.unit,
        recordedOnHandQuantity: reveal
          ? fixed(units(line.recordedOnHandQuantity))
          : null,
        recordedReservedQuantity: reveal
          ? fixed(units(line.recordedReservedQuantity))
          : null,
        recordedAvailableQuantity: reveal
          ? fixed(units(line.recordedAvailableQuantity))
          : null,
        countedQuantity:
          line.countedQuantity === null
            ? null
            : fixed(units(line.countedQuantity)),
        varianceQuantity:
          reveal && line.varianceQuantity !== null
            ? fixed(units(line.varianceQuantity))
            : null,
        version: line.version,
      })),
      movements: movements.map(movementModel),
      availableActions,
      capabilities,
      evidence: await evidence(prisma, actor, "CycleCountSession", session.id, [
        session.warehouseId,
      ]),
      reconciliation: {
        status:
          session.workflowStatus !== "posted"
            ? "unavailable"
            : checks.every((row) => row.status === "matched")
              ? "matched"
              : "mismatch",
        checks,
      },
      limitations: [
        "Posted cycle counts cannot be reversed; use a governed inventory adjustment.",
      ],
    };
  }

  async function listAdjustments(query, context) {
    const actor = await resolveProvisionedActor(
        prisma,
        context?.identity || context,
      ),
      paging = page(query);
    const candidates = await prisma.inventoryAdjustmentDocument.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(text(query.workflowStatus)
          ? { workflowStatus: text(query.workflowStatus) }
          : {}),
        ...(text(query.postingStatus)
          ? { postingStatus: text(query.postingStatus) }
          : {}),
      },
      include: { lines: true },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    const visible = candidates.filter((row) =>
      row.lines.every((line) => canRead(actor, line.warehouseId)),
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      page: paging.page,
      pageSize: paging.pageSize,
      total: visible.length,
      capabilities,
      adjustments: visible
        .slice(paging.skip, paging.skip + paging.pageSize)
        .map((row) => ({
          id: row.id,
          adjustmentNumber: row.adjustmentNumber,
          reasonCode: row.reasonCode,
          workflowStatus: row.workflowStatus,
          postingStatus: row.postingStatus,
          version: row.version,
          lineCount: row.lines.length,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        })),
    };
  }

  async function adjustmentWorkbench(id, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const adjustment = await prisma.inventoryAdjustmentDocument.findFirst({
      where: { id: text(id), tenantId: actor.tenantId },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const warehouses = adjustment
      ? [...new Set(adjustment.lines.map((line) => line.warehouseId))]
      : [];
    if (
      !adjustment ||
      !warehouses.every((warehouseId) => canRead(actor, warehouseId))
    ) {
      throw new InventoryOperationsReadError(
        "ADJUSTMENT_NOT_FOUND",
        "Inventory adjustment was not found.",
        404,
      );
    }
    const movements = await prisma.inventoryMovement.findMany({
      where: {
        tenantId: actor.tenantId,
        sourceDocumentType: "InventoryAdjustmentDocument",
        sourceDocumentId: adjustment.id,
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    const operate = warehouses.every((warehouseId) =>
      canOperate(actor, warehouseId),
    );
    const availableActions = {
      canEdit:
        enabled &&
        permission(actor, "inventory.adjustment.create") &&
        operate &&
        adjustment.workflowStatus === "draft",
      canReady:
        enabled &&
        permission(actor, "inventory.adjustment.approve") &&
        operate &&
        adjustment.workflowStatus === "draft",
      canCancel:
        enabled &&
        permission(actor, "inventory.adjustment.create") &&
        operate &&
        ["draft", "ready"].includes(adjustment.workflowStatus) &&
        adjustment.postingStatus === "unposted",
      canPost:
        enabled &&
        permission(actor, "inventory.adjustment.post") &&
        operate &&
        adjustment.workflowStatus === "ready" &&
        adjustment.postingStatus === "unposted",
      canReverse:
        enabled &&
        permission(actor, "inventory.adjustment.reverse") &&
        operate &&
        adjustment.postingStatus === "posted",
      blockingReasonCodes: [],
    };
    if (!enabled)
      availableActions.blockingReasonCodes.push(
        "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
      );
    const lineChecks = adjustment.lines.map((line) => {
      const original = oneBySourceLine(
        movements,
        line.id,
        "inventory_adjustment",
      );
      const delta = units(line.adjustmentQuantity);
      const originalMatched = movementMatchesIdentity(original, {
        sourceDocumentType: "InventoryAdjustmentDocument",
        sourceDocumentId: adjustment.id,
        sourceDocumentLineId: line.id,
        movementType: "inventory_adjustment",
        itemId: line.itemId,
        sku: line.sku,
        warehouseId: line.warehouseId,
        locationKey: line.locationKey,
        balanceId: line.inventoryBalanceId,
        postingBatchId: adjustment.metadata?.postingBatchId,
        adjustmentQty: delta,
        quantityIn: delta > 0n ? delta : 0,
        quantityOut: delta < 0n ? -delta : 0,
      });
      let reversalMatched = adjustment.postingStatus !== "reversed";
      if (adjustment.postingStatus === "reversed") {
        const reversal = oneBySourceLine(
          movements,
          `${line.id}:reversal`,
          "inventory_adjustment_reversal",
        );
        reversalMatched =
          movementMatchesIdentity(reversal, {
            sourceDocumentType: "InventoryAdjustmentDocument",
            sourceDocumentId: adjustment.id,
            sourceDocumentLineId: `${line.id}:reversal`,
            movementType: "inventory_adjustment_reversal",
            itemId: line.itemId,
            sku: line.sku,
            warehouseId: line.warehouseId,
            locationKey: line.locationKey,
            balanceId: line.inventoryBalanceId,
            adjustmentQty: -delta,
            quantityIn: delta < 0n ? -delta : 0,
            quantityOut: delta > 0n ? delta : 0,
          }) &&
          reversal?.reversalOfMovementId === original?.id &&
          original?.reversedByMovementId === reversal?.id;
      }
      return {
        rule: "adjustment line movement chain",
        lineId: line.id,
        status: originalMatched && reversalMatched ? "matched" : "mismatch",
      };
    });
    return {
      dataSource: "Authoritative PostgreSQL",
      adjustment: {
        ...adjustment,
        postedAt: iso(adjustment.postedAt),
        reversedAt: iso(adjustment.reversedAt),
        createdAt: iso(adjustment.createdAt),
        updatedAt: iso(adjustment.updatedAt),
      },
      lines: adjustment.lines.map((line) => ({
        ...line,
        adjustmentQuantity: fixed(units(line.adjustmentQuantity)),
      })),
      movements: movements.map(movementModel),
      availableActions,
      capabilities,
      evidence: await evidence(
        prisma,
        actor,
        "InventoryAdjustmentDocument",
        adjustment.id,
        warehouses,
      ),
      smartLinks: movements.map((row) => ({
        id: `movement-${row.id}`,
        label: row.movementType,
        count: 1,
        targetRouteId: "inventory:movements",
        targetType: "inventory_movement",
        targetId: row.id,
        filter: {
          sourceDocumentId: adjustment.id,
          sourceDocumentLineId: row.sourceDocumentLineId,
        },
        enabled: true,
        unavailableReason: null,
      })),
      reconciliation: {
        status:
          adjustment.postingStatus === "unposted"
            ? "unavailable"
            : lineChecks.every((row) => row.status === "matched")
              ? "matched"
              : "mismatch",
        checks: lineChecks,
      },
      limitations: [
        "Opening stock and found stock can add an item at a location with no stock record; posting creates the record.",
      ],
    };
  }

  return {
    entryData,
    listTransfers,
    transferWorkbench,
    listCountSessions,
    countWorkbench,
    listAdjustments,
    adjustmentWorkbench,
  };
}
