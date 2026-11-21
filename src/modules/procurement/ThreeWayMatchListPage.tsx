import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertCircle, CheckCircle2, Clock3, Scale } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, StatusChip, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, type StatusTone } from "../../components/ui/listLayout";
import { STATUS_TONE_COLORS } from "../../components/ui/statusTones";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { procurementApi } from "./procurementApi";
import { ListPager, usePagedRows } from "./listPaging";
import { matchResultOf, type MatchResult } from "./threeWayMatchResult";
import type { ProcurementDocument } from "./procurementTypes";
import { useI18n } from "../../i18n/I18n";
import { formatLocaleAmount } from "../../lib/format";

// Rows to a page, as on the purchase order list (design audit U-14).
const PAGE_SIZE = 50;

function money(value: number | undefined, currency: string | undefined, locale: string) {
  if (!Number.isFinite(value)) return "—";
  return formatLocaleAmount(Number(value), currency, locale, { maximumFractionDigits: 2 });
}

const COPY = {
  all: ["Matches", "匹配记录"],
  allNote: ["Supplier invoices checked against PO and receipt", "已与采购订单和收货核对的发票"],
  matched: ["Matched", "已匹配"],
  // The tile also counts matches whose differences were all approved.
  matchedNote: ["Amounts agree, or differences approved", "金额一致，或差异已批准"],
  pending: ["Pending", "待处理"],
  pendingNote: ["Waiting for a receipt or a review", "等待收货或复核"],
  variance: ["Variances", "差异"],
  varianceNote: ["Invoice differs from the PO or receipt", "发票与采购订单或收货不一致"],
  searchTitle: ["Three-way match search", "三单匹配查询"],
  searchSubtitle: ["Compare purchase orders, goods receipts and supplier invoices to review matching results and variances.", "比对采购订单、收货单与采购发票，复核匹配结果和差异。"],
  search: ["Search", "搜索"],
  searchPlaceholder: ["Invoice, PO or receipt number", "发票、采购订单或收货单号"],
  supplier: ["Supplier", "供应商"],
  allSuppliers: ["All suppliers", "全部供应商"],
  result: ["Result", "结果"],
  allResults: ["All results", "全部结果"],
  listTitle: ["Match list", "匹配列表"],
  // A match is named by its supplier invoice's number, as its page is.
  match: ["Match", "匹配"],
  documents: ["PO / receipt", "采购订单 / 收货单"],
  invoiceAmount: ["Invoice amount", "发票金额"],
  varianceAmount: ["Variance", "差异金额"],
  status: ["Status", "状态"],
  noSupplier: ["No supplier linked", "未关联供应商"],
  loading: ["Loading three-way matches…", "正在读取三单匹配…"],
  loadFailed: ["Three-way matches could not be loaded", "三单匹配加载失败"],
  empty: ["No three-way matches yet", "暂无三单匹配记录"],
  emptyDetail: ["A match needs a real purchase order, receipt and supplier invoice.", "需要真实采购订单、收货单和采购发票后才能形成匹配。"],
  noMatch: ["No matches fit these filters", "没有符合筛选条件的匹配记录"],
  actions: ["Actions", "操作"],
  view: ["View", "查看"],
} as const;

// A match as the list reads it: the read model adds the supplier's invoice
// number (invoiceNumber) and the receipt's GRN number (grnNumber), when
// recorded, to the ids it links by.
type MatchRow = ProcurementDocument & { grnNumber?: string };

// Each match reads as Matched, Pending or Variances by its match status
// (matchResultOf): the cards and ?result= use the same rule, and a match
// inside the tolerance keeps its small variance in the Variance column.
const RESULT_TONE: Record<MatchResult, StatusTone> = { matched: "success", pending: "warning", variance: "danger" };

export function ThreeWayMatchListPage() {
  const copy = useWorkspaceCopy();
  const { locale, language } = useI18n();
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [searchParams, setSearchParams] = useSearchParams();
  // A PO's "View three-way match" opens its matches: ?q=<PO number> (design audit U-20).
  const [query, setQuery] = useState(() => searchParams.get("q") || "");
  const [supplier, setSupplier] = useState("");
  const result = searchParams.get("result") || "";
  const setResult = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("result", next); else params.delete("result");
    setSearchParams(params, { replace: true });
  };

  const load = useCallback(async () => {
    setState("loading");
    try {
      setRows(await procurementApi.listDocuments("threeWayMatch"));
      setState("loaded");
    } catch {
      setRows([]);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const poOf = (row: MatchRow) => row.poId || row.po || row.relatedPo || "";
  // The numbers people read; the id only when no number is recorded.
  const invoiceOf = (row: MatchRow) => row.invoiceNumber || row.invoiceId || row.id || "";
  const receiptOf = (row: MatchRow) => row.grnNumber || row.grnId || "";
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) =>
    (!result || matchResultOf(row) === result)
    && (!supplier || row.supplierName === supplier)
    && (!needle || [row.invoiceNumber, row.poNumber, row.grnNumber, row.id, poOf(row), row.grnId, row.invoiceId].some((value) => String(value || "").toLowerCase().includes(needle))),
  );
  const paged = usePagedRows(shown, PAGE_SIZE, [result, supplier, needle].join("|"));
  const suppliers = [...new Set(rows.map((row) => String(row.supplierName || "")).filter(Boolean))].sort();
  const count = (name: MatchResult) => rows.filter((row) => matchResultOf(row) === name).length;
  const value = (count: number) => state === "loaded" ? String(count) : "—";
  const reset = () => {
    setQuery("");
    setSupplier("");
    setResult("");
  };

  return (
    <div className="space-y-5" data-testid="procurement-three-way-match-list">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={tr("all")} value={value(rows.length)} description={tr("allNote")} to="/app/procurement/three-way-match" icon={Scale} color={A.blue} />
        <ActionableMetricCard label={tr("matched")} value={value(count("matched"))} description={tr("matchedNote")} to="/app/procurement/three-way-match?result=matched" icon={CheckCircle2} color={A.success} />
        <ActionableMetricCard label={tr("pending")} value={value(count("pending"))} description={tr("pendingNote")} to="/app/procurement/three-way-match?result=pending" icon={Clock3} color={A.orange} />
        <ActionableMetricCard label={tr("variance")} value={value(count("variance"))} description={tr("varianceNote")} to="/app/procurement/three-way-match?result=variance" icon={AlertCircle} color={A.red} />
      </div>

      <ListSearchCard
        title={tr("searchTitle")}
        subtitle={tr("searchSubtitle")}
        activeFilters={[supplier, result].filter(Boolean).length}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={() => void load()} />
        </>}
      >
        <Field label={tr("search")}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("searchPlaceholder")} style={inputStyle} />
        </Field>
        <Field label={tr("supplier")}>
          <select value={supplier} onChange={(event) => setSupplier(event.target.value)} style={inputStyle}>
            <option value="">{tr("allSuppliers")}</option>
            {suppliers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label={tr("result")}>
          <select value={result} onChange={(event) => setResult(event.target.value)} style={inputStyle}>
            <option value="">{tr("allResults")}</option>
            <option value="matched">{tr("matched")}</option>
            <option value="pending">{tr("pending")}</option>
            <option value="variance">{tr("variance")}</option>
          </select>
        </Field>
      </ListSearchCard>

      <ListCard title={tr("listTitle")} total={state === "loaded" ? shown.length : undefined} all={state === "loaded" ? rows.length : undefined} shown={paged.pageRows.length} testId="three-way-match-record-list">
        {/* Six columns that fit a 1440 px window: the match by its invoice
            number, the PO and receipt by theirs, the invoice amount, the
            variance and the status. The whole PO amount is not a column: an
            invoice may bill part of the order, and the match page compares
            it line by line. */}
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[900px] text-left ${tableBodyTextClass}`} data-testid="three-way-match-table">
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("match")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("supplier")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("documents")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{tr("invoiceAmount")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{tr("varianceAmount")}</th>
                <th className={thClass} style={{ color: A.gray1 }} data-card-status="">{tr("status")}</th>
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
              {state === "loaded" && paged.pageRows.map((row, index) => {
                const reason = row.blockingReason || row.exceptionReason;
                const variance = Number(row.varianceAmount || 0);
                return (
                  <tr key={row.id} className={`${listRowClass} align-top`} style={listRowStyle(index, paged.pageRows.length)} data-testid="three-way-match-row">
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <BusinessEntityLink entityType="three_way_match" entityId={row.id} className={tableLinkClass}>{invoiceOf(row)}</BusinessEntityLink>
                    </td>
                    <td className={`${tdNameClass} max-w-[200px] truncate`} title={row.supplierName}>{row.supplierName || <span style={{ color: A.gray2 }}>{tr("noSupplier")}</span>}</td>
                    <td className={tdNowrapClass}>
                      <div className="flex flex-col gap-0.5 text-[12px]">
                        <BusinessEntityLink entityType="purchase_order" entityId={poOf(row)} number={row.poNumber} />
                        <BusinessEntityLink entityType="receiving_doc" entityId={row.grnId}>{receiptOf(row) || "—"}</BusinessEntityLink>
                      </div>
                    </td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.invoiceAmount, row.currency, locale)}</td>
                    {/* Red only while the variance waits on a decision; an approved one, or one inside the tolerance, stays on record in gray. */}
                    <td className={tdNumericRightClass} style={{ color: variance && matchResultOf(row) === "variance" ? STATUS_TONE_COLORS.danger.color : A.sub }}>{money(row.varianceAmount, row.currency, locale)}</td>
                    <td className={`${tdNameClass} min-w-[160px]`}>
                      <StatusChip label={copy(row.matchStatus || row.status || "—")} tone={RESULT_TONE[matchResultOf(row)]} />
                      {reason && <div className="mt-1 max-w-[260px] whitespace-normal text-[11px] leading-4 text-amber-800">{copy(reason)}</div>}
                    </td>
                    {/* A blue View, as on every other list (design audit U-20). */}
                    <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                      {/* Named "View", not by the match: the number's link carries that name. */}
                      <Link to={`/app/procurement/three-way-match/${encodeURIComponent(row.id || "")}`} className={rowActionClass.primary} data-testid="three-way-match-view">{tr("view")}</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {state === "loaded" && <ListPager page={paged.page} pageSize={PAGE_SIZE} total={shown.length} onPage={paged.setPage} testId="three-way-match-pager" />}
      </ListCard>
    </div>
  );
}
