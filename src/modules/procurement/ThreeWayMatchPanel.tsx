import { useState } from "react";
import { AlertCircle, AlertOctagon, CheckCircle2, FileSpreadsheet, MoreHorizontal, Package, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Modal, Card, Chip, KpiCard, A } from "../../components/ui";
import { SUPPLIER_INVOICES, purchaseOrders, receivingDocs } from "../../data/empty-business-state";
import { exportRowsToCsv } from "../../lib/data-export";
import { fmt } from "../../lib/format";
import { invoiceToMatchQueueItem, type InvoiceMatchQueueItem } from "../../domain/procurement/invoice-matching";
import { matchStatusStyle } from "./shared";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import {
  tableMinLgClass,
  tableScrollClass,
  tdWideActionClass,
  tdWideIdClass,
  tdWideNameClass,
  tdWideNowrapClass,
  tdWideNumericClass,
  thWideClass,
} from "../../components/ui/workbenchTable";

export default function ThreeWayMatchPanel() {
  const [queue, setQueue] = useState<InvoiceMatchQueueItem[]>(() =>
    SUPPLIER_INVOICES.map((invoice) => invoiceToMatchQueueItem(invoice, purchaseOrders, receivingDocs, SUPPLIER_INVOICES))
  );
  const [selected, setSelected] = useState<InvoiceMatchQueueItem | null>(null);
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const exportCsv = () => {
    if (queue.length === 0) {
      toast.warning("暂无可导出的数据");
      return;
    }
    exportRowsToCsv("invoice-three-way-match-export.csv", queue.map((item) => ({
      匹配号: item.id,
      采购订单: item.po,
      收货单: item.grn,
      发票: item.invoiceNumber,
      供应商: item.supplier,
      PO金额: item.poAmt,
      GRN金额: item.grnAmt,
      发票金额: item.invAmt,
      差异类型: item.varianceType,
      差异金额: item.varianceAmount,
      匹配状态: item.matchStatus,
      发票状态: item.status,
    })));
    toast.success("导出文件已生成", { description: `${queue.length} 条匹配记录` });
  };
  const resolve = (id: string) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, matchStatus: "已解决", status: "已匹配", varianceAmount: 0, varianceType: "无差异" } : q));
    setOpenActionId(null);
    toast.success(`${id} 差异已解决`, { description: "已保存匹配复核状态；不审批、不付款、不过账。" });
  };
  const rejectInvoice = (id: string) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, status: "已驳回", matchStatus: "差异待处理" } : q));
    setOpenActionId(null);
    toast.success(`${id} 已退回发票`);
  };
  const markMatched = (id: string) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, status: "已匹配", matchStatus: "已解决", varianceAmount: 0, varianceType: "无差异" } : q));
    setOpenActionId(null);
    toast.success(`${id} 已标记匹配`);
  };

  const varianceTotal = queue.reduce((sum, row) => sum + Number(row.varianceAmount || 0), 0);
  const autoMatched = queue.length ? Math.round((queue.filter((row) => row.matchStatus === "自动匹配").length / queue.length) * 100) : 0;
  const missingGrn = queue.filter((row) => row.varianceType === "缺少收货").length;
  const duplicateRisk = queue.filter((row) => row.duplicateRisk || row.varianceType === "重复发票").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="匹配队列" value={String(queue.length)} sub="PO / GRN / 发票" icon={ShieldCheck} color={A.blue} />
        <KpiCard label="自动匹配率" value={`${autoMatched}%`} sub="容差内通过" icon={CheckCircle2} color={A.green} />
        <KpiCard label="差异总额" value={fmt(varianceTotal)} sub="待处理" icon={AlertOctagon} color={A.red} />
        <KpiCard label="缺少收货" value={String(missingGrn)} sub="GRN 未完成" icon={Package} color={A.orange} />
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>发票三单匹配复核</h2>
            <p className="text-[11px] leading-5 mt-1" style={{ color: A.sub }}>
              三单匹配只生成证据、差异状态和协同记录。保存财务协同备注与预览发票异常工单均需人工确认，且不审批、不付款、不过账。
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button type="button" className="px-3 py-1.5 rounded-md text-[11px] font-medium" style={{ background: A.gray6, color: A.blue }}>保存财务协同备注</button>
            <button type="button" className="px-3 py-1.5 rounded-md text-[11px] font-medium" style={{ background: "#fff8f0", color: A.orange }}>预览发票异常工单</button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>三单匹配</h2>
            <p className="text-[11px] mt-1" style={{ color: A.sub }}>
              比较采购订单、收货单与供应商发票的金额、数量与状态差异；差异可通过发票更正、采购退货、供应商贷项通知或后续财务协同处理。
            </p>
          </div>
          <button onClick={exportCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all hover:opacity-90"
            style={{ background: A.gray6, color: A.blue }}>
            <FileSpreadsheet size={13} /> 导出当前结果
          </button>
        </div>
        <div className={tableScrollClass}>
          <table className={tableMinLgClass}>
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                {["匹配号", "PO", "GRN", "发票", "供应商", "PO 金额", "GRN 金额", "发票金额", "差异类型", "差异金额", "匹配状态", "操作"].map(h => (
                  <th key={h} className={thWideClass} style={{ color: A.gray1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {queue.map((q, i) => (
                <tr key={q.id} style={{ borderBottom: i < queue.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                  <td className={tdWideIdClass}><BusinessEntityLink entityType="three_way_match" entityId={q.id}>{q.id}</BusinessEntityLink></td>
                  <td className={tdWideNowrapClass}><BusinessEntityLink entityType="purchase_order" entityId={q.po}>{q.po}</BusinessEntityLink></td>
                  <td className={tdWideNowrapClass}><BusinessEntityLink entityType="receiving_doc" entityId={q.grn} exists={Boolean(q.grn && q.grn !== "—")}>{q.grn || "—"}</BusinessEntityLink></td>
                  <td className={tdWideNowrapClass}><BusinessEntityLink entityType="supplier_invoice" entityId={q.invoiceNumber}>{q.invoiceNumber}</BusinessEntityLink></td>
                  <td className={`${tdWideNameClass} max-w-[180px] truncate`}><BusinessEntityLink entityType="supplier" entityId={q.supplier}>{q.supplier}</BusinessEntityLink></td>
                  <td className={tdWideNumericClass} style={{ color: A.label }}>{fmt(q.poAmt)}</td>
                  <td className={tdWideNumericClass} style={{ color: A.label }}>{fmt(q.grnAmt)}</td>
                  <td className={tdWideNumericClass} style={{ color: A.label }}>{fmt(q.invAmt)}</td>
                  <td className={`${tdWideNowrapClass} font-medium`} style={{ color: q.varianceType === "无差异" ? A.green : A.red }}>{q.varianceType}</td>
                  <td className={`${tdWideNumericClass} font-medium`} style={{ color: q.varianceAmount === 0 ? A.green : A.red }}>{q.varianceAmount === 0 ? "—" : fmt(q.varianceAmount)}</td>
                  <td className={tdWideNowrapClass}>
                    <Chip label={q.matchStatus} {...matchStatusStyle(q.matchStatus)} />
                  </td>
                  <td className={tdWideActionClass}>
                    <div className="relative flex gap-1">
                      <button onClick={() => setSelected(q)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: A.gray6, color: A.blue }}>详情</button>
                      <button onClick={() => setOpenActionId((current) => current === q.id ? null : q.id)} className="px-2 py-1 text-[11px] font-medium rounded-md flex items-center gap-1" style={{ background: A.gray6, color: A.gray1 }}>
                        更多 <MoreHorizontal size={12} />
                      </button>
                      {openActionId === q.id && (
                        <div className="absolute right-0 top-7 z-20 w-28 rounded-lg p-1 shadow-lg" style={{ background: A.white, boxShadow: "0 10px 30px rgba(15,23,42,0.12)" }}>
                          {q.matchStatus !== "自动匹配" && <button onClick={() => resolve(q.id)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.blue }}>解决差异</button>}
                          <button onClick={() => markMatched(q.id)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.green }}>标记匹配</button>
                          <button onClick={() => rejectInvoice(q.id)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.red }}>退回</button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} width={620}
        title={selected?.invoiceNumber || "发票匹配"}
        subtitle={selected ? `${selected.po} · ${selected.grn}` : undefined}>
        {selected && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {[
                ["PO 订购金额", fmt(selected.poAmt), A.blue],
                ["GRN 收货金额", fmt(selected.grnAmt), A.green],
                ["发票金额", fmt(selected.invAmt), A.orange],
              ].map(([label, value, color]) => (
                <div key={String(label)} className="rounded-xl p-3" style={{ background: A.gray6 }}>
                  <div className="fc-caption" style={{ color: A.gray2 }}>{label}</div>
                  <div className="text-sm font-semibold mt-1" style={{ color: String(color) }}>{value}</div>
                </div>
              ))}
            </div>
            <div className="rounded-xl p-3" style={{ background: selected.varianceType === "无差异" ? "#f0faf4" : "#fff8f0" }}>
              <div className="text-xs font-semibold" style={{ color: selected.varianceType === "无差异" ? A.green : A.orange }}>
                {selected.varianceType} · {selected.matchStatus}
              </div>
              <div className="text-[11px] leading-5 mt-1" style={{ color: A.sub }}>
                当前差异金额 {fmt(selected.varianceAmount)}，请在发票协同或财务协同中查看行项目证据；本结果用于匹配预检和异常处理。
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
