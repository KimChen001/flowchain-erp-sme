import {
  CONTRACTS,
  PORTAL_SUPPLIERS,
  PURCHASE_RETURNS,
  RFQS,
  SUPPLIER_CREDIT_MEMOS,
  SUPPLIER_INVOICES,
  SUPPLIER_RECONCILIATION_STATEMENTS,
  purchaseOrders,
  receivingDocs,
} from "../../data/empty-business-state";
import { SUPPLIER_MASTER } from "../../data/master-data";
import { fmt } from "../../lib/format";
import type { SupplierMaster } from "../../types/scm";
import { grnLinesOf } from "../receiving/helpers";
import { poLinesOf, poTotals, toNumber } from "../purchasing/helpers";

export type SupplierSrmRow = ReturnType<typeof buildSrmSupplierRows>[number];
export type SupplierRelationshipProfile = SupplierMaster & {
  legacyCode?: string;
  legacyName?: string;
  matchNames?: string[];
};

function normalizedSupplierKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function supplierRelationshipKeys(supplier: SupplierRelationshipProfile) {
  return Array.from(new Set([
    supplier.code,
    supplier.name,
    supplier.legacyCode,
    supplier.legacyName,
    ...(Array.isArray(supplier.matchNames) ? supplier.matchNames : []),
  ].map(normalizedSupplierKey).filter(Boolean)));
}

export function matchesSupplierName(value: unknown, supplier: SupplierRelationshipProfile) {
  const key = normalizedSupplierKey(value);
  return Boolean(key) && supplierRelationshipKeys(supplier).includes(key);
}

function supplierStatusLabel(supplier: SupplierRelationshipProfile, hasOperationalException: boolean) {
  if (supplier.status !== "启用") return "资料待补齐";
  if (supplier.riskStatus === "高") return "需复核";
  if (hasOperationalException) return "观察中";
  return "正常";
}

function invoiceLineQtyForPoLine(poLineId: string) {
  return SUPPLIER_INVOICES.flatMap((invoice) => invoice.lines)
    .filter((line) => line.poLine === poLineId)
    .reduce((sum, line) => sum + toNumber(line.quantity), 0);
}

function uninvoicedAmountForPurchaseOrders(pos: typeof purchaseOrders) {
  return pos.reduce((sum, po) => {
    return sum + poLinesOf(po).reduce((lineSum, line) => {
      const receivedQty = toNumber(line.quantityReceived);
      const invoicedQty = invoiceLineQtyForPoLine(line.poLineId);
      const uninvoicedQty = Math.max(0, receivedQty - invoicedQty);
      return lineSum + uninvoicedQty * toNumber(line.unitPrice);
    }, 0);
  }, 0);
}

function latestTransactionDate({
  invoices,
  grns,
  pos,
  rfqs,
}: {
  invoices: typeof SUPPLIER_INVOICES;
  grns: typeof receivingDocs;
  pos: typeof purchaseOrders;
  rfqs: typeof RFQS;
}) {
  return invoices[0]?.receivedDate || grns[0]?.arrived || pos[0]?.created || rfqs[0]?.due || "待补齐";
}

export function buildSrmSupplierRows(suppliers: SupplierRelationshipProfile[] = SUPPLIER_MASTER) {
  return suppliers.map((supplier) => {
    const supplierOperationsProfile = PORTAL_SUPPLIERS.find((item) => matchesSupplierName(item.name, supplier));
    const pos = purchaseOrders.filter((order) => matchesSupplierName(order.supplier, supplier));
    const openPoCount = pos.filter((order) => !["已完成", "已取消", "已驳回"].includes(order.status)).length;
    const grns = receivingDocs.filter((doc) => matchesSupplierName(doc.supplier, supplier));
    const rfqs = RFQS.filter((rfq) => matchesSupplierName(rfq.bestSupplier, supplier));
    const contracts = CONTRACTS.filter((contract) => matchesSupplierName(contract.supplier, supplier));
    const invoices = SUPPLIER_INVOICES.filter((invoice) => matchesSupplierName(invoice.supplier, supplier));
    const invoiceVarianceCount = invoices.filter((invoice) => invoice.varianceType !== "无差异" || ["人工复核", "差异待处理"].includes(invoice.matchStatus)).length;
    const credits = SUPPLIER_CREDIT_MEMOS.filter((memo) => matchesSupplierName(memo.supplier, supplier));
    const reconciliation = SUPPLIER_RECONCILIATION_STATEMENTS.find((statement) => matchesSupplierName(statement.supplier, supplier));
    const returns = PURCHASE_RETURNS.filter((item) => matchesSupplierName(item.supplier, supplier));
    const reconciliationException = reconciliation ? reconciliation.totalVarianceAmount > 0 || reconciliation.overdueAmount > 0 || ["存在差异", "已驳回", "待确认"].includes(reconciliation.status) : false;
    const poTotalsForSupplier = pos.map(poTotals);
    const poTotalAmount = pos.reduce((sum, order, index) => {
      const typedOrder = order as typeof order & { totalAmount?: number };
      return sum + toNumber(typedOrder.totalAmount, toNumber(order.amount, poTotalsForSupplier[index]?.totalAmount || 0));
    }, 0);
    const orderedQty = poTotalsForSupplier.reduce((sum, total) => sum + toNumber(total.totalOrderedQty), 0);
    const receivedQty = poTotalsForSupplier.reduce((sum, total) => sum + toNumber(total.totalReceivedQty), 0);
    const unreceivedQty = Math.max(0, orderedQty - receivedQty);
    const rejectedQty = grns.reduce((sum, doc) => sum + grnLinesOf(doc).reduce((lineSum, line) => lineSum + toNumber(line.rejectedQty), 0), 0);
    const invoiceTotalAmount = invoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0);
    const priceVarianceAmount = invoices.filter((invoice) => invoice.varianceType === "价格差异").reduce((sum, invoice) => sum + toNumber(invoice.varianceAmount), 0);
    const quantityVarianceAmount = invoices.filter((invoice) => invoice.varianceType === "数量差异").reduce((sum, invoice) => sum + toNumber(invoice.varianceAmount), 0);
    const receivedNotInvoicedAmount = uninvoicedAmountForPurchaseOrders(pos);
    const matchExceptionCount = invoices.filter((invoice) => invoice.matchStatus !== "自动匹配" || invoice.varianceType !== "无差异").length;
    const quoteResponseRate = rfqs.length ? Math.round(rfqs.reduce((sum, rfq) => sum + (rfq.quoted / Math.max(1, rfq.suppliers)), 0) / rfqs.length * 100) : 0;
    const invoiceMatchRate = invoices.length ? Math.round((invoices.length - matchExceptionCount) / invoices.length * 100) : 100;
    const onTimeReceiptRate = grns.length ? Math.round((grns.filter((doc) => doc.status === "已入库").length / grns.length) * 100) : supplier.onTimeRate;
    const receivingExceptionRate = grns.length ? Math.round((grns.filter((doc) => doc.status === "异常处理" || doc.failed > 0).length / grns.length) * 100) : 0;
    const hasOperationalException = invoiceVarianceCount > 0 || reconciliationException || rejectedQty > 0 || receivedNotInvoicedAmount > 0;
    const riskScore = supplier.riskStatus === "高" ? 86 : supplier.certificationStatus !== "已认证" ? 72 : invoiceVarianceCount > 0 || reconciliationException ? 66 : 42;
    const nextAction = supplier.certificationStatus !== "已认证"
      ? "复核认证资料"
      : supplier.riskStatus === "高"
        ? "制定整改计划"
        : invoiceVarianceCount > 0 || reconciliationException
          ? "复核发票与对账差异"
          : contracts.some((contract) => contract.status === "即将到期" || contract.status === "已到期")
            ? "复核合同覆盖"
            : "持续监控";
    const p2pSummary = {
      rfqCount: rfqs.length,
      quoteCount: rfqs.reduce((sum, rfq) => sum + rfq.quoted, 0),
      quoteResponseRate,
      poCount: pos.length,
      openPoCount,
      poTotalAmount,
      unreceivedQty,
      receivedQty,
      receivingExceptionCount: grns.filter((doc) => doc.status === "异常处理" || doc.failed > 0).length,
      invoiceCount: invoices.length,
      invoiceVarianceCount,
      uninvoicedAmount: receivedNotInvoicedAmount,
      receivedNotInvoicedAmount,
      matchExceptionCount,
      latestTransactionDate: latestTransactionDate({ invoices, grns, pos, rfqs }),
      invoiceTotalAmount,
      priceVarianceAmount,
      quantityVarianceAmount,
      rejectedQty,
      invoiceMatchRate,
      onTimeReceiptRate,
      receivingExceptionRate,
    };
    const riskSignals = [
      {
        name: "交期风险",
        level: unreceivedQty > 0 || openPoCount > 0 ? "中" : "低",
        evidence: `${openPoCount} 张未完成 PO，未收数量 ${unreceivedQty}`,
        impact: "可能影响生产齐套和采购跟催优先级。",
        action: unreceivedQty > 0 ? "查看相关 PO 并复核 ETA" : "持续监控交付节奏",
        limitation: "仅基于当前工作区 PO 与收货记录判断。",
      },
      {
        name: "收货异常风险",
        level: p2pSummary.receivingExceptionCount > 0 ? "高" : "低",
        evidence: `异常收货 ${p2pSummary.receivingExceptionCount} 条，拒收数量 ${rejectedQty}`,
        impact: "可能影响发票匹配和供应稳定性。",
        action: p2pSummary.receivingExceptionCount > 0 ? "查看收货异常并生成内部说明草稿" : "保持常规复核",
        limitation: "质检结论以已读取的 GRN 行为准。",
      },
      {
        name: "发票差异风险",
        level: invoiceVarianceCount > 0 ? "高" : "低",
        evidence: `差异发票 ${invoiceVarianceCount} 张，差异金额 ${fmt(priceVarianceAmount + quantityVarianceAmount)}`,
        impact: "可能延迟应付确认和供应商对账。",
        action: invoiceVarianceCount > 0 ? "查看发票差异并生成风险说明草稿" : "持续监控三单匹配",
        limitation: "不形成会计分录，仅用于采购与财务协同可见性。",
      },
      {
        name: "未响应报价风险",
        level: quoteResponseRate < 90 && rfqs.length > 0 ? "中" : "低",
        evidence: `RFQ 响应率 ${quoteResponseRate}%`,
        impact: "报价样本不足可能影响授标建议完整性。",
        action: quoteResponseRate < 90 && rfqs.length > 0 ? "复核相关 RFQ / Quote" : "保留报价表现记录",
        limitation: "仅统计当前供应商作为最佳报价方的 RFQ 记录。",
      },
      {
        name: "已收未票风险",
        level: receivedNotInvoicedAmount > 0 ? "中" : "低",
        evidence: `已收未票金额 ${fmt(receivedNotInvoicedAmount)}`,
        impact: "可能影响采购与财务协同口径。",
        action: receivedNotInvoicedAmount > 0 ? "查看未开票风险并人工复核" : "暂无明显风险",
        limitation: "金额仅用于内部复核，不自动生成应计或付款。",
      },
      {
        name: "供应集中风险",
        level: pos.length >= 3 ? "中" : "低",
        evidence: `相关 PO ${pos.length} 张，品类 ${supplier.category}`,
        impact: "关键品类依赖度较高时需要备用来源可见性。",
        action: pos.length >= 3 ? "复核替代供应和 RFQ 覆盖" : "保持供应池观察",
        limitation: "当前未接入外部市场容量数据。",
      },
      {
        name: "资料完整性风险",
        level: supplier.certificationStatus !== "已认证" ? "中" : "低",
        evidence: `认证状态 ${supplier.certificationStatus}，主档状态 ${supplier.status}`,
        impact: "资料缺口可能影响内部准入复核。",
        action: supplier.certificationStatus !== "已认证" ? "复核联系人、地址和证书资料" : "按年度复核",
        limitation: "联系人、地址和证书为只读展示。",
      },
      {
        name: "价格波动风险",
        level: priceVarianceAmount > 0 ? "中" : "低",
        evidence: `价格差异金额 ${fmt(priceVarianceAmount)}`,
        impact: "可能影响采购成本和发票匹配周期。",
        action: priceVarianceAmount > 0 ? "复核报价与发票单价差异" : "持续监控报价表现",
        limitation: "当前未接入外部行情或合同调价条款。",
      },
    ];
    return {
      supplier,
      supplierOperationsProfile,
      category: supplier.category,
      rating: supplierOperationsProfile?.rating ?? supplier.rating,
      onTimeRate: supplierOperationsProfile?.onTime ?? supplier.onTimeRate,
      qualityRate: supplierOperationsProfile?.quality ?? supplier.qualityRate,
      responseScore: supplierOperationsProfile?.resp ?? Math.round((supplier.onTimeRate + supplier.qualityRate) / 2),
      flag: supplierOperationsProfile?.flag ?? (supplier.riskStatus === "高" ? "整改" : supplier.rating >= 4.5 ? "战略" : "核心"),
      openPoCount,
      poCount: pos.length,
      grnExceptionCount: grns.filter((doc) => doc.status === "异常处理" || doc.failed > 0).length,
      rfqCount: rfqs.length,
      activeRfqCount: rfqs.filter((rfq) => ["进行中", "比价中"].includes(rfq.status)).length,
      contractCount: contracts.length,
      activeContractCount: contracts.filter((contract) => contract.status !== "已到期").length,
      invoiceVarianceCount,
      creditMemoAmount: credits.reduce((sum, memo) => sum + memo.totalCredit, 0),
      returnCount: returns.length,
      reconciliation,
      reconciliationException,
      riskScore,
      nextAction,
      operationalStatus: supplierStatusLabel(supplier, hasOperationalException),
      buyerOwner: pos[0]?.owner || reconciliation?.owner || invoices[0]?.owner || "待分配",
      relatedRfqs: rfqs,
      relatedPurchaseOrders: pos,
      relatedReceivingDocs: grns,
      relatedInvoices: invoices,
      relatedReturns: returns,
      relatedContracts: contracts,
      p2pSummary,
      riskSignals,
    };
  }).sort((a, b) => b.riskScore - a.riskScore || b.openPoCount - a.openPoCount);
}

export function srmKpis(rows = buildSrmSupplierRows()) {
  return {
    totalSuppliers: rows.length,
    highRiskSuppliers: rows.filter((row) => row.supplier.riskStatus === "高" || row.flag === "整改").length,
    certificationReview: rows.filter((row) => row.supplier.certificationStatus !== "已认证").length,
    openRfqs: RFQS.filter((rfq) => ["进行中", "比价中"].includes(rfq.status)).length,
    reconciliationOrInvoiceExceptions: rows.filter((row) => row.invoiceVarianceCount > 0 || row.reconciliationException).length,
  };
}

export function srmReportRows(rows = buildSrmSupplierRows()) {
  return rows.map((row) => ({
    供应商编码: row.supplier.code,
    供应商: row.supplier.name,
    品类: row.category,
    评级: row.rating,
    准时率: row.onTimeRate,
    质量合格率: row.qualityRate,
    响应分: row.responseScore,
    风险状态: row.supplier.riskStatus,
    认证状态: row.supplier.certificationStatus,
    开放PO: row.openPoCount,
    RFx参与: row.rfqCount,
    未完成PO: row.p2pSummary.openPoCount,
    收货异常: row.p2pSummary.receivingExceptionCount,
    已收未票金额: row.p2pSummary.receivedNotInvoicedAmount,
    最近交易日期: row.p2pSummary.latestTransactionDate,
    合同覆盖: row.activeContractCount,
    发票差异: row.invoiceVarianceCount,
    对账异常: row.reconciliationException ? "是" : "否",
    贷项金额: row.creditMemoAmount,
    下一步: row.nextAction,
  }));
}

export function supplierRiskReportRows(rows = buildSrmSupplierRows()) {
  return rows.map((row) => ({
    供应商: row.supplier.name,
    风险状态: row.supplier.riskStatus,
    SRM风险分: row.riskScore,
    战略分级: row.flag,
    准时率: row.onTimeRate,
    质量合格率: row.qualityRate,
    收货异常: row.grnExceptionCount,
    发票差异: row.invoiceVarianceCount,
    对账状态: row.reconciliation?.status || "待生成",
    风险说明: `${row.supplier.riskStatus}风险 · ${row.nextAction}`,
  }));
}

export function supplierCertificationReportRows(rows = buildSrmSupplierRows()) {
  return rows.map((row) => ({
    供应商编码: row.supplier.code,
    供应商: row.supplier.name,
    品类: row.category,
    认证状态: row.supplier.certificationStatus,
    主数据状态: row.supplier.status,
    联系人: row.supplier.contact,
    邮箱: row.supplier.email,
    付款条款: row.supplier.paymentTerms,
    默认税码: row.supplier.defaultTaxCode,
    下一步: row.supplier.certificationStatus === "已认证" ? "年度复核" : row.nextAction,
  }));
}

export function supplierDetailEvidence(row: SupplierSrmRow) {
  return [
    { label: "相关 PO", value: `${row.poCount} 单 / 开放 ${row.openPoCount}` },
    { label: "RFx 参与", value: `${row.rfqCount} 次 / 开放 ${row.activeRfqCount}` },
    { label: "合同覆盖", value: `${row.activeContractCount}/${row.contractCount}` },
    { label: "发票差异", value: row.invoiceVarianceCount },
    { label: "贷项金额", value: fmt(row.creditMemoAmount) },
    { label: "对账状态", value: row.reconciliation?.status || "待生成" },
    { label: "收货异常", value: row.grnExceptionCount },
    { label: "下一步", value: row.nextAction },
  ];
}
