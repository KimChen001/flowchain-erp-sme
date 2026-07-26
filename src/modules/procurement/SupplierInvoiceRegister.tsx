import { useEffect, useMemo, useState } from "react";
import { AlertOctagon, CheckCircle2, FileSpreadsheet, FileText, MoreHorizontal, Search } from "lucide-react";
import { toast } from "sonner";
import { Modal, Card, Chip, A } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { DocumentActionBar, DocumentEvidencePanel, DocumentHeader, DocumentLinesTable, DocumentShell, DocumentStatusTimeline, DocumentTotals, statusTone, type TimelineStep } from "../../components/document/DocumentShell";
import { SUPPLIER_INVOICES, purchaseOrders, receivingDocs } from "../../data/empty-business-state";
import { getInvoiceLinkedDocuments } from "../../domain/procurement/document-links";
import { ContextualAIInsightPanel, type ContextualAIInsight } from "../../components/ai/ContextualAIInsightPanel";
import { makeInvoiceInsight, type ContextualAiAction } from "../../domain/contextual-ai";
import type { WorkflowContext } from "../../lib/workflowContext";
import { relatedRecordsForEntity } from "../../domain/relationships";
import { calculateInvoiceMatch, getInvoiceVarianceSummary, isInvoicePayableReady, supplierInvoiceExportRows } from "../../domain/procurement/invoice-matching";
import { calculateInvoiceTaxSummary, calculateLineTax, getTaxVarianceSummary } from "../../domain/finance/tax";
import { exportRowsToCsv } from "../../lib/data-export";
import { fmt } from "../../lib/format";
import type { SupplierInvoice, SupplierInvoiceStatus } from "../../types/scm";
import { matchStatusStyle } from "./shared";
import ContextualImportActions from "../../components/import/ContextualImportActions";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { useSearchParams } from "react-router";
import type { ActiveContext } from "../ai-assistant/Panel";
import {
  tableMinXlClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";

function invoiceStatusStyle(status: SupplierInvoiceStatus) {
  if (status === "存在差异" || status === "已驳回") return { color: A.red, bg: "#fff1f0" };
  if (status === "待匹配" || status === "待审批" || status === "已接收") return { color: A.orange, bg: "#fff8f0" };
  if (status === "已付款" || status === "已过账应付" || status === "已审批" || status === "已匹配") return { color: A.green, bg: "#f0faf4" };
  return { color: A.gray1, bg: A.gray6 };
}

function invoiceStatusLabel(status: SupplierInvoiceStatus) {
  if (status === "已过账应付") return "AP 可见";
  if (status === "已付款") return "外部已付款";
  return status;
}

function invoiceSourceLabel(source: SupplierInvoice["source"]) {
  return ({
    "supplier-portal": "供应商协同导入",
    "email-upload": "邮件上传",
    "manual-entry": "手工录入",
    "edi-sample": "EDI",
  } satisfies Record<SupplierInvoice["source"], string>)[source];
}

function invoiceTimeline(invoice: SupplierInvoice): TimelineStep[] {
  const blocked = invoice.status === "已驳回" || invoice.duplicateRisk || invoice.varianceType === "重复发票";
  const hasVariance = invoice.status === "存在差异" || invoice.matchStatus === "差异待处理" || invoice.varianceType !== "无差异";
  const isPaid = invoice.status === "已付款" || invoice.paid;
  const isPosted = invoice.status === "已过账应付" || invoice.postedToAp || isPaid;
  const isApproved = invoice.status === "已审批" || isPosted;
  const isMatched = invoice.status === "已匹配" || invoice.matchStatus === "自动匹配" || invoice.matchStatus === "已解决" || isApproved;
  const wasReceived = invoice.status !== "草稿";
  return [
    { label: "已接收", status: wasReceived ? "done" : "pending", helper: invoice.receivedDate },
    { label: "待匹配", status: blocked ? "blocked" : isMatched || hasVariance ? "done" : "current", helper: invoice.matchStatus },
    { label: hasVariance ? "存在差异" : "已匹配", status: blocked ? "blocked" : hasVariance ? "warning" : isMatched ? "done" : "pending", helper: invoice.varianceType },
    { label: "已审批", status: isApproved ? "done" : blocked || hasVariance ? "pending" : "current", helper: invoice.approvalStatus || "等待 AP 审批" },
    { label: "应付可见性", status: isPosted ? "done" : "pending", helper: invoice.postedToAp ? "已进入 AP 可见性" : "待复核" },
    { label: "付款状态", status: isPaid ? "done" : "pending", helper: invoice.paid ? "外部付款完成" : "未付款" },
  ];
}

type SupplierInvoiceRegisterProps = {
  mode?: "procurement" | "finance";
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; returnContext?: WorkflowContext | null; source?: string }) => void;
  onActiveContextChange?: (context: ActiveContext | null) => void;
};

export default function SupplierInvoiceRegister({ mode = "finance", focus, onNavigate, onActiveContextChange }: SupplierInvoiceRegisterProps) {
  const [searchParams] = useSearchParams();
  const [invoices, setInvoices] = useState<SupplierInvoice[]>(SUPPLIER_INVOICES);
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") || "全部");
  const [varianceFilter, setVarianceFilter] = useState(() => searchParams.get("variance") ? "价格差异" : "全部");
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  const [selectedInvoice, setSelectedInvoice] = useState<SupplierInvoice | null>(null);
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [invoiceInsight, setInvoiceInsight] = useState<ContextualAIInsight | null>(null);
  const isProcurementMode = mode === "procurement";

  const visibleInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    const supplier = searchParams.get("supplier") || "";
    const matchStatus = searchParams.get("matchStatus") || "";
    const overdue = searchParams.get("overdue") === "true";
    return invoices
      .filter((invoice) => statusFilter === "全部" || invoice.status === statusFilter)
      .filter((invoice) => varianceFilter === "全部" || invoice.varianceType === varianceFilter)
      .filter((invoice) => !supplier || invoice.supplier === supplier || invoice.supplierCode === supplier)
      .filter((invoice) => !overdue || (!invoice.paid && invoice.dueDate < "2026-07-11"))
      .filter((invoice) => !matchStatus
        || (matchStatus === "pending" && (invoice.status === "待匹配" || invoice.matchStatus === "未匹配"))
        || (matchStatus === "matched" && ["自动匹配", "已解决"].includes(invoice.matchStatus))
        || (matchStatus === "variance" && invoice.varianceType !== "无差异")
        || (matchStatus === "blocked" && (invoice.duplicateRisk || invoice.status === "已驳回")))
      .filter((invoice) => !q || [
        invoice.invoiceNumber,
        invoice.supplier,
        invoice.relatedPo,
        invoice.relatedGrn || "",
      ].some((value) => value.toLowerCase().includes(q)));
  }, [invoices, search, statusFilter, varianceFilter, searchParams]);

  useEffect(() => {
    setStatusFilter(searchParams.get("status") || "全部");
    if (!searchParams.get("variance")) setVarianceFilter("全部");
    setSearch(searchParams.get("q") || "");
  }, [searchParams]);

  const pendingMatch = invoices.filter((invoice) => invoice.status === "待匹配" || invoice.matchStatus === "未匹配").length;
  const varianceInvoices = invoices.filter((invoice) => invoice.varianceType !== "无差异" || invoice.status === "存在差异");
  const pendingApproval = invoices.filter((invoice) => invoice.status === "已匹配" || invoice.status === "待审批").length;
  const dueSoonAmount = invoices
    .filter((invoice) => !invoice.paid && isInvoicePayableReady(invoice))
    .reduce((sum, invoice) => sum + invoice.total, 0);

  function updateInvoice(id: string, patch: Partial<SupplierInvoice>) {
    setInvoices((current) => current.map((invoice) => invoice.id === id ? { ...invoice, ...patch } : invoice));
    setSelectedInvoice((current) => current?.id === id ? { ...current, ...patch } : current);
    setOpenActionId(null);
  }

  function runMatch(invoice: SupplierInvoice) {
    const snapshot = calculateInvoiceMatch(invoice, purchaseOrders, receivingDocs, invoices);
    updateInvoice(invoice.id, {
      status: snapshot.status,
      matchStatus: snapshot.matchStatus,
      varianceType: snapshot.varianceType,
      varianceAmount: snapshot.varianceAmount,
      notes: snapshot.suggestedAction,
    });
    toast.success("匹配已刷新", { description: `${invoice.invoiceNumber} · ${snapshot.varianceType}` });
  }

  function approve(invoice: SupplierInvoice) {
    if (invoice.varianceType !== "无差异" && invoice.matchStatus !== "已解决") {
      toast.warning("仍有差异待处理", { description: "请先解决三单匹配差异，再标记审批。" });
      return;
    }
    updateInvoice(invoice.id, { status: "已审批", approvalStatus: "已审批" });
    toast.success(`${invoice.invoiceNumber} 已标记为已审批`);
  }

  function previewPayableImpact(invoice: SupplierInvoice) {
    if (!["已审批", "已过账应付", "已付款"].includes(invoice.status) && !invoice.postedToAp) {
      toast.warning("请先完成发票审批复核");
      return;
    }
    setOpenActionId(null);
    toast("应付影响预览", { description: `${invoice.invoiceNumber} · 仅复核 AP 可见性，不做发票过账或会计分录。` });
  }

  function reject(invoice: SupplierInvoice) {
    updateInvoice(invoice.id, { status: "已驳回", matchStatus: "差异待处理", approvalStatus: "已驳回" });
    toast.success(`${invoice.invoiceNumber} 已驳回`);
  }

  function exportRegister() {
    if (visibleInvoices.length === 0) {
      toast.warning("暂无可导出的数据");
      return;
    }
    exportRowsToCsv("supplier-invoices-export.csv", supplierInvoiceExportRows(visibleInvoices));
    toast.success("导出文件已生成", { description: `${visibleInvoices.length} 条发票` });
  }

  function exportInvoice(invoice: SupplierInvoice) {
    const taxSummary = calculateInvoiceTaxSummary(invoice);
    const headerRows = [
      ["发票ID", invoice.id],
      ["发票号码", invoice.invoiceNumber],
      ["供应商", invoice.supplier],
      ["PO", invoice.relatedPo || ""],
      ["GRN", invoice.relatedGrn || ""],
      ["发票日期", invoice.invoiceDate],
      ["接收日期", invoice.receivedDate],
      ["到期日", invoice.dueDate],
      ["付款条款", invoice.paymentTerms],
      ["AP负责人", invoice.apOwner || ""],
      ["来源", invoiceSourceLabel(invoice.source)],
      ["匹配状态", invoice.matchStatus],
      ["发票状态", invoiceStatusLabel(invoice.status)],
      ["审批状态", invoice.approvalStatus || ""],
      ["重复风险", invoice.duplicateRisk ? "是" : "否"],
      ["差异类型", invoice.varianceType],
      ["税码", taxSummary.taxCodes.join(" / ")],
      ["税率", taxSummary.taxRates.join(" / ")],
      ["未税金额", invoice.subtotal],
      ["税额", invoice.tax],
      ["价税合计", invoice.subtotal + invoice.tax],
      ["运费", invoice.freight || 0],
      ["发票总额", invoice.total],
      ["差异金额", invoice.varianceAmount],
      ["AP可见性", invoice.postedToAp ? "是" : "否"],
      ["付款状态", invoice.paid ? "外部已付款" : "未付款"],
      ["备注", invoice.notes || ""],
    ].map(([field, value]) => ({ section: "header", field, value }));
    const lineRows = invoice.lines.map((line) => ({
      section: "line",
      field: line.lineId,
      value: `${line.sku} ${line.name}`,
      税码: calculateLineTax(line).taxCode,
      发票数量: line.quantity,
      单位: line.unit,
      单价: line.unitPrice,
      税率: line.taxRate,
      未税金额: line.lineSubtotal,
      税额: line.taxAmount,
      价税合计: line.lineTotal,
      订购数量: line.orderedQty ?? "",
      收货数量: line.receivedQty ?? "",
      匹配数量: line.matchedQty ?? "",
      差异类型: line.varianceType || invoice.varianceType,
      差异金额: line.varianceAmount ?? invoice.varianceAmount,
    }));
    exportRowsToCsv(`supplier-invoice-detail-${invoice.invoiceNumber}.csv`, [...headerRows, ...lineRows]);
    toast.success("导出文件已生成", { description: "供应商发票详情" });
  }

  function openInvoiceInsight(invoice: SupplierInvoice, trigger: string) {
    const snapshot = calculateInvoiceMatch(invoice, purchaseOrders, receivingDocs, invoices);
    setInvoiceInsight({
      ...makeInvoiceInsight({
        invoiceNumber: invoice.invoiceNumber,
        supplier: invoice.supplier,
        po: invoice.relatedPo,
        grn: invoice.relatedGrn,
        matchStatus: snapshot.matchStatus,
        varianceType: snapshot.varianceType,
        varianceAmount: snapshot.varianceAmount,
      }),
      trigger,
    });
  }

  function handleInvoiceInsightAction(action: ContextualAiAction) {
    if (action.intent === "preview_invoice_resolution_note") {
      toast("仅预览差异处理备注", { description: `${action.sourceEntityId} · 不自动审批、不付款、不做应付过账。` });
      return;
    }
    toast(action.label, { description: "仅提供上下文洞察，需人工复核后处理。" });
  }

  const selectedSnapshot = selectedInvoice
    ? calculateInvoiceMatch(selectedInvoice, purchaseOrders, receivingDocs, invoices)
    : null;

  useEffect(() => {
    if (focus?.entityType !== "supplier_invoice" || !focus.entityId) return;
    const invoice = invoices.find((item) => item.invoiceNumber === focus.entityId || item.id === focus.entityId);
    if (invoice) setSelectedInvoice(invoice);
  }, [focus?.at, focus?.entityType, focus?.entityId, invoices]);

  useEffect(() => {
    if (!selectedInvoice) {
      onActiveContextChange?.(null);
      return;
    }
    onActiveContextChange?.({
      module: "procurement",
      entityType: "supplier",
      entityId: selectedInvoice.supplier,
      entityLabel: selectedInvoice.supplier,
      view: "invoices",
    });
    return () => onActiveContextChange?.(null);
  }, [selectedInvoice?.invoiceNumber, selectedInvoice?.supplier, onActiveContextChange]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <ActionableMetricCard label={isProcurementMode ? "协同发票" : "发票总数"} value={String(invoices.length)} description={isProcurementMode ? "PO / GRN 协同" : "查看全部发票台账"} to="/app/finance/invoices" icon={FileText} color={A.blue} />
        <ActionableMetricCard label="待匹配" value={String(pendingMatch)} description="需补齐 PO / GRN" to="/app/finance/invoices?matchStatus=pending" icon={Search} color={A.orange} />
        <ActionableMetricCard label="差异发票" value={String(varianceInvoices.length)} description={`差异金额 ${fmt(varianceInvoices.reduce((sum, invoice) => sum + invoice.varianceAmount, 0))}`} to="/app/finance/invoices?matchStatus=variance" icon={AlertOctagon} color={A.red} />
        <ActionableMetricCard label={isProcurementMode ? "待采购确认" : "待审批"} value={String(pendingApproval)} description={isProcurementMode ? "匹配后确认" : `待复核金额 ${fmt(dueSoonAmount)}`} to="/app/finance/invoices?status=待审批" icon={CheckCircle2} color={A.green} />
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>{isProcurementMode ? "发票协同" : "供应商发票台账"}</h2>
            <p className="text-[11px] mt-1" style={{ color: A.sub }}>
                {isProcurementMode
                ? "围绕 PO / GRN 匹配、发票差异、税额拆分、采购确认、关联退货贷项与下一步动作形成协同证据链。"
                : "复核供应商发票、发票行、税额拆分、三单匹配、审批状态与 AP 可见性，形成匹配证据链。"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!isProcurementMode && <ContextualImportActions entityLabel="发票" templateName="发票" compact />}
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}
              className="h-8 rounded-lg px-2 text-xs outline-none" style={{ background: A.gray6, color: A.label }}>
              {[
                { value: "全部", label: "全部" },
                { value: "待匹配", label: "待匹配" },
                { value: "存在差异", label: "存在差异" },
                { value: "已匹配", label: "已匹配" },
                { value: "待审批", label: "待审批" },
                { value: "已审批", label: "已审批" },
                { value: "已过账应付", label: "AP 可见" },
                { value: "已付款", label: "外部已付款" },
              ].map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <select value={varianceFilter} onChange={(event) => setVarianceFilter(event.target.value)}
              className="h-8 rounded-lg px-2 text-xs outline-none" style={{ background: A.gray6, color: A.label }}>
              {["全部", "无差异", "价格差异", "数量差异", "税额差异", "运费差异", "缺少收货", "缺少PO", "重复发票"].map((item) => <option key={item}>{item}</option>)}
            </select>
            <div className="h-8 px-2 rounded-lg flex items-center gap-1.5" style={{ background: A.gray6 }}>
              <Search size={12} style={{ color: A.gray2 }} />
              <input value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索发票/供应商/PO/GRN"
                className="w-44 bg-transparent outline-none text-xs"
                style={{ color: A.label }} />
            </div>
            <button onClick={exportRegister}
              className="h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5"
              style={{ background: "#f0f6ff", color: A.blue }}>
              <FileSpreadsheet size={13} /> 导出当前结果
            </button>
          </div>
        </div>
      </Card>

      <Card>
        <div className={tableScrollClass}>
          <table className={tableMinXlClass}>
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                {["发票编号", "供应商", "PO", "GRN", "发票日期", "到期日", "未税金额", "税额", "价税合计", "付款条款", "匹配状态", "发票状态", "差异类型", "操作"].map((header) => (
                  <th key={header} className={thClass} style={{ color: A.gray1 }}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((invoice, index) => {
                const statusStyle = invoiceStatusStyle(invoice.status);
                const matchStyle = matchStatusStyle(invoice.matchStatus);
                return (
                  <tr key={invoice.id} style={{ borderBottom: index < visibleInvoices.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={tdIdClass}><BusinessEntityLink entityType="supplier_invoice" entityId={invoice.invoiceNumber}>{invoice.invoiceNumber}</BusinessEntityLink></td>
                    <td className={`${tdNameClass} max-w-[180px] truncate font-medium`}><BusinessEntityLink entityType="supplier" entityId={invoice.supplierCode || invoice.supplier}>{invoice.supplier}</BusinessEntityLink></td>
                    <td className={tdNowrapClass}><BusinessEntityLink entityType="purchase_order" entityId={invoice.relatedPo} exists={Boolean(invoice.relatedPo)}>{invoice.relatedPo || "—"}</BusinessEntityLink></td>
                    <td className={tdNowrapClass}><BusinessEntityLink entityType="receiving_doc" entityId={invoice.relatedGrn} exists={Boolean(invoice.relatedGrn)}>{invoice.relatedGrn || "缺少"}</BusinessEntityLink></td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{invoice.invoiceDate}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{invoice.dueDate}</td>
                    <td className={tdNumericClass} style={{ color: A.sub }}>{fmt(invoice.subtotal)}</td>
                    <td className={tdNumericClass} style={{ color: A.sub }}>{fmt(invoice.tax)}</td>
                    <td className={`${tdNumericClass} font-semibold`} style={{ color: A.label }}>{fmt(invoice.total)}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{invoice.paymentTerms}</td>
                    <td className={tdNowrapClass}><Chip label={invoice.matchStatus} color={matchStyle.color} bg={matchStyle.bg} /></td>
                    <td className={tdNowrapClass}><Chip label={invoiceStatusLabel(invoice.status)} color={statusStyle.color} bg={statusStyle.bg} /></td>
                    <td className={tdNowrapClass} style={{ color: invoice.varianceType === "无差异" ? A.green : A.red }}>{invoice.varianceType}</td>
                    <td className={tdActionClass}>
                      <div className="relative flex items-center gap-1">
                        <button onClick={() => setSelectedInvoice(invoice)} className="px-2 py-1 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>详情</button>
                        <button onClick={() => setOpenActionId((current) => current === invoice.id ? null : invoice.id)} className="px-2 py-1 rounded-md font-medium flex items-center gap-1" style={{ background: A.gray6, color: A.gray1 }}>
                          更多 <MoreHorizontal size={12} />
                        </button>
                        {openActionId === invoice.id && (
                          <div className="absolute right-0 top-7 z-20 w-28 rounded-lg p-1 shadow-lg" style={{ background: A.white, boxShadow: "0 10px 30px rgba(15,23,42,0.12)" }}>
                            <button onClick={() => runMatch(invoice)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.blue }}>运行匹配</button>
                            <button onClick={() => approve(invoice)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.green }}>审批确认</button>
                            {!isProcurementMode && <button onClick={() => previewPayableImpact(invoice)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.purple }}>预览应付影响</button>}
                            <button onClick={() => reject(invoice)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.red }}>驳回</button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={Boolean(selectedInvoice)}
        onClose={() => setSelectedInvoice(null)}
        width={980}
        title="供应商发票"
        subtitle={isProcurementMode ? "采购协同 · 发票匹配" : "发票与匹配协同 · 供应商发票"}>
        {selectedInvoice && selectedSnapshot && (
          (() => {
            const taxSummary = calculateInvoiceTaxSummary(selectedInvoice);
            const invoiceReturnContext: WorkflowContext = {
              sourceModule: isProcurementMode ? "procurement" : "finance",
              sourceEntityType: "supplier_invoice",
              sourceEntityId: selectedInvoice.invoiceNumber,
              sourceRoute: isProcurementMode ? "procurement:invoices" : "finance:invoices",
              sourceLabel: selectedInvoice.invoiceNumber,
              returnLabel: `返回供应商发票 ${selectedInvoice.invoiceNumber}`,
            };
            return (
          <DocumentShell
            title="供应商发票"
            documentNo={selectedInvoice.invoiceNumber}
            moduleLabel={isProcurementMode ? "采购 / 发票协同" : "财务 / 发票与匹配"}
            status={invoiceStatusLabel(selectedInvoice.status)}
            subtitle={`${selectedInvoice.supplier} · PO ${selectedInvoice.relatedPo || "—"} · GRN ${selectedInvoice.relatedGrn || "缺少"}`}
          >
            <DocumentHeader
              fields={[
                { label: "发票ID", value: selectedInvoice.id },
                { label: "发票号码", value: selectedInvoice.invoiceNumber },
                { label: "供应商", value: selectedInvoice.supplier },
                { label: "PO", value: selectedInvoice.relatedPo || "—", tone: selectedInvoice.relatedPo ? "info" : "warning" },
                { label: "GRN", value: selectedInvoice.relatedGrn || "缺少", tone: selectedInvoice.relatedGrn ? "info" : "warning" },
                { label: "发票日期", value: selectedInvoice.invoiceDate },
                { label: "接收日期", value: selectedInvoice.receivedDate },
                { label: "到期日", value: selectedInvoice.dueDate },
                { label: "付款条款", value: selectedInvoice.paymentTerms },
                { label: "AP负责人", value: selectedInvoice.apOwner || "—" },
                { label: "来源", value: invoiceSourceLabel(selectedInvoice.source) },
                { label: "匹配状态", value: selectedInvoice.matchStatus, tone: statusTone(selectedInvoice.matchStatus) },
                { label: "发票状态", value: invoiceStatusLabel(selectedInvoice.status), tone: statusTone(selectedInvoice.status) },
                { label: "审批状态", value: selectedInvoice.approvalStatus || "—" },
                { label: "重复风险", value: selectedInvoice.duplicateRisk ? "是" : "否", tone: selectedInvoice.duplicateRisk ? "danger" : "success" },
                { label: "差异类型", value: selectedSnapshot.varianceType, tone: selectedSnapshot.varianceType === "无差异" ? "success" : "danger" },
                { label: "税码", value: taxSummary.taxCodes.join(" / ") || "待维护" },
                { label: "税率", value: taxSummary.taxRates.join(" / ") || "待维护" },
              ]}
            />
            <DocumentStatusTimeline steps={invoiceTimeline(selectedInvoice)} />
            <DocumentLinesTable
              rows={selectedInvoice.lines}
              columns={[
                { key: "sku", label: "SKU", render: (line) => <span style={{ color: A.blue }}>{String(line.sku)}</span> },
                { key: "name", label: "品名" },
                { key: "quantity", label: "发票数量", align: "right", render: (line) => Number(line.quantity).toLocaleString() },
                { key: "unit", label: "单位" },
                { key: "unitPrice", label: "单价", align: "right", render: (line) => fmt(Number(line.unitPrice || 0)) },
                { key: "taxCode", label: "税码", render: (line) => calculateLineTax(line).taxCode },
                { key: "taxRate", label: "税率", align: "right", render: (line) => `${Math.round(Number(line.taxRate || 0) * 100)}%` },
                { key: "lineSubtotal", label: "未税金额", align: "right", render: (line) => fmt(Number(line.lineSubtotal || 0)) },
                { key: "taxAmount", label: "税额", align: "right", render: (line) => fmt(Number(line.taxAmount || 0)) },
                { key: "lineTotal", label: "价税合计", align: "right", render: (line) => fmt(Number(line.lineTotal || 0)) },
                { key: "orderedQty", label: "订购数量", align: "right", render: (line) => line.orderedQty ?? "—" },
                { key: "receivedQty", label: "收货数量", align: "right", render: (line) => line.receivedQty ?? "—" },
                { key: "matchedQty", label: "匹配数量", align: "right", render: (line) => line.matchedQty ?? "—" },
                { key: "varianceType", label: "差异类型", render: (line) => String(line.varianceType || selectedInvoice.varianceType) },
                { key: "varianceAmount", label: "差异金额", align: "right", render: (line) => fmt(Number(line.varianceAmount ?? selectedInvoice.varianceAmount ?? 0)) },
              ]}
            />
            <DocumentTotals
              totals={[
                { label: "未税金额", value: fmt(selectedInvoice.subtotal) },
                { label: "税额", value: fmt(selectedInvoice.tax) },
                { label: "价税合计", value: fmt(selectedInvoice.subtotal + selectedInvoice.tax), tone: "info" },
                { label: "运费", value: fmt(selectedInvoice.freight || 0) },
                { label: "发票总额", value: fmt(selectedInvoice.total), tone: "info" },
                { label: "差异金额", value: fmt(selectedSnapshot.varianceAmount), tone: selectedSnapshot.varianceAmount ? "danger" : "success" },
              ]}
              columns={5}
            />
            <ContextualAIInsightPanel insight={invoiceInsight} onClose={() => setInvoiceInsight(null)} onAction={handleInvoiceInsightAction} returnContext={invoiceReturnContext} onNavigateRecord={onNavigate} />
            <DocumentEvidencePanel
              linkedDocuments={getInvoiceLinkedDocuments(selectedInvoice, purchaseOrders, receivingDocs)}
              onNavigate={onNavigate}
              returnContext={invoiceReturnContext}
              relatedRecords={relatedRecordsForEntity({ purchaseOrders, receivingDocs, supplierInvoices: invoices }, "invoice", selectedInvoice.invoiceNumber)}
              confidence={`${selectedInvoice.confidence || 0}%`}
              provenance={invoiceSourceLabel(selectedInvoice.source)}
              notes={selectedInvoice.notes || `${getInvoiceVarianceSummary(selectedInvoice)} 三单匹配用于比较 PO、GRN 与供应商发票的金额、数量与状态差异。`}
              evidence={[
                { label: "PO 金额", value: fmt(selectedSnapshot.poAmount) },
                { label: "GRN 金额", value: fmt(selectedSnapshot.grnAmount) },
                { label: "发票金额", value: fmt(selectedSnapshot.invoiceAmount) },
                { label: "税码 / 税率", value: `${taxSummary.taxCodes.join(" / ")} · ${taxSummary.taxRates.join(" / ")}` },
                { label: "税额拆分", value: getTaxVarianceSummary(selectedInvoice), tone: selectedInvoice.varianceType === "税额差异" ? "warning" : "success" },
                { label: "匹配状态", value: selectedSnapshot.matchStatus, tone: statusTone(selectedSnapshot.matchStatus) },
                { label: "差异类型", value: selectedSnapshot.varianceType, tone: selectedSnapshot.varianceType === "无差异" ? "success" : "danger" },
                { label: "重复风险", value: selectedInvoice.duplicateRisk ? "是" : "否", tone: selectedInvoice.duplicateRisk ? "danger" : "success" },
              ]}
            />
            <DocumentActionBar>
              <button onClick={() => openInvoiceInsight(selectedInvoice, "解释匹配失败")} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#f0f6ff", color: A.blue }}>解释匹配失败</button>
              <button onClick={() => openInvoiceInsight(selectedInvoice, "追踪 PO/GRN/发票差异")} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.gray6, color: A.label }}>追踪 PO/GRN/发票差异</button>
              <button onClick={() => openInvoiceInsight(selectedInvoice, "检查收货影响")} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#fff8f0", color: A.orange }}>检查收货影响</button>
              <button onClick={() => handleInvoiceInsightAction({
                id: `preview_invoice_resolution_note:supplier_invoice:${selectedInvoice.invoiceNumber}`,
                label: `预览 ${selectedInvoice.invoiceNumber} 差异处理备注`,
                intent: "preview_invoice_resolution_note",
                sourceModule: isProcurementMode ? "procurement" : "finance",
                sourceEntityType: "supplier_invoice",
                sourceEntityId: selectedInvoice.invoiceNumber,
                sourceRoute: isProcurementMode ? "procurement:invoices" : "finance:invoices",
                linkedRecords: [
                  ...(selectedInvoice.relatedPo ? [{ type: "purchase_order", id: selectedInvoice.relatedPo }] : []),
                  ...(selectedInvoice.relatedGrn ? [{ type: "grn", id: selectedInvoice.relatedGrn }] : []),
                ],
                allowedOutputType: "draft_preview",
                requiresReview: true,
                mutationAllowed: false,
              })} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#faf3ff", color: A.purple }}>预览差异处理备注</button>
              <button onClick={() => runMatch(selectedInvoice)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#f0f6ff", color: A.blue }}>运行匹配</button>
              <button onClick={() => approve(selectedInvoice)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#f0faf4", color: A.green }}>标记已审批</button>
              {!isProcurementMode && <button onClick={() => previewPayableImpact(selectedInvoice)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#faf3ff", color: A.purple }}>预览应付影响</button>}
              <button onClick={() => reject(selectedInvoice)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: "#fff1f0", color: A.red }}>驳回</button>
              <button onClick={() => exportInvoice(selectedInvoice)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.white, color: A.blue, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>导出详情</button>
              <button onClick={() => setSelectedInvoice(null)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.white, color: A.label, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>关闭</button>
            </DocumentActionBar>
          </DocumentShell>
            );
          })()
        )}
      </Modal>
    </div>
  );
}
