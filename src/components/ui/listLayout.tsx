import type React from "react";
import { FileSpreadsheet, Plus, RefreshCw } from "lucide-react";
import { A, Card } from "./index";
import { typography } from "./typography";
import { useI18n } from "../../i18n/I18n";

// The list page layout every procurement tab shares, taken from the purchase
// order list: metric cards, a search card with labelled filters, then a list
// card holding the table. Callers pass copy already in the interface language.

const COPY = {
  reset: ["Reset", "重置"],
  refresh: ["Refresh", "刷新"],
  export: ["Export results", "导出当前结果"],
  loading: ["Loading…", "加载中…"],
  retry: ["Retry", "重试"],
  shown: ["{total} total, {shown} shown", "共 {total} 条，当前显示 {shown} 条"],
} as const;

export function useListCopy() {
  const { language } = useI18n();
  return (key: keyof typeof COPY, values: Record<string, string | number> = {}) =>
    COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

export const listButtonClass = {
  secondary: `inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-50 px-3 ${typography.denseButton} text-slate-900 hover:bg-slate-100`,
  export: `inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-50 px-3 ${typography.denseButton} text-blue-600 hover:bg-blue-100`,
  primary: `inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 ${typography.denseButton} text-white hover:bg-blue-700 disabled:opacity-60`,
};

// Buttons inside a table row: the main one tinted, the others neutral.
export const rowActionClass = {
  primary: "rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-100",
  neutral: "rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200",
  danger: "rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100",
};

export function ResetButton({ onClick }: { onClick: () => void }) {
  const say = useListCopy();
  return <button type="button" onClick={onClick} className={listButtonClass.secondary}>{say("reset")}</button>;
}

export function RefreshButton({ onClick }: { onClick: () => void }) {
  const say = useListCopy();
  return <button type="button" onClick={onClick} className={listButtonClass.secondary}><RefreshCw size={13} />{say("refresh")}</button>;
}

export function ExportButton({ onClick }: { onClick: () => void }) {
  const say = useListCopy();
  return <button type="button" onClick={onClick} className={listButtonClass.export}><FileSpreadsheet size={13} />{say("export")}</button>;
}

export function PrimaryButton({ onClick, children, testId }: { onClick: () => void; children: React.ReactNode; testId?: string }) {
  return <button type="button" onClick={onClick} className={listButtonClass.primary} data-testid={testId}><Plus size={13} />{children}</button>;
}

export function ListSearchCard({ title, subtitle, actions, children }: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="fc-section-title" style={{ color: A.label }}>{title}</h2>
          {subtitle && <div className="mt-1 text-xs" style={{ color: A.sub }}>{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">{children}</div>
    </Card>
  );
}

export function ListCard({ title, total, shown, right, children, testId }: {
  title: string;
  total?: number;
  shown?: number;
  right?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const say = useListCopy();
  return (
    <Card data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
        <div>
          <div className="text-sm font-semibold" style={{ color: A.label }}>{title}</div>
          {total !== undefined && <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{say("shown", { total, shown: shown ?? total })}</div>}
        </div>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      {children}
    </Card>
  );
}

// A table row standing in for the rows: loading, a load error with Retry, or
// nothing to show.
export function ListStateRow({ colSpan, state, title, detail, onRetry }: {
  colSpan: number;
  state: "loading" | "error" | "empty";
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  const say = useListCopy();
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-sm" style={{ color: A.sub }}>
        {state === "loading" ? say("loading") : (
          <>
            {title && <div className="font-semibold" style={{ color: A.label }}>{title}</div>}
            {detail && <div className="mt-1 text-xs">{detail}</div>}
            {state === "error" && onRetry && <button type="button" onClick={onRetry} className="mt-3 text-xs font-semibold text-blue-600">{say("retry")}</button>}
          </>
        )}
      </td>
    </tr>
  );
}

export const listHeadRowStyle: React.CSSProperties = { borderBottom: "0.5px solid rgba(0,0,0,0.06)" };
export const listRowClass = "transition-colors hover:bg-blue-50/40";
export const listRowStyle = (index: number, count: number): React.CSSProperties => ({
  borderBottom: index < count - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none",
});

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

// Status colours follow the brand rules: teal for done, orange for waiting on
// someone (approval, matching), red for exceptions, blue for in progress and
// gray for drafts and cancelled records. Codes and the server's Chinese
// labels are both recognised; anything unknown is neutral.
const TONES: Record<StatusTone, string[]> = {
  success: ["approved", "matched", "recorded", "auto_matched", "converted", "completed", "fully_received", "fully_reserved", "fully_fulfilled", "closed", "awarded", "settled", "resolved", "posted", "已批准", "已审批", "已匹配", "自动匹配", "已完成", "已转换", "已解决", "已入库"],
  warning: ["submitted", "pending", "pending_approval", "pending_match", "held", "on_hold", "awaiting_receipt", "unposted", "partially_reserved", "待审批", "待匹配", "待处理", "人工复核", "缺少收货"],
  danger: ["rejected", "exception", "variance", "mismatch", "disputed", "overdue", "已驳回", "已拒绝", "存在差异", "差异待处理", "异常处理", "重复发票"],
  info: ["open", "confirmed", "issued", "sent", "issued_outside_flowchain", "collecting_quotes", "partially_received", "partially_fulfilled", "received", "ready_for_receiving", "export_ready", "partially_settled", "reviewed", "已发出", "部分到货", "已收货", "已签收", "质检中"],
  neutral: ["draft", "cancelled", "canceled", "withdrawn", "not_sent", "reversed", "voided", "not_reserved", "not_fulfilled", "草稿", "已取消", "已撤回"],
};
const toneOf = new Map(Object.entries(TONES).flatMap(([tone, codes]) => codes.map((code) => [code, tone as StatusTone])));

export function statusToneOf(status?: string | null): StatusTone {
  return toneOf.get(String(status || "").trim()) || "neutral";
}

const TONE_CLASS: Record<StatusTone, string> = {
  success: "bg-teal-50 text-teal-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
  info: "bg-blue-50 text-blue-700",
  neutral: "bg-slate-100 text-slate-600",
};

export function StatusChip({ label, tone, testId }: { label: string; tone: StatusTone; testId?: string }) {
  return <span className={`fc-status-chip inline-flex w-fit items-center whitespace-nowrap ${TONE_CLASS[tone]}`} data-testid={testId}>{label}</span>;
}
