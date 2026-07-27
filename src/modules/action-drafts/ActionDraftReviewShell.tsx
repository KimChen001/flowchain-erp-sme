import { Copy, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { A, Chip, Modal, RecoveryActions } from "../../components/ui";
import { typography } from "../../components/ui/typography";
import { navigationIntentFromEvidenceLink, normalizeEvidenceLinks, type CanonicalFocusTarget } from "../../lib/evidenceLinks";

export type ActionDraftPreviewRequest = {
  type: string;
  title?: string;
  source?: string;
  originEvidence?: Record<string, unknown>[];
  payload?: Record<string, unknown>;
};

export type ActionDraftPreview = {
  id: string;
  type: string;
  title: string;
  status: string;
  source: string;
  updatedAt?: string;
  requiresConfirmation: boolean;
  originEvidence?: Record<string, unknown>[];
  payload?: Record<string, unknown>;
  validation?: {
    ok?: boolean;
    status?: string;
    errors?: string[];
    missingFields?: string[];
  };
  auditTrail?: { action?: string; summary?: string; timestamp?: string }[];
  confirmationBoundary?: {
    previewOnly?: boolean;
    submitted?: boolean;
    requiresUserReview?: boolean;
    futureConfirmation?: string;
  };
};

function text(value: unknown) {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : "—";
  return String(value);
}

function compactObject(value: Record<string, unknown>) {
  return [
    value.supplierId || value.supplierIdOrName || value.supplierName || value.name,
    value.itemIdOrSku || value.sku || value.itemName,
    value.documentId || value.poId || value.rfqId || value.id,
    value.status || value.reason,
  ].filter(Boolean).map(text).slice(0, 3).join(" · ");
}

function businessValue(value: unknown) {
  if (Array.isArray(value)) {
    const items = value.map((item) => typeof item === "object" && item ? compactObject(item as Record<string, unknown>) : text(item)).filter(Boolean);
    return items.length ? items.slice(0, 3).join("；") : "—";
  }
  if (typeof value === "object" && value) return compactObject(value as Record<string, unknown>) || "需人工复核";
  return text(value);
}

function payloadLabel(key: string) {
  const labels: Record<string, string> = {
    itemIdOrSku: "物料 / SKU",
    itemName: "物料名称",
    warehouse: "仓库",
    warehouseId: "仓库",
    suggestedQuantity: "建议数量",
    quantity: "数量",
    unit: "单位",
    reason: "原因",
    supplierSuggestion: "供应商建议",
    supplierCandidates: "候选供应商",
    requestedDeliveryDate: "期望交期",
    quotationDeadline: "报价截止",
    supplierIdOrName: "供应商",
    supplierId: "供应商编码",
    supplierName: "供应商名称",
    relatedDocumentType: "关联单据类型",
    relatedDocumentId: "关联单据",
    followupReason: "跟进原因",
    messageDraft: "消息草稿",
    message: "消息草稿",
    severity: "优先级",
    urgency: "紧急程度",
    dueDate: "截止日期",
    availableQuantity: "可用库存",
    reorderPoint: "再订货点",
    safetyStock: "安全库存",
  };
  return labels[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function copyTextForDraft(draft: ActionDraftPreview | null) {
  if (!draft) return "";
  const payload = Object.entries(draft.payload || {})
    .map(([key, value]) => `${payloadLabel(key)}: ${businessValue(value)}`)
    .join("\n");
  const warnings = draft.validation?.errors?.length ? `\n校验：${draft.validation.errors.join("; ")}` : "";
  return `${draft.title}\n类型：${draft.type}\n状态：${draft.status}\n${payload}${warnings}`.trim();
}

function draftTypeLabel(type?: string) {
  const labels: Record<string, string> = {
    purchase_request_draft: "PR 草稿",
    rfq_draft: "RFQ 草稿",
    supplier_followup_draft: "供应商跟进备注草稿",
    po_followup_draft: "PO 跟进备注草稿",
    exception_note: "工单备注草稿",
  };
  return labels[type || ""] || "业务动作草稿";
}

function draftStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    preview: "仅预览",
    draft: "草稿",
    review_required: "需人工复核",
    draft_only_requires_review: "仅生成草稿 / 需人工复核",
  };
  return labels[status || ""] || "需人工复核";
}

function draftSourceLabel(source?: string) {
  const labels: Record<string, string> = {
    inventory_replenishment: "库存补货",
    today_cockpit: "今日驾驶舱",
    ai_assistant: "智能洞察",
    procurement_followup: "采购跟进",
    supplier_followup: "供应商跟进",
  };
  return labels[source || ""] || "业务上下文";
}

function isEditableScalar(value: unknown) {
  return ["string", "number", "boolean"].includes(typeof value) || value === null || value === undefined;
}

function editValue(raw: string, original: unknown) {
  if (typeof original === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : original;
  }
  if (typeof original === "boolean") return raw === "true";
  return raw;
}

const draftButtonClass = `h-8 rounded-lg px-3 ${typography.denseButton} disabled:cursor-not-allowed`;
const draftEvidenceTitleClass = `${typography.metadata} font-semibold`;
const draftEvidenceLinkClass = `text-left ${draftEvidenceTitleClass} hover:underline`;
const draftEvidenceMetaClass = typography.compactMetadata;

export function ActionDraftReviewShell({
  open,
  loading = false,
  error = "",
  draft,
  onClose,
  onCancelPreview,
  onSaveDraft,
  onNavigate,
}: {
  open: boolean;
  loading?: boolean;
  error?: string;
  draft: ActionDraftPreview | null;
  onClose: () => void;
  onCancelPreview: () => void;
  onSaveDraft?: (draft: ActionDraftPreview) => Promise<void>;
  onNavigate?: (moduleId: string, focusTarget?: CanonicalFocusTarget | null) => void;
}) {
  const [workingDraft, setWorkingDraft] = useState<ActionDraftPreview | null>(draft);
  const [saveStatus, setSaveStatus] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const activeDraft = workingDraft || draft;
  const validation = activeDraft?.validation;
  const evidence = normalizeEvidenceLinks(activeDraft?.originEvidence || [], { source: "actionDraft" }).slice(0, 6);
  const audit = activeDraft?.auditTrail?.[0];
  const payloadEntries = useMemo(() => Object.entries(activeDraft?.payload || {}), [activeDraft?.payload]);

  useEffect(() => {
    setWorkingDraft(draft);
    setSaveStatus("");
    setSaveError("");
  }, [draft?.id, draft?.updatedAt, open]);

  function updatePayloadField(key: string, value: string, original: unknown) {
    setWorkingDraft((current) => current ? ({
      ...current,
      payload: {
        ...(current.payload || {}),
        [key]: editValue(value, original),
      },
    }) : current);
    setSaveStatus("草稿有未保存的审阅修改");
    setSaveError("");
  }

  function resetDraft() {
    setWorkingDraft(draft);
    setSaveStatus("已重置为预览生成的草稿");
    setSaveError("");
  }

  async function saveDraft() {
    if (!activeDraft || !onSaveDraft) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSaveDraft(activeDraft);
      setSaveStatus("待复核草稿已保留，后续仍需人工确认。");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "草稿保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function copyDraft() {
    const content = copyTextForDraft(activeDraft);
    if (!content || !navigator?.clipboard) return;
    await navigator.clipboard.writeText(content);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={activeDraft?.title || "动作草稿预览"}
      subtitle="文本草稿编辑器：仅用于供应商消息或内部备注，不替代正式业务页面"
      width={860}
      footer={(
        <>
          <RecoveryActions
            actions={[
              { key: "close", label: "关闭", onClick: onClose, kind: "previous" },
              { key: "cancel", label: "取消草稿", onClick: onCancelPreview, kind: "clear", tone: "subtle" },
            ]}
          />
          <button type="button" onClick={resetDraft} disabled={!activeDraft || saving} className={draftButtonClass} style={{ background: A.white, color: activeDraft ? A.gray1 : A.gray2 }}>
            <RotateCcw size={12} className="mr-1 inline" />重置修改
          </button>
          <button type="button" onClick={copyDraft} disabled={!activeDraft} className={draftButtonClass} style={{ background: A.white, color: activeDraft ? A.blue : A.gray2 }}>
            <Copy size={12} className="mr-1 inline" />复制草稿内容
          </button>
          <button type="button" onClick={saveDraft} disabled={!activeDraft || !onSaveDraft || saving} className={draftButtonClass} style={{ background: activeDraft && onSaveDraft ? A.blue : A.gray4, color: A.white }}>
            <Save size={12} className="mr-1 inline" />{saving ? "保留中" : "保留待复核草稿"}
          </button>
        </>
      )}
    >
      {loading ? (
        <div className="rounded-lg border px-4 py-5 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>正在生成草稿预览...</div>
      ) : error ? (
        <div className="rounded-lg border px-4 py-5 text-[12px] leading-5" style={{ borderColor: "#ffd6d6", background: "#fff1f0", color: A.red }}>{error}</div>
      ) : activeDraft ? (
        <div className="space-y-4" data-testid="action-draft-review-shell">
          <section className="rounded-lg px-3 py-3 text-[12px] leading-5" style={{ background: "#f0f6ff", color: A.blue, border: `0.5px solid ${A.blue}30` }}>
            <div className="flex items-start gap-2">
              <ShieldCheck size={15} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">预览 / 留存边界</div>
                <div className="mt-1" style={{ color: A.sub }}>
                  当前工作区允许审阅、复制、编辑简单字段和保留待复核草稿；后续仍受人工确认和安全边界约束。
                </div>
                <div className="mt-1" style={{ color: A.sub }}>
                  危险动作保持关闭：不提交、不外发、不写库存、不写财务凭证、不处理资金。
                </div>
                <div className="mt-1" style={{ color: A.sub }}>
                  草稿预览只用于人工复核，不形成正式业务处理，不改主数据，不覆盖当前工作区数据。
                </div>
              </div>
            </div>
            {(saveStatus || saveError) && (
              <div className="mt-2 text-[11px]" style={{ color: saveError ? A.red : A.green }}>{saveError || saveStatus}</div>
            )}
          </section>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>类型</div>
              <div className="mt-1 text-[12px] font-semibold" style={{ color: A.label }}>{draftTypeLabel(activeDraft.type)}</div>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>状态</div>
              <div className="mt-1"><Chip label={draftStatusLabel(activeDraft.status)} color={A.blue} bg="#eef4ff" /></div>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>来源</div>
              <div className="mt-1 text-[12px] font-semibold" style={{ color: A.label }}>{draftSourceLabel(activeDraft.source)}</div>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>确认边界</div>
              <div className="mt-1 text-[12px] font-semibold" style={{ color: A.orange }}>{activeDraft.requiresConfirmation ? "需要人工确认" : "仅预览"}</div>
            </div>
          </div>

          <section>
            <div className="mb-2 text-[12px] font-semibold" style={{ color: A.label }}>业务内容（简单字段可审阅编辑）</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {payloadEntries.length ? payloadEntries.map(([key, value]) => (
                <div key={key} className="rounded-lg border px-3 py-2" style={{ borderColor: A.border }}>
                  <div className="fc-caption" style={{ color: A.gray2 }}>{payloadLabel(key)}</div>
                  {isEditableScalar(value) ? (
                    typeof value === "boolean" ? (
                      <select value={String(value)} onChange={(event) => updatePayloadField(key, event.target.value, value)} className="mt-1 w-full rounded-md border px-2 py-1 text-[12px] font-semibold outline-none" style={{ borderColor: A.border, color: A.label, background: A.white }}>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : (
                      <input value={value === undefined || value === null ? "" : String(value)} onChange={(event) => updatePayloadField(key, event.target.value, value)} className="mt-1 w-full rounded-md border px-2 py-1 text-[12px] font-semibold outline-none" style={{ borderColor: A.border, color: A.label, background: A.white }} />
                    )
                  ) : (
                    <div className="mt-1 text-[12px] font-semibold leading-5" style={{ color: A.label }}>{businessValue(value)}</div>
                  )}
                </div>
              )) : (
                <div className="rounded-lg border px-3 py-3 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>暂无可展示字段</div>
              )}
            </div>
          </section>

          <section>
            <div className="mb-2 text-[12px] font-semibold" style={{ color: A.label }}>来源证据</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {evidence.length ? evidence.map((link, index) => {
                const intent = navigationIntentFromEvidenceLink(link, { source: "actionDraft" });
                return (
                  <div key={`${link.entityType}-${link.entityId}-${index}`} className="rounded-lg border px-3 py-2" style={{ borderColor: A.border }}>
                    {intent && onNavigate ? (
                      <button type="button" onClick={() => onNavigate(intent.activeId, intent.focusTarget || null)} className={draftEvidenceLinkClass} style={{ color: A.blue }}>
                        {[link.label || "来源记录", link.entityId].filter(Boolean).join(" · ")}
                      </button>
                    ) : (
                      <div className={draftEvidenceTitleClass} style={{ color: A.label }}>{link.label}</div>
                    )}
                    <div className={`mt-1 ${draftEvidenceMetaClass}`} style={{ color: A.gray2 }}>{link.status || link.label}</div>
                  </div>
                );
              }) : (
                <div className="rounded-lg border px-3 py-3 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>暂无来源证据</div>
              )}
            </div>
          </section>

          <section className="rounded-lg px-3 py-3" style={{ background: validation?.ok ? "#f0faf4" : "#fff8f0" }}>
            <div className="text-[12px] font-semibold" style={{ color: validation?.ok ? A.green : A.orange }}>
              {validation?.ok ? "校验通过" : "需要补充或人工复核"}
            </div>
            {validation?.errors?.length ? (
              <div className="mt-1 space-y-1">
                {validation.errors.map((item) => <div key={item} className="text-[11px]" style={{ color: A.sub }}>{item}</div>)}
              </div>
            ) : (
              <div className="mt-1 text-[11px]" style={{ color: A.sub }}>该草稿仍需人工复核；用户确认后也只保留允许范围内的安全内部记录。</div>
            )}
          </section>

          <section className="rounded-lg px-3 py-3 text-[11px] leading-5" style={{ background: A.gray6, color: A.sub }}>
            <span className="font-semibold" style={{ color: A.gray1 }}>审计预览：</span>
            {audit?.summary || "草稿预览已生成；未创建或提交业务记录。"}
          </section>
        </div>
      ) : (
        <div className="rounded-lg border px-4 py-5 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>暂无草稿预览</div>
      )}
    </Modal>
  );
}
