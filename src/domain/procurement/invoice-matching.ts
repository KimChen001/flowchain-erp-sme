import { invoiceVarianceCode, isInvoiceVarianceType, isNoInvoiceVariance } from "./variance-types";
import type {
  InvoiceVarianceType,
  PurchaseOrder,
  ReceivingDoc,
  SupplierInvoice,
  SupplierInvoiceMatchStatus,
  SupplierInvoiceStatus,
} from "../../types/scm";

export type InvoiceMatchSnapshot = {
  poAmount: number;
  grnAmount: number;
  invoiceAmount: number;
  varianceAmount: number;
  varianceType: InvoiceVarianceType;
  matchStatus: SupplierInvoiceMatchStatus;
  status: SupplierInvoiceStatus;
  suggestedAction: string;
};

export type InvoiceMatchQueueItem = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  po: string;
  grn: string;
  supplier: string;
  poAmt: number;
  grnAmt: number;
  invAmt: number;
  varianceType: InvoiceVarianceType;
  varianceAmount: number;
  matchStatus: SupplierInvoiceMatchStatus;
  status: SupplierInvoiceStatus;
  duplicateRisk?: boolean;
};

const AMOUNT_TOLERANCE = 1000;

function amountTolerance(reference: number) {
  return Math.min(AMOUNT_TOLERANCE, Math.abs(reference) * 0.01);
}

function poAmount(po?: PurchaseOrder) {
  return Number(po?.totalAmount ?? po?.amount ?? 0);
}

function grnAmount(invoice: SupplierInvoice, grn?: ReceivingDoc) {
  if (!grn) return 0;
  const receivedRatio = invoice.lines.reduce((sum, line) => {
    const ordered = Number(line.orderedQty || line.quantity || 0);
    const received = Number(line.receivedQty ?? line.matchedQty ?? 0);
    if (ordered <= 0) return sum + 1;
    return sum + Math.min(1, received / ordered);
  }, 0) / Math.max(1, invoice.lines.length);
  return Math.round(invoice.subtotal * receivedRatio);
}

export function calculateInvoiceMatch(
  invoice: SupplierInvoice,
  purchaseOrders: PurchaseOrder[],
  receivingDocs: ReceivingDoc[],
  allInvoices: SupplierInvoice[] = []
): InvoiceMatchSnapshot {
  const po = purchaseOrders.find((item) => item.po === invoice.relatedPo);
  const grn = invoice.relatedGrn ? receivingDocs.find((item) => item.grn === invoice.relatedGrn) : undefined;
  const duplicate = invoice.duplicateRisk || allInvoices.some((item) =>
    item.id !== invoice.id &&
    item.supplier === invoice.supplier &&
    item.invoiceNumber === invoice.invoiceNumber
  );
  const poAmt = poAmount(po);
  const grnAmt = grnAmount(invoice, grn);
  const invoiceAmount = Number(invoice.total || 0);

  let varianceType: InvoiceVarianceType = invoice.varianceType || "无差异";
  let varianceAmount = Math.abs(Number(invoice.varianceAmount || 0));
  let matchStatus: SupplierInvoiceMatchStatus = invoice.matchStatus;
  let status: SupplierInvoiceStatus = invoice.status;

  const overReceived = invoice.lines.some((line) => Number(line.quantity || 0) > Number(line.receivedQty ?? line.quantity));
  const poDelta = Math.abs(invoiceAmount - (poAmt ? poAmt * 1.13 : invoiceAmount));
  const grnMissing = !invoice.relatedGrn || !grn || grn.status === "待收货" || grn.status === "质检中";

  if (duplicate) {
    varianceType = "重复发票";
    varianceAmount = invoiceAmount;
    matchStatus = "差异待处理";
    status = "存在差异";
  } else if (!po) {
    varianceType = "缺少PO";
    varianceAmount = invoiceAmount;
    matchStatus = "差异待处理";
    status = "存在差异";
  } else if (grnMissing) {
    varianceType = "缺少收货";
    varianceAmount = invoiceAmount;
    matchStatus = invoice.matchStatus === "未匹配" ? "未匹配" : "人工复核";
    status = invoice.status === "草稿" ? "待匹配" : invoice.status;
  } else if (overReceived) {
    varianceType = "数量差异";
    varianceAmount = Math.max(varianceAmount, Math.abs(invoiceAmount - grnAmt * 1.13));
    matchStatus = "差异待处理";
    status = "存在差异";
  } else if (!isNoInvoiceVariance(varianceType) && varianceAmount > 0) {
    matchStatus = isInvoiceVarianceType(varianceType, "freight_variance") || isInvoiceVarianceType(varianceType, "tax_variance") ? "人工复核" : "差异待处理";
    status = "存在差异";
  } else if (poDelta <= amountTolerance(poAmt)) {
    varianceType = "无差异";
    varianceAmount = 0;
    matchStatus = "自动匹配";
    status = invoice.postedToAp ? invoice.status : invoice.status === "待匹配" || invoice.status === "已接收" ? "已匹配" : invoice.status;
  }

  return {
    poAmount: poAmt,
    grnAmount: grnAmt,
    invoiceAmount,
    varianceAmount,
    varianceType,
    matchStatus,
    status,
    suggestedAction: getInvoiceVarianceSummary({ ...invoice, varianceType, varianceAmount, matchStatus, status }),
  };
}

export function getInvoiceVarianceSummary(invoice: SupplierInvoice) {
  const code = invoiceVarianceCode(invoice.varianceType);
  if (code === "none") return "三单金额和数量在容差内，可进入审批或过账应付。";
  if (code === "missing_grn") return "先完成 GRN 签收/质检，再继续发票匹配。";
  if (code === "duplicate_invoice") return "存在重复发票风险，建议退回或合并附件后关闭重复项。";
  if (code === "quantity_variance") return "复核发票数量、GRN 合格数量和拒收处理。";
  if (code === "price_variance") return "复核 PO 价格、合同调价或供应商报价依据。";
  if (code === "tax_variance" || code === "freight_variance") return "由 AP 与采购复核税额/运费是否符合条款。";
  return "需要人工复核单据来源和供应商提交内容。";
}

export function invoiceToMatchQueueItem(
  invoice: SupplierInvoice,
  purchaseOrders: PurchaseOrder[],
  receivingDocs: ReceivingDoc[],
  allInvoices: SupplierInvoice[] = []
): InvoiceMatchQueueItem {
  const snapshot = calculateInvoiceMatch(invoice, purchaseOrders, receivingDocs, allInvoices);
  return {
    id: `MATCH-${invoice.id.replace(/^SI-/, "")}`,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    po: invoice.relatedPo || "—",
    grn: invoice.relatedGrn || "—",
    supplier: invoice.supplier,
    poAmt: snapshot.poAmount,
    grnAmt: snapshot.grnAmount,
    invAmt: snapshot.invoiceAmount,
    varianceType: snapshot.varianceType,
    varianceAmount: snapshot.varianceAmount,
    matchStatus: snapshot.matchStatus,
    status: snapshot.status,
    duplicateRisk: invoice.duplicateRisk,
  };
}

export function invoiceToPayable(invoice: SupplierInvoice) {
  return {
    id: `AP-${invoice.id.replace(/^SI-/, "")}`,
    supplier: invoice.supplier,
    invoice: invoice.invoiceNumber,
    amount: invoice.total,
    due: invoice.dueDate,
    aging: Math.ceil((new Date("2026-06-01").getTime() - new Date(invoice.dueDate).getTime()) / 86400000),
    terms: invoice.paymentTerms,
    status: invoice.paid ? "已付款" : "待付款",
  };
}

export function isInvoicePayableReady(invoice: SupplierInvoice) {
  return ["已审批", "已过账应付", "已付款"].includes(invoice.status) || invoice.postedToAp;
}

export function supplierInvoiceExportRows(invoices: SupplierInvoice[]) {
  return invoices.map((invoice) => ({
    发票ID: invoice.id,
    发票号码: invoice.invoiceNumber,
    供应商: invoice.supplier,
    PO: invoice.relatedPo,
    GRN: invoice.relatedGrn || "",
    发票日期: invoice.invoiceDate,
    接收日期: invoice.receivedDate,
    到期日: invoice.dueDate,
    币种: invoice.currency,
    未税金额: invoice.subtotal,
    税额: invoice.tax,
    运费: invoice.freight || 0,
    总额: invoice.total,
    付款条款: invoice.paymentTerms,
    来源: invoice.source,
    匹配状态: invoice.matchStatus,
    发票状态: invoice.status,
    差异类型: invoice.varianceType,
    差异金额: invoice.varianceAmount,
    AP负责人: invoice.apOwner,
    已过账应付: invoice.postedToAp ? "是" : "否",
    已付款: invoice.paid ? "是" : "否",
  }));
}
