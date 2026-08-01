import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Card } from "../../components/ui";
import { procurementApi } from "./procurementApi";
import type { ProcurementDocument } from "./procurementTypes";

function money(value?: number, currency = "CNY") {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function SupplierInvoiceListPage() {
  const [rows, setRows] = useState<ProcurementDocument[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setRows(await procurementApi.listDocuments("invoice"));
      setState("loaded");
    } catch {
      setRows([]);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4" data-testid="procurement-supplier-invoice-list">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold">发票记录</div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            PostgreSQL 中的正式供应商发票及其采购订单、收货和匹配状态。
          </div>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs">
          <RefreshCw size={14} />
          刷新
        </button>
      </Card>

      <Card className="overflow-hidden" data-testid="supplier-invoice-record-list">
        {state === "loading" ? (
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>正在读取供应商发票…</div>
        ) : state === "error" ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">供应商发票加载失败</div>
            <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">当前工作区暂无供应商发票</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>不会使用静态发票补足空数据。</div>
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((row) => (
              <article key={row.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <BusinessEntityLink entityType="supplier_invoice" entityId={row.id}>{row.id}</BusinessEntityLink>
                    <div className="mt-1 text-xs" style={{ color: A.sub }}>{row.supplierName || "未关联供应商"}</div>
                  </div>
                  <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold">{row.matchStatus || row.invoiceStatus || "—"}</span>
                </div>
                <dl className="mt-4 grid gap-x-6 gap-y-4 text-xs sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                  <div><dt style={{ color: A.sub }}>采购订单</dt><dd className="mt-1"><BusinessEntityLink entityType="purchase_order" entityId={row.relatedPo || row.poId}>{row.relatedPo || row.poId || "—"}</BusinessEntityLink></dd></div>
                  <div><dt style={{ color: A.sub }}>收货单</dt><dd className="mt-1"><BusinessEntityLink entityType="receiving_doc" entityId={row.relatedGrn || row.grnId}>{row.relatedGrn || row.grnId || "—"}</BusinessEntityLink></dd></div>
                  <div><dt style={{ color: A.sub }}>发票金额</dt><dd className="mt-1 font-medium tabular-nums">{money(row.amount, row.currency)}</dd></div>
                  <div><dt style={{ color: A.sub }}>差异金额</dt><dd className="mt-1 font-medium tabular-nums">{money(row.varianceAmount, row.currency)}</dd></div>
                  <div><dt style={{ color: A.sub }}>发票日期</dt><dd className="mt-1 font-medium">{row.invoiceDate || "—"}</dd></div>
                  <div><dt style={{ color: A.sub }}>到期日</dt><dd className="mt-1 font-medium">{row.dueDate || "—"}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
