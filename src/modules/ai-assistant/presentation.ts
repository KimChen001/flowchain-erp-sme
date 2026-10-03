const JSON_LIKE_START = /^[\s\r\n]*[\[{]/;
const DEBUG_LINE = /^(intent|cards|evidence|provider|model|tool|schema)\s*[:=]/i;
const AMOUNT_CONTEXT_WAN = /(订单金额|发票金额|合同金额|差异金额|采购额|应付|余额|贷项|报价金额|金额)\s*(¥?)\s*(-?\d+(?:\.\d+)?)\s*万/g;

// The AI answer's currency is not known here, so only keep a ¥ symbol that the
// source text already carried; otherwise expand 万 into a plain number.
function amountText(value: number, symbol = "") {
  return `${symbol}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;
}

export function looksLikeRawJson(value: unknown) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!JSON_LIKE_START.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function parsesAsJsonLine(value: string) {
  const trimmed = value.trim();
  if (!JSON_LIKE_START.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function stripInlineMarkdownEmphasis(value: string) {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=$|[^\w*])/g, "$1$2");
}

export function normalizeAiMessageAmounts(value: string) {
  return value.replace(AMOUNT_CONTEXT_WAN, (_match, label: string, symbol: string, numeric: string) => {
    const amount = Number(numeric) * 10000;
    if (!Number.isFinite(amount)) return _match;
    return `${label} ${amountText(amount, symbol)}`;
  });
}

export function sanitizeAiMessage(value: unknown) {
  if (typeof value !== "string") return "";
  const lines = value.split(/\r?\n/);
  let inDebugFence = false;
  return lines
    .filter((line) => {
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) {
        inDebugFence = !inDebugFence;
        return false;
      }
      if (inDebugFence) return false;
      if (DEBUG_LINE.test(trimmed)) return false;
      if (parsesAsJsonLine(trimmed)) return false;
      return true;
    })
    .map((line) => normalizeAiMessageAmounts(stripInlineMarkdownEmphasis(line.replace(/^\s{0,3}#{1,6}\s+/, "").trimEnd())))
    .join("\n")
    .trim();
}
