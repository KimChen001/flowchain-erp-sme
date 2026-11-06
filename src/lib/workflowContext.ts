export type WorkflowContext = {
  sourceModule: string;
  sourceEntityType?: string;
  sourceEntityId?: string;
  sourceRoute?: string;
  sourceLabel?: string;
  originIntent?: string;
  sourceQuery?: string;
  aiTrigger?: string;
  returnLabel?: string;
};

const SOURCE_MODULE_LABELS: Record<string, string> = {
  overview: "首页",
  todayCockpit: "首页",
  sales: "销售管理",
  procurement: "采购管理",
  inventory: "库存管理",
  srm: "基础资料",
  supplier: "基础资料",
  finance: "结算管理",
  "master-data": "基础资料",
  reports: "报表中心",
  imports: "数据接入与质量",
  "exception-cases": "异常处理工单",
  forecast: "预测与 MRP",
  ai: "AI 助手",
  globalSearch: "全局搜索",
};

const SOURCE_ENTITY_LABELS: Record<string, string> = {
  customer_order: "销售订单",
  sales_order: "销售订单",
  inventory_availability: "库存可用量",
  inventory_item: "SKU",
  item: "SKU",
  sku: "SKU",
  purchase_request: "采购申请",
  rfq: "RFx",
  purchase_order: "采购订单",
  receiving_doc: "收货单",
  supplier: "供应商",
  supplier_invoice: "采购发票",
  exception_case: "异常工单",
  report: "报表",
  import_batch: "数据导入批次",
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}
function compactContext(context: WorkflowContext) {
  return {
    sourceModule: clean(context.sourceModule) || "overview",
    sourceEntityType: clean(context.sourceEntityType),
    sourceEntityId: clean(context.sourceEntityId),
    sourceRoute: clean(context.sourceRoute),
    sourceLabel: clean(context.sourceLabel),
    originIntent: clean(context.originIntent),
    sourceQuery: clean(context.sourceQuery).slice(0, 80),
    aiTrigger: clean(context.aiTrigger).slice(0, 80),
    returnLabel: clean(context.returnLabel),
  };
}

export function buildReturnContext(input: WorkflowContext | null | undefined): WorkflowContext | null {
  if (!input?.sourceModule) return null;
  const context = compactContext(input);
  return {
    sourceModule: context.sourceModule,
    ...(context.sourceEntityType ? { sourceEntityType: context.sourceEntityType } : {}),
    ...(context.sourceEntityId ? { sourceEntityId: context.sourceEntityId } : {}),
    ...(context.sourceRoute ? { sourceRoute: context.sourceRoute } : {}),
    ...(context.sourceLabel ? { sourceLabel: context.sourceLabel } : {}),
    ...(context.originIntent ? { originIntent: context.originIntent } : {}),
    ...(context.sourceQuery ? { sourceQuery: context.sourceQuery } : {}),
    ...(context.aiTrigger ? { aiTrigger: context.aiTrigger } : {}),
    ...(context.returnLabel ? { returnLabel: context.returnLabel } : {}),
  };
}

export function encodeReturnContext(context: WorkflowContext | null | undefined) {
  const safe = buildReturnContext(context);
  if (!safe) return "";
  try {
    return encodeURIComponent(JSON.stringify(safe));
  } catch {
    return "";
  }
}

export function parseReturnContext(value: string | null | undefined): WorkflowContext | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== "object" || !clean(parsed.sourceModule)) return null;
    return buildReturnContext(parsed as WorkflowContext);
  } catch {
    return null;
  }
}

export function buildReturnUrl(route: string, context: WorkflowContext | null | undefined) {
  const target = clean(route) || "overview";
  const encoded = encodeReturnContext(context);
  if (!encoded) return target;
  return `${target}${target.includes("?") ? "&" : "?"}returnTo=${encoded}`;
}

export function formatReturnLabel(context: WorkflowContext | null | undefined) {
  const safe = buildReturnContext(context);
  if (!safe) return "返回上一级";
  if (safe.returnLabel) return safe.returnLabel;
  if (safe.sourceLabel) return `返回 ${safe.sourceLabel}`;
  if (safe.sourceEntityId) {
    const entityLabel = SOURCE_ENTITY_LABELS[safe.sourceEntityType || ""] || "";
    return `返回 ${[entityLabel, safe.sourceEntityId].filter(Boolean).join(" ")}`;
  }
  if (safe.sourceModule === "overview" || safe.sourceModule === "todayCockpit") return "返回 今日行动";
  return `返回${SOURCE_MODULE_LABELS[safe.sourceModule] || "上一级"}`;
}
