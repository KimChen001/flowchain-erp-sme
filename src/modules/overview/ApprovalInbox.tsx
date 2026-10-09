import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";
import { formatCalendarDay, formatCurrencyAmount, formatDateTimeInTimeZone } from "../../lib/format";
import { usePermissionSet } from "../../lib/usePermissionSet";
import { TwoStepAction } from "../finance/FinanceControls";

// The approval inbox (mobile step 2, after Coupa Mobile): what waits for the
// signed-in person's decision, with Approve, Reject and Details on each card,
// and the decisions they made in the last 30 days.
//
// FlowChain has no named approver: a purchase request or order waits for
// anyone holding the approve permission, and a bill for anyone holding the
// bill approve permission once it is matched (server/notifications/
// approval-notifier.mjs). The lists come from the same endpoints as the
// desktop pages, so the server's read and field permissions apply; the
// commands are the desktop ones, each with its own idempotency key.

const COPY: Record<string, [string, string]> = {
  title: ["Approvals", "审批"],
  intro: ["Purchase requests, purchase orders and bills waiting for a decision you can make.", "等待您决定的采购申请、采购订单和账单。"],
  waiting: ["Waiting on me", "待我审批"],
  done: ["Done by me", "我已处理"],
  refresh: ["Refresh", "刷新"],
  loading: ["Loading approvals…", "正在加载审批…"],
  loadFailed: ["Approvals could not be loaded.", "审批加载失败。"],
  retry: ["Try again", "重试"],
  nothingWaiting: ["Nothing is waiting for your approval.", "当前没有等待您审批的单据。"],
  nothingDone: ["You have not approved or rejected anything in the last 30 days.", "最近 30 天您没有审批或驳回过单据。"],
  purchase_request: ["Purchase request", "采购申请"],
  purchase_order: ["Purchase order", "采购订单"],
  supplier_invoice: ["Supplier bill", "供应商账单"],
  awaiting: ["Awaiting me", "待我审批"],
  needBy: ["needed by {date}", "需求日期 {date}"],
  eta: ["expected {date}", "预计到货 {date}"],
  due: ["due {date}", "到期 {date}"],
  variance: ["{amount} above the order", "比订单高 {amount}"],
  amountHidden: ["Amount hidden for your role", "您的角色无法查看金额"],
  approve: ["Approve", "批准"],
  reject: ["Reject", "驳回"],
  details: ["Details", "详情"],
  rejectTitle: ["Reject {number}", "驳回 {number}"],
  reason: ["Reason", "原因"],
  reasonHint: ["The requester sees this reason.", "申请人会看到这个原因。"],
  reasonRequired: ["Enter a reason.", "请填写原因。"],
  cancel: ["Cancel", "取消"],
  working: ["Working…", "处理中…"],
  approved: ["Approved", "已批准"],
  rejected: ["Rejected", "已驳回"],
  returned: ["Returned for revision", "已退回修改"],
  doneToast: ["{number}: {decision}", "{number}：{decision}"],
  changed: ["This record changed since the list loaded. The list is reloaded.", "该单据已被他人修改，列表已刷新。"],
  failed: ["The decision could not be saved.", "审批未能保存。"],
  billApproveFailed: ["The bill could not be approved.", "账单批准失败。"],
};

type Waiting = {
  key: string;
  type: "purchase_request" | "purchase_order" | "supplier_invoice";
  id: string;
  number: string;
  version: number;
  title: string;
  meta: string[];
  amount: number | null;
  currency: string;
  link: string;
  canReject: boolean;
};
type HistoryItem = { id: string; documentType: Waiting["type"]; documentId: string; documentNumber: string; decision: "approved" | "rejected" | "returned"; decidedAt: string; reason: string | null };

type RequestRow = { id: string; status: string; version: number; requiredDate?: string; defaultNeedByDate?: string; totalAmount?: number | null; currency?: string; defaultCurrency?: string; sourceName?: string; quantity?: number; unit?: string; supplier?: string };
type OrderRow = { id: string; orderNumber?: string; status: string; version: number; supplier?: string; eta?: string; totalAmount?: number | null; currency?: string };
type InvoiceRow = { id: string; invoiceNumber: string; supplierName?: string | null; dueDate?: string | null; totalAmount?: string | null; varianceAmount?: string | null; currency: string; status: string; version: number; availableActions?: string[] };

const STALE_CODES = new Set(["VERSION_CONFLICT", "SYNC_VERSION_CONFLICT", "PURCHASE_ORDER_WORKFLOW_CONFLICT", "INVALID_STATE_TRANSITION"]);
const PATHS: Record<Waiting["type"], (id: string) => string> = {
  purchase_request: (id) => `/app/procurement/requests/${encodeURIComponent(id)}`,
  purchase_order: (id) => `/app/procurement/orders/${encodeURIComponent(id)}`,
  supplier_invoice: (id) => `/app/procurement/bills/${encodeURIComponent(id)}`,
};
// Tells the app shell to read the Approvals tab count again.
export const APPROVALS_CHANGED_EVENT = "flowchain:approvals-changed";
const announceChange = () => window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
const amountOf = (value: unknown) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const fill = (text: string, values: Record<string, string>) => Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), text);

// Bills are listed only where the bill capability is on and the reader may
// read them; otherwise the inbox simply has none.
async function loadBills(): Promise<InvoiceRow[]> {
  const page = async (status: string) => apiJson<{ items?: InvoiceRow[] }>(`/api/finance/supplier-invoices?status=${status}&pageSize=100`).then((payload) => payload.items || []).catch(() => []);
  const [matched, exceptions] = await Promise.all([page("matched"), page("exception")]);
  return [...matched, ...exceptions].filter((row) => row.availableActions?.includes("approve"));
}

export function ApprovalInbox() {
  const { language, locale, timezone } = useI18n();
  const tr = useCallback((key: string, values: Record<string, string> = {}) => fill(COPY[key][language === "en-US" ? 0 : 1], values), [language]);
  const permissions = usePermissionSet();
  const [view, setView] = useState<"waiting" | "done">("waiting");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [bills, setBills] = useState<InvoiceRow[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState("");
  const [rejecting, setRejecting] = useState<Waiting | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);

  const load = useCallback(async () => {
    setState((current) => (current === "ready" ? current : "loading"));
    try {
      const [requestRows, orderRows, billRows, historyRows] = await Promise.all([
        apiJson<RequestRow[]>("/api/procurement/requests"),
        apiJson<OrderRow[]>("/api/procurement/orders"),
        loadBills(),
        apiJson<{ items: HistoryItem[] }>("/api/me/approval-history").then((payload) => payload.items || []).catch(() => []),
      ]);
      setRequests(requestRows.filter((row) => row.status === "submitted"));
      setOrders(orderRows.filter((row) => row.status === "pending_approval"));
      setBills(billRows);
      setHistory(historyRows);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Need-by, arrival and due dates are calendar days.
  const date = (value?: string | null) => (value ? formatCalendarDay(String(value).slice(0, 10), locale) : "");
  const canApprove = Boolean(permissions?.has("procurement.purchase_order.approve"));
  const canReject = Boolean(permissions?.has("procurement.purchase_order.reject"));

  const waiting = useMemo<Waiting[]>(() => {
    if (!permissions) return [];
    const procurement: Waiting[] = canApprove ? [
      ...requests.map((row) => ({
        key: `purchase_request:${row.id}`, type: "purchase_request" as const, id: row.id, number: row.id, version: row.version,
        title: [row.sourceName, row.quantity ? `× ${row.quantity}${row.unit ? ` ${row.unit}` : ""}` : ""].filter(Boolean).join(" ") || tr("purchase_request"),
        // The list carries the requester's user id, not a name, so the card leaves it out.
        meta: [row.supplier || "", (row.requiredDate || row.defaultNeedByDate) ? tr("needBy", { date: date(row.requiredDate || row.defaultNeedByDate) }) : ""].filter(Boolean),
        amount: amountOf(row.totalAmount), currency: row.currency || row.defaultCurrency || "", link: PATHS.purchase_request(row.id), canReject,
      })),
      ...orders.map((row) => ({
        key: `purchase_order:${row.id}`, type: "purchase_order" as const, id: row.id, number: row.orderNumber || row.id, version: row.version,
        title: row.supplier || tr("purchase_order"),
        meta: [row.eta ? tr("eta", { date: date(row.eta) }) : ""].filter(Boolean),
        amount: amountOf(row.totalAmount), currency: row.currency || "", link: PATHS.purchase_order(row.id), canReject,
      })),
    ] : [];
    const invoices: Waiting[] = bills.map((row) => {
      const variance = amountOf(row.varianceAmount);
      return {
        key: `supplier_invoice:${row.id}`, type: "supplier_invoice" as const, id: row.id, number: row.invoiceNumber, version: row.version,
        title: row.supplierName || tr("supplier_invoice"),
        meta: [row.dueDate ? tr("due", { date: date(row.dueDate) }) : "", variance && variance > 0 ? tr("variance", { amount: formatCurrencyAmount(variance, row.currency) }) : ""].filter(Boolean),
        amount: amountOf(row.totalAmount), currency: row.currency, link: PATHS.supplier_invoice(row.id), canReject: false,
      };
    });
    return [...procurement, ...invoices];
  }, [bills, canApprove, canReject, orders, permissions, requests, tr]);

  const decide = async (item: Waiting, action: "approve" | "reject", why = "") => {
    setBusy(`${item.key}:${action}`);
    const base = item.type === "purchase_request" ? "/api/procurement/requests" : "/api/procurement/orders";
    try {
      await apiJson(`${base}/${encodeURIComponent(item.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: item.version, reason: why, idempotencyKey: createSecureClientMutationId(`inbox-${action}`) }),
      });
      toast.success(tr("doneToast", { number: item.number, decision: tr(action === "approve" ? "approved" : "rejected") }));
      announceChange();
      setRejecting(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && STALE_CODES.has(error.code || "")) {
        toast.error(tr("changed"));
        setRejecting(null);
        await load();
      } else {
        toast.error(tr("failed"), { description: error instanceof Error ? error.message : undefined });
      }
    } finally {
      setBusy("");
    }
  };

  const submitReject = () => {
    if (!rejecting) return;
    if (!reason.trim()) { setReasonError(true); return; }
    void decide(rejecting, "reject", reason.trim());
  };

  const tabButton = (id: "waiting" | "done", label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === id}
      data-testid={`approval-view-${id}`}
      onClick={() => setView(id)}
      className="flex-1 rounded-lg py-2 text-sm font-medium"
      style={view === id ? { background: A.white, color: A.label, boxShadow: "0 1px 2px rgba(15,23,42,.12)" } : { color: A.gray1 }}
    >
      {label} <span className="tabular-nums" style={{ color: A.sub }}>{count}</span>
    </button>
  );

  return (
    <div className="space-y-4" data-testid="approval-inbox">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* The page title above already says Approvals. */}
          <p className="text-xs" style={{ color: A.sub }}>{tr("intro")}</p>
          <button type="button" onClick={() => void load()} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>
            <RefreshCw size={13} />{tr("refresh")}
          </button>
        </div>
        <div role="tablist" aria-label={tr("title")} className="mt-4 flex gap-1 rounded-xl p-1" style={{ background: A.gray6 }}>
          {tabButton("waiting", tr("waiting"), waiting.length)}
          {tabButton("done", tr("done"), history.length)}
        </div>
      </Card>

      {state === "loading" || !permissions ? (
        <Card className="py-12 text-center text-sm" style={{ color: A.sub }}>{tr("loading")}</Card>
      ) : state === "error" ? (
        <Card className="py-12 text-center text-sm">
          <div style={{ color: A.red }}>{tr("loadFailed")}</div>
          <button type="button" onClick={() => void load()} className="mt-3 text-xs font-semibold text-blue-600">{tr("retry")}</button>
        </Card>
      ) : view === "waiting" ? (
        waiting.length === 0 ? (
          <Card className="py-12 text-center text-sm" style={{ color: A.sub }} data-testid="approval-empty">{tr("nothingWaiting")}</Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {waiting.map((item) => (
              <Card key={item.key} className="flex flex-col gap-2 p-4" data-testid="approval-card" data-approval-key={item.key}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[13px] font-medium" style={{ color: A.label }}>{item.number}</span>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: "#fef3c7", color: "#92400e" }}>{tr("awaiting")}</span>
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: A.sub }}>{tr(item.type)}</div>
                <div className="flex items-baseline justify-between gap-3">
                  <b className="min-w-0 text-sm" style={{ color: A.label }}>{item.title}</b>
                  {item.amount !== null
                    ? <span className="shrink-0 text-lg font-bold tabular-nums" style={{ color: A.label }}>{formatCurrencyAmount(item.amount, item.currency)}</span>
                    : <span className="shrink-0 text-[11px]" style={{ color: A.gray2 }}>{tr("amountHidden")}</span>}
                </div>
                {item.meta.length > 0 && <div className="text-xs" style={{ color: A.sub }}>{item.meta.join(" · ")}</div>}
                <div className="mt-1 flex gap-2">
                  {item.canReject && (
                    <button type="button" data-testid="approval-reject" disabled={Boolean(busy)} onClick={() => { setRejecting(item); setReason(""); setReasonError(false); }}
                      className="h-9 flex-1 rounded-lg border text-sm font-semibold disabled:opacity-50" style={{ borderColor: "#fecaca", color: A.red, background: A.white }}>
                      {tr("reject")}
                    </button>
                  )}
                  <Link to={item.link} data-testid="approval-details" className="flex h-9 flex-1 items-center justify-center rounded-lg border text-sm font-semibold" style={{ borderColor: A.border, color: A.label }}>
                    {tr("details")}
                  </Link>
                  {item.type === "supplier_invoice" ? (
                    <div className="flex flex-1 [&>button]:h-9 [&>button]:w-full [&>button]:justify-center">
                      <TwoStepAction
                        label={tr("approve")}
                        testId="approval-approve-bill"
                        previewUrl={`/api/finance/supplier-invoices/${encodeURIComponent(item.id)}/approve-preview`}
                        runUrl={`/api/finance/supplier-invoices/${encodeURIComponent(item.id)}/approve`}
                        payload={() => ({ expectedVersion: item.version })}
                        oneStep
                        onDone={() => { toast.success(tr("doneToast", { number: item.number, decision: tr("approved") })); announceChange(); void load(); }}
                      />
                    </div>
                  ) : (
                    <button type="button" data-testid="approval-approve" disabled={Boolean(busy)} onClick={() => void decide(item, "approve")}
                      className="h-9 flex-1 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ background: A.blue }}>
                      {busy === `${item.key}:approve` ? tr("working") : tr("approve")}
                    </button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )
      ) : history.length === 0 ? (
        <Card className="py-12 text-center text-sm" style={{ color: A.sub }}>{tr("nothingDone")}</Card>
      ) : (
        <Card className="divide-y" data-testid="approval-history">
          {history.map((item) => {
            const tone = item.decision === "approved" ? { bg: "#ccfbf1", fg: "#0f766e" } : item.decision === "rejected" ? { bg: "#fee2e2", fg: "#b91c1c" } : { bg: "#fef3c7", fg: "#92400e" };
            return (
              <div key={item.id} className="flex flex-col gap-1 px-4 py-3" data-testid="approval-history-row" style={{ borderColor: A.border }}>
                <div className="flex items-center justify-between gap-2">
                  <Link to={PATHS[item.documentType](item.documentId)} className="min-w-0 truncate font-mono text-[13px] font-medium text-blue-600">{item.documentNumber}</Link>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: tone.bg, color: tone.fg }}>{tr(item.decision)}</span>
                </div>
                <div className="text-xs" style={{ color: A.sub }}>{tr(item.documentType)} · {formatDateTimeInTimeZone(item.decidedAt, locale, timezone)}</div>
                {item.reason && <div className="text-xs" style={{ color: A.label }}>{item.reason}</div>}
              </div>
            );
          })}
        </Card>
      )}

      {rejecting && createPortal(
        <div className="fixed inset-0 z-[60]" data-testid="approval-reject-sheet">
          <button type="button" aria-label={tr("cancel")} className="absolute inset-0 bg-slate-900/45" onClick={() => setRejecting(null)} />
          <div role="dialog" aria-modal="true" aria-label={tr("rejectTitle", { number: rejecting.number })}
            className="absolute inset-x-0 bottom-0 grid gap-3 rounded-t-2xl bg-white px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-3 md:inset-x-auto md:left-1/2 md:top-1/2 md:bottom-auto md:w-[440px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:p-5">
            <div className="flex items-center justify-between">
              <b className="text-base" style={{ color: A.label }}>{tr("rejectTitle", { number: rejecting.number })}</b>
              <button type="button" onClick={() => setRejecting(null)} aria-label={tr("cancel")} className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ color: A.gray1 }}><X size={18} /></button>
            </div>
            <label className="grid gap-1 text-xs" style={{ color: A.sub }}>
              {tr("reason")}
              <textarea data-testid="approval-reject-reason" autoFocus rows={3} value={reason} onChange={(event) => { setReason(event.target.value); setReasonError(false); }}
                className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: reasonError ? A.red : A.border, color: A.label }} />
              <span>{reasonError ? <span style={{ color: A.red }}>{tr("reasonRequired")}</span> : tr("reasonHint")}</span>
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setRejecting(null)} className="h-11 flex-1 rounded-xl border text-sm font-semibold" style={{ borderColor: A.border, color: A.label }}>{tr("cancel")}</button>
              <button type="button" data-testid="approval-reject-confirm" disabled={Boolean(busy)} onClick={submitReject} className="h-11 flex-[2] rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ background: A.red }}>
                {busy ? tr("working") : tr("reject")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
