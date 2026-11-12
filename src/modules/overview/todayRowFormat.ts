import { useCallback } from "react";
import { A } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { useTodayCopy, type TodayCopyKey } from "./todayCopy";

// How a row of Today's work reads, wherever it is shown: on Today and in the
// assistant's decision cards. A row's date as its chip says it ("6 days
// overdue", "Order today", "Due Nov 16, 2026"), the chip's colours, and the
// row's kind in words.

type Row = { kind: string; date: string | null; dateKind: string; overdueDays: number };

// A workspace calendar day (YYYY-MM-DD) in the interface locale. The day is
// already the workspace's, so it is formatted as a date, not an instant.
export function formatDay(day: string, locale: string) {
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(locale || "en-US", { timeZone: "UTC", dateStyle: "medium" }).format(date);
  } catch {
    return day;
  }
}

export function useTodayRowFormat(today: string) {
  const { locale } = useI18n();
  const t = useTodayCopy();
  const day = useCallback((value: string) => formatDay(value, locale), [locale]);
  const dateText = (row: Row) => {
    if (!row.date) return t("noDate");
    if (row.dateKind === "due") return row.overdueDays > 0 ? t.count("overdueDays", row.overdueDays) : row.date === today ? t("dueToday") : t("dueOn", { date: day(row.date) });
    if (row.dateKind === "order_by") return row.date <= today ? t("orderToday") : t("orderBy", { date: day(row.date) });
    if (row.dateKind === "promised") return row.overdueDays > 0 ? t.count("lateDays", row.overdueDays) : row.date === today ? t("promisedToday") : t("promisedOn", { date: day(row.date) });
    if (row.dateKind === "required") return t("neededBy", { date: day(row.date) });
    if (row.dateKind === "notice_by") return row.date === today ? t("noticeToday") : t("noticeBy", { date: day(row.date) });
    if (row.dateKind === "ends") return row.date === today ? t("endsToday") : t("endsOn", { date: day(row.date) });
    if (row.dateKind === "ended") return t.count("endedDays", row.overdueDays);
    return t("invoiceOn", { date: day(row.date) });
  };
  // Red for what is late or an exception, orange for today and for approvals
  // and stock warnings, blue for the rest, gray without a date.
  const tone = (row: Row) => {
    if (row.overdueDays > 0 || row.kind === "bill_exception") return { color: "#b91c1c", background: "#fef2f2" };
    if (row.date === today || row.kind === "reorder_now" || row.kind.endsWith("_to_approve")) return { color: "#b45309", background: "#fffbeb" };
    if (!row.date) return { color: A.gray1, background: A.gray6 };
    return { color: "#1d4ed8", background: "#eff6ff" };
  };
  const kindLabel = (row: { kind: string }) => t(`kind_${row.kind}` as TodayCopyKey);
  return { day, dateText, tone, kindLabel };
}
