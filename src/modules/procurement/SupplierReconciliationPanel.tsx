import { useMemo, useState } from "react";
import { AlertOctagon, AlertTriangle, Clock, CreditCard, FileSpreadsheet, Search, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Modal, Card, Chip, KpiCard, A } from "../../components/ui";
import { DocumentActionBar, DocumentEvidencePanel, DocumentHeader, DocumentLinesTable, DocumentShell, DocumentStatusTimeline, DocumentTotals, type TimelineStep } from "../../components/document/DocumentShell";
import { SUPPLIER_INVOICES, SUPPLIER_RECONCILIATION_STATEMENTS, purchaseOrders, receivingDocs } from "../../data/empty-business-state";
import { getStatementLinkedDocuments } from "../../domain/procurement/document-links";
import { getReconciliationStatusTone, getReconciliationSummary, isStatementException, reconciliationExportRows, reconciliationLineExportRows } from "../../domain/procurement/reconciliation";
import { exportRowsToCsv } from "../../lib/data-export";
import { fmt } from "../../lib/format";
import type { SupplierReconciliationStatement } from "../../types/scm";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import ContextualImportActions from "../../components/import/ContextualImportActions";

function statementPeriod(statement: SupplierReconciliationStatement) {
  return `${statement.periodStart} ~ ${statement.periodEnd}`;
}

function reconciliationChipStyle(status: string) {
  const tone = getReconciliationStatusTone(status);
  if (tone === "success") return { color: A.green, bg: "#f0faf4" };
  if (tone === "warning") return { color: A.orange, bg: "#fff8f0" };
  if (tone === "danger") return { color: A.red, bg: "#fff1f0" };
  return { color: A.gray1, bg: A.gray6 };
}

function reconciliationTimeline(statement: SupplierReconciliationStatement): TimelineStep[] {
  const rejected = statement.status === "已驳回";
  const closed = statement.status === "已关闭";
  const confirmed = statement.status === "已确认" || closed;
  const hasException = statement.status === "存在差异" || statement.exceptionCount > 0 || statement.totalVarianceAmount > 0;
  const settled = statement.settlementStatus === "已结算";
  const partiallySettled = statement.settlementStatus === "部分结算";

  return [
    { label: "草稿", status: statement.status === "草稿" ? "current" : "done", helper: statement.createdDate },
    {
      label: "待确认",
      status: rejected ? "blocked" : ["待确认", "存在差异", "已确认", "已关闭"].includes(statement.status) ? "done" : "pending",
      helper: statement.owner,
    },
    {
      label: rejected ? "已驳回" : hasException ? "存在差异" : "已确认",
      status: rejected ? "blocked" : hasException && !confirmed ? "warning" : confirmed ? "done" : statement.status === "待确认" ? "current" : "pending",
      helper: rejected ? statement.rejectReason : hasException ? `${statement.exceptionCount} 项异常` : statement.confirmedDate || "等待供应商确认",
    },
    {
      label: statement.settlementStatus,
      status: settled ? "done" : partiallySettled ? "warning" : statement.openBalance > 0 ? "current" : "pending",
      helper: statement.openBalance > 0 ? `未结 ${fmt(statement.openBalance)}` : "已结清",
    },
    { label: "已关闭", status: closed ? "done" : rejected ? "blocked" : "pending", helper: closed ? "对账关闭" : "可关闭" },
  ];
}

export default function SupplierReconciliationPanel() {
  const [statements, setStatements] = useState<SupplierReconciliationStatement[]>(SUPPLIER_RECONCILIATION_STATEMENTS);
  const [statusFilter, setStatusFilter] = useState("全部");
  const [settlementFilter, setSettlementFilter] = useState("全部");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("");
  const [selectedStatement, setSelectedStatement] = useState<SupplierReconciliationStatement | null>(null);

  const visibleStatements = useMemo(() => {
    const q = search.trim().toLowerCase();
    const p = period.trim().toLowerCase();
    return statements
      .filter((statement) => statusFilter === "全部" || statement.status === statusFilter)
      .filter((statement) => settlementFilter === "全部" || statement.settlementStatus === settlementFilter)
      .filter((statement) => !q || [statement.statementNo, statement.supplier, statement.supplierCode || ""].some((value) => value.toLowerCase().includes(q)))
      .filter((statement) => !p || statementPeriod(statement).toLowerCase().includes(p));
  }, [period, search, settlementFilter, statements, statusFilter]);

  const pending = statements.filter((statement) => statement.status === "待确认").length;
  const exceptions = statements.filter(isStatementException).length;
  const openBalance = statements.reduce((sum, statement) => sum + statement.openBalance, 0);
  const overdue = statements.reduce((sum, statement) => sum + statement.overdueAmount, 0);
  const paid = statements.reduce((sum, statement) => sum + statement.totalPaidAmount, 0);

  function updateStatement(id: string, patch: Partial<SupplierReconciliationStatement>) {
    setStatements((current) => current.map((statement) => statement.id === id ? { ...statement, ...patch } : statement));
    setSelectedStatement((current) => current?.id === id ? { ...current, ...patch } : current);
  }

  function confirm(statement: SupplierReconciliationStatement) {
    updateStatement(statement.id, { status: "已确认", confirmedDate: statement.confirmedDate || "2026-06-02", rejectReason: undefined });
    toast.success(`${statement.statementNo} 已标记确认`);
  }

  function reject(statement: SupplierReconciliationStatement) {
    updateStatement(statement.id, { status: "已驳回", rejectReason: statement.rejectReason || "供应商反馈金额或单据差异，需重新核对。" });
    toast.success(`${statement.statementNo} 已标记驳回`);
  }

  function close(statement: SupplierReconciliationStatement) {
    updateStatement(statement.id, { status: "已关闭" });
    toast.success(`${statement.statementNo} 已关闭`);
  }

  function exportList() {
    if (visibleStatements.length === 0) {
      toast.warning("暂无可导出的对账单");
      return;
    }
    exportRowsToCsv("supplier-reconciliation-export.csv", reconciliationExportRows(visibleStatements));
    toast.success("导出文件已生成", { description: "供应商对账单 CSV" });
  }

  function exportDetail(statement: SupplierReconciliationStatement) {
    if (statement.lines.length === 0) {
      toast.warning("暂无可导出的对账明细");
      return;
    }
    exportRowsToCsv(`supplier-reconciliation-detail-${statement.statementNo}.csv`, reconciliationLineExportRows(statement));
    toast.success("导出文件已生成", { description: "对账明细 CSV" });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="对账单数" value={String(statements.length)} sub="对账期间" icon={FileSpreadsheet} color={A.blue} />
        <KpiCard label="待确认" value={String(pending)} sub="供应商确认" icon={Clock} color={A.orange} />
        <KpiCard label="差异对账" value={String(exceptions)} sub="含逾期/驳回" icon={AlertOctagon} color={A.red} />
        <KpiCard label="未结算余额" value={fmt(openBalance)} sub="应付 - 已付" icon={Wallet} color={A.purple} />
        <KpiCard label="逾期应付" value={fmt(overdue)} sub="需 AP 复核" icon={AlertTriangle} color={A.orange} />
        <KpiCard label="本期已付" value={fmt(paid)} sub="付款状态" icon={CreditCard} color={A.green} />
      </div>

      <Card>
        <div className="px-5 py-4 flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>供应商对账单</h2>
            <p className="text-[11px] mt-1" style={{ color: A.sub }}>
              按供应商和对账期间汇总 PO、GRN、供应商发票、退货、贷项、三单匹配、AP 与付款状态，用于差异复核和结算跟进。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ContextualImportActions entityLabel="对账单" templateName="对账单" compact />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}
              className="h-8 rounded-lg px-2 text-xs outline-none" style={{ background: A.gray6, color: A.label }}>
              {["全部", "待确认", "存在差异", "已确认", "已驳回", "已关闭"].map((item) => <option key={item}>{item}</option>)}
            </select>
            <select value={settlementFilter} onChange={(event) => setSettlementFilter(event.target.value)}
              className="h-8 rounded-lg px-2 text-xs outline-none" style={{ background: A.gray6, color: A.label }}>
              {["全部", "未结算", "部分结算", "已结算"].map((item) => <option key={item}>{item}</option>)}
            </select>
            <input value={period} onChange={(event) => setPeriod(event.target.value)} placeholder="期间"
              className="h-8 w-28 rounded-lg px-2 text-xs outline-none" style={{ background: A.gray6, color: A.label }} />
            <div className="h-8 px-2 rounded-lg flex items-center gap-1.5" style={{ background: A.gray6 }}>
              <Search size={13} style={{ color: A.gray1 }} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="供应商/单号"
                className="w-32 bg-transparent text-xs outline-none" style={{ color: A.label }} />
            </div>
            <button onClick={exportList}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all hover:opacity-90"
              style={{ background: A.gray6, color: A.blue }}>
              <FileSpreadsheet size={13} /> 导出当前结果
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                {["对账单号", "供应商", "对账期间", "发票数", "应付金额", "已付金额", "调整金额", "差异金额", "未结余额", "逾期金额", "状态", "结算状态", "操作"].map((header) => (
                  <th key={header} className="text-left px-5 py-3 font-medium whitespace-nowrap" style={{ color: A.gray1 }}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleStatements.map((statement, index) => (
                <tr key={statement.id} style={{ borderBottom: index < visibleStatements.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                  <td className="px-5 py-3 font-semibold whitespace-nowrap"><BusinessEntityLink entityType="reconciliation_statement" entityId={statement.statementNo}>{statement.statementNo}</BusinessEntityLink></td>
                  <td className="px-5 py-3 whitespace-nowrap"><BusinessEntityLink entityType="supplier" entityId={statement.supplierCode || statement.supplier}>{statement.supplier}</BusinessEntityLink></td>
                  <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{statementPeriod(statement)}</td>
                  <td className="px-5 py-3" style={{ color: A.label }}>{statement.invoiceCount}</td>
                  <td className="px-5 py-3 font-medium whitespace-nowrap" style={{ color: A.label }}>{fmt(statement.totalPayableAmount)}</td>
                  <td className="px-5 py-3 font-medium whitespace-nowrap" style={{ color: A.green }}>{fmt(statement.totalPaidAmount)}</td>
                  <td className="px-5 py-3 whitespace-nowrap" style={{ color: statement.totalAdjustmentAmount ? A.orange : A.sub }}>{fmt(statement.totalAdjustmentAmount)}</td>
                  <td className="px-5 py-3 font-medium whitespace-nowrap" style={{ color: statement.totalVarianceAmount ? A.red : A.green }}>{statement.totalVarianceAmount ? fmt(statement.totalVarianceAmount) : "—"}</td>
                  <td className="px-5 py-3 font-medium whitespace-nowrap" style={{ color: statement.openBalance ? A.purple : A.green }}>{fmt(statement.openBalance)}</td>
                  <td className="px-5 py-3 font-medium whitespace-nowrap" style={{ color: statement.overdueAmount ? A.red : A.green }}>{statement.overdueAmount ? fmt(statement.overdueAmount) : "—"}</td>
                  <td className="px-5 py-3 whitespace-nowrap"><Chip label={statement.status} {...reconciliationChipStyle(statement.status)} /></td>
                  <td className="px-5 py-3 whitespace-nowrap"><Chip label={statement.settlementStatus} {...reconciliationChipStyle(statement.settlementStatus)} /></td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1 min-w-[260px]">
                      <button onClick={() => setSelectedStatement(statement)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: A.gray6, color: A.blue }}>查看详情</button>
                      <button onClick={() => confirm(statement)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: "#f0faf4", color: A.green }}>标记已确认</button>
                      <button onClick={() => reject(statement)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: "#fff1f0", color: A.red }}>标记已驳回</button>
                      <button onClick={() => close(statement)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: "#faf3ff", color: A.purple }}>关闭对账</button>
                      <button onClick={() => exportDetail(statement)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: A.gray6, color: A.gray1 }}>导出明细</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={Boolean(selectedStatement)} onClose={() => setSelectedStatement(null)} width={1180}
        title={selectedStatement?.statementNo || "供应商对账单"}
        subtitle={selectedStatement ? `${selectedStatement.supplier} · ${statementPeriod(selectedStatement)}` : undefined}>
        {selectedStatement && (
          <DocumentShell
            title="供应商对账单"
            documentNo={selectedStatement.statementNo}
            moduleLabel="采购 / 对账"
            status={selectedStatement.status}
            statusTone={getReconciliationStatusTone(selectedStatement.status)}
            subtitle={`${selectedStatement.supplier} · ${statementPeriod(selectedStatement)}`}
          >
            <DocumentHeader
              fields={[
                { label: "对账单ID", value: selectedStatement.id },
                { label: "对账单号", value: selectedStatement.statementNo },
                { label: "供应商", value: selectedStatement.supplier, helper: selectedStatement.supplierCode || "—" },
                { label: "对账期间", value: statementPeriod(selectedStatement) },
                { label: "币种", value: selectedStatement.currency },
                { label: "负责人", value: selectedStatement.owner },
                { label: "创建日期", value: selectedStatement.createdDate },
                { label: "确认日期", value: selectedStatement.confirmedDate || "—" },
                { label: "状态", value: selectedStatement.status, tone: getReconciliationStatusTone(selectedStatement.status) },
                { label: "结算状态", value: selectedStatement.settlementStatus, tone: getReconciliationStatusTone(selectedStatement.settlementStatus) },
                { label: "来源", value: selectedStatement.source },
                { label: "拒绝原因", value: selectedStatement.rejectReason || "—", tone: selectedStatement.rejectReason ? "danger" : "neutral" },
              ]}
            />
            <DocumentStatusTimeline steps={reconciliationTimeline(selectedStatement)} />
            <DocumentLinesTable
              rows={selectedStatement.lines}
              columns={[
                { key: "bizType", label: "类型" },
                { key: "bizId", label: "业务单据", render: (line) => <span style={{ color: A.blue }}>{String(line.bizId)}</span> },
                { key: "documentDate", label: "日期" },
                { key: "dueDate", label: "到期日", render: (line) => line.dueDate || "—" },
                { key: "description", label: "描述" },
                { key: "payableAmount", label: "应付金额", align: "right", render: (line) => fmt(Number(line.payableAmount || 0)) },
                { key: "paidAmount", label: "已付金额", align: "right", render: (line) => fmt(Number(line.paidAmount || 0)) },
                { key: "varianceAmount", label: "差异金额", align: "right", render: (line) => Number(line.varianceAmount || 0) ? <span style={{ color: A.red }}>{fmt(Number(line.varianceAmount || 0))}</span> : "—" },
                { key: "status", label: "状态" },
                { key: "relatedPo", label: "关联 PO", render: (line) => line.relatedPo || "—" },
                { key: "relatedGrn", label: "关联 GRN", render: (line) => line.relatedGrn || "—" },
                { key: "relatedInvoice", label: "关联发票", render: (line) => line.relatedInvoice || "—" },
                { key: "notes", label: "备注", render: (line) => line.notes || line.matchStatus || "—" },
              ]}
            />
            <DocumentTotals
              columns={5}
              totals={[
                { label: "发票金额", value: fmt(selectedStatement.totalInvoiceAmount) },
                { label: "应付金额", value: fmt(selectedStatement.totalPayableAmount), tone: "info" },
                { label: "已付金额", value: fmt(selectedStatement.totalPaidAmount), tone: selectedStatement.totalPaidAmount ? "success" : "neutral" },
                { label: "调整金额", value: fmt(selectedStatement.totalAdjustmentAmount), tone: selectedStatement.totalAdjustmentAmount ? "warning" : "neutral" },
                { label: "差异金额", value: fmt(selectedStatement.totalVarianceAmount), tone: selectedStatement.totalVarianceAmount ? "danger" : "success" },
                { label: "未结余额", value: fmt(selectedStatement.openBalance), tone: selectedStatement.openBalance ? "purple" : "success" },
                { label: "逾期金额", value: fmt(selectedStatement.overdueAmount), tone: selectedStatement.overdueAmount ? "danger" : "success" },
              ]}
            />
            <DocumentEvidencePanel
              linkedDocuments={getStatementLinkedDocuments(selectedStatement, SUPPLIER_INVOICES, purchaseOrders, receivingDocs)}
              confidence={selectedStatement.confidence ? `${selectedStatement.confidence}%` : "—"}
              provenance={selectedStatement.source}
              notes={selectedStatement.notes || getReconciliationSummary(selectedStatement)}
              evidence={[
                { label: "发票数", value: selectedStatement.invoiceCount },
                { label: "异常数", value: selectedStatement.exceptionCount, tone: selectedStatement.exceptionCount ? "danger" : "success" },
                { label: "未结余额", value: fmt(selectedStatement.openBalance), tone: selectedStatement.openBalance ? "purple" : "success" },
                { label: "逾期金额", value: fmt(selectedStatement.overdueAmount), tone: selectedStatement.overdueAmount ? "danger" : "success" },
                { label: "结算状态", value: selectedStatement.settlementStatus, tone: getReconciliationStatusTone(selectedStatement.settlementStatus) },
                { label: "建议动作", value: getReconciliationSummary(selectedStatement), tone: isStatementException(selectedStatement) ? "warning" : "success" },
              ]}
            />
            <DocumentActionBar>
              <button onClick={() => confirm(selectedStatement)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#f0faf4", color: A.green }}>标记已确认</button>
              <button onClick={() => reject(selectedStatement)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#fff1f0", color: A.red }}>标记已驳回</button>
              <button onClick={() => close(selectedStatement)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#faf3ff", color: A.purple }}>关闭对账</button>
              <button onClick={() => exportDetail(selectedStatement)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.white, color: A.blue, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>导出明细 CSV</button>
              <button onClick={() => setSelectedStatement(null)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.white, color: A.label, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>关闭</button>
            </DocumentActionBar>
          </DocumentShell>
        )}
      </Modal>
    </div>
  );
}
