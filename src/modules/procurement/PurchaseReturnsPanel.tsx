import { useMemo, useState } from "react";
import { AlertOctagon, CheckCircle2, CreditCard, FileSpreadsheet, MoreHorizontal, PackageX, Search, Undo2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Modal, Card, Chip, KpiCard, A } from "../../components/ui";
import { DocumentActionBar, DocumentEvidencePanel, DocumentHeader, DocumentLinesTable, DocumentShell, DocumentStatusTimeline, DocumentTotals, type TimelineStep } from "../../components/document/DocumentShell";
import { PURCHASE_RETURNS, SUPPLIER_CREDIT_MEMOS, SUPPLIER_INVOICES, SUPPLIER_RECONCILIATION_STATEMENTS, purchaseOrders, receivingDocs } from "../../data/empty-business-state";
import { getPurchaseReturnLinkedDocuments } from "../../domain/procurement/document-links";
import { calculateReturnFinancialImpact, creditMemoExportRows, getCreditMemoStatusTone, getReturnStatusTone, getReturnSummary, isReturnException, purchaseReturnExportRows, purchaseReturnLineExportRows } from "../../domain/procurement/returns";
import { exportRowsToCsv } from "../../lib/data-export";
import { fmt } from "../../lib/format";
import type { PurchaseReturn, PurchaseReturnReason, PurchaseReturnStatus, SupplierCreditMemo, SupplierCreditMemoStatus } from "../../types/scm";

const RETURN_STATUSES: ("全部" | PurchaseReturnStatus)[] = ["全部", "待审批", "已审批", "已退货", "待贷项", "已生成贷项", "已关闭", "已驳回"];
const RETURN_REASONS: ("全部" | PurchaseReturnReason)[] = ["全部", "质检拒收", "数量差异", "价格差异", "重复发票", "其他"];

function toneStyle(tone: string) {
  if (tone === "success") return { color: A.green, bg: "#f0faf4" };
  if (tone === "warning") return { color: A.orange, bg: "#fff8f0" };
  if (tone === "danger") return { color: A.red, bg: "#fff1f0" };
  if (tone === "purple") return { color: A.purple, bg: "#faf3ff" };
  return { color: A.gray1, bg: A.gray6 };
}

function returnTimeline(returnDoc: PurchaseReturn, memo?: SupplierCreditMemo): TimelineStep[] {
  const rejected = returnDoc.status === "已驳回";
  const approved = ["已审批", "已退货", "待贷项", "已生成贷项", "已关闭"].includes(returnDoc.status);
  const returned = ["已退货", "待贷项", "已生成贷项", "已关闭"].includes(returnDoc.status);
  const creditGenerated = Boolean(returnDoc.creditMemoId || memo || ["已生成贷项", "已关闭"].includes(returnDoc.status));
  const offsetDone = memo?.status === "已冲减应付" || memo?.apOffsetStatus === "已冲减应付";
  return [
    { label: "草稿", status: returnDoc.status === "草稿" ? "current" : "done", helper: returnDoc.createdDate },
    { label: "待审批", status: rejected ? "blocked" : approved ? "done" : returnDoc.status === "待审批" ? "current" : "pending", helper: returnDoc.approvalStatus || returnDoc.owner },
    { label: "已审批", status: rejected ? "blocked" : approved ? "done" : "pending", helper: approved ? "审批完成" : "等待审批" },
    { label: "已退货", status: rejected ? "blocked" : returned ? "done" : approved ? "current" : "pending", helper: returnDoc.returnQty > 0 ? `数量 ${returnDoc.returnQty}` : "无实物退货" },
    { label: "待贷项", status: rejected ? "blocked" : creditGenerated ? "done" : returned || returnDoc.status === "待贷项" ? "warning" : "pending", helper: creditGenerated ? "已关联贷项" : "等待供应商贷项" },
    { label: "已生成贷项", status: rejected ? "blocked" : creditGenerated ? "done" : "pending", helper: memo?.creditMemoNo || returnDoc.creditMemoId || "未生成" },
    { label: "已关闭", status: returnDoc.status === "已关闭" || offsetDone ? "done" : rejected ? "blocked" : "pending", helper: offsetDone ? "已冲减应付" : "可关闭" },
  ];
}

function linkedCredit(returnDoc: PurchaseReturn, creditMemos: SupplierCreditMemo[]) {
  return creditMemos.find((memo) => memo.relatedReturn === returnDoc.returnNo || memo.id === returnDoc.creditMemoId || memo.creditMemoNo === returnDoc.creditMemoId);
}

function blockedReturnAction(returnDoc: PurchaseReturn, action: "approve" | "reject" | "markReturned" | "generateCredit" | "close", creditMemos: SupplierCreditMemo[]) {
  if (returnDoc.status === "已关闭") return "已关闭的采购退货不能继续处理。";
  if (["approve", "reject", "markReturned", "generateCredit"].includes(action) && returnDoc.status === "已驳回") return "已驳回的采购退货不能继续推进。";
  if (action === "markReturned" && returnDoc.status === "待审批") return "采购退货需先完成审批。";
  if (action === "markReturned" && returnDoc.status === "已驳回") return "已驳回的采购退货不能标记退货。";
  if (action === "close" && returnDoc.status === "已驳回") return "已驳回的采购退货不能关闭异常处理。";
  if (action === "generateCredit" && linkedCredit(returnDoc, creditMemos)) return "该采购退货已关联供应商贷项通知。";
  return "";
}

function blockedCreditAction(memo: SupplierCreditMemo, action: "confirm" | "offset" | "reject") {
  if (action === "reject" && memo.status === "已冲减应付") return "已冲减应付的贷项通知不能驳回。";
  if (action === "offset" && ["已驳回", "已关闭"].includes(memo.status)) return "已驳回或已关闭的贷项通知不能冲减应付。";
  if (action === "offset" && memo.status !== "已确认" && memo.status !== "已冲减应付") return "贷项通知需先确认后再冲减应付。";
  if (action === "confirm" && ["已驳回", "已关闭"].includes(memo.status)) return "已驳回或已关闭的贷项通知不能确认。";
  return "";
}

export default function PurchaseReturnsPanel() {
  const [returns, setReturns] = useState<PurchaseReturn[]>(PURCHASE_RETURNS);
  const [creditMemos, setCreditMemos] = useState<SupplierCreditMemo[]>(SUPPLIER_CREDIT_MEMOS);
  const [statusFilter, setStatusFilter] = useState<(typeof RETURN_STATUSES)[number]>("全部");
  const [reasonFilter, setReasonFilter] = useState<(typeof RETURN_REASONS)[number]>("全部");
  const [search, setSearch] = useState("");
  const [selectedReturn, setSelectedReturn] = useState<PurchaseReturn | null>(null);
  const [openReturnActionId, setOpenReturnActionId] = useState<string | null>(null);
  const [openCreditActionId, setOpenCreditActionId] = useState<string | null>(null);

  const visibleReturns = useMemo(() => {
    const q = search.trim().toLowerCase();
    return returns
      .filter((row) => statusFilter === "全部" || row.status === statusFilter)
      .filter((row) => reasonFilter === "全部" || row.reason === reasonFilter)
      .filter((row) => !q || [row.returnNo, row.supplier, row.relatedPo, row.relatedGrn, row.relatedInvoice, row.creditMemoId].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [reasonFilter, returns, search, statusFilter]);

  const pendingApproval = returns.filter((row) => row.status === "待审批").length;
  const pendingCredit = returns.filter((row) => ["已退货", "待贷项"].includes(row.status) && !linkedCredit(row, creditMemos)).length;
  const offsetCredits = creditMemos.filter((memo) => memo.status === "已冲减应付" || memo.apOffsetStatus === "已冲减应付").reduce((sum, memo) => sum + memo.totalCredit, 0);
  const totalReturnAmount = returns.reduce((sum, row) => sum + row.total, 0);
  const unoffsetAmount = returns.reduce((sum, row) => sum + calculateReturnFinancialImpact(row, creditMemos), 0);

  function updateReturn(id: string, patch: Partial<PurchaseReturn>) {
    setReturns((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    setSelectedReturn((current) => current?.id === id ? { ...current, ...patch } : current);
    setOpenReturnActionId(null);
  }

  function updateCredit(id: string, patch: Partial<SupplierCreditMemo>) {
    setCreditMemos((current) => current.map((memo) => memo.id === id ? { ...memo, ...patch } : memo));
    setOpenCreditActionId(null);
  }

  function approve(returnDoc: PurchaseReturn) {
    const blocked = blockedReturnAction(returnDoc, "approve", creditMemos);
    if (blocked) {
      toast.warning(blocked);
      return;
    }
    updateReturn(returnDoc.id, { status: "已审批", approvalStatus: "已审批" });
    toast.success(`${returnDoc.returnNo} 已标记为已审批`);
  }

  function markReturned(returnDoc: PurchaseReturn) {
    const blocked = blockedReturnAction(returnDoc, "markReturned", creditMemos);
    if (blocked) {
      toast.warning(blocked);
      return;
    }
    updateReturn(returnDoc.id, { status: returnDoc.creditMemoId ? "已生成贷项" : "待贷项", approvalStatus: "已审批" });
    toast.success(`${returnDoc.returnNo} 已标记为已退货`);
  }

  function generateCredit(returnDoc: PurchaseReturn) {
    const blocked = blockedReturnAction(returnDoc, "generateCredit", creditMemos);
    if (blocked) {
      toast.warning(blocked);
      return;
    }
    const creditMemoNo = `CM-${returnDoc.returnNo.replace("RTV-", "")}`;
    const memo: SupplierCreditMemo = {
      id: creditMemoNo,
      creditMemoNo,
      supplier: returnDoc.supplier,
      relatedReturn: returnDoc.returnNo,
      relatedInvoice: returnDoc.relatedInvoice,
      relatedPo: returnDoc.relatedPo,
      relatedGrn: returnDoc.relatedGrn,
      issueDate: "2026-06-03",
      receivedDate: "2026-06-03",
      currency: returnDoc.currency,
      subtotal: returnDoc.subtotal,
      tax: returnDoc.tax,
      totalCredit: returnDoc.total,
      status: "待确认",
      apOffsetStatus: "未冲减",
      owner: returnDoc.owner,
      source: "manual-adjustment",
      notes: "采购退货已登记供应商贷项通知，等待 AP 复核应付冲减。",
    };
    setCreditMemos((current) => [memo, ...current]);
    updateReturn(returnDoc.id, { status: "已生成贷项", creditMemoId: creditMemoNo });
    toast.success("贷项通知已登记", { description: creditMemoNo });
  }

  function close(returnDoc: PurchaseReturn) {
    const blocked = blockedReturnAction(returnDoc, "close", creditMemos);
    if (blocked) {
      toast.warning(blocked);
      return;
    }
    updateReturn(returnDoc.id, { status: "已关闭" });
    toast.success("已关闭异常处理", { description: returnDoc.returnNo });
  }

  function reject(returnDoc: PurchaseReturn) {
    const blocked = blockedReturnAction(returnDoc, "reject", creditMemos);
    if (blocked) {
      toast.warning(blocked);
      return;
    }
    updateReturn(returnDoc.id, { status: "已驳回", approvalStatus: "已驳回" });
    toast.success(`${returnDoc.returnNo} 已驳回`);
  }

  function updateCreditStatus(memo: SupplierCreditMemo, patch: Partial<SupplierCreditMemo>, success: string) {
    const nextStatus = patch.status as SupplierCreditMemoStatus | undefined;
    const action = nextStatus === "已确认" ? "confirm" : nextStatus === "已冲减应付" || patch.apOffsetStatus === "已冲减应付" ? "offset" : nextStatus === "已驳回" ? "reject" : null;
    const blocked = action ? blockedCreditAction(memo, action) : "";
    if (blocked) {
      toast.warning(blocked);
      return;
    }
    updateCredit(memo.id, patch);
    toast.success(success, { description: memo.creditMemoNo });
  }

  function exportList() {
    if (visibleReturns.length === 0) {
      toast.warning("暂无可导出的采购退货");
      return;
    }
    exportRowsToCsv("purchase-returns-export.csv", purchaseReturnExportRows(visibleReturns));
    toast.success("导出文件已生成", { description: "采购退货 CSV" });
  }

  function exportCreditMemos() {
    if (creditMemos.length === 0) {
      toast.warning("暂无可导出的贷项通知");
      return;
    }
    exportRowsToCsv("supplier-credit-memos-export.csv", creditMemoExportRows(creditMemos));
    toast.success("导出文件已生成", { description: "供应商贷项通知 CSV" });
  }

  function exportDetail(returnDoc: PurchaseReturn) {
    exportRowsToCsv(`purchase-return-detail-${returnDoc.returnNo}.csv`, purchaseReturnLineExportRows(returnDoc, creditMemos));
    toast.success("导出文件已生成", { description: "退货明细 CSV" });
  }

  const selectedCredit = selectedReturn ? linkedCredit(selectedReturn, creditMemos) : undefined;
  const selectedImpact = selectedReturn ? calculateReturnFinancialImpact(selectedReturn, creditMemos) : 0;
  const selectedConfirmedCredit = selectedReturn
    ? creditMemos
      .filter((memo) => memo.relatedReturn === selectedReturn.returnNo || memo.id === selectedReturn.creditMemoId || memo.creditMemoNo === selectedReturn.creditMemoId)
      .filter((memo) => ["已确认", "已冲减应付", "已关闭"].includes(memo.status))
      .reduce((sum, memo) => sum + memo.totalCredit, 0)
    : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <KpiCard label="退货单数" value={String(returns.length)} sub="RTV / 贷项通知" icon={PackageX} color={A.blue} />
        <KpiCard label="待审批" value={String(pendingApproval)} sub="需采购确认" icon={CheckCircle2} color={A.orange} />
        <KpiCard label="待贷项" value={String(pendingCredit)} sub="已退货未冲减" icon={AlertOctagon} color={A.red} />
        <KpiCard label="已冲减应付" value={fmt(offsetCredits)} sub="贷项通知金额" icon={CreditCard} color={A.green} />
        <KpiCard label="退货金额" value={fmt(totalReturnAmount)} sub="本期异常影响" icon={Undo2} color={A.purple} />
        <KpiCard label="未冲减金额" value={fmt(unoffsetAmount)} sub="需 AP/对账复核" icon={Wallet} color={unoffsetAmount ? A.red : A.green} />
      </div>

      <Card>
        <div className="px-5 py-4 flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>采购退货 / 供应商贷项</h2>
            <p className="text-[11px] mt-1" style={{ color: A.sub }}>
              管理采购退货、供应商贷项通知、库存影响、应付冲减与供应商对账调整，形成异常处理证据链。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              className="h-8 rounded-lg px-2 text-xs outline-none" style={{ background: A.gray6, color: A.label }}>
              {RETURN_STATUSES.map((item) => <option key={item}>{item}</option>)}
            </select>
            <select value={reasonFilter} onChange={(event) => setReasonFilter(event.target.value as typeof reasonFilter)}
              className="h-8 rounded-lg px-2 text-xs outline-none" style={{ background: A.gray6, color: A.label }}>
              {RETURN_REASONS.map((item) => <option key={item}>{item}</option>)}
            </select>
            <div className="h-8 px-2 rounded-lg flex items-center gap-1.5" style={{ background: A.gray6 }}>
              <Search size={13} style={{ color: A.gray1 }} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="退货/供应商/PO/GRN/发票"
                className="w-48 bg-transparent text-xs outline-none" style={{ color: A.label }} />
            </div>
            <button onClick={exportList}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg"
              style={{ background: A.gray6, color: A.blue }}>
              <FileSpreadsheet size={13} /> 导出当前结果
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                {["退货单号", "供应商", "PO", "GRN", "发票", "原因", "退货日期", "退货数量", "退货金额", "状态", "贷项通知", "操作"].map((header) => (
                  <th key={header} className="text-left px-5 py-3 font-medium whitespace-nowrap" style={{ color: A.gray1 }}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleReturns.map((row, index) => {
                const statusStyle = toneStyle(getReturnStatusTone(row.status));
                const memo = linkedCredit(row, creditMemos);
                return (
                  <tr key={row.id} style={{ borderBottom: index < visibleReturns.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className="px-5 py-3 font-semibold whitespace-nowrap" style={{ color: A.blue }}>{row.returnNo}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.label }}>{row.supplier}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{row.relatedPo}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{row.relatedGrn}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{row.relatedInvoice || "—"}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: row.reason === "重复发票" ? A.red : A.label }}>{row.reason}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{row.returnDate}</td>
                    <td className="px-5 py-3 tabular-nums" style={{ color: A.label }}>{row.returnQty}</td>
                    <td className="px-5 py-3 font-semibold whitespace-nowrap" style={{ color: A.label }}>{fmt(row.total)}</td>
                    <td className="px-5 py-3 whitespace-nowrap"><Chip label={row.status} {...statusStyle} /></td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: memo ? A.green : A.orange }}>{memo?.creditMemoNo || "待贷项"}</td>
                    <td className="px-5 py-3">
                      <div className="relative flex gap-1 min-w-[96px]">
                        <button onClick={() => setSelectedReturn(row)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: A.gray6, color: A.blue }}>详情</button>
                        <button onClick={() => setOpenReturnActionId((current) => current === row.id ? null : row.id)} className="px-2 py-1 text-[11px] font-medium rounded-md flex items-center gap-1" style={{ background: A.gray6, color: A.gray1 }}>
                          更多 <MoreHorizontal size={12} />
                        </button>
                        {openReturnActionId === row.id && (
                          <div className="absolute right-0 top-7 z-30 w-32 rounded-lg p-1 shadow-lg" style={{ background: A.white, boxShadow: "0 10px 30px rgba(15,23,42,0.12)" }}>
                            <button disabled={Boolean(blockedReturnAction(row, "approve", creditMemos))} onClick={() => approve(row)} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.green }}>标记已审批</button>
                            <button disabled={Boolean(blockedReturnAction(row, "markReturned", creditMemos))} onClick={() => markReturned(row)} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.blue }}>标记已退货</button>
                            <button disabled={Boolean(blockedReturnAction(row, "generateCredit", creditMemos))} onClick={() => generateCredit(row)} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.purple }}>登记贷项通知</button>
                            <button disabled={Boolean(blockedReturnAction(row, "close", creditMemos))} onClick={() => close(row)} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.gray1 }}>关闭</button>
                            <button disabled={Boolean(blockedReturnAction(row, "reject", creditMemos))} onClick={() => reject(row)} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.red }}>驳回</button>
                            <button onClick={() => exportDetail(row)} className="w-full text-left px-2 py-1.5 rounded-md font-medium" style={{ color: A.gray1 }}>导出明细</button>
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

      <Card>
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>供应商贷项通知</h2>
            <p className="text-[11px] mt-1" style={{ color: A.sub }}>贷项通知用于关联采购退货、发票差异、应付冲减和供应商对账调整。</p>
          </div>
          <button onClick={exportCreditMemos}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg"
            style={{ background: A.gray6, color: A.blue }}>
            <FileSpreadsheet size={13} /> 导出当前结果
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                {["贷项编号", "供应商", "关联退货", "关联发票", "开具日期", "接收日期", "贷项金额", "状态", "应付冲减", "对账单", "操作"].map((header) => (
                  <th key={header} className="text-left px-5 py-3 font-medium whitespace-nowrap" style={{ color: A.gray1 }}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {creditMemos.map((memo, index) => {
                const style = toneStyle(getCreditMemoStatusTone(memo.status));
                return (
                  <tr key={memo.id} style={{ borderBottom: index < creditMemos.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className="px-5 py-3 font-semibold whitespace-nowrap" style={{ color: A.blue }}>{memo.creditMemoNo}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.label }}>{memo.supplier}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{memo.relatedReturn}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{memo.relatedInvoice || "—"}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{memo.issueDate}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{memo.receivedDate}</td>
                    <td className="px-5 py-3 font-semibold whitespace-nowrap" style={{ color: A.label }}>{fmt(memo.totalCredit)}</td>
                    <td className="px-5 py-3 whitespace-nowrap"><Chip label={memo.status} {...style} /></td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: memo.apOffsetStatus === "已冲减应付" ? A.green : A.orange }}>{memo.apOffsetStatus}</td>
                    <td className="px-5 py-3 whitespace-nowrap" style={{ color: A.sub }}>{memo.reconciliationStatement || "—"}</td>
                    <td className="px-5 py-3">
                      <div className="relative flex gap-1 min-w-[56px]">
                        <button onClick={() => setOpenCreditActionId((current) => current === memo.id ? null : memo.id)} className="px-2 py-1 text-[11px] font-medium rounded-md flex items-center gap-1" style={{ background: A.gray6, color: A.gray1 }}>
                          更多 <MoreHorizontal size={12} />
                        </button>
                        {openCreditActionId === memo.id && (
                          <div className="absolute right-0 top-7 z-30 w-32 rounded-lg p-1 shadow-lg" style={{ background: A.white, boxShadow: "0 10px 30px rgba(15,23,42,0.12)" }}>
                            <button disabled={Boolean(blockedCreditAction(memo, "confirm"))} onClick={() => updateCreditStatus(memo, { status: "已确认" }, "贷项通知已确认")} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.green }}>标记已确认</button>
                            <button disabled={Boolean(blockedCreditAction(memo, "offset"))} onClick={() => updateCreditStatus(memo, { status: "已冲减应付", apOffsetStatus: "已冲减应付" }, "已更新应付冲减状态")} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.purple }}>标记已冲减</button>
                            <button disabled={Boolean(blockedCreditAction(memo, "reject"))} onClick={() => updateCreditStatus(memo, { status: "已驳回", apOffsetStatus: "未冲减" }, "贷项通知已驳回")} className="w-full text-left px-2 py-1.5 rounded-md font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ color: A.red }}>驳回</button>
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

      <Modal open={Boolean(selectedReturn)} onClose={() => setSelectedReturn(null)} width={1180}
        title={selectedReturn?.returnNo || "采购退货 / 供应商贷项"}
        subtitle={selectedReturn ? `${selectedReturn.supplier} · ${selectedReturn.relatedPo} / ${selectedReturn.relatedGrn}` : undefined}>
        {selectedReturn && (
          <DocumentShell
            title="采购退货 / 供应商贷项"
            documentNo={selectedReturn.returnNo}
            moduleLabel="采购 / 异常处理"
            status={selectedReturn.status}
            statusTone={getReturnStatusTone(selectedReturn.status)}
            subtitle={`${selectedReturn.supplier} · ${selectedReturn.relatedPo} / ${selectedReturn.relatedGrn}${selectedReturn.relatedInvoice ? ` / ${selectedReturn.relatedInvoice}` : ""}`}
          >
            <DocumentHeader
              fields={[
                { label: "退货ID", value: selectedReturn.id },
                { label: "退货单号", value: selectedReturn.returnNo },
                { label: "供应商", value: selectedReturn.supplier, helper: selectedReturn.supplierCode || "—" },
                { label: "PO", value: selectedReturn.relatedPo },
                { label: "GRN", value: selectedReturn.relatedGrn },
                { label: "供应商发票", value: selectedReturn.relatedInvoice || "—" },
                { label: "三单匹配结果", value: selectedReturn.relatedMatchId || "—" },
                { label: "仓库", value: selectedReturn.warehouse },
                { label: "退货日期", value: selectedReturn.returnDate },
                { label: "创建日期", value: selectedReturn.createdDate },
                { label: "原因", value: selectedReturn.reason, tone: isReturnException(selectedReturn, creditMemos) ? "warning" : "neutral" },
                { label: "状态", value: selectedReturn.status, tone: getReturnStatusTone(selectedReturn.status) },
                { label: "来源", value: selectedReturn.source },
                { label: "负责人", value: selectedReturn.owner },
                { label: "贷项通知", value: selectedCredit?.creditMemoNo || selectedReturn.creditMemoId || "待贷项", tone: selectedCredit ? getCreditMemoStatusTone(selectedCredit.status) : "warning" },
              ]}
            />
            <DocumentStatusTimeline steps={returnTimeline(selectedReturn, selectedCredit)} />
            <DocumentLinesTable
              rows={selectedReturn.lines}
              columns={[
                { key: "sku", label: "SKU" },
                { key: "name", label: "品名" },
                { key: "orderedQty", label: "订购数量", align: "right" },
                { key: "receivedQty", label: "收货数量", align: "right" },
                { key: "acceptedQty", label: "合格数量", align: "right" },
                { key: "rejectedQty", label: "拒收数量", align: "right" },
                { key: "returnQty", label: "退货数量", align: "right" },
                { key: "unit", label: "单位" },
                { key: "unitPrice", label: "单价", align: "right", render: (line) => fmt(Number(line.unitPrice || 0)) },
                { key: "taxRate", label: "税率", align: "right", render: (line) => `${Math.round(Number(line.taxRate || 0) * 100)}%` },
                { key: "taxAmount", label: "税额", align: "right", render: (line) => fmt(Number(line.taxAmount || 0)) },
                { key: "totalAmount", label: "退货金额", align: "right", render: (line) => fmt(Number(line.totalAmount || 0)) },
                { key: "reason", label: "原因" },
                { key: "notes", label: "备注", render: (line) => line.notes || "—" },
              ]}
            />
            <DocumentTotals
              columns={5}
              totals={[
                { label: "退货数量", value: selectedReturn.returnQty, tone: selectedReturn.returnQty ? "warning" : "neutral" },
                { label: "未税金额", value: fmt(selectedReturn.subtotal) },
                { label: "税额", value: fmt(selectedReturn.tax) },
                { label: "退货总额", value: fmt(selectedReturn.total), tone: "purple" },
                { label: "已确认贷项", value: fmt(selectedConfirmedCredit), tone: selectedConfirmedCredit ? "success" : "neutral" },
                { label: "未冲减金额", value: fmt(selectedImpact), tone: selectedImpact ? "danger" : "success" },
              ]}
            />
            <DocumentEvidencePanel
              linkedDocuments={getPurchaseReturnLinkedDocuments(selectedReturn, purchaseOrders, receivingDocs, SUPPLIER_INVOICES, creditMemos, SUPPLIER_RECONCILIATION_STATEMENTS)}
              confidence={selectedReturn.confidence ? `${selectedReturn.confidence}%` : "—"}
              provenance={selectedReturn.source}
              notes={selectedReturn.notes || getReturnSummary(selectedReturn, creditMemos)}
              evidence={[
                { label: "退货原因", value: selectedReturn.reason, tone: isReturnException(selectedReturn, creditMemos) ? "warning" : "neutral" },
                { label: "拒收数量", value: selectedReturn.rejectedImpactQty ?? selectedReturn.lines.reduce((sum, line) => sum + line.rejectedQty, 0), tone: selectedReturn.rejectedImpactQty ? "warning" : "neutral" },
                { label: "财务影响", value: fmt(selectedImpact), tone: selectedImpact ? "danger" : "success" },
                { label: "贷项状态", value: selectedCredit?.status || "待供应商贷项", tone: selectedCredit ? getCreditMemoStatusTone(selectedCredit.status) : "warning" },
                { label: "应付冲减", value: selectedCredit?.apOffsetStatus || "未冲减", tone: selectedCredit?.apOffsetStatus === "已冲减应付" ? "success" : "warning" },
                { label: "建议动作", value: getReturnSummary(selectedReturn, creditMemos), tone: isReturnException(selectedReturn, creditMemos) ? "warning" : "success" },
              ]}
            />
            <DocumentActionBar>
              <button disabled={Boolean(blockedReturnAction(selectedReturn, "approve", creditMemos))} onClick={() => approve(selectedReturn)} className="text-xs px-3 py-1.5 rounded-lg font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: "#f0faf4", color: A.green }}>标记已审批</button>
              <button disabled={Boolean(blockedReturnAction(selectedReturn, "markReturned", creditMemos))} onClick={() => markReturned(selectedReturn)} className="text-xs px-3 py-1.5 rounded-lg font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: "#f0f6ff", color: A.blue }}>标记已退货</button>
              <button disabled={Boolean(blockedReturnAction(selectedReturn, "generateCredit", creditMemos))} onClick={() => generateCredit(selectedReturn)} className="text-xs px-3 py-1.5 rounded-lg font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: "#faf3ff", color: A.purple }}>登记贷项通知</button>
              <button disabled={Boolean(blockedReturnAction(selectedReturn, "close", creditMemos))} onClick={() => close(selectedReturn)} className="text-xs px-3 py-1.5 rounded-lg font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: A.gray6, color: A.gray1 }}>关闭异常</button>
              <button disabled={Boolean(blockedReturnAction(selectedReturn, "reject", creditMemos))} onClick={() => reject(selectedReturn)} className="text-xs px-3 py-1.5 rounded-lg font-medium disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: "#fff1f0", color: A.red }}>驳回</button>
              <button onClick={() => exportDetail(selectedReturn)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.white, color: A.blue, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>导出明细 CSV</button>
              <button onClick={() => setSelectedReturn(null)} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.white, color: A.label, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>关闭</button>
            </DocumentActionBar>
          </DocumentShell>
        )}
      </Modal>
    </div>
  );
}
