import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertCircle, ClipboardCheck, ListChecks, PackageSearch, Truck } from "lucide-react";
import { useRouteAvailability } from "../../app/routeAvailability";
import { apiJson } from "../../lib/api-client";
import { purchaseOrderStatusCode } from "../purchasing/filters";
import { A, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, PrimaryButton, RefreshButton, ResetButton, StatusChip, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableLinkClass, tableScrollClass, tdClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass, tableBodyTextClass } from "../../components/ui/workbenchTable";
import { procurementApi } from "./procurementApi";
import { ListPager, usePagedRows } from "./listPaging";
import type { ProcurementNavigate, ProcurementWorkItem } from "./procurementTypes";
import { QUEUES, daysBetween, heldInvoiceRows, inWorkQueue, workQueueCount, type Queue, type WorkRow } from "./workQueue";
import { useI18n } from "../../i18n/I18n";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { formatCalendarDay, formatLocaleAmount, todayInTimeZone } from "../../lib/format";

// Rows to a page, as on the purchase order list (design audit U-14).
const PAGE_SIZE = 50;

const FINISHED_PURCHASE_ORDER_STATUSES = ["fully_received", "completed", "closed", "cancelled", "已完成", "已关闭", "已取消"];

const COPY = {
  allWork: ["Open work", "全部待办"],
  allWorkNote: ["Requests, orders and held supplier invoices still open", "仍在进行的申请、订单和被扣住的采购发票"],
  approval: ["Awaiting approval", "待审批"],
  approvalNote: ["Submitted requests and orders to approve", "已提交、等待审批的申请和订单"],
  tracking: ["In progress", "跟进中"],
  trackingNote: ["Approved or issued, not finished", "已批准或已下达，尚未完成"],
  issues: ["Invoice or match issues", "发票或匹配问题"],
  // The supplier invoice list's Match exceptions, also on a closed order.
  issuesNote: ["Supplier invoices held by a match exception, whatever the order's status", "因匹配例外被扣住的采购发票，不论订单状态"],
  searchTitle: ["Work queue search", "待办查询"],
  searchSubtitle: ["Find purchase requests and purchase orders that still need purchasing work.", "查找仍需采购处理的采购申请和采购订单。"],
  search: ["Search", "搜索"],
  searchPlaceholder: ["Document number, item or supplier", "单号、物料或供应商"],
  type: ["Document type", "单据类型"],
  allTypes: ["All types", "全部类型"],
  queue: ["Queue", "队列"],
  allQueues: ["All open work", "全部待办"],
  status: ["Status", "状态"],
  allStatuses: ["All statuses", "全部状态"],
  newRequest: ["New purchase request", "新建采购申请"],
  listTitle: ["Work queue", "待办队列"],
  document: ["Document", "单据"],
  item: ["Item", "物料"],
  supplier: ["Supplier", "供应商"],
  due: ["Need by / ETA / due", "需求日期 / 预计到货 / 到期日"],
  amount: ["Amount", "金额"],
  attention: ["Needs attention", "需关注"],
  actions: ["Actions", "操作"],
  view: ["View", "查看"],
  request: ["Purchase request", "采购申请"],
  order: ["Purchase order", "采购订单"],
  invoice: ["Supplier invoice", "采购发票"],
  billsOrder: ["Bills {order}", "对应 {order}"],
  requests: ["Purchase requests", "采购申请"],
  orders: ["Purchase orders", "采购订单"],
  moreLines: ["+{count} more", "另 {count} 行"],
  loadFailed: ["The purchasing workbench could not be loaded", "采购工作台加载失败"],
  empty: ["No purchasing work is open", "暂无采购待办"],
  emptyDetail: ["Submitted requests, open purchase orders and supplier invoices held at the match appear here.", "已提交的采购申请、未结采购订单和在匹配中被扣住的采购发票会显示在这里。"],
  noMatch: ["No work matches these filters", "没有符合筛选条件的待办"],
  match_exception: ["Three-way match exception", "三单匹配异常"],
  invoice_to_approve: ["Differences approved; approve the invoice", "差异已批准，待批准发票"],
  lateOne: ["1 day late", "逾期 1 天"],
  late: ["{n} days late", "逾期 {n} 天"],
  reorder: ["Items to reorder", "待补货物料"],
  // The tile's number is the items to order now; {n} is how many the list checked, not more to order.
  reorderNote: ["{now} to order now · {n} items checked", "需立即下单 {now} 项 · 已检查 {n} 项"],
} as const;

// The queues and the "Invoice or match issues" rows are in workQueue.ts: the
// issues are the supplier invoices held by a match exception, counted by the
// supplier invoice list's own rule and listed whatever their order's status,
// not orders flagged by matching the server's status text (design audit
// L1-18 = L7-02, L7-03).
// Orders the supplier is expected to deliver: approved or issued and not yet
// received in full (a legacy label older rows carry is read as its code).
const EXPECTED_ORDER_STATUSES = new Set(["approved", "issued", "partially_received"]);
type ReorderCounts = { orderNow: number; listed: number };

type WorkLists = { requests: Awaited<ReturnType<typeof procurementApi.listRequests>>; orders: Awaited<ReturnType<typeof procurementApi.listOrders>>; invoices: Awaited<ReturnType<typeof procurementApi.listDocuments>> };
// The work rows: requests to approve or source, open orders with their days
// late against `today` (the workspace's day), and held supplier invoices.
function workRows({ requests, orders, invoices }: WorkLists, today: string): WorkRow[] {
  return [
    ...requests.filter(row => ["submitted", "approved"].includes(row.status)).map((row): ProcurementWorkItem => {
      const lines = row.lines || [];
      const suppliers = [...new Set(lines.map(line => line.supplierSnapshot?.supplierName).filter(Boolean))] as string[];
      const needBy = lines.map(line => line.needByDate).filter(Boolean).sort()[0] || row.defaultNeedByDate;
      return { id: row.id, number: row.number || row.id, kind: "purchase_request", status: row.status, bucket: row.status === "submitted" ? "approval" : "tracking", amount: row.totalAmount, currency: row.defaultCurrency, item: lines[0]?.itemNameSnapshot || lines[0]?.sku || "", moreLines: Math.max(lines.length - 1, 0), supplier: suppliers.join(", "), dueDate: needBy };
    }),
    ...orders
      // A fully received, closed or cancelled order needs no more purchasing work.
      .filter(row => !FINISHED_PURCHASE_ORDER_STATUSES.includes(row.status))
      .map((row): WorkRow => {
        // Due by Today's rule: the earliest open line's promised day (V-B-02).
        const due = row.dueDay || row.eta;
        const late = due && today && EXPECTED_ORDER_STATUSES.has(purchaseOrderStatusCode(row.status)) ? daysBetween(String(due), today) : 0;
        const daysLate = Number.isFinite(late) && late > 0 ? late : 0;
        return {
          daysLate,
          id: row.id,
          number: row.number || row.id,
          kind: "purchase_order",
          status: row.status,
          transmissionStatus: row.transmissionStatus,
          bucket: row.status === "pending_approval" ? "approval" : "tracking",
          amount: row.totalAmount,
          currency: row.currency,
          item: row.sourceName || row.lines?.[0]?.itemNameSnapshot || "",
          moreLines: Math.max((row.lines?.length || 0) - 1, 0),
          supplier: row.supplier || row.supplierSnapshot?.supplierName || "",
          dueDate: row.dueDay || row.eta,
          signals: [
            ...(daysLate ? ["overdue"] : []),
          ],
        };
      }),
    // Each supplier invoice held by a match exception, also on a closed order.
    ...heldInvoiceRows(invoices, today),
  ];
}

export function ProcurementWorkbench(_props: { onNavigate?: ProcurementNavigate }) {
  // Days late count from the workspace's day, from the server (design audit
  // B3, L6-02): "" until it has loaded, and then the counts read "—".
  const { language, locale, workspaceToday } = useI18n();
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const statusLabel = (code: string) => statusCodeLabel(code, language) || code;
  const navigate = useNavigate();
  const canOpenRoute = useRouteAvailability();
  const [searchParams, setSearchParams] = useSearchParams();
  // The lists as read; the rows are built from them and the workspace day,
  // so the days late follow that day when it arrives or changes.
  const [lists, setLists] = useState<WorkLists | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  // The reorder list's counts, read on their own so a slow or refused read
  // never holds up the work queue; null while unread or when it failed.
  const [reorder, setReorder] = useState<ReorderCounts | null>(null);
  const canOpenReorder = canOpenRoute("inventory:reorder");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const queueParam = searchParams.get("queue") as Queue | null;
  const queue: Queue = queueParam && QUEUES.includes(queueParam) ? queueParam : "all";
  const setQueue = (next: Queue) => {
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("queue"); else params.set("queue", next);
    setSearchParams(params, { replace: true });
  };
  // The reorder list is read only after the work queue has drawn: it ranks
  // every item, and reading it beside the queue's lists slowed the whole page
  // (0.6 s to 1.5 s, UI review 7b, finding 10).
  const loadReorder = () => {
    if (!canOpenReorder) return;
    apiJson<{ summary?: { orderNow?: number; listed?: number } }>("/api/inventory/reorder-list")
      .then((list) => setReorder(list?.summary ? { orderNow: Number(list.summary.orderNow || 0), listed: Number(list.summary.listed || 0) } : null))
      .catch(() => setReorder(null));
  };
  const load = async () => {
    setState("loading");
    try {
      const [requests, orders, invoices] = await Promise.all([
        procurementApi.listRequests(),
        procurementApi.listOrders(),
        procurementApi.listDocuments("invoice"),
      ]);
      setLists({ requests, orders, invoices });
      setState("loaded");
    } catch { setState("error"); }
    // After the queue's lists, loaded or not; the tile shows "—" until then.
    window.setTimeout(loadReorder, 0);
  };
  useEffect(() => { void load(); }, []);
  const rows = useMemo(() => (lists && workspaceToday ? workRows(lists, workspaceToday) : []), [lists, workspaceToday]);
  // The queue counts and the list wait for the workspace's day as well.
  const ready = state === "loaded" && Boolean(workspaceToday);
  const statuses = useMemo(() => [...new Set(rows.map(row => row.status))], [rows]);
  const needle = query.trim().toLowerCase();
  // Approvals first, then rows that need attention (late, or an invoice or
  // match issue), each group by its date, the earliest first; rows without a
  // date last.
  const byDate = (left: WorkRow, right: WorkRow) => (left.dueDate ? 0 : 1) - (right.dueDate ? 0 : 1) || String(left.dueDate || "").localeCompare(String(right.dueDate || "")) || String(left.number || left.id).localeCompare(String(right.number || right.id));
  const shown = rows
    .filter(row => inWorkQueue(row, queue))
    .filter(row => !type || row.kind === type)
    .filter(row => !status || row.status === status)
    .filter(row => !needle || [row.number, row.id, row.item, row.supplier].some(value => String(value || "").toLowerCase().includes(needle)))
    .sort((left, right) => Number(right.bucket === "approval") - Number(left.bucket === "approval") || Number(Boolean(right.signals?.length)) - Number(Boolean(left.signals?.length)) || byDate(left, right));
  const paged = usePagedRows(shown, PAGE_SIZE, [queue, type, status, needle].join("|"));
  // A card's number is the number of rows the queue it opens lists.
  const count = (name: Queue) => workQueueCount(rows, name);
  const reset = () => { setQuery(""); setType(""); setStatus(""); setQueue("all"); };
  const money = (row: ProcurementWorkItem) => row.amount === null || !Number.isFinite(Number(row.amount)) ? "—" : formatLocaleAmount(Number(row.amount), row.currency, locale, { maximumFractionDigits: 2 });
  const queueLink = (name: Queue) => `/app/procurement/workbench${name === "all" ? "" : `?queue=${name}`}`;
  const value = (name: Queue) => ready ? String(count(name)) : "—";
  return (
    <div className="space-y-5" data-testid="procurement-workbench">
      <div className={`grid grid-cols-2 gap-3 ${canOpenReorder ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
        <ActionableMetricCard label={tr("allWork")} value={value("all")} description={tr("allWorkNote")} to={queueLink("all")} icon={ListChecks} color={A.blue} />
        <ActionableMetricCard label={tr("approval")} value={value("approval")} description={tr("approvalNote")} to={queueLink("approval")} icon={ClipboardCheck} color={A.orange} />
        <ActionableMetricCard label={tr("tracking")} value={value("tracking")} description={tr("trackingNote")} to={queueLink("tracking")} icon={Truck} color={A.blue} />
        <ActionableMetricCard label={tr("issues")} value={value("issues")} description={tr("issuesNote")} to={queueLink("issues")} icon={AlertCircle} color={A.red} />
        {/* What to order next comes from the reorder list, the inventory page that ranks it. */}
        {canOpenReorder && (
          <ActionableMetricCard label={tr("reorder")} value={reorder ? String(reorder.orderNow) : "—"} description={tr("reorderNote").replace("{now}", reorder ? String(reorder.orderNow) : "—").replace("{n}", reorder ? String(reorder.listed) : "—")} to="/app/inventory/reorder" icon={PackageSearch} color={A.orange} />
        )}
      </div>

      <ListSearchCard
        title={tr("searchTitle")}
        subtitle={tr("searchSubtitle")}
        activeFilters={[type, queue === "all" ? "" : queue, status].filter(Boolean).length}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={() => void load()} />
          <PrimaryButton onClick={() => navigate("/app/procurement/requests?mode=create")} testId="workbench-new-request">{tr("newRequest")}</PrimaryButton>
        </>}
      >
        <Field label={tr("search")}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("searchPlaceholder")} style={inputStyle} />
        </Field>
        <Field label={tr("type")}>
          <select value={type} onChange={(event) => setType(event.target.value)} style={inputStyle}>
            <option value="">{tr("allTypes")}</option>
            <option value="purchase_request">{tr("requests")}</option>
            <option value="purchase_order">{tr("orders")}</option>
          </select>
        </Field>
        <Field label={tr("queue")}>
          <select value={queue} onChange={(event) => setQueue(event.target.value as Queue)} style={inputStyle}>
            <option value="all">{tr("allQueues")}</option>
            <option value="approval">{tr("approval")}</option>
            <option value="tracking">{tr("tracking")}</option>
            <option value="issues">{tr("issues")}</option>
          </select>
        </Field>
        <Field label={tr("status")}>
          <select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}>
            <option value="">{tr("allStatuses")}</option>
            {statuses.map(code => <option key={code} value={code}>{statusLabel(code)}</option>)}
          </select>
        </Field>
      </ListSearchCard>

      <ListCard title={tr("listTitle")} total={ready ? shown.length : undefined} all={ready ? rows.length : undefined} shown={paged.pageRows.length} testId="procurement-work-queue">
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[1100px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("document")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("item")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("supplier")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("status")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("due")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{tr("amount")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("attention")}</th>
                <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {(state === "loading" || (state === "loaded" && !workspaceToday)) && <ListStateRow colSpan={8} state="loading" />}
              {state === "error" && <ListStateRow colSpan={8} state="error" title={tr("loadFailed")} onRetry={() => void load()} />}
              {ready && shown.length === 0 && (
                rows.length === 0
                  ? <ListStateRow colSpan={8} state="empty" title={tr("empty")} detail={tr("emptyDetail")} />
                  : <ListStateRow colSpan={8} state="empty" title={tr("noMatch")} />
              )}
              {ready && paged.pageRows.map((row, index) => (
                <tr key={`${row.kind}:${row.id}`} className={listRowClass} style={listRowStyle(index, paged.pageRows.length)}>
                  <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                    <EntityLink kind={row.kind} id={row.id} number={row.number} className={tableLinkClass} />
                    <div className="text-[11px] font-normal" style={{ color: A.sub }}>{tr(row.kind === "purchase_request" ? "request" : row.kind === "supplier_invoice" ? "invoice" : "order")}</div>
                  </td>
                  <td className={`${tdNameClass} max-w-[220px]`}>
                    {/* A held invoice names the order it bills. */}
                    {row.kind === "supplier_invoice"
                      ? <div className="truncate" style={{ color: A.sub }}>{row.orderNumber ? tr("billsOrder").replace("{order}", row.orderNumber) : "—"}</div>
                      : <div className="truncate font-medium" style={{ color: A.label }} title={row.item}>{row.item || "—"}</div>}
                    {row.moreLines ? <div className="text-[11px]" style={{ color: A.sub }}>{tr("moreLines").replace("{count}", String(row.moreLines))}</div> : null}
                  </td>
                  <td className={`${tdNameClass} max-w-[200px] truncate`} title={row.supplier}>{row.supplier || <span style={{ color: A.gray2 }}>—</span>}</td>
                  <td className={tdNowrapClass}>
                    <StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} />
                    {row.transmissionStatus && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{statusLabel(row.transmissionStatus)}</div>}
                  </td>
                  {/* A late order's expected arrival, or a held invoice past its due date, reads red. */}
                  <td className={`${tdNowrapClass} ${row.daysLate ? "font-medium" : ""}`} style={{ color: row.daysLate ? A.red : A.sub }}>{row.dueDate ? formatCalendarDay(row.dueDate, locale) : "—"}</td>
                  <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row)}</td>
                  {/* Signals wrap onto lines of their own, so the table fits and the sticky
                      Actions column does not cover them. */}
                  <td className={`${tdClass} min-w-[150px] [&_.fc-status-chip]:whitespace-normal`}>
                    {row.signals?.length ? <div className="flex flex-wrap gap-1">{row.signals.map(signal => signal === "overdue"
                      ? <StatusChip key={signal} testId={`workbench-late-${row.id}`} label={row.daysLate === 1 ? tr("lateOne") : tr("late").replace("{n}", String(row.daysLate))} tone="danger" />
                      : <StatusChip key={signal} label={signal in COPY ? tr(signal as keyof typeof COPY) : signal} tone="warning" />)}</div> : <span style={{ color: A.gray2 }}>—</span>}
                  </td>
                  <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                    <EntityLink kind={row.kind} id={row.id} className={`${rowActionClass.primary} !no-underline`}>{tr("view")}</EntityLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ready && <ListPager page={paged.page} pageSize={PAGE_SIZE} total={shown.length} onPage={paged.setPage} testId="procurement-work-pager" />}
      </ListCard>
    </div>
  );
}
