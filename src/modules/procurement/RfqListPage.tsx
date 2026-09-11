import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { A, Card } from "../../components/ui";
import { procurementApi } from "./procurementApi";
import { useI18n } from "../../i18n/I18n";
import type { ProcurementDocument } from "./procurementTypes";

const RFQ_STATUS_LABELS: Record<string, readonly [string, string]> = {
  draft: ["草稿", "Draft"],
  open: ["开放", "Open"],
  collecting_quotes: ["收集报价", "Collecting quotes"],
  closed: ["已关闭", "Closed"],
  cancelled: ["已取消", "Cancelled"],
};

export function RfqListPage() {
  const { language } = useI18n();
  const tr = (zh: string, en: string) => language === "en-US" ? en : zh;
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
          <div className="text-sm font-semibold">{tr("询价记录", "Request for quotation records")}</div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            {tr("当前工作区的正式 RFQ；没有记录时不会自动补入报价。", "Formal RFQs in this workspace. Quotations are never generated for missing records.")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs"
        >
          <RefreshCw size={14} />
          {tr("刷新", "Refresh")}
        </button>
      </Card>

      <Card className="overflow-hidden">
        {state === "loading" ? (
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>{tr("正在读取询价记录…", "Loading RFQ records…")}</div>
        ) : state === "error" ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">{tr("询价记录加载失败", "RFQ records could not be loaded")}</div>
            <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">{tr("重试", "Retry")}</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">{tr("当前工作区暂无询价记录", "No RFQ records in this workspace")}</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>{tr("页面只展示当前工作区的正式 RFQ。", "This page shows formal RFQs for the current workspace.")}</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="bg-slate-50" style={{ color: A.sub }}>
                <tr>
                  <th className="p-3 font-medium">RFQ</th>
                  <th className="p-3 font-medium">{tr("主题 / 物料", "Subject / item")}</th>
                  <th className="p-3 font-medium">{tr("数量", "Quantity")}</th>
                  <th className="p-3 font-medium">{tr("供应商响应", "Supplier responses")}</th>
                  <th className="p-3 font-medium">{tr("截止日期", "Due date")}</th>
                  <th className="p-3 font-medium">{tr("状态", "Status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-3">
                      <Link
                        className="font-semibold tabular-nums text-blue-600 hover:underline"
                        to={`/app/procurement/rfq/${encodeURIComponent(row.id || "")}`}
                        data-testid={`rfq-id-link-${row.id}`}
                      >
                        {row.id}
                      </Link>
                    </td>
                    <td className="p-3"><div className="font-medium">{row.title || "—"}</div>{row.itemName && <div className="mt-1" style={{ color: A.sub }}>{row.itemName}</div>}</td>
                    <td className="p-3 tabular-nums">{Number.isFinite(row.quantity) ? Number(row.quantity).toLocaleString() : "—"} {row.unit || ""}</td>
                    <td className="p-3 tabular-nums">{row.respondedSupplierCount ?? 0} / {row.supplierCount ?? 0}</td>
                    <td className="p-3">{row.dueDate || "—"}</td>
                    <td className="p-3"><span className="rounded bg-slate-100 px-2 py-1 font-semibold">{row.status ? (RFQ_STATUS_LABELS[row.status] ? RFQ_STATUS_LABELS[row.status][language === "en-US" ? 1 : 0] : row.status) : "—"}</span></td>
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
