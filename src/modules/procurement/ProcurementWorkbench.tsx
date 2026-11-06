import { isNoInvoiceVariance } from "../../domain/procurement/variance-types";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertCircle, ClipboardCheck, ListChecks, Truck } from "lucide-react";
import { A, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, PrimaryButton, RefreshButton, ResetButton, StatusChip, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableLinkClass, tableScrollClass, tdClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass, tableBodyTextClass } from "../../components/ui/workbenchTable";
import { procurementApi } from "./procurementApi";
import type { ProcurementNavigate, ProcurementWorkItem } from "./procurementTypes";
import { useI18n } from "../../i18n/I18n";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { formatCalendarDay, formatLocaleAmount } from "../../lib/format";

const FINISHED_PURCHASE_ORDER_STATUSES = ["fully_received", "completed", "closed", "cancelled", "已完成", "已关闭", "已取消"];

const COPY = {
  allWork: ["Open work", "全部待办"],
  allWorkNote: ["Requests and orders still open", "仍在进行的申请和订单"],
  approval: ["Awaiting approval", "待审批"],
  approvalNote: ["Submitted requests and orders to approve", "已提交、等待审批的申请和订单"],
  tracking: ["In progress", "跟进中"],
  trackingNote: ["Approved or issued, not finished", "已批准或已下达，尚未完成"],
  issues: ["Invoice or match issues", "发票或匹配问题"],
  issuesNote: ["Orders with a variance to review", "存在差异、需要复核的订单"],
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
  due: ["Need by / ETA", "需求日期 / 预计到货"],
  amount: ["Amount", "金额"],
  attention: ["Needs attention", "需关注"],
  actions: ["Actions", "操作"],
  view: ["View", "查看"],
  request: ["Purchase request", "采购申请"],
  order: ["Purchase order", "采购订单"],
  requests: ["Purchase requests", "采购申请"],
  orders: ["Purchase orders", "采购订单"],
  moreLines: ["+{count} more", "另 {count} 行"],
  loadFailed: ["The purchasing workbench could not be loaded", "采购工作台加载失败"],
  empty: ["No purchasing work is open", "暂无采购待办"],
  emptyDetail: ["Submitted requests and open purchase orders appear here.", "已提交的采购申请和未结采购订单会显示在这里。"],
  noMatch: ["No work matches these filters", "没有符合筛选条件的待办"],
  invoice_variance: ["Invoice variance", "发票差异"],
  match_exception: ["Three-way match exception", "三单匹配异常"],
} as const;

type Queue = "all" | "approval" | "tracking" | "issues";
const QUEUES: Queue[] = ["all", "approval", "tracking", "issues"];

export function ProcurementWorkbench(_props: { onNavigate?: ProcurementNavigate }) {
  const { language, locale } = useI18n();
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const statusLabel = (code: string) => statusCodeLabel(code, language) || code;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<ProcurementWorkItem[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
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
  const load = async () => {
    setState("loading");
    try {
      const [requests, orders, invoices] = await Promise.all([
        procurementApi.listRequests(),
        procurementApi.listOrders(),
        procurementApi.listDocuments("invoice"),
      ]);
      setRows([
        ...requests.filter(row => ["submitted", "approved"].includes(row.status)).map((row): ProcurementWorkItem => {
          const lines = row.lines || [];
          const suppliers = [...new Set(lines.map(line => line.supplierSnapshot?.supplierName).filter(Boolean))] as string[];
          const needBy = lines.map(line => line.needByDate).filter(Boolean).sort()[0] || row.defaultNeedByDate;
          return { id: row.id, number: row.number || row.id, kind: "purchase_request", status: row.status, bucket: row.status === "submitted" ? "approval" : "tracking", amount: row.totalAmount, currency: row.defaultCurrency, item: lines[0]?.itemNameSnapshot || lines[0]?.sku || "", moreLines: Math.max(lines.length - 1, 0), supplier: suppliers.join(", "), dueDate: needBy };
        }),
        ...orders
          // A fully received, closed or cancelled order needs no more purchasing work.
          .filter(row => !FINISHED_PURCHASE_ORDER_STATUSES.includes(row.status))
          .map((row): ProcurementWorkItem => {
            const relatedInvoices = invoices.filter(invoice => invoice.relatedPo === row.id);
            const hasInvoiceVariance = relatedInvoices.some(invoice => Number(invoice.varianceAmount || 0) !== 0 || (Boolean(invoice.varianceType) && !isNoInvoiceVariance(invoice.varianceType)) || /差异|variance/i.test(String(invoice.status || "")));
            const hasMatchException = relatedInvoices.some(invoice => /差异|异常|待处理|variance/i.test(String(invoice.matchStatus || "")));
            return {
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
              dueDate: row.eta,
              signals: [
                ...(hasInvoiceVariance ? ["invoice_variance"] : []),
                ...(hasMatchException ? ["match_exception"] : []),
              ],
            };
          }),
      ]);
      setState("loaded");
    } catch { setState("error"); }
  };
  useEffect(() => { void load(); }, []);
  const inQueue = (row: ProcurementWorkItem, name: Queue) =>
    name === "all" || (name === "issues" ? Boolean(row.signals?.length) : row.bucket === name);
  const statuses = useMemo(() => [...new Set(rows.map(row => row.status))], [rows]);
  const needle = query.trim().toLowerCase();
  // Approvals first, then orders with an invoice or match issue.
  const shown = rows
    .filter(row => inQueue(row, queue))
    .filter(row => !type || row.kind === type)
    .filter(row => !status || row.status === status)
    .filter(row => !needle || [row.number, row.id, row.item, row.supplier].some(value => String(value || "").toLowerCase().includes(needle)))
    .sort((left, right) => Number(right.bucket === "approval") - Number(left.bucket === "approval") || Number(Boolean(right.signals?.length)) - Number(Boolean(left.signals?.length)));
  const count = (name: Queue) => rows.filter(row => inQueue(row, name)).length;
  const reset = () => { setQuery(""); setType(""); setStatus(""); setQueue("all"); };
  const money = (row: ProcurementWorkItem) => row.amount === null || !Number.isFinite(Number(row.amount)) ? "—" : formatLocaleAmount(Number(row.amount), row.currency, locale, { maximumFractionDigits: 2 });
  const queueLink = (name: Queue) => `/app/procurement/workbench${name === "all" ? "" : `?queue=${name}`}`;
  const value = (name: Queue) => state === "loaded" ? String(count(name)) : "—";
  return (
    <div className="space-y-5" data-testid="procurement-workbench">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={tr("allWork")} value={value("all")} description={tr("allWorkNote")} to={queueLink("all")} icon={ListChecks} color={A.blue} />
        <ActionableMetricCard label={tr("approval")} value={value("approval")} description={tr("approvalNote")} to={queueLink("approval")} icon={ClipboardCheck} color={A.orange} />
        <ActionableMetricCard label={tr("tracking")} value={value("tracking")} description={tr("trackingNote")} to={queueLink("tracking")} icon={Truck} color={A.purple} />
        <ActionableMetricCard label={tr("issues")} value={value("issues")} description={tr("issuesNote")} to={queueLink("issues")} icon={AlertCircle} color={A.red} />
      </div>

      <ListSearchCard
        title={tr("searchTitle")}
        subtitle={tr("searchSubtitle")}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={() => void load()} />
          <PrimaryButton onClick={() => navigate("/app/procurement/requests?new=1")} testId="workbench-new-request">{tr("newRequest")}</PrimaryButton>
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

      <ListCard title={tr("listTitle")} total={state === "loaded" ? rows.length : undefined} shown={shown.length} testId="procurement-work-queue">
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
              {state === "loading" && <ListStateRow colSpan={8} state="loading" />}
              {state === "error" && <ListStateRow colSpan={8} state="error" title={tr("loadFailed")} onRetry={() => void load()} />}
              {state === "loaded" && shown.length === 0 && (
                rows.length === 0
                  ? <ListStateRow colSpan={8} state="empty" title={tr("empty")} detail={tr("emptyDetail")} />
                  : <ListStateRow colSpan={8} state="empty" title={tr("noMatch")} />
              )}
              {state === "loaded" && shown.map((row, index) => (
                <tr key={`${row.kind}:${row.id}`} className={listRowClass} style={listRowStyle(index, shown.length)}>
                  <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                    <EntityLink kind={row.kind} id={row.id} number={row.number} className={tableLinkClass} />
                    <div className="text-[11px] font-normal" style={{ color: A.sub }}>{tr(row.kind === "purchase_request" ? "request" : "order")}</div>
                  </td>
                  <td className={`${tdNameClass} max-w-[220px]`}>
                    <div className="truncate font-medium" style={{ color: A.label }} title={row.item}>{row.item || "—"}</div>
                    {row.moreLines ? <div className="text-[11px]" style={{ color: A.sub }}>{tr("moreLines").replace("{count}", String(row.moreLines))}</div> : null}
                  </td>
                  <td className={`${tdNameClass} max-w-[200px] truncate`} title={row.supplier}>{row.supplier || <span style={{ color: A.gray2 }}>—</span>}</td>
                  <td className={tdNowrapClass}>
                    <StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} />
                    {row.transmissionStatus && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{statusLabel(row.transmissionStatus)}</div>}
                  </td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{row.dueDate ? formatCalendarDay(row.dueDate, locale) : "—"}</td>
                  <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row)}</td>
                  {/* Signals wrap onto lines of their own, so the table fits and the sticky
                      Actions column does not cover them. */}
                  <td className={`${tdClass} min-w-[150px] [&_.fc-status-chip]:whitespace-normal`}>
                    {row.signals?.length ? <div className="flex flex-wrap gap-1">{row.signals.map(signal => <StatusChip key={signal} label={signal in COPY ? tr(signal as keyof typeof COPY) : signal} tone="warning" />)}</div> : <span style={{ color: A.gray2 }}>—</span>}
                  </td>
                  <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                    <EntityLink kind={row.kind} id={row.id} className={`${rowActionClass.primary} !no-underline`}>{tr("view")}</EntityLink>
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
