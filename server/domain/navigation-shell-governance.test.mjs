import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("route registry is the single navigation and page-label source", () => {
  const registry = read("src/app/routeRegistry.tsx");
  const routes = read("src/app/routes.tsx");
  const app = read("src/app/FlowChainApp.tsx");
  const requiredPaths = [
    "/app/overview", "/app/master-data/items", "/app/master-data/suppliers",
    "/app/procurement/orders", "/app/procurement/receiving", "/app/sales/deliveries",
    "/app/sales/receipts", "/app/inventory/adjustments", "/app/inventory/warnings",
    "/app/finance/three-way-match", "/app/reports", "/app/settings",
  ];
  for (const path of requiredPaths) assert.match(registry, new RegExp(path.replaceAll("/", "\\/")));
  assert.match(routes, /export \* from "\.\/routeRegistry"/);
  assert.doesNotMatch(app, /const \[active,\s*setActive\]/);
  assert.doesNotMatch(app, /PAGE_LABELS/);
  assert.match(app, /routeByPath\(location\.pathname\)/);
  assert.match(app, /routePathForId\(intent\.activeId\)/);
});

test("module shell owns breadcrumb, secondary navigation, page title and recovery", () => {
  const shell = read("src/components/navigation/ModuleShell.tsx");
  const breadcrumb = read("src/components/navigation/AppBreadcrumb.tsx");
  assert.match(shell, /data-testid="module-shell"/);
  assert.match(shell, /routesForModule\(route\.moduleId\)/);
  assert.match(shell, /data-testid="module-title"/);
  assert.match(shell, /data-testid="page-title"/);
  assert.match(shell, /NotFoundRecovery/);
  assert.match(breadcrumb, /breadcrumbRoutes\(route\)/);
  assert.match(breadcrumb, /aria-current="page"/);
  assert.match(breadcrumb, /<Link[^>]+to=\{item\.path\}/);
  assert.doesNotMatch(breadcrumb, /preventDefault/);
});

test("business-level inventory, master-data, procurement and finance tabs navigate by route", () => {
  const inventoryWrapper = read("src/modules/inventory/Page.tsx").split("export default function InventoryPage")[1];
  const master = read("src/modules/master-data/Page.tsx");
  const procurement = read("src/modules/procurement/Page.tsx");
  const finance = read("src/modules/finance/Page.tsx");
  assert.match(read("src/modules/inventory/Page.tsx"), /<EntityLink/);
  assert.match(inventoryWrapper, /endpointFor/);
  assert.doesNotMatch(inventoryWrapper, /<SubTabs/);
  for (const source of [master, procurement, finance]) {
    assert.match(source, /onNavigate/);
    assert.doesNotMatch(source, /<SubTabs/);
  }
});

test("module content without a standalone workbench does not recreate a separate h1 title shell", () => {
  for (const path of ["src/modules/overview/Page.tsx", "src/modules/master-data/Page.tsx", "src/modules/receiving/Page.tsx", "src/modules/sales/Page.tsx", "src/modules/inventory/Page.tsx", "src/modules/finance/Page.tsx", "src/modules/reports/Page.tsx", "src/modules/settings/Page.tsx"]) {
    assert.doesNotMatch(read(path), /<h1\b/, path);
  }
});

test("list context and recent pages use isolated bounded browser storage", () => {
  const listState = read("src/components/navigation/useListRouteState.ts");
  const recent = read("src/components/navigation/RecentPages.tsx");
  assert.match(listState, /flowchain:list:\$\{moduleId\}:\$\{routeId\}/);
  assert.match(listState, /useSearchParams/);
  assert.match(listState, /scrollTop/);
  assert.match(recent, /MAX_RECENT = 8/);
  assert.match(recent, /localStorage/);
  assert.match(recent, /current\.pageType === "create"/);
});
