// The progress line while the assistant answers (server/routes/ai-runtime-stream.mjs):
// what it reads, then that it writes and checks the answer. English first,
// with the Chinese beside it.
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
      purchase_orders: "采购订单", purchase_requests: "采购申请", rfqs: "询价单", inventory: "库存", supplier_invoices: "采购发票",
      receipts: "收货单", suppliers: "供应商", sales_orders: "销售订单", documents: "文档", contracts: "合同", supplier_risks: "供应商风险",
      receivables: "销售发票", workspace: "工作区概况", records: "记录",
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
  // Calculating is named only when nothing is read with it.
  const read = sources.filter((source) => copy.sources[source]);
  if (!read.length) return sources.includes("calculation") ? copy.calculation : copy.records;
  if (read.length === 1 && read[0] === "documents") return copy.documents;
  if (read.length === 1 && read[0] === "records") return copy.records;
  return copy.reading.replace("{sources}", listOf(read.slice(0, 3).map((source) => copy.sources[source]), language));
}
