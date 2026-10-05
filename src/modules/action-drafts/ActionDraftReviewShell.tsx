import { Copy, Mail, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { A, Chip, Modal, RecoveryActions } from "../../components/ui";
import { typography } from "../../components/ui/typography";
import { useI18n } from "../../i18n/I18n";
import { navigationIntentFromEvidenceLink, normalizeEvidenceLinks, type CanonicalFocusTarget } from "../../lib/evidenceLinks";
import type { PrefillEntry } from "../../lib/prefill";
import { PrefillSourceChip } from "../../components/prefill/PrefillSource";
import { MESSAGE_DRAFT_TYPES, MESSAGE_FIELDS, draftLines, mailtoLink, messageKey, messageText, recordActionDraftUse } from "./draftMessage";

export type ActionDraftPreviewRequest = {
  type: string;
  title?: string;
  source?: string;
  originEvidence?: Record<string, unknown>[];
  payload?: Record<string, unknown>;
  // Which payload fields were suggested, and from where.
  prefill?: Record<string, PrefillEntry>;
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
  prefill?: Record<string, PrefillEntry>;
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

// English source copy with its Chinese translation. The server's audit
// summary arrives in Chinese, so it is listed too.
const ZH: Record<string, string> = {
  "Yes": "是", "No": "否", "Needs review": "需人工复核",
  "Item / SKU": "物料 / SKU", "Item name": "物料名称", "Warehouse": "仓库", "Suggested quantity": "建议数量", "Quantity": "数量",
  "Unit": "单位", "Reason": "原因", "Suggested supplier": "供应商建议", "Candidate suppliers": "候选供应商",
  "Requested delivery date": "期望交期", "Quotation deadline": "报价截止", "Supplier": "供应商", "Supplier code": "供应商编码",
  "Supplier name": "供应商名称", "Related document type": "关联单据类型", "Related document": "关联单据",
  "Follow-up reason": "跟进原因", "Message draft": "消息草稿", "Priority": "优先级", "Urgency": "紧急程度", "Due date": "截止日期",
  "Available stock": "可用库存", "Reorder point": "再订货点", "Safety stock": "安全库存",
  "PR draft": "PR 草稿", "RFQ draft": "RFQ 草稿", "Supplier follow-up note": "供应商跟进备注草稿", "PO follow-up note": "PO 跟进备注草稿",
  "Case note": "工单备注草稿", "Business action draft": "业务动作草稿",
  "Preview": "仅预览", "Draft": "草稿", "Draft, needs review": "仅生成草稿 / 需人工复核",
  "Inventory replenishment": "库存补货", "Today cockpit": "今日驾驶舱", "AI insights": "智能洞察", "Procurement follow-up": "采购跟进",
  "Supplier follow-up": "供应商跟进", "Business context": "业务上下文",
  "Type: {value}": "类型：{value}", "Status: {value}": "状态：{value}", "Checks: {value}": "校验：{value}",
  "This draft has unsaved review changes": "草稿有未保存的审阅修改", "Reset to the draft the preview produced": "已重置为预览生成的草稿",
  "Draft kept for review. A person still has to confirm it.": "待复核草稿已保留，后续仍需人工确认。", "The draft could not be saved": "草稿保存失败",
  "Action draft preview": "动作草稿预览",
  "Text draft editor for supplier messages or internal notes. It does not replace the business pages.": "文本草稿编辑器：仅用于供应商消息或内部备注，不替代正式业务页面",
  "Close": "关闭", "Discard draft": "取消草稿", "Reset changes": "重置修改", "Copy draft": "复制草稿内容", "Keeping…": "保留中",
  "Keep draft for review": "保留待复核草稿", "Preparing the draft preview…": "正在生成草稿预览...",
  "Preview and keep limits": "预览 / 留存边界",
  "You can review, copy, edit simple fields and keep the draft for review. A person still confirms anything that follows.": "当前工作区允许审阅、复制、编辑简单字段和保留待复核草稿；后续仍受人工确认和安全边界约束。",
  "Risky actions stay off: nothing is submitted, sent, or written to inventory, finance entries or payments.": "危险动作保持关闭：不提交、不外发、不写库存、不写财务凭证、不处理资金。",
  "The preview is for human review only. It does not process business records, change master data or overwrite workspace data.": "草稿预览只用于人工复核，不形成正式业务处理，不改主数据，不覆盖当前工作区数据。",
  "Type": "类型", "Status": "状态", "Source": "来源", "Confirmation": "确认边界", "Needs human confirmation": "需要人工确认",
  "Business content (simple fields can be edited)": "业务内容（简单字段可审阅编辑）", "No fields to show": "暂无可展示字段",
  "Source evidence": "来源证据", "Source record": "来源记录", "No source evidence": "暂无来源证据",
  "Checks passed": "校验通过", "Needs more information or human review": "需要补充或人工复核",
  "This draft still needs human review. After confirmation only safe internal records within the allowed scope are kept.": "该草稿仍需人工复核；用户确认后也只保留允许范围内的安全内部记录。",
  "Audit preview:": "审计预览：", "Draft preview prepared. No business record was created or submitted.": "草稿预览已生成；未创建或提交业务记录。",
  "No draft preview": "暂无草稿预览",
  "Supplier message": "供应商消息", "To": "收件人", "Subject": "主题", "Message": "消息内容",
  "Open lines": "未到货明细", "Item": "物料", "Remaining": "未到数量", "Promised date": "承诺日期", "Originally {date}": "原定 {date}",
  "Open in email": "在邮件中打开", "Copied": "已复制",
  "Purchase order": "采购订单", "Invoice": "发票",
  "Open in email starts a message in your own mail app. FlowChain does not send anything.": "“在邮件中打开”会在你自己的邮件程序中新建邮件；FlowChain 不会发送任何内容。",
  "This message is long, so your mail app gets a shortened copy. Use Copy draft for the full text.": "消息较长，邮件程序收到的是截短的内容；如需完整内容请使用“复制草稿内容”。",
};
const EN = Object.fromEntries(Object.entries(ZH).map(([english, chinese]) => [chinese, english]));
type Tr = (value: string, params?: Record<string, string>) => string;

function translator(language: string): Tr {
  return (value, params = {}) => {
    const base = language === "en-US" ? EN[value] || value : ZH[value] || value;
    return Object.entries(params).reduce((text, [key, param]) => text.replaceAll(`{${key}}`, param), base);
  };
}

function text(value: unknown, tr: Tr, locale: string) {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return tr(value ? "Yes" : "No");
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString(locale) : "—";
  return String(value);
}

// A calendar day in the workspace locale, as the draft's message states it.
function dayText(value: unknown, locale: string) {
  const day = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return String(value ?? "") || "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

function compactObject(value: Record<string, unknown>, tr: Tr, locale: string) {
  return [
    value.supplierId || value.supplierIdOrName || value.supplierName || value.name,
    value.itemIdOrSku || value.sku || value.itemName,
    value.documentId || value.poId || value.rfqId || value.id,
    value.status || value.reason,
  ].filter(Boolean).map((item) => text(item, tr, locale)).slice(0, 3).join(" · ");
}

function businessValue(value: unknown, tr: Tr, locale: string) {
  if (Array.isArray(value)) {
    const items = value.map((item) => typeof item === "object" && item ? compactObject(item as Record<string, unknown>, tr, locale) : text(item, tr, locale)).filter(Boolean);
    return items.length ? items.slice(0, 3).join("; ") : "—";
  }
  if (typeof value === "object" && value) return compactObject(value as Record<string, unknown>, tr, locale) || tr("Needs review");
  return text(value, tr, locale);
}

const PAYLOAD_LABELS: Record<string, string> = {
  itemIdOrSku: "Item / SKU", itemName: "Item name", warehouse: "Warehouse", warehouseId: "Warehouse",
  suggestedQuantity: "Suggested quantity", quantity: "Quantity", unit: "Unit", reason: "Reason",
  supplierSuggestion: "Suggested supplier", supplierCandidates: "Candidate suppliers", requestedDeliveryDate: "Requested delivery date",
  quotationDeadline: "Quotation deadline", supplierIdOrName: "Supplier", supplierId: "Supplier code", supplierName: "Supplier name",
  relatedDocumentType: "Related document type", relatedDocumentId: "Related document", followupReason: "Follow-up reason",
  messageDraft: "Message draft", message: "Message draft", severity: "Priority", urgency: "Urgency", dueDate: "Due date",
  availableQuantity: "Available stock", reorderPoint: "Reorder point", safetyStock: "Safety stock",
  poId: "Purchase order", invoiceId: "Invoice",
};

function payloadLabel(key: string, tr: Tr) {
  return PAYLOAD_LABELS[key] ? tr(PAYLOAD_LABELS[key]) : key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function copyTextForDraft(draft: ActionDraftPreview | null, tr: Tr, locale: string) {
  if (!draft) return "";
  const payload = Object.entries(draft.payload || {})
    .map(([key, value]) => `${payloadLabel(key, tr)}: ${businessValue(value, tr, locale)}`)
    .join("\n");
  const warnings = draft.validation?.errors?.length ? `\n${tr("Checks: {value}", { value: draft.validation.errors.join("; ") })}` : "";
  return `${draft.title}\n${tr("Type: {value}", { value: draftTypeLabel(draft.type, tr) })}\n${tr("Status: {value}", { value: draftStatusLabel(draft.status, tr) })}\n${payload}${warnings}`.trim();
}

function draftTypeLabel(type: string | undefined, tr: Tr) {
  const labels: Record<string, string> = {
    purchase_request_draft: "PR draft", rfq_draft: "RFQ draft", supplier_followup_draft: "Supplier follow-up note",
    po_followup_draft: "PO follow-up note", exception_note: "Case note",
  };
  return tr(labels[type || ""] || "Business action draft");
}

function draftStatusLabel(status: string | undefined, tr: Tr) {
  const labels: Record<string, string> = {
    preview: "Preview", draft: "Draft", review_required: "Needs review", draft_only_requires_review: "Draft, needs review",
  };
  return tr(labels[status || ""] || "Needs review");
}

function draftSourceLabel(source: string | undefined, tr: Tr) {
  const labels: Record<string, string> = {
    inventory_replenishment: "Inventory replenishment", today_cockpit: "Today cockpit", ai_assistant: "AI insights",
    procurement_followup: "Procurement follow-up", supplier_followup: "Supplier follow-up",
  };
  return tr(labels[source || ""] || "Business context");
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
  const { language, locale } = useI18n();
  const tr = useMemo(() => translator(language), [language]);
  const [workingDraft, setWorkingDraft] = useState<ActionDraftPreview | null>(draft);
  const [saveStatus, setSaveStatus] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const activeDraft = workingDraft || draft;
  const validation = activeDraft?.validation;
  const evidence = normalizeEvidenceLinks(activeDraft?.originEvidence || [], { source: "actionDraft" }).slice(0, 6);
  const audit = activeDraft?.auditTrail?.[0];
  const isMessageDraft = MESSAGE_DRAFT_TYPES.has(activeDraft?.type || "");
  // A message draft shows its recipient, subject, text and lines in the message
  // section; the grid lists the remaining fields.
  const payloadEntries = useMemo(
    () => Object.entries(activeDraft?.payload || {}).filter(([key]) => !(isMessageDraft && MESSAGE_FIELDS.has(key))),
    [activeDraft?.payload, isMessageDraft],
  );
  const messagePayload = activeDraft?.payload || {};
  const bodyKey = messageKey(messagePayload);
  const lines = draftLines(messagePayload);
  const mailto = isMessageDraft ? mailtoLink(messagePayload) : null;
  const suggestion = (field: string) => activeDraft?.prefill?.[field];

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
    setSaveStatus(tr("This draft has unsaved review changes"));
    setSaveError("");
  }

  function resetDraft() {
    setWorkingDraft(draft);
    setSaveStatus(tr("Reset to the draft the preview produced"));
    setSaveError("");
  }

  async function saveDraft() {
    if (!activeDraft || !onSaveDraft) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSaveDraft(activeDraft);
      setSaveStatus(tr("Draft kept for review. A person still has to confirm it."));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : tr("The draft could not be saved"));
    } finally {
      setSaving(false);
    }
  }

  async function copyDraft() {
    const content = isMessageDraft && activeDraft
      ? messageText(activeDraft.payload || {}, { to: tr("To"), subject: tr("Subject") })
      : copyTextForDraft(activeDraft, tr, locale);
    if (!content || !navigator?.clipboard || !activeDraft) return;
    await navigator.clipboard.writeText(content);
    setSaveStatus(tr("Copied"));
    void recordActionDraftUse(activeDraft, "copied");
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={activeDraft?.title || tr("Action draft preview")}
      subtitle={tr("Text draft editor for supplier messages or internal notes. It does not replace the business pages.")}
      width={860}
      footer={(
        <>
          <RecoveryActions
            actions={[
              { key: "close", label: tr("Close"), onClick: onClose, kind: "previous" },
              { key: "cancel", label: tr("Discard draft"), onClick: onCancelPreview, kind: "clear", tone: "subtle" },
            ]}
          />
          <button type="button" onClick={resetDraft} disabled={!activeDraft || saving} className={draftButtonClass} style={{ background: A.white, color: activeDraft ? A.gray1 : A.gray2 }}>
            <RotateCcw size={12} className="mr-1 inline" />{tr("Reset changes")}
          </button>
          <button type="button" onClick={copyDraft} disabled={!activeDraft} className={draftButtonClass} style={{ background: A.white, color: activeDraft ? A.blue : A.gray2 }}>
            <Copy size={12} className="mr-1 inline" />{tr("Copy draft")}
          </button>
          {mailto && activeDraft ? (
            <a
              href={mailto.href}
              data-testid="action-draft-open-email"
              onClick={() => { void recordActionDraftUse(activeDraft, "opened_in_email"); }}
              className={`${draftButtonClass} inline-flex items-center`}
              style={{ background: A.white, color: A.blue }}
            >
              <Mail size={12} className="mr-1 inline" />{tr("Open in email")}
            </a>
          ) : null}
          <button type="button" onClick={saveDraft} disabled={!activeDraft || !onSaveDraft || saving} className={draftButtonClass} style={{ background: activeDraft && onSaveDraft ? A.blue : A.gray4, color: A.white }}>
            <Save size={12} className="mr-1 inline" />{saving ? tr("Keeping…") : tr("Keep draft for review")}
          </button>
        </>
      )}
    >
      {loading ? (
        <div className="rounded-lg border px-4 py-5 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>{tr("Preparing the draft preview…")}</div>
      ) : error ? (
        <div className="rounded-lg border px-4 py-5 text-[12px] leading-5" style={{ borderColor: "#ffd6d6", background: "#fff1f0", color: A.red }}>{error}</div>
      ) : activeDraft ? (
        <div className="space-y-4" data-testid="action-draft-review-shell">
          <section className="rounded-lg px-3 py-3 text-[12px] leading-5" style={{ background: "#f0f6ff", color: A.blue, border: `0.5px solid ${A.blue}30` }}>
            <div className="flex items-start gap-2">
              <ShieldCheck size={15} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">{tr("Preview and keep limits")}</div>
                <div className="mt-1" style={{ color: A.sub }}>
                  {tr("You can review, copy, edit simple fields and keep the draft for review. A person still confirms anything that follows.")}
                </div>
                <div className="mt-1" style={{ color: A.sub }}>
                  {tr("Risky actions stay off: nothing is submitted, sent, or written to inventory, finance entries or payments.")}
                </div>
                <div className="mt-1" style={{ color: A.sub }}>
                  {tr("The preview is for human review only. It does not process business records, change master data or overwrite workspace data.")}
                </div>
              </div>
            </div>
            {(saveStatus || saveError) && (
              <div className="mt-2 text-[11px]" style={{ color: saveError ? A.red : A.green }}>{saveError || saveStatus}</div>
            )}
          </section>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>{tr("Type")}</div>
              <div className="mt-1 text-[12px] font-semibold" style={{ color: A.label }}>{draftTypeLabel(activeDraft.type, tr)}</div>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>{tr("Status")}</div>
              <div className="mt-1"><Chip label={draftStatusLabel(activeDraft.status, tr)} color={A.blue} bg="#eef4ff" /></div>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>{tr("Source")}</div>
              <div className="mt-1 text-[12px] font-semibold" style={{ color: A.label }}>{draftSourceLabel(activeDraft.source, tr)}</div>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="fc-caption" style={{ color: A.gray2 }}>{tr("Confirmation")}</div>
              <div className="mt-1 text-[12px] font-semibold" style={{ color: A.orange }}>{activeDraft.requiresConfirmation ? tr("Needs human confirmation") : tr("Preview")}</div>
            </div>
          </div>

          {isMessageDraft ? (
            <section data-testid="action-draft-message" className="space-y-2">
              <div className="text-[12px] font-semibold" style={{ color: A.label }}>{tr("Supplier message")}</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="block rounded-lg border px-3 py-2" style={{ borderColor: A.border }}>
                  <span className="fc-caption" style={{ color: A.gray2 }}>{tr("To")}{messagePayload.contactName ? ` · ${String(messagePayload.contactName)}` : ""}</span>
                  <input data-testid="action-draft-to" type="email" value={String(messagePayload.to ?? "")} onChange={(event) => updatePayloadField("to", event.target.value, "")} className="mt-1 w-full rounded-md border px-2 py-1 text-[12px] font-semibold outline-none" style={{ borderColor: A.border, color: A.label }} />
                  <PrefillSourceChip entry={suggestion("to")} current={String(messagePayload.to ?? "")} testId="action-draft-source-to" />
                </label>
                <label className="block rounded-lg border px-3 py-2" style={{ borderColor: A.border }}>
                  <span className="fc-caption" style={{ color: A.gray2 }}>{tr("Subject")}</span>
                  <input data-testid="action-draft-subject" value={String(messagePayload.subject ?? "")} onChange={(event) => updatePayloadField("subject", event.target.value, "")} className="mt-1 w-full rounded-md border px-2 py-1 text-[12px] font-semibold outline-none" style={{ borderColor: A.border, color: A.label }} />
                  <PrefillSourceChip entry={suggestion("subject")} current={String(messagePayload.subject ?? "")} testId="action-draft-source-subject" />
                </label>
              </div>
              <label className="block rounded-lg border px-3 py-2" style={{ borderColor: A.border }}>
                <span className="fc-caption" style={{ color: A.gray2 }}>{tr("Message")}</span>
                <textarea data-testid="action-draft-message-body" rows={6} value={String(messagePayload[bodyKey] ?? "")} onChange={(event) => updatePayloadField(bodyKey, event.target.value, "")} className="mt-1 w-full rounded-md border px-2 py-1.5 text-[12px] leading-5 outline-none" style={{ borderColor: A.border, color: A.label }} />
                <PrefillSourceChip entry={suggestion(bodyKey)} current={String(messagePayload[bodyKey] ?? "")} testId="action-draft-source-message" />
              </label>
              {lines.length ? (
                <div className="overflow-x-auto rounded-lg border" style={{ borderColor: A.border }} data-testid="action-draft-lines">
                  <table className="w-full text-left text-[11px]">
                    <caption className="px-3 pt-2 text-left text-[11px] font-semibold" style={{ color: A.gray1 }}>{tr("Open lines")}</caption>
                    <thead><tr style={{ color: A.gray2 }}><th className="px-3 py-1 font-medium">SKU</th><th className="px-3 py-1 font-medium">{tr("Item")}</th><th className="px-3 py-1 text-right font-medium">{tr("Remaining")}</th><th className="px-3 py-1 font-medium">{tr("Promised date")}</th></tr></thead>
                    <tbody>
                      {lines.map((line, index) => (
                        <tr key={line.lineId || `${line.sku}-${index}`} className="border-t" style={{ borderColor: A.border, color: A.label }}>
                          <td className="px-3 py-1 font-semibold">{line.sku || "—"}</td>
                          <td className="px-3 py-1">{line.itemName || "—"}</td>
                          <td className="px-3 py-1 text-right">{line.remaining === null || line.remaining === undefined ? "—" : `${Number(line.remaining).toLocaleString(locale)}${line.unit ? ` ${line.unit}` : ""}`}</td>
                          <td className="px-3 py-1">{line.promisedDate ? dayText(line.promisedDate, locale) : "—"}{line.originalPromisedDate && line.originalPromisedDate !== line.promisedDate ? <span style={{ color: A.gray2 }}> · {tr("Originally {date}", { date: dayText(line.originalPromisedDate, locale) })}</span> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <p className="text-[11px] leading-5" style={{ color: A.gray2 }}>
                {tr("Open in email starts a message in your own mail app. FlowChain does not send anything.")}
                {mailto?.shortened ? ` ${tr("This message is long, so your mail app gets a shortened copy. Use Copy draft for the full text.")}` : ""}
              </p>
            </section>
          ) : null}

          <section>
            <div className="mb-2 text-[12px] font-semibold" style={{ color: A.label }}>{tr("Business content (simple fields can be edited)")}</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {payloadEntries.length ? payloadEntries.map(([key, value]) => (
                <div key={key} className="rounded-lg border px-3 py-2" style={{ borderColor: A.border }}>
                  <div className="fc-caption" style={{ color: A.gray2 }}>{payloadLabel(key, tr)}</div>
                  {isEditableScalar(value) ? (
                    typeof value === "boolean" ? (
                      <select value={String(value)} onChange={(event) => updatePayloadField(key, event.target.value, value)} className="mt-1 w-full rounded-md border px-2 py-1 text-[12px] font-semibold outline-none" style={{ borderColor: A.border, color: A.label, background: A.white }}>
                        <option value="true">{tr("Yes")}</option>
                        <option value="false">{tr("No")}</option>
                      </select>
                    ) : (
                      <input value={value === undefined || value === null ? "" : String(value)} onChange={(event) => updatePayloadField(key, event.target.value, value)} className="mt-1 w-full rounded-md border px-2 py-1 text-[12px] font-semibold outline-none" style={{ borderColor: A.border, color: A.label, background: A.white }} />
                    )
                  ) : (
                    <div className="mt-1 text-[12px] font-semibold leading-5" style={{ color: A.label }}>{businessValue(value, tr, locale)}</div>
                  )}
                </div>
              )) : (
                <div className="rounded-lg border px-3 py-3 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>{tr("No fields to show")}</div>
              )}
            </div>
          </section>

          <section>
            <div className="mb-2 text-[12px] font-semibold" style={{ color: A.label }}>{tr("Source evidence")}</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {evidence.length ? evidence.map((link, index) => {
                const intent = navigationIntentFromEvidenceLink(link, { source: "actionDraft" });
                return (
                  <div key={`${link.entityType}-${link.entityId}-${index}`} className="rounded-lg border px-3 py-2" style={{ borderColor: A.border }}>
                    {intent && onNavigate ? (
                      <button type="button" onClick={() => onNavigate(intent.activeId, intent.focusTarget || null)} className={draftEvidenceLinkClass} style={{ color: A.blue }}>
                        {[link.label || tr("Source record"), link.entityId].filter(Boolean).join(" · ")}
                      </button>
                    ) : (
                      <div className={draftEvidenceTitleClass} style={{ color: A.label }}>{link.label}</div>
                    )}
                    <div className={`mt-1 ${draftEvidenceMetaClass}`} style={{ color: A.gray2 }}>{link.status || link.label}</div>
                  </div>
                );
              }) : (
                <div className="rounded-lg border px-3 py-3 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>{tr("No source evidence")}</div>
              )}
            </div>
          </section>

          <section className="rounded-lg px-3 py-3" style={{ background: validation?.ok ? "#f0faf4" : "#fff8f0" }}>
            <div className="text-[12px] font-semibold" style={{ color: validation?.ok ? A.green : A.orange }}>
              {validation?.ok ? tr("Checks passed") : tr("Needs more information or human review")}
            </div>
            {validation?.errors?.length ? (
              <div className="mt-1 space-y-1">
                {validation.errors.map((item) => <div key={item} className="text-[11px]" style={{ color: A.sub }}>{item}</div>)}
              </div>
            ) : (
              <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("This draft still needs human review. After confirmation only safe internal records within the allowed scope are kept.")}</div>
            )}
          </section>

          <section className="rounded-lg px-3 py-3 text-[11px] leading-5" style={{ background: A.gray6, color: A.sub }}>
            <span className="font-semibold" style={{ color: A.gray1 }}>{tr("Audit preview:")}</span>
            {tr(audit?.summary || "Draft preview prepared. No business record was created or submitted.")}
          </section>
        </div>
      ) : (
        <div className="rounded-lg border px-4 py-5 text-[12px]" style={{ borderColor: A.border, color: A.sub }}>{tr("No draft preview")}</div>
      )}
    </Modal>
  );
}
