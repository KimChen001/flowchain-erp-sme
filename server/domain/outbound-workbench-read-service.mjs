import { resolveProvisionedActor } from "./pilot-identity.mjs";
import {
  outboundDecimalString as fixed,
  outboundDecimalUnits as units,
} from "./outbound-transaction-policy.mjs";
import { SalesWorkbenchError } from "./sales-order-workbench-service.mjs";
import { assertAuthorized, can } from "../auth/authorization-service.mjs";

const fail = (code, message, status = 400) => {
  throw new SalesWorkbenchError(code, message, status);
};
const iso = (value) => (value ? new Date(value).toISOString() : null);
const text = (value) => String(value ?? "").trim();
const q = (value) => fixed(units(value || 0));
const activeReservation = (row) =>
  units(row.reservedQuantity) -
  units(row.consumedQuantity) -
  units(row.releasedQuantity);
const allocatable = (row) =>
  activeReservation(row) - units(row.allocatedQuantity);
const permission = (actor, code) => can({ actor, permission: code, tenantId: actor.tenantId });
const canRead = (actor, warehouseId) =>
  actor.allWarehouses || actor.readWarehouseIds?.has(text(warehouseId));
const canOperate = (actor, warehouseId) =>
  actor.allWarehouses || actor.operateWarehouseIds?.has(text(warehouseId));

function orderHeader(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    customerName: order.customerName,
    promisedDate: iso(order.promisedDate),
    currency: order.currency,
    workflowStatus: order.workflowStatus,
    reservationStatus: order.reservationStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    version: order.version,
    createdAt: iso(order.createdAt),
    updatedAt: iso(order.updatedAt),
  };
}
function lineModel(line, visibleReservations, partialScope) {
  const ordered = units(line.orderedQuantity);
  const scoped = visibleReservations.filter(
    (row) => row.salesOrderLineId === line.id,
  );
  const reserved = partialScope
    ? scoped.reduce((sum, row) => sum + activeReservation(row), 0n)
    : units(line.reservedQuantity);
  const fulfilled = partialScope
    ? scoped.reduce((sum, row) => sum + units(row.consumedQuantity), 0n)
    : units(line.fulfilledQuantity);
  return {
    id: line.id,
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    orderedQuantity: fixed(ordered),
    reservedQuantity: fixed(reserved),
    fulfilledQuantity: fixed(fulfilled),
    remainingToReserve: partialScope
      ? null
      : fixed(ordered - reserved - fulfilled),
    remainingToFulfill: partialScope ? null : fixed(ordered - fulfilled),
    quantityScope: partialScope ? "visible_warehouses_only" : "full",
    unit: line.unit,
    // A line without a price cannot be invoiced, so the page shows it.
    unitPrice:
      line.unitPrice === null || line.unitPrice === undefined
        ? null
        : fixed(units(line.unitPrice)),
    version: line.version,
  };
}
function reservationModel(row) {
  return {
    id: row.id,
    salesOrderLineId: row.salesOrderLineId,
    itemId: row.itemId,
    sku: row.sku,
    warehouseId: row.warehouseId,
    location: row.location || "",
    locationKey: row.locationKey,
    reservedQuantity: q(row.reservedQuantity),
    allocatedQuantity: q(row.allocatedQuantity),
    consumedQuantity: q(row.consumedQuantity),
    releasedQuantity: q(row.releasedQuantity),
    activeReservedQuantity: fixed(activeReservation(row)),
    allocatableQuantity: fixed(allocatable(row)),
    status: row.status,
    version: row.version,
  };
}
function shipmentModel(row) {
  return {
    id: row.id,
    shipmentNumber: row.shipmentNumber,
    salesOrderId: row.salesOrderId,
    workflowStatus: row.workflowStatus,
    postingStatus: row.postingStatus,
    version: row.version,
    postedAt: iso(row.postedAt),
    postedBy: row.postedBy
      ? { id: row.postedBy.id, name: row.postedBy.name }
      : null,
    reversedAt: iso(row.reversedAt),
    reversedBy: row.reversedBy
      ? { id: row.reversedBy.id, name: row.reversedBy.name }
      : null,
    reversalReason: row.reversalReason,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function smartLinks({ order, reservations, shipments, movements, balances }) {
  const oneShipment = shipments.length === 1 ? shipments[0] : null;
  const oneBalance = balances.length === 1 ? balances[0] : null;
  const movementSources = [
    ...new Set(movements.map((row) => row.sourceDocumentId).filter(Boolean)),
  ];
  const postingBatches = [
    ...new Set(movements.map((row) => row.postingBatchId).filter(Boolean)),
  ];
  return [
    {
      id: `order-${order.id}-reservations`,
      label: "预留记录",
      count: reservations.length,
      targetRouteId: "sales:order-detail",
      targetType: "reservation",
      targetId: order.id,
      filter: { section: "reservations" },
      enabled: reservations.length > 0,
      unavailableReason: reservations.length ? null : "暂无预留记录",
    },
    {
      id: `order-${order.id}-shipments`,
      label: "发货单",
      count: shipments.length,
      targetRouteId: oneShipment
        ? "sales:shipment-detail"
        : "sales:order-detail",
      targetType: "shipment",
      targetId: oneShipment?.id || order.id,
      filter: oneShipment ? {} : { section: "shipments" },
      enabled: shipments.length > 0,
      unavailableReason: shipments.length ? null : "暂无发货单",
    },
    {
      id: `order-${order.id}-balances`,
      label: "库存余额",
      count: balances.length,
      targetRouteId: "inventory:stock",
      targetType: "inventory_balance",
      targetId: oneBalance?.id || null,
      filter: oneBalance
        ? {
            sku: oneBalance.sku,
            warehouseId: oneBalance.warehouseId,
            locationKey: oneBalance.locationKey,
          }
        : {},
      enabled: Boolean(oneBalance),
      unavailableReason: oneBalance
        ? null
        : balances.length
          ? "存在多个库存目标，请在库存页面手动筛选"
          : "当前授权仓库没有余额记录",
    },
    {
      id: `order-${order.id}-movements`,
      label: "库存流水",
      count: movements.length,
      targetRouteId: "inventory:movements",
      targetType: "inventory_movement",
      targetId: order.id,
      filter: {
        relatedSalesOrderId: order.id,
        ...(movementSources.length === 1
          ? { sourceDocumentId: movementSources[0] }
          : {}),
        ...(postingBatches.length === 1
          ? { postingBatchId: postingBatches[0] }
          : {}),
      },
      enabled: movements.length > 0,
      unavailableReason: movements.length ? null : "暂无库存流水",
    },
    {
      id: `order-${order.id}-audit`,
      label: "审计记录",
      count: null,
      targetRouteId: "settings:audit",
      targetType: "audit",
      targetId: order.id,
      // entityLabel names the order on the audit page by its number.
      filter: { entityType: "SalesOrder", entityId: order.id, entityLabel: order.orderNumber },
      enabled: true,
      unavailableReason: null,
    },
  ];
}

function reconciliation(order, balances, movements, partialScope = false) {
  const checks = [];
  for (const row of balances) {
    const calculated = units(row.onHandQuantity) - units(row.reservedQuantity),
      recorded = units(row.availableQuantity);
    checks.push({
      status: calculated === recorded ? "matched" : "mismatch",
      rule: "available = onHand - reserved",
      affectedEntity: { type: "InventoryBalance", id: row.id },
      calculated: fixed(calculated),
      recorded: fixed(recorded),
      difference: fixed(recorded - calculated),
      evidenceLinks: [{ type: "inventory_balance", id: row.id }],
    });
  }
  for (const line of partialScope ? [] : order.lines) {
    const ordered = units(line.orderedQuantity),
      reserved = units(line.reservedQuantity),
      fulfilled = units(line.fulfilledQuantity),
      valid =
        reserved >= 0n && fulfilled >= 0n && reserved + fulfilled <= ordered;
    checks.push({
      status: valid ? "matched" : "mismatch",
      rule: "reserved + fulfilled <= ordered",
      affectedEntity: { type: "SalesOrderLine", id: line.id },
      calculated: fixed(reserved + fulfilled),
      recorded: fixed(ordered),
      difference: fixed(ordered - reserved - fulfilled),
      evidenceLinks: [{ type: "sales_order", id: order.id }],
    });
  }
  for (const row of order.reservations) {
    const valid =
      units(row.consumedQuantity) + units(row.releasedQuantity) <=
        units(row.reservedQuantity) &&
      units(row.allocatedQuantity) <= activeReservation(row);
    checks.push({
      status: valid ? "matched" : "mismatch",
      rule: "reservation quantities reconcile",
      affectedEntity: { type: "InventoryReservation", id: row.id },
      calculated: fixed(
        units(row.consumedQuantity) +
          units(row.releasedQuantity) +
          units(row.allocatedQuantity),
      ),
      recorded: q(row.reservedQuantity),
      difference: fixed(activeReservation(row) - units(row.allocatedQuantity)),
      evidenceLinks: [{ type: "reservation", id: row.id }],
    });
  }
  for (const shipment of order.shipments)
    for (const line of shipment.lines || []) {
      const allocationIds = new Set(line.allocations.map((row) => row.id)),
        effective = movements
          .filter((row) => allocationIds.has(row.sourceDocumentLineId))
          .reduce(
            (sum, row) =>
              sum +
              (row.movementType === "shipment_posting"
                ? units(row.quantityOut)
                : row.movementType === "shipment_reversal"
                  ? -units(row.quantityIn)
                  : 0n),
            0n,
          );
      const recorded =
        shipment.postingStatus === "reversed" ? 0n : units(line.postedQuantity);
      checks.push({
        status: effective === recorded ? "matched" : "mismatch",
        rule: "posted quantity = posting movements - reversals",
        affectedEntity: { type: "ShipmentLine", id: line.id },
        calculated: fixed(effective),
        recorded: fixed(recorded),
        difference: fixed(recorded - effective),
        evidenceLinks: [{ type: "shipment", id: shipment.id }],
      });
    }
  return {
    status: checks.some((row) => row.status === "mismatch")
      ? "mismatch"
      : checks.length
        ? "matched"
        : "unavailable",
    checks,
  };
}

// Audit rows keep the summary the command wrote, in English ("Shipment
// SH-202611-0001 posted."). The timeline titles them by action when it is
// read, like its reservation and movement titles, and the page translates
// the title (src/modules/sales/outboundCopy.ts). The summary names the
// shipment or order and any reason given; the stored row is unchanged.
export const OUTBOUND_AUDIT_TITLES = Object.freeze({
  sales_inventory_reserved: "已为订单预留库存",
  sales_reservation_released: "已释放库存预留",
  shipment_draft_created: "发货单已创建",
  shipment_draft_cancelled: "发货单已取消",
  sales_shipment_posted: "发货单已过账",
  sales_shipment_reversed: "发货单已冲销",
  create_sales_order_draft: "销售订单草稿已创建",
  revise_sales_order_draft: "销售订单草稿已修改",
  confirm_sales_order: "销售订单已确认",
  hold_sales_order: "销售订单已暂停",
  resume_sales_order: "销售订单已恢复",
  sales_order_cancelled: "销售订单已取消",
});

export function outboundAuditTimelineText(row, { orderNumber = "", shipmentNumbers = new Map() } = {}) {
  const title = OUTBOUND_AUDIT_TITLES[row.action];
  if (!title) return { title: row.summary, summary: row.summary };
  const number = row.entityType === "ShipmentDocument" ? shipmentNumbers.get(row.entityId) || "" : orderNumber;
  // "…cancelled: <reason>" / "…reversed: <reason>" / "…released: <reason>".
  const reason = /^[^:]*:\s+(.+)$/.exec(String(row.summary || ""))?.[1]?.trim() || "";
  return { title, summary: [number, reason].filter(Boolean).join(" · ") };
}

// The outbound commands that post and reverse a shipment
// (OUTBOUND_COMMAND_TYPES in outbound-posting-command-service.mjs).
const SHIPMENT_POSTING_COMMAND = "post_sales_shipment",
  SHIPMENT_REVERSAL_COMMAND = "reverse_sales_shipment";
const commandKey = (commandType, idempotencyKey) => `${text(commandType)}\u0000${text(idempotencyKey)}`;
const timeOf = (value) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
};

// Every event on the order timeline is placed and shown at its business time,
// on one clock. A history import replays an order's commands at the business
// time it imports, while the records themselves are written when the import
// runs: a posted shipment and its stock movements carry the business time, but
// the reservation events and audit records carry the import run. Ordered by
// those creation times, the goods left a day before the shipment existed. So:
// a stock movement is at its occurredAt; an event of a shipment posting or
// reversal at the shipment's postedAt or reversedAt (the time on its
// movements); an event of any other command at the time the command
// completed, which the command takes from the same clock; anything else at the
// time it was recorded. Events at the same time keep the order they were
// recorded in, so a command's reservation events, movements and audit record
// read in the order they were written.
function timelineClock(shipments, executions) {
  const shipmentsById = new Map(shipments.map((row) => [row.id, row])),
    byId = new Map(),
    byKey = new Map();
  for (const execution of executions) {
    if (!execution?.id) continue;
    byId.set(execution.id, execution);
    if (execution.idempotencyKey) byKey.set(commandKey(execution.commandType, execution.idempotencyKey), execution);
  }
  const shipmentTime = (commandType, shipmentId) => {
    const shipment = shipmentsById.get(text(shipmentId));
    if (commandType === SHIPMENT_POSTING_COMMAND) return timeOf(shipment?.postedAt);
    if (commandType === SHIPMENT_REVERSAL_COMMAND) return timeOf(shipment?.reversedAt);
    return null;
  };
  const commandTime = (execution, commandType, shipmentId) =>
    shipmentTime(commandType, shipmentId) ?? timeOf(execution?.completedAt);
  // The command an audit record wrote, by its execution id or by its command
  // type and idempotency key.
  const auditExecution = (row) =>
    byId.get(text(row.metadata?.commandExecutionId)) ||
    byKey.get(commandKey(row.metadata?.commandType || row.action, row.metadata?.idempotencyKey));
  return {
    auditExecution,
    audit: (row) => {
      const execution = auditExecution(row),
        commandType = text(row.metadata?.commandType || execution?.commandType || row.action),
        shipmentId = row.entityType === "ShipmentDocument" ? row.entityId : execution?.entityId;
      return commandTime(execution, commandType, shipmentId) ?? timeOf(row.createdAt);
    },
    reservationEvent: (row) => {
      const execution = row.commandExecution;
      return commandTime(execution, text(execution?.commandType || row.commandType), execution?.entityId) ?? timeOf(row.createdAt);
    },
    movement: (row) => timeOf(row.occurredAt) ?? timeOf(row.createdAt),
  };
}

// The command executions behind audit records that the reservation events do
// not already name (an order's draft, confirm, hold and resume commands, say).
async function auditExecutions(prisma, tenantId, audits, known) {
  const clock = timelineClock([], known);
  const missing = audits.filter((row) => !clock.auditExecution(row));
  const ids = [...new Set(missing.map((row) => text(row.metadata?.commandExecutionId)).filter(Boolean))],
    keys = [...new Set(missing.map((row) => text(row.metadata?.idempotencyKey)).filter(Boolean))];
  if (!ids.length && !keys.length) return [];
  return prisma.businessCommandExecution.findMany({
    where: {
      tenantId,
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(keys.length ? [{ idempotencyKey: { in: keys } }] : []),
      ],
    },
    select: { id: true, commandType: true, idempotencyKey: true, entityType: true, entityId: true, completedAt: true },
  });
}

async function evidence(
  prisma,
  actor,
  order,
  visibleShipments,
  visibleReservations,
) {
  const shipmentNumbers = new Map(visibleShipments.map((row) => [row.id, row.shipmentNumber]));
  const shipmentIds = visibleShipments.map((row) => row.id),
    reservationIds = visibleReservations.map((row) => row.id);
  const [audits, events, movements] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        tenantId: actor.tenantId,
        OR: [
          { entityType: "SalesOrder", entityId: order.id },
          ...(shipmentIds.length
            ? [
                {
                  entityType: "ShipmentDocument",
                  entityId: { in: shipmentIds },
                },
              ]
            : []),
        ],
      },
      include: { actor: true },
      orderBy: { createdAt: "asc" },
    }),
    reservationIds.length
      ? prisma.inventoryReservationEvent.findMany({
          where: {
            tenantId: actor.tenantId,
            reservationId: { in: reservationIds },
          },
          include: { actor: true, commandExecution: true },
          orderBy: { createdAt: "asc" },
        })
      : [],
    prisma.inventoryMovement.findMany({
      where: { tenantId: actor.tenantId, relatedSalesOrderId: order.id },
      orderBy: { occurredAt: "asc" },
    }),
  ]);
  const lifecycleActions = new Set([
    "create_sales_order_draft",
    "revise_sales_order_draft",
    "confirm_sales_order",
    "hold_sales_order",
    "resume_sales_order",
  ]);
  const visibleReservationIds = new Set(reservationIds);
  const visibleAudits = audits.filter((row) => {
    if (row.entityType === "ShipmentDocument")
      return shipmentIds.includes(row.entityId);
    if (row.entityType !== "SalesOrder" || row.entityId !== order.id)
      return false;
    if (lifecycleActions.has(row.action)) return true;
    const affectedReservationIds = Array.isArray(row.metadata?.reservationIds)
      ? row.metadata.reservationIds.map(text).filter(Boolean)
      : [];
    return (
      affectedReservationIds.length > 0 &&
      affectedReservationIds.every((id) => visibleReservationIds.has(id))
    );
  });
  const knownExecutions = events.map((row) => row.commandExecution).filter(Boolean);
  const clock = timelineClock(visibleShipments, [
    ...knownExecutions,
    ...(await auditExecutions(prisma, actor.tenantId, visibleAudits, knownExecutions)),
  ]);
  // A row at its business time (`at`, shown as occurredAt) and the time it
  // was recorded (recordedAt), both kept in milliseconds for the sort below.
  const stamped = (at, recordedAt, fields) => {
    const recorded = timeOf(recordedAt) ?? at;
    return { at, recorded, row: { ...fields, occurredAt: iso(at), recordedAt: iso(recorded) } };
  };
  const rows = [
    ...visibleAudits.map((row) => stamped(clock.audit(row), row.createdAt, {
      eventType: row.action,
      ...outboundAuditTimelineText(row, { orderNumber: order.orderNumber, shipmentNumbers }),
      actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
      entityType: row.entityType,
      entityId: row.entityId,
      commandType: row.metadata?.commandType || row.action,
      commandExecutionId: row.metadata?.commandExecutionId || null,
      idempotencyKey: row.metadata?.idempotencyKey || null,
      evidenceLinks: [{ type: row.entityType, id: row.entityId }],
      limitations: [],
    })),
    ...events.map((row) => stamped(clock.reservationEvent(row), row.createdAt, {
      eventType: `reservation_${row.eventType}`,
      title: `库存预留${{ reserved: "已创建", released: "已释放", allocated: "已分配", deallocated: "已取消分配", consumed: "已消耗", restored: "已恢复" }[row.eventType] || "已更新"}`,
      summary: `${q(row.quantity)} · ${row.reservationId}`,
      actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
      entityType: "InventoryReservation",
      entityId: row.reservationId,
      commandType: row.commandType,
      commandExecutionId: row.commandExecutionId,
      idempotencyKey: row.commandExecution?.idempotencyKey || null,
      evidenceLinks: [{ type: "reservation", id: row.reservationId }],
      limitations: [],
    })),
    ...movements
      .filter((row) => canRead(actor, row.warehouseId))
      .map((row) => stamped(clock.movement(row), row.createdAt, {
        eventType: row.movementType,
        title:
          row.movementType === "shipment_reversal"
            ? "发货冲销流水已创建"
            : "发货出库流水已创建",
        summary: `${row.sku} · ${row.warehouseId || "未指定仓库"} · ${q(row.quantityOut || row.quantityIn)}`,
        actor: row.actorId ? { id: row.actorId, name: row.actorId } : null,
        entityType: "InventoryMovement",
        entityId: row.id,
        commandType: row.movementType,
        commandExecutionId: null,
        idempotencyKey: null,
        evidenceLinks: [{ type: "inventory_movement", id: row.id }],
        limitations: [],
      })),
  ]
    // By business time, then by when each was recorded; a row with neither
    // time last. The sort is stable, so ties keep the order above.
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.recorded ?? Infinity) - (b.recorded ?? Infinity))
    .map((entry) => entry.row);
  const visibleMovements = movements.filter((row) =>
    canRead(actor, row.warehouseId),
  );
  return {
    timeline: rows,
    hiddenMovementFacts:
      visibleMovements.length !== movements.length ||
      visibleAudits.length !== audits.length,
    movements: visibleMovements.map((row) => ({
      id: row.id,
      movementType: row.movementType,
      sku: row.sku,
      itemName: row.itemName,
      warehouseId: row.warehouseId,
      location: row.location || "",
      quantityIn: q(row.quantityIn),
      quantityOut: q(row.quantityOut),
      postingBatchId: row.postingBatchId,
      sourceDocumentId: row.sourceDocumentId,
      sourceDocumentLineId: row.sourceDocumentLineId,
      reversalOfMovementId: row.reversalOfMovementId,
      reversedByMovementId: row.reversedByMovementId,
      occurredAt: iso(row.occurredAt),
    })),
  };
}

export function createOutboundWorkbenchReadService({
  prisma,
  capabilities = {},
} = {}) {
  if (!prisma) throw new Error("prisma is required");
  async function loadOrder(id, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    assertAuthorized({ actor, permission: "sales_order.read", tenantId: actor.tenantId });
    const order = await prisma.salesOrder.findFirst({
      where: { id: text(id), tenantId: actor.tenantId },
      include: {
        lines: { orderBy: { id: "asc" } },
        reservations: { orderBy: { reservedAt: "asc" } },
        shipments: {
          include: {
            postedBy: true,
            reversedBy: true,
            lines: { include: { allocations: true }, orderBy: { id: "asc" } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!order)
      fail("SALES_ORDER_NOT_FOUND", "Sales order was not found.", 404);
    return { actor, order };
  }
  async function orderWorkbench(id, context) {
    const { actor, order } = await loadOrder(id, context),
      itemIds = order.lines.map((line) => line.itemId);
    const allBalances = await prisma.inventoryBalance.findMany({
      where: { tenantId: actor.tenantId, itemId: { in: itemIds } },
      orderBy: [{ sku: "asc" }, { warehouseId: "asc" }, { locationKey: "asc" }],
    });
    const balances = allBalances.filter((row) =>
      canRead(actor, row.warehouseId),
    );
    const reservations = order.reservations.filter((row) =>
      canRead(actor, row.warehouseId),
    );
    const visibleShipments = order.shipments.filter((shipment) =>
      shipment.lines
        .flatMap((line) => line.allocations)
        .every((allocation) => canRead(actor, allocation.warehouseId)),
    );
    const ev = await evidence(
      prisma,
      actor,
      order,
      visibleShipments,
      reservations,
    );
    const hiddenWarehouseFacts =
      balances.length !== allBalances.length ||
      reservations.length !== order.reservations.length ||
      visibleShipments.length !== order.shipments.length ||
      ev.hiddenMovementFacts;
    const scopeCoverage = {
      status: hiddenWarehouseFacts ? "partial" : "full",
      visibleWarehouseCount: new Set(
        [
          ...balances.map((row) => row.warehouseId),
          ...reservations.map((row) => row.warehouseId),
        ].filter(Boolean),
      ).size,
      hiddenWarehouseFacts,
      limitationCodes: hiddenWarehouseFacts ? ["PARTIAL_WAREHOUSE_SCOPE"] : [],
    };
    const mutable = ["sales_order.revise", "sales_order.submit", "shipment.prepare"].some((code) => permission(actor, code)),
      lifecycleEnabled = capabilities.lifecycle?.enabled === true,
      reservationEnabled = capabilities.reservation?.enabled === true,
      confirmed = order.workflowStatus === "confirmed",
      // A fully shipped order has nothing left to hold, reserve or ship.
      shippedInFull = order.fulfillmentStatus === "fully_fulfilled",
      openToReserve = order.lines.some(
        (line) =>
          units(line.orderedQuantity) -
            units(line.reservedQuantity) -
            units(line.fulfilledQuantity) >
          0n,
      ),
      operateWarehouses = balances.filter((row) =>
        canOperate(actor, row.warehouseId),
      );
    const availableActions = {
      canEditDraft:
        lifecycleEnabled &&
        permission(actor, "sales_order.revise") &&
        order.workflowStatus === "draft",
      canConfirm:
        lifecycleEnabled &&
        permission(actor, "sales_order.submit") &&
        order.workflowStatus === "draft" &&
        order.lines.length > 0,
      canHold: lifecycleEnabled && permission(actor, "sales_order.revise") && confirmed && !shippedInFull,
      canResume:
        lifecycleEnabled && permission(actor, "sales_order.revise") && order.workflowStatus === "on_hold",
      // Cancelling releases the order's reservations and cancels its unposted
      // shipments; an order with goods shipped is not cancelled.
      canCancel:
        lifecycleEnabled &&
        permission(actor, "sales_order.cancel") &&
        ["draft", "confirmed", "on_hold"].includes(order.workflowStatus) &&
        !order.shipments.some((shipment) => shipment.postingStatus === "posted"),
      canReserve:
        reservationEnabled &&
        permission(actor, "shipment.prepare") &&
        confirmed &&
        openToReserve &&
        operateWarehouses.some((row) => units(row.availableQuantity) > 0n),
      canRelease:
        reservationEnabled &&
        permission(actor, "shipment.prepare") &&
        confirmed &&
        reservations.some(
          (row) => canOperate(actor, row.warehouseId) && allocatable(row) > 0n,
        ),
      canCreateShipment:
        capabilities.shipmentDraft?.enabled === true &&
        permission(actor, "shipment.prepare") &&
        confirmed &&
        reservations.some(
          (row) => canOperate(actor, row.warehouseId) && allocatable(row) > 0n,
        ),
      blockingReasonCodes: [],
      primaryAction: null,
    };
    if (
      !lifecycleEnabled ||
      !reservationEnabled ||
      capabilities.shipmentDraft?.enabled !== true
    )
      availableActions.blockingReasonCodes.push(
        "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
      );
    if (!mutable)
      availableActions.blockingReasonCodes.push("PERMISSION_DENIED");
    if (confirmed && !operateWarehouses.length)
      availableActions.blockingReasonCodes.push("WAREHOUSE_SCOPE_DENIED");
    availableActions.primaryAction = availableActions.canConfirm
      ? "confirm"
      : availableActions.canResume
        ? "resume"
        : availableActions.canReserve
          ? "reserve"
          : null;
    const availability = order.lines.map((line) => ({
      salesOrderLineId: line.id,
      itemId: line.itemId,
      sku: line.sku,
      itemName: line.itemName,
      totalOnHand: fixed(
        balances
          .filter((row) => row.itemId === line.itemId)
          .reduce((sum, row) => sum + units(row.onHandQuantity), 0n),
      ),
      totalReserved: fixed(
        balances
          .filter((row) => row.itemId === line.itemId)
          .reduce((sum, row) => sum + units(row.reservedQuantity), 0n),
      ),
      totalAvailable: fixed(
        balances
          .filter((row) => row.itemId === line.itemId)
          .reduce((sum, row) => sum + units(row.availableQuantity), 0n),
      ),
      balances: balances
        .filter((row) => row.itemId === line.itemId)
        .map((row) => ({
          id: row.id,
          warehouseId: row.warehouseId,
          location: row.location || "",
          locationKey: row.locationKey,
          onHandQuantity: q(row.onHandQuantity),
          reservedQuantity: q(row.reservedQuantity),
          availableQuantity: q(row.availableQuantity),
          actorScope: canOperate(actor, row.warehouseId) ? "operate" : "read",
          selectable: canOperate(actor, row.warehouseId),
        })),
    }));
    const links = smartLinks({
      order,
      reservations,
      shipments: visibleShipments,
      movements: ev.movements,
      balances,
    });
    const projectedOrder = {
      ...order,
      reservations,
      shipments: visibleShipments,
    };
    const visibleReconciliation = reconciliation(
      projectedOrder,
      balances,
      ev.movements,
      hiddenWarehouseFacts,
    );
    const recon = hiddenWarehouseFacts
      ? {
          status: "unavailable",
          reasonCode: "PARTIAL_WAREHOUSE_SCOPE",
          checks: visibleReconciliation.checks,
          visibleChecks: visibleReconciliation.checks,
        }
      : visibleReconciliation;
    return {
      dataSource: "Authoritative PostgreSQL",
      order: orderHeader(order),
      lines: order.lines.map((line) =>
        lineModel(line, reservations, hiddenWarehouseFacts),
      ),
      availability,
      reservations: reservations.map(reservationModel),
      shipments: visibleShipments.map(shipmentModel),
      movements: ev.movements,
      scopeCoverage,
      availableActions,
      smartLinks: links,
      evidence: ev.timeline,
      reconciliation: recon,
      aiExplain: {
        conclusion: hiddenWarehouseFacts
          ? "当前仅能解释已授权仓库范围，完整履约事实已隐藏。"
          : recon.status === "matched"
            ? "当前订单的库存、预留与履约事实一致。"
            : "当前订单存在需要人工复核的对账差异。",
        keyEvidence: ev.timeline
          .slice(-5)
          .map((row) => ({
            label: row.title,
            entityType: row.entityType,
            entityId: row.entityId,
          })),
        businessImpact: availableActions.canReserve
          ? "可继续预留或创建发货草稿。"
          : "当前状态、能力或权限阻止下一步交易。",
        suggestedAction: availableActions.primaryAction || "查看证据与对账结果",
        links: links.filter((row) => row.enabled).slice(0, 4),
        limitations: [
          ...(hiddenWarehouseFacts ? ["部分仓库事实因权限被隐藏。"] : []),
          "说明为确定性只读解释，不执行 Reserve、Post 或 Reverse。",
        ],
        uncertainty: hiddenWarehouseFacts
          ? "中"
          : ev.timeline.length
            ? "低"
            : "中",
      },
      capabilities,
    };
  }
  async function shipmentWorkbench(id, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    assertAuthorized({ actor, permission: "shipment.read", tenantId: actor.tenantId });
    const shipment = await prisma.shipmentDocument.findFirst({
      where: { id: text(id), tenantId: actor.tenantId },
      include: {
        postedBy: true,
        reversedBy: true,
        salesOrder: true,
        lines: {
          include: {
            salesOrderLine: true,
            allocations: {
              include: { reservation: true },
              orderBy: { id: "asc" },
            },
          },
          orderBy: { id: "asc" },
        },
      },
    });
    if (!shipment) fail("SHIPMENT_NOT_FOUND", "Shipment was not found.", 404);
    const allocations = shipment.lines.flatMap((line) => line.allocations);
    if (allocations.some((row) => !canRead(actor, row.warehouseId)))
      fail("WAREHOUSE_SCOPE_DENIED", "Shipment was not found.", 404);
    const orderData = await orderWorkbench(shipment.salesOrderId, context),
      mutable = ["shipment.prepare", "shipment.post", "shipment.reverse"].some((code) => permission(actor, code)),
      operate = allocations.every((row) => canOperate(actor, row.warehouseId)),
      confirmed = shipment.salesOrder.workflowStatus === "confirmed";
    const availableActions = {
      canCancel:
        capabilities.shipmentDraft?.enabled === true &&
        permission(actor, "shipment.prepare") &&
        operate &&
        shipment.postingStatus === "unposted" &&
        ["draft", "ready"].includes(shipment.workflowStatus),
      canPost:
        capabilities.shipmentPosting?.enabled === true &&
        permission(actor, "shipment.post") &&
        operate &&
        confirmed &&
        shipment.postingStatus === "unposted" &&
        shipment.workflowStatus === "ready",
      canReverse:
        capabilities.shipmentReversal?.enabled === true &&
        permission(actor, "shipment.reverse") &&
        operate &&
        shipment.postingStatus === "posted",
      blockingReasonCodes: [],
      primaryAction: null,
    };
    if (
      !capabilities.shipmentDraft?.enabled ||
      !capabilities.shipmentPosting?.enabled ||
      !capabilities.shipmentReversal?.enabled
    )
      availableActions.blockingReasonCodes.push(
        "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
      );
    if (
      shipment.salesOrder.workflowStatus === "on_hold" &&
      shipment.postingStatus === "unposted"
    )
      availableActions.blockingReasonCodes.push("SALES_ORDER_ON_HOLD");
    if (!mutable)
      availableActions.blockingReasonCodes.push("PERMISSION_DENIED");
    if (!operate)
      availableActions.blockingReasonCodes.push("WAREHOUSE_SCOPE_DENIED");
    availableActions.primaryAction = availableActions.canReverse
      ? "reverse"
      : availableActions.canPost
        ? "post"
        : availableActions.canCancel
          ? "cancel"
          : null;
    const movements = orderData.movements.filter(
      (row) => row.sourceDocumentId === shipment.id,
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      shipment: shipmentModel(shipment),
      salesOrder: orderHeader(shipment.salesOrder),
      lines: shipment.lines.map((line) => ({
        id: line.id,
        salesOrderLineId: line.salesOrderLineId,
        sku: line.sku,
        itemName: line.salesOrderLine.itemName,
        requestedQuantity: q(line.requestedQuantity),
        postedQuantity: q(line.postedQuantity),
        unit: line.unit,
        version: line.version,
      })),
      allocations: allocations.map((row) => ({
        id: row.id,
        reservationId: row.reservationId,
        // The item the allocation ships, so the page names it, not the reservation id.
        sku: row.reservation?.sku || null,
        warehouseId: row.warehouseId,
        location: row.location || "",
        locationKey: row.locationKey,
        quantity: q(row.quantity),
        status: row.status,
        movementLink:
          movements.find(
            (movement) =>
              movement.sourceDocumentLineId === row.id &&
              movement.movementType === "shipment_posting",
          )?.id || null,
        reversalMovementLink:
          movements.find(
            (movement) =>
              movement.sourceDocumentLineId === row.id &&
              movement.movementType === "shipment_reversal",
          )?.id || null,
      })),
      scopeCoverage: orderData.scopeCoverage,
      availableActions,
      evidence: orderData.evidence.filter(
        (row) =>
          row.entityId === shipment.id ||
          row.summary.includes(shipment.shipmentNumber) ||
          row.eventType.includes("shipment"),
      ),
      smartLinks: [
        {
          id: `shipment-${shipment.id}-order`,
          label: "销售订单",
          count: 1,
          targetRouteId: "sales:order-detail",
          targetType: "sales_order",
          targetId: shipment.salesOrderId,
          filter: {},
          enabled: true,
          unavailableReason: null,
        },
        ...orderData.smartLinks,
      ],
      reconciliation: orderData.reconciliation,
      aiExplain: orderData.aiExplain,
      movements,
      capabilities,
    };
  }
  return { orderWorkbench, shipmentWorkbench };
}
