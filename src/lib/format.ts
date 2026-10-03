// A missing or hidden amount (null, undefined, empty or not a number)
// renders as "—", never as 0: a role without the amount permission gets null
// from the server, and showing it as $0.00 would state a false value.
export function formatNumberAmount(value: number | string | null | undefined, options: Intl.NumberFormatOptions = {}) {
  if (value === null || value === undefined || value === "") return "—";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    ...options,
  }).format(amount);
}

export function formatCurrencyAmount(value: number | string | null | undefined, currency?: string) {
  if (!currency) return formatNumberAmount(value);
  return formatNumberAmount(value, { style: "currency", currency });
}

// Pass the document or workspace currency when it is known. Without one the
// amount renders as a plain number rather than guessing a currency symbol.
export function fmt(n: number | string | null | undefined, currency?: string) {
  return formatCurrencyAmount(n, currency);
}

// A stored quantity for display: every stored digit kept, trailing zeros of the
// fixed four-decimal scale dropped and thousands grouped ("19500.0000" ->
// "19,500"). Strings are handled as text so large decimals stay exact.
export function formatQuantity(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const [, sign, whole, fraction = ""] = match;
  const trimmed = fraction.replace(/0+$/, "");
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${trimmed ? `.${trimmed}` : ""}`;
}

// An instant as a date and time in the workspace timezone ("Sep 29, 2026,
// 10:35 AM"), not the UTC ISO string. A value that is not an instant is shown as is.
export function formatDateTimeInTimeZone(value: string | null | undefined, locale?: string, timeZone?: string) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale || "en-US", { timeZone: timeZone || workspaceTimeZone || DEFAULT_WORKSPACE_TIMEZONE, dateStyle: "medium", timeStyle: "short" }).format(parsed);
  } catch {
    return value;
  }
}

export const DEFAULT_WORKSPACE_TIMEZONE = "America/New_York";

// Today's calendar date (YYYY-MM-DD) in the workspace timezone, not UTC or the browser.
// The I18n provider records the loaded workspace timezone here, so helpers used
// outside React (exports, file names) follow the workspace without every caller
// passing it.
let workspaceTimeZone = "";
export function setWorkspaceTimeZone(timeZone?: string | null) {
  workspaceTimeZone = String(timeZone || "").trim();
}

export function todayInTimeZone(timeZone?: string, now: Date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || workspaceTimeZone || DEFAULT_WORKSPACE_TIMEZONE }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_WORKSPACE_TIMEZONE }).format(now);
  }
}

// Amount in the workspace locale. A currency symbol is shown only when the
// document's currency is known; otherwise the amount is a plain number.
// Never throws: an unrecognised code falls back to "<number> <code>".
export function formatLocaleAmount(value: number, currency: string | null | undefined, locale?: string, options: Intl.NumberFormatOptions = {}) {
  const code = String(currency || "").trim().toUpperCase();
  try {
    return new Intl.NumberFormat(locale || "en-US", code ? { style: "currency", currency: code, ...options } : options).format(value);
  } catch {
    const plain = new Intl.NumberFormat("en-US", options).format(value);
    return code ? `${plain} ${code}` : plain;
  }
}

// Wall-clock value ("YYYY-MM-DDTHH:mm") of an instant in the workspace
// timezone, for <input type="datetime-local">.
export function dateTimeInputInTimeZone(value: Date, timeZone?: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || workspaceTimeZone || DEFAULT_WORKSPACE_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// The instant (ISO string) at which the workspace timezone reads the given
// wall-clock value, so a time typed on the page means workspace time rather
// than the browser's. Returns "" for an unreadable value.
export function dateTimeInputToIso(value: string, timeZone?: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return "";
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (instant: number) => {
    const shown = dateTimeInputInTimeZone(new Date(instant), timeZone).match(/\d+/g)!.map(Number);
    return Date.UTC(shown[0], shown[1] - 1, shown[2], shown[3], shown[4]) - instant;
  };
  let instant = wall - offset(wall);
  instant = wall - offset(instant);
  return new Date(instant).toISOString();
}
