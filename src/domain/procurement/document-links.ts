import { isNoInvoiceVariance } from "./variance-types";
import type { PurchaseOrder, PurchaseRequest, PurchaseReturn, ReceivingDoc, SupplierCreditMemo, SupplierInvoice, SupplierReconciliationStatement } from "../../types/scm";
import { type DocumentTone, statusTone } from "../../components/document/DocumentShell";

export type BusinessDocumentLink = {
  label: string;
  value: string;
  moduleId?: string;
  tone?: DocumentTone;
};

function present(value?: string) {
  return value && value !== "—";
}

export function documentLinkTone(status?: string): DocumentTone {
  return statusTone(status);
}

export function getInvoiceLinkedDocuments(
  invoice: SupplierInvoice,
  purchaseOrders: PurchaseOrder[],
  receivingDocs: ReceivingDoc[]
): BusinessDocumentLink[] {
  const po = purchaseOrders.find((item) => item.po === invoice.relatedPo);
  const grn = receivingDocs.find((item) => item.grn === invoice.relatedGrn);
  return [
    po ? { label: "PO / 采购订单", value: po.po, moduleId: "purchasing", tone: documentLinkTone(po.status) } : undefined,
    grn ? { label: "GRN / 收货单", value: grn.grn, moduleId: "receiving", tone: documentLinkTone(grn.status) } : present(invoice.relatedGrn) ? { label: "GRN / 收货单", value: invoice.relatedGrn!, moduleId: "receiving", tone: "warning" as const } : undefined,
    { label: "三单匹配结果", value: invoice.matchStatus, moduleId: "procurement", tone: documentLinkTone(invoice.matchStatus) },
    invoice.postedToAp ? { label: "AP / 应付账款", value: invoice.paid ? "已付款" : `已过账应付 · ${invoice.invoiceNumber}`, moduleId: "procurement", tone: invoice.paid ? "success" as const : "purple" as const } : undefined,
  ].filter(Boolean) as BusinessDocumentLink[];
}

export function getPoLinkedDocuments(
  po: PurchaseOrder,
  supplierInvoices: SupplierInvoice[],
  receivingDocs: ReceivingDoc[],
  purchaseRequests: PurchaseRequest[] = []
): BusinessDocumentLink[] {
  const grns = receivingDocs.filter((item) => item.po === po.po);
  const invoices = supplierInvoices.filter((item) => item.relatedPo === po.po);
  const sourcePr = purchaseRequests.find((item) => item.pr === po.sourceRequest);
  return [
    po.sourceRequest ? { label: "来源 PR", value: po.sourceRequest, moduleId: "purchaseRequests", tone: documentLinkTone(sourcePr?.status) } : undefined,
    po.sourceRfq ? { label: "来源 RFQ", value: po.sourceRfq, moduleId: "rfq", tone: "info" as const } : undefined,
    ...grns.slice(0, 3).map((grn) => ({ label: "GRN / 收货单", value: grn.grn, moduleId: "receiving", tone: documentLinkTone(grn.status) })),
    ...invoices.slice(0, 3).map((invoice) => ({ label: "供应商发票", value: invoice.invoiceNumber, moduleId: "procurement", tone: documentLinkTone(invoice.status) })),
    invoices.some((invoice) => invoice.postedToAp) ? { label: "AP / 应付账款", value: "关联发票已过账", moduleId: "procurement", tone: "purple" as const } : undefined,
  ].filter(Boolean) as BusinessDocumentLink[];
}

export function getGrnLinkedDocuments(
  grn: ReceivingDoc,
  purchaseOrders: PurchaseOrder[],
  supplierInvoices: SupplierInvoice[]
): BusinessDocumentLink[] {
  const po = purchaseOrders.find((item) => item.po === grn.po);
  const invoices = supplierInvoices.filter((item) => item.relatedGrn === grn.grn || item.relatedPo === grn.po);
  return [
    po ? { label: "PO / 采购订单", value: po.po, moduleId: "purchasing", tone: documentLinkTone(po.status) } : { label: "PO / 采购订单", value: grn.po, moduleId: "purchasing", tone: "warning" },
    ...invoices.slice(0, 3).map((invoice) => ({ label: "供应商发票", value: invoice.invoiceNumber, moduleId: "procurement", tone: documentLinkTone(invoice.status) })),
    invoices.length ? { label: "三单匹配结果", value: invoices.some((invoice) => !isNoInvoiceVariance(invoice.varianceType)) ? "存在差异" : "可匹配", moduleId: "procurement", tone: invoices.some((invoice) => !isNoInvoiceVariance(invoice.varianceType)) ? "danger" as const : "success" as const } : undefined,
  ].filter(Boolean) as BusinessDocumentLink[];
}

export function getStatementLinkedDocuments(
  statement: SupplierReconciliationStatement,
  supplierInvoices: SupplierInvoice[],
  purchaseOrders: PurchaseOrder[],
  receivingDocs: ReceivingDoc[]
): BusinessDocumentLink[] {
  const invoiceNumbers = new Set(statement.lines.map((line) => line.relatedInvoice || (line.bizType === "SupplierInvoice" ? line.bizId : "")).filter(Boolean));
  const poNumbers = new Set(statement.lines.map((line) => line.relatedPo || (line.bizType === "PO" ? line.bizId : "")).filter(Boolean));
  const grnNumbers = new Set(statement.lines.map((line) => line.relatedGrn || (line.bizType === "GRN" ? line.bizId : "")).filter(Boolean));
  const invoices = supplierInvoices.filter((invoice) =>
    invoice.supplier === statement.supplier &&
    (invoiceNumbers.has(invoice.invoiceNumber) || statement.lines.some((line) => line.bizId === invoice.invoiceNumber))
  );
  const pos = purchaseOrders.filter((po) => po.supplier === statement.supplier && poNumbers.has(po.po));
  const grns = receivingDocs.filter((grn) => grn.supplier === statement.supplier && grnNumbers.has(grn.grn));
  const hasAp = statement.lines.some((line) => line.bizType === "AP" || line.bizType === "Payment");
  const hasExceptions = statement.exceptionCount > 0 || statement.totalVarianceAmount > 0 || statement.status === "存在差异" || statement.status === "已驳回";

  return [
    ...invoices.slice(0, 4).map((invoice) => ({ label: "供应商发票", value: invoice.invoiceNumber, moduleId: "procurement", tone: documentLinkTone(invoice.status) })),
    hasAp ? { label: "AP / 应付账款", value: statement.settlementStatus, moduleId: "procurement", tone: documentLinkTone(statement.settlementStatus) } : undefined,
    ...pos.slice(0, 3).map((po) => ({ label: "PO / 采购订单", value: po.po, moduleId: "purchasing", tone: documentLinkTone(po.status) })),
    ...grns.slice(0, 3).map((grn) => ({ label: "GRN / 收货单", value: grn.grn, moduleId: "receiving", tone: documentLinkTone(grn.status) })),
    { label: "三单匹配结果", value: hasExceptions ? "存在差异" : "已汇总", moduleId: "procurement", tone: hasExceptions ? "danger" as const : "success" as const },
  ].filter(Boolean) as BusinessDocumentLink[];
}

export function getPurchaseReturnLinkedDocuments(
  returnDoc: PurchaseReturn,
  purchaseOrders: PurchaseOrder[],
  receivingDocs: ReceivingDoc[],
  supplierInvoices: SupplierInvoice[],
  creditMemos: SupplierCreditMemo[],
  reconciliationStatements: SupplierReconciliationStatement[]
): BusinessDocumentLink[] {
  const po = purchaseOrders.find((item) => item.po === returnDoc.relatedPo);
  const grn = receivingDocs.find((item) => item.grn === returnDoc.relatedGrn);
  const invoice = supplierInvoices.find((item) => item.invoiceNumber === returnDoc.relatedInvoice);
  const memo = creditMemos.find((item) => item.relatedReturn === returnDoc.returnNo || item.id === returnDoc.creditMemoId || item.creditMemoNo === returnDoc.creditMemoId);
  const statement = reconciliationStatements.find((item) =>
    item.supplier === returnDoc.supplier &&
    (item.statementNo === memo?.reconciliationStatement ||
      item.lines.some((line) => line.relatedInvoice === returnDoc.relatedInvoice || line.relatedPo === returnDoc.relatedPo || line.relatedGrn === returnDoc.relatedGrn))
  );
  const hasApOffset = memo?.status === "已冲减应付" || memo?.apOffsetStatus === "已冲减应付";

  return [
    po ? { label: "PO / 采购订单", value: po.po, moduleId: "purchasing", tone: documentLinkTone(po.status) } : { label: "PO / 采购订单", value: returnDoc.relatedPo, moduleId: "purchasing", tone: "warning" },
    grn ? { label: "GRN / 收货单", value: grn.grn, moduleId: "receiving", tone: documentLinkTone(grn.status) } : { label: "GRN / 收货单", value: returnDoc.relatedGrn, moduleId: "receiving", tone: "warning" },
    invoice ? { label: "供应商发票", value: invoice.invoiceNumber, moduleId: "procurement", tone: documentLinkTone(invoice.status) } : returnDoc.relatedInvoice ? { label: "供应商发票", value: returnDoc.relatedInvoice, moduleId: "procurement", tone: "warning" } : undefined,
    returnDoc.relatedMatchId || invoice ? { label: "三单匹配结果", value: returnDoc.relatedMatchId || invoice!.matchStatus, moduleId: "procurement", tone: returnDoc.status === "已驳回" ? "danger" : documentLinkTone(invoice?.matchStatus) } : undefined,
    memo ? { label: "供应商贷项通知", value: memo.creditMemoNo, moduleId: "procurement", tone: documentLinkTone(memo.status) } : { label: "供应商贷项通知", value: "待供应商开具", moduleId: "procurement", tone: "warning" },
    hasApOffset ? { label: "AP / 应付账款", value: "贷项已冲减应付", moduleId: "procurement", tone: "purple" } : memo ? { label: "AP / 应付账款", value: memo.apOffsetStatus, moduleId: "procurement", tone: documentLinkTone(memo.apOffsetStatus) } : undefined,
    statement ? { label: "供应商对账", value: statement.statementNo, moduleId: "procurement", tone: documentLinkTone(statement.status) } : undefined,
  ].filter(Boolean) as BusinessDocumentLink[];
}
