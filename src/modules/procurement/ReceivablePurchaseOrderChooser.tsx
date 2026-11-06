import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";
import { A, Field, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { useI18n } from "../../i18n/I18n";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { ApiError, apiJson } from "../../lib/api-client";
import { formatCalendarDay } from "../../lib/format";
import { usePermissionSet } from "../../lib/usePermissionSet";

// English source copy with its Chinese translation.
const COPY: Record<string, [string, string]> = {
  title: ["New receipt", "新建收货单"],
  intro: ["A receipt records goods that arrived against a purchase order. Choose the order the goods came in on.", "收货单登记采购订单的到货。请选择本次到货对应的采购订单。"],
  backToOrders: ["Purchase orders", "采购订单"],
  search: ["Search", "搜索"],
  searchPlaceholder: ["PO number, supplier, SKU or item", "采购订单号、供应商、SKU 或物料"],
  listTitle: ["Purchase orders to receive", "待收货采购订单"],
  purchaseOrder: ["Purchase order", "采购订单"],
  supplier: ["Supplier", "供应商"],
  expected: ["Expected", "预计到货"],
  status: ["Status", "状态"],
  open: ["Open quantity", "未收数量"],
  openLines: ["{count} open lines", "{count} 行未收"],
  action: ["Action", "操作"],
  receive: ["Receive", "收货"],
  empty: ["No purchase order is waiting to be received", "暂无待收货的采购订单"],
  emptyDetail: ["Issued or partially received purchase orders with quantity still to receive show here.", "已下达或部分收货、仍有未收数量的采购订单会显示在这里。"],
  noMatch: ["No purchase order matches this search", "没有符合搜索条件的采购订单"],
  loadFailed: ["The purchase orders could not be loaded.", "采购订单加载失败。"],
  cannotReceive: ["Your role cannot prepare receipts.", "您的角色无权准备收货单。"],
  cannotReceiveDetail: ["Ask an administrator for receiving access, or ask someone who receives goods to record this delivery.", "请联系管理员开通收货权限，或请负责收货的同事登记本次到货。"],
  cannotListOrders: ["Your role cannot view purchase orders.", "您的角色无权查看采购订单。"],
  cannotListOrdersDetail: ["Open the receipt from the purchase order link you were given.", "请通过收到的采购订单链接进入收货。"],
};

// The statuses the Receive action on a purchase order offers (PurchaseOrderReceiveAction).
const RECEIVE_STATUSES = new Set(["issued", "partially_received"]);

type OrderLine = { quantityOrdered?: number; quantityReceived?: number; unit?: string; sku?: string; itemName?: string };
type Order = { id?: string; po?: string; status: string; supplier?: string; eta?: string; lines?: OrderLine[]; totalOrderedQty?: number; totalReceivedQty?: number };
// open is a total only when every open line uses one unit; otherwise null and
// the row says how many lines are open.
type Receivable = { id: string; status: string; supplier: string; eta: string; open: number | null; unit: string; openLines: number; search: string };

const quantity = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

// An order with quantity still to receive, in a status the Receive action allows.
function receivableOf(order: Order): Receivable | null {
  const id = String(order.po || order.id || "").trim();
  if (!id || !RECEIVE_STATUSES.has(order.status)) return null;
  const lines = order.lines || [];
  const openLines = lines.filter((line) => quantity(line.quantityOrdered) > quantity(line.quantityReceived));
  const open = lines.length
    ? openLines.reduce((sum, line) => sum + quantity(line.quantityOrdered) - quantity(line.quantityReceived), 0)
    : Math.max(quantity(order.totalOrderedQty) - quantity(order.totalReceivedQty), 0);
  if (open <= 0) return null;
  const units = [...new Set(openLines.map((line) => String(line.unit || "").trim()))];
  return {
    id,
    status: order.status,
    supplier: String(order.supplier || ""),
    eta: String(order.eta || ""),
    open: units.length > 1 ? null : open,
    unit: units.length === 1 ? units[0] : "",
    openLines: openLines.length,
    search: [id, order.supplier, ...lines.flatMap((line) => [line.sku, line.itemName])].filter(Boolean).join(" ").toLowerCase(),
  };
}

// /app/procurement/receiving/new without ?po=: the purchase orders that can be
// received now, each opening the receipt form for that order. Read from
// /api/procurement/orders (the purchase order read model, masked by role);
// the server checks receiving.prepare, warehouse scope and open quantities
// again when the receipt is saved.
export function ReceivablePurchaseOrderChooser() {
  const { language, locale, formatNumber } = useI18n();
  const tr = (key: string, values: Record<string, string | number> = {}) =>
    COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  const navigate = useNavigate();
  const permissions = usePermissionSet();
  const canReceive = Boolean(permissions?.has("receiving.prepare"));
  const [orders, setOrders] = useState<Receivable[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error" | "denied">("loading");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const rows = await apiJson<Order[]>("/api/procurement/orders");
      // Earliest expected arrival first; orders without a date last.
      setOrders((rows || []).map(receivableOf).filter((row): row is Receivable => Boolean(row))
        .sort((a, b) => (a.eta || "9999-12-31").localeCompare(b.eta || "9999-12-31") || a.id.localeCompare(b.id)));
      setState("loaded");
    } catch (error) {
      setOrders([]);
      setState(error instanceof ApiError && error.status === 403 ? "denied" : "error");
    }
  }, []);

  useEffect(() => {
    if (canReceive) void load();
  }, [canReceive, load]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => orders.filter((row) => !needle || row.search.includes(needle)), [orders, needle]);
  const statusLabel = (status: string) => statusCodeLabel(status, language) || status;
  const open = (row: Receivable) => row.open === null
    ? tr("openLines", { count: formatNumber(row.openLines) })
    : `${formatNumber(row.open)}${row.unit ? ` ${row.unit}` : ""}`;
  const backToOrders = (
    <button type="button" onClick={() => navigate("/app/procurement/orders")} className={listButtonClass.secondary} data-testid="receiving-po-chooser-orders">
      <ArrowLeft size={13} />{tr("backToOrders")}
    </button>
  );

  return (
    <div className="space-y-5" data-testid="receiving-po-chooser">
      <ListSearchCard title={tr("title")} subtitle={tr("intro")} actions={backToOrders}>
        {canReceive && (
          <Field label={tr("search")}>
            <input aria-label={tr("search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("searchPlaceholder")} style={inputStyle} />
          </Field>
        )}
      </ListSearchCard>

      <ListCard title={tr("listTitle")} total={canReceive && state === "loaded" ? orders.length : undefined} shown={shown.length} testId="receiving-po-chooser-list">
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[860px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                {[tr("purchaseOrder"), tr("supplier"), tr("expected"), tr("status")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                <th className={thRightClass} style={{ color: A.gray1 }}>{tr("open")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("action")}</th>
              </tr>
            </thead>
            <tbody>
              {permissions === null && <ListStateRow colSpan={6} state="loading" />}
              {permissions !== null && !canReceive && <ListStateRow colSpan={6} state="empty" title={tr("cannotReceive")} detail={tr("cannotReceiveDetail")} />}
              {canReceive && state === "loading" && <ListStateRow colSpan={6} state="loading" />}
              {canReceive && state === "error" && <ListStateRow colSpan={6} state="error" title={tr("loadFailed")} onRetry={() => void load()} />}
              {canReceive && state === "denied" && <ListStateRow colSpan={6} state="empty" title={tr("cannotListOrders")} detail={tr("cannotListOrdersDetail")} />}
              {canReceive && state === "loaded" && shown.length === 0 && (
                orders.length === 0
                  ? <ListStateRow colSpan={6} state="empty" title={tr("empty")} detail={tr("emptyDetail")} />
                  : <ListStateRow colSpan={6} state="empty" title={tr("noMatch")} />
              )}
              {canReceive && state === "loaded" && shown.map((row, index) => (
                <tr key={row.id} className={listRowClass} style={listRowStyle(index, shown.length)} data-testid="receiving-po-chooser-row">
                  <td className={tdIdClass}>
                    <EntityLink kind="purchase_order" id={row.id} className={tableLinkClass}>{row.id}</EntityLink>
                  </td>
                  <td className={`${tdNameClass} max-w-[260px] truncate`} title={row.supplier}>{row.supplier || "—"}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{row.eta ? formatCalendarDay(row.eta, locale) : "—"}</td>
                  <td className={tdNameClass}><StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} /></td>
                  <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>
                    {open(row)}
                  </td>
                  <td className={tdNowrapClass}>
                    <button
                      type="button"
                      className={rowActionClass.primary}
                      data-testid="receiving-po-chooser-receive"
                      aria-label={`${tr("receive")} ${row.id}`}
                      onClick={() => navigate(`/app/procurement/receiving/new?po=${encodeURIComponent(row.id)}`)}
                    >{tr("receive")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListCard>
    </div>
  );
}
