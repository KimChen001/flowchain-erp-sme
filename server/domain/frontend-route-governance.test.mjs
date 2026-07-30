import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { permissionCodeSet } from "../auth/permission-catalog.mjs";

let vite;
let routes;
let registry;
let invariants;
let manifest;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  registry = await vite.ssrLoadModule("/src/app/routeRegistry.tsx");
  invariants = await vite.ssrLoadModule("/src/app/routes/route-invariants.ts");
  manifest = await vite.ssrLoadModule("/src/app/routes/route-manifest.ts");
  routes = registry.appRouteRegistry;
});

after(async () => {
  await vite?.close();
});

test("frontend route manifest satisfies authority invariants", () => {
  assert.equal(routes.length, 159);
  assert.deepEqual(
    invariants.validateRouteManifest(routes, { permissionCatalog: permissionCodeSet }),
    [],
  );
  assert.equal(new Set(routes.map((route) => route.id)).size, routes.length);
  assert.equal(new Set(routes.map((route) => route.path)).size, routes.length);
  assert.ok(routes.every((route) => route.owner));
  assert.ok(routes.every((route) => route.directAccessBehavior));
});

test("route classification is explicit, exhaustive, and fail closed", () => {
  assert.equal(
    [...Object.values(manifest.routeClassificationIds)].reduce(
      (total, routeIds) => total + routeIds.size,
      0,
    ),
    159,
  );
  assert.throws(
    () =>
      manifest.authorityForRoute({
        id: "forgotten:new-route",
        path: "/app/forgotten",
        moduleId: "forgotten",
        moduleLabel: "Forgotten",
        label: "Forgotten",
        order: 999,
      }),
    /unclassified route: forgotten:new-route/,
  );
  assert.throws(
    () => manifest.buildRouteManifest(routes.filter((route) => route.id !== "overview:ai")),
    /route policy references nonexistent route: overview:ai/,
  );
});

test("normal SME navigation is deterministic and excludes non-product surfaces", () => {
  const first = invariants.primaryNavigationRoutes(routes);
  const second = invariants.primaryNavigationRoutes(routes);
  assert.deepEqual(
    first.map((route) => route.id),
    [
      "overview",
      "procurement",
      "procurement:receiving",
      "inventory",
      "master-data:suppliers",
      "master-data:items",
      "universal-intake",
      "review-actions",
    ],
  );
  assert.deepEqual(
    second.map((route) => route.id),
    first.map((route) => route.id),
  );
  assert.ok(
    first.every(
      (route) =>
        !["LEGACY", "INTERNAL", "FROZEN"].includes(route.classification),
    ),
  );
  for (const route of first.filter((candidate) => !candidate.parentId)) {
    const hasChild = routes.some((candidate) => candidate.parentId === route.id);
    if (!hasChild) continue;
    assert.equal(route.entryBehavior, "redirect-to-default-child");
    assert.notEqual(route.defaultChildId, route.id);
  }
});

test("capability and permission metadata remain declarative boundaries", () => {
  const extensions = routes.filter(
    (route) => route.classification === "EXTENSION",
  );
  assert.ok(extensions.length > 0);
  assert.ok(extensions.every((route) => route.requiredCapability));

  const procurement = routes.find((route) => route.id === "procurement");
  assert.equal(procurement.requiredPermission, "procurement.purchase_order.read");
  assert.ok(
    invariants
      .primaryNavigationRoutes(routes)
      .some((route) => route.id === procurement.id),
    "navigation metadata must not impersonate runtime authorization",
  );
  for (const [id, capability] of [
    ["finance:reconciliation", "cashbook"],
    ["finance:settlement", "internal-settlement"],
    ["finance:bank-statements", "bank-statement-reconciliation"],
    ["finance:bank-reconciliation", "bank-statement-reconciliation"],
  ]) {
    const route = routes.find((candidate) => candidate.id === id);
    assert.equal(route.classification, "EXTENSION", id);
    assert.equal(route.requiredCapability, capability, id);
  }
  assert.equal(
    routes.find((route) => route.id === "procurement:invoices").requiredPermission,
    "finance.supplier_invoice.read",
  );
  assert.equal(
    routes.find((route) => route.id === "inventory:transfer").requiredPermission,
    "inventory.transfer.read",
  );
  assert.equal(
    routes.find((route) => route.id === "finance:bank-statements").requiredPermission,
    "finance.bank_statement.read",
  );
});

test("hidden and searchable route projections respect classifications", () => {
  assert.ok(
    routes
      .filter((route) => ["FROZEN", "INTERNAL"].includes(route.classification))
      .every((route) => route.navigationVisibility === "HIDDEN"),
  );
  assert.ok(
    invariants
      .searchableRouteManifest(routes)
      .every(
        (route) =>
          !["FROZEN", "INTERNAL", "LEGACY"].includes(route.classification),
      ),
  );
  assert.ok(
    routes
      .filter((route) => route.compatibilityOnly)
      .every(
        (route) =>
          route.classification === "EXTENSION" &&
          route.navigationVisibility === "HIDDEN" &&
          route.requiredCapability &&
          route.requiredPermission,
      ),
  );
});

test("legacy redirects and canonical operational deep links remain exact", () => {
  const byId = (id) => routes.find((route) => route.id === id);
  for (const route of routes.filter(
    (candidate) => candidate.directAccessBehavior === "LEGACY_REDIRECT",
  )) {
    assert.ok(byId(route.canonicalReplacement));
  }
  assert.equal(byId("imports").canonicalReplacement, "universal-intake");
  for (const id of [
    "imports:pilot",
    "imports:templates",
    "imports:validation",
    "imports:failed",
  ]) {
    assert.equal(byId(id).directAccessBehavior, "LEGACY_UNAVAILABLE");
    assert.equal(byId(id).canonicalReplacement, undefined);
  }
  assert.equal(
    byId("procurement:rfq-detail").directAccessBehavior,
    "NOT_IMPLEMENTED",
  );
  assert.equal(byId("procurement:rfq-detail").readMaturity, "UNAVAILABLE");
  assert.equal(byId("procurement:rfq-detail").writeMaturity, "UNAVAILABLE");
  assert.equal(
    byId("procurement:order-detail").path,
    "/app/procurement/orders/:id",
  );
  assert.equal(
    byId("procurement:receiving-detail").path,
    "/app/procurement/receiving/:id",
  );
  assert.equal(registry.routeByPath("/app/procurement/orders/PO-002").id, "procurement:order-detail");
  assert.equal(
    registry.routeByPath("/app/procurement/receiving/GRN-001").id,
    "procurement:receiving-detail",
  );
});

test("read and write maturity are independent from CORE classification", () => {
  const byId = (id) => routes.find((route) => route.id === id);
  for (const id of [
    "overview",
    "overview:risks",
    "procurement:rfq",
    "procurement:receiving",
    "inventory:stock",
  ]) {
    assert.equal(byId(id).readMaturity, "AUTHORITATIVE", id);
    assert.equal(byId(id).writeMaturity, "UNAVAILABLE", id);
  }
  assert.equal(byId("procurement:requests").writeMaturity, "AUTHORITATIVE");
  assert.ok(
    routes
      .filter((route) => route.classification === "FROZEN")
      .every(
        (route) =>
          route.readMaturity === "UNAVAILABLE" &&
          route.writeMaturity === "UNAVAILABLE",
      ),
  );
});

test("runtime access helpers fail closed for exact capabilities and permissions", () => {
  const bank = routes.find((route) => route.id === "finance:bank-statements");
  const access = {
    capabilityLoadState: "ready",
    enabledCapabilityIds: new Set(["bank-statement-reconciliation"]),
    authorizationLoadState: "ready",
    effectivePermissionCodes: new Set(["finance.overview.read"]),
  };
  assert.equal(invariants.isRouteCapabilityEnabled(bank, access), true);
  assert.equal(invariants.isRoutePermissionEnabled(bank, access), false);
  assert.equal(
    invariants.isRouteVisibleInNavigation(bank, "SECONDARY", access),
    false,
  );
  assert.equal(
    invariants.isRouteCapabilityEnabled(bank, {
      ...access,
      capabilityLoadState: "failed",
    }),
    false,
  );
});

test("human-readable route authority matrix covers the executable manifest", () => {
  const matrix = readFileSync(
    new URL("../../docs/frontend-route-authority-matrix.md", import.meta.url),
    "utf8",
  );
  const cell = (value) =>
    String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const route of routes) {
    const expected = `| \`${cell(route.id)}\` | \`${cell(route.path)}\` | ${cell(route.label)} | \`${cell(route.moduleId)}\` | ${cell(route.classification)} | ${cell(route.navigationVisibility)} | ${route.compatibilityOnly ? "yes" : "no"} | ${cell(route.businessObject)} | \`${cell(route.owner)}\` | ${cell(route.apiDependency)} | ${cell(route.repositoryAuthority)} | ${cell(route.readMaturity)} | ${cell(route.writeMaturity)} | ${cell(route.requiredCapability)} | ${cell(route.requiredPermission)} | ${cell(route.directAccessBehavior)} | ${cell(route.canonicalReplacement)} | ${cell(route.knownLimitations)} |`;
    assert.ok(matrix.includes(expected), route.id);
  }
  assert.match(matrix, /Default SME navigation/);
  assert.match(matrix, /159\/159 frontend route stability audit/);
});
