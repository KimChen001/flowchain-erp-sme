import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { AlertTriangle, ArrowRight, Link2, Loader2, Printer, ShieldCheck } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, useConfirm } from "../../components/ui";
import { StatusChip, listHeadRowStyle, statusToneOf } from "../../components/ui/listLayout";
import { tableMinSmClass, tableScrollClass, tdClass, tdIdClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { createSecureClientMutationId } from "../../lib/client-id";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { RecordBillAction } from "../../components/business/BillingEntryActions";
import PrintLayoutEditor from "../print-layout/PrintLayoutEditor";
import { adaptReceivingDetailSheet } from "../print-layout/printDataAdapters";
import { formatDecimal, formatInstantDay } from "../business-documents/documentFormat";
import { DocumentNumber } from "../../lib/documentNumbers";
import { BackToListLink } from "../procurement/BackToListLink";
import { procurementErrorCode, procurementErrorText } from "../procurement/procurementErrors";

type Capability = { enabled?: boolean; maturity?: string };
type Detail = {
  receivingDocument: { id: string; documentNumber: string; workflowStatus: string; postingStatus: string; qualityStatus: string; version: number; arrivedAt?: string | null; postedAt?: string | null; postedById?: string | null; reversedAt?: string | null; reversedById?: string | null; reversalReason?: string | null; receiver?: string | null; supplier?: { name?: string }; warehouse?: { id?: string; name?: string; code?: string } | null };
  // number: the order's document number (shown); id: its internal id (links).
  purchaseOrder: { id: string; number?: string; workflowStatus: string; fulfillmentStatus: string };
  lines: Array<{ id: string; poLineId: string; sku: string; itemName: string; orderedQuantity: string; previouslyReceivedQuantity: string; documentAcceptedQuantity: string; currentlyAppliedQuantity: string; acceptedQuantity: string; rejectedQuantity: string; remainingReceivableQuantity: string; unit?: string; warehouse?: { id?: string; name?: string; code?: string } | null; location?: string; lotSerialCapability: { postingAvailable: boolean; message: string } }>;
  postingSummary: { acceptedQuantity: string; rejectedQuantity: string; lineCount: number };
  capabilities: { posting?: Capability; reversal?: Capability };
  availableActions: { canEditDraft?: boolean; canSubmit?: boolean; canCancel?: boolean; canPost: boolean; canReverse: boolean; canViewReversal: boolean; primaryAction: "post" | "reverse" | "view_reversal" | null; blockingReasonCodes: string[] };
  limitations: string[];
};
type Preview = { operation: "post" | "reverse"; allowed: boolean; blockingIssues: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }>; inventoryImpacts: Array<Record<string, string>>; purchaseOrderImpacts: Array<Record<string, string>>; statusImpact: Record<string, string>; factsToCreate: { inventoryMovementCount: number; auditEventCount: number; commandExecutionCount: number }; limitations: string[] };
type Link = { label: string; count: number; targetRouteId: string; targetType: string; targetId?: string; filter?: Record<string, unknown>; enabled: boolean; unavailableReason?: string | null; unavailableReasonCode?: string | null };
type TimelineEvent = { id: string; type: string; event: string; occurredAt: string; label: string; actorId?: string; actorName?: string | null; postedFact: boolean; data?: Record<string, unknown> | null };
type Reconciliation = { status: "matched" | "mismatch" | "unavailable"; reason?: string; entries: Array<{ sku: string; warehouseId?: string | null; locationKey: string; status: string; calculatedQuantity: string; recordedQuantity: string | null; differenceQuantity: string | null }> };
type Navigate = (routeId: string, focus?: { entityType: string; entityId: string } | null, options?: { source?: string; entityLabel?: string }) => void;
type Pair = [string, string];

const newKey = () => createSecureClientMutationId("receiving");
// English source copy with its Chinese translation, for the draft actions.
const DRAFT_COPY: Record<string, Pair> = {
  editDraft: ["Edit draft", "编辑草稿"],
  submitDraft: ["Submit for posting", "提交过账"],
  submitting: ["Submitting…", "正在提交…"],
  submitFailed: ["The receipt could not be submitted.", "收货单提交失败。"],
  draftNote: ["This receipt is a draft. Submit it to post it to inventory.", "该收货单为草稿，提交后方可过账入库。"],
  cancelReceipt: ["Cancel receipt", "取消收货单"],
  cancelTitle: ["Cancel this receipt?", "取消该收货单？"],
  cancelBody: ["Nothing from it will be posted to inventory.", "其中的内容不会过账入库。"],
  cancelReason: ["Why is it cancelled?", "取消原因"],
  keepReceipt: ["Keep receipt", "保留收货单"],
  cancelFailed: ["The receipt could not be cancelled.", "收货单取消失败。"],
};

// The command errors by their stable code, in English with the Chinese translation.
const ERROR_COPY: Record<string, Pair> = {
  CAPABILITY_NOT_AVAILABLE: ["Receipt posting is turned off for this workspace. Ask an administrator to turn it on.", "当前工作区未开启收货过账，请联系管理员开启。"],
  AUTHENTICATION_REQUIRED: ["Your session has expired. Sign in again.", "登录已过期，请重新登录。"],
  PERMISSION_DENIED: ["Your role cannot perform this receiving action.", "你的角色无权执行此收货操作。"],
  TENANT_CONTEXT_REQUIRED: ["No workspace is selected for this session. Sign in again.", "当前会话未选择工作区，请重新登录。"],
  ACTOR_NOT_PROVISIONED: ["Your account has not been added to this workspace.", "你的账号尚未加入此工作区。"],
  RECEIVING_NOT_FOUND: ["This receipt is not available in this workspace.", "此工作区中找不到该收货单。"],
  RECEIVING_VALIDATION_FAILED: ["The receipt does not meet the posting rules. Review its status and lines.", "收货单不符合过账规则，请检查其状态和明细。"],
  RECEIVING_OVER_RECEIPT: ["Accepted quantity exceeds the remaining purchase order quantity.", "合格数量超过采购订单的剩余数量。"],
  RECEIVING_ALREADY_POSTED: ["This receipt has already been posted. Data was refreshed.", "该收货单已过账，数据已刷新。"],
  RECEIVING_CONCURRENT_POSTING_CONFLICT: ["The receipt changed while you were reviewing it. Data was refreshed; review the impact again.", "收货单在复核期间发生变化，数据已刷新，请重新复核影响。"],
  RECEIVING_VERSION_CONFLICT: ["The receipt was changed by someone else. Data was refreshed; review again.", "收货单已被他人修改，数据已刷新，请重新复核。"],
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: ["This confirmation was already used for a different request. Start a new review.", "该确认已用于其他请求，请重新开始复核。"],
  RECEIVING_ALREADY_REVERSED: ["This receipt has already been reversed. Data was refreshed.", "该收货单已冲销，数据已刷新。"],
  RECEIVING_REVERSAL_NOT_SAFE: ["Reversal is blocked: the received stock has already been used or the balance is too low.", "无法冲销：已收库存已被使用或余额不足。"],
};

// Review dialog notes by code. In English the server's message is shown,
// since it can name the exact line or movement; in Chinese the code's
// translation, or the server's message when the code is not listed here.
const ISSUE_COPY: Record<string, Pair> = {
  REVERSAL_REASON_REQUIRED_ON_CONFIRM: ["A reversal reason is required when confirming.", "确认冲销前请填写冲销原因。"],
  RECEIVING_REVERSAL_BLOCKED_BY_INVOICE: ["A supplier invoice already claims this receipt, so it can no longer be reversed. To send these goods back, use a supplier return.", "已有采购发票关联此收货单，无法冲销。如需退回货物，请发起供应商退货。"],
  RECEIVING_ALREADY_POSTED: ["This receipt has already been posted.", "该收货单已过账。"],
  RECEIVING_ALREADY_REVERSED: ["This receipt has already been reversed.", "该收货单已冲销。"],
  RECEIVING_OVER_RECEIPT: ["Accepted quantity exceeds the remaining purchase order quantity.", "合格数量超过采购订单的剩余数量。"],
  RECEIVING_VALIDATION_FAILED: ["The receipt does not meet the posting rules.", "收货单不符合过账规则，请检查其状态和明细。"],
  RECEIVING_REVERSAL_NOT_SAFE: ["Reversal is blocked: the received stock has already been used or the balance is too low.", "无法冲销：已收库存已被使用或余额不足。"],
};

// The smart links the server names, shown in the interface language. The
// server's label stays the key.
const LINK_COPY: Record<string, Pair> = {
  "Purchase Order": ["Purchase order", "采购订单"],
  Movements: ["Movements", "库存移动"],
  Balances: ["Balances", "库存余额"],
  Audit: ["Audit", "审计记录"],
  Reversal: ["Reversal", "冲销"],
};

// Why a related-records button is off, by the server's code (or, from an
// older server, its English sentence).
const LINK_UNAVAILABLE_COPY: Record<string, Pair> = {
  NO_RECORDS: ["No related records yet.", "暂无相关记录。"],
  "No authoritative records are available.": ["No related records yet.", "暂无相关记录。"],
};

// Movement kinds as the server's timeline names them.
const MOVEMENT_COPY: Record<string, Pair> = {
  "Receipt posting": ["Receipt posting", "收货过账"],
  "Receipt reversal": ["Receipt reversal", "收货冲销"],
  "Inventory movement": ["Inventory movement", "库存移动"],
};

// Receipt audit actions; {doc} is the receipt number.
const AUDIT_COPY: Record<string, Pair> = {
  receiving_draft_created: ["Receipt draft {doc} created", "收货草稿 {doc} 已创建"],
  receiving_draft_revised: ["Receipt draft {doc} revised", "收货草稿 {doc} 已修改"],
  receiving_submitted: ["Receipt {doc} submitted for posting", "收货单 {doc} 已提交过账"],
  receiving_cancelled: ["Receipt {doc} cancelled", "收货单 {doc} 已取消"],
  receiving_posted: ["Receipt {doc} posted to inventory", "收货单 {doc} 已过账入库"],
  receiving_reversed: ["Receipt {doc} reversed", "收货单 {doc} 已冲销"],
};

const BUTTON = {
  primary: "inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50",
  secondary: "inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
  danger: "inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
};

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

function errorMessage(error: unknown, language: string, fallback: Pair = ["Receiving data could not be loaded.", "收货数据加载失败。"]) {
  const index = language === "en-US" ? 0 : 1;
  if (!(error instanceof ApiError)) return fallback[index];
  return ERROR_COPY[error.code || ""]?.[index] || procurementErrorText(error, language, fallback);
}

// The sentence after "The receipt could not be submitted." when the code has none of its own.
const RETRY: Pair = ["Try again in a moment.", "请稍后重试。"];

export default function ReceivingPostingWorkbench({ receivingDocumentId, onNavigate }: { receivingDocumentId: string; onNavigate?: Navigate }) {
  const { language, locale, timezone, t, formatDateTime } = useI18n();
  const languageRef = useRef(language);
  languageRef.current = language;
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const sayPair = (pair: Pair) => say(pair[0], pair[1]);
  const draftCopy = (key: string) => sayPair(DRAFT_COPY[key]);
  const confirmDialog = useConfirm();
  const warehouseName = useWarehouseNames();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  // Timeline groups a person opened to read line by line.
  const [openEventGroups, setOpenEventGroups] = useState<Set<string>>(() => new Set());
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // The failed request's code and status, in the message's tooltip for support.
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [actionKey, setActionKey] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  // The reconciliation table, when every balance matches, opens on request.
  const [showReconciliation, setShowReconciliation] = useState(false);

  const refresh = useCallback(async () => {
    if (!receivingDocumentId) return;
    setLoading(true); setError(""); setErrorCode(undefined);
    try {
      const encoded = encodeURIComponent(receivingDocumentId);
      const [nextDetail, nextLinks, nextEvidence, nextReconciliation] = await Promise.all([
        apiJson<Detail>(`/api/procurement/receiving/${encoded}`),
        apiJson<{ links: Link[] }>(`/api/procurement/receiving/${encoded}/links`),
        apiJson<{ events: TimelineEvent[] }>(`/api/procurement/receiving/${encoded}/evidence`),
        apiJson<Reconciliation>(`/api/procurement/receiving/${encoded}/reconciliation`),
      ]);
      setDetail(nextDetail); setLinks(nextLinks.links); setEvents(nextEvidence.events); setReconciliation(nextReconciliation);
    } catch (nextError) { setError(errorMessage(nextError, languageRef.current)); setErrorCode(procurementErrorCode(nextError)); setDetail(null); }
    finally { setLoading(false); }
  }, [receivingDocumentId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useDetailCrumb(detail?.receivingDocument.documentNumber);

  const operation = detail?.availableActions.primaryAction === "reverse" ? "reverse" : "post";
  const capability = operation === "post" ? detail?.capabilities.posting : detail?.capabilities.reversal;
  const canOfferAction = detail?.availableActions.primaryAction === "post" || detail?.availableActions.primaryAction === "reverse";
  const totals = useMemo(() => ({ movement: links.find((item) => item.label === "Movements")?.count, balances: links.find((item) => item.label === "Balances")?.count }), [links]);

  async function submitDraft() {
    if (!detail) return;
    setSaving(true); setError("");
    try {
      await apiJson(`/api/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/submit`, { method: "POST", body: JSON.stringify({ idempotencyKey: newKey(), expectedVersion: detail.receivingDocument.version }) });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof ApiError ? `${draftCopy("submitFailed")} ${errorMessage(nextError, language, RETRY)}` : draftCopy("submitFailed"));
      setErrorCode(procurementErrorCode(nextError));
      if (nextError instanceof ApiError && nextError.status === 409) await refresh();
    } finally { setSaving(false); }
  }

  async function cancelReceipt() {
    if (!detail) return;
    const reason = await confirmDialog.prompt({
      title: draftCopy("cancelTitle"),
      description: draftCopy("cancelBody"),
      field: { label: draftCopy("cancelReason") },
      confirmLabel: draftCopy("cancelReceipt"),
      cancelLabel: draftCopy("keepReceipt"),
      tone: "danger",
    });
    if (!reason) return;
    setSaving(true); setError("");
    try {
      await apiJson(`/api/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/cancel`, { method: "POST", body: JSON.stringify({ idempotencyKey: newKey(), expectedVersion: detail.receivingDocument.version, reason }) });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof ApiError ? `${draftCopy("cancelFailed")} ${errorMessage(nextError, language, RETRY)}` : draftCopy("cancelFailed"));
      setErrorCode(procurementErrorCode(nextError));
      if (nextError instanceof ApiError && nextError.status === 409) await refresh();
    } finally { setSaving(false); }
  }

  async function openPreview(nextOperation: "post" | "reverse") {
    setError(""); setReason(""); setActionKey(newKey());
    try { setPreview(await apiJson<Preview>(`/api/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/impact-preview?operation=${nextOperation}`)); }
    catch (nextError) { setError(errorMessage(nextError, language, ["The posting review could not be opened.", "无法打开过账复核。"])); setErrorCode(procurementErrorCode(nextError)); }
  }

  async function confirm() {
    if (!detail || !preview || !actionKey || (preview.operation === "reverse" && !reason.trim())) return;
    setSaving(true); setError("");
    try {
      await apiJson(`/api/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/${preview.operation}`, {
        method: "POST", body: JSON.stringify(preview.operation === "post" ? { idempotencyKey: actionKey, expectedVersion: detail.receivingDocument.version } : { idempotencyKey: actionKey, reason: reason.trim() }),
      });
      setPreview(null); await refresh();
    } catch (nextError) {
      setError(errorMessage(nextError, language, ["The receiving action could not be completed.", "收货操作未完成。"]));
      setErrorCode(procurementErrorCode(nextError));
      if (nextError instanceof ApiError && nextError.status === 409) { setPreview(null); await refresh(); }
    } finally { setSaving(false); }
  }

  if (loading) return <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm" data-testid="receiving-loading"><Loader2 className="animate-spin" size={18} />{say("Loading receipt…", "正在读取收货单…")}</div>;
  if (!detail) return <div className="space-y-3"><BackToListLink list="receiving" /><div className="rounded-xl border p-6" data-testid="receiving-error" title={errorCode}><AlertTriangle className="mb-2" color={A.red} />{error || say("This receipt is unavailable.", "该收货单暂时无法查看。")}<button className="ml-3 underline" onClick={() => void refresh()}>{say("Retry", "重试")}</button></div></div>;

  const unavailable = say("Unavailable", "不可用");
  // A disabled related-records button says why in the interface language.
  const linkUnavailableText = (link: Link) => {
    const pair = LINK_UNAVAILABLE_COPY[link.unavailableReasonCode || ""] || LINK_UNAVAILABLE_COPY[link.unavailableReason || ""];
    return pair ? sayPair(pair) : language === "en-US" ? link.unavailableReason || undefined : sayPair(LINK_UNAVAILABLE_COPY.NO_RECORDS);
  };
  // Quantities are recorded as decimal strings; they are shown in the
  // workspace number format, with only the fraction digits that are not zero.
  const qty = (value?: string | null) => formatDecimal(value, locale);
  // Instants in the workspace locale and timezone.
  const stamp = (value?: string | null) => value && Number.isFinite(new Date(value).getTime()) ? formatDateTime(value) : "—";
  // Status codes stay stored as codes; only their label follows the language.
  const statusText = (code?: string | null) => code ? statusCodeLabel(code, language) || code.replaceAll("_", " ") : unavailable;
  const chip = (code?: string | null) => <StatusChip label={statusText(code)} tone={statusToneOf(code)} />;
  const issueText = (issue: { code: string; message: string }) => language === "en-US" ? issue.message || ISSUE_COPY[issue.code]?.[0] || issue.code : ISSUE_COPY[issue.code]?.[1] || issue.message;
  // The timeline says what happened and who did it. Command bookkeeping
  // repeats the change log, and notes are shown once below, so both stay out.
  const shownEvents = events.filter((event) => event.type !== "human_activity" && event.type !== "limitation");
  const eventKind = (event: TimelineEvent) =>
    event.type === "audit" ? say("Change", "变更") : event.postedFact ? say("Posted", "已过账") : say("Recorded", "已记录");
  // Lot and serial numbers are the one limitation a user can act on.
  const notes = detail.limitations.some((item) => /lot\/serial/i.test(item))
    ? [say("Lot and serial numbers are not recorded on receipts yet.", "收货暂不记录批次号和序列号。")]
    : [];
  const grn = detail.receivingDocument;
  // A PO line named by its item and its position on this receipt, not its id.
  const poLineName = (poLineId?: string) => {
    const position = detail.lines.findIndex((line) => line.poLineId === poLineId);
    if (position < 0) return say("Purchase order line", "采购订单行");
    const line = detail.lines[position];
    return [line.sku, say(`Line ${position + 1}`, `第 ${position + 1} 行`)].filter(Boolean).join(" · ");
  };
  const documentNumber = grn.documentNumber || grn.id;
  // The timeline's fixed wording in the interface language; the recorded
  // values (numbers, SKUs, reasons) are shown as recorded. An event this page
  // does not know keeps the server's label.
  const eventLabel = (event: TimelineEvent) => {
    const data = record(event.data);
    if (event.event === "receiving_created") return say(`Receipt ${documentNumber} created`, `收货单 ${documentNumber} 已创建`);
    if (event.event === "inventory_movement_created") {
      const [kind, sku, quantity, ...rest] = event.label.split(" · ");
      const pair = MOVEMENT_COPY[kind];
      return pair && sku && quantity && !rest.length ? `${sayPair(pair)} · ${sku} · ${qty(quantity)}` : event.label;
    }
    if (event.event === "inventory_balance_changed") {
      const sku = text(data.sku), before = text(record(data.before).onHandQuantity), after = text(record(data.after).onHandQuantity);
      if (before && after) return say(`On hand ${sku}: ${qty(before)} → ${qty(after)}`, `在手库存 ${sku}：${qty(before)} → ${qty(after)}`);
    }
    if (event.event === "purchase_order_line_received_changed") {
      const sku = detail.lines.find((line) => line.poLineId === text(data.purchaseOrderLineId))?.sku;
      const before = text(data.receivedBefore), after = text(data.receivedAfter);
      if (before && after) return say(`PO received${sku ? ` ${sku}` : ""}: ${qty(before)} → ${qty(after)}`, `采购订单已收${sku ? ` ${sku}` : ""}：${qty(before)} → ${qty(after)}`);
    }
    if (event.event === "purchase_order_workflow_changed") return say(`PO status: ${statusText(text(data.before))} → ${statusText(text(data.after))}`, `采购订单状态：${statusText(text(data.before))} → ${statusText(text(data.after))}`);
    if (event.event === "purchase_order_fulfillment_changed") return say(`PO fulfillment: ${statusText(text(data.before))} → ${statusText(text(data.after))}`, `订单履约：${statusText(text(data.before))} → ${statusText(text(data.after))}`);
    if (event.type === "audit" && AUDIT_COPY[event.event]) {
      const summary = sayPair(AUDIT_COPY[event.event]).replace("{doc}", documentNumber);
      const recordedReason = text(data.reason).trim();
      return recordedReason ? `${summary}${say(": ", "：")}${recordedReason}` : summary;
    }
    return event.label;
  };
  // One receipt posts a movement, a balance change and a PO quantity change
  // for every line, all at the same moment. More than three of a kind read as
  // one entry ("On hand updated for 18 items") that opens to the lines.
  const EVENT_GROUP_AFTER = 3;
  const eventGroupKey = (event: TimelineEvent) =>
    [event.event, event.event === "inventory_movement_created" ? event.label.split(" · ")[0] : "", stamp(event.occurredAt), eventKind(event)].join("|");
  // Consecutive events of one kind at one moment form a group; the group's
  // key adds its position, so two runs of the same kind stay apart.
  const eventGroups = shownEvents.reduce<Array<{ kind: string; key: string; events: TimelineEvent[] }>>((groups, event) => {
    const kind = eventGroupKey(event);
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.events.push(event);
    else groups.push({ kind, key: `${kind}#${groups.length}`, events: [event] });
    return groups;
  }, []);
  const eventGroupLabel = (group: TimelineEvent[]) => {
    const first = group[0];
    const count = group.length;
    if (first.event === "inventory_movement_created") {
      const kind = first.label.split(" · ")[0];
      const name = MOVEMENT_COPY[kind] ? sayPair(MOVEMENT_COPY[kind]) : kind;
      return say(`${name} · ${count} lines`, `${name} · ${count} 行`);
    }
    if (first.event === "inventory_balance_changed") return say(`On hand updated for ${count} items`, `${count} 个物料的在手库存已更新`);
    if (first.event === "purchase_order_line_received_changed") return say(`PO received quantity updated on ${count} lines`, `采购订单 ${count} 行的已收数量已更新`);
    return say(`${eventLabel(first)} and ${count - 1} more`, `${eventLabel(first)} 等 ${count} 条`);
  };
  const toggleEventGroup = (key: string) => setOpenEventGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // The balance key lower-cases the location; show the location as the
  // receipt line recorded it when the line can be found.
  const recordedLocation = (sku: string, locationKey: string) =>
    detail.lines.find((line) => line.sku === sku && String(line.location || "").trim().toLowerCase() === locationKey)?.location || locationKey || "—";
  const reconciliationReason = reconciliation?.status === "unavailable" && !reconciliation.entries.length
    ? say("Nothing from this receipt has been posted to inventory yet.", "该收货单尚未过账入库，暂无可核对的库存。")
    : reconciliation?.reason || say("Reconciliation is unavailable.", "暂无库存核对结果。");
  const facts: Array<[string, React.ReactNode]> = [
    [say("Workflow", "流程状态"), chip(grn.workflowStatus)],
    [say("Posting", "过账状态"), chip(grn.postingStatus)],
    [say("PO fulfillment", "订单履约"), chip(detail.purchaseOrder.fulfillmentStatus)],
    [say("Warehouse", "仓库"), grn.warehouse?.name || unavailable],
    [say("Receiver", "收货人"), grn.receiver || "—"],
    [say("Arrived", "到货时间"), stamp(grn.arrivedAt)],
    [grn.postingStatus === "reversed" ? say("Reversed", "冲销时间") : say("Posted", "过账时间"), stamp(grn.reversedAt || grn.postedAt)],
  ];
  // One row of totals under the header facts; the posting status is already
  // among the header facts, so it is not repeated here.
  const summary: Array<[string, React.ReactNode]> = [
    [say("Total accepted", "合格总数"), qty(detail.postingSummary.acceptedQuantity)],
    [say("Total rejected", "拒收总数"), qty(detail.postingSummary.rejectedQuantity)],
    [say("Movements", "库存移动"), totals.movement === undefined ? "—" : String(totals.movement)],
    [say("Affected balances", "影响的库存余额"), totals.balances === undefined ? "—" : String(totals.balances)],
    [say("Reconciliation", "库存核对"), reconciliation ? chip(reconciliation.status) : unavailable],
  ];
  // The lines' warehouse column shows only when a line is stored somewhere
  // other than the receipt's warehouse, which the header already names.
  const warehouseKey = (warehouse?: { id?: string; name?: string; code?: string } | null) => warehouse ? warehouse.id || warehouse.code || warehouse.name || "" : "";
  const showLineWarehouse = detail.lines.some((line) => warehouseKey(line.warehouse) !== warehouseKey(grn.warehouse));
  const lineColumns: Array<[string, boolean]> = [
    ["SKU", false], [say("Item", "物料"), false], [say("Ordered", "订购"), true], [say("Received before", "此前已收"), true],
    [say("Accepted", "本单合格"), true], [say("Posted qty", "已过账数量"), true], [say("Rejected", "拒收"), true],
    [say("Open", "未收"), true], ...(showLineWarehouse ? [[say("Warehouse", "仓库"), false] as [string, boolean]] : []), [say("Location", "库位"), false], [say("Unit", "单位"), false],
  ];
  // Every balance matching its movements is said in one line; the table
  // opens on request. Any difference shows the table at once.
  const reconciliationEntries = reconciliation?.entries || [];
  const allBalancesMatch = reconciliation?.status === "matched" && reconciliationEntries.length > 0 && reconciliationEntries.every((entry) => entry.status === "matched");
  const matchedSummary = reconciliationEntries.length === 1
    ? say("The balance matches its movements.", "该库存余额与库存移动一致。")
    : say(`All ${reconciliationEntries.length} balances match their movements.`, `全部 ${reconciliationEntries.length} 个库存余额与库存移动一致。`);
  const showReconciliationTable = reconciliationEntries.length > 0 && (!allBalancesMatch || showReconciliation);
  const reconciliationColumns: Array<[string, boolean]> = [
    ["SKU", false], [say("Warehouse", "仓库"), false], [say("Location", "库位"), false], [say("Calculated from movements", "按库存移动计算"), true],
    [say("Recorded balance", "账面余额"), true], [say("Difference", "差异"), true], [say("Status", "状态"), false],
  ];
  const actionButton = canOfferAction && <button data-testid="receiving-primary-action" onClick={() => void openPreview(operation)} className={operation === "post" ? BUTTON.primary : BUTTON.danger}>{operation === "post" ? say("Post receipt", "过账入库") : say("Reverse receipt", "冲销收货")}</button>;
  return <div className="space-y-4" data-testid="receiving-workbench">
    <BackToListLink list="receiving" />
    {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert" title={errorCode}>{error}</div>}
    <section className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="fc-page-title">{grn.documentNumber}</h1><p className="mt-1 text-sm text-gray-500">{grn.supplier?.name || say("Unknown supplier", "未知供应商")} · {say("Purchase order", "采购订单")} <a className="text-blue-600 underline" href={`/app/procurement/orders/${encodeURIComponent(detail.purchaseOrder.id)}`}><DocumentNumber type="purchase_order" id={detail.purchaseOrder.id} number={detail.purchaseOrder.number} /></a></p></div>
        {/* Non-destructive actions first; cancelling or reversing the receipt comes last, tinted red. */}
        <div className="flex flex-wrap items-center gap-2">
          <button data-testid="receiving-print-sheet" aria-label={say(`Print receive sheet ${grn.documentNumber}`, `打印入库单 ${grn.documentNumber}`)} onClick={() => setPrinting(true)} className={BUTTON.secondary}><Printer size={14} />{say("Print receive sheet", "打印入库单")}</button>
          {detail.availableActions.canEditDraft && <a data-testid="receiving-edit-draft" href={`/app/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/edit`} className={BUTTON.secondary}>{draftCopy("editDraft")}</a>}
          {detail.availableActions.canSubmit && <button data-testid="receiving-submit-draft" disabled={saving} onClick={() => void submitDraft()} className={BUTTON.primary}>{saving ? draftCopy("submitting") : draftCopy("submitDraft")}</button>}
          {operation === "post" && actionButton}
          {detail.availableActions.canViewReversal && <button onClick={() => { const link = links.find((item) => item.label === 'Reversal'); if (link?.enabled) onNavigate?.(link.targetRouteId, { entityType: link.targetType, entityId: link.targetId || receivingDocumentId }, { source: 'receiving-smart-link' }); }} className={BUTTON.secondary}>{say("View reversal", "查看冲销")}</button>}
          {grn.postingStatus === 'posted' && <RecordBillAction receiptId={grn.id} />}
          {detail.availableActions.canCancel && <button data-testid="receiving-cancel" disabled={saving} onClick={() => void cancelReceipt()} className={BUTTON.danger}>{draftCopy("cancelReceipt")}</button>}
          {operation === "reverse" && actionButton}
        </div>
      </div>
      {detail.availableActions.canSubmit && <div className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{draftCopy("draftNote")}</div>}
      {!capability?.enabled && <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{say("Read-only. Receipt posting is turned off for this workspace; an administrator can turn it on.", "只读。当前工作区未开启收货过账，可由管理员开启。")}</div>}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {facts.map(([name, value]) => <div key={name} className="rounded-xl bg-gray-50 p-3"><div className="text-xs" style={{ color: A.sub }}>{name}</div><div className="mt-1 text-sm font-semibold">{value}</div></div>)}
      </div>
      <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-3" data-testid="receiving-summary">
        {summary.map(([name, value]) => <div key={name} className="flex items-center gap-2"><dt className="text-xs" style={{ color: A.sub }}>{name}</dt><dd className="text-sm font-semibold tabular-nums">{value}</dd></div>)}
      </dl>
    </section>

    <section className="overflow-hidden rounded-2xl border bg-white">
      <div className="border-b px-4 py-3 text-sm font-semibold">{say("Receiving lines", "收货明细")}</div>
      <div className={tableScrollClass}><table className={tableMinSmClass}>
        <thead><tr style={listHeadRowStyle}>{lineColumns.map(([label, numeric]) => <th key={label} className={numeric ? thRightClass : thClass} style={{ color: A.gray1 }}>{label}</th>)}</tr></thead>
        <tbody>{detail.lines.map((line) => <tr key={line.id} className="border-t">
          <td className={tdIdClass}>{line.sku}</td>
          <td className={tdNowrapClass}><div className="max-w-[320px] truncate" title={line.itemName}>{line.itemName}</div></td>
          <td className={tdNumericRightClass}>{qty(line.orderedQuantity)}</td>
          <td className={tdNumericRightClass}>{qty(line.previouslyReceivedQuantity)}</td>
          <td className={`${tdNumericRightClass} font-semibold text-teal-700`}>{qty(line.documentAcceptedQuantity)}</td>
          <td className={tdNumericRightClass}>{qty(line.currentlyAppliedQuantity)}</td>
          <td className={tdNumericRightClass}>{qty(line.rejectedQuantity)}</td>
          <td className={tdNumericRightClass}>{qty(line.remainingReceivableQuantity)}</td>
          {showLineWarehouse && <td className={`${tdClass} min-w-[140px]`}>{line.warehouse?.name || line.warehouse?.code || unavailable}</td>}
          <td className={tdNowrapClass}>{line.location || "—"}</td>
          <td className={tdNowrapClass}>{line.unit ? unitLabel(line.unit, language) : "—"}</td>
        </tr>)}</tbody>
      </table></div>
    </section>

    <section className="rounded-2xl border bg-white p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Link2 size={16} />{say("Related records", "关联记录")}</div><div className="flex flex-wrap gap-2">{links.map((link) => <button key={link.label} disabled={!link.enabled} title={link.enabled ? undefined : linkUnavailableText(link)} onClick={() => onNavigate?.(link.targetRouteId, { entityType: link.targetType, entityId: link.targetId || receivingDocumentId }, { source: 'receiving-smart-link', entityLabel: link.label })} className={`rounded-lg border px-3 py-1.5 text-sm ${link.enabled ? 'text-blue-700 hover:bg-blue-50' : 'text-gray-400'}`}>{LINK_COPY[link.label] ? sayPair(LINK_COPY[link.label]) : link.label} · {link.count}</button>)}</div></section>

    <section className="overflow-hidden rounded-2xl border bg-white" data-testid="receiving-reconciliation">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">{say("Inventory reconciliation", "库存核对")}{reconciliation && chip(reconciliation.status)}</div>
      {allBalancesMatch && <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm${showReconciliation ? " border-b" : ""}`}>
        <span data-testid="receiving-reconciliation-summary">{matchedSummary}</span>
        <button type="button" data-testid="receiving-reconciliation-toggle" aria-expanded={showReconciliation} aria-controls={showReconciliation ? "receiving-reconciliation-table" : undefined} onClick={() => setShowReconciliation((open) => !open)} className="text-sm font-medium text-blue-600 hover:underline">{showReconciliation ? say("Hide details", "收起明细") : say("Show details", "显示明细")}</button>
      </div>}
      {showReconciliationTable ? <div id="receiving-reconciliation-table" className={tableScrollClass}><table className={tableMinSmClass}>
        <thead><tr style={listHeadRowStyle}>{reconciliationColumns.map(([label, numeric]) => <th key={label} className={numeric ? thRightClass : thClass} style={{ color: A.gray1 }}>{label}</th>)}</tr></thead>
        <tbody>{reconciliationEntries.map((entry) => <tr key={`${entry.sku}-${entry.warehouseId || ''}-${entry.locationKey}`} className="border-t">
          <td className={tdIdClass}>{entry.sku}</td>
          <td className={tdClass}>{warehouseName(entry.warehouseId) || say("No warehouse", "未指定仓库")}</td>
          <td className={tdNowrapClass}>{recordedLocation(entry.sku, entry.locationKey)}</td>
          <td className={tdNumericRightClass}>{qty(entry.calculatedQuantity)}</td>
          <td className={tdNumericRightClass}>{entry.recordedQuantity == null ? unavailable : qty(entry.recordedQuantity)}</td>
          <td className={`${tdNumericRightClass} ${entry.differenceQuantity != null && /[1-9]/.test(entry.differenceQuantity) ? 'text-red-700' : ''}`}>{qty(entry.differenceQuantity)}</td>
          <td className={tdNowrapClass}>{chip(entry.status)}</td>
        </tr>)}</tbody>
      </table></div> : !reconciliationEntries.length && <div className="p-4 text-sm text-gray-500">{reconciliationReason}</div>}
    </section>

    <section id="evidence" className="rounded-2xl border bg-white p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} />{say("Evidence timeline", "证据时间线")}</div><div className="space-y-3">{shownEvents.length ? eventGroups.map((group) => {
      const eventRow = (event: TimelineEvent) => <div key={event.id} className="flex gap-3 border-l-2 border-blue-200 pl-3" data-testid="evidence-event"><div className="w-40 shrink-0 text-xs tabular-nums text-gray-500">{stamp(event.occurredAt)}</div><div><div className="text-sm font-medium">{eventLabel(event)}</div><div className="text-[11px] text-gray-500">{eventKind(event)}{event.actorName ? ` · ${event.actorName}` : ''}</div></div></div>;
      if (group.events.length <= EVENT_GROUP_AFTER) return group.events.map(eventRow);
      const first = group.events[0];
      const open = openEventGroups.has(group.key);
      return <div key={group.key} className="space-y-3" data-testid="evidence-event-group">
        <div className="flex gap-3 border-l-2 border-blue-200 pl-3" data-testid="evidence-event"><div className="w-40 shrink-0 text-xs tabular-nums text-gray-500">{stamp(first.occurredAt)}</div><div className="min-w-0 flex-1"><div className="text-sm font-medium">{eventGroupLabel(group.events)}</div><div className="text-[11px] text-gray-500">{eventKind(first)}{first.actorName ? ` · ${first.actorName}` : ''}</div></div><button type="button" aria-expanded={open} data-testid="evidence-event-group-toggle" onClick={() => toggleEventGroup(group.key)} className="h-7 shrink-0 self-start rounded-md px-2 text-xs font-medium text-blue-600 hover:bg-blue-50">{open ? say("Hide lines", "收起") : say("Show lines", "展开")}</button></div>
        {open ? <div className="ml-4 space-y-3">{group.events.map(eventRow)}</div> : null}
      </div>;
    }) : <div className="text-sm text-gray-500">{say("No evidence connected.", "暂无关联证据。")}</div>}</div></section>
    {notes.length > 0 && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="receiving-notes">{notes.join(' ')}</div>}

    {preview && <div className="fc-overlay-enter fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="impact-preview"><div className="fc-dialog-enter max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
      <div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{preview.operation === 'post' ? say('Review receipt posting', '复核收货过账') : say('Review receipt reversal', '复核收货冲销')}</h2><p className="text-sm text-gray-500">{say("Nothing is recorded until you confirm.", "确认前不会记录任何变更。")}</p></div><button aria-label={say("Close", "关闭")} onClick={() => setPreview(null)}>✕</button></div>
      {preview.blockingIssues.map((issue, index) => <div key={`${issue.code}-${index}`} className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{issueText(issue)}</div>)}
      {preview.warnings.map((issue, index) => <div key={`${issue.code}-${index}`} className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{issueText(issue)}</div>)}
      <h3 className="mt-5 font-semibold">{say("Inventory impact", "库存影响")}</h3>{preview.inventoryImpacts.map((impact, index) => <div key={index} className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg bg-gray-50 p-3 text-sm"><span>{impact.sku}<br/><small>{warehouseName(impact.warehouseId)} / {impact.location || say('No location', '未指定库位')}</small></span><ArrowRight size={16}/><span data-testid="balance-impact">{say("On hand", "在手")} {qty(impact.onHandBefore)} → {qty(impact.onHandAfter)}<br/>{say("Available", "可用")} {qty(impact.availableBefore)} → {qty(impact.availableAfter)}</span></div>)}
      <h3 className="mt-5 font-semibold">{say("Purchase order impact", "采购订单影响")}</h3>{preview.purchaseOrderImpacts.map((impact, index) => <div key={index} className="mt-2 rounded-lg bg-gray-50 p-3 text-sm" title={impact.poLineId}>{poLineName(impact.poLineId)}: {qty(impact.receivedBefore)} → {qty(impact.receivedAfter)} · {say("Remaining", "剩余")} {qty(impact.remainingAfter)}</div>)}
      <div className="mt-4 rounded-lg border p-3 text-sm">{say("PO fulfillment", "订单履约")} {statusText(preview.statusImpact.poFulfillmentBefore)} → {statusText(preview.statusImpact.poFulfillmentAfter)} · {say(`${preview.factsToCreate.inventoryMovementCount} inventory movement(s), ${preview.factsToCreate.auditEventCount} audit event(s)`, `${preview.factsToCreate.inventoryMovementCount} 条库存移动，${preview.factsToCreate.auditEventCount} 条审计记录`)}</div>
      {preview.operation === 'reverse' && <label className="mt-4 block text-sm font-medium">{say("Reversal reason *", "冲销原因 *")}<textarea data-testid="reversal-reason" value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-lg border p-2" rows={3}/></label>}
      <div className="mt-5 flex justify-end gap-2"><button className={BUTTON.secondary} onClick={() => setPreview(null)}>{say("Cancel", "取消")}</button><button data-testid="confirm-receiving-action" disabled={!preview.allowed || saving || (preview.operation === 'reverse' && !reason.trim())} onClick={() => void confirm()} className={`inline-flex h-9 items-center rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-40 ${preview.operation === 'reverse' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>{saving ? say('Saving…', '正在保存…') : preview.operation === 'post' ? say('Confirm posting', '确认过账') : say('Confirm reversal', '确认冲销')}</button></div>
    </div></div>}
    {confirmDialog.element}
    {printing && <PrintLayoutEditor open documentType="receive_sheet" documentNo={grn.documentNumber || grn.id} data={adaptReceivingDetailSheet(detail, { quantity: (value) => formatDecimal(value, locale), rejectedLabel: (qty) => t("printLayout.rejectedQty", { qty }), day: (instant) => formatInstantDay(instant, locale, timezone) })} onClose={() => setPrinting(false)} />}
  </div>;
}
