// Formatting for printed business documents. Always in the workspace locale
// and timezone, never in the document language: switching a document to
// Chinese changes its labels, not how 1,234.50 or a date reads.
//
// Amounts and quantities arrive as decimal strings and are formatted as text,
// never through a JS number, so every recorded digit is kept exactly.

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function separators(locale: string) {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    return {
      group: parts.find((part) => part.type === "group")?.value ?? ",",
      decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    };
  } catch {
    return { group: ",", decimal: "." };
  }
}

// A recorded decimal with its digits grouped. Trailing zeros of the stored
// scale are dropped down to `minimumFractionDigits`; a digit that was
// recorded is never rounded away. null prints "—"; text that is not a
// decimal is printed as recorded.
export function formatDecimal(value: string | null | undefined, locale: string, minimumFractionDigits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const match = DECIMAL.exec(String(value).trim());
  if (!match) return String(value);
  const [, sign, whole, fraction = ""] = match;
  let digits = fraction.replace(/0+$/, "");
  if (digits.length < minimumFractionDigits) digits = digits.padEnd(minimumFractionDigits, "0");
  const { group, decimal } = separators(locale);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  // A stored "-0.0000" is zero and prints without a minus sign.
  const zero = /^0+$/.test(whole) && /^0*$/.test(fraction);
  return `${zero ? "" : sign}${grouped}${digits ? `${decimal}${digits}` : ""}`;
}

// The minor unit digits of a currency (2 for USD, 0 for JPY), so an amount
// shows at least its cents; 2 when the code is unknown.
export function currencyFractionDigits(currency: string | null | undefined) {
  const code = String(currency || "").trim().toUpperCase();
  if (!code) return 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().minimumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatAmount(value: string | null | undefined, currency: string | null | undefined, locale: string) {
  return formatDecimal(value, locale, currencyFractionDigits(currency));
}

// A calendar date (YYYY-MM-DD). Formatted as UTC so the recorded day never
// shifts to the day before in a US timezone.
export function formatCalendarDay(day: string | null | undefined, locale: string) {
  if (!day) return "—";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(day);
  if (!match) return day;
  const parsed = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(parsed);
  } catch {
    return match[1];
  }
}

// A recorded date that is either a calendar day (printed as that day) or an
// instant (printed as the day it falls on in the workspace timezone).
export function formatDayOrInstant(value: { day: string | null; instant: string | null } | null | undefined, locale: string, timeZone: string) {
  if (value?.day) return formatCalendarDay(value.day, locale);
  return formatInstantDay(value?.instant, locale, timeZone);
}

// The day an instant (such as the moment a PO was issued) falls on in the
// workspace timezone.
export function formatInstantDay(value: string | null | undefined, locale: string, timeZone: string) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(parsed);
  } catch {
    return value;
  }
}
