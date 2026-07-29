import type { GovernedAppRouteDefinition } from "./route-types";

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

export function searchableRouteManifest(
  routes: GovernedAppRouteDefinition[],
) {
  return orderedRouteManifest(routes).filter(
    (route) =>
      route.classification !== "INTERNAL" &&
      route.classification !== "FROZEN" &&
      route.classification !== "LEGACY",
  );
}

export function validateRouteManifest(routes: GovernedAppRouteDefinition[]) {
  const issues: string[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();

  for (const route of routes) {
    if (ids.has(route.id)) issues.push(`duplicate route id: ${route.id}`);
    if (paths.has(route.path)) issues.push(`duplicate route path: ${route.path}`);
    ids.add(route.id);
    paths.add(route.path);

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
    if (!route.owner) issues.push(`route lacks owner: ${route.id}`);
    if (!route.directAccessBehavior)
      issues.push(`route lacks direct access behavior: ${route.id}`);
    if (
      route.directAccessBehavior === "LEGACY_REDIRECT" &&
      (!route.canonicalReplacement ||
        !routes.some((candidate) => candidate.id === route.canonicalReplacement))
    )
      issues.push(`invalid legacy replacement: ${route.id}`);
  }

  return issues;
}
