import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiJson } from "../../lib/api-client";
import { formatCalendarDay, formatDateTimeInTimeZone, formatQuantity } from "../../lib/format";
import { usePermissionSet } from "../../lib/usePermissionSet";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useRouteAvailability } from "../../app/routeAvailability";
import { useI18n } from "../../i18n/I18n";
import { movementTypeLabel } from "../../i18n/statusLabels";
import { unitLabel } from "../../i18n/unitLabels";
import { A } from "../../components/ui";
import { ListCard, ListStateRow, StatusChip, listHeadRowStyle, listRowClass, listRowStyle, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";

// What an item's page shows besides its master fields: its stock in each
// warehouse, its latest movements and the sales orders still to ship it,
// with links to the stock list, the movements and the purchase orders
// filtered to the item. Read through the lists those pages use:
//   - Stock: GET /api/inventory/balances?sku= (the warehouses the reader may see).
//   - Movements: GET /api/inventory/movements?sku=, newest first.
//   - Sales orders: GET /api/sales-demand/orders?sku=&orderStatus= for the
//     statuses of an order not yet shipped in full (sales_order.read).
//   - Purchase orders: a link to the order list's own item filter.

type Balance = { warehouseId: string; onHandQuantity?: string | null; reservedQuantity?: string | null; availableQuantity?: string | null; unit?: string | null };
type Movement = {
  id: string;
  movementType: string;
  reason?: string | null;
  warehouseId: string;
  location?: string | null;
  quantityIn?: string | null;
  quantityOut?: string | null;
  unit?: string | null;
  occurredAt?: string | null;
  sourceDocumentType?: string | null;
  sourceDocumentId?: string | null;
  sourceDocumentNumber?: string | null;
  relatedGrnId?: string | null;
};
type OrderLine = { sku?: string; itemId?: string; orderedQuantity?: number; fulfilledQuantity?: number; unit?: string | null };
type SalesOrder = { salesOrderId: string; orderNumber: string; customerName?: string; promisedDate?: string | null; status: string; workflowStatus?: string; lines?: OrderLine[] };
type Load<T> = { state: "loading" | "ready" | "error" | "hidden"; rows: T[]; total?: number };

const RECENT = 5;
// The sales-demand read API's name for an order without a customer name
// (db-sales-order-read-repository.mjs); matched, then shown translated.
const UNNAMED_CUSTOMER = "未命名客户";
// The order statuses of an order not shipped in full (db-sales-order-read-repository.mjs).
const OPEN_ORDER_STATUSES = ["shortage_risk", "ready_to_ship", "partially_fulfilled"];
const ORDER_STATUS: Record<string, [string, string]> = {
  // Nothing shipped yet and not all of it reserved.
  shortage_risk: ["To reserve", "待预留"],
  ready_to_ship: ["Ready to ship", "可发货"],
  partially_fulfilled: ["Partly shipped", "部分发货"],
  draft: ["Draft", "草稿"],
  on_hold: ["On hold", "已暂停"],
};
// A movement's document, linked to its page (as on the movements list).
const SOURCE_ROUTES: Array<{ types: string[]; routeId: string; path: (id: string) => string }> = [
  { types: ["receiving_document", "ReceivingDocument", "receipt"], routeId: "procurement:receiving-detail", path: (id) => `/app/procurement/receiving/${encodeURIComponent(id)}` },
  { types: ["ShipmentDocument", "shipment"], routeId: "sales:shipment-detail", path: (id) => `/app/sales/shipments/${encodeURIComponent(id)}` },
  { types: ["InventoryAdjustmentDocument"], routeId: "inventory:adjustment-detail", path: (id) => `/app/inventory/adjustments/${encodeURIComponent(id)}` },
  { types: ["StockTransferDocument"], routeId: "inventory:transfer-detail", path: (id) => `/app/inventory/transfers/${encodeURIComponent(id)}` },
  { types: ["CycleCountSession"], routeId: "inventory:count-detail", path: (id) => `/app/inventory/counts/${encodeURIComponent(id)}` },
];

const COPY = {
  stock: ["Stock by warehouse", "各仓库库存"],
  movements: ["Recent movements", "最近的库存流水"],
  orders: ["Sales orders still to ship", "待发货的销售订单"],
  allStock: ["Stock records", "库存记录"],
  allMovements: ["All movements", "全部流水"],
  purchaseOrders: ["Open purchase orders", "未完成的采购订单"],
  warehouse: ["Warehouse", "仓库"],
  onHand: ["On hand", "在库"],
  reserved: ["Reserved", "已预留"],
  available: ["Available", "可用"],
  date: ["Date", "日期"],
  type: ["Movement", "流水类型"],
  quantity: ["Quantity", "数量"],
  document: ["Document", "单据"],
  order: ["Order", "订单"],
  customer: ["Customer", "客户"],
  toShip: ["Still to ship", "待发数量"],
  promised: ["Promised", "承诺交期"],
  status: ["Status", "状态"],
  noStock: ["No stock recorded for this item.", "该物料没有库存记录。"],
  noMovements: ["No movements for this item yet.", "该物料还没有库存流水。"],
  noOrders: ["No sales order is waiting for this item.", "没有等待该物料发货的销售订单。"],
  loadFailed: ["This list could not be loaded.", "列表加载失败。"],
} satisfies Record<string, [string, string]>;

// Decimal strings as whole ten-thousandths, so sums stay exact.
function units(value: string | number | null | undefined): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{0,4})\d*)?$/.exec(String(value ?? "").trim());
  if (!match) return 0n;
  const size = BigInt(match[2]) * 10000n + BigInt((match[3] || "").padEnd(4, "0") || "0");
  return match[1] ? -size : size;
}
const fixed = (value: bigint) => {
  const size = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${size / 10000n}.${String(size % 10000n).padStart(4, "0")}`;
};

export function ItemStockAndOrders({ itemId, sku, baseUnit }: { itemId: string; sku: string; baseUnit?: string }) {
  const { language, locale, timezone } = useI18n();
  const text = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const warehouseName = useWarehouseNames();
  const canOpenRoute = useRouteAvailability();
  const permissions = usePermissionSet();
  const [stock, setStock] = useState<Load<Balance>>({ state: "loading", rows: [] });
  const [movements, setMovements] = useState<Load<Movement>>({ state: "loading", rows: [] });
  const [orders, setOrders] = useState<Load<SalesOrder>>({ state: "loading", rows: [] });
  const canReadOrders = Boolean(permissions?.has("sales_order.read"));

  useEffect(() => {
    let alive = true;
    const key = encodeURIComponent(sku);
    // Every stock record of the item, a page of 200 at a time (five at most).
    (async () => {
      const rows: Balance[] = [];
      for (let page = 1; page <= 5; page += 1) {
        const payload = await apiJson<{ balances?: Balance[]; total?: number }>(`/api/inventory/balances?sku=${key}&page=${page}&pageSize=200`);
        rows.push(...(payload.balances || []));
        if ((payload.balances || []).length < 200 || rows.length >= Number(payload.total || 0)) break;
      }
      return rows;
    })()
      .then((rows) => { if (alive) setStock({ state: "ready", rows }); })
      .catch(() => { if (alive) setStock({ state: "error", rows: [] }); });
    apiJson<{ movements?: Movement[]; total?: number }>(`/api/inventory/movements?sku=${key}&page=1&pageSize=${RECENT}&sort=occurredAt&direction=desc`)
      .then((payload) => { if (alive) setMovements({ state: "ready", rows: payload.movements || [], total: payload.total }); })
      .catch(() => { if (alive) setMovements({ state: "error", rows: [] }); });
    return () => { alive = false; };
  }, [sku]);

  useEffect(() => {
    if (!permissions) return;
    if (!canReadOrders) { setOrders({ state: "hidden", rows: [] }); return; }
    let alive = true;
    const key = encodeURIComponent(sku);
    Promise.all(OPEN_ORDER_STATUSES.map((status) =>
      apiJson<{ orders?: SalesOrder[]; total?: number }>(`/api/sales-demand/orders?sku=${key}&orderStatus=${status}&limit=${RECENT}`)))
      .then((pages) => {
        if (!alive) return;
        const rows = pages.flatMap((page) => page.orders || []);
        const total = pages.reduce((sum, page) => sum + Number(page.total ?? (page.orders || []).length), 0);
        // The soonest promised first; an order without a date last.
        rows.sort((a, b) => String(a.promisedDate || "9999").localeCompare(String(b.promisedDate || "9999")));
        setOrders({ state: "ready", rows, total });
      })
      .catch(() => { if (alive) setOrders({ state: "error", rows: [] }); });
    return () => { alive = false; };
  }, [permissions, canReadOrders, sku]);

  const quantityText = (value: bigint | string | number | null | undefined, unit?: string | null) => {
    const raw = typeof value === "bigint" ? fixed(value) : String(value ?? "");
    return `${formatQuantity(raw)}${unit ? ` ${unitLabel(unit, language, Number(raw))}` : ""}`;
  };
  // Stock per warehouse, each quantity in its unit (one item, one unit).
  const byWarehouse = [...stock.rows.reduce((groups, row) => {
    const group = groups.get(row.warehouseId) || { onHand: 0n, reserved: 0n, available: 0n, unit: row.unit || baseUnit };
    group.onHand += units(row.onHandQuantity);
    group.reserved += units(row.reservedQuantity);
    group.available += units(row.availableQuantity);
    groups.set(row.warehouseId, group);
    return groups;
  }, new Map<string, { onHand: bigint; reserved: bigint; available: bigint; unit?: string | null }>()).entries()];
  const link = (routeId: string, to: string, label: string) =>
    canOpenRoute(routeId)
      ? <Link to={to} className="text-xs font-medium text-blue-600 hover:underline max-sm:inline-flex max-sm:min-h-9 max-sm:items-center">{label}</Link>
      : null;
  const stateRow = (colSpan: number, load: Load<unknown>, none: string) =>
    load.state === "loading" ? <ListStateRow colSpan={colSpan} state="loading" />
      : load.state === "error" ? <ListStateRow colSpan={colSpan} state="error" title={text("loadFailed")} />
        : load.rows.length === 0 ? <ListStateRow colSpan={colSpan} state="empty" title={none} />
          : null;
  const documentCell = (row: Movement) => {
    const route = SOURCE_ROUTES.find((entry) => entry.types.includes(String(row.sourceDocumentType || "")));
    const id = route?.routeId === "procurement:receiving-detail" ? row.relatedGrnId || row.sourceDocumentId : row.sourceDocumentId;
    if (!row.sourceDocumentNumber) return <span style={{ color: A.gray2 }}>—</span>;
    return route && id && canOpenRoute(route.routeId)
      ? <Link to={route.path(id)} className={tableLinkClass} style={{ color: A.blue }}>{row.sourceDocumentNumber}</Link>
      : row.sourceDocumentNumber;
  };
  const toShip = (order: SalesOrder) => {
    const lines = (order.lines || []).filter((line) => line.sku === sku || line.itemId === itemId);
    const left = lines.reduce((sum, line) => sum + units(line.orderedQuantity) - units(line.fulfilledQuantity), 0n);
    return quantityText(left, lines[0]?.unit || baseUnit);
  };
  return (
    <div className="space-y-4" data-testid="item-stock-and-orders">
      <ListCard
        title={text("stock")}
        testId="item-stock"
        right={link("inventory:stock", `/app/inventory/stock?sku=${encodeURIComponent(sku)}`, text("allStock"))}
      >
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[520px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={thClass} style={{ color: A.gray1 }}>{text("warehouse")}</th>
                {[text("onHand"), text("reserved"), text("available")].map((label) => <th key={label} className={thRightClass} style={{ color: A.gray1 }}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {stateRow(4, stock, text("noStock"))}
              {byWarehouse.map(([warehouseId, group], index) => (
                <tr key={warehouseId} className={listRowClass} style={listRowStyle(index, byWarehouse.length)} data-testid="item-stock-row">
                  <td className={tdIdClass}>
                    {canOpenRoute("inventory:stock")
                      ? <Link to={`/app/inventory/stock?sku=${encodeURIComponent(sku)}&warehouseId=${encodeURIComponent(warehouseId)}`} className={tableLinkClass} style={{ color: A.blue }}>{warehouseName(warehouseId) || warehouseId}</Link>
                      : warehouseName(warehouseId) || warehouseId}
                  </td>
                  <td className={tdNumericRightClass}>{quantityText(group.onHand, group.unit)}</td>
                  <td className={tdNumericRightClass}>{quantityText(group.reserved, group.unit)}</td>
                  <td className={tdNumericRightClass}><strong>{quantityText(group.available, group.unit)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListCard>
      <ListCard
        title={text("movements")}
        testId="item-movements"
        right={link("inventory:movements", `/app/inventory/movements?sku=${encodeURIComponent(sku)}`, movements.total ? say(`All ${movements.total} movements`, `全部 ${movements.total} 条流水`) : text("allMovements"))}
      >
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[720px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                {[text("date"), text("type"), text("warehouse"), text("document")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                <th className={thRightClass} style={{ color: A.gray1 }}>{text("quantity")}</th>
              </tr>
            </thead>
            <tbody>
              {stateRow(5, movements, text("noMovements"))}
              {movements.rows.map((row, index) => {
                const change = units(row.quantityIn) - units(row.quantityOut);
                return (
                  <tr key={row.id} className={listRowClass} style={listRowStyle(index, movements.rows.length)} data-testid="item-movement-row">
                    <td className={tdNowrapClass}>{formatDateTimeInTimeZone(row.occurredAt, locale, timezone)}</td>
                    <td className={tdNowrapClass}>{movementTypeLabel(row.movementType, language, row.reason)}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{[warehouseName(row.warehouseId), row.location].filter(Boolean).join(" / ")}</td>
                    <td className={tdIdClass}>{documentCell(row)}</td>
                    <td className={tdNumericRightClass} style={{ color: change < 0n ? A.red : A.label }}>{change > 0n ? "+" : ""}{quantityText(change, row.unit || baseUnit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ListCard>
      {orders.state !== "hidden" && (
        <ListCard
          title={text("orders")}
          total={orders.state === "ready" && orders.rows.length ? orders.total : undefined}
          shown={orders.rows.length}
          testId="item-open-orders"
          right={link("procurement:orders", `/app/procurement/orders?item=${encodeURIComponent(sku)}&status=open`, text("purchaseOrders"))}
        >
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[720px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  {[text("order"), text("status"), text("customer"), text("promised")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{text("toShip")}</th>
                </tr>
              </thead>
              <tbody>
                {stateRow(5, orders, text("noOrders"))}
                {orders.rows.map((order, index) => {
                  const status = order.workflowStatus === "draft" || order.workflowStatus === "on_hold" ? order.workflowStatus : order.status;
                  const label = ORDER_STATUS[status];
                  return (
                    <tr key={order.salesOrderId} className={listRowClass} style={listRowStyle(index, orders.rows.length)} data-testid="item-open-order-row">
                      <td className={tdIdClass}>
                        {canOpenRoute("sales:order-detail")
                          ? <Link to={`/app/sales/orders/${encodeURIComponent(order.salesOrderId)}`} className={tableLinkClass} style={{ color: A.blue }}>{order.orderNumber}</Link>
                          : order.orderNumber}
                      </td>
                      <td className={tdNowrapClass}><StatusChip label={label ? label[language === "en-US" ? 0 : 1] : status} tone={statusToneOf(status === "shortage_risk" ? "pending" : status === "ready_to_ship" ? "confirmed" : status)} /></td>
                      {/* The read API names a customer without a recorded name in Chinese. */}
                      <td className={`${tdNowrapClass} max-w-[240px] truncate`}>{order.customerName === UNNAMED_CUSTOMER ? say("Unnamed customer", "未命名客户") : order.customerName}</td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{formatCalendarDay(order.promisedDate, locale)}</td>
                      <td className={tdNumericRightClass}>{toShip(order)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ListCard>
      )}
    </div>
  );
}
