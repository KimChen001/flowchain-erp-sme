const JSON_LIKE_START = /^[\s\r\n]*[\[{]/;
const DEBUG_LINE = /^(intent|cards|evidence|provider|model|tool|schema)\s*[:=]/i;
const AMOUNT_LABEL = /(金额|余额|应付|贷项|差异|订单金额|发票金额|合同金额|采购额)/;
const WAN_AMOUNT = /^(¥?)\s*(-?\d+(?:\.\d+)?)\s*万$/;
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

export function aiDisplayMessage(value: unknown, hasCards = false) {
  if (looksLikeRawJson(value)) {
    return hasCards
      ? "已找到相关业务记录，请查看下方结果。"
      : "AI 助手暂时无法整理该结果，请换一种问法。";
  }
  return sanitizeAiMessage(value) || "已收到请求，但当前没有可展示的回复。";
}

export function safeUnknownCardMessage() {
  return "暂不支持展示该结果类型。";
}

export function normalizeAiCardValue(label: string, value: unknown) {
  if (typeof value !== "string" || !AMOUNT_LABEL.test(label)) return value;
  const match = value.trim().match(WAN_AMOUNT);
  if (!match) return value;
  const amount = Number(match[2]) * 10000;
  if (!Number.isFinite(amount)) return value;
  return amountText(amount, match[1]);
}
