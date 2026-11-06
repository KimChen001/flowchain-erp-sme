import { RagAnswerCard } from "../../modules/ai-assistant/KnowledgeLibrary";
import { isUnavailableProductRoute } from "../../../shared/unavailable-product-routes.mjs";
import { BusinessQueryPresentation } from "./BusinessQueryPresentation";
import { useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { ActionDraftPreviewRequest } from "../../modules/action-drafts/ActionDraftReviewShell";
import { structuredDraftTarget } from "../../modules/action-drafts/structuredDraftHandoff";
import type { AiResponseV2, AiResponseV2EvidenceItem, AiResponseV2NavigationLink, AiResponseV2ReviewCard, AiResponseV2Section } from "../../domain/ai/response-contract";
import { isAiCapabilityAnswer, toAiFocusedResponse, type AiFocusedAction } from "../../domain/ai/focused-response";
import { businessEntityRouteRegistry, type BusinessEntityType } from "../business/businessEntityRoutes";
import { AiConfirmCard } from "./AiConfirmCard";
import { A } from "../ui";
import { useI18n } from "../../i18n/I18n";
import { isDocumentNumberType, useDocumentNumber } from "../../lib/documentNumbers";

type Language = "en-US" | "zh-CN";
// The renderer's own labels, in the answer's language (the question's), so a
// Chinese question on the English interface reads all in Chinese; the UI
// language when the answer has none. Answer text comes from the server.
const rendererCopy = {
  "en-US": {
    textDraft: "Prepare text draft",
    impact: "Impact: {impact}",
    figuresChecked: "Figures checked",
    fromRecords: "From your records",
    sources: "{count} sources",
    source: "1 source",
    notes: "{count} notes",
    note: "1 note",
    viewBasis: "View basis",
    basis: "Basis",
    draftFor: "Draft a purchase request for {sku}",
    newItem: "{description} (not in the catalog)",
    notNamed: "New item",
    records: "Records",
    limitations: "Data limitations",
    impactDetails: "Business impact",
    contextDetails: "System notes",
    proposal: "Suggested: new purchase request",
    proposalOptional: "If you still need one: new purchase request",
    item: "Item",
    quantity: "Quantity",
    supplier: "Supplier",
    needBy: "Need by",
    why: "Why",
    cancel: "Cancel",
    cancelled: "Suggestion dismissed. Nothing was saved.",
    moreLines: "Show {count} more",
    nextSteps: "Next steps for these records ({count})",
    limitedMode: "AI planning was unavailable, so this answer comes from the standard rules and may not cover every part of your question.",
    overCap: "This workspace reached this month's AI limit, so this answer comes from workspace rules.",
    modelUnavailable: "The AI model did not respond, so this answer comes from the standard rules.",
    modelBudget: "The AI service has reached its usage limit, so this answer comes from the standard rules.",
    modelUnchecked: "The AI answer could not be checked against your records, so this answer comes from the standard rules.",
  },
  "zh-CN": {
    textDraft: "生成文本草稿",
    impact: "影响：{impact}",
    figuresChecked: "数字已核对",
    fromRecords: "来自你的记录",
    sources: "{count} 条来源",
    source: "1 条来源",
    notes: "{count} 条说明",
    note: "1 条说明",
    viewBasis: "查看依据",
    basis: "依据",
    draftFor: "为 {sku} 起草采购申请",
    newItem: "{description}（非目录）",
    notNamed: "新物料",
    records: "相关记录",
    limitations: "数据限制",
    impactDetails: "业务影响",
    contextDetails: "系统说明",
    proposal: "建议：新建采购申请",
    proposalOptional: "如仍需要：新建采购申请",
    item: "物料",
    quantity: "数量",
    supplier: "供应商",
    needBy: "需求日期",
    why: "原因",
    cancel: "取消",
    cancelled: "已取消这条建议，没有保存任何内容。",
    moreLines: "再显示 {count} 条",
    nextSteps: "这些记录的下一步（{count}）",
    limitedMode: "AI 规划暂不可用，本回答来自标准规则，可能没有覆盖问题的每个部分。",
    overCap: "本工作区本月 AI 用量已达上限，本回答按工作区规则生成。",
    modelUnavailable: "AI 模型没有响应，本回答来自标准规则。",
    modelBudget: "AI 服务的用量额度已用完，本回答来自标准规则。",
    modelUnchecked: "AI 的回答未能与你的记录核对一致，本回答来自标准规则。",
  },
} as const;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
const count = (n: number, one: string, many: string) => n === 1 ? one : fill(many, { count: n });

// Teal text on white (owner palette, 2026-10-03): #0D9488 is too light for text.
const TEAL_TEXT = "#0F766E";
// A tint, no border: a sentence full of record numbers stays calm.
const CHIP_STYLE = { background: "#EFF4FF", color: A.blue };
const LINE_LIMIT = 3;

type NavigateOptions = { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown; query?: Record<string, string> };
type FocusTarget = { entityType: string; entityId: string; focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance" };
export type Navigate = (moduleId: string, focusTarget?: FocusTarget | null, options?: NavigateOptions) => void;

function entityType(value = ""): BusinessEntityType | null {
  const aliases: Record<string, BusinessEntityType> = { inventory_item: "item", sku: "item", po: "purchase_order", pr: "purchase_request", grn: "receiving_doc", invoice: "supplier_invoice" };
  const candidate = aliases[value] || value;
  return candidate in businessEntityRouteRegistry ? candidate as BusinessEntityType : null;
}

const chipClass = "inline-flex max-w-full items-center whitespace-nowrap rounded px-1 align-baseline text-[12.5px] font-semibold leading-5";

// A table cell that holds a record number, a figure or a date keeps to one
// line; words (a supplier, a status) wrap.
const KEEP_ON_ONE_LINE = /^(?:[A-Za-z0-9][A-Za-z0-9._/-]*\d[A-Za-z0-9._/-]*|[-+−]?[$€£¥]?\s?\d[\d,.]*\s?(?:%|[A-Za-z]{1,8}|[\u4e00-\u9fff]{1,3})?|\d{4}-\d{2}-\d{2})$/u;
const cellClass = (value: string) => (KEEP_ON_ONE_LINE.test(value.trim()) ? "whitespace-nowrap" : "");

// A purchase request, RFQ or purchase order labelled with its internal id (or
// not labelled) is shown by its document number; the id still opens it.
function useNumberedEvidence(item: AiResponseV2EvidenceItem, type: BusinessEntityType | null): AiResponseV2EvidenceItem {
  const id = String(item.entityId || "");
  const byId = !item.entityLabel || item.entityLabel === id;
  const number = useDocumentNumber(type && isDocumentNumberType(type) && byId ? type : null, id);
  if (!type || !isDocumentNumberType(type) || !byId || !number || number === id) return item;
  return { ...item, entityLabel: number, label: !item.label || item.label === id ? number : item.label };
}

// A record as a small chip that opens it; plain text when it has no page.
export function EvidenceLink({ item: evidence, children, onNavigate }: { item: AiResponseV2EvidenceItem; children?: ReactNode; onNavigate?: Navigate }) {
  const type = entityType(evidence.entityType);
  const item = useNumberedEvidence(evidence, type);
  const route = type ? businessEntityRouteRegistry[type] : null;
  if (!route || !item.entityId || !onNavigate || isUnavailableProductRoute(route.listRouteId)) return <span className="font-medium" style={{ color: A.label }}>{children || item.entityLabel || item.label}</span>;
  const focusArea = type === "purchase_order" ? "evidence" : undefined;
  return <button type="button" data-testid="ai-record-chip" data-action-kind="view_evidence" data-business-id={item.entityId} className={`${chipClass} hover:underline`} style={CHIP_STYLE} onClick={() => onNavigate(route.listRouteId, { entityType: type, entityId: item.entityId, focusArea }, { returnTo: "ai", entityLabel: item.entityLabel || item.entityId, source: "ai" })}>{children || item.entityLabel || item.label || item.entityId}</button>;
}

function linkFocusTarget(link: AiResponseV2NavigationLink) {
  const type = entityType(link.entityType);
  return link.focusTarget || (type && link.entityId ? {
    entityType: type,
    entityId: link.entityId,
    ...(type === "purchase_order" ? { focusArea: "receiving-invoice-variance" as const } : {}),
  } : null);
}

// A record the answer names only through its link ("Open CT-ACME0001").
function LinkChip({ link, code: written, onNavigate }: { link: AiResponseV2NavigationLink; code: string; onNavigate?: Navigate }) {
  // A purchase request, RFQ or order written by its id is shown by its document number.
  const type = entityType(link.entityType);
  const number = useDocumentNumber(type && isDocumentNumberType(type) && written === link.entityId ? type : null, link.entityId);
  const code = type && isDocumentNumberType(type) && written === link.entityId && number ? number : written;
  if (!onNavigate || isUnavailableProductRoute(link.moduleId)) return <span className="font-medium" style={{ color: A.label }}>{code}</span>;
  return <button type="button" data-testid="ai-record-chip" data-action-kind="view_business_object" data-business-id={link.entityId || ""} className={`${chipClass} hover:underline`} style={CHIP_STYLE} onClick={() => onNavigate(link.moduleId, linkFocusTarget(link), { returnTo: "ai", entityLabel: link.label, source: "ai", returnContext: link.returnContext })}>{code}</button>;
}

function reviewRequest(card: AiResponseV2ReviewCard): ActionDraftPreviewRequest | null {
  if (!card.draftType || !["supplier_followup_draft", "po_followup_draft", "exception_note", "inventory_exception_closure_draft"].includes(card.draftType)) return null;
  return { type: card.draftType, title: card.draftTitle || card.title, source: "ai_assistant", originEvidence: card.originEvidence || [], payload: { ...(card.payload || {}), reason: card.payload?.reason || card.description || card.allowedNextStep } , ...(card.prefill ? { prefill: card.prefill } : {}) };
}

const buttonClass = (primary: boolean) => primary
  ? "inline-flex min-h-9 items-center gap-1 rounded-lg px-3 py-2 text-[13px] font-semibold text-white"
  : "inline-flex min-h-9 items-center gap-1 rounded-lg px-3 py-2 text-[13px] font-semibold";
const buttonStyle = (primary: boolean) => primary ? { background: A.blue } : { background: A.white, color: A.blue, border: `1px solid ${A.gray4}` };

function NavigationAction({ link, primary = false, onNavigate }: { link: AiResponseV2NavigationLink; primary?: boolean; onNavigate?: Navigate }) {
  // Frozen or unavailable surfaces are never offered as a destination.
  if (!onNavigate || isUnavailableProductRoute(link.moduleId)) return null;
  const focusTarget = linkFocusTarget(link);
  return <button type="button" data-testid="ai-business-navigation-action" data-action-kind="view_business_object" data-business-id={link.entityId || ""} className={buttonClass(primary)} style={buttonStyle(primary)} onClick={() => onNavigate(link.moduleId, focusTarget, { returnTo: "ai", entityLabel: link.label, source: "ai", returnContext: link.returnContext })}>{link.label}<ChevronRight size={13} /></button>;
}

// A line's own draft button is smaller than the answer's actions.
const compactButtonClass = "inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 py-1 text-[13px] font-semibold";

function Action({ action, primary = false, compact = false, onNavigate, onReviewActionDraft, language }: { action: AiFocusedAction; primary?: boolean; compact?: boolean; onNavigate?: Navigate; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; language: Language }) {
  if (action.kind === "navigation") return <NavigationAction link={action.link} primary={primary} onNavigate={onNavigate} />;
  const className = compact ? compactButtonClass : buttonClass(primary);
  if (action.kind === "structured_draft") {
    const target = structuredDraftTarget(action.card.draftType || "", action.card.payload, "ai_assistant");
    if (!onNavigate) return null;
    return <button type="button" onClick={() => onNavigate(target.moduleId, null, { returnTo: "ai", entityLabel: action.label, source: "ai", query: target.query })} data-testid="ai-structured-draft-action" data-action-kind="create_formal_business_draft" className={className} style={buttonStyle(primary)}>{action.label}</button>;
  }
  const request = reviewRequest(action.card);
  if (!request || !onReviewActionDraft) return null;
  return <button type="button" onClick={() => onReviewActionDraft(request)} data-testid="ai-action-draft-preview" data-action-kind="generate_text_draft" data-draft-type={action.card.draftType || ""} className={className} style={buttonStyle(primary)}>{action.label || rendererCopy[language].textDraft}</button>;
}

// An order the assistant proposes (a purchase request for a named item): a
// card to confirm on. Its button opens the request form, filled in, where the
// user submits; nothing is saved from the assistant.
export function isAiOrderProposal(card: AiResponseV2ReviewCard) {
  return card.draftType === "purchase_request_draft" && typeof card.autoOpen === "boolean" && Boolean(card.payload?.itemIdOrSku || card.payload?.nonCatalog);
}

function OrderProposal({ card, onNavigate, onReviewActionDraft, language }: { card: AiResponseV2ReviewCard; onNavigate?: Navigate; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; language: Language }) {
  const copy = rendererCopy[language];
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return <p data-testid="ai-confirm-dismissed" className="text-[13px]" style={{ color: A.sub }}>{copy.cancelled}</p>;
  const payload = card.payload || {};
  const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const quantity = typeof payload.quantity === "number" ? payload.quantity.toLocaleString("en-US") : text(payload.quantity);
  const fields = [
    { label: copy.item, value: payload.nonCatalog ? fill(copy.newItem, { description: text(payload.description) || copy.notNamed }) : text(payload.itemIdOrSku) },
    // The unit's label in the answer language when the server gives one ("25 pcs", "25 件").
    { label: copy.quantity, value: [quantity, text(payload.unitLabel) || text(payload.unit)].filter(Boolean).join(" ") },
    { label: copy.supplier, value: text(payload.supplierName) },
    { label: copy.needBy, value: text(payload.needByDate) },
    { label: copy.why, value: card.description || text(payload.reason) },
  ].filter((field) => field.value);
  const action: AiFocusedAction = { kind: "structured_draft", label: card.allowedNextStep || card.title, card };
  // A request the answer says is not needed is not "suggested".
  return <AiConfirmCard label={card.optional ? copy.proposalOptional : copy.proposal} fields={fields} primary={<Action action={action} primary onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} />} cancelLabel={copy.cancel} onCancel={() => setDismissed(true)} />;
}

// Record numbers in the answer's text become chips: the numbers of the
// records the answer cites (PO-020, LDM-001, CT-ACME0001), not names.
const RECORD_CODE = /^(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._/-]{2,39}$/;
type RecordRef = { code: string; render: (code: string) => ReactNode };
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// An item the answer offers to order is a choice, not a link: its chip asks
// for a request for it, as its follow-up chip does (owner, 2026-11-03: a click
// on the item opened its page).
function OrderChoiceChip({ code, prompt, onFollowUp, language }: { code: string; prompt: string; onFollowUp?: (prompt: string) => void; language: Language }) {
  return <button type="button" data-testid="ai-order-choice" data-action-kind="draft_choice" data-business-id={code} title={fill(rendererCopy[language].draftFor, { sku: code })} disabled={!onFollowUp} className={`${chipClass} hover:underline`} style={CHIP_STYLE} onClick={() => onFollowUp?.(prompt)}>{code}</button>;
}

function recordRefs(response: AiResponseV2, onNavigate?: Navigate, onFollowUp?: (prompt: string) => void, language: Language = "en-US") {
  const refs = new Map<string, RecordRef>();
  for (const choice of response.orderChoices || []) {
    if (choice?.sku && choice.prompt && !refs.has(choice.sku.toUpperCase())) refs.set(choice.sku.toUpperCase(), { code: choice.sku, render: (text) => <OrderChoiceChip code={text} prompt={choice.prompt} onFollowUp={onFollowUp} language={language} /> });
  }
  for (const item of response.keyEvidence || []) {
    const code = item.entityLabel || item.label || "";
    if (RECORD_CODE.test(code) && !refs.has(code.toUpperCase())) refs.set(code.toUpperCase(), { code, render: (text) => <EvidenceLink item={item} onNavigate={onNavigate}>{text}</EvidenceLink> });
  }
  for (const link of response.navigationLinks || []) {
    if (!link.entityId) continue;
    for (const code of String(link.label || "").split(/\s+/).map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")).filter((word) => RECORD_CODE.test(word))) {
      if (!refs.has(code.toUpperCase())) refs.set(code.toUpperCase(), { code, render: (text) => <LinkChip link={link} code={text} onNavigate={onNavigate} /> });
    }
  }
  return refs;
}

function recordPattern(refs: Map<string, RecordRef>) {
  if (!refs.size) return null;
  const codes = [...refs.values()].map((ref) => escapeRegExp(ref.code)).sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![A-Za-z0-9-])(${codes.join("|")})(?![A-Za-z0-9-])`, "gi");
}

function withRecordChips(text: string, refs: Map<string, RecordRef>, pattern: RegExp | null): ReactNode {
  if (!pattern) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const ref = refs.get(match[0].toUpperCase());
    if (!ref || match.index === undefined) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<span key={`${match.index}-${match[0]}`}>{ref.render(match[0])}</span>);
    last = match.index + match[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// The answer's own text as written: its line breaks kept, and its numbered or
// bulleted lines shown as a list ("1.", "1、", "（1）", "-", "•").
const LIST_LINE = /^(?:(\d{1,2})(?:[.)．]\s+|、\s*)|[（(](\d{1,2})[)）]\s*|[-•*·]\s+)/u;
// A Markdown table (a list of items, owner 2026-11-03): a header row, a
// separator row of dashes, then one row per item. Each row's cells.
const TABLE_ROW = /^\|.*\|$/;
const TABLE_RULE = /^\|(?:\s*:?-{2,}:?\s*\|)+$/;
const tableCells = (line: string) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
type TextBlock = { kind: "p" | "ol" | "ul"; start: number; lines: string[] } | { kind: "table"; start: number; lines: string[]; head: string[]; rows: string[][] };
export function answerTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const rows = text.split(/\r?\n/).map((raw) => raw.trim());
  for (let index = 0; index < rows.length; index += 1) {
    const line = rows[index];
    if (!line) continue;
    if (TABLE_ROW.test(line) && TABLE_RULE.test(rows[index + 1] || "")) {
      const head = tableCells(line);
      const body: string[][] = [];
      for (index += 2; index < rows.length && TABLE_ROW.test(rows[index]); index += 1) body.push(tableCells(rows[index]));
      index -= 1;
      blocks.push({ kind: "table", start: 1, lines: [], head, rows: body });
      continue;
    }
    const match = line.match(LIST_LINE);
    const number = match ? Number(match[1] || match[2] || 0) : 0;
    const kind = match ? (number ? "ol" : "ul") : "p";
    const content = match ? line.slice(match[0].length) : line;
    const last = blocks[blocks.length - 1];
    if (last && kind !== "p" && last.kind === kind) last.lines.push(content);
    else blocks.push({ kind, start: number || 1, lines: [content] });
  }
  return blocks;
}

type Chips = { refs: Map<string, RecordRef>; pattern: RegExp | null };

function AnswerText({ text, lang, chips }: { text: string; lang?: string; chips: Chips }) {
  const line = (value: string) => withRecordChips(value, chips.refs, chips.pattern);
  return (
    <div data-testid="ai-answer-text" lang={lang} className="space-y-2 text-sm leading-relaxed" style={{ color: A.label }}>
      {answerTextBlocks(text).map((block, index) => block.kind === "table"
        ? <div key={index} className="@container">
            <div className="hidden overflow-x-auto @lg:block"><table data-testid="ai-answer-table" className="w-full text-[12.5px] leading-5"><thead><tr>{block.head.map((cell, column) => <th key={column} className="whitespace-nowrap px-1.5 py-1 text-left font-medium first:pl-0" style={{ color: A.sub, borderBottom: `1px solid ${A.gray4}` }}>{line(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.head.map((_, column) => <td key={column} className={`px-1.5 py-1 align-top tabular-nums first:pl-0 ${cellClass(row[column] || "")}`} style={{ borderBottom: `1px solid ${A.gray5}` }}>{line(row[column] || "")}</td>)}</tr>)}</tbody></table></div>
            {/* In the narrow panel: the record on one line, the rest of its row on the next. */}
            <ul data-testid="ai-answer-table-rows" className="divide-y @lg:hidden" style={{ borderColor: A.gray5 }}>
              {block.rows.map((row, rowIndex) => {
                const rest = block.head.slice(1).map((head, column) => ({ head, value: (row[column + 1] || "").trim() })).filter((cell) => cell.value);
                return (
                  <li key={rowIndex} className="py-1.5 text-[13px] leading-5 first:pt-0">
                    <div className="font-medium" style={{ color: A.label }}>{line(row[0] || "")}</div>
                    {rest.length ? <div style={{ color: A.sub }}>{rest.map((cell, column) => <span key={column}>{column ? " · " : ""}{KEEP_ON_ONE_LINE.test(cell.value) ? <span className="whitespace-nowrap">{cell.head} <span className="tabular-nums" style={{ color: A.label }}>{line(cell.value)}</span></span> : line(cell.value)}</span>)}</div> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        : block.kind === "p"
        ? <p key={index}>{line(block.lines[0])}</p>
        : block.kind === "ol"
          ? <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">{block.lines.map((value, row) => <li key={row}>{line(value)}</li>)}</ol>
          : <ul key={index} className="list-disc space-y-1 pl-5">{block.lines.map((value, row) => <li key={row}>{line(value)}</li>)}</ul>)}
    </div>
  );
}

// One part of a compound answer: its title and summary, in the answer
// language, and up to two of the records it cited.
function AnswerSection({ section, evidence, answerLanguage, chips, onNavigate }: { section: AiResponseV2Section; evidence: AiResponseV2EvidenceItem[]; answerLanguage?: string; chips: Chips; onNavigate?: Navigate }) {
  return (
    <article data-testid="ai-answer-section" data-skill={section.skillId} lang={answerLanguage || undefined}>
      <h4 className="text-sm font-semibold leading-6" style={{ color: A.label }}>{section.title}</h4>
      {section.summary ? <AnswerText text={section.summary} chips={chips} /> : null}
      {evidence.length ? <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">{evidence.slice(0, 2).map((item) => <span key={item.id}><EvidenceLink item={item} onNavigate={onNavigate} />{item.status ? <span style={{ color: A.sub }}> · {item.status}</span> : null}</span>)}</div> : null}
    </article>
  );
}

// A model-first answer's headline is its first sentence, cut at 80
// characters. A whole sentence leads in bold and the text goes on after it; a
// cut one is not shown, and the text is shown whole.
const SENTENCE_END = /[.。!！?？:：]$/u;
function splitHeadline(summary: string, headline: string) {
  const text = summary.trim();
  const lead = headline.trim();
  if (!lead || !text.startsWith(lead)) return { headline: lead, body: text };
  const rest = text.slice(lead.length);
  if (!SENTENCE_END.test(lead) && rest && !/^[.。!！?？:：]/u.test(rest)) return { headline: "", body: text };
  return { headline: lead, body: rest.replace(/^[\s.。!！?？:：]+/u, "") };
}

export function AiResponseV2Renderer({ response, onNavigate, onReviewActionDraft, onFollowUp, latest = true }: { response: AiResponseV2; onNavigate?: Navigate; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; onFollowUp?: (prompt: string, skillHint?: string) => void; latest?: boolean }) {
  const { language: uiLanguage } = useI18n();
  const [allLines, setAllLines] = useState(false);
  const [nextOpen, setNextOpen] = useState(false);
  const language: Language = response?.language === "zh-CN" || response?.language === "en-US" ? response.language : uiLanguage === "zh-CN" ? "zh-CN" : "en-US";
  const copy = rendererCopy[language];
  if (!response || response.version !== "v2") return null;
  if (response.rag) return <RagAnswerCard rag={response.rag} title={response.conclusion.title} summary={response.conclusion.summary} />;
  const focused = toAiFocusedResponse(response, language);
  const refs = recordRefs(response, onNavigate, onFollowUp, language);
  const chips: Chips = { refs, pattern: recordPattern(refs) };
  // A compound answer shows a section per part in place of the summary and
  // the priorities, which repeat the sections.
  const sections = (response.sections || []).filter((section) => Boolean(section?.title));
  const compound = sections.length > 1;
  const evidenceById = new Map((response.keyEvidence || []).map((item) => [item.id, item]));
  const { headline, body } = compound ? { headline: focused.headline, body: "" } : splitHeadline(focused.summary, focused.headline);
  // The records the text already shows as chips are not listed again.
  const shownText = [headline, body, ...sections.map((section) => section.summary || "")].join("\n");
  const shown = new Set([...(chips.pattern ? shownText.matchAll(chips.pattern) : [])].map((match) => match[0].toUpperCase()));
  const isShown = (code?: string) => Boolean(code) && shown.has(String(code).toUpperCase());
  const proposals = (response.reviewCards || []).filter(isAiOrderProposal);
  const lineDraft = (action: AiFocusedAction | null) => action && !(action.kind !== "navigation" && isAiOrderProposal(action.card)) ? action : null;
  const items = focused.primaryItems.map((item) => ({ ...item, draft: lineDraft(item.draft) }));
  // A line with something of its own to say (a reason, an impact, a next step
  // or a draft) is listed with it. Records the answer only cites are listed
  // when the text does not name them already; in a model-first answer that
  // holds beside lines with a next step too (owner, 2026-11-03: no record
  // listed twice).
  const saysSomething = (item: (typeof items)[number]) => Boolean(item.reason || item.impact || item.nextStep || item.draft);
  const notInText = (item: (typeof items)[number]) => !isShown(item.evidence.entityLabel || item.evidence.label);
  const citedOnly = items.every((item) => !saysSomething(item));
  const lines = compound ? [] : citedOnly ? items.filter(notInText) : response.answerSource === "workspace_model" ? items.filter((item) => saysSomething(item) || notInText(item)) : items;
  const compactLines = !citedOnly && lines.every((item) => !item.reason && !item.impact);
  // A table in the text already lists the records: their next steps fold
  // under one line instead of naming each record a third time (owner,
  // 2026-11-04: the summary, the table and a "Next:" line per order).
  const tableInText = /^\s*\|.+\|\s*$/m.test(body || "");
  const foldedLines = !citedOnly && compactLines && tableInText && lines.length > 1 && lines.every((item) => !notInText(item)) && !nextOpen;
  const shownLines = citedOnly || allLines ? lines : lines.slice(0, LINE_LIMIT);
  const hiddenLines = lines.length - shownLines.length;
  const impacts = new Set(lines.map((item) => item.impact));
  const sharedImpact = !citedOnly && lines.length > 1 && impacts.size === 1 ? [...impacts][0] : "";
  // A record shown as a chip, in the text or on a line, gets no "Open" button too.
  const chipped = new Set([...shown, ...lines.map((item) => item.evidence.entityId)].map((value) => String(value).toUpperCase()));
  const actions = [focused.primaryAction, ...focused.secondaryActions].filter((action): action is AiFocusedAction => Boolean(action))
    .filter((action) => action.kind === "navigation" ? !(action.link.entityId && (chipped.has(action.link.entityId.toUpperCase()) || String(action.link.label || "").split(/\s+/).some((word) => isShown(word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))))) : !isAiOrderProposal(action.card));
  const capability = isAiCapabilityAnswer(response);
  const sourceCount = response.realEvidenceCount ?? response.keyEvidence.length;
  const noteCount = focused.limitations.length;
  const modelAnswer = response.answerSource === "workspace_model";
  // One source for every record ("Your workspace data") is said once, not on each.
  const sources = new Set(focused.evidence.map((item) => item.sourceLabel || ""));
  const sharedSource = focused.evidence.length > 1 && sources.size === 1 ? [...sources][0] : "";
  // What stands behind a model-first answer (its bases and caveats), folded
  // under the trust line rather than written into the answer.
  const basis = (response.answerBasis || []).filter((line) => typeof line === "string" && line.trim());
  const trust = !capability && (response.answerSourceLabel || sourceCount || noteCount || basis.length || focused.businessImpact.length || response.contextCards?.length);
  // One meta line (owner, 2026-11-03): what was checked goes inside the trust
  // line when there is one, and stands above the answer only when there is not.
  // A clarification's detail is shown once, by the business query panel.
  const clarifying = Boolean(response.businessQuery?.clarification?.needed);
  const checkedLine = response.checkedLabel ? <p data-testid="ai-answer-checked" className="flex items-start gap-1.5 text-[13px] leading-5" style={{ color: A.sub }}><Search size={13} className="mt-[3px] shrink-0" aria-hidden />{response.checkedLabel}</p> : null;
  return (
    <div data-testid="ai-response-v2" data-answer-mode={focused.answerMode} data-answer-source={response.answerSource || undefined} className="space-y-3">
      {trust ? null : checkedLine}
      {/* A model call failed (the provider down, slow or out of budget), or agent planning was tried and failed: the rules answered. One line, the most specific. */}
      {response.aiModelAccess?.status === "unavailable"
        ? <p data-testid="ai-model-unavailable" role="status" className="rounded-lg px-2.5 py-1.5 text-[13px]" style={{ background: "#FFF7ED", color: "#9A3412" }}>{response.aiModelAccess.reason === "budget" ? copy.modelBudget : response.aiModelAccess.reason === "unchecked" ? copy.modelUnchecked : copy.modelUnavailable}</p>
        : response.agentPlanning?.status === "degraded" ? <p data-testid="ai-limited-mode" role="status" className="rounded-lg px-2.5 py-1.5 text-[13px]" style={{ background: "#FFF7ED", color: "#9A3412" }}>{copy.limitedMode}</p> : null}
      {response.aiModelAccess?.status === "over_cap" ? <p data-testid="ai-over-cap" role="status" className="rounded-lg px-2.5 py-1.5 text-[13px]" style={{ background: "#FFF7ED", color: "#9A3412" }}>{copy.overCap}</p> : null}

      <section data-testid="ai-focused-conclusion" lang={response.language || undefined} className="space-y-2">
        {headline ? <h3 className="text-[15px] font-semibold leading-6" style={{ color: A.label }}>{withRecordChips(headline, chips.refs, chips.pattern)}</h3> : null}
        {body && !clarifying ? <AnswerText text={body} chips={chips} /> : null}
      </section>

      <BusinessQueryPresentation response={response} />

      {compound ? <section data-testid="ai-answer-sections" className="space-y-3">{sections.map((section) => <AnswerSection key={section.id} section={section} evidence={(section.evidenceIds || []).map((id) => evidenceById.get(id)).filter((item): item is AiResponseV2EvidenceItem => Boolean(item))} answerLanguage={response.language} chips={chips} onNavigate={onNavigate} />)}</section> : null}

      {foldedLines ? <button type="button" data-testid="ai-next-steps-toggle" onClick={() => setNextOpen(true)} className="text-[13px] font-medium hover:underline" style={{ color: A.blue }}>{fill(copy.nextSteps, { count: lines.length })}</button> : null}
      {lines.length && !foldedLines ? <ul data-testid="ai-focused-primary-items" data-records={citedOnly ? "cited" : "priorities"} className={citedOnly ? "flex flex-wrap gap-x-4 gap-y-1.5" : compactLines ? "space-y-2" : "divide-y"} style={citedOnly || compactLines ? undefined : { borderColor: A.gray5 }} aria-label={citedOnly ? copy.records : undefined}>
        {shownLines.map((item) => citedOnly
          ? <li key={item.id} data-testid="ai-cited-record" className="text-[13px] leading-6"><EvidenceLink item={item.evidence} onNavigate={onNavigate}>{item.title}</EvidenceLink>{item.status ? <span style={{ color: A.sub }}> · {item.status}</span> : null}</li>
          // A line with only its next step (a model-first answer's record): one row.
          : compactLines
            ? <li key={item.id} data-testid="ai-line-next-step" className="text-[13px] leading-6"><EvidenceLink item={item.evidence} onNavigate={onNavigate}>{item.title}</EvidenceLink>{" "}{item.nextStep ? <span lang={response.language || undefined} style={{ color: A.label }}>{withRecordChips(item.nextStep, chips.refs, chips.pattern)}</span> : item.status ? <span style={{ color: A.sub }}>{item.status}</span> : null}{item.draft ? <span className="ml-2 inline-block align-middle"><Action action={item.draft} compact onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} /></span> : null}</li>
          : <li key={item.id} className="py-3 first:pt-0 last:pb-0" style={{ borderColor: A.gray5 }}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><EvidenceLink item={item.evidence} onNavigate={onNavigate}>{item.title}</EvidenceLink>{item.status && !item.reason.startsWith(item.status) ? <span className="text-[13px]" style={{ color: A.sub }}>{item.status}</span> : null}</div>
              {item.reason ? <p className="mt-1 text-sm leading-relaxed" lang={response.language || undefined} style={{ color: A.label }}>{withRecordChips(item.reason, chips.refs, chips.pattern)}</p> : null}
              {item.impact && !sharedImpact ? <p className="mt-0.5 text-[13px] leading-relaxed" style={{ color: A.sub }}>{fill(copy.impact, { impact: item.impact })}</p> : null}
              {item.nextStep || item.draft ? <div data-testid="ai-line-next-step" className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">{item.nextStep ? <span className="text-[13px] leading-relaxed" lang={response.language || undefined} style={{ color: A.label }}>{withRecordChips(item.nextStep, chips.refs, chips.pattern)}</span> : null}{item.draft ? <Action action={item.draft} compact onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} /> : null}</div> : null}
            </li>)}
      </ul> : null}
      {/* The same impact on every line is said once. */}
      {sharedImpact ? <p data-testid="ai-shared-impact" className="text-[13px] leading-relaxed" style={{ color: A.sub }}>{fill(copy.impact, { impact: sharedImpact })}</p> : null}
      {/* Three lines show; the rest open on request, so a long answer stays readable on a phone. */}
      {hiddenLines && !foldedLines ? <button type="button" data-testid="ai-more-lines" onClick={() => setAllLines(true)} className="text-[13px] font-medium hover:underline" style={{ color: A.blue }}>{fill(copy.moreLines, { count: hiddenLines })}</button> : null}

      {proposals.map((card, index) => <OrderProposal key={`${card.draftType}-${card.payload?.itemIdOrSku}-${index}`} card={card} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} />)}

      {actions.length ? <section data-testid="ai-focused-actions" className="flex flex-wrap gap-2">{actions.map((action, index) => <Action key={`${action.kind}-${action.label}-${index}`} action={action} primary={index === 0 && !proposals.length} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} />)}</section> : null}

      {response.supplementalKnowledge && <RagAnswerCard rag={response.supplementalKnowledge.rag} title={response.supplementalKnowledge.title} summary={response.supplementalKnowledge.summary} />}

      {/* The help answer reads no records and says so. */}
      {capability && response.answerSourceLabel ? <p data-testid="ai-answer-source" className="text-[13px]" style={{ color: A.sub }}>{response.answerSourceLabel}</p> : null}

      {/* One line says how the answer was checked; it opens to the records, limitations and notes behind it. */}
      {trust ? <details data-testid="ai-trust-line" className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-[13px] [&::-webkit-details-marker]:hidden">
          <CheckCircle2 size={14} style={{ color: TEAL_TEXT }} aria-hidden />
          <span className="font-medium" style={{ color: TEAL_TEXT }}>{modelAnswer ? copy.figuresChecked : copy.fromRecords}</span>
          {sourceCount ? <span style={{ color: A.sub }}>· {count(sourceCount, copy.source, copy.sources)}</span> : null}
          {noteCount ? <span style={{ color: A.sub }}>· {count(noteCount, copy.note, copy.notes)}</span> : null}
          {basis.length ? <span style={{ color: A.blue }}>· {copy.viewBasis}</span> : null}
          <ChevronDown size={13} className="transition-transform group-open:rotate-180" style={{ color: A.gray2 }} aria-hidden />
        </summary>
        <div className="mt-2 space-y-3 rounded-xl p-3 text-[13px] leading-relaxed" style={{ background: A.gray6, border: `1px solid ${A.gray4}` }}>
          {basis.length ? <div data-testid="ai-answer-basis" lang={response.language || undefined} className="space-y-1"><div className="font-semibold" style={{ color: A.label }}>{copy.basis}</div><ul className="list-disc space-y-0.5 pl-4" style={{ color: A.label }}>{basis.map((line, index) => <li key={index}>{withRecordChips(line, chips.refs, chips.pattern)}</li>)}</ul></div> : null}
          {checkedLine}
          {response.answerSourceLabel ? <p data-testid="ai-answer-source" style={{ color: A.sub }}>{response.answerSourceLabel}</p> : null}
          {focused.evidence.length ? <div data-testid="ai-evidence-details" className="space-y-1.5">{focused.evidence.map((item) => <div key={item.id}><EvidenceLink item={item} onNavigate={onNavigate} /><span style={{ color: A.sub }}>{[item.status, item.value, sharedSource ? "" : item.sourceLabel].filter((value) => value !== undefined && value !== null && value !== "").map((value) => ` · ${value}`).join("")}</span></div>)}{sharedSource ? <div style={{ color: A.sub }}>{sharedSource}</div> : null}</div> : null}
          {focused.limitations.length ? <div data-testid="ai-limitations-details" className="space-y-1"><div className="font-semibold" style={{ color: A.label }}>{copy.limitations}</div>{focused.limitations.map((item, index) => <div key={item.code || `${item.label}-${index}`}><span className="font-medium" style={{ color: A.label }}>{item.label}</span>{item.description ? <span style={{ color: A.sub }}> · {item.description}</span> : null}{item.consequence ? <div style={{ color: A.sub }}>{item.consequence}</div> : null}</div>)}</div> : null}
          {focused.businessImpact.length ? <div data-testid="ai-impact-details" className="space-y-1"><div className="font-semibold" style={{ color: A.label }}>{copy.impactDetails}</div>{focused.businessImpact.map((item, index) => <div key={`${index}-${item.area}-${item.impact}`}><span className="font-medium" style={{ color: A.label }}>{item.area} · {item.impact}</span>{item.explanation ? <div style={{ color: A.sub }}>{item.explanation}</div> : null}</div>)}</div> : null}
          {response.contextCards?.length ? <div data-testid="ai-context-details" className="space-y-1"><div className="font-semibold" style={{ color: A.label }}>{copy.contextDetails}</div>{response.contextCards.slice(0, 5).map((item) => <div key={item.id}><span className="font-medium" style={{ color: A.label }}>{item.entityLabel || item.label}</span>{item.summary ? <span style={{ color: A.sub }}> · {item.summary}</span> : null}</div>)}</div> : null}
        </div>
      </details> : null}

      {latest && focused.followUps.length ? <section data-testid="ai-focused-follow-ups" className="flex flex-wrap gap-1.5">{focused.followUps.map((item) => <button key={item.prompt} type="button" onClick={() => onFollowUp?.(item.prompt, item.skillHint)} disabled={!onFollowUp} className="rounded-full px-3 py-1.5 text-[13px] font-medium hover:bg-blue-50 disabled:opacity-50" style={{ background: A.white, color: A.blue, border: `1px solid ${A.gray4}` }}>{item.label}</button>)}</section> : null}
    </div>
  );
}
