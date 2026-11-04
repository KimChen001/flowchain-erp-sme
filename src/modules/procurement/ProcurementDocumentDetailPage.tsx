import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Card } from "../../components/ui";
import { StatusChip, statusToneOf } from "../../components/ui/listLayout";
import { formatCalendarDay, formatInstantDay } from "../business-documents/documentFormat";
import { ApiError } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { procurementApi } from "./procurementApi";
import type { ProcurementDocument } from "./procurementTypes";

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
  "Supplier invoice details": "供应商发票详情", "Three-way match details": "三单匹配详情",
  "Read-only view of this workspace's purchasing records. Approval, matching and posting are not available here.": "只读查看当前工作区的采购单据，此处不能审批、匹配或过账。",
  "Refresh": "刷新", "Loading…": "正在读取…", "Retry": "重试",
  "This document was not found in the current workspace, or you cannot see it.": "当前工作区未找到该单据，或您无权查看。",
  "Document number: {id}": "单据编号：{id}",
  "Your session has expired or is missing": "登录已失效",
  "Sign in again to read this document.": "请重新登录后查看该单据。",
  "You do not have permission to view this document": "您没有查看该单据的权限",
  "Ask an administrator for access if you need to see it.": "如需查看，请联系管理员开通权限。",
  "This document cannot be read right now. Try again.": "该单据暂时无法读取，请重试。",
  "The service or network could not be reached. Try again in a moment.": "暂时无法连接服务，请稍后重试。",
  "No linked supplier": "未关联供应商", "Supplier": "供应商", "Purchase order": "采购订单", "Receipt": "收货单",
  "Supplier invoice": "供应商发票", "Three-way match": "三单匹配", "Invoice status": "发票状态", "Match status": "匹配状态",
  "PO amount": "采购订单金额", "Invoice amount": "发票金额", "Variance amount": "差异金额", "Currency": "币种",
  "Invoice date": "发票日期", "Due date": "到期日",
  "The linked three-way match does not exist or is not visible to this workspace.": "关联的三单匹配不存在，或在当前工作区不可见。",
  "Your session has expired, so the linked three-way match cannot be read.": "登录状态已失效，无法读取关联三单匹配。",
  "You do not have permission to view the linked three-way match.": "当前用户没有查看关联三单匹配的权限。",
  "The linked three-way match cannot be read right now. Refresh to try again.": "关联三单匹配暂时无法读取，可刷新后重试。",
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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <dt className="text-xs" style={{ color: A.sub }}>{label}</dt>
      <dd className="mt-1 text-sm font-medium">{children}</dd>
    </div>
  );
}

export function ProcurementDocumentDetailPage({
  kind,
  documentId,
}: {
  kind: DetailKind;
  documentId: string;
}) {
  const [record, setRecord] = useState<ProcurementDocument | null>(null);
  const [relatedMatch, setRelatedMatch] = useState<ProcurementDocument | null>(null);
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
  const blockingReason =
    record?.blockingReason ||
    record?.exceptionReason ||
    relatedMatch?.blockingReason ||
    relatedMatch?.exceptionReason;

  return (
    <div className="space-y-4" data-testid={`procurement-${kind}-detail`}>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            {copy("Read-only view of this workspace's purchasing records. Approval, matching and posting are not available here.")}
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
                <h2 className="text-xl font-semibold">{record.id || documentId}</h2>
                <p className="mt-1 text-sm" style={{ color: A.sub }}>{record.supplierName || copy("No linked supplier")}</p>
              </div>
              {statusChip(status === "—" ? undefined : status)}
            </div>

            <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label={copy("Supplier")}>
                <BusinessEntityLink entityType="supplier" entityId={record.supplierId}>{record.supplierName || record.supplierId || "—"}</BusinessEntityLink>
              </Fact>
              <Fact label={copy("Purchase order")}>
                <BusinessEntityLink entityType="purchase_order" entityId={poId}>{poId || "—"}</BusinessEntityLink>
              </Fact>
              <Fact label={copy("Receipt")}>
                <BusinessEntityLink entityType="receiving_doc" entityId={grnId}>{grnId || "—"}</BusinessEntityLink>
              </Fact>
              {!isInvoice && (
                <Fact label={copy("Supplier invoice")}>
                  <BusinessEntityLink entityType="supplier_invoice" entityId={invoiceId}>{invoiceId || "—"}</BusinessEntityLink>
                </Fact>
              )}
              {isInvoice && relatedMatch && (
                <Fact label={copy("Three-way match")}>
                  <BusinessEntityLink entityType="three_way_match" entityId={relatedMatch.id}>{relatedMatch.id || "—"}</BusinessEntityLink>
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
              <Fact label={copy("PO amount")}>{money(record.poAmount ?? relatedMatch?.poAmount, record.currency, locale)}</Fact>
              <Fact label={copy("Invoice amount")}>{money(record.amount ?? record.invoiceAmount, record.currency, locale)}</Fact>
              <Fact label={copy("Variance amount")}>{money(record.varianceAmount, record.currency, locale)}</Fact>
              <Fact label={copy("Currency")}>{record.currency || "—"}</Fact>
              {isInvoice && <Fact label={copy("Invoice date")}>{day(record.invoiceDate, locale, timezone)}</Fact>}
              {isInvoice && <Fact label={copy("Due date")}>{day(record.dueDate, locale, timezone)}</Fact>}
            </dl>

            {blockingReason && (
              <div className="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-900">
                {copy(blockingReason)}
              </div>
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
