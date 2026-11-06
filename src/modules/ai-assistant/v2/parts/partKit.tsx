import type { ReactNode } from "react";
import { EvidenceLink, type Navigate } from "../../../../components/ai/AiResponseV2Renderer";
import { A } from "../../../../components/ui";
import { isTranslationKey, translate, useI18n, type TranslationKey } from "../../../../i18n/I18n";
import { statusCodeLabel } from "../../../../i18n/statusLabels";
import { formatCalendarDay, formatLocaleAmount } from "../../../../lib/format";
import type { AnswerLanguage, PartRef, StatusTone, StatusValue, ValueUnit } from "./types";

export type { Navigate };

// "lead_time_days" -> "Lead time days": a code with no label yet still reads.
const humanize = (code: string) => {
  const words = code.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
};

// The parts' copy and formatters. Labels follow the answer's language (the
// question's), falling back to the interface language; numbers, amounts and
// dates keep the workspace locale whatever the language.
export function usePartCopy(answerLanguage?: string) {
  const i18n = useI18n();
  const language: AnswerLanguage = answerLanguage === "zh-CN" || answerLanguage === "en-US" ? answerLanguage : i18n.language === "zh-CN" ? "zh-CN" : "en-US";
  const t = (key: TranslationKey, variables?: Record<string, string | number>) => translate(language, key, variables);
  const known = (prefix: string, code: string) => {
    const key = `${prefix}.${code}`;
    return isTranslationKey(key) ? t(key) : humanize(code);
  };
  const number = (value: number) => i18n.formatNumber(value);
  const money = (value: number, currency?: string | null) => formatLocaleAmount(value, currency, i18n.locale, { maximumFractionDigits: 2 });
  const day = (value: string) => formatCalendarDay(value, i18n.locale);
  // A missing or role-hidden value is a dash, never 0.
  const value = (input: number | null | undefined, unit: ValueUnit, currency?: string | null) => {
    if (input === null || input === undefined || !Number.isFinite(input)) return "—";
    if (unit === "money") return money(input, currency);
    if (unit === "percent") return `${number(input)}%`;
    if (unit === "days") return t("ai.v2.unit.days", { count: number(input) });
    return number(input);
  };
  return { language, locale: i18n.locale, timezone: i18n.timezone, t, known, number, money, day, value };
}

export type PartCopy = ReturnType<typeof usePartCopy>;

// Owner palette (2026-10-03): red is overdue or a problem, orange is waiting,
// teal is done or healthy. Text shades are darker than the fills so they read on white.
const TONE_STYLE: Record<StatusTone, { background: string; color: string }> = {
  danger: { background: "#FEF2F2", color: "#B91C1C" },
  warning: { background: "#FFF7ED", color: "#9A3412" },
  success: { background: "#F0FDFA", color: "#0F766E" },
  info: { background: "#EFF4FF", color: A.blue },
  neutral: { background: A.gray6, color: A.sub },
};
const CODE_TONE: Record<string, StatusTone> = {
  overdue: "danger", rejected: "danger", exception: "danger", mismatch: "danger", disputed: "danger", failed: "danger", out_of_stock: "danger", shortage_risk: "danger", risk: "danger",
  pending: "warning", warning: "warning", due: "warning", pending_approval: "warning", submitted: "warning", held: "warning", on_hold: "warning", below_safety_stock: "warning", below_reorder_point: "warning", partially_received: "warning", variance: "warning",
  approved: "success", received: "success", fully_received: "success", matched: "success", completed: "success", posted: "success", passed: "success", available: "success",
  draft: "neutral", cancelled: "neutral", canceled: "neutral", closed: "neutral", withdrawn: "neutral", inactive: "neutral",
};

export function statusTone(status: StatusValue): StatusTone {
  return status.tone || CODE_TONE[status.code] || "info";
}

export function StatusPill({ status, copy }: { status: StatusValue; copy: PartCopy }) {
  const label = statusCodeLabel(status.code, copy.language) || copy.known("ai.v2.status", status.code);
  return <span data-testid="ai-v2-status" data-tone={statusTone(status)} className="inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap" style={TONE_STYLE[statusTone(status)]}>{label}</span>;
}

export function toneStyle(tone: StatusTone) {
  return TONE_STYLE[tone];
}

// A record the server named, as the answer's record chip.
export function RefChip({ value, onNavigate, children }: { value: PartRef; onNavigate?: Navigate; children?: ReactNode }) {
  return <EvidenceLink item={{ id: `${value.type}:${value.id}`, label: value.label, entityLabel: value.label, entityType: value.type, entityId: value.id, moduleId: "", evidenceType: "record", summary: "" }} onNavigate={onNavigate}>{children}</EvidenceLink>;
}

export const isRef = (value: unknown): value is PartRef =>
  Boolean(value) && typeof value === "object" && typeof (value as PartRef).type === "string" && typeof (value as PartRef).id === "string" && typeof (value as PartRef).label === "string";

// The card every part sits in: white on the panel's grey, with the owner border.
export const cardStyle = { background: A.white, border: `1px solid ${A.gray4}` };
