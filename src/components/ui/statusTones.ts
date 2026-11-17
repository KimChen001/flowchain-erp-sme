// The one table of status colours (design audit L6-08, U-05, U-06). The
// list chips, the PO pill, the document headers, the finance pages, Today,
// the assistant's cards, the evidence graph and the report charts all read a
// status's tone from here, so one status code has one colour everywhere.
//
// The tones follow the owner-approved palette (2026-10-03): teal for done,
// orange for waiting on someone (approval, matching) and stock warnings, red
// for exceptions and what is late, blue for in progress, gray for drafts,
// cancelled and closed records. Codes and the server's older Chinese labels
// are both recognised; anything unknown is neutral.

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONES: Record<StatusTone, string[]> = {
  success: [
    "approved", "matched", "variance_approved", "recorded", "auto_matched", "converted", "completed", "fully_received", "received",
    "fully_reserved", "fully_fulfilled", "fulfilled", "delivered", "awarded", "settled", "paid", "resolved", "posted", "passed",
    "active", "available", "ok", "low",
    "已批准", "已审批", "已匹配", "自动匹配", "已完成", "已转换", "已解决", "已入库", "已收货",
  ],
  warning: [
    "submitted", "pending", "pending_approval", "pending_match", "held", "on_hold", "awaiting_receipt", "unposted", "partially_reserved",
    "below_safety_stock", "below_reorder_point", "medium", "due", "warning",
    "待审批", "待匹配", "待处理", "人工复核", "缺少收货",
  ],
  danger: [
    "rejected", "exception", "variance", "mismatch", "disputed", "overdue", "failed", "blocked", "risk",
    "out_of_stock", "shortage_risk", "high",
    "已驳回", "已拒绝", "存在差异", "差异待处理", "异常处理", "重复发票", "缺货风险", "高风险", "阻塞", "缺货",
  ],
  info: [
    "open", "confirmed", "issued", "sent", "issued_outside_flowchain", "collecting_quotes", "matching", "partially_received",
    "partially_fulfilled", "partially_allocated", "partial", "reserved", "ready_to_ship", "ready_for_receiving", "export_ready",
    "to_pay", "to_be_paid", "partially_settled", "reviewed",
    "已发出", "部分到货", "已签收", "质检中", "已确认", "部分分配", "可发货", "部分发货",
  ],
  neutral: [
    "draft", "cancelled", "canceled", "withdrawn", "closed", "not_sent", "reversed", "voided", "void", "not_reserved",
    "not_fulfilled", "not_received", "not_matched", "inactive", "unavailable", "quarantined", "unknown",
    "草稿", "已取消", "已撤回", "已关闭",
  ],
};
const toneOf = new Map(Object.entries(TONES).flatMap(([tone, codes]) => codes.map((code) => [code, tone as StatusTone])));

/** Every status this table colours, for tests and for the charts. */
export const STATUS_TONE_CODES: ReadonlyArray<string> = [...toneOf.keys()];

/** The tone of a status code (or an older Chinese label); neutral when unknown. */
export function statusToneOf(status?: string | null): StatusTone {
  return toneOf.get(String(status || "").trim()) || "neutral";
}

/** The tone of a status this table knows, or undefined. */
export function knownStatusTone(status?: string | null): StatusTone | undefined {
  return toneOf.get(String(status || "").trim());
}

const SEVERITY: StatusTone[] = ["danger", "warning", "info", "success", "neutral"];
/** The most serious tone among several codes or words ("high 阻塞 matching"). */
export function mostSeriousTone(text?: string | null): StatusTone {
  const tones = String(text || "").split(/\s+/).map(knownStatusTone).filter((tone): tone is StatusTone => Boolean(tone));
  return SEVERITY.find((tone) => tones.includes(tone)) || "neutral";
}

/** The chip colours of each tone, as the list chips draw them (Tailwind teal, amber, red, blue, slate). */
export const STATUS_TONE_COLORS: Record<StatusTone, { background: string; color: string }> = {
  success: { background: "#f0fdfa", color: "#0f766e" },
  warning: { background: "#fffbeb", color: "#b45309" },
  danger: { background: "#fef2f2", color: "#b91c1c" },
  info: { background: "#eff6ff", color: "#1d4ed8" },
  neutral: { background: "#f1f5f9", color: "#475569" },
};

/** The chart colours of each tone: shades of one family, so two statuses of one tone in one chart stay apart. */
export const STATUS_TONE_SHADES: Record<StatusTone, string[]> = {
  success: ["#0d9488", "#14b8a6", "#0f766e", "#2dd4bf"],
  info: ["#2563eb", "#0ea5e9", "#6366f1", "#3b82f6", "#1d4ed8"],
  warning: ["#f59e0b", "#ea580c", "#d97706", "#fb923c"],
  danger: ["#dc2626", "#b91c1c", "#ef4444"],
  neutral: ["#94a3b8", "#64748b", "#cbd5e1"],
};

/**
 * One chart colour per status code: the code's tone family, and within it
 * the next shade for each code of that tone, in a fixed order, so a status
 * has the same colour in every chart.
 */
// The statuses that share a chart come first, chart by chart (purchase
// orders, sales orders, stock, matching, risk), so they take different shades.
const CHART_ORDER = [
  "draft", "pending_approval", "submitted", "approved", "issued", "partially_received", "fully_received", "received", "closed", "cancelled", "rejected",
  "confirmed", "held", "shortage_risk", "ready_to_ship", "partially_fulfilled", "fulfilled",
  "ok", "below_reorder_point", "below_safety_stock", "out_of_stock", "unknown",
  "matching", "matched", "exception", "pending",
  "low", "medium", "high",
];
export const STATUS_CHART_COLORS: Readonly<Record<string, string>> = (() => {
  const used: Record<StatusTone, number> = { success: 0, info: 0, warning: 0, danger: 0, neutral: 0 };
  const colors: Record<string, string> = {};
  for (const code of [...new Set([...CHART_ORDER, ...STATUS_TONE_CODES])]) {
    if (/[^\x00-\x7f]/.test(code)) continue;
    const tone = statusToneOf(code);
    const shades = STATUS_TONE_SHADES[tone];
    colors[code] = shades[used[tone] % shades.length];
    used[tone] += 1;
  }
  return colors;
})();
