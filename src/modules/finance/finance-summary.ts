import { AlertTriangle, CreditCard, FileText, HandCoins, ReceiptText } from "lucide-react";
import { A } from "../../components/ui";
import { PAYABLES, SUPPLIER_CREDIT_MEMOS, SUPPLIER_INVOICES, SUPPLIER_RECONCILIATION_STATEMENTS } from "../../data/empty-business-state";
import { invoiceToPayable, isInvoicePayableReady } from "../../domain/procurement/invoice-matching";
import { fmt } from "../../lib/format";

export const financePayables = [
  ...SUPPLIER_INVOICES.filter(isInvoicePayableReady).map(invoiceToPayable),
  ...PAYABLES.filter((item) => !SUPPLIER_INVOICES.some((invoice) => invoice.invoiceNumber === item.invoice)),
];

export function financeSummaryCards() {
  const openPayables = financePayables.filter((item) => item.status !== "已付款");
  const creditOffset = SUPPLIER_CREDIT_MEMOS
    .filter((memo) => ["已确认", "已冲减应付", "已关闭"].includes(memo.status))
    .reduce((sum, memo) => sum + memo.totalCredit, 0);
  const reconciliationExceptions = SUPPLIER_RECONCILIATION_STATEMENTS.filter((item) =>
    item.exceptionCount > 0 || item.totalVarianceAmount > 0 || ["存在差异", "已驳回"].includes(item.status)
  );
  const settlementReady = settlementRows().filter((row) => row.readiness === "可结算").length;

  return [
    { label: "供应商发票", value: String(SUPPLIER_INVOICES.length), sub: "发票登记与匹配状态", icon: FileText, color: A.blue },
    { label: "应付敞口", value: fmt(openPayables.reduce((sum, item) => sum + item.amount, 0)), sub: `${openPayables.length} 笔未关闭 AP`, icon: CreditCard, color: A.purple },
    { label: "贷项冲减", value: fmt(creditOffset), sub: `${SUPPLIER_CREDIT_MEMOS.length} 张贷项通知`, icon: ReceiptText, color: A.teal },
    { label: "对账异常", value: String(reconciliationExceptions.length), sub: "差异、驳回或逾期需复核", icon: AlertTriangle, color: A.orange },
    { label: "结算资料准备", value: String(settlementReady), sub: "供应商可进入资料复核", icon: HandCoins, color: A.green },
  ];
}

export function settlementRows() {
  const suppliers = Array.from(new Set([
    ...SUPPLIER_INVOICES.map((invoice) => invoice.supplier),
    ...financePayables.map((payable) => payable.supplier),
    ...SUPPLIER_CREDIT_MEMOS.map((memo) => memo.supplier),
    ...SUPPLIER_RECONCILIATION_STATEMENTS.map((statement) => statement.supplier),
  ]));

  return suppliers.map((supplier) => {
    const invoices = SUPPLIER_INVOICES.filter((invoice) => invoice.supplier === supplier);
    const payables = financePayables.filter((payable) => payable.supplier === supplier && payable.status !== "已付款");
    const credits = SUPPLIER_CREDIT_MEMOS.filter((memo) => memo.supplier === supplier);
    const reconciliation = SUPPLIER_RECONCILIATION_STATEMENTS.find((statement) => statement.supplier === supplier);
    const invoiceAmount = invoices
      .filter((invoice) => ["已审批", "已过账应付", "已付款"].includes(invoice.status) || invoice.postedToAp)
      .reduce((sum, invoice) => sum + invoice.total, 0);
    const creditAmount = credits
      .filter((memo) => ["已确认", "已冲减应付", "已关闭"].includes(memo.status))
      .reduce((sum, memo) => sum + memo.totalCredit, 0);
    const openPayable = Math.max(0, payables.reduce((sum, payable) => sum + payable.amount, 0) - creditAmount);
    const blocked = Boolean(reconciliation && (reconciliation.exceptionCount > 0 || reconciliation.totalVarianceAmount > 0 || reconciliation.status === "已驳回"));
    const hasPendingCredit = credits.some((memo) => ["草稿", "待确认", "已驳回"].includes(memo.status));
    const readiness = blocked ? "暂缓" : hasPendingCredit || openPayable > 0 ? "需复核" : "可结算";
    const nextStep = blocked
      ? "先关闭对账差异"
      : hasPendingCredit
        ? "确认贷项冲减"
        : openPayable > 0
          ? "复核 AP 余额"
          : "进入结算资料复核";

    return {
      supplier,
      invoiceAmount,
      creditAmount,
      openPayable,
      reconciliationStatus: reconciliation?.status || "待生成",
      readiness,
      owner: reconciliation?.owner || invoices[0]?.apOwner || credits[0]?.owner || "发票协同",
      nextStep,
    };
  }).sort((a, b) => b.openPayable - a.openPayable);
}

export function readinessStyle(status: string) {
  if (status === "可结算") return { color: A.green, bg: "#f0faf4" };
  if (status === "暂缓") return { color: A.red, bg: "#fff1f0" };
  return { color: A.orange, bg: "#fff8f0" };
}
