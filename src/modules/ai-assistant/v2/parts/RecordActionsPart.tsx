import { useRef, useState } from "react";
import { CONFIRMED_RECORD_ACTIONS, REASON_RECORD_ACTIONS, recordActionsNow } from "../../../../../shared/assistant-record-actions.mjs";
import { A } from "../../../../components/ui";
import { isTranslationKey, translate, type TranslationKey } from "../../../../i18n/I18n";
import { ApiError, apiJson } from "../../../../lib/api-client";
import { RefChip, StatusPill, cardStyle, toneStyle, usePartCopy, type Navigate, type PartCopy } from "./partKit";
import type { ActionRecord, AnswerLanguage, PartRef, RecordActionCode, RecordActionReceipt, RecordActionsProps, RecordActionStep } from "./types";

// The record card (offer_record_actions, owner decision of 2026-11-04): the
// steps on a purchase request or purchase order this user may take now,
// each taken only by their own click, and for anything past submitting a
// draft a second, inline Confirm click that says what will happen. The
// user's own session calls the same procurement routes the pages use, which
// check the permission, the status and the version again. Each step carries
// an idempotency key for this card, the step and the record's version, so a
// double click or a retry is the same command; after a conflict the card
// reads the record again and offers what its new status allows.

type Post = (url: string, body: unknown) => Promise<unknown>;
type Get = (url: string) => Promise<unknown>;
type RecordState = { status: string; version: number };
export type RecordActionOutcome =
  | { status: "done"; record: RecordState; step: RecordActionStep }
  | { status: "changed"; record: RecordState; code: string }
  | { status: "failed"; code: string };

// A record changed, or a step that already happened: read it again.
const CONFLICT_CODES = new Set([
  "VERSION_CONFLICT", "SYNC_VERSION_CONFLICT", "INVALID_STATE_TRANSITION", "PURCHASE_ORDER_WORKFLOW_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "DOWNSTREAM_OBJECT_ALREADY_EXISTS", "TRANSACTION_CONFLICT",
]);
const SOURCING: RecordActionCode[] = ["create_po", "create_rfq"];

const recordUrl = (record: Pick<ActionRecord, "type" | "ref">) =>
  `/api/procurement/${record.type === "purchase_order" ? "orders" : "requests"}/${encodeURIComponent(record.ref.id)}`;

// The step's id: the card, the step and the version it was taken at. The
// route's idempotency key is ai-action:<actionId>, which the server checks
// before it notes the step in the thread.
export const recordActionId = (cardId: string, action: RecordActionCode, version: number) => `${cardId}:${action}:v${version}`;

// The route and body of a step, as the procurement pages post them.
export function recordActionRequest(record: Pick<ActionRecord, "type" | "ref">, action: RecordActionCode, { version, actionId, reason = "" }: { version: number; actionId: string; reason?: string }) {
  const path = action === "create_po" ? "direct-purchase-order" : action === "create_rfq" ? "rfqs" : action;
  return {
    url: `${recordUrl(record)}/${path}`,
    body: { expectedVersion: version, idempotencyKey: `ai-action:${actionId}`, ...(REASON_RECORD_ACTIONS.includes(action) ? { reason: reason.trim() } : {}) },
  };
}

type Result = {
  id?: string; status?: string; version?: number; entityVersion?: number; idempotentReplay?: boolean;
  purchaseRequest?: { status?: string; version?: number };
  purchaseOrder?: { status?: string; version?: number };
  createdPurchaseOrders?: { id: string; orderNumber?: string }[];
  rfq?: { id: string };
};

// The record's status and version, and the records the step created, from a route's answer.
function resultOf(record: Pick<ActionRecord, "type">, action: RecordActionCode, value: unknown): RecordState & { created: PartRef[] } {
  const result = (value && typeof value === "object" ? value : {}) as Result;
  if (record.type === "purchase_order") {
    return { status: String(result.status || result.purchaseOrder?.status || ""), version: Number(result.entityVersion ?? result.purchaseOrder?.version ?? 0), created: [] };
  }
  const request = SOURCING.includes(action) ? result.purchaseRequest || {} : result;
  const created: PartRef[] = action === "create_po"
    ? (result.createdPurchaseOrders || []).filter((order) => order?.id).map((order) => ({ type: "purchase_order", id: order.id, label: order.orderNumber || order.id }))
    : action === "create_rfq" && result.rfq?.id ? [{ type: "rfq", id: result.rfq.id, label: result.rfq.id }] : [];
  return { status: String(request.status || ""), version: Number(request.version ?? 0), created };
}

const codeOf = (failure: unknown) => (failure instanceof ApiError ? failure.code || "" : failure && typeof failure === "object" && "code" in failure ? String((failure as { code?: unknown }).code || "") : "");

// One click on a step (after its Confirm): the route with the user's
// session. A replay returns the first answer, so the record is read again for
// where it stands now; so is a record that changed since the card was shown.
export async function runRecordAction({ record, cardId, state, action, reason = "", post, get }: {
  record: Pick<ActionRecord, "type" | "ref">;
  cardId: string;
  state: RecordState;
  action: RecordActionCode;
  reason?: string;
  post: Post;
  get: Get;
}): Promise<RecordActionOutcome> {
  const actionId = recordActionId(cardId, action, state.version);
  const { url, body } = recordActionRequest(record, action, { version: state.version, actionId, reason });
  const reread = async (): Promise<RecordState> => {
    const current = (await get(recordUrl(record))) as { status?: string; version?: number };
    return { status: String(current?.status || state.status), version: Number(current?.version ?? state.version) };
  };
  try {
    const result = await post(url, body);
    const next = resultOf(record, action, result);
    const now = (result as Result)?.idempotentReplay ? await reread().catch(() => next) : next;
    return { status: "done", record: { status: now.status || state.status, version: now.version }, step: { actionId, action, created: next.created } };
  } catch (failure) {
    const code = codeOf(failure);
    if (!CONFLICT_CODES.has(code)) return { status: "failed", code };
    try {
      return { status: "changed", record: await reread(), code };
    } catch {
      return { status: "failed", code };
    }
  }
}

// The steps the card offers now: the shared rules over the record's status,
// less ordering or requesting quotes once one of them came from this request.
export function cardActions(props: RecordActionsProps, state: RecordState, sourced: boolean): RecordActionCode[] {
  const now = recordActionsNow({ type: props.record.type, status: state.status, allowed: props.allowed, path: props.path, poBlocked: props.poBlocked }) as RecordActionCode[];
  return sourced ? now.filter((action) => !SOURCING.includes(action)) : now;
}

// "300 pcs of LDM-002", or "3 lines".
function linesText(record: ActionRecord, copy: PartCopy) {
  const [line] = record.lines;
  if (record.lineCount === 1 && line) {
    const what = line.sku || line.name;
    if (line.quantity !== null) return copy.t("ai.v2.actions.lineOne", { quantity: copy.number(line.quantity), unit: line.unit || "", sku: what }).replace(/\s+/g, " ").trim();
    return what;
  }
  return copy.t("ai.v2.actions.lineMany", { count: copy.number(record.lineCount) });
}

function supplierText(record: ActionRecord, copy: PartCopy) {
  if (record.suppliers.length === 1) return copy.t("ai.v2.actions.fromOne", { name: record.suppliers[0] });
  if (record.suppliers.length > 1) return copy.t("ai.v2.actions.fromMany", { count: copy.number(record.suppliers.length) });
  return "";
}

// What the Confirm click will do, in words: "Approve PR-0231 for 300 pcs of
// LDM-002 from Northstar Electronics?"
export function confirmText(copy: PartCopy, record: ActionRecord, action: RecordActionCode) {
  const key = `ai.v2.actions.confirm.${record.type}.${action}`;
  if (!isTranslationKey(key)) return "";
  return copy.t(key, { record: record.ref.label, lines: linesText(record, copy), from: supplierText(record, copy) });
}

// A route's error in plain words, from its code (server messages are not
// shown): the card's own wording, the request form's, or a general line.
export function recordActionErrorText(code: string, language: AnswerLanguage) {
  const key = [`ai.v2.actions.error.${code}`, `ai.v2.error.${code}`].find((entry) => code && isTranslationKey(entry));
  return translate(language, (key || "ai.v2.actions.error.generic") as TranslationKey);
}

export function RecordActionsPart({ props, language, onNavigate, receipt = null, onReceipt, post = (url, body) => apiJson(url, { method: "POST", body: JSON.stringify(body) }), get = (url) => apiJson(url), initialConfirm = null }: {
  props: RecordActionsProps;
  language?: string;
  onNavigate?: Navigate;
  // What this card already did, when an earlier answer is shown again.
  receipt?: RecordActionReceipt | null;
  onReceipt?: (receipt: RecordActionReceipt) => void;
  post?: Post;
  get?: Get;
  // A step whose Confirm shows from the start (tests render it so).
  initialConfirm?: RecordActionCode | null;
}) {
  const copy = usePartCopy(language);
  const { record } = props;
  const [state, setState] = useState<RecordState>({ status: receipt?.status || record.status, version: receipt?.version ?? record.version });
  const [steps, setSteps] = useState<RecordActionStep[]>(receipt?.steps || []);
  const [sourced, setSourced] = useState(Boolean(receipt?.sourced) || (receipt?.steps || []).some((step) => SOURCING.includes(step.action)));
  const [confirming, setConfirming] = useState<RecordActionCode | null>(initialConfirm && CONFIRMED_RECORD_ACTIONS.includes(initialConfirm) ? initialConfirm : null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Set at once on a click, so a second click before the card redraws takes nothing.
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const actions = cardActions(props, state, sourced);

  const take = async (action: RecordActionCode) => {
    if (busyRef.current || !actions.includes(action)) return;
    if (REASON_RECORD_ACTIONS.includes(action) && !reason.trim()) {
      setError(copy.t("ai.v2.actions.reasonRequired"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    setChanged(false);
    try {
      const outcome = await runRecordAction({ record, cardId: props.cardId, state, action, reason, post, get });
      if (outcome.status === "failed") {
        setError(recordActionErrorText(outcome.code, copy.language));
        return;
      }
      setConfirming(null);
      setReason("");
      const nextSteps = outcome.status === "done" ? [...steps.filter((step) => step.actionId !== outcome.step.actionId), outcome.step] : steps;
      const nextSourced = sourced || (outcome.status === "done" && SOURCING.includes(action)) || (outcome.status === "changed" && outcome.code === "DOWNSTREAM_OBJECT_ALREADY_EXISTS");
      if (outcome.status === "changed") setChanged(true);
      setState(outcome.record);
      setSteps(nextSteps);
      setSourced(nextSourced);
      onReceipt?.({ type: record.type, id: record.ref.id, status: outcome.record.status, version: outcome.record.version, steps: nextSteps, ...(nextSourced ? { sourced: true } : {}) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const click = (action: RecordActionCode) => {
    setError("");
    if (CONFIRMED_RECORD_ACTIONS.includes(action)) setConfirming(action);
    else void take(action);
  };

  const recommended = props.path && actions.some((action) => SOURCING.includes(action)) ? props.path : null;
  const details = [
    linesText(record, copy),
    record.suppliers.length ? record.suppliers.join(", ") : "",
    record.amount && record.amount.amount !== null ? copy.money(record.amount.amount, record.amount.currency) : "",
  ].filter(Boolean);
  const button = (action: RecordActionCode, primary: boolean) => (
    <button
      key={action}
      type="button"
      data-testid="ai-v2-record-action"
      data-action={action}
      data-primary={primary ? "true" : "false"}
      disabled={busy}
      onClick={() => click(action)}
      className={primary
        ? "inline-flex min-h-9 items-center rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        : "inline-flex min-h-9 items-center rounded-lg px-3 py-2 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"}
      style={primary ? { background: A.blue } : { background: A.white, color: action === "reject" ? toneStyle("danger").color : A.blue, border: `1px solid ${A.gray4}` }}
    >
      {copy.t(`ai.v2.actions.button.${record.type}.${action}` as TranslationKey)}
    </button>
  );

  return (
    <section data-testid="ai-v2-record-actions" data-card-id={props.cardId} data-status={state.status} lang={copy.language} className="space-y-2 rounded-xl p-3 text-[13px]" style={cardStyle}>
      <p className="flex flex-wrap items-center gap-1.5" style={{ color: A.label }}>
        <span className="text-[12px]" style={{ color: A.sub }}>{copy.t(`ai.v2.actions.type.${record.type}` as TranslationKey)}</span>
        <RefChip value={record.ref} onNavigate={onNavigate} />
        <StatusPill status={{ code: state.status }} copy={copy} />
      </p>
      {details.length ? <p data-testid="ai-v2-record-details" style={{ color: A.sub }}>{details.join(" · ")}</p> : null}
      {recommended ? (
        <p data-testid="ai-v2-record-path" data-recommendation={recommended.recommendation} style={{ color: A.label }}>
          {copy.t(`ai.v2.actions.path.${recommended.recommendation}` as TranslationKey)}
          {recommended.reasons.length ? <span style={{ color: A.sub }}> · {recommended.reasons.map((code) => copy.known("ai.v2.actions.pathReason", code)).join("; ")}</span> : null}
        </p>
      ) : null}
      {props.poBlocked && record.type === "purchase_request" && state.status === "approved" && !sourced ? <p data-testid="ai-v2-record-po-blocked" style={{ color: toneStyle("warning").color }}>{copy.t("ai.v2.actions.poBlocked.lines_incomplete")}</p> : null}
      {steps.map((step) => (
        <p key={step.actionId} data-testid="ai-v2-record-done" data-action={step.action} className="flex flex-wrap items-center gap-1.5" style={{ color: toneStyle("success").color }}>
          {copy.t(`ai.v2.actions.done.${record.type}.${step.action}` as TranslationKey)}
          {step.created.map((ref) => <RefChip key={`${ref.type}:${ref.id}`} value={ref} onNavigate={onNavigate} />)}
        </p>
      ))}
      {changed ? <p role="status" data-testid="ai-v2-record-changed" style={{ color: toneStyle("warning").color }}>{copy.t("ai.v2.actions.changed")}</p> : null}
      {error ? <p role="alert" data-testid="ai-v2-record-error" style={{ color: toneStyle("danger").color }}>{error}</p> : null}
      {confirming && actions.includes(confirming) ? (
        <div data-testid="ai-v2-record-confirm" data-action={confirming} className="space-y-2 rounded-lg p-2" style={{ border: `1px solid ${A.gray5}` }}>
          <p style={{ color: A.label }}>{confirmText(copy, record, confirming)}</p>
          {REASON_RECORD_ACTIONS.includes(confirming) ? (
            <label className="block space-y-0.5">
              <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.actions.reasonLabel")}</span>
              <textarea data-testid="ai-v2-record-reason" value={reason} maxLength={500} rows={2} onChange={(event) => setReason(event.target.value)} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={{ border: `1px solid ${A.gray4}`, background: A.white, color: A.label }} />
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="button" data-testid="ai-v2-record-confirm-button" data-primary="true" disabled={busy || (REASON_RECORD_ACTIONS.includes(confirming) && !reason.trim())} onClick={() => void take(confirming)} className="inline-flex min-h-9 items-center rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" style={{ background: confirming === "reject" ? toneStyle("danger").color : A.blue }}>
              {busy ? copy.t("ai.v2.actions.working") : copy.t(`ai.v2.actions.confirmButton.${confirming}` as TranslationKey)}
            </button>
            <button type="button" data-testid="ai-v2-record-back" disabled={busy} onClick={() => { setConfirming(null); setReason(""); setError(""); }} className="text-[13px] font-medium hover:underline disabled:opacity-50" style={{ color: A.blue }}>{copy.t("ai.v2.actions.back")}</button>
          </div>
        </div>
      ) : actions.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action, index) => button(action, index === 0 && action !== "reject"))}
        </div>
      ) : null}
    </section>
  );
}
