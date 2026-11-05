import { formatLocaleAmount } from "../../lib/format";

// Quotation figures in the workspace number format. The RFQ API sends exact
// decimal strings ("4900.0000"); they are formatted as strings, so a long
// amount keeps every digit, and no currency is assumed when none is sent.
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

function exact(value: string | number | null | undefined, locale: string, options: Intl.NumberFormatOptions, currency?: string | null) {
  if (value === null || value === undefined || value === "") return "—";
  const code = String(currency || "").trim().toUpperCase();
  if (typeof value === "number") return Number.isFinite(value) ? formatLocaleAmount(value, code, locale, options) : "—";
  const text = value.trim();
  if (!DECIMAL.test(text)) return "—";
  try {
    // A numeric string is formatted exactly (Intl.NumberFormat v3).
    return new Intl.NumberFormat(locale || "en-US", code ? { style: "currency", currency: code, ...options } : options).format(text as unknown as number);
  } catch {
    return formatLocaleAmount(Number(text), code, locale, options);
  }
}

/** A quoted amount or price: "$4,900.00", "CN¥97.50", "$12.3456". */
export function rfqMoney(value: string | number | null | undefined, currency: string | null | undefined, locale: string) {
  return exact(value, locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }, currency);
}

/** A quoted or requested quantity: "50", "1,250.5". */
export function rfqQuantity(value: string | number | null | undefined, locale: string) {
  return exact(value, locale, { maximumFractionDigits: 4 });
}
