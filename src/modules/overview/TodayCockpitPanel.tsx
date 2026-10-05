import { Sparkles } from "lucide-react";
import { A, Card, Chip } from "../../components/ui";
import {
  tableBodyTextClass,
  tableLinkClass,
  tdClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericRightClass,
  thClass,
  thRightClass,
} from "../../components/ui/workbenchTable";
import { evidenceModuleId, normalizeTodayCockpitTarget, type CanonicalFocusTarget } from "../../lib/evidenceLinks";
import { fmt } from "../../lib/format";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";
import type {
  TodayCockpitAction,
  TodayCockpitCard,
  TodayCockpitDocument,
  TodayCockpitInventoryRisk,
  TodayCockpitResponse,
  TodayCockpitSeverity,
} from "./todayCockpit";

type TodayCockpitPanelProps = {
  cockpit: TodayCockpitResponse | null;
  loading: boolean;
  error?: boolean;
  onNavigate: (moduleId: string, focusTarget?: CanonicalFocusTarget | null, options?: { returnTo?: string; entityLabel?: string; returnContext?: any; source?: string }) => void;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
};

function cockpitSeverityStyle(severity: TodayCockpitSeverity) {
  if (severity === "high" || severity === "高") return { color: A.red, bg: "#fff1f0", label: "高" };
  if (severity === "medium" || severity === "中") return { color: A.orange, bg: "#fff8f0", label: "中" };
  return { color: A.green, bg: "#f0faf4", label: "低" };
}
function cockpitTargetModule(target?: { module?: string }, fallback?: string) {
  return target?.module || fallback || "overview";
}

function cockpitCardValue(card: TodayCockpitCard) {
  if (card.valueKind === "currency") return fmt(Number(card.value || 0));
  return typeof card.value === "number" ? card.value.toLocaleString() : String(card.value || "0");
}

function documentTypeLabel(type: TodayCockpitDocument["type"]) {
  const labels: Record<string, string> = {
    pr: "PR",
    rfq: "RFQ",
    po: "PO",
    grn: "GRN",
    invoice: "Invoice",
    threeWayMatch: "3WM",
  };
  return labels[type] || type;
}

function procurementModuleForDocument(type?: string) {
  if (type === "pr") return "procurement:requests";
  if (type === "rfq") return "procurement:rfq";
  if (type === "po") return "procurement:orders";
  if (type === "grn") return "procurement:receiving";
  if (type === "invoice" || type === "threeWayMatch") return "procurement:bills";
  return "procurement";
}

function quantityText(value?: number | null, unit = "") {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toLocaleString()} ${unit}`.trim();
}

function firstEvidence(item: { evidence?: unknown[] }) {
  return Array.isArray(item.evidence) ? item.evidence[0] as Record<string, unknown> | undefined : undefined;
}

function evidenceText(evidence: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = evidence?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function actionEntityId(item: TodayCockpitAction, evidence: Record<string, unknown> | undefined) {
  const target = item.target || {};
  return String(target.entityId || evidence?.id || "").trim();
}

function actionSku(item: TodayCockpitAction, evidence: Record<string, unknown> | undefined) {
  const entityId = actionEntityId(item, evidence);
  if (/^SKU-/i.test(entityId)) return entityId;
  return evidenceText(evidence, ["sku", "itemIdOrSku", "itemId", "itemCode"]);
}

function actionSupplier(item: TodayCockpitAction, evidence: Record<string, unknown> | undefined) {
  const target = (item.target || {}) as Record<string, unknown>;
  return String(
    target.supplierId ||
    target.supplierName ||
    evidence?.supplierId ||
    evidence?.supplierName ||
    evidence?.supplier ||
    (evidence?.type === "supplier" ? evidence?.id || evidence?.label : "") ||
    "",
  ).trim();
}

function actionQuantity(evidence: Record<string, unknown> | undefined) {
  return evidenceText(evidence, ["quantity", "suggestedQuantity", "requiredQuantity", "replenishmentQuantity"]);
}

function actionDraftRequest(item: TodayCockpitAction): ActionDraftPreviewRequest | null {
  const evidence = firstEvidence(item);
  const target = item.target || {};
  const entityId = actionEntityId(item, evidence);
  const documentType = String(target.documentType || evidence?.type || "").trim();
  const sku = actionSku(item, evidence);
  const supplierIdOrName = actionSupplier(item, evidence);
  const quantity = actionQuantity(evidence);
  const reason = item.reason || item.nextAction || item.title;
  if (item.module === "inventory" || documentType === "inventory_item" || target.entityType === "inventory_item") {
    return {
      type: "purchase_request_draft",
      title: `${sku || entityId || item.title} 补货 PR 草稿预览`,
      source: "today_cockpit",
      originEvidence: item.evidence as Record<string, unknown>[] || [],
      payload: {
        itemIdOrSku: sku || entityId,
        quantity,
        reason,
      },
    };
  }
  if (item.module === "procurement" || String(target.module || "").startsWith("procurement")) {
    if (documentType === "rfq" || /rfq|报价|询价|寻源/i.test(`${item.title} ${reason}`)) {
      if (!sku) return null;
      return {
        type: "rfq_draft",
        title: `${sku} RFQ 草稿预览`,
        source: "today_cockpit",
        originEvidence: item.evidence as Record<string, unknown>[] || [],
        payload: {
          itemIdOrSku: sku,
          quantity,
          reason,
          relatedDocumentType: documentType,
          relatedDocumentId: entityId,
        },
      };
    }
    if (documentType !== "po" && !supplierIdOrName) return null;
    return {
      type: documentType === "po" ? "po_followup_draft" : "supplier_followup_draft",
      title: `${item.title} 草稿预览`,
      source: "today_cockpit",
      originEvidence: item.evidence as Record<string, unknown>[] || [],
      payload: {
        supplierIdOrName,
        poId: documentType === "po" ? entityId : "",
        message: item.nextAction || item.reason || "请确认当前跟进计划与责任人。",
        relatedDocumentType: documentType,
        relatedDocumentId: entityId,
        reason,
      },
    };
  }
  return null;
}

function TodayCockpitStateCard({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <Card className="p-5">
      <div className="text-[13px] font-semibold" style={{ color: A.label }}>{title}</div>
      <div className="mt-1 text-[12px]" style={{ color: A.sub }}>{message}</div>
    </Card>
  );
}

export function TodayCockpitSummaryCards({
  cards,
  onNavigate,
}: {
  cards: TodayCockpitCard[];
  onNavigate: TodayCockpitPanelProps["onNavigate"];
}) {
  if (!cards.length) {
    return (
      <div className="mt-4 rounded-lg border px-4 py-5 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>
        暂无关键指标
      </div>
    );
  }

  return (
    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const style = cockpitSeverityStyle(card.severity);
        const link = normalizeTodayCockpitTarget(card);
        const moduleId = evidenceModuleId(link) || cockpitTargetModule(card.target, card.module);
        return (
          <button
            key={card.id}
            type="button"
            onClick={() => onNavigate(moduleId, link?.focusTarget || null, {
              returnTo: "overview",
              entityLabel: link?.label || card.title,
              source: "todayCockpit",
              returnContext: { sourceModule: "todayCockpit", sourceRoute: "overview", sourceLabel: card.title, returnLabel: "返回 今日行动", originIntent: "priorityCard" },
            })}
            className="min-h-[118px] rounded-lg border p-3 text-left transition-colors hover:bg-slate-50"
            style={{ borderColor: A.border, background: A.white }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase" style={{ color: A.sub }}>{card.title}</div>
              <Chip label={style.label} color={style.color} bg={style.bg} />
            </div>
            <div className="mt-3 text-[24px] font-semibold tabular-nums" style={{ color: A.label }}>{cockpitCardValue(card)}</div>
            <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: A.sub }}>{card.subtitle}</div>
            {card.evidence?.[0] ? (
              <div className="mt-2 truncate text-[11px]" style={{ color: A.blue }}>{card.evidence[0].id || card.evidence[0].label}</div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TodayCockpitActionList({
  title,
  items,
  onNavigate,
  onReviewActionDraft,
  className = "",
}: {
  title: string;
  items: TodayCockpitAction[];
  onNavigate: TodayCockpitPanelProps["onNavigate"];
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border p-4 ${className}`} style={{ borderColor: A.border, background: A.white }}>
      <div className="text-[13px] font-semibold" style={{ color: A.label }}>{title}</div>
      <div className="mt-3 space-y-3">
        {items.length ? items.map((item) => {
          const style = cockpitSeverityStyle(item.priority);
          const link = normalizeTodayCockpitTarget(item);
          const moduleId = evidenceModuleId(link) || cockpitTargetModule(item.target, item.module);
          const draftRequest = onReviewActionDraft ? actionDraftRequest(item) : null;
          return (
            <div
              key={item.id}
              className="rounded-md border px-3 py-2"
              style={{ borderColor: A.border }}
            >
              <button type="button" onClick={() => onNavigate(moduleId, link?.focusTarget || null, {
                returnTo: "overview",
                entityLabel: link?.label || item.title,
                source: "todayCockpit",
                returnContext: { sourceModule: "todayCockpit", sourceRoute: "overview", sourceLabel: item.title, returnLabel: "返回 今日行动", originIntent: item.id },
              })} className="w-full text-left">
                <div className="flex items-center gap-2">
                  <Chip label={style.label} color={style.color} bg={style.bg} />
                  <div className="min-w-0 truncate text-[12px] font-semibold" style={{ color: A.label }}>{item.title}</div>
                </div>
                <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: A.sub }}>{item.reason || item.nextAction || "等待复核"}</div>
                {item.nextAction ? <div className="mt-1 text-[11px]" style={{ color: A.blue }}>{item.nextAction}</div> : null}
              </button>
              {draftRequest ? (
                <button
                  type="button"
                  onClick={() => onReviewActionDraft?.(draftRequest)}
                  className="mt-2 rounded-md px-2.5 py-1 text-[11px] font-medium"
                  style={{ background: "#f0f6ff", color: A.blue }}
                >
                  草稿预览
                </button>
              ) : onReviewActionDraft ? (
                <div className="mt-2 text-[11px]" style={{ color: A.sub }}>
                  当前动作需要人工复核，尚未接入草稿预览。
                </div>
              ) : null}
            </div>
          );
        }) : (
          <div className="rounded-md border px-3 py-3 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>暂无待处理事项</div>
        )}
      </div>
    </div>
  );
}

export function TodayCockpitFollowups({
  items,
  onNavigate,
}: {
  items: TodayCockpitAction[];
  onNavigate: TodayCockpitPanelProps["onNavigate"];
}) {
  return <TodayCockpitActionList title="优先跟进" items={items} onNavigate={onNavigate} />;
}

export function TodayCockpitInventoryRisks({
  items,
  onNavigate,
}: {
  items: TodayCockpitInventoryRisk[];
  onNavigate: TodayCockpitPanelProps["onNavigate"];
}) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: A.border, background: A.white }}>
      <div className="text-[13px] font-semibold" style={{ color: A.label }}>库存风险</div>
      <div className="mt-3 space-y-3">
        {items.length ? items.map((item) => {
          const style = cockpitSeverityStyle(item.severity);
          const link = normalizeTodayCockpitTarget(item);
          const moduleId = evidenceModuleId(link) || cockpitTargetModule(item.target, "inventory");
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(moduleId, link?.focusTarget || null, {
                returnTo: "overview",
                entityLabel: link?.label || item.sku || item.id,
                source: "todayCockpit",
                returnContext: { sourceModule: "todayCockpit", sourceRoute: "overview", sourceLabel: item.sku || item.id, returnLabel: "返回 今日行动", originIntent: item.id },
              })}
              className="w-full rounded-md border px-3 py-2 text-left hover:bg-slate-50"
              style={{ borderColor: A.border }}
            >
              <div className="flex items-center gap-2">
                <Chip label={style.label} color={style.color} bg={style.bg} />
                <div className="min-w-0 truncate text-[12px] font-semibold" style={{ color: A.label }}>{item.sku || item.id}</div>
                <div className="truncate text-[11px]" style={{ color: A.sub }}>{item.itemName || item.type}</div>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2 text-[11px]" style={{ color: A.sub }}>
                <span>可用 {quantityText(item.availableQuantity, item.unit)}</span>
                <span>ROP {quantityText(item.reorderPoint, item.unit)}</span>
                <span>安全 {quantityText(item.safetyStock, item.unit)}</span>
              </div>
              <div className="mt-1 truncate text-[11px]" style={{ color: A.blue }}>{item.nextAction || item.status || "复核库存证据"}</div>
            </button>
          );
        }) : (
          <div className="rounded-md border px-3 py-3 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>暂无库存风险</div>
        )}
      </div>
    </div>
  );
}

export function TodayCockpitRecentDocuments({
  documents,
  onNavigate,
}: {
  documents: TodayCockpitDocument[];
  onNavigate: TodayCockpitPanelProps["onNavigate"];
}) {
  return (
    <div className="overflow-hidden rounded-lg border xl:col-span-3" style={{ borderColor: A.border }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ background: "#f8fafc" }}>
        <div className="text-[13px] font-semibold" style={{ color: A.label }}>近期单据</div>
        <div className="text-[11px]" style={{ color: A.sub }}>{documents.length} 条</div>
      </div>
      <div className="overflow-x-auto">
        <table className={`min-w-[760px] w-full ${tableBodyTextClass}`}>
          <thead style={{ background: "#fbfdff", color: A.sub }}>
            <tr>
              <th className={thClass}>类型</th>
              <th className={thClass}>单号</th>
              <th className={thClass}>状态</th>
              <th className={thClass}>供应商</th>
              <th className={thRightClass}>金额</th>
              <th className={thClass}>日期</th>
            </tr>
          </thead>
          <tbody>
            {documents.length ? documents.map((doc, index) => (
              <tr key={`${doc.type}-${doc.id}`} style={{ borderTop: index ? `1px solid ${A.border}` : "none" }}>
                <td className={tdClass}><Chip label={documentTypeLabel(doc.type)} color={A.blue} bg="#eef4ff" /></td>
                <td className={tdIdClass} style={{ color: A.blue }}>
                  {(() => {
                    const link = normalizeTodayCockpitTarget(doc);
                    const moduleId = evidenceModuleId(link);
                    return link?.clickable && moduleId ? (
                      <button type="button" onClick={() => onNavigate(moduleId, link.focusTarget || null, {
                        returnTo: "overview",
                        entityLabel: link.label || doc.id,
                        source: "todayCockpit",
                        returnContext: { sourceModule: "todayCockpit", sourceRoute: "overview", sourceLabel: doc.id, returnLabel: "返回 今日行动", originIntent: "recentDocument" },
                      })} className={tableLinkClass}>
                        {doc.id}
                      </button>
                    ) : doc.id;
                  })()}
                </td>
                <td className={tdNowrapClass} style={{ color: A.label }}>{doc.status || "—"}</td>
                <td className={`${tdNameClass} max-w-[180px] truncate`} style={{ color: A.sub }}>{doc.supplier || "—"}</td>
                <td className={tdNumericRightClass} style={{ color: A.label }}>{doc.amount ? fmt(Number(doc.amount)) : "—"}</td>
                <td className={tdNowrapClass} style={{ color: A.sub }}>{doc.date || "—"}</td>
              </tr>
            )) : (
              <tr>
                <td className="px-4 py-5" colSpan={6} style={{ color: A.sub }}>暂无近期单据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TodayCockpitRecommendedActions({
  items,
  onNavigate,
  onReviewActionDraft,
}: {
  items: TodayCockpitAction[];
  onNavigate: TodayCockpitPanelProps["onNavigate"];
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
}) {
  return <TodayCockpitActionList title="建议动作" items={items} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} className="xl:col-span-2" />;
}

export function TodayCockpitPanel({ cockpit, loading, error = false, onNavigate, onReviewActionDraft }: TodayCockpitPanelProps) {
  if (!cockpit && loading) {
    return <TodayCockpitStateCard title="今日驾驶舱正在加载" message="正在读取采购、库存和单据证据。" />;
  }

  if (!cockpit && error) {
    return <TodayCockpitStateCard title="今日驾驶舱暂不可用" message="可继续使用下方工作台处理采购、库存和单据。" />;
  }

  if (!cockpit) return <TodayCockpitStateCard title="今日驾驶舱暂无数据" message="可继续使用下方工作台查看业务状态。" />;

  const followups = cockpit.followups.slice(0, 4).map((item) => ({
    id: item.id,
    priority: item.severity,
    title: item.title,
    reason: item.summary || item.message || item.status,
    nextAction: item.dueDate ? `截止 ${item.dueDate}` : item.supplierName || "等待复核",
    evidence: item.evidence ? [item.evidence] : [],
    target: { module: procurementModuleForDocument(item.documentType), documentType: item.documentType, entityId: item.documentId },
  }));
  const inventoryRisks = cockpit.inventoryRisks.slice(0, 4);
  const documents = cockpit.recentDocuments.slice(0, 6);
  const actions = cockpit.recommendedActions.slice(0, 4);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={16} color={A.blue} />
            <div className="text-[13px] font-semibold" style={{ color: A.blue }}>今日驾驶舱 v2</div>
          </div>
          <h2 className="text-[20px] font-semibold tracking-normal" style={{ color: A.label }}>今日采购与库存工作台</h2>
          <p className="mt-1 text-[12px]" style={{ color: A.sub }}>
            {Number(cockpit.summary.urgentFollowupCount || 0).toLocaleString()} 个紧急跟进 · {Number(cockpit.summary.lowStockCount || 0).toLocaleString()} 个库存风险 · 开放金额 {fmt(Number(cockpit.summary.totalOpenAmount || 0))}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate("procurement")}
          className="rounded-md border px-3 py-2 text-[12px] font-medium hover:bg-slate-50"
          style={{ borderColor: A.border, color: A.label }}
        >
          打开采购工作台
        </button>
      </div>

      <div className="mt-4 rounded-lg p-4" style={{ background: A.gray6, border: "0.5px solid rgba(0,0,0,0.06)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>运营控制塔</div>
            <div className="text-[11px] leading-5 mt-1" style={{ color: A.sub }}>
              工作项按紧急、需复核、等待供应商、等待内部、已解决待关闭和数据缺口分组，并结合现有工单去重。
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 text-[11px]">
            {["生成内部跟进草稿", "跟进备注草稿", "风险信号"].map((label) => (
              <span key={label} className="rounded-md px-2.5 py-1 font-medium" style={{ background: A.white, color: A.blue }}>{label}</span>
            ))}
          </div>
        </div>
      </div>

      <TodayCockpitSummaryCards cards={cockpit.cards} onNavigate={onNavigate} />

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TodayCockpitFollowups items={followups} onNavigate={onNavigate} />
        <TodayCockpitInventoryRisks items={inventoryRisks} onNavigate={onNavigate} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-5">
        <TodayCockpitRecentDocuments documents={documents} onNavigate={onNavigate} />
        <TodayCockpitRecommendedActions items={actions} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} />
      </div>
    </Card>
  );
}
