import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Card } from "../../components/ui";
import { procurementApi } from "./procurementApi";
import type { ProcurementDocument } from "./procurementTypes";

export function RfqListPage() {
  const [rows, setRows] = useState<ProcurementDocument[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

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

  return (
    <div className="space-y-4" data-testid="procurement-rfq-list">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold">询价记录</div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            当前工作区的正式 RFQ；没有记录时不会自动补入报价。
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
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>正在读取询价记录…</div>
        ) : state === "error" ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">询价记录加载失败</div>
            <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">当前工作区暂无询价记录</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>页面只展示当前工作区的正式 RFQ。</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="bg-slate-50" style={{ color: A.sub }}>
                <tr>
                  <th className="p-3 font-medium">RFQ</th>
                  <th className="p-3 font-medium">主题 / 物料</th>
                  <th className="p-3 font-medium">数量</th>
                  <th className="p-3 font-medium">供应商响应</th>
                  <th className="p-3 font-medium">截止日期</th>
                  <th className="p-3 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-3"><BusinessEntityLink entityType="rfq" entityId={row.id}>{row.id}</BusinessEntityLink></td>
                    <td className="p-3"><div className="font-medium">{row.title || "—"}</div>{row.itemName && <div className="mt-1" style={{ color: A.sub }}>{row.itemName}</div>}</td>
                    <td className="p-3 tabular-nums">{Number.isFinite(row.quantity) ? Number(row.quantity).toLocaleString() : "—"} {row.unit || ""}</td>
                    <td className="p-3 tabular-nums">{row.respondedSupplierCount ?? 0} / {row.supplierCount ?? 0}</td>
                    <td className="p-3">{row.dueDate || "—"}</td>
                    <td className="p-3"><span className="rounded bg-slate-100 px-2 py-1 font-semibold">{row.status || "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
