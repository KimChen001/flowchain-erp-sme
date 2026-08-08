import type {
  AppRouteDefinition,
  GovernedAppRouteDefinition,
  NavigationVisibility,
  RouteAuthorityMetadata,
  RouteClassification,
  RouteMaturity,
} from "./route-types";

const ids = (value: string) =>
  new Set(value.trim().split(/\s+/).filter(Boolean));

export const routeClassificationIds: Record<RouteClassification, Set<string>> = {
  CORE: ids(`
    overview overview:risks overview:ai
    master-data master-data:items master-data:suppliers master-data:customers
    master-data:warehouses master-data:bins master-data:payment-terms
    master-data:tax-codes master-data:print-templates
    master-data:supplier-detail master-data:item-detail
    master-data:customer-detail master-data:warehouse-detail
    master-data:bin-detail master-data:payment-term-detail
    master-data:tax-code-detail
    procurement procurement:workbench procurement:requests procurement:rfq
    procurement:orders procurement:receiving procurement:order-lines procurement:invoices
    procurement:match procurement:request-detail
    procurement:rfq-detail procurement:order-detail
    procurement:receiving-detail procurement:invoice-detail
    procurement:match-detail
    inventory inventory:stock inventory:movements inventory:warnings
    inventory:lots inventory:serials inventory:bins inventory:exceptions
    sales sales:orders sales:risks sales:evidence sales:order-detail
    reports reports:overview reports:procurement reports:sales
    reports:inventory reports:finance reports:suppliers reports:library
    settings settings:profile settings:warehouse-access settings:readiness
    settings:company settings:roles settings:numbering settings:review
    settings:modules settings:ai settings:audit
  `),
  EXTENSION: ids(`
    procurement:receiving:new procurement:receiving:edit procurement:returns
    sales:order-new sales:delivery sales:delivery:new
    sales:delivery:edit sales:receipts sales:receipts:new sales:returns
    sales:returns:new sales:shipment-detail sales:delivery-detail
    sales:receipt-detail
    inventory:operations inventory:returns inventory:return-requests
    inventory:return-request-new inventory:return-request-detail
    inventory:return-authorizations inventory:return-authorization-detail
    inventory:return-postings inventory:return-posting-detail
    inventory:quarantine inventory:adjustments inventory:adjustments:new
    inventory:adjustment-detail inventory:count inventory:count:new
    inventory:count-detail inventory:transfer inventory:transfer:new
    inventory:transfer-detail
    finance finance:overview finance:invoices finance:payables
    finance:customer-invoices finance:receivables finance:aging
    finance:customer-credit-notes finance:credits finance:reconciliation
    finance:bank-statements finance:bank-reconciliation finance:settlement
    finance:three-way-match finance:invoice-detail
    finance:customer-invoice-new finance:customer-invoice-detail
    finance:match-detail finance:reconciliation-detail
    finance:settlement-detail finance:credit-memo-detail
    mobile-operations mobile-operations:tasks mobile-operations:receiving
    mobile-operations:task mobile-operations:po-detail
    mobile-operations:receiving-detail mobile-operations:settlement-detail
    settings:custom-fields
    universal-intake review-actions review-actions:waiting
    review-actions:data-limited
  `),
  INTERNAL: ids(`
    settings:advanced
    exception-cases exception-cases:open exception-cases:review
    collaboration-drafts collaboration-drafts:review
    collaboration-drafts:limited
    audit-history audit-history:ai audit-history:drafts audit-history:data
    audit-history:objects
    pilot-readiness pilot-readiness:modules pilot-readiness:data
    pilot-readiness:ai pilot-readiness:governance
    pilot-readiness:checklist
  `),
  FROZEN: ids(`
    procurement:contracts
    forecast forecast:cockpit forecast:demand forecast:mrp
    forecast:replenishment forecast:parameters
  `),
  LEGACY: ids(`
    imports imports:pilot imports:templates imports:validation imports:failed
  `),
};

const classificationById = new Map<string, RouteClassification>();
for (const [classification, routeIds] of Object.entries(
  routeClassificationIds,
) as Array<[RouteClassification, Set<string>]>) {
  for (const routeId of routeIds) {
    if (classificationById.has(routeId))
      throw new Error(`route has multiple classifications: ${routeId}`);
    classificationById.set(routeId, classification);
  }
}

const primaryNavigation: Record<
  string,
  { navigationOrder: number; navigationLabel: string }
> = {
  overview: { navigationOrder: 10, navigationLabel: "今日" },
  procurement: { navigationOrder: 20, navigationLabel: "采购" },
  "procurement:receiving": {
    navigationOrder: 30,
    navigationLabel: "采购履约",
  },
  inventory: { navigationOrder: 40, navigationLabel: "库存" },
  sales: { navigationOrder: 50, navigationLabel: "销售" },
  "master-data:suppliers": {
    navigationOrder: 60,
    navigationLabel: "供应商",
  },
  "master-data:items": { navigationOrder: 70, navigationLabel: "物料" },
  reports: { navigationOrder: 80, navigationLabel: "报表" },
  "universal-intake": { navigationOrder: 90, navigationLabel: "数据接入" },
  "review-actions": { navigationOrder: 100, navigationLabel: "复核队列" },
};

const compatibilityRouteIds = ids(`
  finance:reconciliation finance:reconciliation-detail
  finance:settlement finance:settlement-detail
  finance:bank-statements finance:bank-reconciliation
`);

const authoritativeWriteRouteIds = ids(`
  master-data master-data:items master-data:suppliers master-data:customers
  master-data:warehouses master-data:payment-terms master-data:tax-codes
  master-data:supplier-detail master-data:item-detail
  master-data:customer-detail master-data:warehouse-detail
  master-data:payment-term-detail master-data:tax-code-detail
  procurement:requests procurement:request-detail
  procurement:orders procurement:order-detail
  settings settings:profile settings:warehouse-access settings:company
  settings:roles settings:numbering settings:review settings:modules
  settings:ai
`);

const ownerByModule: Record<string, string> = {
  overview: "src/modules/overview",
  "master-data": "src/modules/master-data",
  procurement: "src/modules/procurement",
  sales: "src/modules/sales",
  inventory: "src/modules/inventory",
  finance: "src/modules/finance",
  "mobile-operations": "src/modules/mobile",
  reports: "src/modules/reports",
  settings: "src/modules/settings",
  forecast: "src/modules/forecast",
  imports: "src/modules/imports",
  "universal-intake": "src/modules/intake",
  "exception-cases": "src/modules/exception-cases",
  "collaboration-drafts": "src/modules/collaboration-drafts",
  "review-actions": "src/modules/action-drafts",
  "audit-history": "src/modules/audit-history",
  "pilot-readiness": "src/modules/pilot-readiness",
};

const apiByModule: Record<string, string> = {
  overview: "/api/business-read-context",
  "master-data": "/api/master-data/*",
  procurement: "/api/procurement/*",
  sales: "/api/sales-orders/*",
  inventory: "/api/inventory-*",
  finance: "/api/operational-finance/*",
  "mobile-operations": "/api/mobile/*",
  reports: "/api/reports/*",
  settings: "/api/settings/*",
  forecast: "/api/forecast-plans, /api/mrp-plan",
  imports: "retired legacy import APIs",
  "universal-intake": "/api/intake/*",
  "exception-cases": "/api/exception-cases",
  "collaboration-drafts": "transient draft preview",
  "review-actions": "/api/action-drafts",
  "audit-history": "/api/audit-log",
  "pilot-readiness": "/api/pilot-readiness",
};

const routeCapability = new Map<string, string>();
export function assignUniquePolicy(
  map: Map<string, string>,
  routeId: string,
  value: string,
  policyName: string,
) {
  const existing = map.get(routeId);
  if (existing !== undefined && existing !== value) {
    throw new Error(
      `${policyName} conflict for ${routeId}: ${existing} vs ${value}`,
    );
  }
  map.set(routeId, value);
}

const mapCapability = (capability: string, routeIds: string) => {
  for (const routeId of ids(routeIds))
    assignUniquePolicy(routeCapability, routeId, capability, "capability policy");
};
mapCapability(
  "sales",
  "sales sales:orders sales:risks sales:evidence sales:order-detail",
);
mapCapability(
  "stock-transfer",
  "inventory:operations inventory:transfer inventory:transfer:new inventory:transfer-detail",
);
mapCapability(
  "inventory-adjustment-document",
  "inventory:adjustments inventory:adjustments:new inventory:adjustment-detail",
);
mapCapability(
  "cycle-count",
  "inventory:count inventory:count:new inventory:count-detail",
);
mapCapability(
  "return-request",
  "inventory:returns inventory:return-requests inventory:return-request-new inventory:return-request-detail procurement:returns sales:returns sales:returns:new",
);
mapCapability(
  "return-authorization",
  "inventory:return-authorizations inventory:return-authorization-detail",
);
mapCapability(
  "return-posting",
  "inventory:return-postings inventory:return-posting-detail",
);
mapCapability("quarantine-inventory", "inventory:quarantine");
mapCapability(
  "receiving-posting",
  "procurement:receiving:new procurement:receiving:edit",
);
mapCapability(
  "supplier-invoice",
  "finance:invoices finance:invoice-detail",
);
mapCapability(
  "three-way-match",
  "finance:three-way-match finance:match-detail",
);
mapCapability("payable-obligation", "finance:payables");
mapCapability(
  "customer-invoice",
  "finance:customer-invoices finance:customer-invoice-new finance:customer-invoice-detail",
);
mapCapability("receivable-obligation", "finance:receivables finance:aging");
mapCapability("customer-credit-note", "finance:customer-credit-notes");
mapCapability(
  "supplier-credit-memo",
  "finance:credits finance:credit-memo-detail",
);
mapCapability(
  "cashbook",
  "finance:reconciliation finance:reconciliation-detail",
);
mapCapability(
  "internal-settlement",
  "finance:settlement finance:settlement-detail",
);
mapCapability(
  "bank-statement-reconciliation",
  "finance:bank-statements finance:bank-reconciliation",
);
mapCapability("finance", "finance finance:overview");
mapCapability(
  "mobile-operations",
  "mobile-operations mobile-operations:tasks mobile-operations:receiving mobile-operations:task mobile-operations:po-detail mobile-operations:receiving-detail mobile-operations:settlement-detail",
);
mapCapability("universal-intake", "universal-intake settings:custom-fields");
mapCapability(
  "review-actions",
  "review-actions review-actions:waiting review-actions:data-limited",
);

const routePermission = new Map<string, string>();
const mapPermission = (permission: string, routeIds: string) => {
  for (const routeId of ids(routeIds))
    assignUniquePolicy(routePermission, routeId, permission, "permission policy");
};
mapPermission(
  "procurement.purchase_order.read",
  "procurement procurement:workbench procurement:orders procurement:order-lines procurement:order-detail",
);
mapPermission(
  "receiving.read",
  "procurement:receiving procurement:receiving:new procurement:receiving:edit procurement:receiving-detail",
);
mapPermission(
  "finance.supplier_invoice.read",
  "procurement:invoices procurement:invoice-detail finance:invoices finance:invoice-detail",
);
mapPermission(
  "finance.three_way_match.read",
  "procurement:match procurement:match-detail finance:three-way-match finance:match-detail",
);
mapPermission("returns.request.read", "procurement:returns");
mapPermission(
  "inventory.balance.read",
  "inventory inventory:stock inventory:movements inventory:warnings inventory:lots inventory:serials inventory:bins inventory:exceptions inventory:operations",
);
mapPermission(
  "inventory.transfer.read",
  "inventory:transfer inventory:transfer:new inventory:transfer-detail",
);
mapPermission(
  "inventory.count.read",
  "inventory:count inventory:count:new inventory:count-detail",
);
mapPermission(
  "inventory.adjustment.read",
  "inventory:adjustments inventory:adjustments:new inventory:adjustment-detail",
);
mapPermission(
  "returns.request.read",
  "inventory:returns inventory:return-requests inventory:return-request-new inventory:return-request-detail sales:returns sales:returns:new",
);
mapPermission(
  "returns.authorization.read",
  "inventory:return-authorizations inventory:return-authorization-detail",
);
mapPermission(
  "returns.posting.read",
  "inventory:return-postings inventory:return-posting-detail",
);
mapPermission("returns.quarantine.read", "inventory:quarantine");
mapPermission(
  "sales_order.read",
  "sales sales:orders sales:order-new sales:risks sales:evidence sales:order-detail",
);
mapPermission(
  "shipment.read",
  "sales:delivery sales:delivery:new sales:delivery:edit sales:receipts sales:receipts:new sales:shipment-detail sales:delivery-detail sales:receipt-detail",
);
mapPermission("finance.overview.read", "finance finance:overview");
mapPermission("finance.payable.read", "finance:payables");
mapPermission(
  "finance.customer_invoice.read",
  "finance:customer-invoices finance:customer-invoice-new finance:customer-invoice-detail",
);
mapPermission("finance.receivable.read", "finance:receivables finance:aging");
mapPermission("finance.customer_credit.read", "finance:customer-credit-notes");
mapPermission(
  "finance.supplier_credit.read",
  "finance:credits finance:credit-memo-detail",
);
mapPermission(
  "finance.cashbook.read",
  "finance:reconciliation finance:reconciliation-detail",
);
mapPermission(
  "finance.settlement.read",
  "finance:settlement finance:settlement-detail",
);
mapPermission("finance.bank_statement.read", "finance:bank-statements");
mapPermission(
  "finance.bank_reconciliation.read",
  "finance:bank-reconciliation",
);
mapPermission(
  "mobile.tasks.read",
  "mobile-operations mobile-operations:tasks mobile-operations:task mobile-operations:po-detail mobile-operations:settlement-detail",
);
mapPermission(
  "mobile.receiving.read",
  "mobile-operations:receiving mobile-operations:receiving-detail",
);
mapPermission("intake.batch.read", "universal-intake");
mapPermission(
  "settings.workspace.read",
  "settings settings:profile settings:warehouse-access settings:company settings:ai",
);
mapPermission("settings.diagnostics.read", "settings:readiness settings:advanced");
mapPermission("settings.roles.read", "settings:roles");
mapPermission("settings.numbering.read", "settings:numbering");
mapPermission("custom_field.read", "settings:custom-fields");
mapPermission("settings.review_policy.read", "settings:review");
mapPermission("settings.modules.read", "settings:modules");
mapPermission("audit.read", "settings:audit audit-history audit-history:ai audit-history:drafts audit-history:data audit-history:objects");

export function classificationForRouteId(routeId: string) {
  return classificationById.get(routeId);
}

function capabilityFor(route: AppRouteDefinition) {
  const governedCapability = routeCapability.get(route.id);
  if (
    governedCapability &&
    route.capabilityId &&
    governedCapability !== route.capabilityId
  ) {
    throw new Error(
      `route capability drift for ${route.id}: ${route.capabilityId} vs ${governedCapability}`,
    );
  }
  return governedCapability || route.capabilityId;
}

function permissionFor(route: AppRouteDefinition) {
  return routePermission.get(route.id);
}

function navigationFor(
  route: AppRouteDefinition,
  classification: RouteClassification,
): NavigationVisibility {
  if (compatibilityRouteIds.has(route.id)) return "HIDDEN";
  if (primaryNavigation[route.id]) return "PRIMARY";
  if (["INTERNAL", "FROZEN", "LEGACY"].includes(classification))
    return "HIDDEN";
  if (
    route.pageType === "detail" ||
    route.pageType === "create" ||
    route.pageType === "edit"
  )
    return "CONTEXTUAL";
  return "SECONDARY";
}

function readMaturityFor(
  route: AppRouteDefinition,
  classification: RouteClassification,
): RouteMaturity {
  if (classification === "EXTENSION") {
    if (route.moduleId === "universal-intake" || route.moduleId === "review-actions")
      return "PREVIEW";
    return "CAPABILITY_GATED";
  }
  if (classification === "FROZEN") return "UNAVAILABLE";
  if (classification === "INTERNAL") return "INTERNAL_PREVIEW";
  if (classification === "LEGACY") return "RETIRED";
  return "AUTHORITATIVE";
}

function writeMaturityFor(
  route: AppRouteDefinition,
  classification: RouteClassification,
): RouteMaturity {
  if (route.id === "procurement:rfq-detail") return "UNAVAILABLE";
  if (classification === "EXTENSION") {
    if (route.moduleId === "universal-intake" || route.moduleId === "review-actions")
      return "PREVIEW";
    return "CAPABILITY_GATED";
  }
  if (classification === "FROZEN") return "UNAVAILABLE";
  if (classification === "INTERNAL") return "INTERNAL_PREVIEW";
  if (classification === "LEGACY") return "RETIRED";
  return authoritativeWriteRouteIds.has(route.id)
    ? "AUTHORITATIVE"
    : "UNAVAILABLE";
}

function directAccessFor(
  route: AppRouteDefinition,
  classification: RouteClassification,
  requiredCapability?: string,
  requiredPermission?: string,
) {
  if (route.id === "imports") return "LEGACY_REDIRECT" as const;
  if (classification === "LEGACY") return "LEGACY_UNAVAILABLE" as const;
  if (classification === "FROZEN") return "FROZEN_UNAVAILABLE" as const;
  if (classification === "INTERNAL") return "INTERNAL_ONLY" as const;
  if (requiredCapability) return "CAPABILITY_REQUIRED" as const;
  if (requiredPermission) return "PERMISSION_REQUIRED" as const;
  return "RENDER" as const;
}

function limitationFor(
  route: AppRouteDefinition,
  classification: RouteClassification,
) {
  if (route.id === "procurement:rfq-detail")
    return "只读展示当前租户的 RFQ、行项目、参与记录、最大 revisionNumber 报价和明确证据关系；内部 response/revision command 与 Comparison read contract 不在此 UI 路由内。";
  if (compatibilityRouteIds.has(route.id))
    return "Compatibility extension; not part of the default SME Core surface.";
  if (route.id === "imports")
    return "Retired legacy root; redirects exactly to Universal Intake.";
  if (classification === "LEGACY")
    return "Retired legacy route; no one-to-one Universal Intake replacement exists.";
  if (classification === "EXTENSION")
    return "Available only when its exact capability and permission are enabled.";
  if (classification === "FROZEN")
    return "No authoritative enabled product capability is claimed.";
  if (classification === "INTERNAL")
    return "Internal governance surface; excluded from normal SME navigation.";
  if (
    route.id.startsWith("procurement:requests") ||
    route.id.startsWith("procurement:rfq")
  )
    return "No dedicated frontend read permission exists; backend tenant and authorization checks remain authoritative.";
  return "Runtime authorization and tenant scope remain enforced by the API.";
}

export function authorityForRoute(
  route: AppRouteDefinition,
): RouteAuthorityMetadata {
  const classification = classificationForRouteId(route.id);
  if (!classification) throw new Error(`unclassified route: ${route.id}`);
  const requiredCapability = capabilityFor(route);
  const requiredPermission = permissionFor(route);

  return {
    classification,
    navigationVisibility: navigationFor(route, classification),
    ...primaryNavigation[route.id],
    directAccessBehavior: directAccessFor(
      route,
      classification,
      requiredCapability,
      requiredPermission,
    ),
    owner: ownerByModule[route.moduleId] || "src/app/FlowChainApp.tsx",
    businessObject: route.entityType || route.moduleId,
    apiDependency:
      route.id === "procurement:rfq"
        ? "/api/procurement/documents?type=rfq"
        : route.id === "procurement:rfq-detail"
          ? "/api/procurement/documents/rfq/:id"
          : apiByModule[route.moduleId],
    repositoryAuthority:
      classification === "LEGACY"
        ? "Retired legacy route"
        : route.id === "procurement:rfq-detail"
          ? "Tenant-scoped PostgreSQL direct document repository"
          : classification === "FROZEN"
            ? "Capability or direct-route boundary"
          : classification === "INTERNAL"
            ? "Internal preview boundary"
            : "Tenant-scoped PostgreSQL repositories",
    readMaturity: readMaturityFor(route, classification),
    writeMaturity: writeMaturityFor(route, classification),
    requiredCapability,
    requiredPermission,
    compatibilityOnly: compatibilityRouteIds.has(route.id) || undefined,
    canonicalReplacement: route.id === "imports" ? "universal-intake" : undefined,
    knownLimitations: limitationFor(route, classification),
  };
}

export function buildRouteManifest(
  routes: AppRouteDefinition[],
): GovernedAppRouteDefinition[] {
  const declaredIds = new Set(routes.map((route) => route.id));
  validateRoutePolicyReferences(declaredIds);
  for (const route of routes) {
    if (!classificationById.has(route.id))
      throw new Error(`unclassified route: ${route.id}`);
  }
  return routes.map((route) =>
    Object.freeze({
      ...route,
      ...authorityForRoute(route),
    }),
  );
}

type RoutePolicyReferences = Partial<
  Record<
    | "classification policy"
    | "capability policy"
    | "permission policy"
    | "primary navigation"
    | "compatibility policy"
    | "authoritative write policy",
    Iterable<string>
  >
>;

export function validateRoutePolicyReferences(
  declaredIds: Set<string>,
  references: RoutePolicyReferences = {
    "classification policy": classificationById.keys(),
    "capability policy": routeCapability.keys(),
    "permission policy": routePermission.keys(),
    "primary navigation": Object.keys(primaryNavigation),
    "compatibility policy": compatibilityRouteIds,
    "authoritative write policy": authoritativeWriteRouteIds,
  },
) {
  for (const [policyName, policyIds] of Object.entries(references)) {
    for (const routeId of policyIds || []) {
      if (!declaredIds.has(routeId)) {
        throw new Error(`${policyName} references nonexistent route: ${routeId}`);
      }
    }
  }
}
