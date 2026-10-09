import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Link2, Loader2, Printer, ShieldCheck } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { A } from "../../components/ui";
import { createSecureClientMutationId } from "../../lib/client-id";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useI18n } from "../../i18n/I18n";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { RecordBillAction } from "../../components/business/BillingEntryActions";
import PrintLayoutEditor from "../print-layout/PrintLayoutEditor";
import { adaptReceivingDetailSheet } from "../print-layout/printDataAdapters";
import { formatDecimal, formatInstantDay } from "../business-documents/documentFormat";

type Capability = { enabled?: boolean; maturity?: string };
type Detail = {
  receivingDocument: { id: string; documentNumber: string; workflowStatus: string; postingStatus: string; qualityStatus: string; version: number; arrivedAt?: string | null; postedAt?: string | null; postedById?: string | null; reversedAt?: string | null; reversedById?: string | null; reversalReason?: string | null; receiver?: string | null; supplier?: { name?: string }; warehouse?: { name?: string; code?: string } | null };
  purchaseOrder: { id: string; workflowStatus: string; fulfillmentStatus: string };
  lines: Array<{ id: string; poLineId: string; sku: string; itemName: string; orderedQuantity: string; previouslyReceivedQuantity: string; documentAcceptedQuantity: string; currentlyAppliedQuantity: string; acceptedQuantity: string; rejectedQuantity: string; remainingReceivableQuantity: string; unit?: string; warehouse?: { name?: string; code?: string } | null; location?: string; lotSerialCapability: { postingAvailable: boolean; message: string } }>;
  postingSummary: { acceptedQuantity: string; rejectedQuantity: string; lineCount: number };
  capabilities: { posting?: Capability; reversal?: Capability };
  availableActions: { canEditDraft?: boolean; canSubmit?: boolean; canCancel?: boolean; canPost: boolean; canReverse: boolean; canViewReversal: boolean; primaryAction: "post" | "reverse" | "view_reversal" | null; blockingReasonCodes: string[] };
  limitations: string[];
};
type Preview = { operation: "post" | "reverse"; allowed: boolean; blockingIssues: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }>; inventoryImpacts: Array<Record<string, string>>; purchaseOrderImpacts: Array<Record<string, string>>; statusImpact: Record<string, string>; factsToCreate: { inventoryMovementCount: number; auditEventCount: number; commandExecutionCount: number }; limitations: string[] };
type Link = { label: string; count: number; targetRouteId: string; targetType: string; targetId?: string; filter?: Record<string, unknown>; enabled: boolean; unavailableReason?: string | null };
type TimelineEvent = { id: string; type: string; event: string; occurredAt: string; label: string; actorId?: string; actorName?: string | null; postedFact: boolean };
type Reconciliation = { status: "matched" | "mismatch" | "unavailable"; reason?: string; entries: Array<{ sku: string; warehouseId?: string | null; locationKey: string; status: string; calculatedQuantity: string; recordedQuantity: string | null; differenceQuantity: string | null }> };
type Navigate = (routeId: string, focus?: { entityType: string; entityId: string } | null, options?: { source?: string; entityLabel?: string }) => void;

// This page is written in English; status codes use the shared English labels.
const pretty = (value?: string | null) => statusCodeLabel(value || "", "en-US") || value || "Unavailable";
const stamp = (value?: string | null) => value ? new Date(value).toLocaleString() : "Unavailable";
const newKey = () => createSecureClientMutationId("receiving");
// English source copy with its Chinese translation, for the draft actions.
const DRAFT_COPY: Record<string, [string, string]> = {
  editDraft: ["Edit draft", "编辑草稿"],
  submitDraft: ["Submit for posting", "提交过账"],
  submitting: ["Submitting…", "正在提交…"],
  submitFailed: ["The receipt could not be submitted.", "收货单提交失败。"],
  draftNote: ["This receipt is a draft. Submit it to post it to inventory.", "该收货单为草稿，提交后方可过账入库。"],
  cancelReceipt: ["Cancel receipt", "取消收货单"],
  cancelReason: ["Why is this receipt cancelled? Nothing will be posted to inventory.", "请输入取消原因（不会过账入库）"],
  cancelFailed: ["The receipt could not be cancelled.", "收货单取消失败。"],
};

function errorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "Receiving data could not be loaded.";
  const messages: Record<string, string> = {
    CAPABILITY_NOT_AVAILABLE: "Database receiving is disabled. Ask an administrator to enable the beta capability.",
    AUTHENTICATION_REQUIRED: "Your session has expired. Sign in again.",
    PERMISSION_DENIED: "Your role cannot perform this receiving action.",
    TENANT_CONTEXT_REQUIRED: "No authoritative tenant context is available for this session.",
    ACTOR_NOT_PROVISIONED: "Your account is not provisioned for this tenant.",
    RECEIVING_NOT_FOUND: "This receiving record is unavailable in the current tenant.",
    RECEIVING_VALIDATION_FAILED: "The receiving does not meet posting validation rules. Review its workflow and lines.",
    RECEIVING_OVER_RECEIPT: "Accepted quantity exceeds the remaining purchase order quantity.",
    RECEIVING_ALREADY_POSTED: "This receiving has already been posted. Data was refreshed.",
    RECEIVING_CONCURRENT_POSTING_CONFLICT: "The receiving changed concurrently. Data was refreshed; review the impact again.",
    RECEIVING_VERSION_CONFLICT: "The receiving version changed. Data was refreshed; review again.",
    IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: "This confirmation key was already used for a different request. Start a new review.",
    RECEIVING_ALREADY_REVERSED: "This receiving has already been reversed. Data was refreshed.",
    RECEIVING_REVERSAL_NOT_SAFE: "Reversal is blocked by downstream inventory use or insufficient balances.",
  };
  return messages[error.code || ""] || error.message;
}

export default function ReceivingPostingWorkbench({ receivingDocumentId, onNavigate }: { receivingDocumentId: string; onNavigate?: Navigate }) {
  const { language, locale, timezone, t } = useI18n();
  const draftCopy = (key: string) => DRAFT_COPY[key][language === "en-US" ? 0 : 1];
  const warehouseName = useWarehouseNames();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [actionKey, setActionKey] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);

  const refresh = useCallback(async () => {
    if (!receivingDocumentId) return;
    setLoading(true); setError("");
    try {
      const encoded = encodeURIComponent(receivingDocumentId);
      const [nextDetail, nextLinks, nextEvidence, nextReconciliation] = await Promise.all([
        apiJson<Detail>(`/api/procurement/receiving/${encoded}`),
        apiJson<{ links: Link[] }>(`/api/procurement/receiving/${encoded}/links`),
        apiJson<{ events: TimelineEvent[] }>(`/api/procurement/receiving/${encoded}/evidence`),
        apiJson<Reconciliation>(`/api/procurement/receiving/${encoded}/reconciliation`),
      ]);
      setDetail(nextDetail); setLinks(nextLinks.links); setEvents(nextEvidence.events); setReconciliation(nextReconciliation);
    } catch (nextError) { setError(errorMessage(nextError)); setDetail(null); }
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
      setError(nextError instanceof ApiError ? `${draftCopy("submitFailed")} ${nextError.message}` : draftCopy("submitFailed"));
      if (nextError instanceof ApiError && nextError.status === 409) await refresh();
    } finally { setSaving(false); }
  }

  async function cancelReceipt() {
    if (!detail) return;
    const reason = window.prompt(draftCopy("cancelReason"))?.trim() || "";
    if (!reason) return;
    setSaving(true); setError("");
    try {
      await apiJson(`/api/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/cancel`, { method: "POST", body: JSON.stringify({ idempotencyKey: newKey(), expectedVersion: detail.receivingDocument.version, reason }) });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof ApiError ? `${draftCopy("cancelFailed")} ${nextError.message}` : draftCopy("cancelFailed"));
      if (nextError instanceof ApiError && nextError.status === 409) await refresh();
    } finally { setSaving(false); }
  }

  async function openPreview(nextOperation: "post" | "reverse") {
    setError(""); setReason(""); setActionKey(newKey());
    try { setPreview(await apiJson<Preview>(`/api/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/impact-preview?operation=${nextOperation}`)); }
    catch (nextError) { setError(errorMessage(nextError)); }
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
      setError(errorMessage(nextError));
      if (nextError instanceof ApiError && nextError.status === 409) { setPreview(null); await refresh(); }
    } finally { setSaving(false); }
  }

  if (loading) return <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm" data-testid="receiving-loading"><Loader2 className="animate-spin" size={18} />Loading authoritative receiving data…</div>;
  if (!detail) return <div className="rounded-xl border p-6" data-testid="receiving-error"><AlertTriangle className="mb-2" color={A.red} />{error || "Receiving is unavailable."}<button className="ml-3 underline" onClick={() => void refresh()}>Retry</button></div>;

  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
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
  return <div className="space-y-4" data-testid="receiving-workbench">
    {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</div>}
    <section className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><div className="mb-2 flex items-center gap-2"><h1 className="text-xl font-semibold">{grn.documentNumber}</h1></div><p className="text-sm text-gray-500">{grn.supplier?.name || "Unknown supplier"} · PO <a className="text-blue-600 underline" href={`/app/procurement/orders/${encodeURIComponent(detail.purchaseOrder.id)}`}>{detail.purchaseOrder.id}</a></p></div>
        <div className="fc-detail-actions flex gap-2"><button data-testid="receiving-print-sheet" aria-label={say(`Print receive sheet ${grn.documentNumber}`, `打印入库单 ${grn.documentNumber}`)} onClick={() => setPrinting(true)} className="flex items-center gap-1 rounded-lg border px-4 py-2 text-sm font-semibold"><Printer size={14} />{say("Print receive sheet", "打印入库单")}</button>{detail.availableActions.canEditDraft && <a data-testid="receiving-edit-draft" href={`/app/procurement/receiving/${encodeURIComponent(receivingDocumentId)}/edit`} className="rounded-lg border px-4 py-2 text-sm font-semibold">{draftCopy("editDraft")}</a>}{detail.availableActions.canSubmit && <button data-testid="receiving-submit-draft" disabled={saving} onClick={() => void submitDraft()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? draftCopy("submitting") : draftCopy("submitDraft")}</button>}{detail.availableActions.canCancel && <button data-testid="receiving-cancel" disabled={saving} onClick={() => void cancelReceipt()} className="rounded-lg border px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">{draftCopy("cancelReceipt")}</button>}{canOfferAction && <button data-testid="receiving-primary-action" onClick={() => void openPreview(operation)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">{operation === "post" ? "Post Receipt" : "Reverse Receipt"}</button>}{detail.availableActions.canViewReversal && <button onClick={() => { const link = links.find((item) => item.label === 'Reversal'); if (link?.enabled) onNavigate?.(link.targetRouteId, { entityType: link.targetType, entityId: link.targetId || receivingDocumentId }, { source: 'receiving-smart-link' }); }} className="rounded-lg bg-gray-100 px-4 py-2 text-sm">View Reversal</button>}{grn.postingStatus === 'posted' && <RecordBillAction receiptId={grn.id} />}</div>
      </div>
      {detail.availableActions.canSubmit && <div className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{draftCopy("draftNote")}</div>}
      {!capability?.enabled && <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Read-only. Database receiving capability requires explicit administrator enablement.</div>}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Workflow', pretty(grn.workflowStatus)], ['Posting', pretty(grn.postingStatus)], ['PO Fulfillment', pretty(detail.purchaseOrder.fulfillmentStatus)], ['Warehouse', grn.warehouse?.name || 'Unavailable'], ['Receiver', grn.receiver || 'Unavailable'], ['Arrived', stamp(grn.arrivedAt)], [grn.postingStatus === 'reversed' ? 'Reversed' : 'Posted', stamp(grn.reversedAt || grn.postedAt)]].map(([name, value]) => <div key={name} className="rounded-xl bg-gray-50 p-3"><div className="text-[11px] uppercase tracking-wide text-gray-500">{name}</div><div className="mt-1 text-sm font-semibold">{value}</div></div>)}
      </div>
    </section>

    <section className="grid gap-3 md:grid-cols-3">
      {[['Total accepted', detail.postingSummary.acceptedQuantity], ['Total rejected', detail.postingSummary.rejectedQuantity], ['Movements', totals.movement === undefined ? 'Unknown' : String(totals.movement)], ['Affected balances', totals.balances === undefined ? 'Unknown' : String(totals.balances)], ['Posting status', pretty(grn.postingStatus)], ['Reconciliation', reconciliation ? pretty(reconciliation.status) : 'Unavailable']].map(([name, value]) => <div key={name} className="rounded-xl border bg-white p-4"><div className="text-xs text-gray-500">{name}</div><div className="mt-1 font-semibold">{value}</div></div>)}
    </section>

    <section className="overflow-hidden rounded-2xl border bg-white"><div className="border-b p-4 font-semibold">Receiving lines</div><div className="overflow-x-auto"><table className="min-w-[1120px] w-full text-left text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr>{['SKU','Item','Ordered','Previously Received','Accepted on Document','Currently Applied','Rejected','Remaining Receivable','Warehouse','Location','Unit'].map((item) => <th key={item} className="px-3 py-2">{item}</th>)}</tr></thead><tbody>{detail.lines.map((line) => <tr key={line.id} className="border-t"><td className="px-3 py-3 font-mono text-xs">{line.sku}</td><td className="px-3 py-3">{line.itemName}</td><td className="px-3 py-3">{line.orderedQuantity}</td><td className="px-3 py-3">{line.previouslyReceivedQuantity}</td><td className="px-3 py-3 font-semibold text-green-700">{line.documentAcceptedQuantity}</td><td className="px-3 py-3">{line.currentlyAppliedQuantity}</td><td className="px-3 py-3">{line.rejectedQuantity}</td><td className="px-3 py-3">{line.remainingReceivableQuantity}</td><td className="px-3 py-3">{line.warehouse?.name || line.warehouse?.code || 'Unavailable'}</td><td className="px-3 py-3">{line.location || 'Unavailable'}</td><td className="px-3 py-3">{line.unit || 'Unknown'}</td></tr>)}</tbody></table></div></section>

    <section className="rounded-2xl border bg-white p-4"><div className="mb-3 flex items-center gap-2 font-semibold"><Link2 size={16} />Smart links</div><div className="flex flex-wrap gap-2">{links.map((link) => <button key={link.label} disabled={!link.enabled} title={link.unavailableReason || undefined} onClick={() => onNavigate?.(link.targetRouteId, { entityType: link.targetType, entityId: link.targetId || receivingDocumentId }, { source: 'receiving-smart-link', entityLabel: link.label })} className={`rounded-lg border px-3 py-2 text-sm ${link.enabled ? 'text-blue-700' : 'text-gray-400'}`}>{link.label} · {link.count}</button>)}</div></section>

    <section className="rounded-2xl border bg-white p-4" data-testid="receiving-reconciliation"><div className="mb-3 font-semibold">Inventory reconciliation · {pretty(reconciliation?.status)}</div>{reconciliation?.entries.length ? <div className="space-y-2">{reconciliation.entries.map((entry) => <div key={`${entry.sku}-${entry.warehouseId || ''}-${entry.locationKey}`} className="grid gap-2 rounded-lg bg-gray-50 p-3 text-sm md:grid-cols-5"><span>{entry.sku}</span><span>{warehouseName(entry.warehouseId) || 'No warehouse'} / {entry.locationKey || 'No location'}</span><span>Calculated {entry.calculatedQuantity}</span><span>Recorded {entry.recordedQuantity ?? 'Unavailable'}</span><span className={entry.status === 'matched' ? 'text-green-700' : 'text-red-700'}>{pretty(entry.status)}{entry.differenceQuantity != null ? ` · Δ ${entry.differenceQuantity}` : ''}</span></div>)}</div> : <div className="text-sm text-gray-500">{reconciliation?.reason || 'Reconciliation is unavailable.'}</div>}</section>

    <section id="evidence" className="rounded-2xl border bg-white p-4"><div className="mb-3 flex items-center gap-2 font-semibold"><ShieldCheck size={16} />Evidence timeline</div><div className="space-y-3">{shownEvents.length ? shownEvents.map((event) => <div key={event.id} className="flex gap-3 border-l-2 border-blue-200 pl-3" data-testid="evidence-event"><div className="min-w-24 text-xs text-gray-500">{stamp(event.occurredAt)}</div><div><div className="text-sm font-medium">{event.label}</div><div className="text-[11px] text-gray-500">{eventKind(event)}{event.actorName ? ` · ${event.actorName}` : ''}</div></div></div>) : <div className="text-sm text-gray-500">No evidence connected.</div>}</div></section>
    {notes.length > 0 && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="receiving-notes">{notes.join(' ')}</div>}

    {preview && <div className="fc-overlay-enter fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="impact-preview"><div className="fc-dialog-enter max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
      <div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{preview.operation === 'post' ? 'Review receipt posting' : 'Review receipt reversal'}</h2><p className="text-sm text-gray-500">No business fact is written until you confirm.</p></div><button onClick={() => setPreview(null)}>✕</button></div>
      {preview.blockingIssues.map((issue) => <div key={issue.code} className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{issue.code}: {issue.message}</div>)}
      {preview.warnings.map((issue) => <div key={issue.code} className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{issue.message}</div>)}
      <h3 className="mt-5 font-semibold">Inventory impact</h3>{preview.inventoryImpacts.map((impact, index) => <div key={index} className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg bg-gray-50 p-3 text-sm"><span>{impact.sku}<br/><small>{warehouseName(impact.warehouseId)} / {impact.location || 'No location'}</small></span><ArrowRight size={16}/><span data-testid="balance-impact">On hand {impact.onHandBefore} → {impact.onHandAfter}<br/>Available {impact.availableBefore} → {impact.availableAfter}</span></div>)}
      <h3 className="mt-5 font-semibold">Purchase order impact</h3>{preview.purchaseOrderImpacts.map((impact, index) => <div key={index} className="mt-2 rounded-lg bg-gray-50 p-3 text-sm">{impact.poLineId}: {impact.receivedBefore} → {impact.receivedAfter} · Remaining {impact.remainingAfter}</div>)}
      <div className="mt-4 rounded-lg border p-3 text-sm">Fulfillment {pretty(preview.statusImpact.poFulfillmentBefore)} → {pretty(preview.statusImpact.poFulfillmentAfter)} · {preview.factsToCreate.inventoryMovementCount} movement(s), {preview.factsToCreate.auditEventCount} audit event</div>
      {preview.operation === 'reverse' && <label className="mt-4 block text-sm font-medium">Reversal reason *<textarea data-testid="reversal-reason" value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-lg border p-2" rows={3}/></label>}
      <div className="mt-5 flex justify-end gap-2"><button className="rounded-lg border px-4 py-2 text-sm" onClick={() => setPreview(null)}>Cancel</button><button data-testid="confirm-receiving-action" disabled={!preview.allowed || saving || (preview.operation === 'reverse' && !reason.trim())} onClick={() => void confirm()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving ? 'Saving…' : preview.operation === 'post' ? 'Confirm Post' : 'Confirm Reversal'}</button></div>
    </div></div>}
    {printing && <PrintLayoutEditor open documentType="receive_sheet" documentNo={grn.documentNumber || grn.id} data={adaptReceivingDetailSheet(detail, { quantity: (value) => formatDecimal(value, locale), rejectedLabel: (qty) => t("printLayout.rejectedQty", { qty }), day: (instant) => formatInstantDay(instant, locale, timezone) })} onClose={() => setPrinting(false)} />}
  </div>;
}
