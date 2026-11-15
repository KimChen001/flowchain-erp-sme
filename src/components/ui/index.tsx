import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useI18n } from "../../i18n/I18n";
import React, { useEffect, useId, useRef, useState } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { readableOn } from "./contrast";
export { contrastRatio, readableOn } from "./contrast";
import { ArrowDownRight, ArrowLeft, ArrowUpRight, ChevronDown, History, Home, List, X } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import type { AuditEntry } from "../../types/scm";
import { A } from "./tokens";
import { typography } from "./typography";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { statusCodeLabel } from "../../i18n/statusLabels";

export { A } from "./tokens";
export { ConfirmDialog, useConfirm, type ConfirmField, type ConfirmOptions, type ConfirmTone } from "./ConfirmDialog";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

export function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
  const copy = useWorkspaceCopy();
  return (
    <span className="fc-status-chip inline-flex w-fit items-center whitespace-nowrap break-keep"
      style={{ color: readableOn(color, bg), background: bg }}>
      {copy(label)}
    </span>
  );
}

export type RecoveryAction = {
  key: string;
  label: string;
  onClick: () => void;
  kind?: "previous" | "list" | "module" | "clear";
  tone?: "neutral" | "primary" | "subtle" | "warning" | "danger";
};

function recoveryActionStyle(tone: RecoveryAction["tone"] = "neutral") {
  if (tone === "primary") return { background: "#f0f6ff", color: A.blue, boxShadow: "0 0 0 0.5px rgba(37,99,235,0.18)" };
  if (tone === "subtle") return { background: A.gray6, color: A.gray1 };
  if (tone === "warning") return { background: "#fff8f0", color: A.orange };
  if (tone === "danger") return { background: "#fff1f0", color: A.red };
  return { background: A.white, color: A.label, boxShadow: "0 0 0 0.5px rgba(15,23,42,0.08)" };
}

function RecoveryIcon({ kind }: { kind: RecoveryAction["kind"] }) {
  if (kind === "list") return <List size={13} />;
  if (kind === "module") return <Home size={13} />;
  if (kind === "clear") return <X size={13} />;
  return <ArrowLeft size={13} />;
}

export function RecoveryActions({
  actions,
  className = "",
}: {
  actions: RecoveryAction[];
  className?: string;
}) {
  if (!actions.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={action.onClick}
          className={`h-8 inline-flex items-center gap-1.5 rounded-lg px-3 ${typography.denseButton}`}
          style={recoveryActionStyle(action.tone)}
        >
          <RecoveryIcon kind={action.kind} />
          {copy(action.label)}
        </button>
      ))}
    </div>
  );
}

// What a document history row did, in the reader's language (design audit
// U-02 with L16: the panel had been empty, and its labels were Chinese only).
// The PO commands record purchase_order_<step>; the older JSON store recorded
// the past-tense codes, kept here.
const AUDIT_ACTION_LABELS: Record<string, [string, string]> = {
  purchase_order_submit: ["Submitted for approval", "已提交审批"],
  purchase_order_approve: ["Approved", "已批准"],
  purchase_order_reject: ["Rejected", "已驳回"],
  purchase_order_return_for_revision: ["Returned for revision", "已退回修改"],
  purchase_order_issue: ["Issued to the supplier", "已下达给供应商"],
  purchase_order_cancel: ["Cancelled", "已取消"],
  purchase_order_close: ["Closed", "已关闭"],
  purchase_order_promised_dates_revised: ["Promised dates revised", "已修改承诺交期"],
  purchaseRequest_created: ["Purchase request created", "创建采购申请"],
  purchase_request_approved: ["Request approved", "批准申请"],
  purchase_request_rejected: ["Request rejected", "驳回申请"],
  purchase_request_status_changed: ["Request status updated", "更新申请状态"],
  purchase_request_converted_to_po: ["Turned into a purchase order", "转采购订单"],
  purchaseOrder_created: ["Purchase order created", "创建采购订单"],
  purchase_order_created_from_pr: ["Created from a purchase request", "由 PR 生成 PO"],
  purchase_order_created_from_rfq: ["Created from an RFQ", "由询价单生成 PO"],
  purchase_order_approved: ["Approved", "批准订单"],
  purchase_order_rejected: ["Rejected", "驳回订单"],
  purchase_order_issued: ["Issued to the supplier", "下达给供应商"],
  purchase_order_cancelled: ["Cancelled", "取消订单"],
  purchase_order_receiving_started: ["Receiving started", "开始收货"],
  purchase_order_receiving_status: ["Receiving updated the order", "收货更新订单状态"],
  purchase_order_status_changed: ["Order status updated", "更新订单状态"],
  rfq_created: ["RFQ created", "创建询价单"],
  rfq_awarded: ["Awarded", "授标"],
  rfq_converted_to_po: ["Turned into a purchase order", "转采购订单"],
  rfq_status_changed: ["RFQ status updated", "更新询价单状态"],
  receivingDoc_created: ["Receipt created", "创建收货单"],
  receiving_posted: ["Receipt posted", "收货过账"],
  receiving_status_changed: ["Receipt status updated", "更新收货状态"],
  inventory_posted: ["Inventory updated", "库存已更新"],
  system_validation_blocked: ["Blocked an invalid step", "系统阻止了无效操作"],
};
const pairText = (pair: [string, string], language: string) => pair[language === "en-US" ? 0 : 1];

export function auditActionLabel(action: string, language: string) {
  const pair = AUDIT_ACTION_LABELS[action];
  if (pair) return pairText(pair, language);
  const words = action.replace(/^(purchase_order|purchase_request|purchaseOrder|purchaseRequest|receivingDoc|receiving|rfq)_/, "").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The metadata a reader can use; command bookkeeping (idempotency keys,
// versions, devices) stays out of the panel.
const AUDIT_METADATA_LABELS: Array<[string, [string, string]]> = [
  ["poId", ["PO", "PO"]],
  ["grnId", ["Receipt", "收货单"]],
  ["rfqId", ["RFQ", "询价单"]],
  ["sourceRequest", ["Source request", "来源申请"]],
  ["lineCount", ["Lines", "明细行"]],
  ["acceptedQty", ["Accepted", "合格数"]],
  ["rejectedQty", ["Rejected", "拒收数"]],
  ["movementIds", ["Inventory movements", "库存移动"]],
  ["bestSupplier", ["Supplier", "供应商"]],
];
const AUDIT_TECHNICAL_KEYS = new Set(["commandType", "idempotencyKey", "expectedVersion", "sourceDeviceId", "requestHash", "actor", "from", "to", "reason"]);

export function auditMetadataSummary(metadata: Record<string, unknown> | undefined, language: string) {
  if (!metadata) return "";
  const parts = AUDIT_METADATA_LABELS.flatMap(([key, pair]) => {
    const value = metadata[key];
    if (value === undefined || value === null || value === "") return [];
    const label = pairText(pair, language);
    if (Array.isArray(value)) return [`${label} ${value.length ? value.join(", ") : pairText(["none", "无"], language)}`];
    return [`${label} ${String(value)}`];
  });
  return parts.slice(0, 3).join(" · ");
}

// Who took the step: a name when the row has one, never an id or an object.
export function auditActorName(actor: unknown) {
  if (typeof actor === "string") return actor;
  if (actor && typeof actor === "object") {
    const person = actor as Record<string, unknown>;
    for (const key of ["name", "displayName", "email"]) if (typeof person[key] === "string" && person[key]) return String(person[key]);
  }
  return "";
}

export function DocumentHistoryPanel({
  entityType,
  entityId,
  title = "单据历史",
  refreshKey,
  emptyText = "暂无历史记录。当前单据暂无操作记录，后续状态变更会自动记录。",
}: {
  entityType: AuditEntry["entityType"];
  entityId?: string;
  title?: string;
  refreshKey?: string;
  // The text when there are no entries, for a page that says what the panel tracks.
  emptyText?: string;
}) {
  const { formatDateTime, language } = useI18n();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);

  useEffect(() => {
    if (!entityId) {
      setEntries([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams({ entityType: String(entityType), entityId, limit: "20" });
    apiJson<AuditEntry[]>(`/api/audit-log?${params.toString()}`)
      .then((data) => { if (alive) setEntries(data); })
      .catch(() => { if (alive) setEntries([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [entityType, entityId, refreshKey]);

  const statusText = (code: unknown) => (typeof code === "string" && code ? statusCodeLabel(code, language) || code : "");

  return (
    <div className="rounded-xl p-3 mb-4" style={{ background: A.gray6, border: "1px solid rgba(0,0,0,0.05)" }} data-testid="document-history">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: A.label }}>
          <History size={12} /> {copy(title)}
        </div>
        <span className="fc-caption" style={{ color: A.gray2 }}>{loading ? copy("加载中") : `${entries.length} ${copy("条记录")}`}</span>
      </div>
      {entries.length === 0 ? (
        <div className="fc-caption leading-4" style={{ color: A.sub }}>
          {copy(emptyText)}
        </div>
      ) : (
        <div className="space-y-2">
          {entries.slice(0, 5).map((entry) => {
            const id = entry.auditId || entry.id || `${entry.timestamp}-${entry.action}`;
            const metadata = (entry.metadata || {}) as Record<string, unknown>;
            const metadataSummary = auditMetadataSummary(metadata, language);
            const reason = entry.reason || (typeof metadata.reason === "string" ? metadata.reason : "");
            const from = statusText(entry.fromStatus ?? metadata.from);
            const to = statusText(entry.toStatus ?? metadata.to);
            const statusChange = from || to ? `${from || pairText(["New", "新建"], language)} → ${to || "—"}` : "";
            const actor = auditActorName(entry.actor);
            const details = Object.entries(metadata).filter(([key, value]) => !AUDIT_TECHNICAL_KEYS.has(key) && value !== null && value !== undefined && value !== "");
            return (
              <div key={id} className="rounded-lg px-2.5 py-2" style={{ background: A.white }} data-testid="document-history-entry">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold" style={{ color: entry.action === "system_validation_blocked" ? A.red : A.label }}>
                      {auditActionLabel(entry.action, language)}
                    </div>
                    <div className="fc-caption mt-0.5" style={{ color: A.gray2 }}>
                      {entry.timestamp && !Number.isNaN(new Date(entry.timestamp).getTime()) ? formatDateTime(entry.timestamp) : entry.timestamp || "—"}{actor ? ` · ${actor}` : ""}
                    </div>
                  </div>
                  {statusChange ? <span className="fc-caption shrink-0" style={{ color: A.blue }}>{statusChange}</span> : null}
                </div>
                {(reason || metadataSummary) && (
                  <div className="fc-caption leading-4 mt-1" style={{ color: A.sub }}>
                    {reason || metadataSummary}
                    {reason && metadataSummary ? ` · ${metadataSummary}` : ""}
                  </div>
                )}
                {details.length > 0 && (
                  <>
                    <button onClick={() => setOpenDetailId(openDetailId === id ? null : id)}
                      className="mt-1 inline-flex items-center gap-1 fc-caption font-medium"
                      style={{ color: A.gray1 }}>
                      <ChevronDown size={10} className={openDetailId === id ? "rotate-180 transition-transform" : "transition-transform"} />
                      {pairText(["Details", "查看细节"], language)}
                    </button>
                    {openDetailId === id && (
                      <div className="mt-1 rounded-md px-2 py-1.5 fc-caption leading-4 break-words"
                        style={{ background: A.gray6, color: A.sub }}>
                        {details.slice(0, 6).map(([key, value]) => (
                          <div key={key}>
                            <span className="font-medium" style={{ color: A.gray1 }}>{key}: </span>
                            {Array.isArray(value) ? value.join(", ") : String(value)}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Card({
  children,
  className = "",
  style = {},
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div {...props} className={`bg-white rounded-xl border ${className}`}
      style={{ borderColor: A.border, boxShadow: "0 1px 2px rgba(15,23,42,0.04)", ...style }}>
      {children}
    </div>
  );
}

export function KpiCard({ label, value, sub, delta, positive, icon: Icon, color }: {
  label: string; value: string; sub?: string; delta?: string; positive?: boolean;
  icon: React.ElementType; color?: string;
}) {
  const copy = useWorkspaceCopy();
  const c = color ?? A.blue;
  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${c}12` }}>
          <Icon size={15} style={{ color: c }} strokeWidth={1.8} />
        </div>
        {delta !== undefined && (
          <div className="flex items-center gap-0.5 text-xs font-medium"
            style={{ color: positive ? A.green : A.red }}>
            {positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {delta}
          </div>
        )}
      </div>
      <div>
        <div className="fc-kpi-value" style={{ color: A.label }}>{value}</div>
        <div className="fc-label mt-0.5" style={{ color: A.sub }}>{copy(label)}</div>
        {sub && <div className="fc-caption mt-0.5" style={{ color: A.gray2 }}>{copy(sub)}</div>}
      </div>
    </Card>
  );
}

export function SegmentedControl({ options, value, onChange }: {
  options: { label: string; value: string }[]; value: string; onChange: (v: string) => void;
}) {
  const copy = useWorkspaceCopy();
  return (
    <div className="flex p-0.5 rounded-lg" style={{ background: A.gray5 }}>
      {options.map((opt) => (
        <button key={opt.value} onClick={() => onChange(opt.value)}
          className="px-3 py-1 rounded-md text-xs font-medium transition-all duration-150"
          style={value === opt.value
            ? { background: A.white, color: A.label, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }
            : { background: "transparent", color: A.sub }}>
          {copy(opt.label)}
        </button>
      ))}
    </div>
  );
}

export const AppleTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl px-3 py-2.5 text-xs"
      style={{ background: "rgba(255,255,255,0.95)", boxShadow: "0 4px 20px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.08)", backdropFilter: "blur(20px)" }}>
      <div className="font-medium mb-1.5" style={{ color: A.label }}>{label}</div>
      {payload.map((p: any, i: number) => (
        p.value !== null && (
          <div key={i} className="flex justify-between gap-4">
            <span style={{ color: A.sub }}>{p.name}</span>
            <span className="font-medium" style={{ color: p.color }}>{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</span>
          </div>
        )
      ))}
    </div>
  );
};

export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const copy = useWorkspaceCopy();
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="fc-section-title" style={{ color: A.label }}>{copy(title)}</h2>
      {right}
    </div>
  );
}

export function Modal({ open, onClose, title, subtitle, width = 560, children, footer }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  width?: number; children: React.ReactNode; footer?: React.ReactNode;
}) {
  const copy = useWorkspaceCopy();
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // A real dialog: named by its title, focus moves in and stays, Escape
  // closes it and focus returns to the opener (useDialogFocus).
  useDialogFocus(open, dialog, onClose);
  if (!open) return null;
  return (
    <div className="fc-overlay-enter fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.32)", backdropFilter: "blur(10px)" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="fc-dialog-enter bg-white rounded-2xl flex flex-col max-h-[88vh] overflow-hidden outline-none"
        style={{ width: `min(${width}px, calc(100vw - 32px))`, boxShadow: "0 24px 60px rgba(0,0,0,0.24), 0 0 0 0.5px rgba(0,0,0,0.08)" }}>
        <div className="px-6 pt-5 pb-4 flex items-start justify-between" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h2 id={titleId} className="fc-modal-title" style={{ color: A.label }}>{copy(title)}</h2>
            {subtitle && <p className="fc-page-subtitle mt-0.5" style={{ color: A.sub }}>{subtitle}</p>}
          </div>
          <button aria-label={copy("关闭")} onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-gray-100 transition-colors max-sm:h-9 max-sm:w-9"
            style={{ color: A.gray1 }}>
            <X size={15} />
          </button>
        </div>
        <div className="fc-body flex-1 overflow-auto px-6 py-5">{children}</div>
        {footer && <div className="px-6 py-4 flex items-center justify-end gap-2"
          style={{ borderTop: "0.5px solid rgba(0,0,0,0.06)", background: A.gray6 }}>{footer}</div>}
      </div>
    </div>
  );
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-required"?: boolean; "aria-invalid"?: boolean };
const CONTROL_TAGS = new Set(["input", "select", "textarea"]);
const isElement = (node: React.ReactNode): node is React.ReactElement<ControlProps> => React.isValidElement(node) && typeof node.type === "string";

// The label names its control: a single control child gets an id (unless it
// has one) and the label points at it, so a screen reader reads the label,
// not the placeholder. Among several children (a control and its notes), the
// first input, select or textarea is the control.
// `required` puts a "*" after the label and aria-required on the control;
// `error` shows its message right under the control, tied to it with
// aria-describedby, and sets aria-invalid. The form standard is in
// formLayout.tsx.
export function Field({ label, children, hint, required = false, error }: { label: string; children: React.ReactNode; hint?: string; required?: boolean; error?: string | null }) {
  const copy = useWorkspaceCopy();
  const fallbackId = useId();
  const nodes = React.Children.toArray(children);
  const single = React.Children.count(children) === 1 && isElement(children) ? children : null;
  const child = single || nodes.find((node): node is React.ReactElement<ControlProps> => isElement(node) && CONTROL_TAGS.has(node.type as string)) || null;
  const controlId = child?.props.id || fallbackId;
  const errorId = `${controlId}-error`;
  const message = error ? <p key="field-error" id={errorId} className="text-[12px] leading-[18px] text-red-600">{error}</p> : null;
  const wired: React.ReactNode[] | null = child ? [React.cloneElement(child, {
    key: "field-control",
    id: controlId,
    ...(required ? { "aria-required": true } : {}),
    ...(error ? { "aria-invalid": true, "aria-describedby": [child.props["aria-describedby"], errorId].filter(Boolean).join(" ") } : {}),
  }), message] : null;
  const labelElement = <label htmlFor={child ? controlId : undefined} className="block text-[13px] leading-5 font-semibold" style={{ color: A.sub }}>{copy(label)}</label>;
  return (
    <div className="space-y-1.5">
      {required ? <div className="flex items-baseline gap-0.5">{labelElement}<span aria-hidden="true" className="text-[13px] leading-5 font-semibold text-blue-600">*</span></div> : labelElement}
      {!child ? <>{children}{message}</> : single ? wired : nodes.flatMap<React.ReactNode>((node) => (node === child ? wired : [node]))}
      {hint && <p className="text-[12px] leading-[18px]" style={{ color: A.gray2 }}>{copy(hint)}</p>}
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8, fontSize: 13, lineHeight: "20px", color: A.label,
  background: A.white, border: `0.5px solid ${A.gray4}`,
};
