import React, { useEffect, useState } from "react";
import { ArrowDownRight, ArrowLeft, ArrowUpRight, ChevronDown, History, Home, List, X } from "lucide-react";
import { toast } from "sonner";
import { apiJson } from "../../lib/api-client";
import type { AuditEntry } from "../../types/scm";
import { A } from "./tokens";
import { typography } from "./typography";
import { workspaceCopy } from "../../i18n/workspaceCopy";

export { A } from "./tokens";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

export function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span className="fc-status-chip inline-flex w-fit items-center whitespace-nowrap break-keep"
      style={{ color, background: bg }}>
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

function auditActionLabel(action: string) {
  const labels: Record<string, string> = {
    purchaseRequest_created: "创建采购申请",
    purchase_request_approved: "批准申请",
    purchase_request_rejected: "驳回申请",
    purchase_request_status_changed: "更新申请状态",
    purchase_request_converted_to_po: "转采购订单",
    purchaseOrder_created: "创建采购订单",
    purchase_order_created_from_pr: "由 PR 生成 PO",
    purchase_order_created_from_rfq: "由 RFQ 生成 PO",
    purchase_order_approved: "批准订单",
    purchase_order_rejected: "驳回订单",
    purchase_order_issued: "下发给供应商",
    purchase_order_cancelled: "取消订单",
    purchase_order_receiving_started: "开始收货",
    purchase_order_receiving_status: "收货更新订单状态",
    purchase_order_status_changed: "更新订单状态",
    rfq_created: "创建供应商报价请求",
    rfq_awarded: "授标",
    rfq_converted_to_po: "转采购订单",
    rfq_status_changed: "更新报价请求状态",
    receivingDoc_created: "创建收货单",
    receiving_posted: "收货过账",
    receiving_status_changed: "更新收货状态",
    inventory_posted: "库存已更新",
    system_validation_blocked: "系统阻止了无效操作",
  };
  return labels[action] || action.replaceAll("_", " ");
}

function auditMetadataSummary(metadata?: Record<string, unknown>) {
  if (!metadata) return "";
  const pairs = [
    ["poId", "PO"],
    ["grnId", "收货单"],
    ["rfqId", "RFQ"],
    ["sourceRequest", "来源申请"],
    ["lineCount", "明细行"],
    ["acceptedQty", "合格数"],
    ["rejectedQty", "拒收数"],
    ["movementIds", "库存移动"],
    ["bestSupplier", "供应商"],
  ] as const;
  const parts = pairs.flatMap(([key, label]) => {
    const value = metadata[key];
    if (value === undefined || value === null || value === "") return [];
    if (Array.isArray(value)) return [`${label} ${value.length ? value.join(", ") : "无"}`];
    return [`${label} ${String(value)}`];
  });
  return parts.slice(0, 3).join(" · ");
}

export function DocumentHistoryPanel({
  entityType,
  entityId,
  title = "单据历史",
  refreshKey,
}: {
  entityType: AuditEntry["entityType"];
  entityId?: string;
  title?: string;
  refreshKey?: string;
}) {
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

  return (
    <div className="rounded-xl p-3 mb-4" style={{ background: A.gray6, border: "1px solid rgba(0,0,0,0.05)" }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: A.label }}>
          <History size={12} /> {copy(title)}
        </div>
        <span className="fc-caption" style={{ color: A.gray2 }}>{loading ? copy("加载中") : `${entries.length} ${copy("条记录")}`}</span>
      </div>
      {entries.length === 0 ? (
        <div className="fc-caption leading-4" style={{ color: A.sub }}>
          {copy("暂无历史记录。当前单据暂无操作记录，后续状态变更会自动记录。")}
        </div>
      ) : (
        <div className="space-y-2">
          {entries.slice(0, 5).map((entry) => {
            const id = entry.auditId || entry.id || `${entry.timestamp}-${entry.action}`;
            const metadataSummary = auditMetadataSummary(entry.metadata);
            const statusChange = entry.fromStatus || entry.toStatus
              ? `${entry.fromStatus || "新建"} → ${entry.toStatus || "—"}`
              : "状态未变化";
            return (
              <div key={id} className="rounded-lg px-2.5 py-2" style={{ background: A.white }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold" style={{ color: entry.action === "system_validation_blocked" ? A.red : A.label }}>
                      {auditActionLabel(entry.action)}
                    </div>
                    <div className="fc-caption mt-0.5" style={{ color: A.gray2 }}>
                      {entry.timestamp ? new Date(entry.timestamp).toLocaleString("zh-CN") : "—"} · {entry.actor || "system"}
                    </div>
                  </div>
                  <span className="fc-caption shrink-0" style={{ color: A.blue }}>{statusChange}</span>
                </div>
                {(entry.reason || metadataSummary) && (
                  <div className="fc-caption leading-4 mt-1" style={{ color: A.sub }}>
                    {entry.reason || metadataSummary}
                    {entry.reason && metadataSummary ? ` · ${metadataSummary}` : ""}
                  </div>
                )}
                {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                  <>
                    <button onClick={() => setOpenDetailId(openDetailId === id ? null : id)}
                      className="mt-1 inline-flex items-center gap-1 fc-caption font-medium"
                      style={{ color: A.gray1 }}>
                      <ChevronDown size={10} className={openDetailId === id ? "rotate-180 transition-transform" : "transition-transform"} />
                      查看细节
                    </button>
                    {openDetailId === id && (
                      <div className="mt-1 rounded-md px-2 py-1.5 fc-caption leading-4 break-words"
                        style={{ background: A.gray6, color: A.sub }}>
                        {Object.entries(entry.metadata).slice(0, 6).map(([key, value]) => (
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

export function SubTabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: string; count?: number | string; icon?: React.ElementType }[];
  value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-0 overflow-x-auto" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = value === t.id;
        return (
          <button key={t.id} onClick={() => onChange(t.id)}
            className="px-4 py-2.5 fc-body font-medium flex items-center gap-1.5 shrink-0 transition-colors relative"
            style={{ color: isActive ? A.blue : A.gray1, background: "transparent" }}>
            {Icon && <Icon size={12} strokeWidth={isActive ? 2 : 1.8} />}
            {copy(t.label)}
            {t.count !== undefined && (
              <span className="fc-caption px-1.5 py-px rounded-full font-semibold tabular-nums"
                style={{ background: isActive ? "#f0f6ff" : A.gray6, color: isActive ? A.blue : A.gray1 }}>
                {t.count}
              </span>
            )}
            {isActive && <div className="absolute left-3 right-3 -bottom-px h-0.5 rounded-full" style={{ background: A.blue }} />}
          </button>
        );
      })}
    </div>
  );
}

export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
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
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.32)", backdropFilter: "blur(10px)" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl flex flex-col max-h-[88vh] overflow-hidden"
        style={{ width: `min(${width}px, calc(100vw - 32px))`, boxShadow: "0 24px 60px rgba(0,0,0,0.24), 0 0 0 0.5px rgba(0,0,0,0.08)" }}>
        <div className="px-6 pt-5 pb-4 flex items-start justify-between" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div>
            <h3 className="fc-modal-title" style={{ color: A.label }}>{copy(title)}</h3>
            {subtitle && <p className="fc-page-subtitle mt-0.5" style={{ color: A.sub }}>{subtitle}</p>}
          </div>
          <button aria-label={copy("关闭")} onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-gray-100 transition-colors"
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

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[13px] leading-5 font-semibold" style={{ color: A.sub }}>{copy(label)}</label>
      {children}
      {hint && <p className="text-[12px] leading-[18px]" style={{ color: A.gray2 }}>{copy(hint)}</p>}
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8, fontSize: 13, lineHeight: "20px", color: A.label,
  background: A.white, border: `0.5px solid ${A.gray4}`, outline: "none",
};
