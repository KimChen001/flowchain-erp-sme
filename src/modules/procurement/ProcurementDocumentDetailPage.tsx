import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Card } from "../../components/ui";
import { procurementApi } from "./procurementApi";
import type { ProcurementDocument } from "./procurementTypes";

type DetailKind = "invoice" | "threeWayMatch";

function money(value?: number, currency = "CNY") {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
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
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  const load = useCallback(async () => {
    if (!documentId) return;
    setState("loading");
    try {
      const [rows, matches] = await Promise.all([
        procurementApi.listDocuments(kind),
        kind === "invoice"
          ? procurementApi.listDocuments("threeWayMatch")
          : Promise.resolve([]),
      ]);
      setRecord(
        rows.find((row) => (row.id || row.invoiceNumber) === documentId) || null,
      );
      setRelatedMatch(
        kind === "invoice"
          ? matches.find((row) => row.invoiceId === documentId) || null
          : null,
      );
      setState("loaded");
    } catch {
      setRecord(null);
      setRelatedMatch(null);
      setState("error");
    }
  }, [documentId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const isInvoice = kind === "invoice";
  const title = isInvoice ? "供应商发票详情" : "三单匹配详情";
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
            只读展示当前工作区 PostgreSQL 采购单据事实，不提供审批、匹配或过账操作。
          </div>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs">
          <RefreshCw size={14} />
          刷新
        </button>
      </Card>

      <Card className="p-4 sm:p-5">
        {state === "loading" ? (
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>正在读取{title}…</div>
        ) : state === "error" ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">{title}加载失败</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>未使用静态数据替代失败的业务读取。</div>
            <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">重试</button>
          </div>
        ) : !record ? (
          <div className="py-16 text-center" data-testid="procurement-document-not-found">
            <div className="text-sm font-semibold">当前工作区未找到 {documentId}</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>该编号不存在、已不可见，或不属于当前租户。</div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{record.id || documentId}</h2>
                <p className="mt-1 text-sm" style={{ color: A.sub }}>{record.supplierName || "未关联供应商"}</p>
              </div>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold">{status}</span>
            </div>

            <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="供应商">
                <BusinessEntityLink entityType="supplier" entityId={record.supplierId}>{record.supplierName || record.supplierId || "—"}</BusinessEntityLink>
              </Fact>
              <Fact label="采购订单">
                <BusinessEntityLink entityType="purchase_order" entityId={poId}>{poId || "—"}</BusinessEntityLink>
              </Fact>
              <Fact label="收货单">
                <BusinessEntityLink entityType="receiving_doc" entityId={grnId}>{grnId || "—"}</BusinessEntityLink>
              </Fact>
              {!isInvoice && (
                <Fact label="供应商发票">
                  <BusinessEntityLink entityType="supplier_invoice" entityId={invoiceId}>{invoiceId || "—"}</BusinessEntityLink>
                </Fact>
              )}
              {isInvoice && relatedMatch && (
                <Fact label="三单匹配">
                  <BusinessEntityLink entityType="three_way_match" entityId={relatedMatch.id}>{relatedMatch.id || "—"}</BusinessEntityLink>
                </Fact>
              )}
              {isInvoice ? (
                <>
                  <Fact label="发票状态">{record.invoiceStatus || "—"}</Fact>
                  <Fact label="匹配状态">{record.matchStatus || "—"}</Fact>
                </>
              ) : (
                <Fact label="匹配状态">{status}</Fact>
              )}
              <Fact label="PO 金额">{money(record.poAmount ?? relatedMatch?.poAmount, record.currency)}</Fact>
              <Fact label="发票金额">{money(record.amount ?? record.invoiceAmount, record.currency)}</Fact>
              <Fact label="差异金额">{money(record.varianceAmount, record.currency)}</Fact>
              <Fact label="币种">{record.currency || "—"}</Fact>
              {isInvoice && <Fact label="发票日期">{record.invoiceDate || "—"}</Fact>}
              {isInvoice && <Fact label="到期日">{record.dueDate || "—"}</Fact>}
            </dl>

            {blockingReason && (
              <div className="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-900">
                {blockingReason}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
