import { CreditCard, FileSpreadsheet, FileText, HandCoins, ReceiptText } from "lucide-react";
import { A, Card } from "../../components/ui";
import { SUPPLIER_CREDIT_MEMOS, SUPPLIER_INVOICES, SUPPLIER_RECONCILIATION_STATEMENTS } from "../../data/empty-business-state";
import { financePayables, settlementRows } from "./finance-summary";
import type { FinanceTab } from "./Page";

export default function FinanceOverview({ onOpenTab }: { onOpenTab: (tab: FinanceTab) => void }) {
  const reconciliationExceptions = SUPPLIER_RECONCILIATION_STATEMENTS.filter((item) =>
    item.exceptionCount > 0 || item.totalVarianceAmount > 0 || ["存在差异", "已驳回"].includes(item.status)
  );
  const entries = [
    { tab: "invoices" as const, title: "供应商发票", desc: "发票登记、税额拆分、PO/GRN 匹配和异常复核。", signal: `${SUPPLIER_INVOICES.length} 张发票`, icon: FileText },
    { tab: "payables" as const, title: "应付可见性", desc: "查看 AP 状态和未关闭应付，不执行付款。", signal: `${financePayables.filter((item) => item.status !== "已付款").length} 笔未关闭`, icon: CreditCard },
    { tab: "credits" as const, title: "贷项冲减", desc: "供应商贷项通知、退货关联和 AP 冲减可见性。", signal: `${SUPPLIER_CREDIT_MEMOS.length} 张贷项`, icon: ReceiptText },
    { tab: "reconciliation" as const, title: "供应商对账", desc: "供应商期间对账、差异和未结余额。", signal: `${reconciliationExceptions.length} 个异常`, icon: FileSpreadsheet },
    { tab: "settlement" as const, title: "结算资料准备", desc: "付款前资料可见性清单，不包含支付执行、GL 或税务申报。", signal: `${settlementRows().filter((row) => row.readiness === "可结算").length} 个可结算`, icon: HandCoins },
  ];

  return (
    <div className="grid grid-cols-5 gap-3">
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <Card key={entry.tab} className="p-4">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center mb-3" style={{ background: A.gray6, color: A.blue }}>
              <Icon size={15} />
            </div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>{entry.title}</div>
            <div className="text-[11px] leading-5 mt-1" style={{ color: A.sub }}>{entry.desc}</div>
            <div className="text-[11px] font-medium mt-2" style={{ color: A.blue }}>{entry.signal}</div>
            <button onClick={() => onOpenTab(entry.tab)} className="mt-3 w-full text-[11px] px-2.5 py-1.5 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>
              进入
            </button>
          </Card>
        );
      })}
    </div>
  );
}
