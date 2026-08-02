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

export function ThreeWayMatchListPage() {
  const [rows, setRows] = useState<ProcurementDocument[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

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

  return (
    <div className="space-y-4" data-testid="procurement-three-way-match-list">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold">匹配记录</div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            基于 PostgreSQL 中的 PO、GRN 与供应商发票生成只读匹配事实和差异解释。
          </div>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs">
          <RefreshCw size={14} />
          刷新
        </button>
      </Card>

      <Card className="overflow-hidden" data-testid="three-way-match-record-list">
        {state === "loading" ? (
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>正在读取三单匹配…</div>
        ) : state === "error" ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">三单匹配加载失败</div>
            <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">当前工作区暂无可匹配记录</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>需要真实采购订单、收货单和供应商发票后才能形成匹配。</div>
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((row) => (
              <article key={row.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <BusinessEntityLink entityType="three_way_match" entityId={row.id}>{row.id}</BusinessEntityLink>
                    <div className="mt-1 text-xs" style={{ color: A.sub }}>{row.supplierName || "未关联供应商"}</div>
                  </div>
                  <span className="rounded bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">{row.matchStatus || row.status || "—"}</span>
                </div>
                <dl className="mt-4 grid gap-x-6 gap-y-4 text-xs sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                  <div><dt style={{ color: A.sub }}>采购订单</dt><dd className="mt-1"><BusinessEntityLink entityType="purchase_order" entityId={row.poId || row.po}>{row.poId || row.po || "—"}</BusinessEntityLink></dd></div>
                  <div><dt style={{ color: A.sub }}>收货单</dt><dd className="mt-1"><BusinessEntityLink entityType="receiving_doc" entityId={row.grnId}>{row.grnId || "—"}</BusinessEntityLink></dd></div>
                  <div><dt style={{ color: A.sub }}>供应商发票</dt><dd className="mt-1"><BusinessEntityLink entityType="supplier_invoice" entityId={row.invoiceId}>{row.invoiceId || "—"}</BusinessEntityLink></dd></div>
                  <div><dt style={{ color: A.sub }}>PO 金额</dt><dd className="mt-1 font-medium tabular-nums">{money(row.poAmount, row.currency)}</dd></div>
                  <div><dt style={{ color: A.sub }}>发票金额</dt><dd className="mt-1 font-medium tabular-nums">{money(row.invoiceAmount, row.currency)}</dd></div>
                  <div><dt style={{ color: A.sub }}>差异金额</dt><dd className="mt-1 font-medium tabular-nums">{money(row.varianceAmount, row.currency)}</dd></div>
                </dl>
                {(row.blockingReason || row.exceptionReason) && (
                  <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {row.blockingReason || row.exceptionReason}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
