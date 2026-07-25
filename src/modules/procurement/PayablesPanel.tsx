import { AlertOctagon, Clock, CreditCard, FileSpreadsheet, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Card, Chip, KpiCard, A } from "../../components/ui";
import { PAYABLES, SUPPLIER_INVOICES } from "../../data/empty-business-state";
import { invoiceToPayable, isInvoicePayableReady } from "../../domain/procurement/invoice-matching";
import { exportRowsToCsv } from "../../lib/data-export";
import { fmt } from "../../lib/format";

export default function PayablesPanel() {
  const invoicePayables = SUPPLIER_INVOICES.filter(isInvoicePayableReady).map(invoiceToPayable);
  const payables = [
    ...invoicePayables,
    ...PAYABLES.filter((item) => !invoicePayables.some((invoiceItem) => invoiceItem.invoice === item.invoice)),
  ];
  const exportCsv = () => {
    if (payables.length === 0) {
      toast.warning("暂无可导出的数据");
      return;
    }
    exportRowsToCsv("procurement-payables-export.csv", payables.map((item) => ({
      应付编号: item.id,
      供应商: item.supplier,
      发票: item.invoice,
      金额: item.amount,
      条款: item.terms,
      到期日: item.due,
      账龄天数: item.aging,
      状态: item.status,
    })));
    toast.success("导出文件已生成", { description: "应付可见性 CSV" });
  };
  const reviewPayable = (id: string) => {
    toast("打开应付复核", { description: `${id} · 仅展示 AP、对账和到期影响，不执行付款或过账。` });
  };

  const totalDue = payables.filter(p => p.status !== "已付款").reduce((a, b) => a + b.amount, 0);
  const overdue  = payables.filter(p => p.status === "逾期").reduce((a, b) => a + b.amount, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <KpiCard label="应付敞口"   value={fmt(totalDue)}                            sub="来自已审批/已匹配发票"              icon={Wallet}      color={A.blue} />
        <KpiCard label="逾期金额"   value={fmt(overdue)}                             sub={`${payables.filter(p => p.status === "逾期").length} 笔逾期`} icon={AlertOctagon} color={A.red} />
        <KpiCard label="7 天到期"   value={fmt(1460000)}                             sub="3 笔"                              icon={Clock}       color={A.orange} />
        <KpiCard label="DPO"        value="48.2 天"                                 sub="周转天数参考" delta="+2.1d"        icon={CreditCard}  color={A.purple} />
      </div>

      <Card>
        <div className="px-5 py-4 flex items-start justify-between gap-4" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>应付可见性</h2>
            <p className="text-[11px] mt-1" style={{ color: A.sub }}>
              应付可见性来自已审批或已匹配的供应商发票；贷项通知用于冲减影响复核，供应商对账按供应商和期间汇总发票、退货、贷项、应付状态和差异。
            </p>
          </div>
          <button onClick={exportCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all hover:opacity-90"
            style={{ background: A.gray6, color: A.blue }}>
            <FileSpreadsheet size={13} /> 导出当前结果
          </button>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
              {["AP 编号", "供应商", "发票", "金额", "付款条款", "到期日", "账龄", "状态", "复核"].map(h => (
                <th key={h} className="text-left px-5 py-3 font-medium" style={{ color: A.gray1 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {payables.map((p, i) => (
              <tr key={p.id} style={{ borderBottom: i < payables.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                <td className="px-5 py-3 font-medium" style={{ color: A.blue }}>{p.id}</td>
                <td className="px-5 py-3" style={{ color: A.label }}>{p.supplier}</td>
                <td className="px-5 py-3" style={{ color: A.sub }}>{p.invoice}</td>
                <td className="px-5 py-3 font-medium" style={{ color: A.label }}>¥{p.amount.toLocaleString()}</td>
                <td className="px-5 py-3" style={{ color: A.sub }}>{p.terms}</td>
                <td className="px-5 py-3" style={{ color: p.aging > 0 ? A.red : A.label }}>{p.due}</td>
                <td className="px-5 py-3 font-medium" style={{ color: p.aging > 0 ? A.red : p.aging > -7 ? A.orange : A.green }}>
                  {p.aging > 0 ? `逾期 ${p.aging} 天` : `还剩 ${Math.abs(p.aging)} 天`}
                </td>
                <td className="px-5 py-3">
                  <Chip label={p.status} color={p.status === "已付款" ? A.green : p.status === "逾期" ? A.red : p.status === "部分付款" ? A.orange : A.blue}
                    bg={p.status === "已付款" ? "rgba(52,199,89,0.1)" : p.status === "逾期" ? "rgba(255,59,48,0.1)" : p.status === "部分付款" ? "rgba(255,149,0,0.1)" : "rgba(0,113,227,0.1)"} />
                </td>
                <td className="px-5 py-3">
                  <button onClick={() => reviewPayable(p.id)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: "#eef4ff", color: A.blue }}>
                    复核
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
