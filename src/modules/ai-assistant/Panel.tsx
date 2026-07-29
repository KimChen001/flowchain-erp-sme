import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Maximize2, MessageCircle, Minimize2, Plus, RotateCcw, Send, Square, Sparkles, X } from "lucide-react";
import {
  navigationIntentFromInternalTarget,
  navigationIntentFromEvidenceLink,
  navigationIntentFromModule,
  normalizeEvidenceLinks,
  type CanonicalFocusTarget,
} from "../../lib/evidenceLinks";
import { fmt } from "../../lib/format";
import { A } from "../../components/ui";
import { typography } from "../../components/ui/typography";
import { routeById } from "../../app/routeRegistry";
import { AiResponseV2Renderer } from "../../components/ai/AiResponseV2Renderer";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";
import type { AiResponseV2 } from "../../domain/ai/response-contract";
import { focusTargetFromActiveContext, postAiRuntimeResponse } from "./aiRuntimeGateway";
import { aiDisplayMessage, looksLikeRawJson, normalizeAiCardValue, safeUnknownCardMessage, sanitizeAiMessage } from "./presentation";

export type ActiveContext = {
  module?: string;
  entityType?: "supplier" | "item" | "rfq" | "purchase_request" | "purchase_order" | "sales_order";
  entityId?: string;
  entityLabel?: string;
  view?: string;
  route?: string;
};

type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
  cards?: AiChatCard[];
  retryPrompt?: string;
};

type AiChatCard = {
  type?: string;
  title?: string;
  data?: Record<string, unknown>;
  fields?: { name?: string; reason?: string }[] | Record<string, unknown> | null;
  actions?: {
    label?: string;
    kind?: string;
    target?: string;
    draftType?: string;
    draftTitle?: string;
    payload?: Record<string, unknown>;
    originEvidence?: Record<string, unknown>[];
  }[];
  evidence?: { type?: string; id?: string; label?: string; status?: string; route?: string; summary?: string }[];
  matches?: Record<string, unknown>[];
};

type AiNavigateOptions = {
  returnTo?: string;
  entityLabel?: string;
  source?: string;
  returnContext?: unknown;
  query?: Record<string, string>;
};

type AiNavigate = (moduleId: string, focusTarget?: CanonicalFocusTarget | null, options?: AiNavigateOptions) => void;

type AiSessionGrounding = {
  lastIntent?: string;
  lastPrimaryEntity?: { type?: string; id?: string; label?: string } | null;
  lastEvidenceIds?: string[];
  lastVisibleBusinessIds?: Record<string, string[]>;
  activeContext?: ActiveContext | null;
};

type SafeConversationContext = {
  previousIntent?: string;
  previousQuestion?: string;
  previousConclusionTitle?: string;
  previousEntityRefs?: Array<{ entityType?: string; entityId?: string; entityLabel: string; source: string; confidence: string }>;
  previousNavigationRefs?: Array<{ label: string; moduleId?: string; entityType?: string; entityId?: string; entityLabel?: string; returnTo: "ai-assistant" }>;
  previousEvidenceRefs?: Array<{ id?: string; label?: string; entityType?: string; entityId?: string; entityLabel?: string; moduleId?: string }>;
  previousModuleId?: string;
  previousViewId?: string;
  previousFocusTarget?: { entityType?: string; entityId?: string; entityLabel?: string } | null;
  breadcrumbTrail?: Array<{ label: string; moduleId?: string; entityLabel?: string; returnTo: "ai-assistant" }>;
  lastResponseId?: string;
  returnContext?: { returnTo: "ai-assistant"; returnLabel: string; sourceModuleId?: string; sourceViewId?: string };
};

const aiEvidenceLinkClass = `max-w-full text-left ${typography.compactMetadata} font-medium truncate hover:underline`;
const aiEvidenceTitleClass = `${typography.compactMetadata} font-medium truncate`;
const aiEvidenceMetaClass = `${typography.compactMetadata} truncate`;
const aiActionPillClass = `rounded-full px-2.5 py-1 ${typography.compactMetadata} font-medium`;
const aiActionLinkClass = `${aiActionPillClass} hover:underline`;
const aiBoundaryNoticeClass = `${typography.metadata} text-slate-600`;

export const AI_EMPTY_STATE_PROMPT_CHIPS = [
  { label: "今天先处理什么？", prompt: "今天先处理什么？" },
  { label: "哪些事项风险最高？", prompt: "哪些事项风险最高？" },
  { label: "哪些数据需要补齐？", prompt: "哪些数据需要补齐？" },
  { label: "帮我准备一个处理草稿", prompt: "帮我准备一个处理草稿" },
];

const PO_EMPTY_PROMPTS = ["这个 PO 为什么需要关注？", "还差哪些收货或发票证据？", "延误会影响什么？", "建议下一步是什么？"];
const SKU_EMPTY_PROMPTS = ["这个 SKU 需要补货吗？", "当前可用库存是多少？", "哪些订单会受影响？", "建议如何处理？"];

function requestScopeLabel(message: string) {
  if (/PO|采购订单|收货|GRN|发票|匹配/i.test(message)) return "正在查询业务数据：采购订单、收货和发票记录";
  if (/库存|SKU|补货|可用量/i.test(message)) return "正在查询业务数据：库存余额和关联订单";
  if (/供应商|RFQ|报价/i.test(message)) return "正在查询业务数据：供应商和询报价记录";
  if (/今天|重点|风险|待办/i.test(message)) return "正在查询业务数据：当前工作区重点事项";
  return "正在查询业务数据：当前页面相关记录";
}

const CONTEXT_ENTITY_LABELS: Record<string, string> = {
  purchase_order: "采购单",
  item: "库存 SKU",
  rfq: "询价单",
  supplier: "供应商",
  purchase_request: "采购申请",
  sales_order: "客户订单",
};

export function getAiContextLabel(moduleId: string, activeContext?: ActiveContext | null) {
  if (activeContext?.entityId) {
    const label = CONTEXT_ENTITY_LABELS[activeContext.entityType || ""] || "业务对象";
    return `${label} ${activeContext.entityLabel || activeContext.entityId}`;
  }
  return routeById(moduleId)?.moduleLabel || "当前页面";
}

export function getAiInputPlaceholder(moduleId: string, activeContext?: ActiveContext | null) {
  if (activeContext?.entityType === "purchase_order") return "问我：这个 PO 为什么优先？未到货风险在哪里？";
  if (activeContext?.entityType === "sales_order") return "问我：这个客户订单的交付风险在哪里？需要先看哪些证据？";
  if (activeContext?.entityType === "item") return "问我：这个 SKU 需要补货吗？库存覆盖够不够？";
  if (activeContext?.entityType === "rfq") return "问我：这个 RFQ 有几家回复？要不要提醒供应商？";
  if (activeContext?.entityType === "supplier") return "问我：这个供应商有哪些风险？需要怎么跟进？";
  if (moduleId === "overview") return "问我：今天先看什么？哪些风险最高？";
  return "问我：当前有什么问题？哪些数据不完整？";
}

function hasValue(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function textValue(value: unknown) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : "";
  if (typeof value === "object") return "";
  if (typeof value === "string") return sanitizeAiMessage(value);
  return String(value ?? "");
}

function businessValue(label: string, value: unknown) {
  if (/金额|余额|应付|贷项|差异/.test(label) && typeof value === "number") return fmt(value);
  return textValue(normalizeAiCardValue(label, value));
}

function fieldEntries(fields: [string, unknown][]) {
  return fields.filter(([, value]) => hasValue(value));
}

function normalizeFieldPairs(fields: AiChatCard["fields"]) {
  if (Array.isArray(fields)) {
    return fields.map((field) => [field.name, field.reason] as [unknown, unknown]).filter(([name]) => hasValue(name));
  }
  if (fields && typeof fields === "object") {
    return Object.entries(fields);
  }
  return [];
}

function bestText(...values: unknown[]) {
  const found = values.find(hasValue);
  return found === undefined ? "" : textValue(found);
}

function compactCandidateLabel(candidate: Record<string, unknown>) {
  return bestText(
    [candidate.supplierId, candidate.name].filter(Boolean).join(" · "),
    [candidate.itemId, candidate.sku, candidate.name].filter(Boolean).join(" · "),
    [candidate.rfqId, candidate.title].filter(Boolean).join(" · "),
    [candidate.id, candidate.label].filter(Boolean).join(" · "),
    candidate.name,
    candidate.title,
    candidate.label,
  );
}

function priorityDisplayValue(data: Record<string, unknown>) {
  return bestText(data.priorityLabel, data.priorityId, data.prioritySignal, data.prioritySource);
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function yesNoValue(value: unknown) {
  if (!hasValue(value)) return "";
  return value === true ? "是" : value === false ? "否" : textValue(value);
}

function compactProcurementList(items: unknown[], type: "pr" | "po" | "receiving" | "issue") {
  return items.map((item) => {
    const row = typeof item === "object" && item ? item as Record<string, unknown> : { value: item };
    if (type === "pr") {
      return {
        title: bestText(row.prId, row.pr, row.id, "PR"),
        reason: [row.status, row.requiredDate, row.supplier].filter(hasValue).map(textValue).join(" · "),
      };
    }
    if (type === "po") {
      return {
        title: bestText(row.poId, row.po, row.id, "PO"),
        reason: [row.supplier, row.status, row.expectedDate, row.riskLevel].filter(hasValue).map(textValue).join(" · "),
      };
    }
    if (type === "receiving") {
      return {
        title: bestText(row.receivingId, row.grn, row.id, "收货单"),
        reason: [row.poId, row.supplier, row.varianceType, row.status].filter(hasValue).map(textValue).join(" · "),
      };
    }
    return {
      title: [row.type, row.id].filter(hasValue).map(textValue).join(" · ") || bestText(row.title, row.id, "重点事项"),
      reason: bestText(row.summary, row.reason, row.status),
    };
  });
}

function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl px-3 py-2.5 space-y-2" style={{ background: A.white, border: `1px solid ${A.border}` }}>
      <div className="text-[11px] font-semibold" style={{ color: A.label }}>{title}</div>
      {children}
    </div>
  );
}

function KeyValueGrid({ fields }: { fields: [string, unknown][] }) {
  const entries = fieldEntries(fields);
  if (!entries.length) return null;
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {entries.map(([label, value]) => (
        <div key={label} className="rounded-lg px-2 py-1.5" style={{ background: A.gray6 }}>
          <div className="fc-caption" style={{ color: A.gray2 }}>{label}</div>
          <div className="text-[11px] font-medium truncate" style={{ color: A.label }}>{businessValue(label, value)}</div>
        </div>
      ))}
    </div>
  );
}

function MiniList({ items, limit = 2 }: { items: unknown[]; limit?: number }) {
  const rows = items.slice(0, limit).filter(Boolean);
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      {rows.map((item, index) => {
        const row = typeof item === "object" && item ? item as Record<string, unknown> : { value: item };
        const title = compactCandidateLabel(row) || row.title || row.rfqId || row.id || row.pr || row.value || "匹配项";
        const detail = row.reason || row.status || row.responseStatus || row.dueDate || row.riskLevel || row.summary;
        return (
          <div key={`${textValue(title)}-${index}`} className="rounded-lg px-2 py-1.5" style={{ background: A.gray6 }}>
            {hasValue(title) && <div className="text-[11px] font-medium truncate" style={{ color: A.label }}>{textValue(title)}</div>}
            {hasValue(detail) && <div className="fc-caption truncate" style={{ color: A.gray2 }}>{textValue(detail)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function EvidenceList({
  evidence = [],
  onNavigate,
}: {
  evidence?: AiChatCard["evidence"];
  onNavigate?: AiNavigate;
}) {
  const rows = (evidence || [])
    .map((item) => {
      const raw = typeof item === "object" && item ? item as Record<string, unknown> : {};
      const link = normalizeEvidenceLinks([raw], { source: "ai" })[0] || null;
      return { raw, link };
    })
    .filter((item) => item.link)
    .slice(0, 3);
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      {rows.map(({ raw, link }, index) => {
        if (!link) return null;
        const rawLabel = bestText(raw.label, raw.title, raw.summary, link.label);
        const businessId = visibleBusinessId(link.entityId, raw.id, raw.documentId, raw.label, raw.title, raw.summary, link.label);
        const displayId = businessId || link.entityId;
        const fallbackFocusTarget = focusTargetFromBusinessId(businessId);
        const navigableLink = fallbackFocusTarget && !link.clickable
          ? {
              ...link,
              clickable: true,
              entityId: businessId,
              entityType: fallbackFocusTarget.entityType,
              moduleId: moduleIdForBusinessId(businessId),
              focusTarget: fallbackFocusTarget,
            }
          : link;
        const intent = navigationIntentFromEvidenceLink(navigableLink, { source: "ai" });
        const label = displayId && rawLabel && !rawLabel.includes(displayId)
          ? `${displayId} · ${rawLabel}`
          : bestText(rawLabel, link.entityId);
        const title = `依据：${label}`;
        const detail = bestText(raw.summary, raw.reason, link.status && link.status !== link.label ? link.status : "");
        return (
          <div key={`${title}-${index}`} className="rounded-lg px-2 py-1.5" style={{ background: A.gray6 }}>
            {navigableLink.clickable && intent && onNavigate ? (
              <button
                type="button"
                onClick={() => onNavigate(intent.activeId, intent.focusTarget || null, { returnTo: "ai", entityLabel: label, source: "ai" })}
                data-testid="ai-evidence-link"
                data-business-id={displayId}
                className={aiEvidenceLinkClass}
                style={{ color: A.blue }}
              >
                {textValue(title)}
              </button>
            ) : (
              <div className={aiEvidenceTitleClass} style={{ color: A.label }}>{textValue(title)}</div>
            )}
            {hasValue(detail) && <div className={aiEvidenceMetaClass} style={{ color: A.gray2 }}>{textValue(detail)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function actionDraftRequestFromCard(card: AiChatCard): ActionDraftPreviewRequest | null {
  const data = card.data || {};
  if (card.type === "pr_draft") {
    return {
      type: "purchase_request_draft",
      title: card.title || "Purchase Request Draft",
      source: "ai_assistant",
      originEvidence: card.evidence as Record<string, unknown>[] || [],
      payload: {
        itemIdOrSku: data.itemId || data.sku || data.itemLabel || data.itemName,
        quantity: data.quantity,
        reason: data.reason || data.prioritySignal || "AI draft preparation",
        supplierIdOrName: data.preferredSupplierId || data.supplierId || data.supplier,
        warehouse: data.warehouseId || data.defaultWarehouseId,
      },
    };
  }
  if (card.type === "rfq_draft") {
    return {
      type: "rfq_draft",
      title: card.title || "RFQ Draft",
      source: "ai_assistant",
      originEvidence: card.evidence as Record<string, unknown>[] || [],
      payload: {
        itemIdOrSku: data.itemId || data.sku || data.itemLabel || data.itemName,
        quantity: data.quantity,
        supplierCandidates: data.supplierCandidates,
        requestedDeliveryDate: data.targetDeliveryDate || data.requiredDate,
        quotationDeadline: data.quotationDeadline,
        reason: data.reason || data.prioritySignal || "AI draft preparation",
      },
    };
  }
  return null;
}

function actionDraftRequestFromAction(action: NonNullable<AiChatCard["actions"]>[number]): ActionDraftPreviewRequest | null {
  if (action.kind !== "draft_preview" || !action.draftType) return null;
  return {
    type: action.draftType,
    title: action.draftTitle || action.label || "动作草稿预览",
    source: "ai_assistant",
    originEvidence: action.originEvidence || [],
    payload: {
      ...(action.payload || {}),
      reason: action.payload?.reason || action.label || "AI 建议动作草稿预览，需人工审阅。",
    },
  };
}

function AiResponseCard({
  card,
  onNavigate,
  onReviewActionDraft,
  onFollowUp,
}: {
  card: AiChatCard;
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
  onFollowUp?: (prompt: string) => void;
}) {
  const data = card.data || {};
  switch (card.type) {
    case "ai_response_v2":
      return (
        <AiResponseV2Renderer
          response={data as unknown as AiResponseV2}
          onNavigate={onNavigate}
          onReviewActionDraft={onReviewActionDraft}
          onFollowUp={onFollowUp}
        />
      );
    case "supplier_status":
      return (
        <CardShell title={card.title || textValue(data.name) || "供应商状态"}>
          <KeyValueGrid fields={[
            ["状态", data.status],
            ["风险", data.risk],
            ["评分", data.score],
            ["未结 PO", data.openPoCount],
            ["逾期 PO", data.overduePoCount],
            ["优选", data.preferred],
          ]} />
        </CardShell>
      );
    case "supplier_operational_summary":
      return (
        <CardShell title={card.title || textValue(data.supplierName) || "供应商运营摘要"}>
          <KeyValueGrid fields={[
            ["供应商", data.supplierName || data.supplierId],
            ["状态", data.status],
            ["风险", data.risk],
            ["评分", data.score],
            ["开放 PO", data.openPoCount],
            ["逾期 PO", data.overduePoCount],
            ["发票差异", data.invoiceIssueCount],
            ["有效合同", data.activeContractCount],
            ["库存风险", data.inventoryRiskItemCount],
            ["开放 RFQ", data.openRfqCount],
            ["下一步", data.nextAction],
          ]} />
        </CardShell>
      );
    case "supplier_related_po_summary":
      return (
        <CardShell title={card.title || "供应商 PO"}>
          <KeyValueGrid fields={[
            ["总 PO", data.totalPoCount],
            ["开放 PO", data.openPoCount],
            ["逾期 PO", data.overduePoCount],
            ["临期 PO", data.dueSoonPoCount],
          ]} />
          <MiniList items={compactProcurementList(arrayValue(data.topPurchaseOrders), "po")} limit={3} />
        </CardShell>
      );
    case "supplier_invoice_summary":
      return (
        <CardShell title={card.title || "供应商发票"}>
          <KeyValueGrid fields={[
            ["发票数", data.invoiceCount],
            ["差异数", data.invoiceVarianceCount],
            ["待复核", data.pendingReviewCount],
            ["贷项金额", data.creditMemoAmount],
            ["对账状态", data.reconciliationStatus],
          ]} />
          <MiniList items={arrayValue(data.topIssues)} limit={3} />
        </CardShell>
      );
    case "supplier_contract_summary":
      return (
        <CardShell title={card.title || "供应商合同"}>
          <KeyValueGrid fields={[
            ["有效合同", data.activeContractCount],
            ["即将到期", data.expiringContractCount],
            ["已到期", data.expiredContractCount],
          ]} />
          <MiniList items={arrayValue(data.topContracts)} limit={3} />
        </CardShell>
      );
    case "supplier_inventory_risk_summary":
      return (
        <CardShell title={card.title || "供应商库存风险"}>
          <KeyValueGrid fields={[
            ["关联物料", data.relatedItemCount],
            ["风险物料", data.inventoryRiskItemCount],
          ]} />
          <MiniList items={arrayValue(data.topRiskItems)} limit={3} />
        </CardShell>
      );
    case "supplier_rfq_summary":
      return (
        <CardShell title={card.title || "供应商 RFQ"}>
          <KeyValueGrid fields={[
            ["总 RFQ", data.totalRfqCount],
            ["开放 RFQ", data.openRfqCount],
            ["待回复", data.pendingResponseCount],
          ]} />
          <MiniList items={arrayValue(data.topRfqs)} limit={3} />
        </CardShell>
      );
    case "supplier_operational_comparison":
      return (
        <CardShell title={card.title || "供应商运营对比"}>
          <MiniList
            items={arrayValue(data.suppliers).map((supplier) => {
              const row = typeof supplier === "object" && supplier ? supplier as Record<string, unknown> : {};
              return {
                title: bestText(row.supplierName, row.supplierId),
                reason: [
                  `开放 PO ${textValue(row.openPoCount)}`,
                  `发票差异 ${textValue(row.invoiceIssueCount)}`,
                  `库存风险 ${textValue(row.inventoryRiskItemCount)}`,
                  row.nextAction,
                ].filter(hasValue).join(" · "),
              };
            })}
            limit={3}
          />
        </CardShell>
      );
    case "supplier_high_risk_summary":
      return (
        <CardShell title={card.title || "高风险供应商"}>
          <KeyValueGrid fields={[
            ["供应商数", data.supplierCount],
            ["高风险", data.highRiskCount],
            ["逾期 PO", data.overduePoCount],
            ["RFQ 待回复", data.pendingRfqResponseCount],
            ["发票差异", data.invoiceIssueCount],
          ]} />
          <MiniList
            items={arrayValue(data.topSuppliers).map((supplier) => {
              const row = typeof supplier === "object" && supplier ? supplier as Record<string, unknown> : {};
              return {
                title: bestText(row.supplierName, row.supplierId),
                reason: [
                  row.risk ? `风险 ${textValue(row.risk)}` : "",
                  row.score ? `评分 ${textValue(row.score)}` : "",
                  row.pendingRfqResponseCount ? `RFQ 待回复 ${textValue(row.pendingRfqResponseCount)}` : "",
                  row.nextAction,
                ].filter(hasValue).join(" · "),
              };
            })}
            limit={5}
          />
        </CardShell>
      );
    case "supplier_scoring_explanation":
      return (
        <CardShell title={card.title || "供应商评分规则"}>
          <KeyValueGrid fields={[
            ["已评分供应商", data.scoredSupplierCount],
            ["说明", data.message],
          ]} />
          <MiniList items={arrayValue(data.rules).map((rule) => ({ title: textValue(rule) }))} limit={4} />
        </CardShell>
      );
    case "supplier_next_actions":
      return (
        <CardShell title={card.title || "SRM 下一步"}>
          <MiniList items={arrayValue(data.actions).map((action) => ({ title: textValue(action) }))} limit={5} />
          <MiniList
            items={arrayValue(data.topSuppliers).map((supplier) => {
              const row = typeof supplier === "object" && supplier ? supplier as Record<string, unknown> : {};
              return {
                title: bestText(row.supplierName, row.supplierId),
                reason: row.nextAction,
              };
            })}
            limit={5}
          />
        </CardShell>
      );
    case "supplier_boundary_notice":
      return (
        <CardShell title={card.title || "SRM Alpha 边界"}>
          <p className={aiBoundaryNoticeClass}>{textValue(data.message || card.title)}</p>
        </CardShell>
      );
    case "inventory_status":
      return (
        <CardShell title={card.title || textValue(data.sku) || "库存状态"}>
          <KeyValueGrid fields={[
            ["物料", data.name || data.sku],
            ["可用库存", data.availableQuantity],
            ["风险", data.riskLevel],
            ["原因", data.riskReason],
            ["默认仓", data.defaultWarehouseId],
          ]} />
        </CardShell>
      );
    case "inventory_risk_summary":
      return (
        <CardShell title={card.title || "库存风险摘要"}>
          <KeyValueGrid fields={[
            ["物料数", data.itemCount],
            ["有库存证据", data.itemsWithQuantityEvidence],
            ["风险物料", data.riskItemCount],
            ["库存流水", data.movementCount],
            ["余额证据", data.stockBalanceEvidence],
            ["证据缺口", data.balanceGapExplanation],
          ]} />
          <MiniList
            items={arrayValue(data.topRiskItems).map((item) => {
              const row = typeof item === "object" && item ? item as Record<string, unknown> : {};
              return {
                title: bestText(row.sku, row.itemId, row.name, "风险物料"),
                reason: [
                  hasValue(row.availableQuantity) ? `可用 ${textValue(row.availableQuantity)}` : "",
                  row.riskLevel,
                  row.riskReason,
                ].filter(hasValue).map(textValue).join(" · "),
              };
            })}
            limit={3}
          />
        </CardShell>
      );
    case "inventory_exception_summary":
      return (
        <CardShell title={card.title || "库存异常摘要"}>
          <KeyValueGrid fields={[
            ["异常数", data.exceptionCount],
            ["未关闭", data.openExceptionCount],
            ["高风险", data.highRiskCount],
            ["影响数量", data.quantityImpact],
          ]} />
          <MiniList items={arrayValue(data.topExceptions)} limit={3} />
        </CardShell>
      );
    case "inventory_movement_summary":
      return (
        <CardShell title={card.title || "库存流水摘要"}>
          <KeyValueGrid fields={[
            ["流水数", data.movementCount],
            ["入库", data.inboundCount],
            ["出库", data.outboundCount],
            ["调整", data.adjustmentCount],
            ["净变动", data.netMovement],
          ]} />
          <MiniList items={arrayValue(data.topMovements)} limit={3} />
        </CardShell>
      );
    case "inventory_replenishment_summary":
      return (
        <CardShell title={card.title || "补货观察摘要"}>
          <KeyValueGrid fields={[
            ["建议数", data.replenishmentCount],
            ["待审阅", data.reviewCount],
            ["预估数量", data.plannedQuantity],
            ["预估金额", data.plannedAmount],
            ["边界", data.reviewBoundary],
          ]} />
          <MiniList items={arrayValue(data.topSuggestions)} limit={3} />
        </CardShell>
      );
    case "stock_balance_gap_summary":
      return (
        <CardShell title={card.title || "库存余额证据缺口"}>
          <KeyValueGrid fields={[
            ["物料数", data.itemCount],
            ["缺余额证据", data.missingBalanceCount],
            ["可用字段", data.availableFields],
            ["限制", data.limitation],
          ]} />
          <MiniList items={arrayValue(data.topItems)} limit={3} />
        </CardShell>
      );
    case "finance_pending_settlement_summary":
      return (
        <CardShell title={card.title || "待结算协同摘要"}>
          <KeyValueGrid fields={[
            ["发票数", data.invoiceCount],
            ["待协同", data.pendingSettlementCount],
            ["待协同金额", data.pendingAmount],
            ["差异发票", data.varianceInvoiceCount],
            ["三单差异", data.threeWayVarianceCount],
          ]} />
          <MiniList
            items={arrayValue(data.topInvoices).map((invoice) => {
              const row = typeof invoice === "object" && invoice ? invoice as Record<string, unknown> : {};
              return {
                title: bestText(row.invoiceId, row.supplier, "发票"),
                reason: bestText(row.reason, row.matchStatus, row.invoiceStatus),
              };
            })}
            limit={3}
          />
        </CardShell>
      );
    case "finance_variance_summary":
      return (
        <CardShell title={card.title || "财务差异摘要"}>
          <KeyValueGrid fields={[
            ["差异发票", data.varianceInvoiceCount],
            ["差异金额", data.totalVarianceAmount],
          ]} />
          <MiniList
            items={arrayValue(data.topVariances).map((item) => {
              const row = typeof item === "object" && item ? item as Record<string, unknown> : {};
              return {
                title: bestText(row.invoiceId, row.supplier, "差异发票"),
                reason: bestText(row.reason, row.matchStatus, row.invoiceStatus),
              };
            })}
            limit={3}
          />
        </CardShell>
      );
    case "finance_next_actions":
      return (
        <CardShell title={card.title || "财务下一步"}>
          <MiniList items={arrayValue(data.actions)} limit={3} />
          <KeyValueGrid fields={[
            ["禁用动作", arrayValue(data.blockedActions).join("、")],
          ]} />
        </CardShell>
      );
    case "three_way_match_summary":
      return (
        <CardShell title={card.title || "三单匹配摘要"}>
          <KeyValueGrid fields={[
            ["匹配数", data.matchCount],
            ["差异数", data.varianceCount],
          ]} />
          <MiniList
            items={arrayValue(data.topMatches).map((item) => {
              const row = typeof item === "object" && item ? item as Record<string, unknown> : {};
              return {
                title: bestText(row.matchId, row.invoice, "三单匹配"),
                reason: [row.status, row.reason, hasValue(row.varianceAmount) ? `差异 ${textValue(row.varianceAmount)}` : ""].filter(hasValue).map(textValue).join(" · "),
              };
            })}
            limit={3}
          />
        </CardShell>
      );
    case "finance_boundary_notice":
      return (
        <CardShell title={card.title || "财务协同边界"}>
          <KeyValueGrid fields={[
            ["边界", data.boundary],
            ["付款执行", data.paymentExecution],
            ["会计过账", data.accountingPosting],
            ["税务申报", data.taxFiling],
            ["最终审批", data.finalApproval],
          ]} />
        </CardShell>
      );
    case "master_data_quality_summary":
      return (
        <CardShell title={card.title || "基础资料质量摘要"}>
          <KeyValueGrid fields={[
            ["物料", data.itemCount],
            ["供应商", data.supplierCount],
            ["仓库/库位", data.warehouseCount],
            ["付款条款", data.paymentTermCount],
            ["税码", data.taxCodeCount],
            ["质量信号", data.issueCount],
            ["高优先级", data.highIssueCount],
            ["中优先级", data.mediumIssueCount],
          ]} />
        </CardShell>
      );
    case "master_data_missing_fields_summary":
      return (
        <CardShell title={card.title || "缺少默认字段"}>
          <KeyValueGrid fields={[["缺失/待确认", data.missingFieldCount]]} />
          <MiniList
            items={arrayValue(data.topIssues).map((issue) => {
              const row = typeof issue === "object" && issue ? issue as Record<string, unknown> : {};
              return {
                title: bestText(row.label, row.entityId, row.field),
                reason: [row.field, row.severity, row.reason].filter(hasValue).map(textValue).join(" · "),
              };
            })}
            limit={6}
          />
        </CardShell>
      );
    case "master_data_next_actions":
      return (
        <CardShell title={card.title || "基础资料下一步"}>
          <MiniList items={arrayValue(data.actions).map((action) => ({ title: textValue(action) }))} limit={5} />
        </CardShell>
      );
    case "master_data_boundary_notice":
      return (
        <CardShell title={card.title || "基础资料边界"}>
          <p className={aiBoundaryNoticeClass}>{textValue(data.message || card.title)}</p>
        </CardShell>
      );
    case "planning_status_summary":
      return (
        <CardShell title={card.title || "计划/MRP 摘要"}>
          <KeyValueGrid fields={[
            ["SKU", data.sku],
            ["物料", data.name],
            ["例外", data.exception],
            ["例外数", data.exceptionCount],
            ["加急数", data.urgentCount],
            ["计划数量", data.plannedQty],
            ["计划金额", data.plannedAmount],
            ["最大净需求", data.maxNetRequirement],
            ["首个缺口周期", data.firstShortagePeriod],
            ["MAPE", data.mape],
            ["边界", data.reviewBoundary],
          ]} />
          <MiniList
            items={arrayValue(data.plannedReleasePeriods).map((period) => ({
              title: "计划释放周期",
              reason: period,
            }))}
            limit={3}
          />
        </CardShell>
      );
    case "procurement_exception_summary":
      return (
        <CardShell title={card.title || "采购异常"}>
          <KeyValueGrid fields={[
            ["总数", data.totalIssueCount],
            ["逾期 PO", data.overduePoCount],
            ["待处理 PR", data.pendingPrCount],
            ["待处理 RFQ", data.pendingRfqCount],
          ]} />
          {Array.isArray(data.topIssues) && <MiniList items={data.topIssues} />}
        </CardShell>
      );
    case "rfq_status":
      return (
        <CardShell title={card.title || textValue(data.rfqId) || "RFQ 状态"}>
          <KeyValueGrid fields={[
            ["状态", data.status],
            ["供应商", data.supplierCount],
            ["已回复", data.respondedSupplierCount],
            ["待回复", data.pendingSupplierCount],
            ["截止", data.dueDate],
            ["风险", data.riskLevel],
          ]} />
        </CardShell>
      );
    case "rfq_response_summary":
      return (
        <CardShell title={card.title || "RFQ 回复"}>
          <KeyValueGrid fields={[
            ["开放 RFQ", data.totalOpenRfqs],
            ["待回复 RFQ", data.rfqsWithPendingResponses],
          ]} />
          {Array.isArray(data.topPendingRfqs) && <MiniList items={data.topPendingRfqs} />}
        </CardShell>
      );
    case "supplier_rfq_participation":
      return (
        <CardShell title={card.title || textValue(data.supplierName) || "供应商 RFQ"}>
          <KeyValueGrid fields={[
            ["供应商", data.supplierName || data.supplierId],
            ["总 RFQ", data.totalRfqs],
            ["开放 RFQ", data.openRfqs],
            ["待回复", data.pendingResponseCount],
            ["已回复", data.respondedCount],
          ]} />
          {Array.isArray(data.recentRfqs) && <MiniList items={data.recentRfqs} />}
        </CardShell>
      );
    case "pr_status":
      return (
        <CardShell title={card.title || "采购申请状态"}>
          <KeyValueGrid fields={[
            ["PR", data.prId],
            ["状态", data.status],
            ["申请人", data.requester],
            ["采购负责人", data.buyer],
            ["供应商", data.supplier],
            ["物料", data.sku || data.itemId],
            ["数量", data.quantity],
            ["需求日期", data.requiredDate],
            ["优先级", data.priority],
            ["金额", data.amount],
            ["关联 PO", data.linkedPo],
            ["关联 RFQ", data.linkedRfq],
            ["来源", data.source],
          ]} />
        </CardShell>
      );
    case "pr_conversion_status":
      return (
        <CardShell title={card.title || "PR 转单状态"}>
          <KeyValueGrid fields={[
            ["PR", data.prId],
            ["状态", data.status],
            ["可转 PO", yesNoValue(data.canConvert)],
            ["阻塞原因", data.blockedReason],
            ["关联 PO", data.linkedPo],
            ["关联 RFQ", data.linkedRfq],
            ["下一步", data.nextStep],
          ]} />
        </CardShell>
      );
    case "pr_conversion_summary":
      return (
        <CardShell title={card.title || "待转单采购申请"}>
          <KeyValueGrid fields={[
            ["待转 PO 的 PR", data.approvedNotConvertedCount],
            ["待审批 PR", data.pendingApprovalCount],
          ]} />
          <MiniList items={compactProcurementList(arrayValue(data.topRequests), "pr")} limit={3} />
        </CardShell>
      );
    case "po_status":
      return (
        <CardShell title={card.title || "采购订单状态"}>
          <KeyValueGrid fields={[
            ["PO", data.poId],
            ["状态", data.status],
            ["供应商", data.supplier],
            ["来源 PR", data.sourceRequest],
            ["预计日期", data.expectedDate],
            ["已逾期", yesNoValue(data.overdue)],
            ["临近到期", yesNoValue(data.dueSoon)],
            ["订单数量", data.orderedQuantity],
            ["已收数量", data.receivedQuantity],
            ["收货状态", data.receivingStatus],
            ["收货单数", data.receivingDocCount],
          ]} />
        </CardShell>
      );
    case "po_overdue_summary":
      return (
        <CardShell title={card.title || "PO 跟进摘要"}>
          <KeyValueGrid fields={[
            ["逾期 PO", data.overdueCount],
            ["临近到期", data.dueSoonCount],
          ]} />
          <MiniList items={compactProcurementList(arrayValue(data.topPurchaseOrders), "po")} limit={3} />
        </CardShell>
      );
    case "receiving_status":
      return (
        <CardShell title={card.title || "收货状态"}>
          <KeyValueGrid fields={[
            ["收货单", data.receivingId],
            ["PO", data.poId],
            ["供应商", data.supplier],
            ["状态", data.status],
            ["已收数量", data.receivedQuantity],
            ["预计数量", data.expectedQuantity],
            ["差异", data.variance],
            ["不合格数量", data.failedQuantity],
            ["是否异常", yesNoValue(data.exception)],
            ["仓库", data.warehouse],
          ]} />
        </CardShell>
      );
    case "receiving_exception_summary":
      return (
        <CardShell title={card.title || "收货异常"}>
          <KeyValueGrid fields={[
            ["异常收货", data.exceptionCount],
            ["未关闭异常", data.openExceptionCount],
          ]} />
          <MiniList items={compactProcurementList(arrayValue(data.topExceptions), "receiving")} limit={3} />
        </CardShell>
      );
    case "procurement_followup_summary":
      return (
        <CardShell title={card.title || "采购跟进摘要"}>
          <KeyValueGrid fields={[
            ["待审批 PR", data.pendingPrCount],
            ["待转 PO 的 PR", data.approvedNotConvertedPrCount],
            ["待回复 RFQ", data.pendingRfqResponseCount],
            ["逾期 PO", data.overduePoCount],
            ["收货异常", data.receivingExceptionCount],
          ]} />
          <MiniList items={compactProcurementList(arrayValue(data.topIssues), "issue")} limit={3} />
        </CardShell>
      );
    case "pr_draft":
      const prDraftRequest = onReviewActionDraft ? actionDraftRequestFromCard(card) : null;
      return (
        <CardShell title={card.title || "采购申请草稿"}>
          <KeyValueGrid fields={[
            ["物料", data.itemLabel || data.itemName || data.name || data.sku || data.itemId],
            ["数量", data.quantity],
            ["需求日期", data.requiredDate],
            ["仓库", data.warehouseId || data.defaultWarehouseId],
            ["供应商", data.preferredSupplierId || data.supplierId || data.supplier],
            ["优先级", priorityDisplayValue(data)],
            ["优先级来源", data.prioritySource],
            ["优先级置信度", data.priorityConfidence],
            ["单据状态", data.documentStatus],
            ["需要复核", (card as Record<string, unknown>).reviewRequired],
            ["状态", data.status],
          ]} />
          {prDraftRequest ? (
            <button
              type="button"
              onClick={() => onReviewActionDraft?.(prDraftRequest)}
              data-testid="ai-action-draft-preview"
              data-draft-type={prDraftRequest.type}
              className={aiActionPillClass}
              style={{ background: "#f0f6ff", color: A.blue }}
            >
              审阅草稿
            </button>
          ) : null}
        </CardShell>
      );
    case "rfq_draft":
      const rfqDraftRequest = onReviewActionDraft ? actionDraftRequestFromCard(card) : null;
      return (
        <CardShell title={card.title || "询价草稿"}>
          <KeyValueGrid fields={[
            ["物料", data.itemLabel || data.itemName || data.name || data.sku || data.itemId],
            ["数量", data.quantity],
            ["交期", data.targetDeliveryDate || data.requiredDate],
            ["候选供应商", data.supplierCandidateCount || (Array.isArray(data.supplierCandidates) ? data.supplierCandidates.length : "")],
            ["报价截止", data.quotationDeadline],
            ["优先级", priorityDisplayValue(data)],
            ["优先级来源", data.prioritySource],
            ["优先级置信度", data.priorityConfidence],
            ["单据状态", data.documentStatus],
            ["需要复核", (card as Record<string, unknown>).reviewRequired],
            ["状态", data.status],
          ]} />
          {rfqDraftRequest ? (
            <button
              type="button"
              onClick={() => onReviewActionDraft?.(rfqDraftRequest)}
              data-testid="ai-action-draft-preview"
              data-draft-type={rfqDraftRequest.type}
              className={aiActionPillClass}
              style={{ background: "#f0f6ff", color: A.blue }}
            >
              审阅草稿
            </button>
          ) : null}
        </CardShell>
      );
    case "missing_fields":
      return (
        <CardShell title="需补充信息">
          <MiniList items={normalizeFieldPairs(card.fields).map(([name, value]) => ({ title: name, reason: value }))} />
        </CardShell>
      );
    case "confidence_summary":
      return (
        <CardShell title={card.title || "字段级置信度"}>
          <MiniList items={normalizeFieldPairs(card.fields).map(([name, value]) => ({ title: name, reason: value }))} limit={3} />
        </CardShell>
      );
    case "recommended_actions": {
      const actions = (card.actions || []).filter((action) => ["deep_link", "review", "edit", "draft_preview"].includes(String(action.kind || "")));
      if (!actions.length) return null;
      return (
        <CardShell title="建议操作">
          <div className="flex flex-wrap gap-1.5">
            {actions.slice(0, 4).map((action) => {
              const draftRequest = onReviewActionDraft ? actionDraftRequestFromAction(action) : null;
              const intent = action.kind === "deep_link"
                ? navigationIntentFromInternalTarget(action.target, { source: "aiAction" }) || navigationIntentFromModule(action.target || "overview", { source: "aiAction" })
                : null;
              return draftRequest ? (
                <button
                  key={`${action.label}-${action.kind}`}
                  type="button"
                  onClick={() => onReviewActionDraft?.(draftRequest)}
                  data-testid="ai-action-draft-preview"
                  data-draft-type={draftRequest.type}
                  className={aiActionLinkClass}
                  style={{ background: "#f0f6ff", color: A.blue }}
                >
                  {action.label || "预览草稿"}
                </button>
              ) : intent && onNavigate ? (
                <button
                  key={`${action.label}-${action.target}`}
                  type="button"
                  onClick={() => onNavigate(intent.activeId, intent.focusTarget || null, { returnTo: "ai", entityLabel: action.label || intent.entityLabel, source: "ai" })}
                  data-testid="ai-action-link"
                  data-business-id={intent.focusTarget?.entityId || action.target || ""}
                  className={aiActionLinkClass}
                  style={{ background: A.gray6, color: A.blue }}
                >
                  {action.label || "打开"}
                </button>
              ) : (
                <span key={`${action.label}-${action.kind}`} className={aiActionPillClass} style={{ background: A.gray6, color: A.gray1 }}>
                  {action.label || action.kind}
                </span>
              );
            })}
          </div>
        </CardShell>
      );
    }
    case "compound_summary":
      return (
        <CardShell title={card.title || "多问题拆解"}>
          <MiniList
            items={arrayValue(data.sections).map((section) => {
              const row = typeof section === "object" && section ? section as Record<string, unknown> : {};
              return {
                title: bestText(row.title, "业务问题"),
                reason: row.conclusion,
              };
            })}
            limit={3}
          />
          <MiniList
            items={arrayValue(data.remainingTopics).map((topic) => {
              const row = typeof topic === "object" && topic ? topic as Record<string, unknown> : {};
              return {
                title: bestText(row.title, "可继续展开"),
                reason: row.prompt,
              };
            })}
            limit={3}
          />
        </CardShell>
      );
    case "compound_section":
      return (
        <CardShell title={card.title || textValue(data.title) || "业务问题"}>
          <MiniList items={[data.conclusion].filter(hasValue).map((item) => ({ title: item }))} limit={1} />
          <MiniList items={arrayValue(data.keyFacts).map((item) => ({ title: item }))} limit={3} />
          <MiniList items={arrayValue(data.limitations).map((item) => ({ title: "限制", reason: item }))} limit={2} />
          <EvidenceList evidence={card.evidence} onNavigate={onNavigate} />
        </CardShell>
      );
    case "receiving_gap_summary":
      return (
        <CardShell title={card.title || "未收货订单"}>
          <KeyValueGrid fields={[
            ["未完全收货 PO", data.openGapCount],
            ["剩余数量", data.totalRemainingQuantity],
          ]} />
          <MiniList
            items={arrayValue(data.topPurchaseOrders).map((po) => {
              const row = typeof po === "object" && po ? po as Record<string, unknown> : {};
              return {
                title: bestText(row.poId, "PO"),
                reason: [
                  row.supplier,
                  row.status,
                  hasValue(row.receivedQuantity) && hasValue(row.orderedQuantity) ? `已收 ${textValue(row.receivedQuantity)} / 订购 ${textValue(row.orderedQuantity)}` : "",
                  hasValue(row.remainingQuantity) ? `剩余 ${textValue(row.remainingQuantity)}` : "",
                  row.expectedDate ? `预计 ${textValue(row.expectedDate)}` : "",
                ].filter(hasValue).map(textValue).join(" · "),
              };
            })}
            limit={3}
          />
          <MiniList items={arrayValue(data.limitations).map((item) => ({ title: "限制", reason: item }))} limit={2} />
        </CardShell>
      );
    case "evidence_workspace":
      return (
        <CardShell title={card.title || "证据工作区"}>
          <KeyValueGrid fields={[
            ["主对象", data.primaryObject],
          ]} />
          <MiniList items={arrayValue(data.keyFacts).map((item) => ({ title: item }))} limit={5} />
          <MiniList items={arrayValue(data.relatedDocuments).map((item) => ({ title: item }))} limit={4} />
          <MiniList items={arrayValue(data.inventorySignals).map((item) => ({ title: item }))} limit={3} />
          <MiniList items={arrayValue(data.supplierSignals).map((item) => ({ title: item }))} limit={2} />
          <MiniList items={arrayValue(data.limitations).map((item) => ({ title: "限制", reason: item }))} limit={3} />
          <EvidenceList evidence={card.evidence} onNavigate={onNavigate} />
        </CardShell>
      );
    case "evidence":
      if (!card.evidence?.length) return null;
      return (
        <CardShell title="依据">
          <EvidenceList evidence={card.evidence} onNavigate={onNavigate} />
        </CardShell>
      );
    case "empty_state":
      return (
        <CardShell title={card.title || "暂无结果"}>
          <div className="text-[11px] leading-5" style={{ color: A.gray1 }}>
            {bestText((card as Record<string, unknown>).reason, (card as Record<string, unknown>).message, (card as Record<string, unknown>).summary, data.reason, data.message, data.summary) || "当前没有匹配结果。"}
          </div>
        </CardShell>
      );
    case "ambiguous_match":
      return (
        <CardShell title={card.title || "需要选择匹配项"}>
          <MiniList items={card.matches?.length ? card.matches : ["请提供更具体的信息。"]} limit={3} />
        </CardShell>
      );
    default:
      if (!card.type && !card.title) return null;
      return (
        <CardShell title={sanitizeAiMessage(card.title || "") || "结构化信息"}>
          <div className="text-[11px]" style={{ color: A.gray1 }}>{safeUnknownCardMessage()}</div>
        </CardShell>
      );
  }
}

function businessTypeFromId(id = "") {
  if (/^PO-/i.test(id)) return "po";
  if (/^PR-/i.test(id)) return "pr";
  if (/^RFQ-/i.test(id)) return "rfq";
  if (/^GRN-/i.test(id)) return "grn";
  if (/^INV-/i.test(id)) return "invoice";
  if (/^SKU-/i.test(id)) return "sku";
  return "";
}

function focusTargetFromBusinessId(id = ""): CanonicalFocusTarget | null {
  const type = businessTypeFromId(id);
  if (type === "po") return { entityType: "purchase_order", entityId: id };
  if (type === "pr") return { entityType: "purchase_request", entityId: id };
  if (type === "rfq") return { entityType: "rfq", entityId: id };
  if (type === "grn") return { entityType: "receiving_doc", entityId: id };
  if (type === "invoice") return { entityType: "supplier_invoice", entityId: id };
  if (type === "sku") return { entityType: "inventory_item", entityId: id };
  return null;
}

function moduleIdForBusinessId(id = "") {
  const type = businessTypeFromId(id);
  if (type === "po") return "procurement:orders";
  if (type === "pr") return "procurement:requests";
  if (type === "rfq") return "procurement:rfq";
  if (type === "grn") return "procurement:receiving";
  if (type === "invoice") return "procurement:invoices";
  if (type === "sku") return "inventory";
  return "overview";
}

function visibleBusinessId(...values: unknown[]) {
  for (const value of values) {
    const found = String(value ?? "").match(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/i)?.[0];
    if (found) return found.toUpperCase();
  }
  return "";
}

function collectBusinessIdsFromCards(cards: AiChatCard[] = []) {
  const grouped: Record<string, string[]> = {};
  const push = (id: unknown) => {
    const value = String(id ?? "").trim().toUpperCase();
    const type = businessTypeFromId(value);
    if (!type) return;
    grouped[type] = grouped[type] || [];
    if (!grouped[type].includes(value)) grouped[type].push(value);
  };
  for (const card of cards) {
    if (card.type === "ai_response_v2") {
      const response = card.data as Record<string, unknown>;
      for (const item of arrayValue(response.keyEvidence)) {
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          push(row.entityId);
          push(visibleBusinessId(row.entityId, row.entityLabel, row.label, row.summary));
        }
      }
      for (const item of arrayValue(response.navigationLinks)) {
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          push(row.entityId);
          push(visibleBusinessId(row.entityId, row.label, row.reason));
        }
      }
    }
    for (const evidence of card.evidence || []) {
      push(evidence.id);
      push(visibleBusinessId(evidence.id, evidence.route, evidence.label, evidence.summary));
    }
    for (const action of card.actions || []) {
      push(String(action.target || "").match(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/i)?.[0]);
      for (const evidence of action.originEvidence || []) {
        push(evidence.id);
        push(visibleBusinessId(evidence.id, evidence.route, evidence.label, evidence.summary));
      }
    }
    const data = card.data || {};
    Object.values(data).forEach((value) => {
      if (typeof value === "string") push(value.match(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/i)?.[0]);
    });
  }
  return grouped;
}

function primaryEntityFromCards(cards: AiChatCard[] = []) {
  for (const card of cards) {
    if (card.type !== "ai_response_v2") continue;
    const response = card.data as Record<string, unknown>;
    const firstEvidence = arrayValue(response.keyEvidence).find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    const id = visibleBusinessId(firstEvidence?.entityId, firstEvidence?.entityLabel, firstEvidence?.label, firstEvidence?.summary);
    if (id) return { type: businessTypeFromId(id), id, label: id };
  }
  for (const card of cards) {
    const data = card.data || {};
    const priorityItems = arrayValue(data.priorityItems);
    const firstPriority = priorityItems.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    const priorityId = firstPriority
      ? visibleBusinessId(firstPriority.id, firstPriority.sourceDocument, firstPriority.title, firstPriority.reason, firstPriority.explanation)
      : "";
    if (priorityId) return { type: businessTypeFromId(priorityId), id: priorityId, label: priorityId };
  }
  for (const card of cards) {
    for (const evidence of card.evidence || []) {
      const id = visibleBusinessId(evidence.id, evidence.route, evidence.label, evidence.summary);
      if (id) return { type: businessTypeFromId(id), id, label: id };
    }
  }
  return null;
}

function buildSessionGrounding(messages: AiChatMessage[], activeContext: ActiveContext | null): AiSessionGrounding {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.cards?.length);
  const cards = assistant?.cards || [];
  const lastVisibleBusinessIds = collectBusinessIdsFromCards(cards);
  const lastEvidenceIds = Object.values(lastVisibleBusinessIds).flat().slice(0, 12);
  const primaryType = Object.keys(lastVisibleBusinessIds).find((type) => lastVisibleBusinessIds[type]?.length === 1);
  const primaryId = primaryType ? lastVisibleBusinessIds[primaryType]?.[0] : "";
  const primaryEntity = primaryEntityFromCards(cards);
  return {
    lastIntent: cards[0]?.type,
    lastPrimaryEntity: primaryEntity || (primaryId ? { type: primaryType, id: primaryId, label: primaryId } : null),
    lastEvidenceIds,
    lastVisibleBusinessIds,
    activeContext,
  };
}

function safeEntityType(value: unknown) {
  const raw = String(value || "");
  if (/purchase_order|PO/i.test(raw)) return "PO";
  if (/purchase_request|PR/i.test(raw)) return "PR";
  if (/rfq/i.test(raw)) return "RFQ";
  if (/receiving|GRN/i.test(raw)) return "GRN";
  if (/invoice|发票/i.test(raw)) return "Invoice";
  if (/supplier|供应商/i.test(raw)) return "Supplier";
  if (/inventory|item|SKU/i.test(raw)) return "SKU";
  return "Unknown";
}

function latestAiRuntimeResponse(messages: AiChatMessage[]): AiResponseV2 | null {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.cards?.some((card) => card.type === "ai_response_v2"));
  const card = assistant?.cards?.find((item) => item.type === "ai_response_v2");
  return card?.data ? card.data as unknown as AiResponseV2 : null;
}

function buildSafeConversationContext(messages: AiChatMessage[], activeContext: ActiveContext | null, sessionGrounding: AiSessionGrounding): SafeConversationContext {
  const response = latestAiRuntimeResponse(messages);
  const refs: SafeConversationContext["previousEntityRefs"] = [];
  const pushRef = (input: { entityType?: unknown; entityId?: unknown; entityLabel?: unknown; source: string; confidence?: string }) => {
    const entityLabel = textValue(input.entityLabel || input.entityId);
    if (!entityLabel) return;
    const entityId = textValue(input.entityId);
    const key = `${input.source}:${entityId || entityLabel}`;
    if (refs.some((item) => `${item.source}:${item.entityId || item.entityLabel}` === key)) return;
    refs.push({
      entityType: safeEntityType(input.entityType || entityId || entityLabel),
      entityId,
      entityLabel,
      source: input.source,
      confidence: input.confidence || (entityId ? "high" : "medium"),
    });
  };

  if (activeContext?.entityId || activeContext?.entityLabel) {
    pushRef({ entityType: activeContext.entityType, entityId: activeContext.entityId, entityLabel: activeContext.entityLabel, source: "activePage", confidence: "high" });
  }
  if (sessionGrounding.lastPrimaryEntity) {
    pushRef({ entityType: sessionGrounding.lastPrimaryEntity.type, entityId: sessionGrounding.lastPrimaryEntity.id, entityLabel: sessionGrounding.lastPrimaryEntity.label, source: "session", confidence: "high" });
  }
  for (const item of response?.keyEvidence || []) {
    pushRef({ entityType: item.entityType, entityId: item.entityId, entityLabel: item.entityLabel || item.label, source: "evidence", confidence: "high" });
  }
  for (const link of response?.navigationLinks || []) {
    const navEntityType = link.entityType;
    const navEntityId = link.entityId;
    const navLabel = link.label;
    pushRef({ entityType: navEntityType, entityId: navEntityId, entityLabel: navLabel || navEntityId, source: "navigation", confidence: navEntityId ? "high" : "medium" });
  }
  for (const card of response?.reviewCards || []) {
    pushRef({ entityType: card.targetEntityType, entityId: card.targetEntityId, entityLabel: card.title, source: "reviewCard", confidence: card.targetEntityId ? "high" : "medium" });
  }

  return {
    previousIntent: response?.intent || sessionGrounding.lastIntent,
    previousQuestion: response?.query,
    previousConclusionTitle: response?.conclusion?.title,
    previousEntityRefs: refs.slice(0, 12),
    previousNavigationRefs: (response?.navigationLinks || []).slice(0, 8).map((link) => {
      const navEntityType = link.entityType;
      const navEntityId = link.entityId;
      const navLabel = link.label;
      return {
        label: textValue(navLabel || navEntityId || link.moduleId),
        moduleId: link.moduleId,
        entityType: safeEntityType(navEntityType || navEntityId || navLabel),
        entityId: textValue(navEntityId),
        entityLabel: textValue(navLabel || navEntityId),
        returnTo: "ai-assistant",
      };
    }),
    previousEvidenceRefs: (response?.keyEvidence || []).slice(0, 8).map((item) => ({
      id: item.id,
      label: item.label,
      entityType: safeEntityType(item.entityType || item.entityId),
      entityId: item.entityId,
      entityLabel: item.entityLabel,
      moduleId: item.moduleId,
    })),
    previousModuleId: response?.scope?.module || activeContext?.module,
    previousViewId: activeContext?.view,
    previousFocusTarget: activeContext?.entityId ? {
      entityType: activeContext.entityType,
      entityId: activeContext.entityId,
      entityLabel: activeContext.entityLabel || activeContext.entityId,
    } : null,
    breadcrumbTrail: (response?.contextBreadcrumbs || []).slice(0, 4).map((item) => ({
      label: item.label,
      moduleId: item.moduleId,
      entityLabel: item.entityLabel,
      returnTo: "ai-assistant",
    })),
    lastResponseId: (response as (AiResponseV2 & { responseId?: string }) | null)?.responseId,
    returnContext: {
      returnTo: "ai-assistant",
      returnLabel: "返回 AI 助手",
      sourceModuleId: activeContext?.module,
      sourceViewId: activeContext?.view,
    },
  };
}

function uniqueFollowUpChips(chips: { label: string; prompt: string }[]) {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    const key = `${chip.label}|${chip.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function displaySafeAssistantRecoveryMessage(prompt: string) {
  const topic = /收货|GRN|到货/.test(prompt)
    ? "收货异常、采购订单和发票匹配"
    : /库存|SKU|补货|可用量|可承诺量/.test(prompt)
      ? "库存项目、SKU 风险和补货建议"
      : /PO|采购订单/.test(prompt)
        ? "采购订单、收货和供应商证据"
        : "首页、库存管理和来源证据";
  return [
    "证据辅助回答 · 当前工作区数据 · 复核优先",
    "",
    "结论",
    "当前工作区数据暂时未能完整读取，仍可先从相关模块查看来源证据并进入人工复核。",
    "",
    "关键证据",
    `${topic} 可从首页、库存管理、收货记录、采购订单和结算管理继续查看。`,
    "",
    "建议动作",
    "打开今日行动或相关模块查看来源证据，必要时预览草稿并交由人工复核。",
    "",
    "人工复核边界",
    "草稿预览 · 人工复核 · 不提交 · 不外发 · 不写库存 · 不写财务凭证 · 不处理资金 · 不改主数据",
  ].join("\n");
}

function hasRuntimeFollowUpSuggestions(message: AiChatMessage) {
  return Boolean(message.cards?.some((card) =>
    card.type === "ai_response_v2"
    && Array.isArray((card.data as AiResponseV2 | undefined)?.followUpSuggestions)
    && ((card.data as AiResponseV2 | undefined)?.followUpSuggestions || []).length > 0
  ));
}

export function getAiFollowUpChips(message: AiChatMessage) {
  if (message.role !== "assistant" || !message.cards?.length) return [];
  if (hasRuntimeFollowUpSuggestions(message)) return [];
  const ids = collectBusinessIdsFromCards(message.cards);
  const firstPo = ids.po?.[0] || "";
  const firstSku = ids.sku?.[0] || "";
  const firstRfq = ids.rfq?.[0] || "";
  const cardTypes = new Set(message.cards.map((card) => card.type || ""));
  const chips: { label: string; prompt: string }[] = [];

  if (cardTypes.has("procurement_followup_summary") || cardTypes.has("priority_explanation")) {
    if (firstPo) chips.push({ label: "为什么这个 PO 优先？", prompt: "这个 PO 为什么优先？" });
    if (firstSku) chips.push({ label: "查看关联 SKU", prompt: "它和哪个 SKU 有关系？" });
    chips.push({ label: "哪些数据不完整？", prompt: "哪些数据依据不够完整？" });
    if (firstPo || firstRfq) chips.push({ label: "预览跟进草稿", prompt: "预览供应商跟进草稿" });
  }
  if (cardTypes.has("ai_response_v2")) {
    if (firstPo) chips.push({ label: "为什么这个 PO 优先？", prompt: "这个 PO 为什么优先？" });
    if (firstSku) chips.push({ label: "查看关联 SKU", prompt: "这个 SKU 和哪些单据有关？" });
    chips.push({ label: "哪些数据不完整？", prompt: "哪些数据依据不完整？" });
  }
  if (cardTypes.has("inventory_status") || firstSku) {
    chips.push({ label: "需要补货吗？", prompt: "这个 SKU 需要补货吗？" });
    chips.push({ label: "关联哪些采购单？", prompt: "这个 SKU 关联哪些采购单？" });
    chips.push({ label: "预览补货 PR 草稿", prompt: "预览补货 PR 草稿" });
  }
  if (cardTypes.has("rfq_status") || cardTypes.has("rfq_followup") || firstRfq) {
    chips.push({ label: "有几家回复了？", prompt: "刚才那个 RFQ 有几家回复了？" });
    chips.push({ label: "谁还没回复？", prompt: "谁还没回复这个 RFQ？" });
    chips.push({ label: "预览供应商提醒草稿", prompt: "预览供应商提醒草稿" });
  }

  return uniqueFollowUpChips(chips);
}

function AiResponseCards({
  cards = [],
  onNavigate,
  onReviewActionDraft,
  onFollowUp,
}: {
  cards?: AiChatCard[];
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
  onFollowUp?: (prompt: string) => void;
}) {
  const visibleCards = cards.filter((card) => card.type);
  if (!visibleCards.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {visibleCards.map((card, index) => (
        <AiResponseCard key={`${card.type}-${index}`} card={card} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} onFollowUp={onFollowUp} />
      ))}
    </div>
  );
}

function cleanActiveContext(context?: ActiveContext | null) {
  if (!context?.entityType || !context.entityId) return null;
  return {
    module: context.module,
    entityType: context.entityType,
    entityId: context.entityId,
    entityLabel: context.entityLabel,
    view: context.view,
    route: context.route,
  };
}

export default function FloatingAiAssistant({
  moduleId,
  activeContext,
  openSignal,
  onNavigate,
  onReviewActionDraft,
}: {
  moduleId: string;
  activeContext?: ActiveContext | null;
  openSignal?: number;
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const requestInFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const abortReasonRef = useRef<"timeout" | "superseded" | "unmount" | null>(null);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  const minimizeAssistant = () => setOpen(false);
  const restoreAssistant = () => setOpen(true);
  const minimizeAfterNavigate: AiNavigate = (moduleId, focusTarget, options) => {
    onNavigate?.(moduleId, focusTarget || null, { source: "ai", returnTo: activeContext?.route || moduleId, ...options });
    minimizeAssistant();
  };

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open, asking]);

  useEffect(() => {
    return () => {
      abortReasonRef.current = "unmount";
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || restoreButtonRef.current?.contains(target)) return;
      const element = target instanceof Element ? target : null;
      if (element?.closest('[role="dialog"], [data-ai-ignore-outside-minimize="true"]')) return;
      minimizeAssistant();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") minimizeAssistant();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!asking) {
      setSlowRequest(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowRequest(true), 1500);
    return () => window.clearTimeout(timer);
  }, [asking]);

  const currentContext = cleanActiveContext(activeContext);
  const sessionGrounding = useMemo(() => buildSessionGrounding(messages, currentContext), [messages, currentContext]);
  const contextLabel = getAiContextLabel(moduleId, currentContext);
  const inputPlaceholder = getAiInputPlaceholder(moduleId, currentContext);
  const emptyPrompts = currentContext?.entityType === "purchase_order" ? PO_EMPTY_PROMPTS
    : currentContext?.entityType === "item" ? SKU_EMPTY_PROMPTS
      : AI_EMPTY_STATE_PROMPT_CHIPS.map((item) => item.prompt);
  const currentRequestLabel = requestScopeLabel(messages.filter((message) => message.role === "user").at(-1)?.content || input);

  function startNewConversation() {
    abortReasonRef.current = "superseded";
    abortRef.current?.abort();
    requestInFlightRef.current = false;
    setAsking(false);
    setSlowRequest(false);
    setMessages([]);
    setInput("");
  }

  function cancelRequest() {
    abortReasonRef.current = "superseded";
    abortRef.current?.abort();
  }

  async function askAi(text: string) {
    const message = text.trim();
    if (!message || requestInFlightRef.current) return;

    const context = cleanActiveContext(activeContext);
    const requestStartedAt = performance.now();
    const requestId = requestSeqRef.current + 1;
    const controller = new AbortController();
    let timeoutHit = false;
    requestSeqRef.current = requestId;
    requestInFlightRef.current = true;
    abortReasonRef.current = null;
    abortRef.current?.abort();
    abortRef.current = controller;
    setAsking(true);
    setInput("");
    setMessages((current) => [...current, { role: "user", content: message }]);
    const timeout = window.setTimeout(() => {
      timeoutHit = true;
      abortReasonRef.current = "timeout";
      controller.abort();
    }, 12000);

    try {
      const safeConversationContext = buildSafeConversationContext(messages, context, sessionGrounding);
      const response = await postAiRuntimeResponse({
        message,
        activeModuleId: moduleId,
        activeViewId: context?.view,
        focusTarget: focusTargetFromActiveContext(context),
        conversationContext: {
          ...safeConversationContext,
          previousQuestion: safeConversationContext.previousQuestion || sessionGrounding.lastIntent,
          previousAnswerSummary: sessionGrounding.lastPrimaryEntity?.label,
          userIntentLabel: context?.entityLabel || contextLabel,
        },
        sessionGrounding,
        returnTo: "ai-assistant",
      }, controller.signal);
      const rawContent = response.runtimeModeLabel || "";
      const content = "";
      if (looksLikeRawJson(rawContent)) console.debug("AI assistant raw content suppressed", rawContent);
      if (import.meta.env.DEV) {
        console.debug("AI assistant request completed", {
          elapsedMs: Math.round(performance.now() - requestStartedAt),
          cards: 1,
        });
      }
      if (requestSeqRef.current !== requestId) return;
      setMessages((current) => [
        ...current,
        { role: "assistant", content, cards: [{ type: "ai_response_v2", data: response as unknown as Record<string, unknown> }] },
      ]);
    } catch (error) {
      if (requestSeqRef.current !== requestId || abortReasonRef.current === "unmount" || abortReasonRef.current === "superseded") return;
      if (import.meta.env.DEV) {
        console.warn("AI assistant request failed", {
          elapsedMs: Math.round(performance.now() - requestStartedAt),
          timeout: timeoutHit || abortReasonRef.current === "timeout",
          name: error instanceof Error ? error.name : "unknown",
          healthCheck: "/api/health",
          devHint: "Check npm run api, /api/health, SCM_API_PROXY_TARGET, stale node on 8787, current HEAD with git rev-parse --short HEAD, browser refresh, and UTF-8 byte bodies for PowerShell Chinese prompt tests.",
        });
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: displaySafeAssistantRecoveryMessage(message),
          retryPrompt: message,
        },
      ]);
    } finally {
      window.clearTimeout(timeout);
      if (requestSeqRef.current === requestId) {
        requestInFlightRef.current = false;
        abortRef.current = null;
        abortReasonRef.current = null;
        setAsking(false);
      }
    }
  }

  return (
    <div className="fixed right-3 bottom-3 z-40 pointer-events-none sm:right-5 sm:bottom-5" data-testid="ai-assistant-root">
      {open && (
        <div
          ref={panelRef}
          data-testid="ai-assistant-panel"
          className={`${expanded ? "w-[min(760px,calc(100vw-24px))]" : "w-[min(460px,calc(100vw-24px))]"} pointer-events-auto mb-3 flex h-[min(72vh,760px)] max-h-[calc(100vh-88px)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl`}
          style={{ border: `1px solid ${A.border}` }}
        >
          <div className="h-12 px-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${A.border}` }}>
            <div className="min-w-0">
              <div className="text-sm font-semibold flex items-center gap-2" style={{ color: A.label }}>
                <Sparkles size={15} style={{ color: A.blue }} />
                AI 助手
              </div>
              <div data-testid="ai-context-chip" className="text-[11px] truncate" style={{ color: A.gray2 }}>
                当前上下文：{contextLabel}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={startNewConversation} className="flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium hover:bg-slate-100" style={{ color: A.gray1 }} aria-label="新对话"><Plus size={13} />新对话</button>
              <button type="button" onClick={() => setExpanded((value) => !value)} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }} aria-label={expanded ? "收起 AI 工作区" : "展开 AI 工作区"}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
              <button type="button" onClick={minimizeAssistant} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }} aria-label="最小化 AI 助手"><X size={15} /></button>
            </div>
          </div>

          <div ref={scrollRef} data-testid="ai-assistant-messages" className="min-h-0 flex-1 overflow-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="rounded-xl px-3 py-3 space-y-3" style={{ background: A.gray6, color: A.sub }}>
                <p data-testid="ai-runtime-boundary" className="text-xs leading-5" style={{ color: A.gray1 }}>基于当前工作区数据 · 涉及业务变更时需要确认</p>
                <p className="text-xs leading-5" style={{ color: A.sub }}>直接提问，我会先给出结论、重点事项和建议下一步。</p>
                <div className="flex flex-wrap gap-2">
                  {emptyPrompts.slice(0, 4).map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => askAi(prompt)}
                      disabled={asking}
                      data-testid="ai-empty-prompt-chip"
                      className="rounded-full px-2.5 py-1 text-[11px] font-medium hover:bg-slate-100 disabled:cursor-not-allowed"
                      style={{ background: A.white, color: asking ? A.gray3 : A.gray1, border: `1px solid ${A.border}` }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  data-testid={message.role === "assistant" ? "ai-message-assistant" : "ai-message-user"}
                  className="max-w-[86%] rounded-2xl px-3 py-2 text-sm leading-6"
                  style={{
                    background: message.role === "user" ? A.blue : A.gray6,
                    color: message.role === "user" ? A.white : A.label,
                  }}
                >
                  {message.content ? <div className="whitespace-pre-wrap">{message.content}</div> : null}
                  {message.role === "assistant" && <AiResponseCards cards={message.cards} onNavigate={minimizeAfterNavigate} onReviewActionDraft={onReviewActionDraft} onFollowUp={askAi} />}
                  {message.role === "assistant" && getAiFollowUpChips(message).length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {getAiFollowUpChips(message).map((chip) => (
                        <button
                          key={`${chip.label}-${chip.prompt}`}
                          type="button"
                          onClick={() => askAi(chip.prompt)}
                          disabled={asking}
                          data-testid="ai-follow-up-chip"
                          className="rounded-full px-2.5 py-1 text-[11px] font-medium disabled:cursor-not-allowed"
                          style={{ background: A.white, color: asking ? A.gray3 : A.blue, border: `1px solid ${A.border}` }}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {message.role === "assistant" && message.retryPrompt ? (
                    <button
                      type="button"
                      onClick={() => askAi(message.retryPrompt || "")}
                      disabled={asking}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium disabled:cursor-not-allowed"
                      style={{ background: A.white, color: asking ? A.gray3 : A.blue, border: `1px solid ${A.border}` }}
                    >
                      <RotateCcw size={12} />
                      重试
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {asking && (
              <div className="flex justify-start">
                <div className="rounded-2xl px-3 py-2 text-sm flex items-center gap-2" style={{ background: A.gray6, color: A.gray1 }}>
                  <Loader2 size={14} className="animate-spin" />
                  {slowRequest ? currentRequestLabel : "正在确认查询范围"}
                </div>
              </div>
            )}
          </div>

          <div className="px-4 pb-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                data-testid="ai-assistant-input"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!asking) askAi(input);
                  }
                }}
                disabled={asking}
                rows={1}
                placeholder={inputPlaceholder}
                onInput={(event) => { const target = event.currentTarget; target.style.height = "auto"; target.style.height = `${Math.min(target.scrollHeight, 96)}px`; }}
                className="min-h-10 max-h-24 flex-1 resize-none overflow-y-auto rounded-xl px-3 py-2 text-sm outline-none disabled:cursor-not-allowed"
                style={{ background: A.gray6, color: A.label, fontFamily: "inherit" }}
              />
              <button
                onClick={() => asking ? cancelRequest() : askAi(input)}
                disabled={!asking && !input.trim()}
                data-testid="ai-assistant-send"
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white disabled:cursor-not-allowed"
                style={{ background: asking || input.trim() ? A.blue : A.gray3 }}
                aria-label={asking ? "取消请求" : "发送"}
              >
                {asking ? <Square size={14} /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        ref={restoreButtonRef}
        onClick={() => open ? minimizeAssistant() : restoreAssistant()}
        data-testid="ai-assistant-toggle"
        className="pointer-events-auto h-12 rounded-full pl-4 pr-5 flex items-center gap-2 text-sm font-semibold text-white shadow-xl hover:shadow-2xl transition-shadow"
        style={{ background: A.blue }}
        aria-label={open ? "最小化 AI 助手" : "展开 AI 助手"}
      >
        <MessageCircle size={18} />
        AI 助手
      </button>
    </div>
  );
}
