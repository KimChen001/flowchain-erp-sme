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

      <Card className="overflow-hidden">
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
          <>
            <div className="grid gap-3 p-3 md:hidden">
              {rows.map((row) => (
                <article key={row.id} className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <BusinessEntityLink entityType="receiving_doc" entityId={row.id}>
                      {row.id}
                    </BusinessEntityLink>
                    <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold">
                      {row.status || "—"}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div><span style={{ color: A.sub }}>采购订单</span><div className="mt-1"><BusinessEntityLink entityType="purchase_order" entityId={row.poId || row.po}>{row.poId || row.po || "—"}</BusinessEntityLink></div></div>
                    <div><span style={{ color: A.sub }}>供应商</span><div className="mt-1">{row.supplierName || "—"}</div></div>
                    <div><span style={{ color: A.sub }}>合格 / 拒收</span><div className="mt-1">{quantity(row.acceptedQty)} / {quantity(row.rejectedQty)}</div></div>
                    <div><span style={{ color: A.sub }}>到货日期</span><div className="mt-1">{row.arrived || row.createdAt || "—"}</div></div>
                  </div>
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="bg-slate-50" style={{ color: A.sub }}>
                  <tr>
                    <th className="p-3 font-medium">GRN</th>
                    <th className="p-3 font-medium">采购订单</th>
                    <th className="p-3 font-medium">供应商</th>
                    <th className="p-3 font-medium">状态</th>
                    <th className="p-3 font-medium">收货 / 合格 / 拒收</th>
                    <th className="p-3 font-medium">仓库</th>
                    <th className="p-3 font-medium">到货日期</th>
                    <th className="p-3 font-medium">收货人</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="p-3"><BusinessEntityLink entityType="receiving_doc" entityId={row.id}>{row.id}</BusinessEntityLink></td>
                      <td className="p-3"><BusinessEntityLink entityType="purchase_order" entityId={row.poId || row.po}>{row.poId || row.po || "—"}</BusinessEntityLink></td>
                      <td className="p-3">{row.supplierName || "—"}</td>
                      <td className="p-3"><span className="rounded bg-slate-100 px-2 py-1 font-semibold">{row.status || "—"}</span></td>
                      <td className="p-3 tabular-nums">{quantity(row.receivedQuantity)} / {quantity(row.acceptedQty)} / {quantity(row.rejectedQty)}</td>
                      <td className="p-3">{row.warehouse || "—"}</td>
                      <td className="p-3">{row.arrived || row.createdAt || "—"}</td>
                      <td className="p-3">{row.receiver || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
