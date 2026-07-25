import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Building2, Clock, FileSpreadsheet, Filter, GitBranch, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { apiJson } from "../../lib/api-client";
import { exportRowsToCsv } from "../../lib/data-export";
import { fmt } from "../../lib/format";
import { RFQS, purchaseOrders } from "../../data/empty-business-state";
import type { RfqRecord } from "../../types/scm";
import { A, Card, Chip, DocumentHistoryPanel, Field, inputStyle, KpiCard, RecoveryActions, SectionHeader } from "../../components/ui";
import ContextualImportActions from "../../components/import/ContextualImportActions";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { WorkbenchMoreMenu } from "../../components/ui/WorkbenchMoreMenu";
import type { ActiveContext } from "../ai-assistant/Panel";
import CanonicalDownstreamPanel from "../../components/procurement/CanonicalDownstreamPanel";
import {
  defaultRfqWorkbenchFilters,
  filterRfqsForWorkbench,
  rfqResponseStatus,
  type RfqWorkbenchFilters,
} from "./filters";
import {
  DetailFieldGrid,
  DetailSection,
  EvidenceSummaryPanel,
} from "../../components/business/BusinessObjectDetail";
import {
  DocumentActionBar,
  DocumentHeader,
  DocumentShell,
  DocumentStatusTimeline,
  DocumentTotals,
  statusTone,
  type TimelineStep,
} from "../../components/document/DocumentShell";
import {
  tableLinkClass,
  tableMinXlClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";

type RfqViewMode = "list" | "detail";

type RfqLineView = {
  lineId: string;
  sourcePrLine: string;
  sku: string;
  itemName: string;
  quantity: number;
  unit: string;
  needByDate: string;
  warehouse: string;
  specification: string;
  targetPrice: number;
  status: string;
};

type QuoteLineView = {
  supplier: string;
  rfqLineId: string;
  sku: string;
  quoteQty: number;
  unitPrice: number;
  amount: number;
  leadTimeDays: number;
  moq: number;
  alternateNote: string;
  risk: string;
};

type SupplierQuoteView = {
  supplier: string;
  responseStatus: string;
  responseTime: string;
  quoteTotal: number;
  currency: string;
  paymentTerms: string;
  leadTimeDays: number;
  moq: number;
  validity: string;
  risk: string;
  notes: string;
  quoteLines: QuoteLineView[];
};

type ComparisonView = {
  supplier: string;
  totalQuote: number;
  priceAdvantage: string;
  leadTime: string;
  moq: number;
  paymentTerms: string;
  riskScore: number;
  supplierRating: string;
  capacity: string;
  recommendationReason: string;
  savings: number;
  rank: number;
};

type AwardDraftView = {
  recommendedSupplier: string;
  recommendedLines: string;
  allocation: string;
  recommendedAmount: number;
  savings: number;
  reason: string;
  risk: string;
  reviewQuestions: string;
  splitAllocation: string;
  quoteSupplement: string;
  canPreviewPo: string;
};

const SOURCE_PR_BY_RFQ: Record<string, { pr: string; sku: string; name: string; quantity: number; unit: string; warehouse: string; buyer: string; created: string }> = {
  "RFQ-26-0042": { pr: "PR-2026-2408", sku: "SKU-00287", name: "铝合金型材 6063", quantity: 12000, unit: "kg", warehouse: "华东原料仓", buyer: "王志强", created: "2026-05-28" },
  "RFQ-26-0043": { pr: "PR-2026-2399", sku: "SKU-FAST-M3", name: "标准紧固件 M3-M12", quantity: 800000, unit: "件", warehouse: "标准件仓", buyer: "李婷", created: "2026-05-20" },
  "RFQ-26-0044": { pr: "PR-2026-2403", sku: "SKU-00623", name: "控制器主板 V3.2", quantity: 240, unit: "片", warehouse: "电子料仓", buyer: "陈思远", created: "2026-05-30" },
  "RFQ-26-0045": { pr: "PR-2026-2405", sku: "SKU-00744", name: "切削液 12 个月供货", quantity: 180, unit: "桶", warehouse: "MRO 备件仓", buyer: "周浩", created: "2026-05-27" },
  "RFQ-26-0046": { pr: "PR-2026-2401", sku: "SKU-00412", name: "高精度数控刀具", quantity: 120, unit: "件", warehouse: "刀具库", buyer: "李婷", created: "2026-05-31" },
};

const SUPPLIER_POOL = ["江苏铝合金集团", "佛山标准件", "深圳新元电气", "广州化工耗材", "华东精工机械", "上海仪表科技"];

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function sourceForRfq(rfq: RfqRecord) {
  const fallback = SOURCE_PR_BY_RFQ[rfq.id] || SOURCE_PR_BY_RFQ["RFQ-26-0046"];
  return {
    ...fallback,
    pr: rfq.sourceRequest || fallback.pr,
    sku: rfq.sourceSku || fallback.sku,
    name: rfq.sourceName || fallback.name,
    quantity: Number(rfq.quantity || fallback.quantity),
    unit: rfq.unit || fallback.unit,
  };
}

function buyerForRfq(rfq: RfqRecord) {
  return rfq.buyer || sourceForRfq(rfq).buyer;
}

function linkedPoForRfq(rfq: RfqRecord) {
  return rfq.linkedPo || purchaseOrders.find((order) => order.sourceRfq === rfq.id || order.sourceRequest === sourceForRfq(rfq).pr || order.supplier === rfq.bestSupplier)?.po || "";
}

function displayRfqStatus(status: string) {
  const map: Record<string, string> = {
    草稿: "草稿",
    待发送预览: "待发送",
    进行中: "等待报价",
    等待报价: "等待报价",
    比价中: "比价中",
    报价已收到: "报价已收到",
    已授标: "授标建议待复核",
    授标建议待复核: "授标建议待复核",
    已转PO: "已生成 PO 草稿",
    已关闭: "已生成 PO 草稿",
    已取消: "已取消",
  };
  return map[status] || status || "待确认";
}

function rfqStatusStyle(status: string) {
  const display = displayRfqStatus(status);
  return {
    color: display === "已生成 PO 草稿" ? A.green : display === "授标建议待复核" || display === "比价中" ? A.orange : display === "等待报价" || display === "报价已收到" ? A.blue : display === "已取消" ? A.red : A.gray1,
    bg: display === "已生成 PO 草稿" ? "rgba(52,199,89,0.1)" : display === "授标建议待复核" || display === "比价中" ? "rgba(255,149,0,0.1)" : display === "等待报价" || display === "报价已收到" ? "rgba(0,113,227,0.1)" : display === "已取消" ? "#fff1f0" : "rgba(142,142,147,0.1)",
  };
}

function nextStepForRfq(rfq: RfqRecord) {
  const display = displayRfqStatus(rfq.status);
  if (display === "草稿" || display === "待发送") return "复核 RFQ 明细";
  if (display === "等待报价") return Number(rfq.quoted || 0) >= Number(rfq.suppliers || 0) ? "进入报价比较" : "跟进未回复供应商";
  if (display === "报价已收到" || display === "比价中") return "生成授标建议草稿";
  if (display === "授标建议待复核") return "复核授标建议";
  if (display === "已生成 PO 草稿") return "跟踪采购订单";
  if (display === "已取消") return "查看取消原因";
  return "需人工复核";
}

function buildRfqLines(rfq: RfqRecord): RfqLineView[] {
  const source = sourceForRfq(rfq);
  const baseQty = Math.max(1, source.quantity);
  const basePrice = Number(rfq.bestPrice || 1);
  return [
    {
      lineId: `${rfq.id}-L1`,
      sourcePrLine: `${source.pr}-L1`,
      sku: source.sku,
      itemName: source.name,
      quantity: baseQty,
      unit: source.unit,
      needByDate: rfq.due,
      warehouse: source.warehouse,
      specification: `${rfq.category} · 需确认交期、质量和批量条件`,
      targetPrice: Math.round(basePrice * 1.08 * 100) / 100,
      status: Number(rfq.quoted || 0) > 0 ? "已有报价" : "等待报价",
    },
    {
      lineId: `${rfq.id}-L2`,
      sourcePrLine: `${source.pr}-L2`,
      sku: `${source.sku}-SPARE`,
      itemName: `${source.name} 配套件`,
      quantity: Math.max(1, Math.round(baseQty * 0.2)),
      unit: source.unit,
      needByDate: rfq.due,
      warehouse: source.warehouse,
      specification: "配套件需与主物料同批次交付",
      targetPrice: Math.round(basePrice * 0.42 * 100) / 100,
      status: Number(rfq.quoted || 0) >= Number(rfq.suppliers || 0) ? "报价齐套" : "需补充报价",
    },
  ];
}

function invitedSuppliersForRfq(rfq: RfqRecord) {
  return unique([rfq.bestSupplier, ...(rfq.invitedSuppliers || []), ...SUPPLIER_POOL]).slice(0, Math.max(1, Number(rfq.suppliers || 3)));
}

function buildSupplierQuotes(rfq: RfqRecord): SupplierQuoteView[] {
  const lines = buildRfqLines(rfq);
  const suppliers = invitedSuppliersForRfq(rfq);
  const respondedCount = Math.min(Number(rfq.quoted || 0), suppliers.length);
  const factors = [1, 1.07, 1.13, 0.96, 1.18, 1.22, 1.05, 1.15];
  return suppliers.map((supplier, index) => {
    const responded = index < respondedCount;
    const factor = factors[index % factors.length];
    const leadTimeDays = responded ? 7 + index * 3 : 0;
    const moq = responded ? Math.max(1, Math.round(lines[0].quantity * (0.25 + index * 0.05))) : 0;
    const quoteLines = lines.map((line, lineIndex) => {
      const unitPrice = responded ? Math.round(line.targetPrice * factor * (lineIndex === 0 ? 1 : 0.95) * 100) / 100 : 0;
      return {
        supplier,
        rfqLineId: line.lineId,
        sku: line.sku,
        quoteQty: responded ? line.quantity : 0,
        unitPrice,
        amount: Math.round(line.quantity * unitPrice * 100) / 100,
        leadTimeDays,
        moq,
        alternateNote: responded && index === 1 ? "可提供等效替代料，需工程确认" : "按需求物料报价",
        risk: responded ? (index === 0 ? "风险较低" : index === 1 ? "交期需复核" : "条款需确认") : "尚未响应",
      };
    });
    const quoteTotal = quoteLines.reduce((sum, line) => sum + line.amount, 0);
    return {
      supplier,
      responseStatus: responded ? (index === 1 ? "需补充条款" : "已响应") : "未响应",
      responseTime: responded ? `2026-06-${String(3 + index).padStart(2, "0")} 10:${String(index * 7).padStart(2, "0")}` : "待响应",
      quoteTotal,
      currency: "CNY",
      paymentTerms: responded ? (index === 0 ? "Net 45" : index === 1 ? "Net 30" : "预付 30% / 到货 70%") : "待确认",
      leadTimeDays,
      moq,
      validity: responded ? "2026-07-15" : "待确认",
      risk: responded ? (index === 0 ? "价格与交期均衡" : index === 1 ? "条款和替代料需复核" : "供应能力需复核") : "未响应影响比较完整性",
      notes: responded ? "报价已进入内部比价视图，需负责人复核。" : "需要采购负责人补充报价或调整供应商范围。",
      quoteLines,
    };
  });
}

function buildComparisonRows(rfq: RfqRecord): ComparisonView[] {
  const responded = buildSupplierQuotes(rfq).filter((quote) => quote.responseStatus !== "未响应");
  const maxQuote = Math.max(...responded.map((quote) => quote.quoteTotal), Number(rfq.bestPrice || 0));
  return responded
    .map((quote) => {
      const riskScore = quote.risk.includes("低") || quote.risk.includes("均衡") ? 18 : quote.risk.includes("条款") ? 42 : 58;
      return {
        supplier: quote.supplier,
        totalQuote: quote.quoteTotal,
        priceAdvantage: quote.quoteTotal <= Math.min(...responded.map((item) => item.quoteTotal)) ? "价格领先" : "价格偏高",
        leadTime: `${quote.leadTimeDays} 天`,
        moq: quote.moq,
        paymentTerms: quote.paymentTerms,
        riskScore,
        supplierRating: riskScore <= 25 ? "A" : riskScore <= 45 ? "B+" : "B",
        capacity: quote.leadTimeDays <= 10 ? "可承诺" : "需确认产能",
        recommendationReason: quote.supplier === rfq.bestSupplier ? "价格、交期与供应风险综合最优" : quote.leadTimeDays <= 10 ? "可作为拆分分配备选" : "需补充交期承诺",
        savings: Math.max(0, Math.round((maxQuote - quote.quoteTotal) * 100) / 100),
        rank: 0,
      };
    })
    .sort((a, b) => a.totalQuote - b.totalQuote || a.riskScore - b.riskScore)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function buildAwardDraft(rfq: RfqRecord): AwardDraftView {
  const comparison = buildComparisonRows(rfq);
  const top = comparison[0];
  const second = comparison[1];
  const lines = buildRfqLines(rfq);
  const responded = Number(rfq.quoted || 0);
  const supplierText = top?.supplier || rfq.bestSupplier || "待推荐";
  return {
    recommendedSupplier: supplierText,
    recommendedLines: lines.map((line) => line.lineId).join(" / "),
    allocation: second ? `${supplierText} 70%，${second.supplier} 30%` : `${supplierText} 100%`,
    recommendedAmount: top?.totalQuote || 0,
    savings: top?.savings || 0,
    reason: top?.recommendationReason || "等待完整报价后生成建议",
    risk: second ? "建议保留拆分分配，降低单一供应风险。" : "报价覆盖不足，需人工复核供应商范围。",
    reviewQuestions: "MOQ、付款条款、交期承诺和替代料是否满足生产节奏。",
    splitAllocation: second ? "建议拆分分配" : "暂不建议拆分",
    quoteSupplement: responded < Number(rfq.suppliers || 0) ? "建议先补充未响应报价" : "报价已满足内部比较",
    canPreviewPo: responded >= 2 ? "报价条件已满足" : "需补充报价",
  };
}

function estimatedAmountForRfq(rfq: RfqRecord) {
  const source = sourceForRfq(rfq);
  const lines = buildRfqLines(rfq);
  return Math.round(lines.reduce((sum, line) => sum + line.quantity * line.targetPrice, 0) || source.quantity * Number(rfq.bestPrice || 0));
}

function rfqTimeline(rfq: RfqRecord): TimelineStep[] {
  const display = displayRfqStatus(rfq.status);
  const responded = Number(rfq.quoted || 0);
  const suppliers = Number(rfq.suppliers || 0);
  const comparisonReady = responded > 0;
  const awardReady = display === "授标建议待复核" || display === "已生成 PO 草稿";
  const poReady = display === "已生成 PO 草稿";
  return [
    { label: "RFQ 草稿", status: display === "草稿" ? "current" : "done", helper: sourceForRfq(rfq).created },
    { label: "报价收集", status: suppliers > responded ? "current" : "done", helper: `${responded}/${suppliers} 家响应` },
    { label: "报价比较", status: comparisonReady ? (awardReady ? "done" : "current") : "pending" },
    { label: "授标建议草稿", status: awardReady ? (poReady ? "done" : "current") : "pending" },
    { label: "采购订单", status: poReady ? "done" : "pending", helper: linkedPoForRfq(rfq) || "尚未创建" },
  ];
}

function labelDataLimitation(item: string) {
  const map: Record<string, string> = {
    workspace_only: "当前仅基于工作区内 PR、RFQ、供应商报价和采购记录判断。",
    quote_partial: "部分供应商报价尚未响应，授标建议需人工复核。",
    external_sourcing_closed: "当前不进入外部寻源流程，不触达供应商，不形成授标结果。",
    po_preview_only: "PO 草稿仅为预览，不会创建正式采购订单。",
    contract_quality_partial: "当前未读取完整合同、质量和历史履约记录。",
  };
  return map[item] || item;
}

export default function PurchasingRFQPage({
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (moduleId: string) => void;
  onActiveContextChange?: (context: ActiveContext | null) => void;
}) {
  if (!focus) return <CanonicalDownstreamPanel kind="rfqs" />;
  const enrichBuyer = (rfq: RfqRecord): RfqRecord => ({ ...rfq, buyer: rfq.buyer || (SOURCE_PR_BY_RFQ[rfq.id] || SOURCE_PR_BY_RFQ["RFQ-26-0046"]).buyer });
  const [rfqs, setRfqs] = useState<RfqRecord[]>(() => RFQS.map(enrichBuyer));
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(RFQS[0]?.id ?? "");
  const [viewMode, setViewMode] = useState<RfqViewMode>("list");
  const [, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<RfqWorkbenchFilters>(() => Object.fromEntries(Object.entries(defaultRfqWorkbenchFilters).map(([key, fallback]) => [key, new URLSearchParams(window.location.search).get(key) || fallback])) as RfqWorkbenchFilters);
  const [moreFilters, setMoreFilters] = useState(false);

  useEffect(() => {
    let alive = true;
    apiJson<RfqRecord[]>("/api/rfqs")
      .then((data) => {
        if (!alive) return;
        setRfqs(data.map(enrichBuyer));
        setSelectedId((current) => data.some((item) => item.id === current) ? current : data[0]?.id ?? "");
      })
      .catch(() => toast.error("RFQ 服务暂不可用", { description: "已显示当前询价快照" }))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (focus?.entityType !== "rfq" || !focus.entityId) return;
    if (!rfqs.some((item) => item.id === focus.entityId)) return;
    setSelectedId(focus.entityId);
    setViewMode("detail");
  }, [focus?.at, focus?.entityType, focus?.entityId, rfqs]);

  const filtered = filterRfqsForWorkbench(rfqs, filters);
  const selectedRfq = rfqs.find((item) => item.id === selectedId) ?? filtered[0] ?? rfqs[0] ?? null;
  const statusOptions = Array.from(new Set(rfqs.map((item) => item.status).filter(Boolean))).sort();

  useEffect(() => {
    if (viewMode !== "detail" || !selectedRfq) {
      onActiveContextChange?.(null);
      return;
    }
    onActiveContextChange?.({
      module: "procurement",
      entityType: "rfq",
      entityId: selectedRfq.id,
      entityLabel: selectedRfq.title || selectedRfq.id,
      view: "rfqs",
    });
    return () => onActiveContextChange?.(null);
  }, [viewMode, selectedRfq?.id, selectedRfq?.title, onActiveContextChange]);

  const exportCsv = () => {
    if (filtered.length === 0) {
      toast.warning("暂无可导出的数据");
      return;
    }
    exportRowsToCsv("procurement-rfq-export.csv", filtered.map((rfq) => ({
      RFQ编号: rfq.id,
      标题: rfq.title,
      品类: rfq.category,
      供应商数量: rfq.suppliers,
      报价响应数量: rfq.quoted,
      报价状态: rfqResponseStatus(rfq),
      推荐供应商: rfq.bestSupplier,
      截止日期: rfq.due,
      状态: displayRfqStatus(rfq.status),
      来源申请: sourceForRfq(rfq).pr,
      来源SKU: sourceForRfq(rfq).sku,
      关联PO草稿: linkedPoForRfq(rfq),
    })));
    toast.success("导出文件已生成");
  };

  function updateFilter<K extends keyof RfqWorkbenchFilters>(key: K, value: RfqWorkbenchFilters[K]) {
    const updated = { ...filters, [key]: value };
    setFilters(updated);
    const next = new URLSearchParams();
    Object.entries(updated).forEach(([filterKey, filterValue]) => { if (filterValue !== defaultRfqWorkbenchFilters[filterKey as keyof RfqWorkbenchFilters]) next.set(filterKey, String(filterValue)); });
    setSearchParams(next, { replace: true });
  }

  function resetFilters() {
    setFilters(defaultRfqWorkbenchFilters);
    setSearchParams({}, { replace: true });
  }

  function openDetail(id: string) {
    setSelectedId(id);
    setViewMode("detail");
  }

  function returnToList() {
    setViewMode("list");
  }

  function returnToSourcePr() {
    onNavigate?.("procurement:requests");
  }

  const detailContent = selectedRfq && (() => {
    const source = sourceForRfq(selectedRfq);
    const rfqLines = buildRfqLines(selectedRfq);
    const supplierQuotes = buildSupplierQuotes(selectedRfq);
    const quoteLines = supplierQuotes.flatMap((quote) => quote.quoteLines);
    const comparison = buildComparisonRows(selectedRfq);
    const awardDraft = buildAwardDraft(selectedRfq);
    const linkedPo = linkedPoForRfq(selectedRfq);
    const statusStyle = rfqStatusStyle(selectedRfq.status);
    return (
      <DocumentShell
        title="RFQ / 寻源对象"
        documentNo={selectedRfq.id}
        moduleLabel="寻源 / RFx"
        status={displayRfqStatus(selectedRfq.status)}
        statusTone={statusTone(displayRfqStatus(selectedRfq.status))}
        subtitle={`${selectedRfq.title} · ${source.sku}`}
        actions={
          <RecoveryActions
            actions={[
              { key: "source-pr", label: "返回来源 PR", onClick: returnToSourcePr, kind: "module", tone: "subtle" },
              { key: "rfq-list", label: "返回 RFQ 列表", onClick: returnToList, kind: "list" },
              { key: "module", label: "返回采购工作台", onClick: () => onNavigate?.("procurement"), kind: "module", tone: "subtle" },
              { key: "back", label: "返回上一级", onClick: returnToList, kind: "list", tone: "subtle" },
            ]}
          />
        }
      >
        <DocumentHeader
          fields={[
            { label: "RFQ 编号", value: selectedRfq.id, tone: "info" },
            { label: "标题", value: selectedRfq.title },
            { label: "来源 PR", value: source.pr, tone: "info" },
            { label: "状态", value: displayRfqStatus(selectedRfq.status), tone: statusTone(displayRfqStatus(selectedRfq.status)) },
            { label: "采购负责人", value: buyerForRfq(selectedRfq) },
            { label: "报价截止日期", value: selectedRfq.due, tone: Number(selectedRfq.quoted || 0) < Number(selectedRfq.suppliers || 0) ? "warning" : "success" },
            { label: "供应商数量", value: selectedRfq.suppliers },
            { label: "报价响应数量", value: selectedRfq.quoted, tone: Number(selectedRfq.quoted || 0) < Number(selectedRfq.suppliers || 0) ? "warning" : "success" },
          ]}
        />
        <DetailSection title="概览" right={<Chip label="轻量寻源对象" color={statusStyle.color} bg={statusStyle.bg} />}>
          <DetailFieldGrid fields={[
            { label: "RFQ 编号", value: selectedRfq.id, tone: "info" },
            { label: "状态", value: displayRfqStatus(selectedRfq.status), tone: displayRfqStatus(selectedRfq.status) === "等待报价" ? "warning" : "good" },
            { label: "标题", value: selectedRfq.title },
            { label: "来源 PR", value: source.pr, tone: "info" },
            { label: "来源 PR Line", value: `${source.pr}-L1` },
            { label: "采购负责人", value: buyerForRfq(selectedRfq) },
            { label: "创建日期", value: source.created },
            { label: "报价截止日期", value: selectedRfq.due },
            { label: "目标仓库", value: source.warehouse },
            { label: "采购品类", value: selectedRfq.category },
            { label: "供应商数量", value: selectedRfq.suppliers },
            { label: "已响应供应商数量", value: selectedRfq.quoted, tone: Number(selectedRfq.quoted || 0) < Number(selectedRfq.suppliers || 0) ? "warning" : "good" },
            { label: "预计金额", value: fmt(estimatedAmountForRfq(selectedRfq)), tone: "info" },
            { label: "当前下一步", value: nextStepForRfq(selectedRfq), tone: "info" },
          ]} />
        </DetailSection>
        <DocumentStatusTimeline steps={rfqTimeline(selectedRfq)} />
        <DetailSection title="RFQ 明细行" right={<Chip label={`${rfqLines.length} 行`} color={A.blue} bg="#f0f6ff" />}>
          <div className={tableScrollClass}>
            <table className={tableMinXlClass}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                  {["RFQ Line 编号", "来源 PR Line", "SKU", "物料名称", "数量", "单位", "需求日期", "目标仓库", "技术规格 / 备注", "目标价格", "行状态"].map((header) => (
                    <th key={header} className={thClass} style={{ color: A.gray1 }}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rfqLines.map((line, index) => (
                  <tr key={line.lineId} style={{ borderBottom: index < rfqLines.length - 1 ? `1px solid ${A.border}` : "none" }}>
                    <td className={tdIdClass} style={{ color: A.blue }}>{line.lineId}</td>
                    <td className={tdIdClass}>{line.sourcePrLine}</td>
                    <td className={tdNowrapClass} style={{ color: A.blue }}>{line.sku}</td>
                    <td className={tdNameClass}>{line.itemName}</td>
                    <td className={tdNumericClass}>{line.quantity.toLocaleString()}</td>
                    <td className={tdNowrapClass}>{line.unit}</td>
                    <td className={tdNowrapClass}>{line.needByDate}</td>
                    <td className={tdNowrapClass}>{line.warehouse}</td>
                    <td className={tdNameClass}>{line.specification}</td>
                    <td className={tdNumericClass}>{fmt(line.targetPrice)}</td>
                    <td className={tdNowrapClass}><Chip label={line.status} color={line.status.includes("需") ? A.orange : A.green} bg={line.status.includes("需") ? "#fff8f0" : "#f0faf4"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
        <DetailSection title="供应商报价" right={<Chip label={`${selectedRfq.quoted}/${selectedRfq.suppliers} 家响应`} color={Number(selectedRfq.quoted || 0) < Number(selectedRfq.suppliers || 0) ? A.orange : A.green} bg={Number(selectedRfq.quoted || 0) < Number(selectedRfq.suppliers || 0) ? "#fff8f0" : "#f0faf4"} />}>
          <div className={tableScrollClass}>
            <table className={tableMinXlClass}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                  {["供应商", "响应状态", "响应时间", "报价总额", "币种", "付款条款", "交期", "MOQ", "有效期", "风险提示", "备注"].map((header) => (
                    <th key={header} className={thClass} style={{ color: A.gray1 }}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {supplierQuotes.map((quote, index) => (
                  <tr key={quote.supplier} style={{ borderBottom: index < supplierQuotes.length - 1 ? `1px solid ${A.border}` : "none" }}>
                    <td className={tdNameClass} style={{ color: A.label }}>{quote.supplier}</td>
                    <td className={tdNowrapClass}><Chip label={quote.responseStatus} color={quote.responseStatus === "未响应" ? A.orange : A.green} bg={quote.responseStatus === "未响应" ? "#fff8f0" : "#f0faf4"} /></td>
                    <td className={tdNowrapClass}>{quote.responseTime}</td>
                    <td className={tdNumericClass}>{quote.quoteTotal ? fmt(quote.quoteTotal) : "待确认"}</td>
                    <td className={tdNowrapClass}>{quote.currency}</td>
                    <td className={tdNowrapClass}>{quote.paymentTerms}</td>
                    <td className={tdNowrapClass}>{quote.leadTimeDays ? `${quote.leadTimeDays} 天` : "待确认"}</td>
                    <td className={tdNumericClass}>{quote.moq || "待确认"}</td>
                    <td className={tdNowrapClass}>{quote.validity}</td>
                    <td className={tdNameClass}>{quote.risk}</td>
                    <td className={tdNameClass}>{quote.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={`${tableScrollClass} mt-3`}>
            <table className={tableMinXlClass}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                  {["报价行编号", "供应商", "RFQ Line", "SKU", "报价数量", "报价单价", "报价金额", "交期天数", "MOQ", "替代料提示", "行级风险"].map((header) => (
                    <th key={header} className={thClass} style={{ color: A.gray1 }}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quoteLines.map((line, index) => (
                  <tr key={`${line.supplier}-${line.rfqLineId}`} style={{ borderBottom: index < quoteLines.length - 1 ? `1px solid ${A.border}` : "none" }}>
                    <td className={tdIdClass}>{`${line.rfqLineId}-Q${index + 1}`}</td>
                    <td className={tdNameClass}>{line.supplier}</td>
                    <td className={tdIdClass}>{line.rfqLineId}</td>
                    <td className={tdNowrapClass} style={{ color: A.blue }}>{line.sku}</td>
                    <td className={tdNumericClass}>{line.quoteQty || "待确认"}</td>
                    <td className={tdNumericClass}>{line.unitPrice ? fmt(line.unitPrice) : "待确认"}</td>
                    <td className={tdNumericClass}>{line.amount ? fmt(line.amount) : "待确认"}</td>
                    <td className={tdNumericClass}>{line.leadTimeDays || "待确认"}</td>
                    <td className={tdNumericClass}>{line.moq || "待确认"}</td>
                    <td className={tdNameClass}>{line.alternateNote}</td>
                    <td className={tdNameClass}>{line.risk}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
        <DetailSection title="报价比较" right={<Chip label="比价矩阵" color={A.blue} bg="#f0f6ff" />}>
          <div className={tableScrollClass}>
            <table className={tableMinXlClass}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                  {["排名", "供应商", "总报价", "单价优势", "交期", "MOQ", "付款条款", "风险评分", "供应商评级", "供应能力", "推荐理由", "节省金额"].map((header) => (
                    <th key={header} className={thClass} style={{ color: A.gray1 }}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.map((row, index) => (
                  <tr key={row.supplier} style={{ borderBottom: index < comparison.length - 1 ? `1px solid ${A.border}` : "none" }}>
                    <td className={tdNumericClass}>{row.rank}</td>
                    <td className={tdNameClass} style={{ color: row.rank === 1 ? A.green : A.label }}>{row.supplier}</td>
                    <td className={tdNumericClass}>{fmt(row.totalQuote)}</td>
                    <td className={tdNowrapClass}>{row.priceAdvantage}</td>
                    <td className={tdNowrapClass}>{row.leadTime}</td>
                    <td className={tdNumericClass}>{row.moq}</td>
                    <td className={tdNowrapClass}>{row.paymentTerms}</td>
                    <td className={tdNumericClass} style={{ color: row.riskScore <= 25 ? A.green : row.riskScore <= 45 ? A.orange : A.red }}>{row.riskScore}</td>
                    <td className={tdNowrapClass}>{row.supplierRating}</td>
                    <td className={tdNowrapClass}>{row.capacity}</td>
                    <td className={tdNameClass}>{row.recommendationReason}</td>
                    <td className={tdNumericClass} style={{ color: A.green }}>{fmt(row.savings)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
        <DetailSection title="授标建议草稿" right={<Chip label="需人工复核" color={A.orange} bg="#fff8f0" />}>
          <DetailFieldGrid fields={[
            { label: "推荐供应商", value: awardDraft.recommendedSupplier, tone: "good" },
            { label: "推荐 RFQ 明细行", value: awardDraft.recommendedLines },
            { label: "推荐分配比例", value: awardDraft.allocation, tone: awardDraft.splitAllocation.includes("建议") ? "warning" : "default" },
            { label: "推荐金额", value: fmt(awardDraft.recommendedAmount), tone: "info" },
            { label: "预计节省金额", value: fmt(awardDraft.savings), tone: "good" },
            { label: "推荐理由", value: awardDraft.reason },
            { label: "风险提示", value: awardDraft.risk, tone: "warning" },
            { label: "需要人工复核的问题", value: awardDraft.reviewQuestions, tone: "warning" },
            { label: "是否建议拆分分配", value: awardDraft.splitAllocation },
            { label: "是否建议先补充报价", value: awardDraft.quoteSupplement, tone: awardDraft.quoteSupplement.includes("补充") ? "warning" : "good" },
            { label: "后续处理", value: linkedPo ? "已创建采购订单" : "尚未创建采购订单", tone: linkedPo ? "good" : "warning" },
          ]} columns={3} />
        </DetailSection>
        <DetailSection title="关联单据">
          <DetailFieldGrid fields={[
            { label: "来源 PR", value: source.pr, tone: "info" },
            { label: "来源 PR Line", value: `${source.pr}-L1 / ${source.pr}-L2` },
            { label: "来源 SKU", value: source.sku },
            { label: "采购订单", value: linkedPo || "尚未创建", tone: linkedPo ? "good" : "warning" },
            { label: "业务链", value: `${source.pr} → ${selectedRfq.id}${linkedPo ? ` → ${linkedPo}` : ""}`, tone: "info" },
          ]} columns={3} />
        </DetailSection>
        <DocumentHistoryPanel
          entityType="rfq"
          entityId={selectedRfq.id}
          title="历史记录"
          refreshKey={selectedRfq.lastAuditId || selectedRfq.auditTrailIds?.join(",") || selectedRfq.status}
        />
        <EvidenceSummaryPanel groups={[
          { label: "PR / RFQ", value: `${source.pr} 的 ${source.sku} 需求进入 ${selectedRfq.id}，用于报价收集和比价。`, tone: "info" },
          { label: "供应商报价", value: `${selectedRfq.quoted}/${selectedRfq.suppliers} 家供应商已响应，未响应报价会影响推荐完整性。`, tone: Number(selectedRfq.quoted || 0) < Number(selectedRfq.suppliers || 0) ? "warning" : "good" },
          { label: "报价比较", value: comparison[0] ? `${comparison[0].supplier} 当前排名第一，节省金额 ${fmt(comparison[0].savings)}。` : "等待报价后生成比较。", tone: comparison[0] ? "good" : "warning" },
        ]} />
        <DocumentTotals
          totals={[
            { label: "RFQ 行数", value: rfqLines.length },
            { label: "供应商数量", value: selectedRfq.suppliers },
            { label: "报价响应数量", value: selectedRfq.quoted, tone: Number(selectedRfq.quoted || 0) < Number(selectedRfq.suppliers || 0) ? "warning" : "success" },
            { label: "推荐金额", value: fmt(awardDraft.recommendedAmount), tone: "info" },
            { label: "预计节省", value: fmt(awardDraft.savings), tone: "success" },
          ]}
          columns={5}
        />
        <DocumentActionBar>
          <RecoveryActions
            actions={[
              { key: "rfq-list-bottom", label: "返回 RFQ 列表", onClick: returnToList, kind: "list" },
            ]}
          />
          <button onClick={exportCsv} className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: A.white, color: A.blue, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>导出详情</button>
        </DocumentActionBar>
      </DocumentShell>
    );
  })();

  if (viewMode === "detail") {
    return (
      <div className="space-y-4">
        {selectedRfq ? detailContent : (
          <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }}>
            未找到 RFQ。
            <button onClick={returnToList} className="ml-3 px-3 py-1.5 rounded-lg font-medium" style={{ background: A.gray6, color: A.blue }}>返回列表</button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CanonicalDownstreamPanel kind="rfqs" />
      <div className="grid grid-cols-4 gap-3">
        <KpiCard label="活动询价" value={String(rfqs.length)} sub={loading ? "加载中" : "近 30 天"} delta="+2" positive icon={FileSpreadsheet} color={A.blue} />
        <KpiCard label="参与供应商" value={String(rfqs.reduce((a, b) => a + b.suppliers, 0))} sub="累计范围" icon={Building2} color={A.purple} />
        <KpiCard label="预计节省" value={fmt(124800)} sub="草稿测算" delta="+18%" positive icon={TrendingUp} color={A.green} />
        <KpiCard label="平均周期" value="4.8 天" sub="RFQ → 建议草稿" delta="-1.2d" positive icon={Clock} color={A.teal} />
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <SectionHeader title="询价与报价" />
            <div className="text-xs mt-1" style={{ color: A.sub }}>按 RFQ、供应商、物料、状态、报价状态和截止日期查询询价记录</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setMoreFilters((value) => !value)} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.blue }}>更多筛选</button>
            <button onClick={resetFilters}
              className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.label }}>重置</button>
            <button onClick={exportCsv}
              className="h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5" style={{ background: "#f0f6ff", color: A.blue }}>
              <FileSpreadsheet size={13} /> 导出当前结果
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="搜索 RFQ / SKU / 标题"><input value={filters.query} onChange={(event) => updateFilter("query", event.target.value)} placeholder="RFQ、SKU 或标题" style={inputStyle} /></Field>
          <Field label="状态"><select value={filters.status} onChange={(event) => updateFilter("status", event.target.value)} style={inputStyle}><option value="全部">全部</option>{statusOptions.map((status) => <option key={status} value={status}>{displayRfqStatus(status)}</option>)}</select></Field>
          <Field label="报价状态"><select value={filters.responseStatus} onChange={(event) => updateFilter("responseStatus", event.target.value as RfqWorkbenchFilters["responseStatus"])} style={inputStyle}>{(["全部", "未报价", "部分报价", "已报价"] as const).map((status) => <option key={status} value={status}>{status}</option>)}</select></Field>
          <Field label="截止日期"><input type="date" value={filters.dueTo} onChange={(event) => updateFilter("dueTo", event.target.value)} style={inputStyle} /></Field>
        </div>
        {moreFilters && <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6"><Field label="来源 PR"><input value={filters.sourceRequest} onChange={(event) => updateFilter("sourceRequest", event.target.value)} style={inputStyle} /></Field><Field label="供应商"><input value={filters.supplier} onChange={(event) => updateFilter("supplier", event.target.value)} style={inputStyle} /></Field><Field label="品类"><input value={filters.category} onChange={(event) => updateFilter("category", event.target.value)} style={inputStyle} /></Field><Field label="采购负责人"><input value={filters.buyer} onChange={(event) => updateFilter("buyer", event.target.value)} style={inputStyle} /></Field><Field label="截止日期起"><input type="date" value={filters.dueFrom} onChange={(event) => updateFilter("dueFrom", event.target.value)} style={inputStyle} /></Field><Field label="截止日期止"><input type="date" value={filters.dueTo} onChange={(event) => updateFilter("dueTo", event.target.value)} style={inputStyle} /></Field></div>}
      </Card>

      <Card>
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: A.label }}>询价与报价</h2>
            <p className="text-[11px] mt-1" style={{ color: A.sub }}>
              共 {rfqs.length} 条，当前筛选 {filtered.length} 条 RFQ。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs flex items-center gap-1.5" style={{ color: A.gray2 }}><Filter size={13} /> 当前结果</span>
            <ContextualImportActions entityLabel="RFQ" compact />
          </div>
        </div>
        <div className={tableScrollClass}>
          <table className={tableMinXlClass}>
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                {["RFQ / 需求", "来源 PR", "状态", "报价进度", "截止日期", "当前最优", "采购负责人", "操作"].map((h) => (
                  <th key={h} className={thClass} style={{ color: A.gray1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const style = rfqStatusStyle(r.status);
                const source = sourceForRfq(r);
                const awardDraft = buildAwardDraft(r);
                return (
                  <tr key={r.id}
                    className="h-16 hover:bg-blue-50/40 transition-colors"
                    style={{ borderBottom: i < filtered.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={`${tdIdClass} max-w-[260px]`}><BusinessEntityLink entityType="rfq" entityId={r.id} className={tableLinkClass}>{r.id}</BusinessEntityLink><div className="fc-caption mt-1 truncate font-normal" style={{ color: A.gray2 }}>{r.title} · {source.sku || source.name}</div></td>
                    <td className={tdIdClass} style={{ color: A.blue }}>{source.pr}</td>
                    <td className={tdNowrapClass}><Chip label={displayRfqStatus(r.status)} color={style.color} bg={style.bg} /></td>
                    <td className={tdNameClass}><div>已回复 {r.quoted} / {r.suppliers}</div><div className="fc-caption" style={{color:A.orange}}>{Math.max(0, r.suppliers-r.quoted)} 家待回复</div></td>
                    <td className={tdNowrapClass} style={{ color: A.label }}>{r.due}</td>
                    <td className={tdNameClass} style={{ color: A.green }}>{awardDraft.recommendedSupplier}<div className="fc-caption">{fmt(estimatedAmountForRfq(r))}</div></td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{buyerForRfq(r)}</td>
                    <td className={tdActionClass}>
                      <div className="flex justify-end gap-1">
                        <button onClick={() => openDetail(r.id)} className="px-2 py-1 text-[11px] font-medium rounded-md" style={{ background: "#f0f6ff", color: A.blue }}>查看</button>
                        <WorkbenchMoreMenu>{["查看 RFQ","查看报价","查看比价","查看授标建议"].map(label=><button key={label} onClick={()=>openDetail(r.id)} className="w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-slate-50">{label}</button>)}<button onClick={returnToSourcePr} className="w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-slate-50">查看来源 PR</button></WorkbenchMoreMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-xs" style={{ color: A.gray2 }}>当前条件下暂无 RFQ</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
