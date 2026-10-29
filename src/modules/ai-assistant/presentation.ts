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

// The progress line while the model-first assistant answers a typed question
// (server/routes/ai-runtime-stream.mjs): what it reads, then that it writes
// and checks the answer. English first, with the Chinese beside it.
const PROGRESS_COPY = {
  "en-US": {
    sources: {
      purchase_orders: "purchase orders", purchase_requests: "purchase requests", rfqs: "RFQs", inventory: "inventory", supplier_invoices: "supplier invoices",
      receipts: "receipts", suppliers: "suppliers", sales_orders: "sales orders", documents: "documents", contracts: "contracts", supplier_risks: "supplier risks",
      receivables: "customer invoices", workspace: "the workspace summary", records: "records",
    } as Record<string, string>,
    reading: "Reading {sources}…",
    documents: "Searching your documents…",
    records: "Searching your records…",
    calculation: "Calculating…",
    writing: "Writing the answer…",
    checking: "Checking the figures…",
  },
  "zh-CN": {
    sources: {
      purchase_orders: "采购订单", purchase_requests: "采购申请", rfqs: "询价单", inventory: "库存", supplier_invoices: "供应商发票",
      receipts: "收货单", suppliers: "供应商", sales_orders: "销售订单", documents: "文档", contracts: "合同", supplier_risks: "供应商风险",
      receivables: "客户发票", workspace: "工作区概况", records: "记录",
    } as Record<string, string>,
    reading: "正在读取{sources}…",
    documents: "正在检索文档…",
    records: "正在查找记录…",
    calculation: "正在计算…",
    writing: "正在撰写回答…",
    checking: "正在核对数字…",
  },
} as const;

function listOf(values: string[], language: "en-US" | "zh-CN") {
  if (language === "zh-CN") return values.join("、");
  return values.length > 1 ? `${values.slice(0, -1).join(", ")} and ${values.at(-1)}` : values[0] || "";
}

export function aiProgressLine(progress: { step?: string; sources?: string[] } | null | undefined, language: "en-US" | "zh-CN" = "en-US") {
  const copy = PROGRESS_COPY[language];
  if (progress?.step === "writing") return copy.writing;
  if (progress?.step === "checking") return copy.checking;
  const sources = [...new Set(progress?.sources || [])];
  const read = sources.filter((source) => source !== "calculation" && copy.sources[source]);
  if (!read.length) return sources.includes("calculation") ? copy.calculation : copy.records;
  if (read.length === 1 && read[0] === "documents") return copy.documents;
  if (read.length === 1 && read[0] === "records") return copy.records;
  return copy.reading.replace("{sources}", listOf(read.slice(0, 3).map((source) => copy.sources[source]), language));
}
