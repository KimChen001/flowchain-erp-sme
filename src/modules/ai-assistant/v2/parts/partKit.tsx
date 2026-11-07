import type { ReactNode } from "react";
import { A } from "../../../../components/ui";
import { businessEntityRouteRegistry, type BusinessEntityType } from "../../../../components/business/businessEntityRoutes";
import { isDocumentNumberType, useDocumentNumber } from "../../../../lib/documentNumbers";
import { isUnavailableProductRoute } from "../../../../../shared/unavailable-product-routes.mjs";
import { isTranslationKey, translate, useI18n, type TranslationKey } from "../../../../i18n/I18n";
import { statusCodeLabel } from "../../../../i18n/statusLabels";
import { formatCalendarDay, formatLocaleAmount } from "../../../../lib/format";
import type { AnswerLanguage, PartRef, StatusTone, StatusValue, ValueUnit } from "./types";

type NavigateOptions = { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown; query?: Record<string, string> };
type FocusTarget = { entityType: string; entityId: string; focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance" };
export type Navigate = (moduleId: string, focusTarget?: FocusTarget | null, options?: NavigateOptions) => void;

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
  // A missing or role-hidden value is a dash, never 0. One day is "1 day";
  // a quantity carries its unit when the row gives one ("7,000 pcs").
  const value = (input: number | null | undefined, unit: ValueUnit, currency?: string | null, unitLabel?: string | null) => {
    if (input === null || input === undefined || !Number.isFinite(input)) return "—";
    if (unit === "money") return money(input, currency);
    if (unit === "percent") return `${number(input)}%`;
    if (unit === "days") return input === 1 ? t("ai.v2.unit.dayOne") : t("ai.v2.unit.days", { count: number(input) });
    if (unit === "quantity" && unitLabel) return `${number(input)} ${unitLabel}`;
    return number(input);
  };
  // A compact figure for a chart's axis: $21K, 2.1万.
  const compact = (input: number, unit: ValueUnit, currency?: string | null) => {
    try {
      return new Intl.NumberFormat(i18n.locale, { notation: "compact", maximumFractionDigits: 1, ...(unit === "money" && currency ? { style: "currency", currency } : {}) }).format(input) + (unit === "percent" ? "%" : "");
    } catch {
      return value(input, unit, currency);
    }
  };
  return { language, locale: i18n.locale, timezone: i18n.timezone, t, known, number, money, day, value, compact };
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

// A status, signal type or priority in words: the app's status label, the
// assistant's own, a record type's name (purchase_order), else the code
// made readable.
export function codeLabel(code: string, copy: PartCopy) {
  const own = `ai.v2.status.${code}`;
  const column = `ai.v2.column.${code}`;
  return statusCodeLabel(code, copy.language) || (isTranslationKey(own) ? copy.t(own) : isTranslationKey(column) ? copy.t(column) : copy.known("ai.v2.status", code));
}

export function StatusPill({ status, copy }: { status: StatusValue; copy: PartCopy }) {
  const label = codeLabel(status.code, copy);
  return <span data-testid="ai-v2-status" data-tone={statusTone(status)} className="inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap" style={TONE_STYLE[statusTone(status)]}>{label}</span>;
}

export function toneStyle(tone: StatusTone) {
  return TONE_STYLE[tone];
}

function entityTypeOf(value = ""): BusinessEntityType | null {
  const aliases: Record<string, BusinessEntityType> = { inventory_item: "item", sku: "item", po: "purchase_order", pr: "purchase_request", grn: "receiving_doc", invoice: "supplier_invoice" };
  const candidate = aliases[value] || value;
  return candidate in businessEntityRouteRegistry ? candidate as BusinessEntityType : null;
}

const chipClass = "inline-flex max-w-full items-center whitespace-nowrap rounded px-1 align-baseline text-[12.5px] font-semibold leading-5";
// A tint, no border: a sentence full of record numbers stays calm.
const CHIP_STYLE = { background: "#EFF4FF", color: A.blue };

// A record the server named, as the answer's record chip: a button that opens
// the record, or plain text when it has no page. A purchase request, RFQ or
// purchase order labelled by its internal id is shown by its document number;
// the id still opens it.
export function RefChip({ value, onNavigate, children }: { value: PartRef; onNavigate?: Navigate; children?: ReactNode }) {
  const type = entityTypeOf(value.type);
  const byId = !value.label || value.label === value.id;
  const number = useDocumentNumber(type && isDocumentNumberType(type) && byId ? type : null, value.id);
  const label = type && isDocumentNumberType(type) && byId && number && number !== value.id ? number : value.label || value.id;
  const route = type ? businessEntityRouteRegistry[type] : null;
  if (!route || !value.id || !onNavigate || isUnavailableProductRoute(route.listRouteId)) return <span className="font-medium" style={{ color: A.label }}>{children || label}</span>;
  const focusArea = type === "purchase_order" ? "evidence" as const : undefined;
  return <button type="button" data-testid="ai-record-chip" data-action-kind="view_evidence" data-business-id={value.id} className={`${chipClass} hover:underline`} style={CHIP_STYLE} onClick={() => onNavigate(route.listRouteId, { entityType: type as string, entityId: value.id, focusArea }, { returnTo: "ai", entityLabel: label, source: "ai" })}>{children || label}</button>;
}

export const isRef = (value: unknown): value is PartRef =>
  Boolean(value) && typeof value === "object" && typeof (value as PartRef).type === "string" && typeof (value as PartRef).id === "string" && typeof (value as PartRef).label === "string";

// The card every part sits in: white on the panel's grey, with the owner border.
export const cardStyle = { background: A.white, border: `1px solid ${A.gray4}` };
