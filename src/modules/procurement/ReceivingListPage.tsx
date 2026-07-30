import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Card } from "../../components/ui";
import { procurementApi } from "./procurementApi";
import type { ProcurementDocument } from "./procurementTypes";

function quantity(value?: number) {
  return Number.isFinite(value) ? Number(value).toLocaleString() : "—";
}

export function ReceivingListPage() {
  const [rows, setRows] = useState<ProcurementDocument[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setRows(await procurementApi.listDocuments("receiving"));
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
    <div className="space-y-4" data-testid="procurement-receiving-list">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold">收货记录</div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            当前工作区的正式 GRN；点击编号查看收货、过账与库存影响。
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs"
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </Card>

      <Card className="overflow-hidden" data-testid="receiving-record-list">
        {state === "loading" ? (
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>
            正在读取收货记录…
          </div>
        ) : state === "error" ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">收货记录加载失败</div>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 text-sm font-semibold text-blue-600"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">当前工作区暂无收货记录</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>
              创建并提交正式收货后，GRN 会显示在这里。
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((row) => {
              const poId = row.poId || row.po;
              return (
                <article key={row.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <BusinessEntityLink entityType="receiving_doc" entityId={row.id}>
                        {row.id}
                      </BusinessEntityLink>
                      <div className="mt-1 text-xs" style={{ color: A.sub }}>
                        采购订单{" "}
                        <BusinessEntityLink entityType="purchase_order" entityId={poId}>
                          {poId || "—"}
                        </BusinessEntityLink>
                      </div>
                    </div>
                    <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold">
                      {row.status || "—"}
                    </span>
                  </div>
                  <dl className="mt-4 grid gap-x-6 gap-y-4 text-xs sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                    <div>
                      <dt style={{ color: A.sub }}>供应商</dt>
                      <dd className="mt-1 font-medium">{row.supplierName || "—"}</dd>
                    </div>
                    <div>
                      <dt style={{ color: A.sub }}>收货 / 合格 / 拒收</dt>
                      <dd className="mt-1 font-medium tabular-nums">
                        {quantity(row.receivedQuantity)} / {quantity(row.acceptedQty)} / {quantity(row.rejectedQty)}
                      </dd>
                    </div>
                    <div>
                      <dt style={{ color: A.sub }}>仓库</dt>
                      <dd className="mt-1 font-medium">{row.warehouse || "—"}</dd>
                    </div>
                    <div>
                      <dt style={{ color: A.sub }}>到货日期</dt>
                      <dd className="mt-1 font-medium">{row.arrived || row.createdAt || "—"}</dd>
                    </div>
                    <div>
                      <dt style={{ color: A.sub }}>收货人</dt>
                      <dd className="mt-1 font-medium">{row.receiver || "—"}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
