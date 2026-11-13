import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { RefreshCw } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Card } from "../../components/ui";
import { StatusChip, listHeadRowStyle, listRowClass, listRowStyle, statusToneOf, type StatusTone } from "../../components/ui/listLayout";
import { listTableCardsRef, tableBodyTextClass, tableScrollClass, tdClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { unitLabel } from "../../i18n/unitLabels";
import { formatCalendarDay, formatInstantDay } from "../business-documents/documentFormat";
import { ApiError } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { procurementApi } from "./procurementApi";
import { BackToListLink } from "./BackToListLink";
import { looksLikeStoredId, useDetailCrumb } from "../../components/navigation/detailCrumb";
import type { ProcurementDocument } from "./procurementTypes";

// The read model adds the receipt's GRN number (grnNumber) and the supplier's
// invoice number (invoiceNumber) when they are recorded.
type DetailRecord = ProcurementDocument & { grnNumber?: string };

type DetailKind = "invoice" | "threeWayMatch";
type ReadState = "loading" | "loaded" | "notFound" | "unauthenticated" | "forbidden" | "error";

function readFailureState(error: unknown): Exclude<ReadState, "loading" | "loaded"> {
  if (!(error instanceof ApiError)) return "error";
  if (error.status === 404) return "notFound";
  if (error.status === 401) return "unauthenticated";
  if (error.status === 403) return "forbidden";
  return "error";
}

// English source copy with its Chinese translation.
const zh: Record<string, string> = {
  "Supplier invoice details": "采购发票详情", "Three-way match details": "三单匹配详情",
  "Read-only view of this workspace's purchasing records. Approval, matching and posting are not available here.": "只读查看当前工作区的采购单据，此处不能审批、匹配或过账。",
  "Read-only: this page compares the purchase order, receipt and supplier invoice. Variances are resolved on the supplier invoice.": "只读：本页比对采购订单、收货单和采购发票。差异在采购发票上处理。",
  "Refresh": "刷新", "Loading…": "正在读取…", "Retry": "重试",
  "This document was not found in the current workspace, or you cannot see it.": "当前工作区未找到该单据，或你无权查看。",
  "Document number: {id}": "单据编号：{id}",
  "Your session has expired or is missing": "登录已失效",
  "Sign in again to read this document.": "请重新登录后查看该单据。",
  "You do not have permission to view this document": "你没有查看该单据的权限",
  "Ask an administrator for access if you need to see it.": "如需查看，请联系管理员开通权限。",
  "This document cannot be read right now. Try again.": "该单据加载失败，请重试。",
  "The service or network could not be reached. Try again in a moment.": "暂时无法连接服务，请稍后重试。",
  "No linked supplier": "未关联供应商", "Supplier": "供应商", "Purchase order": "采购订单", "Receipt": "收货单",
  "Supplier invoice": "采购发票", "Three-way match": "三单匹配", "Invoice status": "发票状态", "Match status": "匹配状态",
  "PO amount": "采购订单金额", "Invoice amount": "发票金额", "Variance amount": "差异金额", "Currency": "币种",
  "Invoice date": "发票日期", "Due date": "到期日",
  "The linked three-way match does not exist or is not visible to this workspace.": "关联的三单匹配不存在，或在当前工作区不可见。",
  "Your session has expired, so the linked three-way match cannot be read.": "登录状态已失效，关联三单匹配加载失败。",
  "You do not have permission to view the linked three-way match.": "当前用户没有查看关联三单匹配的权限。",
  "The linked three-way match cannot be read right now. Refresh to try again.": "关联三单匹配加载失败，可刷新后重试。",
  // The line-by-line match.
  "Match by line": "按行匹配",
  "Each invoice line against its purchase order line: the invoiced quantity at the PO price, and the quantity received. Amounts exclude tax.": "逐行对照发票行与采购订单行：开票数量按订单单价计算，并与已收数量核对。金额不含税。",
  "PO line / item": "采购订单行 / 物料", "Ordered": "订购", "Received": "已收", "Invoiced": "开票",
  "PO price": "订单单价", "Invoice price": "发票单价", "Expected": "应开金额", "Invoiced (net)": "发票金额（不含税）", "Variance": "差异",
  "Invoice line": "发票行",
  "{qty} still to receive": "仍待收货 {qty}", "{qty} more than received": "超出已收 {qty}", "{qty} received, not invoiced": "已收未开票 {qty}",
  "Price variance {amount}": "价格差异 {amount}", "Quantity over received {amount}": "超收开票 {amount}",
  "Matched": "已匹配", "Price variance": "价格差异", "Amount variance": "金额差异", "Invoiced more than received": "开票数量超出已收",
  "Price and quantity variance": "价格与数量差异", "PO line not found": "未找到采购订单行",
  "Expected at PO prices": "按订单价应开金额", "Invoiced, net of tax": "发票金额（不含税）", "Tax": "税额", "Invoice total": "发票总额（含税）",
  "Still to receive on the purchase order: {qty}": "采购订单仍待收货：{qty}", "Ordered but not received yet; not a match variance.": "已订购但尚未收货，不计入匹配差异。",
  "One or more invoice lines differ from the purchase order price or the quantity received. Review the variance before proceeding.": "有发票行与采购订单单价或已收数量不一致，请复核差异后再处理。",
  "The variance recorded on the invoice is {amount}; the lines above add up to a different amount.": "发票上记录的差异金额为 {amount}，与上方各行合计不一致。",
  "Line detail is not available for this match, so only the recorded invoice amount and variance are shown. The purchase order total is not compared with the invoice.": "该匹配暂无行明细，因此仅显示发票记录的金额和差异，不将采购订单总额与发票比较。",
  "Amounts are hidden for your role.": "你的角色无法查看金额。",
  // The page heading and the way to the invoice, where a variance is resolved.
  "Three-way match · {invoice}": "三单匹配 · {invoice}", "Supplier invoice · {invoice}": "采购发票 · {invoice}",
  "Line {n}": "第 {n} 行",
  "Variances are reviewed and resolved on the supplier invoice.": "差异在采购发票上复核和处理。",
  "Resolve it on the supplier invoice": "到采购发票上处理差异",
  // Every difference approved: nothing left to resolve.
  "Differences approved on {invoice}.": "差异已在 {invoice} 上批准。",
  "Differences approved on the supplier invoice.": "差异已在采购发票上批准。",
};

function useDetailCopy() {
  const { language, locale, timezone } = useI18n();
  const copy = (value: string, params: Record<string, string> = {}) => {
    // Status tokens and server text come in Chinese or as codes; workspaceCopy
    // maps the ones it knows (a status code gets its label in either language).
    const text = language === "en-US" ? (zh[value] ? value : workspaceCopy(value, language)) : zh[value] || workspaceCopy(value, language);
    return Object.entries(params).reduce((result, [key, param]) => result.replaceAll(`{${key}}`, param), text);
  };
  return { copy, locale, timezone };
}

// A recorded calendar day prints as that day; an instant prints as the day it
// falls on in the workspace timezone. Both in the workspace locale.
function day(value: string | undefined, locale: string, timezone: string) {
  if (!value) return "—";
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? formatCalendarDay(value, locale) : formatInstantDay(value, locale, timezone);
}

function readFailureMessage(error: unknown) {
  const state = readFailureState(error);
  if (state === "notFound") return "The linked three-way match does not exist or is not visible to this workspace.";
  if (state === "unauthenticated") return "Your session has expired, so the linked three-way match cannot be read.";
  if (state === "forbidden") return "You do not have permission to view the linked three-way match.";
  return "The linked three-way match cannot be read right now. Refresh to try again.";
}

function money(value: number | undefined, currency: string | undefined, locale: string) {
  if (!Number.isFinite(value)) return "—";
  const code = String(currency || "").trim().toUpperCase();
  // Never assume a currency: without one the amount is shown as a plain number.
  return new Intl.NumberFormat(locale || "en-US", code
    ? { style: "currency", currency: code, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 2 }).format(Number(value));
}

// One invoice line against its PO line, as the read model returns it. Amounts
// are net of tax and null when the role cannot see them.
type MatchLine = {
  invoiceLineId?: string;
  poLineId?: string;
  grnLineId?: string;
  sku?: string;
  itemName?: string;
  unit?: string;
  orderedQty?: number | null;
  receivedQty?: number | null;
  invoicedQty?: number | null;
  receivingGapQty?: number | null;
  quantityVariance?: number | null;
  uninvoicedReceivedQty?: number | null;
  poUnitPrice?: number | null;
  invoiceUnitPrice?: number | null;
  expectedAmount?: number | null;
  invoiceLineAmount?: number | null;
  taxAmount?: number | null;
  priceVariance?: number | null;
  varianceAmount?: number | null;
  quantityVarianceAmount?: number | null;
  status?: string;
};
type MatchDocument = ProcurementDocument & {
  // Absent when the server predates the line-by-line match.
  lines?: MatchLine[];
  expectedAmount?: number | null;
  invoiceNetAmount?: number | null;
  taxAmount?: number | null;
  lineVarianceAmount?: number | null;
  lineVarianceTotal?: number | null;
  quantityVarianceAmount?: number | null;
  receivingGapQty?: number | null;
  lineMatchStatus?: string;
  restrictedFields?: string[];
};

// Line status codes from the read model, with their label and tone.
const LINE_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  matched: { label: "Matched", tone: "success" },
  price_variance: { label: "Price variance", tone: "danger" },
  amount_variance: { label: "Amount variance", tone: "danger" },
  quantity_variance: { label: "Invoiced more than received", tone: "danger" },
  price_and_quantity_variance: { label: "Price and quantity variance", tone: "danger" },
  po_line_unavailable: { label: "PO line not found", tone: "warning" },
};

const MONEY_EPSILON = 0.005;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <dt className="text-xs" style={{ color: A.sub }}>{label}</dt>
      <dd className="mt-1 text-sm font-medium">{children}</dd>
    </div>
  );
}

type Copy = (value: string, params?: Record<string, string>) => string;

// The match line by line, with a summary that adds up: expected at PO prices
// plus the variance is the invoiced net amount, plus tax the invoice total.
function LineMatch({ match, invoiceTotal, currency, copy, locale }: {
  match: MatchDocument;
  invoiceTotal: number | undefined;
  currency: string | undefined;
  copy: Copy;
  locale: string;
}) {
  const { formatNumber, language } = useI18n();
  const lines = match.lines || [];
  const amount = (value: number | null | undefined) => money(finite(value) ? value : undefined, currency, locale);
  // A variance with its sign: +$200.00 over the PO, -$50.00 under it.
  const signed = (value: number | null | undefined) => !finite(value)
    ? "—"
    : `${value >= MONEY_EPSILON ? "+" : ""}${amount(Math.abs(value) < MONEY_EPSILON ? 0 : value)}`;
  const qty = (value: number | null | undefined) => (finite(value) ? formatNumber(value) : "—");
  const priceVariance = lines.reduce((sum, line) => sum + (finite(line.priceVariance) ? line.priceVariance : 0), 0);
  const summary: Array<{ label: string; value: string; strong?: boolean; helper?: string; testId: string }> = [
    { label: copy("Expected at PO prices"), value: amount(match.expectedAmount), testId: "match-expected" },
    {
      label: copy("Variance"),
      value: signed(match.lineVarianceAmount),
      helper: finite(match.lineVarianceAmount) && Math.abs(priceVariance) >= MONEY_EPSILON ? copy("Price variance {amount}", { amount: signed(priceVariance) }) : undefined,
      testId: "match-variance",
    },
    { label: copy("Invoiced, net of tax"), value: amount(match.invoiceNetAmount), strong: true, testId: "match-invoiced-net" },
    ...(match.taxAmount !== undefined && match.taxAmount !== null ? [{ label: copy("Tax"), value: amount(match.taxAmount), testId: "match-tax" }] : []),
    ...(finite(invoiceTotal) || match.restrictedFields?.includes("amounts") ? [{ label: copy("Invoice total"), value: amount(invoiceTotal), strong: true, testId: "match-invoice-total" }] : []),
  ];
  const gap = finite(match.receivingGapQty) ? match.receivingGapQty : 0;

  return (
    <section className="mt-5" data-testid="three-way-match-lines">
      <div className="text-sm font-semibold">{copy("Match by line")}</div>
      <p className="mt-1 text-xs" style={{ color: A.sub }}>
        {copy("Each invoice line against its purchase order line: the invoiced quantity at the PO price, and the quantity received. Amounts exclude tax.")}
      </p>
      {/* On a phone each invoice line is a card (listTableCardsRef), not a table to scroll sideways. */}
      <div ref={listTableCardsRef} className={`mt-3 rounded-lg border ${tableScrollClass}`}>
        <table className={`w-full ${tableBodyTextClass}`}>
          <thead>
            <tr style={listHeadRowStyle}>
              <th scope="col" className={thClass} style={{ color: A.gray1 }}>{copy("PO line / item")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("Ordered")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("Received")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("Invoiced")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("PO price")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("Invoice price")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("Expected")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("Invoiced (net)")}</th>
              <th scope="col" className={thRightClass} style={{ color: A.gray1 }}>{copy("Variance")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const status = LINE_STATUS[line.status || ""];
              const lineGap = finite(line.receivingGapQty) ? line.receivingGapQty : 0;
              const over = finite(line.quantityVariance) ? line.quantityVariance : 0;
              const notInvoiced = finite(line.uninvoicedReceivedQty) ? line.uninvoicedReceivedQty : 0;
              const subClass = "mt-0.5 text-[11px] font-normal leading-4";
              return (
                <tr key={line.invoiceLineId || index} className={listRowClass} style={listRowStyle(index, lines.length)} data-testid="three-way-match-line">
                  <td className={`${tdClass} align-top`}>
                    <div className="whitespace-nowrap font-medium" title={[line.poLineId, line.invoiceLineId].filter(Boolean).join(" · ") || undefined}>{copy("Line {n}", { n: String(index + 1) })}</div>
                    <div className={subClass} style={{ color: A.sub }}>{[line.sku, line.itemName, line.unit ? unitLabel(line.unit, language) : ""].filter(Boolean).join(" · ") || "—"}</div>
                  </td>
                  <td className={`${tdNumericRightClass} align-top`}>{qty(line.orderedQty)}</td>
                  <td className={`${tdNumericRightClass} align-top`}>
                    {qty(line.receivedQty)}
                    {/* Still to receive on the PO: information, not a match variance. */}
                    {lineGap > 0 ? <div className={subClass} style={{ color: A.sub }}>{copy("{qty} still to receive", { qty: formatNumber(lineGap) })}</div> : null}
                  </td>
                  <td className={`${tdNumericRightClass} align-top`}>
                    {qty(line.invoicedQty)}
                    {over > 0
                      ? <div className={`${subClass} text-red-700`}>{copy("{qty} more than received", { qty: formatNumber(over) })}</div>
                      : notInvoiced > 0 ? <div className={subClass} style={{ color: A.sub }}>{copy("{qty} received, not invoiced", { qty: formatNumber(notInvoiced) })}</div> : null}
                  </td>
                  <td className={`${tdNumericRightClass} align-top`}>{amount(line.poUnitPrice)}</td>
                  <td className={`${tdNumericRightClass} align-top`}>{amount(line.invoiceUnitPrice)}</td>
                  <td className={`${tdNumericRightClass} align-top`}>
                    {amount(line.expectedAmount)}
                    <div className={subClass} style={{ color: A.sub }}>{qty(line.invoicedQty)} × {amount(line.poUnitPrice)}</div>
                  </td>
                  <td className={`${tdNumericRightClass} align-top`}>
                    {amount(line.invoiceLineAmount)}
                    {finite(line.taxAmount) && line.taxAmount ? <div className={subClass} style={{ color: A.sub }}>{copy("Tax")} {amount(line.taxAmount)}</div> : null}
                  </td>
                  <td className={`${tdNumericRightClass} align-top font-medium`}>
                    {signed(line.varianceAmount)}
                    {finite(line.quantityVarianceAmount) && line.quantityVarianceAmount >= MONEY_EPSILON
                      ? <div className={subClass} style={{ color: A.sub }}>{copy("Quantity over received {amount}", { amount: amount(line.quantityVarianceAmount) })}</div>
                      : null}
                    <div className="mt-1 flex justify-end font-normal" data-testid="three-way-match-line-status">
                      {status ? <StatusChip label={copy(status.label)} tone={status.tone} /> : line.status ? <StatusChip label={copy(line.status)} tone={statusToneOf(line.status)} /> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <div className="text-xs" style={{ color: A.sub }}>
          {gap > 0 ? (
            <div className="rounded-lg bg-slate-50 p-3" data-testid="match-receiving-gap">
              <div className="font-medium" style={{ color: A.label }}>{copy("Still to receive on the purchase order: {qty}", { qty: formatNumber(gap) })}</div>
              <div className="mt-1">{copy("Ordered but not received yet; not a match variance.")}</div>
            </div>
          ) : null}
        </div>
        <dl className="rounded-lg bg-slate-50 p-3 text-sm" data-testid="three-way-match-summary">
          {summary.map((row) => (
            <div key={row.testId} className={`flex items-baseline justify-between gap-4 py-1 ${row.strong ? "border-t border-slate-200 font-semibold" : ""}`} data-testid={row.testId}>
              <dt className={row.strong ? "" : "text-xs"} style={row.strong ? undefined : { color: A.sub }}>
                {row.label}
                {row.helper ? <div className="text-[11px] font-normal" style={{ color: A.sub }}>{row.helper}</div> : null}
              </dt>
              <dd className="whitespace-nowrap text-right tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function ProcurementDocumentDetailPage({
  kind,
  documentId,
}: {
  kind: DetailKind;
  documentId: string;
}) {
  const [record, setRecord] = useState<DetailRecord | null>(null);
  const [relatedMatch, setRelatedMatch] = useState<DetailRecord | null>(null);
  const [relatedMatchNotice, setRelatedMatchNotice] = useState("");
  const [state, setState] = useState<ReadState>("loading");
  const { copy, locale, timezone } = useDetailCopy();
  // Statuses keep their recorded value; the chip shows its label and tone.
  const statusChip = (value?: string) => value ? <StatusChip label={copy(value)} tone={statusToneOf(value)} /> : "—";

  const load = useCallback(async () => {
    if (!documentId) {
      setState("notFound");
      return;
    }
    setState("loading");
    setRecord(null);
    setRelatedMatch(null);
    setRelatedMatchNotice("");
    try {
      const document = await procurementApi.getDocument(kind, documentId);
      setRecord(document);
      setState("loaded");

      if (kind === "invoice") {
        const matchReference = document.relatedDocuments?.find(
          (candidate) => candidate.type === "threeWayMatch" && candidate.id,
        );
        if (matchReference) {
          try {
            setRelatedMatch(
              await procurementApi.getDocument("threeWayMatch", matchReference.id),
            );
          } catch (error) {
            setRelatedMatchNotice(readFailureMessage(error));
          }
        }
      }
    } catch (error) {
      setRecord(null);
      setRelatedMatch(null);
      setState(readFailureState(error));
    }
  }, [documentId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const isInvoice = kind === "invoice";
  const title = copy(isInvoice ? "Supplier invoice details" : "Three-way match details");
  const status = record?.matchStatus || record?.invoiceStatus || record?.status || "—";
  const poId = record?.relatedPo || record?.poId || record?.po;
  const grnId = record?.relatedGrn || record?.grnId;
  const invoiceId = isInvoice ? record?.id : record?.invoiceId;
  // The page names the match by the supplier's invoice number, and the
  // receipt by its GRN number. Without a recorded number an id that reads as
  // a name (INV-001) is shown, never a stored id such as a UUID: the heading
  // and breadcrumb then say "Three-way match" without a number.
  const readable = (value?: string) => (value && !looksLikeStoredId(value) ? value : "");
  const invoiceNumber = record?.invoiceNumber || readable(invoiceId);
  const grnNumber = record?.grnNumber || grnId;
  const heading = invoiceNumber
    ? copy(isInvoice ? "Supplier invoice · {invoice}" : "Three-way match · {invoice}", { invoice: invoiceNumber })
    : copy(isInvoice ? "Supplier invoice" : "Three-way match");
  useDetailCrumb(state === "loaded" ? invoiceNumber || null : null);
  // A variance is resolved on the supplier invoice; this page only reads.
  const canResolveOnInvoice = !isInvoice && Boolean(invoiceId);
  // The match, read line by line when the server returns its lines. Without
  // them (an older server, or an invoice with no lines) the page shows the
  // recorded invoice amount and variance only, never the whole PO total
  // against a partial invoice.
  const match = (isInvoice ? relatedMatch : record) as MatchDocument | null;
  const matchLines = Array.isArray(match?.lines) && match.lines.length ? match.lines : null;
  const invoiceTotal = isInvoice ? record?.amount ?? record?.invoiceAmount : record?.invoiceAmount ?? record?.amount;
  const recordedVariance = record?.varianceAmount;
  const varianceDisagrees = Boolean(matchLines) && finite(recordedVariance) && finite(match?.lineVarianceTotal)
    && Math.abs(Math.abs(recordedVariance) - match.lineVarianceTotal) >= MONEY_EPSILON;
  const storedReason =
    record?.blockingReason ||
    record?.exceptionReason ||
    relatedMatch?.blockingReason ||
    relatedMatch?.exceptionReason;
  // Every difference approved (the read model's variance_approved, also for
  // invoices approved before it was stored): the variance stays on record,
  // but there is nothing left to review or resolve.
  const varianceApproved = [status, match?.matchStatus, record?.matchStatus].includes("variance_approved");
  // With lines, the reason comes from them; the stored reason speaks of PO and
  // invoice totals.
  const blockingReason = varianceApproved ? "" : matchLines
    ? match?.lineMatchStatus === "variance" ? "One or more invoice lines differ from the purchase order price or the quantity received. Review the variance before proceeding." : ""
    : storedReason;

  return (
    <div className="space-y-4" data-testid={`procurement-${kind}-detail`}>
      <BackToListLink list={isInvoice ? "bills" : "match"} />
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            {isInvoice
              ? copy("Read-only view of this workspace's purchasing records. Approval, matching and posting are not available here.")
              : copy("Read-only: this page compares the purchase order, receipt and supplier invoice. Variances are resolved on the supplier invoice.")}
          </div>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs">
          <RefreshCw size={14} />
          {copy("Refresh")}
        </button>
      </Card>

      <Card className="p-4 sm:p-5">
        {state === "loading" ? (
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>{copy("Loading…")}</div>
        ) : state === "notFound" ? (
          <div className="py-16 text-center" data-testid="procurement-document-not-found">
            <div className="text-sm font-semibold">{copy("This document was not found in the current workspace, or you cannot see it.")}</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>{copy("Document number: {id}", { id: documentId })}</div>
          </div>
        ) : state === "unauthenticated" ? (
          <div className="py-16 text-center" data-testid="procurement-document-unauthenticated">
            <div className="text-sm font-semibold">{copy("Your session has expired or is missing")}</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>{copy("Sign in again to read this document.")}</div>
          </div>
        ) : state === "forbidden" ? (
          <div className="py-16 text-center" data-testid="procurement-document-forbidden">
            <div className="text-sm font-semibold">{copy("You do not have permission to view this document")}</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>{copy("Ask an administrator for access if you need to see it.")}</div>
          </div>
        ) : state === "error" ? (
          <div className="py-16 text-center" data-testid="procurement-document-read-error">
            <div className="text-sm font-semibold">{copy("This document cannot be read right now. Try again.")}</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>{copy("The service or network could not be reached. Try again in a moment.")}</div>
            <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">{copy("Retry")}</button>
          </div>
        ) : !record ? (
          <div className="py-16 text-center" data-testid="procurement-document-read-error">
            <div className="text-sm font-semibold">{copy("This document cannot be read right now. Try again.")}</div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="fc-page-title" style={{ color: A.label }} title={record.id || documentId} data-testid="procurement-document-heading">{heading}</h1>
                <p className="mt-1 text-sm" style={{ color: A.sub }}>{record.supplierName || copy("No linked supplier")}</p>
              </div>
              {statusChip(status === "—" ? undefined : status)}
            </div>

            <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label={copy("Supplier")}>
                <BusinessEntityLink entityType="supplier" entityId={record.supplierId}>{record.supplierName || record.supplierId || "—"}</BusinessEntityLink>
              </Fact>
              <Fact label={copy("Purchase order")}>
                <BusinessEntityLink entityType="purchase_order" entityId={poId} number={record?.poNumber} />
              </Fact>
              <Fact label={copy("Receipt")}>
                <BusinessEntityLink entityType="receiving_doc" entityId={grnId}>{grnNumber || "—"}</BusinessEntityLink>
              </Fact>
              {!isInvoice && (
                <Fact label={copy("Supplier invoice")}>
                  <BusinessEntityLink entityType="supplier_invoice" entityId={invoiceId}>{record.invoiceNumber || invoiceId || "—"}</BusinessEntityLink>
                </Fact>
              )}
              {isInvoice && relatedMatch && (
                <Fact label={copy("Three-way match")}>
                  <BusinessEntityLink entityType="three_way_match" entityId={relatedMatch.id}>{relatedMatch.invoiceNumber || readable(relatedMatch.invoiceId) || relatedMatch.id || "—"}</BusinessEntityLink>
                </Fact>
              )}
              {isInvoice ? (
                <>
                  <Fact label={copy("Invoice status")}>{statusChip(record.invoiceStatus)}</Fact>
                  <Fact label={copy("Match status")}>{statusChip(record.matchStatus)}</Fact>
                </>
              ) : (
                <Fact label={copy("Match status")}>{statusChip(status === "—" ? undefined : status)}</Fact>
              )}
              {!matchLines && <Fact label={copy("Invoice amount")}>{money(invoiceTotal, record.currency, locale)}</Fact>}
              {!matchLines && <Fact label={copy("Variance amount")}>{money(recordedVariance, record.currency, locale)}</Fact>}
              <Fact label={copy("Currency")}>{record.currency || "—"}</Fact>
              {isInvoice && <Fact label={copy("Invoice date")}>{day(record.invoiceDate, locale, timezone)}</Fact>}
              {isInvoice && <Fact label={copy("Due date")}>{day(record.dueDate, locale, timezone)}</Fact>}
            </dl>

            {blockingReason && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-900" data-testid="three-way-match-blocking-reason">
                <span>{copy(blockingReason)}</span>
                {canResolveOnInvoice && (
                  <Link to={`/app/procurement/bills/${encodeURIComponent(invoiceId || "")}`} className="whitespace-nowrap font-semibold text-blue-600 hover:underline" data-testid="three-way-match-resolve-link">{copy("Resolve it on the supplier invoice")} →</Link>
                )}
              </div>
            )}
            {varianceApproved && (
              <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-900" data-testid="three-way-match-variance-approved">
                {invoiceNumber ? copy("Differences approved on {invoice}.", { invoice: invoiceNumber }) : copy("Differences approved on the supplier invoice.")}
              </div>
            )}
            {!blockingReason && !varianceApproved && canResolveOnInvoice && (
              <p className="mt-4 text-xs" style={{ color: A.sub }}>{copy("Variances are reviewed and resolved on the supplier invoice.")}</p>
            )}
            {matchLines && match ? (
              <LineMatch match={match} invoiceTotal={invoiceTotal} currency={match.currency || record.currency} copy={copy} locale={locale} />
            ) : match ? (
              <div className="mt-4 rounded-lg bg-slate-50 px-3 py-3 text-xs" style={{ color: A.sub }} data-testid="three-way-match-no-lines">
                {copy("Line detail is not available for this match, so only the recorded invoice amount and variance are shown. The purchase order total is not compared with the invoice.")}
              </div>
            ) : null}
            {varianceDisagrees && (
              <div className="mt-3 rounded-lg bg-slate-50 px-3 py-3 text-xs" style={{ color: A.sub }} data-testid="three-way-match-recorded-variance">
                {copy("The variance recorded on the invoice is {amount}; the lines above add up to a different amount.", { amount: money(recordedVariance, record.currency, locale) })}
              </div>
            )}
            {match?.restrictedFields?.includes("amounts") && (
              <div className="mt-3 text-xs" style={{ color: A.sub }}>{copy("Amounts are hidden for your role.")}</div>
            )}
            {relatedMatchNotice && (
              <div className="mt-4 rounded-lg bg-slate-50 px-3 py-3 text-xs" style={{ color: A.sub }} data-testid="related-match-read-limitation">
                {copy(relatedMatchNotice)}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
