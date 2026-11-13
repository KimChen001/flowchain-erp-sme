import { escapeLikePattern } from "../persistence/like-pattern.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import {
  outboundDecimalString,
  outboundDecimalUnits,
} from "./outbound-transaction-policy.mjs";

const text = (value) => String(value ?? "").trim();
const decimal = (value) =>
  outboundDecimalString(outboundDecimalUnits(value || 0));
const iso = (value) => (value ? new Date(value).toISOString() : null);

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function scopedWhere(actor) {
  if (actor.allWarehouses) return {};
  const warehouseIds = [...(actor.readWarehouseIds || [])];
  return warehouseIds.length
    ? { warehouseId: { in: warehouseIds } }
    : { warehouseId: { in: [] } };
}

function pageOptions(query = {}) {
  const page = positiveInteger(query.page, 1);
  const pageSize = positiveInteger(query.pageSize, 50, 200);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function direction(value) {
  return text(value).toLowerCase() === "asc" ? "asc" : "desc";
}

function movementOrder(query = {}) {
  const allowed = new Set([
    "occurredAt",
    "movementDate",
    "sku",
    "warehouseId",
    "movementType",
    "createdAt",
  ]);
  const sort = allowed.has(text(query.sort)) ? text(query.sort) : "occurredAt";
  return [{ [sort]: direction(query.direction) }, { id: "asc" }];
}

function balanceOrder(query = {}) {
  const allowed = new Set([
    "updatedAt",
    "sku",
    "warehouseId",
    "locationKey",
    "status",
    "createdAt",
  ]);
  const sort = allowed.has(text(query.sort)) ? text(query.sort) : "sku";
  return [
    { [sort]: direction(query.direction || (sort === "sku" ? "asc" : "desc")) },
    { id: "asc" },
  ];
}

// A movement search: the text anywhere in the SKU, item name or source
// document, ignoring case. The inventory page searches movements here because
// it shows only one page of them.
function movementSearch(query = {}) {
  const term = text(query.q);
  if (!term) return {};
  const contains = { contains: escapeLikePattern(term), mode: "insensitive" };
  return { OR: [{ sku: contains }, { itemName: contains }, { sourceDocumentId: contains }, { sourceDocument: contains }] };
}

function movementWhere(actor, query = {}) {
  return {
    tenantId: actor.tenantId,
    AND: [
      scopedWhere(actor),
      movementSearch(query),
      {
        ...(text(query.relatedSalesOrderId)
          ? { relatedSalesOrderId: text(query.relatedSalesOrderId) }
          : {}),
        ...(text(query.sourceDocumentId)
          ? { sourceDocumentId: text(query.sourceDocumentId) }
          : {}),
        ...(text(query.sourceDocumentLineId)
          ? { sourceDocumentLineId: text(query.sourceDocumentLineId) }
          : {}),
        ...(text(query.postingBatchId)
          ? { postingBatchId: text(query.postingBatchId) }
          : {}),
        ...(text(query.sku) ? { sku: text(query.sku) } : {}),
        ...(text(query.warehouseId)
          ? { warehouseId: text(query.warehouseId) }
          : {}),
        ...(text(query.locationKey)
          ? { locationKey: text(query.locationKey) }
          : {}),
        ...(text(query.movementType)
          ? { movementType: text(query.movementType) }
          : {}),
      },
    ],
  };
}

// The movement list's context: the filters a link opens it with (a sales
// order, a document, a posting batch, an item, a location), without the
// person's own type, warehouse and search choices. The type and warehouse
// menus are built over this, so they offer every type the list holds, not
// only the types on the page shown.
function movementContextWhere(actor, query = {}) {
  return movementWhere(actor, { ...query, movementType: "", warehouseId: "", q: "" });
}

// The documents a movement can come from: the model, the field holding the
// number people read, and the source document types stored for it.
const RECEIPT_SOURCE = { model: "receivingDocument", number: "documentNumber", types: ["receiving_document", "ReceivingDocument", "receipt"] };
const SOURCE_DOCUMENTS = [
  RECEIPT_SOURCE,
  { model: "shipmentDocument", number: "shipmentNumber", types: ["ShipmentDocument", "shipment"] },
  { model: "inventoryAdjustmentDocument", number: "adjustmentNumber", types: ["InventoryAdjustmentDocument"] },
  { model: "stockTransferDocument", number: "transferNumber", types: ["StockTransferDocument"] },
  { model: "cycleCountSession", number: "countNumber", types: ["CycleCountSession"] },
  { model: "returnPostingDocument", number: "postingNumber", types: ["ReturnPostingDocument"] },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sourceDocumentRef(row) {
  const kind = SOURCE_DOCUMENTS.find((entry) => entry.types.includes(text(row.sourceDocumentType)));
  if (kind === RECEIPT_SOURCE || (!kind && text(row.relatedGrnId)))
    return { kind: RECEIPT_SOURCE, id: text(row.relatedGrnId) || text(row.sourceDocumentId) };
  return kind && text(row.sourceDocumentId) ? { kind, id: text(row.sourceDocumentId) } : null;
}

// The number of each movement's source document (the receipt, shipment,
// adjustment, transfer, count or return posting) and of its sales order, read
// for the page of movements shown. A movement whose document has no number
// keeps a recorded text reference that is not an internal id, else none.
async function movementDocumentNumbers(prisma, tenantId, rows) {
  const wanted = new Map();
  for (const row of rows) {
    const ref = sourceDocumentRef(row);
    if (!ref?.id) continue;
    if (!wanted.has(ref.kind)) wanted.set(ref.kind, new Set());
    wanted.get(ref.kind).add(ref.id);
  }
  const numbers = new Map();
  await Promise.all([...wanted].map(async ([kind, ids]) => {
    const delegate = prisma[kind.model];
    if (typeof delegate?.findMany !== "function") return;
    const found = await delegate.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true, [kind.number]: true } });
    for (const document of found) if (text(document[kind.number])) numbers.set(`${kind.model}:${document.id}`, text(document[kind.number]));
  }));
  const orderIds = [...new Set(rows.map((row) => text(row.relatedSalesOrderId)).filter(Boolean))];
  const orders = orderIds.length && typeof prisma.salesOrder?.findMany === "function"
    ? await prisma.salesOrder.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true, orderNumber: true } })
    : [];
  const orderNumbers = new Map(orders.map((order) => [order.id, text(order.orderNumber)]));
  return (row) => {
    const ref = sourceDocumentRef(row);
    const recorded = text(row.sourceDocument);
    return {
      sourceDocumentNumber: (ref && numbers.get(`${ref.kind.model}:${ref.id}`)) || (recorded && !UUID.test(recorded) ? recorded : null),
      relatedSalesOrderNumber: orderNumbers.get(text(row.relatedSalesOrderId)) || null,
    };
  };
}

// Every movement type and warehouse in the list's context, for its menus.
async function movementFacets(prisma, where) {
  if (typeof prisma.inventoryMovement.groupBy !== "function") return null;
  const groups = await prisma.inventoryMovement.groupBy({ by: ["movementType", "warehouseId"], where, _count: { _all: true } });
  const types = new Map();
  for (const group of groups) if (text(group.movementType)) types.set(group.movementType, (types.get(group.movementType) || 0) + (group._count?._all || 0));
  return {
    movementTypes: [...types].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    warehouseIds: [...new Set(groups.map((group) => text(group.warehouseId)).filter(Boolean))].sort(),
  };
}

function balanceWhere(actor, query = {}) {
  return {
    tenantId: actor.tenantId,
    AND: [
      scopedWhere(actor),
      {
        ...(text(query.itemId) ? { itemId: text(query.itemId) } : {}),
        ...(text(query.sku) ? { sku: text(query.sku) } : {}),
        ...(text(query.warehouseId)
          ? { warehouseId: text(query.warehouseId) }
          : {}),
        ...(text(query.locationKey)
          ? { locationKey: text(query.locationKey) }
          : {}),
        ...(text(query.status) ? { status: text(query.status) } : {}),
      },
    ],
  };
}

function availableBalanceSelectorWhere(actor, query = {}) {
  return {
    tenantId: actor.tenantId,
    ...(String(query.includeZero || "").toLowerCase() === "true"
      ? {}
      : { availableQuantity: { gt: 0 } }),
    AND: [
      scopedWhere(actor),
      {
        ...(text(query.itemId) ? { itemId: text(query.itemId) } : {}),
        ...(text(query.sku) ? { sku: text(query.sku) } : {}),
        ...(text(query.warehouseId)
          ? { warehouseId: text(query.warehouseId) }
          : {}),
        ...(text(query.locationKey)
          ? { locationKey: text(query.locationKey) }
          : {}),
      },
    ],
  };
}

function quarantineBalanceWhere(actor, query = {}, { selector = false } = {}) {
  return {
    tenantId: actor.tenantId,
    ...(selector
      ? {
          status: "active",
          ...(String(query.includeZero || "").toLowerCase() === "true"
            ? {}
            : { onHandQuantity: { gt: 0 } }),
        }
      : {}),
    AND: [
      scopedWhere(actor),
      {
        ...(text(query.itemId) ? { itemId: text(query.itemId) } : {}),
        ...(text(query.sku) ? { sku: text(query.sku) } : {}),
        ...(text(query.warehouseId)
          ? { warehouseId: text(query.warehouseId) }
          : {}),
        ...(text(query.locationKey)
          ? { locationKey: text(query.locationKey) }
          : {}),
        ...(!selector && text(query.status)
          ? { status: text(query.status) }
          : {}),
      },
    ],
  };
}

function movementModel(row, numbers = () => ({})) {
  return {
    ...numbers(row),
    movementId: row.id,
    id: row.id,
    itemId: row.itemId,
    sku: row.sku,
    itemName: row.itemName,
    warehouseId: row.warehouseId,
    location: row.location || "",
    locationKey: row.locationKey,
    movementType: row.movementType,
    movementLabel: row.movementLabel || row.movementType,
    // Inventory adjustments record their reason code here, e.g. opening_balance.
    reason: row.reason || null,
    quantityIn: decimal(row.quantityIn),
    quantityOut: decimal(row.quantityOut),
    adjustmentQty: decimal(row.adjustmentQty),
    unit: row.unit,
    status: row.status,
    relatedSalesOrderId: row.relatedSalesOrderId,
    sourceDocumentType: row.sourceDocumentType,
    sourceDocumentId: row.sourceDocumentId,
    sourceDocumentLineId: row.sourceDocumentLineId,
    relatedGrnId: row.relatedGrnId,
    postingBatchId: row.postingBatchId,
    occurredAt: iso(row.occurredAt),
    date: iso(row.occurredAt),
  };
}

// Safety stock and reorder point are recorded on the item (the item form and
// the import write them there). A stock record carries its own pair only from
// older data, so the item's value wins and the record's is the fallback, as
// in the runtime stock status, the reorder list and the assistant. Without
// this the stock pages read 0 / 0 for every item imported with thresholds.
export function withItemStockThresholds(rows, items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const bySku = new Map(items.map((item) => [item.sku, item]));
  const recorded = (value) =>
    value !== null && value !== undefined && Number(value) > 0 ? value : null;
  return rows.map((row) => {
    const item = (row.itemId && byId.get(row.itemId)) || bySku.get(row.sku);
    return {
      ...row,
      safetyStock: recorded(item?.safetyStock) ?? row.safetyStock,
      reorderPoint: recorded(item?.reorderPoint) ?? row.reorderPoint,
    };
  });
}

function balanceModel(row) {
  return {
    id: row.id,
    itemId: row.itemId,
    sku: row.sku,
    itemName: row.itemName,
    warehouseId: row.warehouseId,
    location: row.location || "",
    locationKey: row.locationKey,
    onHandQuantity: decimal(row.onHandQuantity),
    reservedQuantity: decimal(row.reservedQuantity),
    availableQuantity: decimal(row.availableQuantity),
    safetyStock: decimal(row.safetyStock),
    reorderPoint: decimal(row.reorderPoint),
    unit: row.unit,
    status: row.status,
    riskLevel: row.riskLevel,
    version: row.version,
    updatedAt: iso(row.updatedAt),
  };
}

function availableBalanceOption(row) {
  return {
    id: row.id,
    balanceType: "available",
    itemId: row.itemId,
    sku: row.sku,
    itemName: row.itemName,
    warehouseId: row.warehouseId,
    location: row.location || "",
    locationKey: row.locationKey,
    onHandQuantity: decimal(row.onHandQuantity),
    reservedQuantity: decimal(row.reservedQuantity),
    availableQuantity: decimal(row.availableQuantity),
    quarantineQuantity: null,
    unit: row.unit,
    version: row.version,
    reservable: true,
  };
}

function quarantineBalanceModel(row) {
  return {
    id: row.id,
    balanceType: "quarantine",
    itemId: row.itemId,
    sku: row.sku,
    itemName: row.itemName,
    warehouseId: row.warehouseId,
    location: row.location || "",
    locationKey: row.locationKey,
    onHandQuantity: decimal(row.onHandQuantity),
    reservedQuantity: null,
    availableQuantity: null,
    quarantineQuantity: decimal(row.onHandQuantity),
    unit: row.unit,
    status: row.status,
    version: row.version,
    reservable: false,
    updatedAt: iso(row.updatedAt),
  };
}

export function createInventoryAuthoritativeReadService({ prisma } = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function listMovements(query, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const { page, pageSize, skip } = pageOptions(query);
    const where = movementWhere(actor, query);
    const [total, rows, facets] = await Promise.all([
      prisma.inventoryMovement.count({ where }),
      prisma.inventoryMovement.findMany({
        where,
        orderBy: movementOrder(query),
        skip,
        take: pageSize,
      }),
      movementFacets(prisma, movementContextWhere(actor, query)),
    ]);
    const numbers = await movementDocumentNumbers(prisma, actor.tenantId, rows);
    return {
      dataSource: "Authoritative PostgreSQL",
      page,
      pageSize,
      total,
      ...(facets ? { facets } : {}),
      movements: rows.map((row) => movementModel(row, numbers)),
    };
  }

  async function listBalances(query, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const { page, pageSize, skip } = pageOptions(query);
    const where = balanceWhere(actor, query);
    const [total, rows] = await Promise.all([
      prisma.inventoryBalance.count({ where }),
      prisma.inventoryBalance.findMany({
        where,
        orderBy: balanceOrder(query),
        skip,
        take: pageSize,
      }),
    ]);
    const items = rows.length
      ? await prisma.item.findMany({
          where: {
            tenantId: actor.tenantId,
            OR: [
              {
                id: {
                  in: [...new Set(rows.map((row) => row.itemId).filter(Boolean))],
                },
              },
              { sku: { in: [...new Set(rows.map((row) => row.sku))] } },
            ],
          },
          select: { id: true, sku: true, safetyStock: true, reorderPoint: true },
        })
      : [];
    return {
      dataSource: "Authoritative PostgreSQL",
      page,
      pageSize,
      total,
      balances: withItemStockThresholds(rows, items).map(balanceModel),
    };
  }

  async function listAvailableBalanceOptions(query, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const rows = await prisma.inventoryBalance.findMany({
      where: availableBalanceSelectorWhere(actor, query),
      orderBy: [
        { sku: "asc" },
        { warehouseId: "asc" },
        { locationKey: "asc" },
        { id: "asc" },
      ],
      take: positiveInteger(query.limit, 200, 500),
    });
    return {
      dataSource: "Authoritative PostgreSQL",
      inventoryClass: "available",
      options: rows.map(availableBalanceOption),
    };
  }

  async function listQuarantineBalances(query, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const { page, pageSize, skip } = pageOptions(query);
    const where = quarantineBalanceWhere(actor, query);
    const [total, rows] = await Promise.all([
      prisma.quarantineInventoryBalance.count({ where }),
      prisma.quarantineInventoryBalance.findMany({
        where,
        orderBy: [
          { updatedAt: "desc" },
          { sku: "asc" },
          { warehouseId: "asc" },
          { locationKey: "asc" },
          { id: "asc" },
        ],
        skip,
        take: pageSize,
      }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      inventoryClass: "quarantine",
      page,
      pageSize,
      total,
      balances: rows.map(quarantineBalanceModel),
    };
  }

  async function listQuarantineBalanceOptions(query, context) {
    const actor = await resolveProvisionedActor(
      prisma,
      context?.identity || context,
    );
    const rows = await prisma.quarantineInventoryBalance.findMany({
      where: quarantineBalanceWhere(actor, query, { selector: true }),
      orderBy: [
        { sku: "asc" },
        { warehouseId: "asc" },
        { locationKey: "asc" },
        { id: "asc" },
      ],
      take: positiveInteger(query.limit, 200, 500),
    });
    return {
      dataSource: "Authoritative PostgreSQL",
      inventoryClass: "quarantine",
      options: rows.map(quarantineBalanceModel),
    };
  }

  return {
    listMovements,
    listBalances,
    listAvailableBalanceOptions,
    listQuarantineBalances,
    listQuarantineBalanceOptions,
  };
}
