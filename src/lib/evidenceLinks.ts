export type CanonicalEvidenceModule = "sales" | "procurement" | "inventory" | "supplier" | "masterData" | "todayCockpit" | "planning" | "ai";

export type CanonicalFocusTarget = {
  entityType: string;
  entityId: string;
  focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance";
};

export type CanonicalEvidenceLink = {
  module: CanonicalEvidenceModule;
  moduleId?: string;
  entityType: string;
  entityId: string;
  label: string;
  status?: string;
  route?: string;
  focusTarget?: CanonicalFocusTarget;
  source?: string;
  recovery?: unknown;
  clickable: boolean;
};

export type CanonicalNavigationIntent = {
  moduleId: string;
  viewId?: string;
  activeId: string;
  focusTarget?: CanonicalFocusTarget;
  source?: string;
  returnTo?: string;
  entityLabel?: string;
};

type EvidenceLike = Record<string, unknown> | null | undefined;

const PROCUREMENT_DOCUMENT_TYPES: Record<string, { entityType: string; moduleId: string; label: string }> = {
  pr: { entityType: "purchase_request", moduleId: "procurement:requests", label: "PR" },
  purchase_request: { entityType: "purchase_request", moduleId: "procurement:requests", label: "PR" },
  purchaseRequest: { entityType: "purchase_request", moduleId: "procurement:requests", label: "PR" },
  rfq: { entityType: "rfq", moduleId: "procurement:rfq", label: "RFQ" },
  po: { entityType: "purchase_order", moduleId: "procurement:orders", label: "PO" },
  purchase_order: { entityType: "purchase_order", moduleId: "procurement:orders", label: "PO" },
  purchaseOrder: { entityType: "purchase_order", moduleId: "procurement:orders", label: "PO" },
  grn: { entityType: "receiving_doc", moduleId: "procurement:receiving", label: "GRN" },
  receiving_doc: { entityType: "receiving_doc", moduleId: "procurement:receiving", label: "GRN" },
  receivingDoc: { entityType: "receiving_doc", moduleId: "procurement:receiving", label: "GRN" },
  invoice: { entityType: "supplier_invoice", moduleId: "finance:invoices", label: "供应商发票" },
  supplier_invoice: { entityType: "supplier_invoice", moduleId: "finance:invoices", label: "供应商发票" },
  threeWayMatch: { entityType: "supplier_invoice", moduleId: "finance:invoices", label: "三单匹配" },
};

const ENTITY_TARGETS: Record<string, { moduleId: string; entityType: string; module: CanonicalEvidenceModule; label: string }> = {
  sales_order: { moduleId: "sales", entityType: "sales_order", module: "sales", label: "客户订单" },
  customer_order: { moduleId: "sales", entityType: "sales_order", module: "sales", label: "客户订单" },
  inventory_item: { moduleId: "inventory", entityType: "inventory_item", module: "inventory", label: "SKU" },
  inventory_availability: { moduleId: "inventory", entityType: "inventory_item", module: "inventory", label: "库存可用量" },
  available_to_promise: { moduleId: "inventory", entityType: "inventory_item", module: "inventory", label: "可承诺量" },
  demand_supply_gap: { moduleId: "inventory", entityType: "inventory_item", module: "inventory", label: "供需缺口" },
  inventory_allocation: { moduleId: "inventory", entityType: "inventory_item", module: "inventory", label: "库存分配" },
  sku: { moduleId: "inventory", entityType: "inventory_item", module: "inventory", label: "SKU" },
  item: { moduleId: "inventory", entityType: "inventory_item", module: "inventory", label: "SKU" },
  item_master: { moduleId: "master-data:items", entityType: "item", module: "masterData", label: "SKU" },
  supplier: { moduleId: "srm:master", entityType: "supplier", module: "supplier", label: "供应商" },
  supplier_master: { moduleId: "srm:master", entityType: "supplier", module: "supplier", label: "供应商" },
  supplier_invoice: { moduleId: "finance:invoices", entityType: "supplier_invoice", module: "procurement", label: "供应商发票" },
  exception_case: { moduleId: "exception-cases", entityType: "exception_case", module: "procurement", label: "异常工单" },
  warehouse: { moduleId: "master-data:warehouses", entityType: "warehouse", module: "masterData", label: "仓库" },
  bin: { moduleId: "master-data:warehouses", entityType: "bin", module: "masterData", label: "库位" },
  forecast_plan: { moduleId: "forecast:demand", entityType: "forecast_plan", module: "planning", label: "Forecast" },
  mrp_plan: { moduleId: "forecast:mrp", entityType: "mrp_plan", module: "planning", label: "MRP" },
  bom_source: { moduleId: "forecast:mrp", entityType: "bom_source", module: "planning", label: "BOM" },
  planning_source: { moduleId: "forecast:parameters", entityType: "planning_source", module: "planning", label: "Planning Source" },
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function safeRoute(value: unknown) {
  const route = text(value);
  if (!route || route.startsWith("//")) return "";
  return route.startsWith("/") || /^[a-z-]+(?:[:][a-z-]+)?$/i.test(route) ? route : "";
}

function readableLabel(raw: EvidenceLike, fallbackType = "evidence") {
  if (!raw || typeof raw !== "object") return text(raw) || fallbackType;
  return text(raw.label) || text(raw.summary) || text(raw.title) || text(raw.entityLabel) || text(raw.id) || text(raw.entityId) || fallbackType;
}

function moduleKind(moduleId = "", fallback: CanonicalEvidenceModule = "ai"): CanonicalEvidenceModule {
  if (moduleId.startsWith("procurement") || ["purchaseRequests", "purchasing", "rfq", "receiving"].includes(moduleId)) return "procurement";
  if (moduleId.startsWith("sales")) return "sales";
  if (moduleId.startsWith("inventory")) return "inventory";
  if (moduleId.startsWith("srm")) return "supplier";
  if (moduleId.startsWith("master-data")) return "masterData";
  if (moduleId.startsWith("overview")) return "todayCockpit";
  if (moduleId.startsWith("forecast")) return "planning";
  return fallback;
}

function targetForType(rawType = "") {
  const type = text(rawType);
  const document = PROCUREMENT_DOCUMENT_TYPES[type];
  if (document) return { ...document, module: "procurement" as CanonicalEvidenceModule };
  const entity = ENTITY_TARGETS[type];
  if (entity) return entity;
  return null;
}

export function splitNavigationId(active = "") {
  const [moduleId, viewId] = text(active).split(":");
  return { moduleId: moduleId || "overview", viewId };
}

export function navigationActiveId(moduleId = "overview", viewId?: string) {
  const safeModuleId = text(moduleId) || "overview";
  const safeViewId = text(viewId);
  return safeViewId ? `${safeModuleId}:${safeViewId}` : safeModuleId;
}

export function navigationIntentFromModule(moduleId = "overview", options: {
  focusTarget?: CanonicalFocusTarget | null;
  source?: string;
  returnTo?: string;
  entityLabel?: string;
} = {}): CanonicalNavigationIntent {
  const { moduleId: canonicalModuleId, viewId } = splitNavigationId(moduleId);
  return {
    moduleId: canonicalModuleId,
    viewId,
    activeId: navigationActiveId(canonicalModuleId, viewId),
    focusTarget: options.focusTarget || undefined,
    source: options.source,
    returnTo: options.returnTo,
    entityLabel: options.entityLabel,
  };
}

export function normalizeEvidenceLink(raw: EvidenceLike, options: {
  source?: string;
  fallbackModuleId?: string;
  fallbackType?: string;
  recovery?: unknown;
} = {}): CanonicalEvidenceLink | null {
  if (!raw) return null;
  const row = typeof raw === "object" ? raw : { label: raw };
  const documentType = text(row.documentType || row.type || options.fallbackType);
  const entityType = text(row.entityType || documentType);
  const entityId = text(row.entityId || row.id || row.documentId || row.sku);
  const moduleId = text(row.module || row.moduleId || options.fallbackModuleId);
  const target = targetForType(documentType || entityType);
  const normalizedEntityType = target?.entityType || entityType;
  const label = readableLabel(row, target?.label || normalizedEntityType || "evidence");
  const route = safeRoute(row.route || row.deepLink || moduleId);
  const canonicalModuleId = target?.moduleId || (route && !route.startsWith("/") ? route : moduleId);
  const clickable = Boolean(entityId && canonicalModuleId && normalizedEntityType);

  return {
    module: target?.module || moduleKind(moduleId, options.source === "todayCockpit" ? "todayCockpit" : "ai"),
    moduleId: canonicalModuleId || undefined,
    entityType: normalizedEntityType || "unknown",
    entityId,
    label,
    status: text(row.status),
    route,
    focusTarget: clickable ? { entityType: normalizedEntityType, entityId } : undefined,
    source: options.source,
    recovery: options.recovery,
    clickable,
  };
}

export function normalizeEvidenceLinks(items: unknown, options: Parameters<typeof normalizeEvidenceLink>[1] = {}) {
  const rows = Array.isArray(items) ? items : items ? [items] : [];
  return rows
    .map((item) => normalizeEvidenceLink(item as EvidenceLike, options))
    .filter((item): item is CanonicalEvidenceLink => Boolean(item));
}

export function normalizeTodayCockpitTarget(item: EvidenceLike, options: { source?: string; recovery?: unknown } = {}) {
  if (!item || typeof item !== "object") return null;
  const target = typeof item.target === "object" && item.target ? item.target as Record<string, unknown> : {};
  const evidence = Array.isArray(item.evidence) ? item.evidence[0] as EvidenceLike : null;
  const documentType = text(target.documentType || item.documentType || item.type || evidence?.type);
  return normalizeEvidenceLink({
    ...evidence,
    ...target,
    type: documentType || evidence?.type,
    id: target.entityId || item.entityId || item.id || evidence?.id,
    label: item.title || evidence?.label || evidence?.summary || item.id,
    status: item.status || evidence?.status,
    route: item.route || evidence?.route || target.module,
  }, {
    source: options.source || "todayCockpit",
    fallbackModuleId: text(target.module || item.module),
    fallbackType: documentType,
    recovery: options.recovery,
  });
}

export function normalizeGlobalSearchResult(result: EvidenceLike) {
  if (!result || typeof result !== "object") return null;
  return normalizeEvidenceLink({
    type: result.entityType || result.type,
    entityType: result.entityType || result.type,
    entityId: result.entityId,
    label: result.entityLabel || result.label,
    status: result.status,
    route: result.moduleId || result.deepLink,
    module: result.moduleId,
  }, { source: "globalSearch", fallbackModuleId: text(result.moduleId) });
}

export function evidenceModuleId(link: CanonicalEvidenceLink | null) {
  if (!link?.clickable) return "";
  if (link.moduleId) return link.moduleId;
  if (!link.route || link.route.startsWith("/")) return "";
  return link.route;
}

export function navigationIntentFromEvidenceLink(link: CanonicalEvidenceLink | null, options: {
  source?: string;
  returnTo?: string;
} = {}): CanonicalNavigationIntent | null {
  if (!link?.clickable) return null;
  const moduleId = evidenceModuleId(link);
  if (!moduleId) return null;
  return navigationIntentFromModule(moduleId, {
    focusTarget: link.focusTarget || undefined,
    source: options.source || link.source,
    returnTo: options.returnTo,
    entityLabel: link.label,
  });
}

export function navigationIntentFromGlobalSearchResult(result: EvidenceLike, options: {
  returnTo?: string;
} = {}) {
  const link = normalizeGlobalSearchResult(result);
  const fallbackModuleId = result && typeof result === "object" ? text(result.moduleId) : "";
  const fallbackFocus = result && typeof result === "object"
    ? {
        entityType: text(result.entityType || result.type),
        entityId: text(result.entityId),
      }
    : null;
  const intent = navigationIntentFromEvidenceLink(link, { source: "globalSearch", returnTo: options.returnTo });
  if (intent) return intent;
  return navigationIntentFromModule(fallbackModuleId || "overview", {
    focusTarget: fallbackFocus?.entityType && fallbackFocus.entityId ? fallbackFocus : undefined,
    source: "globalSearch",
    returnTo: options.returnTo,
    entityLabel: result && typeof result === "object" ? text(result.entityLabel || result.label) : "",
  });
}

const ACTION_VIEW_ALIASES: Record<string, string> = {
  "purchase-orders": "orders",
  "purchase-requests": "requests",
  rfqs: "rfq",
  items: "overview",
  item: "overview",
  suppliers: "master",
  supplier: "master",
  invoices: "invoices",
  payables: "payables",
  settlement: "settlement",
  reconciliation: "reconciliation",
};

const ACTION_FOCUS_PARAMS: Array<{ key: string; entityType: string }> = [
  { key: "poId", entityType: "purchase_order" },
  { key: "prId", entityType: "purchase_request" },
  { key: "rfqId", entityType: "rfq" },
  { key: "receivingId", entityType: "receiving_doc" },
  { key: "itemId", entityType: "inventory_item" },
  { key: "sku", entityType: "inventory_item" },
  { key: "supplierId", entityType: "supplier" },
  { key: "invoiceId", entityType: "supplier_invoice" },
];

function actionView(moduleId: string, view = "") {
  const normalized = text(view);
  if (!normalized) return "";
  const alias = ACTION_VIEW_ALIASES[normalized] || normalized;
  if (moduleId === "inventory" && alias === "overview") return "";
  return alias;
}

function actionFocus(params: URLSearchParams) {
  for (const param of ACTION_FOCUS_PARAMS) {
    const entityId = text(params.get(param.key));
    if (entityId) return { entityType: param.entityType, entityId };
  }
  return undefined;
}

function navigationIntentFromApiRoute(url: URL, options: { source?: string } = {}) {
  const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts[0] !== "api") return null;
  if (parts[1] === "procurement" && parts[2] === "documents") {
    const type = decodeURIComponent(parts[3] || "");
    const entityId = decodeURIComponent(parts[4] || "");
    const target = targetForType(type);
    if (target && entityId) {
      return navigationIntentFromModule(target.moduleId, {
        focusTarget: { entityType: target.entityType, entityId },
        source: options.source,
      });
    }
  }
  if (parts[1] === "inventory" && parts[2] === "items" && parts[3]) {
    return navigationIntentFromModule("inventory", {
      focusTarget: { entityType: "inventory_item", entityId: decodeURIComponent(parts[3]) },
      source: options.source,
    });
  }
  if (parts[1] === "inventory" && parts[2] === "exceptions") {
    return navigationIntentFromModule("inventory:exceptions", { source: options.source });
  }
  if (parts[1] === "inventory" && parts[2] === "movements") {
    return navigationIntentFromModule("inventory:movements", { source: options.source });
  }
  return null;
}

export function navigationIntentFromInternalTarget(target: unknown, options: {
  source?: string;
} = {}): CanonicalNavigationIntent | null {
  const value = text(target);
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(value, "https://flowchain.local");
  } catch {
    return null;
  }
  if (url.origin !== "https://flowchain.local") return null;
  const apiIntent = navigationIntentFromApiRoute(url, options);
  if (apiIntent) return apiIntent;
  const [pathModule = "overview"] = url.pathname.replace(/^\/+/, "").split("/");
  const baseModule = pathModule === "receiving" ? "procurement" : pathModule || "overview";
  const view = pathModule === "receiving" ? "receiving" : actionView(baseModule, url.searchParams.get("view") || "");
  return navigationIntentFromModule(navigationActiveId(baseModule, view), {
    focusTarget: actionFocus(url.searchParams),
    source: options.source,
  });
}
