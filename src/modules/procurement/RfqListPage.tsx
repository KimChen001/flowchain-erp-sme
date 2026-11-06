import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CalendarClock, FileSearch, Inbox, MessageSquareQuote } from "lucide-react";
import { A, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, StatusChip, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { procurementApi } from "./procurementApi";
import { useI18n } from "../../i18n/I18n";
import { formatCalendarDay, todayInTimeZone } from "../../lib/format";
import type { ProcurementDocument } from "./procurementTypes";

const RFQ_STATUS_LABELS: Record<string, readonly [string, string]> = {
  draft: ["Draft", "草稿"],
  open: ["Open", "未结"],
  collecting_quotes: ["Collecting quotes", "收集报价"],
  closed: ["Closed", "已关闭"],
  cancelled: ["Cancelled", "已取消"],
};
const OPEN_STATUSES = ["draft", "open", "collecting_quotes"];

const COPY = {
  open: ["Open RFQs", "未结询价单"],
  openNote: ["Draft, open or collecting quotes", "草稿、未结或正在收集报价"],
  collecting: ["Collecting quotes", "收集报价"],
  collectingNote: ["Sent to suppliers, waiting for quotes", "已发给供应商，等待报价"],
  complete: ["All quotes in", "报价已收齐"],
  completeNote: ["Every invited supplier has responded", "所有受邀供应商均已回复"],
  dueSoon: ["Due in 7 days", "7 天内截止"],
  dueSoonNote: ["Open RFQs closing within a week", "一周内截止的未结询价单"],
  searchTitle: ["RFQ search", "询价单查询"],
  searchSubtitle: ["Search requests for quotation by number, subject, item, status and due date.", "按询价单号、主题、物料、状态和截止日期查询询价单。"],
  search: ["Search", "搜索"],
  searchPlaceholder: ["RFQ number, subject or item", "询价单号、主题或物料"],
  status: ["Status", "状态"],
  allStatuses: ["All statuses", "全部状态"],
  quotes: ["Quotes", "报价"],
  anyQuotes: ["Any", "全部"],
  quotesComplete: ["All quotes in", "报价已收齐"],
  quotesWaiting: ["Waiting for quotes", "等待报价"],
  due: ["Due date", "截止日期"],
  anyDue: ["Any time", "不限"],
  listTitle: ["RFQ list", "询价单列表"],
  rfq: ["RFQ", "询价单"],
  subject: ["Subject / item", "主题 / 物料"],
  quantity: ["Quantity", "数量"],
  responses: ["Supplier responses", "供应商回复"],
  actions: ["Actions", "操作"],
  view: ["View", "查看"],
  compare: ["Compare quotes", "比较报价"],
  fromRequest: ["From", "来源"],
  loadFailed: ["RFQ records could not be loaded", "询价单加载失败"],
  empty: ["No RFQ records in this workspace", "当前工作区暂无询价单"],
  emptyDetail: ["This page shows formal RFQs for the current workspace. Quotations are never generated for missing records.", "页面只展示当前工作区的正式询价单，没有记录时不会自动补入报价。"],
  noMatch: ["No RFQs match these filters", "没有符合筛选条件的询价单"],
} as const;

export function RfqListPage() {
  const { language, locale, timezone, formatNumber } = useI18n();
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const statusLabel = (status?: string) => status ? (RFQ_STATUS_LABELS[status] ? RFQ_STATUS_LABELS[status][language === "en-US" ? 0 : 1] : status) : "—";
  const [rows, setRows] = useState<ProcurementDocument[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [query, setQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  // Status, quotes and due live in the URL, so the metric cards can set them.
  const status = searchParams.get("status") || "";
  const quotes = searchParams.get("quotes") || "";
  const due = searchParams.get("due") || "";
  const setParam = (name: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(name, value); else params.delete(name);
    setSearchParams(params, { replace: true });
  };

  const load = useCallback(async () => {
    setState("loading");
    try {
      setRows(await procurementApi.listDocuments("rfq"));
      setState("loaded");
    } catch {
      setRows([]);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const today = todayInTimeZone(timezone);
  const inAWeek = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const isOpen = (row: ProcurementDocument) => OPEN_STATUSES.includes(String(row.status || ""));
  const quotesIn = (row: ProcurementDocument) => (row.supplierCount ?? 0) > 0 && (row.respondedSupplierCount ?? 0) >= (row.supplierCount ?? 0);
  const dueSoon = (row: ProcurementDocument) => isOpen(row) && Boolean(row.dueDate) && String(row.dueDate) <= inAWeek;
  const overdue = (row: ProcurementDocument) => isOpen(row) && Boolean(row.dueDate) && String(row.dueDate) < today;
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) =>
    (!status || row.status === status)
    && (!quotes || (quotes === "complete" ? quotesIn(row) : !quotesIn(row)))
    && (!due || dueSoon(row))
    && (!needle || [row.number, row.id, row.title, row.itemName, row.category].some((value) => String(value || "").toLowerCase().includes(needle))),
  );
  const reset = () => {
    setQuery("");
    setSearchParams({}, { replace: true });
  };
  const value = (count: number) => state === "loaded" ? String(count) : "—";

  return (
    <div className="space-y-5" data-testid="procurement-rfq-list">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={tr("open")} value={value(rows.filter(isOpen).length)} description={tr("openNote")} to="/app/procurement/rfq" icon={FileSearch} color={A.blue} />
        <ActionableMetricCard label={tr("collecting")} value={value(rows.filter((row) => row.status === "collecting_quotes").length)} description={tr("collectingNote")} to="/app/procurement/rfq?status=collecting_quotes" icon={Inbox} color={A.orange} />
        <ActionableMetricCard label={tr("complete")} value={value(rows.filter((row) => isOpen(row) && quotesIn(row)).length)} description={tr("completeNote")} to="/app/procurement/rfq?quotes=complete" icon={MessageSquareQuote} color={A.purple} />
        <ActionableMetricCard label={tr("dueSoon")} value={value(rows.filter(dueSoon).length)} description={tr("dueSoonNote")} to="/app/procurement/rfq?due=7" icon={CalendarClock} color={A.red} />
      </div>

      <ListSearchCard
        title={tr("searchTitle")}
        subtitle={tr("searchSubtitle")}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={() => void load()} />
        </>}
      >
        <Field label={tr("search")}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("searchPlaceholder")} style={inputStyle} />
        </Field>
        <Field label={tr("status")}>
          <select value={status} onChange={(event) => setParam("status", event.target.value)} style={inputStyle}>
            <option value="">{tr("allStatuses")}</option>
            {Object.keys(RFQ_STATUS_LABELS).map((code) => <option key={code} value={code}>{statusLabel(code)}</option>)}
          </select>
        </Field>
        <Field label={tr("quotes")}>
          <select value={quotes} onChange={(event) => setParam("quotes", event.target.value)} style={inputStyle}>
            <option value="">{tr("anyQuotes")}</option>
            <option value="complete">{tr("quotesComplete")}</option>
            <option value="waiting">{tr("quotesWaiting")}</option>
          </select>
        </Field>
        <Field label={tr("due")}>
          <select value={due} onChange={(event) => setParam("due", event.target.value)} style={inputStyle}>
            <option value="">{tr("anyDue")}</option>
            <option value="7">{tr("dueSoon")}</option>
          </select>
        </Field>
      </ListSearchCard>

      <ListCard title={tr("listTitle")} total={state === "loaded" ? rows.length : undefined} shown={shown.length}>
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[1040px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("rfq")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("subject")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{tr("quantity")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("responses")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("due")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("status")}</th>
                <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {state === "loading" && <ListStateRow colSpan={7} state="loading" />}
              {state === "error" && <ListStateRow colSpan={7} state="error" title={tr("loadFailed")} onRetry={() => void load()} />}
              {state === "loaded" && shown.length === 0 && (
                rows.length === 0
                  ? <ListStateRow colSpan={7} state="empty" title={tr("empty")} detail={tr("emptyDetail")} />
                  : <ListStateRow colSpan={7} state="empty" title={tr("noMatch")} />
              )}
              {state === "loaded" && shown.map((row, index) => {
                const responded = row.respondedSupplierCount ?? 0;
                return (
                  <tr key={row.id} className={listRowClass} style={listRowStyle(index, shown.length)}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <Link
                        className={`${tableLinkClass} text-blue-600`}
                        to={`/app/procurement/rfq/${encodeURIComponent(row.id || "")}`}
                        data-testid={`rfq-id-link-${row.id}`}
                      >
                        {row.number || row.id}
                      </Link>
                      {row.linkedPr && <div className="text-[11px] font-normal" style={{ color: A.sub }}>{tr("fromRequest")} <EntityLink kind="purchase_request" id={row.linkedPr} number={row.prNumber} className="text-[11px] font-medium" /></div>}
                    </td>
                    <td className={`${tdNameClass} max-w-[280px]`}>
                      <div className="truncate font-medium" style={{ color: A.label }} title={row.title}>{row.title || "—"}</div>
                      <div className="truncate text-[11px]" style={{ color: A.sub }}>{[row.itemName, row.category].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className={tdNumericRightClass}>{Number.isFinite(Number(row.quantity)) && row.quantity !== null && row.quantity !== undefined ? formatNumber(Number(row.quantity)) : "—"} {row.unit || ""}</td>
                    <td className={tdNowrapClass}>
                      <StatusChip label={`${responded} / ${row.supplierCount ?? 0}`} tone={quotesIn(row) ? "success" : responded > 0 ? "info" : "neutral"} />
                    </td>
                    <td className={tdNowrapClass} style={{ color: overdue(row) ? "#b91c1c" : A.sub }}>{row.dueDate ? formatCalendarDay(row.dueDate, locale) : "—"}</td>
                    <td className={tdNowrapClass}><StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} /></td>
                    <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                      <div className="flex items-center gap-1.5">
                        <Link to={`/app/procurement/rfq/${encodeURIComponent(row.id || "")}`} className={rowActionClass.primary}>{tr("view")}</Link>
                        {responded > 0 && <Link to={`/app/procurement/rfq/${encodeURIComponent(row.id || "")}/comparison`} className={rowActionClass.neutral}>{tr("compare")}</Link>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ListCard>
    </div>
  );
}
