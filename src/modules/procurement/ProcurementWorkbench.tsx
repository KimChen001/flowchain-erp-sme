import { isNoInvoiceVariance } from "../../domain/procurement/variance-types";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { RefreshCw } from "lucide-react";
import { A, Card } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { procurementApi } from "./procurementApi";
import type { ProcurementNavigate, ProcurementWorkItem } from "./procurementTypes";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { statusCodeLabel } from "../../i18n/statusLabels";

const FINISHED_PURCHASE_ORDER_STATUSES = ["fully_received", "completed", "closed", "cancelled", "已完成", "已关闭", "已取消"];
// A work item's signal codes and the labels shown for them.
const SIGNAL_LABELS: Record<string, string> = {
  "invoice_variance": "发票差异",
  "match_exception": "三单匹配异常",
};

export function ProcurementWorkbench({ onNavigate }: { onNavigate?: ProcurementNavigate }) {
  const { language } = useI18n();
  const copy = (label: string) => workspaceCopy(label, language);
  // "partially_received · issued_outside_flowchain" reads as "Partially received · Sent outside FlowChain".
  const statusText = (value: string) => String(value || "").split(" · ").map(code => statusCodeLabel(code, language) || copy(code)).join(" · ");
  const [rows, setRows] = useState<ProcurementWorkItem[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  // ?queue=approval opens the "Awaiting my approval" queue (the Approvals tab on phones).
  const [searchParams] = useSearchParams();
  const queue = searchParams.get("queue");
  const [filter, setFilter] = useState<"all" | "approval" | "tracking">(queue === "approval" || queue === "tracking" ? queue : "all");
  useEffect(() => { if (queue === "approval" || queue === "tracking") setFilter(queue); }, [queue]);
  const load = async () => {
    setState("loading");
    try {
      const [requests, orders, invoices] = await Promise.all([
        procurementApi.listRequests(),
        procurementApi.listOrders(),
        procurementApi.listDocuments("invoice"),
      ]);
      setRows([
        ...requests.filter(row => ["submitted", "approved"].includes(row.status)).map(row => ({ id: row.id, status: row.status, amount: row.totalAmount, bucket: row.status === "submitted" ? "approval" as const : "tracking" as const, kind: "purchase_request" as const })),
        ...orders
          // A fully received, closed or cancelled order needs no more purchasing work.
          .filter(row => !FINISHED_PURCHASE_ORDER_STATUSES.includes(row.status))
          .map(row => {
            const relatedInvoices = invoices.filter(invoice => invoice.relatedPo === row.id);
            const hasInvoiceVariance = relatedInvoices.some(invoice => Number(invoice.varianceAmount || 0) !== 0 || (Boolean(invoice.varianceType) && !isNoInvoiceVariance(invoice.varianceType)) || /差异|variance/i.test(String(invoice.status || "")));
            const hasMatchException = relatedInvoices.some(invoice => /差异|异常|待处理|variance/i.test(String(invoice.matchStatus || "")));
            return {
              id: row.id,
              status: `${row.status}${row.transmissionStatus ? ` · ${row.transmissionStatus}` : ""}`,
              amount: row.totalAmount,
              bucket: row.status === "pending_approval" ? "approval" as const : "tracking" as const,
              kind: "purchase_order" as const,
              signals: [
                ...(hasInvoiceVariance ? ["invoice_variance"] : []),
                ...(hasMatchException ? ["match_exception"] : []),
              ],
            };
          }),
      ]);
      setState("loaded");
    } catch { setState("error"); }
  };
  useEffect(() => { void load(); }, []);
  const shown = rows.filter(row => filter === "all" || row.bucket === filter);
  if (state === "error") return <Card className="p-12 text-center"><div>{copy("采购工作台加载失败")}</div><button onClick={() => void load()} className="mt-3 text-blue-600">{copy("重试")}</button></Card>;
  return <div className="space-y-4"><Card className="p-5"><div className="flex items-center justify-between"><div><h1 className="text-lg font-semibold">{language === "en-US" ? `Today’s purchasing work: ${rows.length}` : `今日采购待办：${rows.length}`}</h1><p className="text-xs" style={{ color: A.sub }}>{language === "en-US" ? "Purchase requests to approve and purchase orders still open." : "待审批的采购申请和仍在执行的采购订单。"}</p></div><div className="flex gap-2"><button onClick={() => void load()} className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs"><RefreshCw size={14}/>{copy("刷新")}</button><button onClick={() => onNavigate?.("procurement:requests")} className="rounded bg-blue-600 px-3 py-2 text-xs text-white">{copy("新建采购申请")}</button></div></div></Card><div className="grid grid-cols-2 gap-3 md:grid-cols-3">{[{ id: "all" as const, label: copy("全部待办"), value: rows.length }, { id: "approval" as const, label: copy("待我审批"), value: rows.filter(row => row.bucket === "approval").length }, { id: "tracking" as const, label: copy("跟进中"), value: rows.filter(row => row.bucket === "tracking").length }].map(item => <button key={item.id} onClick={() => setFilter(item.id)} className="rounded border bg-white p-4 text-left"><div className="text-xs">{item.label}</div><div className="text-2xl font-semibold">{item.value}</div></button>)}</div><Card className="overflow-hidden"><div className="border-b p-4 text-sm font-semibold">{copy("待办队列")}</div>{state === "loading" ? <div className="py-12 text-center text-xs">{copy("加载中")}</div> : shown.length === 0 ? <div className="py-12 text-center text-sm" style={{ color: A.sub }}>{copy("暂无采购事项")}</div> : <table className="w-full text-xs"><tbody>{shown.map(row => <tr key={row.id} className="border-t"><td className="p-3">{copy(row.kind === "purchase_request" ? "采购申请" : "采购订单")}</td><td className="p-3 text-blue-600"><EntityLink kind={row.kind} id={row.id}>{row.id}</EntityLink></td><td className="p-3"><div>{statusText(row.status)}</div>{row.signals?.length ? <div className="mt-1 flex flex-wrap gap-1">{row.signals.map(signal => <span key={signal} className="rounded bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">{copy(SIGNAL_LABELS[signal] || signal)}</span>)}</div> : null}</td><td className="p-3">{row.amount}</td></tr>)}</tbody></table>}</Card></div>;
}
