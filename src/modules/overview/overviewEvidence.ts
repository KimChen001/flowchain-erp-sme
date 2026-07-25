import { fmt } from "../../lib/format";
import {
  FORECAST_SKUS,
  inventoryItems,
  PORTAL_SUPPLIERS,
  SUPPLIER_CREDIT_MEMOS,
} from "../../data/empty-business-state";
import { inventoryPlan } from "../../domain/inventory/planning";
import { INVENTORY_MOVEMENT_TYPE_LABELS, netInventoryImpact } from "../../domain/inventory/movements";
import { statementToCockpitSignal } from "../../domain/procurement/reconciliation";
import { calculateReturnFinancialImpact } from "../../domain/procurement/returns";
import { masterDataQualitySignals } from "../../domain/master-data/helpers";
import type {
  InventoryMovement,
  PurchaseOrder,
  PurchaseRequest,
  PurchaseReturn,
  ReceivingDoc,
  RfqRecord,
  SupplierInvoice,
  SupplierReconciliationStatement,
} from "../../types/scm";

export type SupplierPerformance = typeof PORTAL_SUPPLIERS[number] & {
  category?: string;
  exceptions?: number;
  rejectRate?: number;
  score?: number;
  risk?: string;
  lastIssue?: string;
};

export type EvidenceItem = {
  label: string;
  value: string | number;
};

export type EvidenceDetail = {
  id: string;
  title: string;
  priority: "高" | "中" | "低";
  object: string;
  module: string;
  moduleId: string;
  businessReason: string;
  evidence: EvidenceItem[];
  confidence?: string;
  riskScore?: string;
  suggestedAction: string;
};

export function overviewReplenishmentActions() {
  return inventoryItems
    .filter((item) => item.status !== "正常")
    .map((item) => {
      const plan = inventoryPlan(item);
      return {
        ...item,
        plan,
        shortage: Math.max(0, item.min - item.qty),
      };
    })
    .sort((a, b) => {
      const score = (item: { status: string; plan: { amount: number }; shortage: number }) =>
        (item.status === "不足" ? 1_000_000 : 0) + item.plan.amount + item.shortage * 100;
      return score(b) - score(a);
    });
}

export function safeFilenamePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "detail";
}

export function evidenceRowsForExport(detail: EvidenceDetail) {
  return detail.evidence.map((item) => ({
    对象: detail.object,
    标题: detail.title,
    优先级: detail.priority,
    模块: detail.module,
    证据项: item.label,
    证据值: item.value,
    业务原因: detail.businessReason,
    置信度或风险分: detail.confidence || detail.riskScore || "",
    建议动作: detail.suggestedAction,
  }));
}

export function buildPrEvidence(item: PurchaseRequest): EvidenceDetail {
  return {
    id: `pr-${item.pr}`,
    title: "采购申请审批证据",
    priority: item.priority,
    object: item.pr,
    module: "采购申请",
    moduleId: "procurement:requests",
    businessReason: "高优先级采购申请会影响后续 PO 下达、供应连续性和交付承诺，需要优先确认审批依据。",
    evidence: [
      { label: "PR 编号", value: item.pr },
      { label: "来源 SKU", value: item.sourceSku || item.sourceName || "—" },
      { label: "申请金额", value: fmt(Number(item.amount || 0)) },
      { label: "申请数量", value: `${Number(item.quantity || 0).toLocaleString()} ${item.unit || ""}` },
      { label: "建议供应商", value: item.supplier || "待确认" },
      { label: "申请人", value: item.requester || "—" },
      { label: "采购员", value: item.buyer || "—" },
      { label: "申请原因", value: item.reason || "等待审批" },
    ],
    confidence: "84% · 中高",
    suggestedAction: "打开采购申请，确认数量、金额和供应商后再审批。",
  };
}

export function buildPoEvidence(item: PurchaseOrder): EvidenceDetail {
  return {
    id: `po-${item.po}`,
    title: "采购订单审批证据",
    priority: item.priority,
    object: item.po,
    module: "采购订单",
    moduleId: "procurement:orders",
    businessReason: "待审批 PO 会影响供应商备料和 ETA，金额较高或优先级较高时需要尽快复核。",
    evidence: [
      { label: "PO 编号", value: item.po },
      { label: "供应商", value: item.supplier },
      { label: "状态", value: item.status },
      { label: "金额", value: fmt(item.amount) },
      { label: "ETA", value: item.eta },
      { label: "负责人", value: item.owner },
      { label: "行项数", value: item.items },
      { label: "已收货行项", value: item.received },
    ],
    confidence: "80% · 中高",
    suggestedAction: "打开采购订单，复核金额、ETA 和收货进度。",
  };
}

export function buildInventoryEvidence(item: ReturnType<typeof overviewReplenishmentActions>[number], moduleId = "inventory"): EvidenceDetail {
  return {
    id: `inventory-${item.sku}`,
    title: "库存短缺证据",
    priority: item.plan.priority,
    object: item.sku,
    module: moduleId === "forecast" ? "预测与 MRP" : "库存",
    moduleId,
    businessReason: "库存低于再订货点或覆盖天数低于采购提前期，可能影响后续生产和客户订单交付。",
    evidence: [
      { label: "SKU", value: item.sku },
      { label: "品名", value: item.name },
      { label: "当前库存", value: `${item.qty.toLocaleString()} ${item.plan.unit}` },
      { label: "可用库存", value: `${item.plan.projectedAvailable.toLocaleString()} ${item.plan.unit}` },
      { label: "安全库存", value: `${item.min.toLocaleString()} ${item.plan.unit}` },
      { label: "ROP", value: `${item.plan.reorderPoint.toLocaleString()} ${item.plan.unit}` },
      { label: "覆盖天数", value: `${item.plan.daysCover} 天` },
      { label: "建议补货量", value: `${item.plan.suggestedQty.toLocaleString()} ${item.plan.unit}` },
      { label: "预估金额", value: fmt(item.plan.amount) },
      { label: "建议供应商", value: item.plan.supplier },
      { label: "采购负责人", value: item.plan.buyer },
    ],
    confidence: "88% · 高",
    suggestedAction: item.plan.needsSourcing ? "打开 RFQ 或采购申请，先补齐报价依据。" : "打开预测与 MRP 复核，必要时生成补货 PR。",
  };
}

export function buildInventoryMovementEvidence(item: InventoryMovement): EvidenceDetail {
  const net = netInventoryImpact(item);
  return {
    id: `inventory-movement-${item.movementId}`,
    title: "库存移动异常证据",
    priority: item.status === "异常处理" || item.movementType === "CycleCountVariance" ? "高" : "中",
    object: item.movementId,
    module: "库存事务流水",
    moduleId: "inventory:movements",
    businessReason: "库存事务流水用于追踪采购入库、采购退货、需求出库、调拨、调整和盘点差异形成的库存影响，需要及时关闭待复核异常。",
    evidence: [
      { label: "移动单号", value: item.movementId },
      { label: "类型", value: INVENTORY_MOVEMENT_TYPE_LABELS[item.movementType] },
      { label: "SKU", value: item.sku },
      { label: "品名", value: item.itemName },
      { label: "仓库/库位", value: `${item.warehouse} / ${item.location}` },
      { label: "来源单据", value: item.sourceDocument },
      { label: "关联 PO", value: item.relatedPo || "—" },
      { label: "关联 GRN", value: item.relatedGrn || "—" },
      { label: "入库数量", value: `${item.quantityIn.toLocaleString()} ${item.unit}` },
      { label: "出库数量", value: `${item.quantityOut.toLocaleString()} ${item.unit}` },
      { label: "调整数量", value: `${item.adjustmentQty.toLocaleString()} ${item.unit}` },
      { label: "期末影响", value: `${net > 0 ? "+" : ""}${net.toLocaleString()} ${item.unit}` },
      { label: "状态", value: item.status },
    ],
    confidence: "86% · 规则引擎",
    suggestedAction: "打开库存事务流水，复核来源单据、数量影响和关联证据后关闭异常。",
  };
}

export function buildRfqEvidence(item: RfqRecord): EvidenceDetail {
  return {
    id: `rfq-${item.id}`,
    title: "RFQ 价格风险证据",
    priority: "中",
    object: item.id,
    module: "供应商报价",
    moduleId: "procurement:rfq",
    businessReason: "未关闭 RFQ 仍在报价或比价阶段，可能影响补货成本和供应商锁定节奏。",
    evidence: [
      { label: "RFQ 编号", value: item.id },
      { label: "标题", value: item.title },
      { label: "品类", value: item.category },
      { label: "邀请供应商数", value: item.suppliers },
      { label: "已报价供应商数", value: item.quoted },
      { label: "最优供应商", value: item.bestSupplier },
      { label: "最优报价", value: item.bestPrice },
      { label: "状态", value: item.status },
      { label: "截止日期", value: item.due },
    ],
    confidence: "78% · 中",
    suggestedAction: "打开 RFQ，复核报价差异并决定是否授标或继续询价。",
  };
}

export function buildReceivingEvidence(item: ReceivingDoc): EvidenceDetail {
  return {
    id: `grn-${item.grn}`,
    title: "收货异常证据",
    priority: item.status === "异常处理" ? "高" : "中",
    object: item.grn,
    module: "收货",
    moduleId: "procurement:receiving",
    businessReason: "待收货、质检中或异常处理的 GRN 会影响可用库存和 PO 关闭，需要跟进收货结果。",
    evidence: [
      { label: "GRN", value: item.grn },
      { label: "供应商", value: item.supplier },
      { label: "关联 PO", value: item.po },
      { label: "状态", value: item.status },
      { label: "到达时间", value: item.arrived },
      { label: "通过数", value: item.passed },
      { label: "失败数", value: item.failed },
      { label: "仓库", value: item.warehouse },
      { label: "收货员", value: item.receiver },
    ],
    riskScore: item.status === "异常处理" ? "82 / 100" : "64 / 100",
    suggestedAction: "打开收货模块，确认签收、质检或异常处理状态。",
  };
}

export function buildInvoiceEvidence(item: SupplierInvoice): EvidenceDetail {
  const priority = item.varianceType === "重复发票" || item.varianceType === "缺少收货" ? "高" : item.varianceType === "无差异" ? "低" : "中";
  return {
    id: `invoice-${item.id}`,
    title: "供应商发票匹配证据",
    priority,
    object: item.invoiceNumber,
    module: "供应商发票",
    moduleId: "procurement:invoices",
    businessReason: "供应商发票需要与采购订单和收货单一致后，才能进入审批复核、AP 可见性和结算资料准备状态。",
    evidence: [
      { label: "发票号码", value: item.invoiceNumber },
      { label: "供应商", value: item.supplier },
      { label: "PO", value: item.relatedPo || "缺少 PO" },
      { label: "GRN", value: item.relatedGrn || "缺少收货" },
      { label: "发票金额", value: fmt(item.total) },
      { label: "税额", value: fmt(item.tax) },
      { label: "运费", value: fmt(item.freight || 0) },
      { label: "差异类型", value: item.varianceType },
      { label: "差异金额", value: fmt(item.varianceAmount || 0) },
      { label: "匹配状态", value: item.matchStatus },
      { label: "发票状态", value: item.status },
      { label: "来源", value: item.source },
    ],
    confidence: `${item.confidence || 76}% · ${item.matchStatus === "自动匹配" ? "高" : "需复核"}`,
    suggestedAction: item.varianceType === "无差异" ? "打开发票协同，复核审批状态和 AP 可见性。" : "打开发票协同，复核 PO、GRN 和发票差异。",
  };
}

export function buildPurchaseReturnEvidence(item: PurchaseReturn): EvidenceDetail {
  const impact = calculateReturnFinancialImpact(item, SUPPLIER_CREDIT_MEMOS);
  const linkedCredit = SUPPLIER_CREDIT_MEMOS.find((memo) => memo.relatedReturn === item.returnNo || memo.id === item.creditMemoId || memo.creditMemoNo === item.creditMemoId);
  return {
    id: `purchase-return-${item.id}`,
    title: "采购退货 / 贷项证据",
    priority: item.status === "已驳回" || item.status === "待贷项" ? "高" : "中",
    object: item.returnNo,
    module: "采购退货 / 贷项",
    moduleId: "procurement:returns",
    businessReason: "采购退货和供应商贷项用于处理拒收、数量/价格差异、重复发票和应付冲减，避免异常发票直接进入付款。",
    evidence: [
      { label: "退货单号", value: item.returnNo },
      { label: "供应商", value: item.supplier },
      { label: "PO", value: item.relatedPo },
      { label: "GRN", value: item.relatedGrn },
      { label: "发票", value: item.relatedInvoice || "—" },
      { label: "退货原因", value: item.reason },
      { label: "退货数量", value: item.returnQty },
      { label: "退货金额", value: fmt(item.total) },
      { label: "未冲减金额", value: fmt(impact) },
      { label: "贷项通知", value: linkedCredit?.creditMemoNo || "待贷项" },
      { label: "贷项状态", value: linkedCredit?.status || "未收到" },
      { label: "退货状态", value: item.status },
    ],
    confidence: item.confidence ? `${item.confidence}% · 规则引擎` : "规则引擎",
    suggestedAction: "打开采购退货协同，复核退货、贷项和发票差异。",
  };
}

export function buildReconciliationEvidence(item: SupplierReconciliationStatement): EvidenceDetail {
  const signal = statementToCockpitSignal(item);
  return {
    id: `reconciliation-${item.id}`,
    title: "供应商对账证据",
    priority: signal.priority,
    object: item.statementNo,
    module: "供应商对账",
    moduleId: "finance:reconciliation",
    businessReason: "供应商对账单按供应商和期间汇总发票、应付、付款和差异，帮助 AP 复核未结余额、逾期应付和供应商确认结果。",
    evidence: [
      { label: "对账单号", value: item.statementNo },
      { label: "供应商", value: item.supplier },
      { label: "对账期间", value: `${item.periodStart} ~ ${item.periodEnd}` },
      { label: "应付金额", value: fmt(item.totalPayableAmount) },
      { label: "已付金额", value: fmt(item.totalPaidAmount) },
      { label: "调整金额", value: fmt(item.totalAdjustmentAmount) },
      { label: "差异金额", value: fmt(item.totalVarianceAmount) },
      { label: "未结余额", value: fmt(item.openBalance) },
      { label: "逾期金额", value: fmt(item.overdueAmount) },
      { label: "状态", value: item.status },
      { label: "结算状态", value: item.settlementStatus },
    ],
    confidence: item.confidence ? `${item.confidence}% · 规则引擎` : "规则引擎",
    suggestedAction: item.status === "已驳回" ? "打开供应商对账，复核拒绝原因、相关发票和 AP 状态。" : "打开供应商对账，复核未结余额、逾期金额和差异处理。",
  };
}

export function buildSupplierEvidence(item: SupplierPerformance): EvidenceDetail {
  const rejectRate = Number(item.rejectRate || (100 - Number(item.quality || 0)) * 0.35).toFixed(1);
  const exceptions = Number(item.exceptions || (item.flag === "整改" ? 3 : 1));
  return {
    id: `supplier-${item.name}`,
    title: "供应商风险证据",
    priority: item.flag === "整改" || exceptions > 2 ? "中" : "低",
    object: item.name,
    module: "供应商与绩效",
    moduleId: "srm:performance",
    businessReason: "供应商准时率、质量率和异常次数会影响交付承诺、收货质量和替代供应商策略。",
    evidence: [
      { label: "供应商", value: item.name },
      { label: "标签", value: item.flag || "需复核" },
      { label: "准时率", value: `${Number(item.onTime || 0).toFixed(1)}%` },
      { label: "质量率", value: `${Number(item.quality || 0).toFixed(1)}%` },
      { label: "响应分", value: Number(item.resp || 0).toFixed(0) },
      { label: "拒收率", value: `${rejectRate}%` },
      { label: "异常次数", value: exceptions },
      { label: "YTD 采购额", value: fmt(Number(item.spend || 0)) },
    ],
    confidence: "81% · 中高",
    suggestedAction: "打开供应商与绩效，复核异常记录和备选供应商。",
  };
}

export function buildForecastEvidence(inventoryRisk: ReturnType<typeof overviewReplenishmentActions>[number] | undefined): EvidenceDetail {
  const sku = FORECAST_SKUS.find((item) => item.sku === inventoryRisk?.sku) || FORECAST_SKUS[0];
  return {
    id: `forecast-${sku.sku}`,
    title: "预测 / MRP 证据",
    priority: inventoryRisk?.plan.priority || "中",
    object: sku.sku,
    module: "预测与 MRP",
    moduleId: "forecast",
    businessReason: "预测准确率和 MRP 例外共同决定是否需要释放计划订单，避免过早采购或短缺。",
    evidence: [
      { label: "SKU", value: sku.sku },
      { label: "品名", value: sku.name },
      { label: "期初库存", value: `${sku.onHand.toLocaleString()} ${sku.unit}` },
      { label: "计划入库", value: `${sku.open.toLocaleString()} ${sku.unit}` },
      { label: "预测准确率", value: "92.1%" },
      { label: "MRP 例外", value: inventoryRisk ? `${inventoryRisk.plan.priority}优先级 · ${inventoryRisk.plan.action}` : "中优先级 · 继续监控" },
      { label: "建议释放量", value: inventoryRisk ? `${inventoryRisk.plan.suggestedQty.toLocaleString()} ${inventoryRisk.plan.unit}` : "按计划复核" },
      { label: "短缺窗口", value: inventoryRisk ? `${inventoryRisk.plan.daysCover} 天覆盖` : "未来 6 期滚动检查" },
    ],
    confidence: "83% · 中高",
    suggestedAction: "打开预测与 MRP，查看预测依据、MRP 行和例外明细。",
  };
}

export function buildMasterDataEvidence(): EvidenceDetail {
  const signal = masterDataQualitySignals();
  return {
    id: "master-data-quality",
    title: "基础资料质量证据",
    priority: signal.totalIssues > 0 ? "中" : "低",
    object: "基础资料控制",
    module: "基础资料",
    moduleId: "master-data",
    businessReason: "默认税码、默认供应商和库位资料会影响采购申请、发票匹配、税额拆分、收货和库存事务处理。",
    evidence: [
      { label: "缺少默认税码", value: signal.missingTaxCode },
      { label: "缺少默认供应商", value: signal.missingSupplier },
      { label: "库位需复核", value: signal.inactiveBins },
    ],
    confidence: "规则检查",
    suggestedAction: "打开基础资料，复核物料、供应商、税码和库位维护状态。",
  };
}
