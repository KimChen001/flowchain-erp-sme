import type {
  AppRouteDefinition,
  GovernedAppRouteDefinition,
  NavigationVisibility,
  RouteAuthorityMetadata,
  RouteClassification,
  RouteMaturity,
} from "./route-types";

const primaryNavigation: Record<
  string,
  { navigationOrder: number; navigationLabel: string }
> = {
  overview: { navigationOrder: 10, navigationLabel: "今日" },
  procurement: { navigationOrder: 20, navigationLabel: "采购" },
  "procurement:receiving": { navigationOrder: 30, navigationLabel: "收货" },
  inventory: { navigationOrder: 40, navigationLabel: "库存" },
  "master-data:suppliers": {
    navigationOrder: 50,
    navigationLabel: "供应商",
  },
  "master-data:items": { navigationOrder: 60, navigationLabel: "物料" },
  "universal-intake": { navigationOrder: 70, navigationLabel: "数据接入" },
  "review-actions": { navigationOrder: 80, navigationLabel: "复核队列" },
};

const primaryRouteIds = new Set(Object.keys(primaryNavigation));

const internalModules = new Set([
  "exception-cases",
  "collaboration-drafts",
  "audit-history",
  "pilot-readiness",
]);

const frozenRouteIds = new Set([
  "finance:reconciliation",
  "finance:bank-statements",
  "finance:bank-reconciliation",
  "finance:settlement",
  "finance:reconciliation-detail",
  "finance:settlement-detail",
]);

const procurementExtensionRoutes = new Set([
  "procurement:receiving:new",
  "procurement:receiving:edit",
  "procurement:invoices",
  "procurement:match",
  "procurement:returns",
]);

const inventoryExtensionPrefixes = [
  "inventory:operations",
  "inventory:returns",
  "inventory:return-",
  "inventory:quarantine",
  "inventory:adjustment",
  "inventory:count",
  "inventory:transfer",
];

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

function classificationFor(route: AppRouteDefinition): RouteClassification {
  if (route.moduleId === "imports") return "LEGACY";
  if (route.moduleId === "forecast" || frozenRouteIds.has(route.id))
    return "FROZEN";
  if (
    internalModules.has(route.moduleId) ||
    route.id === "settings:advanced"
  )
    return "INTERNAL";
  if (
    route.moduleId === "sales" ||
    route.moduleId === "finance" ||
    route.moduleId === "mobile-operations" ||
    procurementExtensionRoutes.has(route.id) ||
    inventoryExtensionPrefixes.some((prefix) => route.id.startsWith(prefix))
  )
    return "EXTENSION";
  return "CORE";
}

function capabilityFor(
  route: AppRouteDefinition,
  classification: RouteClassification,
) {
  if (route.capabilityId) return route.capabilityId;
  if (route.moduleId === "universal-intake") return "universal-intake";
  if (route.moduleId === "review-actions") return "review-actions";
  if (route.moduleId === "sales") return "sales";
  if (route.moduleId === "finance") return "finance";
  if (route.moduleId === "mobile-operations") return "mobile-operations";
  if (route.id.startsWith("inventory:returns")) return "return-request";
  if (route.id.startsWith("inventory:return-authorization"))
    return "return-authorization";
  if (route.id.startsWith("inventory:return-posting")) return "return-posting";
  if (route.id === "inventory:quarantine") return "quarantine-inventory";
  if (route.id.startsWith("inventory:adjustment"))
    return "inventory-adjustment-document";
  if (route.id.startsWith("inventory:count")) return "cycle-count";
  if (
    route.id.startsWith("inventory:transfer") ||
    route.id === "inventory:operations"
  )
    return "stock-transfer";
  if (route.id.startsWith("procurement:receiving:"))
    return "receiving-posting";
  if (route.id === "procurement:invoices") return "supplier-invoice";
  if (route.id === "procurement:match") return "three-way-match";
  if (route.id === "procurement:returns") return "return-request";
  if (classification === "FROZEN") return route.moduleId;
  return undefined;
}

function permissionFor(route: AppRouteDefinition) {
  if (route.moduleId === "sales")
    return route.id.includes("delivery") ||
      route.id.includes("shipment") ||
      route.id.includes("receipt")
      ? "shipment.read"
      : "sales_order.read";
  if (route.moduleId === "inventory") {
    if (route.id.includes("return")) return "returns.request.read";
    if (route.id.includes("quarantine")) return "returns.quarantine.read";
    if (route.id.includes("transfer")) return "inventory.transfer.read";
    if (route.id.includes("count")) return "inventory.count.read";
    if (route.id.includes("adjustment")) return "inventory.adjustment.read";
    return "inventory.balance.read";
  }
  if (route.moduleId === "procurement") {
    if (route.id.includes("receiving")) return "receiving.read";
    if (route.id.includes("invoice")) return "finance.supplier_invoice.read";
    if (route.id.includes("match")) return "finance.three_way_match.read";
    return "procurement.purchase_order.read";
  }
  if (route.moduleId === "finance") return "finance.overview.read";
  if (route.moduleId === "mobile-operations") return "mobile.tasks.read";
  if (route.moduleId === "universal-intake") return "intake.batch.read";
  if (route.moduleId === "settings") return "settings.workspace.read";
  if (route.moduleId === "audit-history") return "audit.read";
  return undefined;
}

function navigationFor(
  route: AppRouteDefinition,
  classification: RouteClassification,
): NavigationVisibility {
  if (primaryRouteIds.has(route.id)) return "PRIMARY";
  if (
    classification === "INTERNAL" ||
    classification === "FROZEN" ||
    classification === "LEGACY"
  )
    return "HIDDEN";
  if (route.pageType === "detail" || route.pageType === "create" || route.pageType === "edit")
    return "CONTEXTUAL";
  return "SECONDARY";
}

function maturityFor(classification: RouteClassification): RouteMaturity {
  if (classification === "EXTENSION") return "CAPABILITY_GATED";
  if (classification === "FROZEN") return "UNAVAILABLE";
  if (classification === "INTERNAL") return "INTERNAL_PREVIEW";
  if (classification === "LEGACY") return "RETIRED";
  return "AUTHORITATIVE";
}

function limitationFor(classification: RouteClassification) {
  if (classification === "EXTENSION")
    return "Available only when its explicit database capability is enabled.";
  if (classification === "FROZEN")
    return "No authoritative enabled product capability is claimed.";
  if (classification === "INTERNAL")
    return "Internal governance surface; excluded from normal SME navigation.";
  if (classification === "LEGACY")
    return "Retired compatibility entry; canonical replacement is Universal Intake.";
  return "Runtime authorization and tenant scope remain enforced by the API.";
}

export function authorityForRoute(
  route: AppRouteDefinition,
): RouteAuthorityMetadata {
  const classification = classificationFor(route);
  const requiredCapability = capabilityFor(route, classification);
  const requiredPermission = permissionFor(route);
  const maturity =
    route.moduleId === "universal-intake" || route.moduleId === "review-actions"
      ? "PREVIEW"
      : maturityFor(classification);
  const directAccessBehavior =
    classification === "LEGACY"
      ? "LEGACY_REDIRECT"
      : classification === "FROZEN"
        ? "FROZEN_UNAVAILABLE"
        : classification === "INTERNAL"
          ? "INTERNAL_ONLY"
          : requiredCapability
            ? "CAPABILITY_REQUIRED"
            : requiredPermission
              ? "PERMISSION_REQUIRED"
              : "RENDER";

  return {
    classification,
    navigationVisibility: navigationFor(route, classification),
    ...primaryNavigation[route.id],
    directAccessBehavior,
    owner: ownerByModule[route.moduleId] || "src/app/FlowChainApp.tsx",
    businessObject: route.entityType || route.moduleId,
    apiDependency: apiByModule[route.moduleId],
    repositoryAuthority:
      classification === "LEGACY"
        ? "Retired legacy route"
        : classification === "FROZEN"
          ? "Capability gate"
          : classification === "INTERNAL"
            ? "Internal preview boundary"
            : "Tenant-scoped PostgreSQL repositories",
    readMaturity: maturity,
    writeMaturity:
      classification === "CORE" && maturity === "AUTHORITATIVE"
        ? "AUTHORITATIVE"
        : maturity,
    requiredCapability,
    requiredPermission,
    canonicalReplacement:
      classification === "LEGACY" ? "universal-intake" : undefined,
    knownLimitations: limitationFor(classification),
  };
}

export function buildRouteManifest(
  routes: AppRouteDefinition[],
): GovernedAppRouteDefinition[] {
  return routes.map((route) => {
    const authority = authorityForRoute(route);
    return Object.freeze({
      ...route,
      ...authority,
      capabilityId: route.capabilityId || authority.requiredCapability,
    });
  });
}
