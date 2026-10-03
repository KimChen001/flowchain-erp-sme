// Currencies a US small business meets most often, in the order a currency
// list offers them after the workspace currency.
export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "MXN", "JPY", "CNY"];

/**
 * Orders currency codes for a dropdown: the workspace currency first, then the
 * common currencies, then any other code. With `allowed`, only those codes are
 * offered (for example the currencies a document may use); without it, every
 * ISO currency the browser knows is listed. The current value is always kept
 * so an existing record never loses its currency.
 */
export function orderedCurrencyCodes(workspaceCurrency?: string | null, allowed?: string[] | null, current?: string | null) {
  const normalize = (code?: string | null) => String(code || "").trim().toUpperCase();
  const pool = allowed ? allowed.map(normalize).filter(Boolean) : null;
  const rest = pool || (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : []);
  const workspace = normalize(workspaceCurrency);
  const ordered = [
    ...(workspace && (!pool || pool.includes(workspace)) ? [workspace] : []),
    ...COMMON_CURRENCIES.filter((code) => !pool || pool.includes(code)),
    ...rest,
  ];
  return [...new Set([...ordered, normalize(current)].filter(Boolean))];
}
