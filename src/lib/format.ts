export function formatNumberAmount(value: number | null | undefined, options: Intl.NumberFormatOptions = {}) {
  const amount = Number(value || 0);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    ...options,
  }).format(safeAmount);
}

export function formatCurrencyAmount(value: number | null | undefined, currency?: string) {
  if (!currency) return formatNumberAmount(value);
  return formatNumberAmount(value, { style: "currency", currency });
}

// Pass the document or workspace currency when it is known. Without one the
// amount renders as a plain number rather than guessing a currency symbol.
export function fmt(n: number | null | undefined, currency?: string) {
  return formatCurrencyAmount(n, currency);
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
