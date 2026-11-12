import { useCallback } from "react";
import { useI18n } from "../../i18n/I18n";
import { formatTodayDay, todayDateText, todayDateTone, useTodayCopy, type TodayCopyKey, type TodayDated } from "./todayCopy";

// How a row of Today's work reads, wherever it is shown: on Today, in AI
// priorities and in the assistant's decision cards. A row's date as its chip
// says it ("6 days overdue", "Order today", "Due Nov 16, 2026"), the chip's
// colours, and the row's kind in words. The wording and colours are defined
// once, in todayCopy.ts (todayDateText, todayDateTone); this hook binds them
// to the reader's language and the workspace day.

type Row = { kind: string; date: string | null; dateKind: string; overdueDays: number };

// A workspace calendar day (YYYY-MM-DD) in the interface locale. The day is
// already the workspace's, so it is formatted as a date, not an instant.
export function formatDay(day: string, locale: string) {
  return formatTodayDay(day, locale);
}

export function useTodayRowFormat(today: string) {
  const { locale } = useI18n();
  const t = useTodayCopy();
  const day = useCallback((value: string) => formatTodayDay(value, locale), [locale]);
  const dateText = (row: Row) => todayDateText(t.language, locale, row as TodayDated, today);
  // Red for what is late or an exception, orange for today and for approvals
  // and stock warnings, blue for the rest, gray without a date.
  const tone = (row: Row) => todayDateTone(row as TodayDated, today);
  const kindLabel = (row: { kind: string }) => t(`kind_${row.kind}` as TodayCopyKey);
  return { day, dateText, tone, kindLabel };
}
