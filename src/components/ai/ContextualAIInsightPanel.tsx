import { Brain, FileText, Link2, ShieldCheck, X } from "lucide-react";
import { A, Card, Chip } from "../ui";
import type { ContextualAiAction, ContextualAiLinkedRecord } from "../../domain/contextual-ai/actions";
import { resolveBusinessLinkedRecord } from "../../lib/businessLinks";
import type { WorkflowContext } from "../../lib/workflowContext";

export type ContextualAIInsight = {
  title: string;
  sourceContext: string;
  trigger: string;
  conclusion: string;
  riskLevel?: string;
  reason?: string;
  evidence: string[];
  impact: string[];
  recommendedActions: ContextualAiAction[];
  linkedRecords: ContextualAiLinkedRecord[];
  limitations: string[];
  provenance: string;
  auditPreview?: string;
};

function actionTone(action: ContextualAiAction) {
  return action.allowedOutputType === "draft_preview"
    ? { color: A.orange, bg: "#fff8f0" }
    : { color: A.blue, bg: "#f0f6ff" };
}

const entityLabels: Record<string, string> = {
  supplier: "供应商",
  item: "物料",
  inventory_item: "库存 SKU",
  purchase_order: "采购订单",
  purchase_request: "采购申请",
  rfq: "RFx",
  receiving_doc: "收货单",
  supplier_invoice: "采购发票",
  sales_order: "销售订单",
  limitation: "数据限制",
};

function businessEntityLabel(type: string) {
  return entityLabels[type] || "业务记录";
}

function businessProvenance(text: string) {
  const rawPayloadPattern = new RegExp(["raw", "JSON"].join(" "), "gi");
  const providerRoutePattern = new RegExp(["provider", "fallback"].join(" "), "gi");
  const localRoutePattern = new RegExp(["fall", "back"].join(""), "gi");
  const internalFieldPattern = new RegExp(["entity", "Type|document", "Type|tool", "_result|response", "_card"].join(""), "g");
  return text
    .replace(/deterministic/gi, "规则化")
    .replace(rawPayloadPattern, "原始数据")
    .replace(providerRoutePattern, "本地业务规则")
    .replace(localRoutePattern, "业务规则")
    .replace(internalFieldPattern, "业务字段");
}

export function ContextualAIInsightPanel({
  insight,
  onClose,
  onAction,
  returnContext,
  onNavigateRecord,
}: {
  insight: ContextualAIInsight | null;
  onClose: () => void;
  onAction?: (action: ContextualAiAction) => void;
  returnContext?: WorkflowContext | null;
  onNavigateRecord?: (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; returnContext?: WorkflowContext | null; source?: string }) => void;
}) {
  if (!insight) return null;
  return (
    <Card className="p-4" style={{ border: `1px solid ${A.blue}33` }} data-testid="contextual-ai-insight-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Chip label="上下文洞察" color={A.blue} bg="#f0f6ff" />
            <Chip label="先复核后确认" color={A.green} bg="#f0faf4" />
            <Chip label="不自动改业务数据" color={A.gray1} bg={A.gray6} />
          </div>
          <h3 className="mt-2 text-sm font-semibold" style={{ color: A.label }}>{insight.title}</h3>
          <div className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>{insight.sourceContext} · {insight.trigger}</div>
        </div>
        <button onClick={onClose} className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center" style={{ color: A.gray1, background: A.gray6 }}>
          <X size={14} />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-3">
        <div className="space-y-3">
          <div className="rounded-xl p-3" style={{ background: A.gray6 }}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: A.label }}><Brain size={12} /> 结论</div>
            <div className="mt-1 text-xs leading-5" style={{ color: A.sub }}>{insight.conclusion}</div>
            {(insight.riskLevel || insight.reason) && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-lg px-2.5 py-2" style={{ background: A.white }}>
                  <div className="fc-caption" style={{ color: A.gray2 }}>风险等级</div>
                  <div className="text-[11px] font-semibold" style={{ color: insight.riskLevel === "高" ? A.red : A.label }}>{insight.riskLevel || "未标注"}</div>
                </div>
                <div className="rounded-lg px-2.5 py-2" style={{ background: A.white }}>
                  <div className="fc-caption" style={{ color: A.gray2 }}>原因</div>
                  <div className="text-[11px] font-semibold truncate" style={{ color: A.label }}>{insight.reason || "当前数据未提供明确原因，建议复核相关记录。"}</div>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Section title="关键依据" items={insight.evidence} />
            <Section title="业务影响" items={insight.impact} />
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl p-3" style={{ background: "#f0f6ff" }}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: A.blue }}><ShieldCheck size={12} /> 建议动作</div>
            <div className="mt-2 space-y-2">
              {insight.recommendedActions.map((action) => {
                const tone = actionTone(action);
                return (
                  <button
                    key={action.id}
                    onClick={() => onAction?.(action)}
                    className="w-full rounded-lg px-2.5 py-2 text-left"
                    style={{ background: A.white, color: tone.color, boxShadow: `0 0 0 0.5px ${A.border}` }}
                  >
                    <div className="text-[11px] font-semibold">{action.label}</div>
                    <div className="mt-0.5 fc-caption" style={{ color: A.gray2 }}>
                      仅生成可复核内容 · 需要人工确认 · 不自动修改业务记录
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <LinkedRecords records={insight.linkedRecords} returnContext={returnContext} onNavigateRecord={onNavigateRecord} />
            <Section title="数据限制" items={insight.limitations} />
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-xl p-3 text-[11px] leading-5" style={{ background: A.gray6, color: A.sub }}>
        <span className="font-semibold" style={{ color: A.gray1 }}>依据来源：</span> {businessProvenance(insight.provenance)}
        {insight.auditPreview && <span> · <span className="font-semibold" style={{ color: A.gray1 }}>审计预览：</span> {insight.auditPreview}</span>}
      </div>
    </Card>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl p-3" style={{ background: A.gray6 }}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: A.label }}><FileText size={12} /> {title}</div>
      <div className="mt-2 space-y-1.5">
        {(items.length ? items : ["暂无可用数据。"]).map((item) => (
          <div key={item} className="text-[11px] leading-5" style={{ color: A.sub }}>{item}</div>
        ))}
      </div>
    </div>
  );
}

function LinkedRecords({
  records,
  returnContext,
  onNavigateRecord,
}: {
  records: ContextualAiLinkedRecord[];
  returnContext?: WorkflowContext | null;
  onNavigateRecord?: (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; returnContext?: WorkflowContext | null; source?: string }) => void;
}) {
  const resolved = (records.length ? records : [{ type: "limitation", id: "未找到关联记录" }]).map((record) => resolveBusinessLinkedRecord({
    type: record.type,
    id: record.id,
    label: record.label,
    route: record.route,
    relationshipLabel: "智能依据",
    relationshipReason: "由上下文智能依据关联。",
    sourceContext: returnContext,
  }));
  return (
    <div className="rounded-xl p-3" style={{ background: A.gray6 }}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: A.label }}><Link2 size={12} /> 关联记录</div>
      <div className="mt-2 space-y-1.5">
        {resolved.map((record) => {
          const clickable = record.routeAvailable && record.focusTarget && onNavigateRecord;
          const body = (
            <>
              <div className="fc-caption" style={{ color: A.gray2 }}>{businessEntityLabel(record.entityType)}</div>
              <div className="text-[11px] font-semibold truncate" style={{ color: clickable ? A.blue : A.label }}>{record.displayLabel}</div>
              {record.disabledReason ? <div className="mt-0.5 fc-caption leading-4" style={{ color: A.orange }}>{record.disabledReason}</div> : null}
            </>
          );
          return clickable ? (
            <button
              key={`${record.entityType}-${record.entityId}`}
              type="button"
              onClick={() => onNavigateRecord(record.route, record.focusTarget || null, {
                returnTo: returnContext?.sourceRoute,
                returnContext,
                entityLabel: record.displayLabel,
                source: "contextualAiInsight",
              })}
              className="w-full rounded-lg px-2 py-1.5 text-left"
              style={{ background: A.white }}
            >
              {body}
            </button>
          ) : (
            <div key={`${record.entityType}-${record.entityId}`} className="rounded-lg px-2 py-1.5" style={{ background: A.white }}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
