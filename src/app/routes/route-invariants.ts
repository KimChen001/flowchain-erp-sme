import {
  classificationForRouteId,
  routeClassificationIds,
} from "./route-manifest";
import type {
  GovernedAppRouteDefinition,
  NavigationVisibility,
} from "./route-types";

export type RouteRegistryLoadState = "loading" | "ready" | "failed";

export type GovernedRouteAccessContext = {
  capabilityLoadState: RouteRegistryLoadState;
  enabledCapabilityIds: Set<string> | null;
  authorizationLoadState: RouteRegistryLoadState;
  effectivePermissionCodes: Set<string>;
  moduleVisibility?: Record<
    string,
    {
      visible: boolean;
      permissionAllowed: boolean;
      capabilityAllowed: boolean;
    }
  >;
};

export function routeOrder(
  left: GovernedAppRouteDefinition,
  right: GovernedAppRouteDefinition,
) {
  return left.order - right.order || left.id.localeCompare(right.id);
}

export function orderedRouteManifest(routes: GovernedAppRouteDefinition[]) {
  return [...routes].sort(routeOrder);
}

export function primaryNavigationRoutes(
  routes: GovernedAppRouteDefinition[],
) {
  return routes
    .filter((route) => route.navigationVisibility === "PRIMARY")
    .sort(
      (left, right) =>
        (left.navigationOrder ?? left.order) -
          (right.navigationOrder ?? right.order) ||
        left.id.localeCompare(right.id),
    );
}

export function capabilityIdForRoute(route: GovernedAppRouteDefinition) {
  return route.requiredCapability;
}

export function hasRoutePermission(
  route: GovernedAppRouteDefinition,
  effectivePermissions: Set<string>,
) {
  return (
    !route.requiredPermission ||
    effectivePermissions.has(route.requiredPermission)
  );
}

export function isRouteCapabilityEnabled(
  route: GovernedAppRouteDefinition,
  access: Pick<
    GovernedRouteAccessContext,
    "capabilityLoadState" | "enabledCapabilityIds"
  >,
) {
  const capabilityId = capabilityIdForRoute(route);
  if (!capabilityId) return true;
  return (
    access.capabilityLoadState === "ready" &&
    access.enabledCapabilityIds?.has(capabilityId) === true
  );
}

export function isRoutePermissionEnabled(
  route: GovernedAppRouteDefinition,
  access: Pick<
    GovernedRouteAccessContext,
    "authorizationLoadState" | "effectivePermissionCodes"
  >,
) {
  if (!route.requiredPermission) return true;
  return (
    access.authorizationLoadState === "ready" &&
    hasRoutePermission(route, access.effectivePermissionCodes)
  );
}

export function isRouteVisibleInNavigation(
  route: GovernedAppRouteDefinition,
  expectedVisibility: NavigationVisibility,
  access: GovernedRouteAccessContext,
) {
  if (route.navigationVisibility !== expectedVisibility) return false;
  if (
    ["INTERNAL", "FROZEN", "LEGACY"].includes(route.classification) ||
    route.compatibilityOnly
  )
    return false;
  return (
    isRouteCapabilityEnabled(route, access) &&
    isRoutePermissionEnabled(route, access)
  );
}

export function searchableRouteManifest(
  routes: GovernedAppRouteDefinition[],
  access?: GovernedRouteAccessContext,
) {
  return orderedRouteManifest(routes).filter((route) => {
    if (route.path.includes(":")) return false;
    if (
      [
        "FROZEN_UNAVAILABLE",
        "INTERNAL_ONLY",
        "LEGACY_REDIRECT",
        "LEGACY_UNAVAILABLE",
        "NOT_IMPLEMENTED",
      ].includes(route.directAccessBehavior)
    )
      return false;
    if (
      ["INTERNAL", "FROZEN", "LEGACY"].includes(route.classification) ||
      route.compatibilityOnly
    )
      return false;
    if (!access) return true;
    return (
      isRouteCapabilityEnabled(route, access) &&
      isRoutePermissionEnabled(route, access)
    );
  });
}

export function validateRouteManifest(
  routes: GovernedAppRouteDefinition[],
  options: { permissionCatalog?: Set<string> } = {},
) {
  const issues: string[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  const policyIds = new Set<string>();

  for (const routeIds of Object.values(routeClassificationIds))
    for (const routeId of routeIds) {
      if (policyIds.has(routeId))
        issues.push(`route has multiple classifications: ${routeId}`);
      policyIds.add(routeId);
    }

  for (const route of routes) {
    if (ids.has(route.id)) issues.push(`duplicate route id: ${route.id}`);
    if (paths.has(route.path)) issues.push(`duplicate route path: ${route.path}`);
    ids.add(route.id);
    paths.add(route.path);

    const explicitClassification = classificationForRouteId(route.id);
    if (!explicitClassification) issues.push(`unclassified route: ${route.id}`);
    else if (explicitClassification !== route.classification)
      issues.push(`route classification drift: ${route.id}`);

    if (
      route.navigationVisibility === "PRIMARY" &&
      ["LEGACY", "INTERNAL", "FROZEN"].includes(route.classification)
    )
      issues.push(`invalid primary classification: ${route.id}`);
    if (route.classification === "EXTENSION" && !route.requiredCapability)
      issues.push(`extension route lacks capability: ${route.id}`);
    if (
      ["FROZEN", "INTERNAL"].includes(route.classification) &&
      route.navigationVisibility !== "HIDDEN"
    )
      issues.push(`hidden classification is visible: ${route.id}`);
    if (
      route.compatibilityOnly &&
      (route.classification !== "EXTENSION" ||
        route.navigationVisibility !== "HIDDEN")
    )
      issues.push(`invalid compatibility route exposure: ${route.id}`);
    if (!route.owner) issues.push(`route lacks owner: ${route.id}`);
    if (!route.directAccessBehavior)
      issues.push(`route lacks direct access behavior: ${route.id}`);
    if (
      route.requiredPermission &&
      options.permissionCatalog &&
      !options.permissionCatalog.has(route.requiredPermission)
    )
      issues.push(
        `route permission is not in catalog: ${route.id} -> ${route.requiredPermission}`,
      );
    if (
      route.directAccessBehavior === "LEGACY_REDIRECT" &&
      (!route.canonicalReplacement ||
        !routes.some(
          (candidate) => candidate.id === route.canonicalReplacement,
        ))
    )
      issues.push(`invalid legacy replacement: ${route.id}`);
    if (
      route.directAccessBehavior === "LEGACY_UNAVAILABLE" &&
      route.canonicalReplacement
    )
      issues.push(`legacy unavailable route has replacement: ${route.id}`);
    if (
      route.classification === "FROZEN" &&
      (route.readMaturity !== "UNAVAILABLE" ||
        route.writeMaturity !== "UNAVAILABLE")
    )
      issues.push(`frozen route has active maturity: ${route.id}`);
    if (
      route.classification === "LEGACY" &&
      (route.readMaturity !== "RETIRED" ||
        route.writeMaturity !== "RETIRED")
    )
      issues.push(`legacy route has active maturity: ${route.id}`);
    if (
      route.pageType === "list" &&
      route.writeMaturity === "AUTHORITATIVE" &&
      ![
        "master-data:items",
        "master-data:suppliers",
        "master-data:customers",
        "master-data:warehouses",
        "master-data:payment-terms",
        "master-data:tax-codes",
        "procurement:requests",
        "procurement:orders",
      ].includes(route.id)
    )
      issues.push(`read-only list claims authoritative write: ${route.id}`);
    if (
      route.navigationVisibility === "PRIMARY" &&
      !route.parentId &&
      routes.some((candidate) => candidate.parentId === route.id) &&
      (route.entryBehavior !== "redirect-to-default-child" ||
        !route.defaultChildId ||
        route.defaultChildId === route.id)
    )
      issues.push(`primary route has no canonical child entry: ${route.id}`);
  }

  for (const policyId of policyIds)
    if (!ids.has(policyId))
      issues.push(`route policy references nonexistent route: ${policyId}`);

  const redirectById = new Map(
    routes
      .filter((route) => route.directAccessBehavior === "LEGACY_REDIRECT")
      .map((route) => [route.id, route.canonicalReplacement!]),
  );
  for (const [routeId, replacement] of redirectById) {
    if (redirectById.has(replacement))
      issues.push(`legacy redirect targets legacy redirect: ${routeId}`);
    const seen = new Set([routeId]);
    let current: string | undefined = replacement;
    while (current && redirectById.has(current)) {
      if (seen.has(current)) {
        issues.push(`legacy redirect cycle: ${routeId}`);
        break;
      }
      seen.add(current);
      current = redirectById.get(current);
    }
  }

  return issues;
}
