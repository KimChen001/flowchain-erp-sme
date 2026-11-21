import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";
import { A, Field, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { apiJson } from "../../lib/api-client";
import { formatCalendarDay } from "../../lib/format";
import { usePermissionSet } from "../../lib/usePermissionSet";
import { useRouteAvailability } from "../../app/routeAvailability";

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
  cannotReceive: ["Your role cannot prepare receipts.", "你的角色无权准备收货单。"],
  cannotReceiveDetail: ["Ask an administrator for receiving access, or ask someone who receives goods to record this delivery.", "请联系管理员开通收货权限，或请负责收货的同事登记本次到货。"],
  notIssuedOne: ["1 approved purchase order for your warehouses is not issued to its supplier yet, so it can't be received.", "你负责的仓库有 1 张已审批的采购订单尚未下达给供应商，因此还不能收货。"],
  notIssuedMany: ["{count} approved purchase orders for your warehouses are not issued to their suppliers yet, so they can't be received.", "你负责的仓库有 {count} 张已审批的采购订单尚未下达给供应商，因此还不能收货。"],
  notIssuedSee: ["See approved orders", "查看已审批订单"],
  notIssuedAsk: ["Someone who manages purchase orders can issue them.", "请负责采购订单的同事将其下达。"],
  truncated: ["Only the orders with the earliest expected arrival are listed. Open a later one from its purchase order, or ask someone who manages purchase orders.", "这里只列出预计到货最早的订单。较晚的订单请从采购订单上点击“收货”，或请负责采购订单的同事处理。"],
};

// The statuses the Receive action on a purchase order offers (PurchaseOrderReceiveAction).
const RECEIVE_STATUSES = new Set(["issued", "partially_received"]);

// GET /api/procurement/receivable-orders (receiving-draft-command-service
// listOrdersToReceive): issued or partially received orders with quantity to
// receive, into the reader's warehouses, read with receiving.prepare.
type OrderLine = { orderedQuantity?: string | number; receivedQuantity?: string | number; unit?: string | null; sku?: string | null; itemName?: string | null };
type Order = { id: string; number?: string; status: string; supplierName?: string | null; expectedDate?: string | null; lines?: OrderLine[] };
type OrdersToReceive = { orders: Order[]; notIssued: number; truncated: boolean };
// open is a total only when every open line uses one unit; otherwise null and
// the row says how many lines are open.
// number: the document number people read; id stays in links and calls.
type Receivable = { id: string; number: string; status: string; supplier: string; eta: string; open: number | null; unit: string; openLines: number; search: string };

const quantity = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

// An order with quantity still to receive, in a status the Receive action allows.
function receivableOf(order: Order): Receivable | null {
  const id = String(order.id || "").trim();
  if (!id || !RECEIVE_STATUSES.has(order.status)) return null;
  const lines = order.lines || [];
  const openLines = lines.filter((line) => quantity(line.orderedQuantity) > quantity(line.receivedQuantity));
  const open = openLines.reduce((sum, line) => sum + quantity(line.orderedQuantity) - quantity(line.receivedQuantity), 0);
  if (open <= 0) return null;
  const units = [...new Set(openLines.map((line) => String(line.unit || "").trim()))];
  const number = String(order.number || "").trim() || id;
  return {
    id,
    number,
    status: order.status,
    supplier: String(order.supplierName || ""),
    eta: String(order.expectedDate || ""),
    open: units.length > 1 ? null : open,
    unit: units.length === 1 ? units[0] : "",
    openLines: openLines.length,
    search: [number, id, order.supplierName, ...lines.flatMap((line) => [line.sku, line.itemName])].filter(Boolean).join(" ").toLowerCase(),
  };
}

// /app/procurement/receiving/new without ?po=: the purchase orders that can be
// received now, each opening the receipt form for that order. Read with
// receiving permissions, so a receiver without purchase order access (the
// default Operations Specialist) gets the list too; the server checks
// receiving.prepare, warehouse scope and open quantities again when the
// receipt is saved.
export function ReceivablePurchaseOrderChooser() {
  const { language, locale, formatNumber } = useI18n();
  const tr = (key: string, values: Record<string, string | number> = {}) =>
    COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  const navigate = useNavigate();
  const permissions = usePermissionSet();
  const canReceive = Boolean(permissions?.has("receiving.prepare"));
  const canOpenRoute = useRouteAvailability();
  // The way to the approved orders and to an order's page, for those who may.
  const canOpenOrders = canOpenRoute("procurement:orders");
  const canOpenOrder = canOpenRoute("procurement:order-detail");
  const [orders, setOrders] = useState<Receivable[]>([]);
  const [notIssued, setNotIssued] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const answer = await apiJson<OrdersToReceive>("/api/procurement/receivable-orders");
      setNotIssued(Number(answer?.notIssued) || 0);
      setTruncated(Boolean(answer?.truncated));
      // Earliest expected arrival first; orders without a date last.
      setOrders((answer?.orders || []).map((row) => receivableOf(row)).filter((row): row is Receivable => Boolean(row))
        .sort((a, b) => (a.eta || "9999-12-31").localeCompare(b.eta || "9999-12-31") || a.id.localeCompare(b.id)));
      setState("loaded");
    } catch {
      setOrders([]);
      setNotIssued(0);
      setTruncated(false);
      setState("error");
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
    : `${formatNumber(row.open)}${row.unit ? ` ${unitLabel(row.unit, language, row.open)}` : ""}`;
  const backToOrders = (
    <button type="button" onClick={() => navigate("/app/procurement/orders")} className={listButtonClass.secondary} data-testid="receiving-po-chooser-orders">
      <ArrowLeft size={13} />{tr("backToOrders")}
    </button>
  );

  return (
    <div className="space-y-5" data-testid="receiving-po-chooser">
      <ListSearchCard title={tr("title")} subtitle={tr("intro")} actions={canOpenOrders ? backToOrders : undefined}>
        {canReceive && (
          <Field label={tr("search")}>
            <input aria-label={tr("search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("searchPlaceholder")} style={inputStyle} />
          </Field>
        )}
      </ListSearchCard>

      <ListCard title={tr("listTitle")} total={canReceive && state === "loaded" ? shown.length : undefined} shown={shown.length} all={canReceive && state === "loaded" ? orders.length : undefined} testId="receiving-po-chooser-list">
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
              {canReceive && state === "loaded" && shown.length === 0 && (
                orders.length === 0
                  ? <ListStateRow colSpan={6} state="empty" title={tr("empty")} detail={tr("emptyDetail")} />
                  : <ListStateRow colSpan={6} state="empty" title={tr("noMatch")} />
              )}
              {canReceive && state === "loaded" && shown.map((row, index) => (
                <tr key={row.id} className={listRowClass} style={listRowStyle(index, shown.length)} data-testid="receiving-po-chooser-row">
                  <td className={tdIdClass}>
                    {canOpenOrder ? <EntityLink kind="purchase_order" id={row.id} number={row.number} className={tableLinkClass} /> : <span className="font-medium">{row.number}</span>}
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
                      aria-label={`${tr("receive")} ${row.number}`}
                      onClick={() => navigate(`/app/procurement/receiving/new?po=${encodeURIComponent(row.id)}`)}
                    >{tr("receive")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListCard>
      {canReceive && state === "loaded" && truncated && <p className="text-xs" style={{ color: A.sub }} data-testid="receiving-po-chooser-truncated">{tr("truncated")}</p>}
      {canReceive && state === "loaded" && notIssued > 0 && (
        <p className="text-sm" style={{ color: A.sub }} data-testid="receiving-po-chooser-not-issued">
          {notIssued === 1 ? tr("notIssuedOne") : tr("notIssuedMany", { count: formatNumber(notIssued) })}{" "}
          {canOpenOrders
            ? <Link to="/app/procurement/orders?status=approved" className={`${tableLinkClass} max-sm:inline-flex max-sm:min-h-9 max-sm:items-center`}>{tr("notIssuedSee")}</Link>
            : tr("notIssuedAsk")}
        </p>
      )}
    </div>
  );
}
