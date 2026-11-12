import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { TodayDecisionCards } from "../overview/DecisionCards";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { translate, useI18n } from "../../i18n/I18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Clock3, FilePlus2, ListChecks, Maximize2, MessageSquareText, Minimize2, MoreHorizontal, Send, Square, SquarePen, Sparkles, Truck, Upload, X, type LucideIcon } from "lucide-react";
import { QUESTION_LIMITS } from "../../../shared/assistant-protocol.mjs";
import type { CanonicalFocusTarget } from "../../lib/evidenceLinks";
import { A } from "../../components/ui";
import { fetchAiRuntimeReadiness, type AiRuntimeReadiness } from "./aiRuntimeGateway";
import { AssistantV2Answer } from "./v2/AssistantV2Answer";
import { emptyAssistantV2Message, finishAssistantV2Message, foldAssistantV2Event, type AssistantV2Message } from "./v2/foldEvents";
import type { PrReceipt, RecordActionReceipt, SetupReceipt } from "./v2/parts/types";
import { setupCreatedRecords } from "./v2/parts/SetupRecordsPart";
import { assistantV2Failure, newThreadId, streamAssistantV2, type AssistantV2FormResult } from "./v2/streamClient";

export type ActiveContext = {
  module?: string;
  entityType?: "supplier" | "item" | "rfq" | "purchase_request" | "purchase_order" | "sales_order";
  entityId?: string;
  entityLabel?: string;
  view?: string;
  route?: string;
};

// One message of the conversation: the user's question, or the assistant's
// answer as its events built it (with the question it answers, for Retry).
type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
  id?: string;
  question?: string;
  v2?: AssistantV2Message;
};

type AiNavigateOptions = {
  returnTo?: string;
  entityLabel?: string;
  source?: string;
  returnContext?: unknown;
  query?: Record<string, string>;
};

type AiNavigate = (moduleId: string, focusTarget?: CanonicalFocusTarget | null, options?: AiNavigateOptions) => void;

// The welcome cards (owner-approved panel design, 2026-11-01): what to handle
// first, overdue orders, a purchase request draft, and the purchasing policy.
// Every card is asked as typed, like any question.
export const AI_EMPTY_STATE_PROMPT_CHIPS = [
  { label: "What should I handle first today?", prompt: "What should I handle first today?", zhLabel: "今天先处理什么？", zhPrompt: "今天先处理什么？" },
  { label: "Which purchase orders are overdue?", prompt: "Which purchase orders are overdue?", zhLabel: "哪些采购订单逾期了？", zhPrompt: "哪些采购订单逾期了？" },
  { label: "Draft a purchase request", prompt: "Draft a purchase request", zhLabel: "帮我起草一份采购申请", zhPrompt: "帮我起草一份采购申请" },
  { label: "What does our purchasing policy say?", prompt: "What does our purchasing policy say?", zhLabel: "公司的采购制度是怎么规定的？", zhPrompt: "公司的采购制度是怎么规定的？" },
];
const EMPTY_STATE_ICONS: LucideIcon[] = [ListChecks, Clock3, FilePlus2, BookOpen];

// With the first-day checklist open on its first steps (no items or no
// suppliers yet), the welcome cards start the setup instead.
const SETUP_STARTERS = ["ai.v2.starter.setup", "ai.v2.starter.suppliers", "ai.v2.starter.reorder", "ai.v2.starter.import"] as const;
const SETUP_STARTER_ICONS: LucideIcon[] = [ListChecks, Truck, FilePlus2, Upload];

const PO_EMPTY_PROMPTS = {
  "en-US": ["Why does this PO need attention?", "Which receipt or invoice evidence is missing?", "What will a delay affect?", "What should happen next?"],
  "zh-CN": ["这个 PO 为什么需要关注？", "还差哪些收货或发票证据？", "延误会影响什么？", "建议下一步是什么？"],
};
const SKU_EMPTY_PROMPTS = {
  "en-US": ["Does this SKU need replenishment?", "What is the available inventory?", "Which orders will be affected?", "What action is recommended?"],
  "zh-CN": ["这个 SKU 需要补货吗？", "当前可用库存是多少？", "哪些订单会受影响？", "建议如何处理？"],
};

const CONTEXT_ENTITY_LABELS: Record<string, { "en-US": string; "zh-CN": string }> = {
  purchase_order: { "en-US": "Purchase order", "zh-CN": "采购单" },
  item: { "en-US": "Inventory SKU", "zh-CN": "库存 SKU" },
  rfq: { "en-US": "RFQ", "zh-CN": "询价单" },
  supplier: { "en-US": "Supplier", "zh-CN": "供应商" },
  purchase_request: { "en-US": "Purchase request", "zh-CN": "采购申请" },
  sales_order: { "en-US": "Sales order", "zh-CN": "销售订单" },
};
// What the assistant answers about: always the whole workspace, which page or
// module is open does not change it. On a record's page the record is named
// too, since "this PO" then means it; the chip's clear button sets it aside.
export function getAiContextLabel(activeContext?: ActiveContext | null, language: "en-US" | "zh-CN" = "en-US") {
  const workspace = language === "zh-CN" ? "整个工作区" : "Whole workspace";
  if (!activeContext?.entityId) return workspace;
  const label = CONTEXT_ENTITY_LABELS[activeContext.entityType || ""]?.[language] || (language === "zh-CN" ? "业务对象" : "Business record");
  return `${workspace} · ${language === "zh-CN" ? "本页：" : "this page: "}${label} ${activeContext.entityLabel || activeContext.entityId}`;
}

// How the placeholder names the page's record. The assistant answers about the
// whole workspace; it uses this record only when the question says "this ...".
const CONTEXT_ENTITY_PHRASES: Record<string, { "en-US": string; "zh-CN": string }> = {
  purchase_order: { "en-US": "this PO", "zh-CN": "这个 PO" },
  item: { "en-US": "this SKU", "zh-CN": "这个 SKU" },
  rfq: { "en-US": "this RFQ", "zh-CN": "这个询价单" },
  supplier: { "en-US": "this supplier", "zh-CN": "这个供应商" },
  sales_order: { "en-US": "this sales order", "zh-CN": "这个销售订单" },
  purchase_request: { "en-US": "this purchase request", "zh-CN": "这个采购申请" },
};

// The same on every page; a record's page only offers the record as well.
export function getAiInputPlaceholder(activeContext?: ActiveContext | null, language: "en-US" | "zh-CN" = "en-US") {
  const zh = language === "zh-CN";
  const phrase = CONTEXT_ENTITY_PHRASES[activeContext?.entityType || ""]?.[language];
  if (phrase) return zh ? `问点什么（也可以问${phrase}），或让我帮你做…` : `Ask about ${phrase} or anything else, or tell me what to do…`;
  return zh ? "问点什么，或让我帮你做…" : "Ask a question, or tell me what to do…";
}

// The page's record in the header chip: its number only, a long one by its
// last two parts ("…PO-001" for "LOCAL-DEMO-PO-001 · Acme Components"); the
// chip's title has it whole.
export function aiShortRecordLabel(label?: string | null) {
  const value = String(label || "").split(" · ")[0].trim();
  const parts = value.split("-");
  if (value.length <= 12 || parts.length < 3 || !/\d/.test(parts.at(-1) || "")) return value;
  return `…${parts.slice(-2).join("-")}`;
}

// Placeholder and role names a workspace starts with ("Initial Admin", "Admin
// User"): never greeted by, as "Hi Initial" would be.
const GENERIC_NAME_WORDS = new Set(["initial", "admin", "administrator", "user", "default", "owner", "manager", "buyer", "viewer", "member", "guest", "system", "workspace", "flowchain"]);
const GENERIC_CHINESE_NAMES = new Set(["管理员", "初始管理员", "系统管理员", "用户"]);

// The greeting's name: a Chinese name whole, else the first name. No name
// when the name is a placeholder or a role, so the greeting is just "Hi".
export function aiGreetingName(name?: string | null) {
  const value = String(name || "").trim();
  if (!value) return "";
  if (/[㐀-鿿]/.test(value)) return GENERIC_CHINESE_NAMES.has(value) ? "" : value;
  const words = value.split(/\s+/);
  if (words.every((word) => GENERIC_NAME_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, "")))) return "";
  return GENERIC_NAME_WORDS.has(words[0].toLowerCase()) ? "" : words[0];
}

// Wide enough to sit beside the page: the panel docks to the right and the
// page narrows. Narrower, it covers the page (a drawer, full screen on phones).
const DOCK_QUERY = "(min-width: 1024px)";
function useDocked() {
  const [docked, setDocked] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(DOCK_QUERY).matches));
  useEffect(() => {
    const media = window.matchMedia?.(DOCK_QUERY);
    if (!media) return;
    const update = () => setDocked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return docked;
}

function HeaderButton({ label, onClick, children, testId, expanded }: { label: string; onClick: () => void; children: ReactNode; testId?: string; expanded?: boolean }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-label={label} title={label} aria-expanded={expanded} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }}>
      {children}
    </button>
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
  userName,
  onNavigate,
}: {
  moduleId: string;
  activeContext?: ActiveContext | null;
  openSignal?: number;
  userName?: string | null;
  onNavigate?: AiNavigate;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const docked = useDocked();
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const requestInFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const abortReasonRef = useRef<"superseded" | "unmount" | "stopped" | null>(null);
  const [threadId, setThreadId] = useState(newThreadId);
  // In-chat form receipts by form id, and the requests the forms created that
  // the next question reports to the server.
  const [formReceipts, setFormReceipts] = useState<Record<string, PrReceipt>>({});
  const reportedFormsRef = useRef(new Set<string>());
  const pendingFormResultsRef = useRef<AssistantV2FormResult[]>([]);
  // Setup card receipts by form id, and the records already reported.
  const [setupReceipts, setSetupReceipts] = useState<Record<string, SetupReceipt>>({});
  const reportedSetupRef = useRef(new Set<string>());
  // Record card receipts by card id, and the steps already reported.
  const [actionReceipts, setActionReceipts] = useState<Record<string, RecordActionReceipt>>({});
  const reportedActionsRef = useRef(new Set<string>());
  // What readiness last said: whether the assistant answers here (with the
  // first-day checklist), or why it cannot (a notice code, shown up front).
  // null until it is read, or when it could not be read: the panel then asks
  // as usual, and the server's answer says what it can.
  const [readiness, setReadiness] = useState<AiRuntimeReadiness | null>(null);
  const readinessRequestedRef = useRef(false);

  function refreshReadiness() {
    readinessRequestedRef.current = true;
    void fetchAiRuntimeReadiness().then((ready) => setReadiness(ready), () => undefined);
  }

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (open && !readinessRequestedRef.current) refreshReadiness();
  }, [open]);

  const minimizeAssistant = () => setOpen(false);
  const restoreAssistant = () => setOpen(true);
  // Docked beside the page, the assistant stays open next to the record it
  // opened; covering the page, it gets out of the way.
  const minimizeAfterNavigate: AiNavigate = (moduleId, focusTarget, options) => {
    onNavigate?.(moduleId, focusTarget || null, { source: "ai", returnTo: activeContext?.route || moduleId, ...options });
    if (!docked) minimizeAssistant();
  };

  useEffect(() => {
    if (open && docked) inputRef.current?.focus();
  }, [open, docked]);
  // Narrower than the docked layout the panel covers the page, so it is a
  // modal dialog: focus moves into it (to its first control, so a phone's
  // keyboard does not pop up) and Tab stays inside. Escape is handled above.
  useDialogFocus(open && !docked, panelRef, minimizeAssistant, { escape: false });

  // A new answer is shown from its first line, where it says what matters
  // most, not scrolled to its end. Anything else (a question, an answer still
  // streaming) scrolls to the end.
  useEffect(() => {
    if (!open) return;
    const area = scrollRef.current;
    if (!area) return;
    const answers = area.querySelectorAll<HTMLElement>('[data-testid="ai-message-assistant"]');
    const latest = !asking && messages.at(-1)?.role === "assistant" ? answers[answers.length - 1] : null;
    const top = latest ? area.scrollTop + latest.getBoundingClientRect().top - area.getBoundingClientRect().top - 12 : area.scrollHeight;
    area.scrollTo({ top, behavior: "smooth" });
  }, [messages, open, asking]);

  useEffect(() => {
    return () => {
      abortReasonRef.current = "unmount";
      abortRef.current?.abort();
    };
  }, []);

  // Covering the page, a click outside or Escape closes the assistant. Docked
  // beside it, working on the page leaves it open; Escape inside it closes it.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!panelRef.current?.contains(target)) setMenuOpen(false);
      if (docked) return;
      if (panelRef.current?.contains(target) || restoreButtonRef.current?.contains(target)) return;
      const element = target instanceof Element ? target : null;
      if (element?.closest('[role="dialog"], [data-ai-ignore-outside-minimize="true"]')) return;
      minimizeAssistant();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (!docked || panelRef.current?.contains(document.activeElement))) minimizeAssistant();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, docked]);

  // The page's record, until the user sets it aside for this record. Opening
  // another record brings its context back.
  const pageContext = cleanActiveContext(activeContext);
  const pageContextKey = pageContext ? `${pageContext.entityType}:${pageContext.entityId}` : null;
  const currentContext = pageContext && pageContextKey !== dismissedContextKey ? pageContext : null;
  const contextLabel = getAiContextLabel(currentContext, language);
  const inputPlaceholder = getAiInputPlaceholder(currentContext, language);
  // Why the assistant cannot answer in this workspace, said before the first
  // question; the welcome cards are left out, since each would get the same notice.
  const notice = readiness && readiness.assistantV2 === false && readiness.notice ? readiness.notice : null;
  // On a PO or SKU page: two questions about the record, then two about the
  // workspace, so the assistant never turns into a single-record bot.
  const workspacePrompts = AI_EMPTY_STATE_PROMPT_CHIPS.map((item) => language === "zh-CN" ? item.zhPrompt : item.prompt);
  const recordPrompts = currentContext?.entityType === "purchase_order" ? PO_EMPTY_PROMPTS[language]
    : currentContext?.entityType === "item" ? SKU_EMPTY_PROMPTS[language] : [];
  const setupStarters = !recordPrompts.length && readiness?.assistantV2 === true && Boolean(readiness.setup?.open && readiness.setup.firstStepsOpen);
  const emptyPrompts = notice ? [] : setupStarters ? SETUP_STARTERS.map((key) => translate(language, key))
    : recordPrompts.length ? [...recordPrompts.slice(0, 2), ...workspacePrompts.slice(0, 2)] : workspacePrompts;
  const emptyPromptIcons = setupStarters ? SETUP_STARTER_ICONS
    : recordPrompts.length ? [MessageSquareText, MessageSquareText, ...EMPTY_STATE_ICONS.slice(0, 2)] : EMPTY_STATE_ICONS;
  // The longest question the assistant reads; pasted rows fit. Longer text
  // stays in the box, unsent.
  const questionLimit = QUESTION_LIMITS.assistantV2;
  const inputLength = input.trim().length;
  const inputTooLong = inputLength > questionLimit;
  // The header names the conversation by its first question once there is one.
  const firstQuestion = messages.find((message) => message.role === "user")?.content || "";
  const panelTitle = firstQuestion || (zh ? "FlowChain 助手" : "FlowChain assistant");
  const greetingName = aiGreetingName(userName);
  const greeting = zh ? (greetingName ? `你好，${greetingName}` : "你好") : (greetingName ? `Hi ${greetingName}` : "Hi");
  const lastAssistantIndex = messages.map((message) => message.role).lastIndexOf("assistant");

  function startNewConversation() {
    abortReasonRef.current = "superseded";
    abortRef.current?.abort();
    requestInFlightRef.current = false;
    setAsking(false);
    setMessages([]);
    setInput("");
    setThreadId(newThreadId());
    setFormReceipts({});
    reportedFormsRef.current = new Set();
    pendingFormResultsRef.current = [];
    setSetupReceipts({});
    reportedSetupRef.current = new Set();
    setActionReceipts({});
    reportedActionsRef.current = new Set();
    // The checklist may have moved on (records created in this conversation),
    // and AI may have been switched on or off.
    refreshReadiness();
  }

  function cancelRequest() {
    if (!abortRef.current) return;
    abortReasonRef.current = "stopped";
    abortRef.current.abort();
  }

  // A form's first receipt is a request it created: reported once, with the next question.
  function recordFormReceipt(formId: string, receipt: PrReceipt) {
    if (!reportedFormsRef.current.has(formId)) {
      reportedFormsRef.current.add(formId);
      pendingFormResultsRef.current = [...pendingFormResultsRef.current, { formId, purchaseRequestId: receipt.id, ...(receipt.addedSupplierLinks?.length ? { addedSupplierLinks: receipt.addedSupplierLinks } : {}) }];
    }
    setFormReceipts((current) => ({ ...current, [formId]: receipt }));
  }

  // A setup card's records, each reported once, with the next question.
  function recordSetupReceipt(formId: string, receipt: SetupReceipt) {
    const fresh = setupCreatedRecords(receipt).filter((record) => !reportedSetupRef.current.has(`${formId}|${record.type}:${record.id}`));
    for (const record of fresh) reportedSetupRef.current.add(`${formId}|${record.type}:${record.id}`);
    if (fresh.length) pendingFormResultsRef.current = [...pendingFormResultsRef.current, { formId, created: fresh }];
    setSetupReceipts((current) => ({ ...current, [formId]: receipt }));
  }

  // Each step taken in a record card, reported once, with the next question.
  function recordActionReceipt(cardId: string, receipt: RecordActionReceipt) {
    const fresh = receipt.steps.filter((step) => !reportedActionsRef.current.has(step.actionId));
    for (const step of fresh) reportedActionsRef.current.add(step.actionId);
    if (fresh.length) pendingFormResultsRef.current = [...pendingFormResultsRef.current, ...fresh.map((step) => ({ actionId: step.actionId, type: receipt.type, id: receipt.id, action: step.action }))];
    setActionReceipts((current) => ({ ...current, [cardId]: receipt }));
  }

  // Every question, typed or from a card or chip, goes to the assistant as it
  // is written; its answer streams in as events.
  async function askAi(text: string) {
    const message = text.trim();
    if (!message || requestInFlightRef.current) return;
    // Over the limit the question stays in the box with its count.
    if (message.length > questionLimit) return;
    const context = currentContext;
    const requestId = requestSeqRef.current + 1;
    const controller = new AbortController();
    const answerId = `answer-${requestId}`;
    const formResults = pendingFormResultsRef.current;
    let answer = emptyAssistantV2Message();
    let received = false;
    requestSeqRef.current = requestId;
    requestInFlightRef.current = true;
    pendingFormResultsRef.current = [];
    abortReasonRef.current = null;
    abortRef.current?.abort();
    abortRef.current = controller;
    const show = (next: AssistantV2Message) => {
      answer = next;
      if (requestSeqRef.current === requestId) setMessages((current) => current.map((item) => item.id === answerId ? { ...item, v2: next } : item));
    };
    setAsking(true);
    setInput("");
    setMessages((current) => [...current, { role: "user", content: message }, { role: "assistant", content: "", id: answerId, question: message, v2: answer }]);
    try {
      const events = streamAssistantV2({
        threadId,
        message,
        activeContext: { moduleId, entityType: context?.entityType ?? null, entityId: context?.entityId ?? null },
        answerLanguage: language,
        ...(formResults.length ? { formResults } : {}),
      }, { signal: controller.signal });
      for await (const event of events) {
        received = true;
        show(foldAssistantV2Event(answer, event));
      }
    } catch (error) {
      // A new conversation dropped this one, forms included.
      if (abortReasonRef.current === "unmount" || abortReasonRef.current === "superseded") return;
      // Not read by the server: the next question reports these forms again.
      if (!received) pendingFormResultsRef.current = [...formResults, ...pendingFormResultsRef.current];
      show(finishAssistantV2Message(answer, abortReasonRef.current === "stopped" ? { notice: "cancelled" } : { error: assistantV2Failure(error) }));
    } finally {
      if (requestSeqRef.current === requestId) {
        requestInFlightRef.current = false;
        abortRef.current = null;
        abortReasonRef.current = null;
        setAsking(false);
      }
    }
  }

  return (
    <div className="contents" data-testid="ai-assistant-root">
      {knowledgeOpen && <KnowledgeLibrary onClose={() => setKnowledgeOpen(false)} />}
      {open && (
        <aside
          ref={panelRef}
          data-testid="ai-assistant-panel"
          data-docked={docked ? "true" : "false"}
          role={docked ? undefined : "dialog"}
          aria-modal={docked ? undefined : true}
          tabIndex={-1}
          aria-label={zh ? "FlowChain 助手" : "FlowChain assistant"}
          className={`fixed inset-0 z-50 flex flex-col bg-white outline-none sm:left-auto sm:w-[440px] sm:shadow-2xl lg:static lg:z-auto lg:h-screen lg:shrink-0 lg:shadow-none ${expanded ? "lg:w-[min(760px,55vw)]" : "lg:w-[440px]"}`}
          style={{ borderLeft: `1px solid ${A.gray4}` }}
        >
          <header className="flex min-h-14 shrink-0 items-center gap-1.5 py-1.5 pl-4 pr-2" style={{ borderBottom: `1px solid ${A.gray4}` }}>
            <span className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: "#EFF4FF" }}><Sparkles size={15} style={{ color: A.blue }} aria-hidden /></span>
            {/* A long first question wraps to a second line rather than being cut after a word. */}
            <h2 data-testid="ai-assistant-title" className="line-clamp-2 min-w-0 flex-1 break-words text-[14px] font-semibold leading-5" style={{ color: A.label }} title={panelTitle}>{panelTitle}</h2>
            {/* Shown only when the panel was opened on a record: answers may use it ("this PO"). */}
            {currentContext && pageContextKey ? (
              <span data-testid="ai-context-chip" title={contextLabel} className="flex min-w-0 max-w-[96px] shrink-0 items-center gap-0.5 rounded-md py-0.5 pl-2 pr-0.5 text-xs font-medium" style={{ background: A.gray5, color: A.gray1 }}>
                <span className="truncate">{aiShortRecordLabel(currentContext.entityLabel || currentContext.entityId)}</span>
                <button
                  type="button"
                  data-testid="ai-context-clear"
                  onClick={() => setDismissedContextKey(pageContextKey)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-slate-200"
                  aria-label={zh ? "不限于这条记录，回答整个工作区" : "Stop using this record; answer about the whole workspace"}
                  title={zh ? "不限于这条记录" : "Stop using this record"}
                >
                  <X size={12} />
                </button>
              </span>
            ) : null}
            <HeaderButton label={zh ? "新对话" : "New conversation"} onClick={startNewConversation}><SquarePen size={16} /></HeaderButton>
            <div className="relative">
              <HeaderButton testId="ai-more-menu" label={zh ? "更多" : "More"} expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={16} /></HeaderButton>
              {menuOpen ? (
                <div role="menu" className="absolute right-0 top-9 z-10 w-52 rounded-xl bg-white p-1 shadow-lg" style={{ border: `1px solid ${A.gray4}` }}>
                  <button type="button" role="menuitem" data-testid="ai-knowledge-library" onClick={() => { setMenuOpen(false); setKnowledgeOpen(true); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-slate-50" style={{ color: A.label }}>
                    <BookOpen size={15} style={{ color: A.gray1 }} aria-hidden />
                    {zh ? "管理资料" : "Knowledge library"}
                  </button>
                </div>
              ) : null}
            </div>
            {docked ? <HeaderButton label={expanded ? (zh ? "收起 AI 工作区" : "Collapse AI workspace") : (zh ? "展开 AI 工作区" : "Expand AI workspace")} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</HeaderButton> : null}
            <button type="button" onClick={minimizeAssistant} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }} aria-label={language === "zh-CN" ? "最小化 AI 助手" : "Minimize AI assistant"}><X size={17} /></button>
          </header>

          <div ref={scrollRef} data-testid="ai-assistant-messages" className="min-h-0 flex-1 overflow-auto px-4 py-5">
            {messages.length === 0 && (
              <div data-testid="ai-welcome">
                <h3 className="text-xl font-semibold" style={{ color: A.label }}>{greeting}</h3>
                <p data-testid="ai-runtime-boundary" className="mt-1.5 text-sm leading-relaxed" style={{ color: A.gray1 }}>{zh ? "我能查采购、库存和发票，也能帮你起草单据，你确认后才会提交。" : "I can look up purchasing, inventory and invoices, and draft documents for you to confirm."}</p>
                {notice ? (
                  <p role="status" data-testid="ai-readiness-notice" data-code={notice} className="mt-4 rounded-lg px-3 py-2 text-[13px] leading-relaxed" style={{ background: A.gray6, color: A.gray1 }}>
                    {translate(language, `ai.v2.notice.${notice}` as const)}
                  </p>
                ) : null}
                {/* The decisions waiting on Today, with their buttons (docs/drafted-decisions-design.md §4.8). */}
                <div className="mt-5"><TodayDecisionCards /></div>
                {emptyPrompts.length ? (
                  <div className="mt-5 grid grid-cols-2 gap-2.5">
                    {emptyPrompts.slice(0, 4).map((prompt, index) => {
                      const Icon = emptyPromptIcons[index] || MessageSquareText;
                      return (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => askAi(prompt)}
                          disabled={asking}
                          data-testid="ai-empty-prompt-chip"
                          data-starter={setupStarters ? "setup" : "workspace"}
                          className="flex min-h-[92px] flex-col items-start gap-2.5 rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/40 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "#EFF4FF" }}><Icon size={15} style={{ color: A.blue }} aria-hidden /></span>
                          <span className="text-[13px] font-medium leading-snug" style={{ color: A.label }}>{prompt}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}
            {messages.length > 0 && (
              <div className="space-y-6">
                {messages.map((message, index) => message.role === "user" ? (
                  <div key={`${message.role}-${index}`} className="flex justify-end">
                    <div data-testid="ai-message-user" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-sm leading-relaxed" style={{ background: "#EFF4FF", color: A.label }}>
                      {message.content}
                    </div>
                  </div>
                ) : message.v2 ? (
                  <div key={message.id || `${message.role}-${index}`} data-testid="ai-message-assistant" className="text-sm leading-relaxed" style={{ color: A.label }}>
                    <AssistantV2Answer
                      message={message.v2}
                      threadId={threadId}
                      fallbackMessageId={message.id || `answer-${index}`}
                      latest={index === lastAssistantIndex}
                      receipts={formReceipts}
                      onReceipt={recordFormReceipt}
                      setupReceipts={setupReceipts}
                      onSetupReceipt={recordSetupReceipt}
                      actionReceipts={actionReceipts}
                      onActionReceipt={recordActionReceipt}
                      onNavigate={minimizeAfterNavigate}
                      onFollowUp={askAi}
                      onRetry={message.question ? () => askAi(message.question || "") : undefined}
                    />
                  </div>
                ) : null)}
              </div>
            )}
          </div>

          {/* On a phone one row, the send button beside the text; docked, a taller box. */}
          <div className="shrink-0 px-3 pb-3 pt-2 lg:px-4 lg:pb-4">
            <div className="flex items-end gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm transition focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 lg:block lg:p-0">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                data-testid="ai-assistant-input"
                aria-label={zh ? "给助手的消息" : "Message to the assistant"}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!asking && !inputTooLong) askAi(input);
                  }
                }}
                disabled={asking}
                rows={1}
                placeholder={inputPlaceholder}
                onInput={(event) => { const target = event.currentTarget; target.style.height = "auto"; target.style.height = `${Math.min(target.scrollHeight, 160)}px`; }}
                className="block max-h-40 min-h-[40px] w-full flex-1 resize-none overflow-y-auto rounded-2xl bg-transparent px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-slate-400 disabled:cursor-not-allowed lg:min-h-[60px] lg:px-3.5 lg:pb-0 lg:pt-3"
                style={{ color: A.label, fontFamily: "inherit" }}
              />
              <div className="flex shrink-0 items-center justify-end p-1 lg:px-2 lg:pb-2 lg:pt-0">
                <button
                  type="button"
                  onClick={() => asking ? cancelRequest() : askAi(input)}
                  disabled={!asking && (!input.trim() || inputTooLong)}
                  data-testid={asking ? "ai-assistant-stop" : "ai-assistant-send"}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white disabled:cursor-not-allowed"
                  style={{ background: asking || input.trim() ? A.blue : A.gray3 }}
                  aria-label={asking ? translate(language, "ai.v2.stop") : (language === "zh-CN" ? "发送" : "Send")}
                  title={asking ? translate(language, "ai.v2.stop") : undefined}
                >
                  {asking ? <Square size={13} /> : <Send size={15} />}
                </button>
              </div>
            </div>
            {inputTooLong ? (
              <p data-testid="ai-input-too-long" role="status" className="mt-1 px-1 text-[12px]" style={{ color: "#9A3412" }}>
                {translate(language, "ai.v2.input.tooLong", { count: inputLength.toLocaleString(language), limit: questionLimit.toLocaleString(language) })}
              </p>
            ) : null}
          </div>
        </aside>
      )}

      {/* The launcher only while the assistant is closed: open, it covers nothing.
          On a phone it is a 48 px round icon, so it hides less of the page;
          its name is still read out. The main area's bottom padding (pb-20,
          FlowChainApp) keeps the end of every page clear of it. */}
      {!open && (
        <button
          ref={restoreButtonRef}
          onClick={restoreAssistant}
          data-testid="ai-assistant-toggle"
          className="fixed bottom-3 right-3 z-40 flex h-12 w-12 items-center justify-center rounded-full text-sm font-semibold text-white shadow-xl transition-shadow hover:shadow-2xl sm:bottom-5 sm:right-5 sm:w-auto sm:justify-start sm:gap-2 sm:pl-4 sm:pr-5"
          style={{ background: A.blue }}
          aria-label={language === "zh-CN" ? "展开 AI 助手" : "Open AI assistant"}
        >
          <Sparkles size={20} aria-hidden className="sm:h-[17px] sm:w-[17px]" />
          <span className="sr-only sm:not-sr-only">{language === "zh-CN" ? "AI 助手" : "AI assistant"}</span>
        </button>
      )}
    </div>
  );
}
