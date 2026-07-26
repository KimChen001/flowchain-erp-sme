import { FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { A, Card, Chip, KpiCard } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { exportRowsToWorkbook } from "../../lib/excel/excelWorkbookService";
import { fmt } from "../../lib/format";

export default function SettlementPreparation() {
  const rows: Array<{
    settlementNo: string; supplier: string; supplierCode: string; settlementDate: string;
    currency: string; invoiceAmount: number; creditAmount: number; adjustmentAmount: number;
    actualSettlementAmount: number; reconciliationStatement: string; invoices: string[]; status: string;
  }> = [];

  async function exportExcel() {
    if (!rows.length) return toast.warning("暂无可导出的数据");
    const filename = await exportRowsToWorkbook("settlement-documents", rows.map((row) => ({
      结算单号: row.settlementNo, 供应商: row.supplier, 结算日期: row.settlementDate, 币种: row.currency,
      发票金额: row.invoiceAmount, 贷项金额: row.creditAmount, 调整金额: row.adjustmentAmount,
      实际结算金额: row.actualSettlementAmount, 对账单: row.reconciliationStatement, 发票列表: row.invoices.join("、"), 状态: row.status,
    })));
    toast.success("Excel 已下载", { description: filename });
  }

  return <div className="space-y-4">
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="结算单" value={String(rows.length)} sub="标准业务链" icon={FileSpreadsheet} color={A.blue} />
      <KpiCard label="发票金额" value={fmt(rows.reduce((sum, row) => sum + row.invoiceAmount, 0))} sub="结算范围" icon={FileSpreadsheet} color={A.purple} />
      <KpiCard label="已结算金额" value={fmt(rows.reduce((sum, row) => sum + row.actualSettlementAmount, 0))} sub="实际核销" icon={FileSpreadsheet} color={A.green} />
      <KpiCard label="调整金额" value={fmt(rows.reduce((sum, row) => sum + row.adjustmentAmount, 0))} sub="差异复核" icon={FileSpreadsheet} color={A.orange} />
    </div>
    <Card>
      <div className="px-5 py-4 flex items-start justify-between gap-4" style={{ borderBottom: `1px solid ${A.border}` }}>
        <div><h2 className="text-sm font-semibold" style={{ color: A.label }}>结算单</h2><p className="text-[11px] mt-1" style={{ color: A.sub }}>从已确认对账单形成的结算业务单据，可继续下钻发票、对账单和供应商。</p></div>
        <button onClick={exportExcel} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg" style={{ background: A.gray6, color: A.blue }}><FileSpreadsheet size={13} /> 导出当前结果</button>
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-xs"><thead><tr style={{ borderBottom: `1px solid ${A.border}` }}>{["结算单号", "供应商", "结算日期", "币种", "发票金额", "贷项金额", "调整金额", "实际结算金额", "对账单", "发票", "状态"].map((header) => <th key={header} className="px-5 py-3 text-left font-medium whitespace-nowrap" style={{ color: A.gray1 }}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.settlementNo} style={{ borderBottom: index < rows.length - 1 ? `1px solid ${A.border}` : "none" }}>
        <td className="px-5 py-3"><BusinessEntityLink entityType="settlement_document" entityId={row.settlementNo}>{row.settlementNo}</BusinessEntityLink></td>
        <td className="px-5 py-3"><BusinessEntityLink entityType="supplier" entityId={row.supplierCode}>{row.supplier}</BusinessEntityLink></td>
        <td className="px-5 py-3 whitespace-nowrap">{row.settlementDate}</td><td className="px-5 py-3">{row.currency}</td>
        <td className="px-5 py-3 text-right">{fmt(row.invoiceAmount)}</td><td className="px-5 py-3 text-right">{fmt(row.creditAmount)}</td><td className="px-5 py-3 text-right">{fmt(row.adjustmentAmount)}</td><td className="px-5 py-3 text-right font-semibold">{fmt(row.actualSettlementAmount)}</td>
        <td className="px-5 py-3"><BusinessEntityLink entityType="reconciliation_statement" entityId={row.reconciliationStatement}>{row.reconciliationStatement}</BusinessEntityLink></td>
        <td className="px-5 py-3">{row.invoices.slice(0, 2).map((invoice) => <div key={invoice}><BusinessEntityLink entityType="supplier_invoice" entityId={invoice}>{invoice}</BusinessEntityLink></div>)}</td>
        <td className="px-5 py-3"><Chip label={row.status} color={A.green} bg="#f0faf4" /></td>
      </tr>)}</tbody></table></div>
    </Card>
  </div>;
}
