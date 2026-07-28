import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { A, Card } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { procurementApi } from "./procurementApi";
import type { ProcurementNavigate, ProcurementWorkItem } from "./procurementTypes";

export function ProcurementWorkbench({ onNavigate }: { onNavigate?: ProcurementNavigate }) {
  const [rows, setRows] = useState<ProcurementWorkItem[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [filter, setFilter] = useState<"all" | "approval" | "tracking">("all");
  const load = async () => {
    setState("loading");
    try {
      const [requests, orders] = await Promise.all([procurementApi.listRequests(), procurementApi.listOrders()]);
      setRows([
        ...requests.filter(row => ["submitted", "approved"].includes(row.status)).map(row => ({ id: row.id, type: "采购申请", status: row.status, amount: row.totalAmount, bucket: row.status === "submitted" ? "approval" as const : "tracking" as const, kind: "purchase_request" as const })),
        ...orders
          .filter(row => !["completed", "closed", "cancelled", "已完成", "已关闭", "已取消"].includes(row.status))
          .map(row => ({
            id: row.id,
            type: "采购订单",
            status: `${row.status}${row.transmissionStatus ? ` · ${row.transmissionStatus}` : ""}`,
            amount: row.totalAmount,
            bucket: row.status === "pending_approval" ? "approval" as const : "tracking" as const,
            kind: "purchase_order" as const,
          })),
      ]);
      setState("loaded");
    } catch { setState("error"); }
  };
  useEffect(() => { void load(); }, []);
  const shown = rows.filter(row => filter === "all" || row.bucket === filter);
  if (state === "error") return <Card className="p-12 text-center"><div>采购工作台加载失败</div><button onClick={() => void load()} className="mt-3 text-blue-600">重试</button></Card>;
  return <div className="space-y-4"><Card className="p-5"><div className="flex items-center justify-between"><div><h1 className="text-lg font-semibold">今日采购待办：{rows.length}</h1><p className="text-xs" style={{ color: A.sub }}>采购申请、审批、开放及履约中的 PO 均来自采购 runtime repository。</p></div><div className="flex gap-2"><button onClick={() => void load()} className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs"><RefreshCw size={14}/>刷新</button><button onClick={() => onNavigate?.("procurement:requests")} className="rounded bg-blue-600 px-3 py-2 text-xs text-white">新建采购申请</button></div></div></Card><div className="grid grid-cols-2 gap-3 md:grid-cols-3">{[{ id: "all" as const, label: "全部待办", value: rows.length }, { id: "approval" as const, label: "待我审批", value: rows.filter(row => row.bucket === "approval").length }, { id: "tracking" as const, label: "跟进中", value: rows.filter(row => row.bucket === "tracking").length }].map(item => <button key={item.id} onClick={() => setFilter(item.id)} className="rounded border bg-white p-4 text-left"><div className="text-xs">{item.label}</div><div className="text-2xl font-semibold">{item.value}</div></button>)}</div><Card className="overflow-hidden"><div className="border-b p-4 text-sm font-semibold">待办队列</div>{state === "loading" ? <div className="py-12 text-center text-xs">加载中</div> : shown.length === 0 ? <div className="py-12 text-center text-sm" style={{ color: A.sub }}>暂无采购事项</div> : <table className="w-full text-xs"><tbody>{shown.map(row => <tr key={row.id} className="border-t"><td className="p-3">{row.type}</td><td className="p-3 text-blue-600"><EntityLink kind={row.kind} id={row.id}>{row.id}</EntityLink></td><td className="p-3">{row.status}</td><td className="p-3">{row.amount}</td></tr>)}</tbody></table>}</Card></div>;
}
