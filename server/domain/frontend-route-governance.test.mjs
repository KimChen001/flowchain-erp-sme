import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let routes;
let registry;
let invariants;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  registry = await vite.ssrLoadModule("/src/app/routeRegistry.tsx");
  invariants = await vite.ssrLoadModule("/src/app/routes/route-invariants.ts");
  routes = registry.appRouteRegistry;
});

after(async () => {
  await vite?.close();
});

test("frontend route manifest satisfies authority invariants", () => {
  assert.equal(routes.length, 159);
  assert.deepEqual(invariants.validateRouteManifest(routes), []);
  assert.equal(new Set(routes.map((route) => route.id)).size, routes.length);
  assert.equal(new Set(routes.map((route) => route.path)).size, routes.length);
  assert.ok(routes.every((route) => route.owner));
  assert.ok(routes.every((route) => route.directAccessBehavior));
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
});

test("legacy redirects and canonical operational deep links remain exact", () => {
  const byId = (id) => routes.find((route) => route.id === id);
  for (const route of routes.filter(
    (candidate) => candidate.directAccessBehavior === "LEGACY_REDIRECT",
  )) {
    assert.ok(byId(route.canonicalReplacement));
  }
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

test("human-readable route authority matrix covers the executable manifest", () => {
  const matrix = readFileSync(
    new URL("../../docs/frontend-route-authority-matrix.md", import.meta.url),
    "utf8",
  );
  for (const route of routes) {
    assert.ok(matrix.includes(`| \`${route.id}\` |`));
  }
  assert.match(matrix, /Standalone SME|Default SME navigation/);
});
