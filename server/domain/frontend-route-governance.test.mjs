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
let fulfillment;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  registry = await vite.ssrLoadModule("/src/app/routeRegistry.tsx");
  invariants = await vite.ssrLoadModule("/src/app/routes/route-invariants.ts");
  manifest = await vite.ssrLoadModule("/src/app/routes/route-manifest.ts");
  fulfillment = await vite.ssrLoadModule("/src/modules/procurement/OrderFulfillmentLinesPage.tsx");
  routes = registry.appRouteRegistry;
});

after(async () => {
  await vite?.close();
});

test("frontend route manifest satisfies authority invariants", () => {
  assert.equal(routes.length, 162);
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
    162,
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
    /classification policy references nonexistent route: overview:ai/,
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
      "sales",
      "master-data:suppliers",
      "master-data:items",
      "reports",
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
    routes.find((route) => route.id === "procurement:order-lines").requiredPermission,
    "procurement.purchase_order.read",
  );
  assert.equal(
    routes.find((route) => route.id === "procurement:invoices").requiredPermission,
    "finance.supplier_invoice.read",
  );
  assert.equal(
    routes.find((route) => route.id === "procurement:invoice-detail").requiredPermission,
    "finance.supplier_invoice.read",
  );
  assert.equal(
    routes.find((route) => route.id === "procurement:match-detail").requiredPermission,
    "finance.three_way_match.read",
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
  const searchable = invariants.searchableRouteManifest(routes);
  assert.ok(
    routes
      .filter((route) => ["FROZEN", "INTERNAL"].includes(route.classification))
      .every((route) => route.navigationVisibility === "HIDDEN"),
  );
  assert.ok(
    searchable.every(
        (route) =>
          !["FROZEN", "INTERNAL", "LEGACY"].includes(route.classification),
      ),
  );
  assert.ok(searchable.some((route) => route.id === "procurement:rfq"));
  assert.ok(searchable.some((route) => route.id === "procurement:order-lines"));
  assert.ok(searchable.some((route) => route.id === "sales"));
  assert.ok(searchable.some((route) => route.id === "reports"));
  for (const id of [
    "procurement:rfq-detail",
    "procurement:contracts",
    "imports",
    "imports:pilot",
    "settings:advanced",
    "finance:reconciliation",
    "procurement:invoice-detail",
    "procurement:match-detail",
  ]) {
    assert.equal(searchable.some((route) => route.id === id), false, id);
  }
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
    byId("procurement:order-lines").path,
    "/app/procurement/order-lines",
  );
  assert.equal(
    byId("procurement:order-detail").path,
    "/app/procurement/orders/:id",
  );
  assert.equal(
    byId("procurement:receiving-detail").path,
    "/app/procurement/receiving/:id",
  );
  assert.equal(
    byId("procurement:invoice-detail").path,
    "/app/procurement/invoices/:id",
  );
  assert.equal(
    byId("procurement:match-detail").path,
    "/app/procurement/three-way-match/:id",
  );
  assert.equal(registry.routeByPath("/app/procurement/orders/PO-002").id, "procurement:order-detail");
  assert.equal(
    registry.routeByPath("/app/procurement/receiving/GRN-001").id,
    "procurement:receiving-detail",
  );
  assert.equal(
    registry.routeByPath("/app/procurement/invoices/INV-001").id,
    "procurement:invoice-detail",
  );
  assert.equal(
    registry.routeByPath("/app/procurement/three-way-match/MATCH-INV-001").id,
    "procurement:match-detail",
  );
});

test("read and write maturity are independent from CORE classification", () => {
  const byId = (id) => routes.find((route) => route.id === id);
  for (const id of [
    "overview",
    "overview:risks",
    "procurement:rfq",
    "procurement:receiving",
    "procurement:order-lines",
    "inventory:stock",
  ]) {
    assert.equal(byId(id).readMaturity, "AUTHORITATIVE", id);
    assert.equal(byId(id).writeMaturity, "UNAVAILABLE", id);
  }
  assert.equal(byId("procurement:requests").writeMaturity, "AUTHORITATIVE");
  assert.equal(byId("settings:audit").writeMaturity, "UNAVAILABLE");
  for (const id of ["procurement:invoice-detail", "procurement:match-detail"]) {
    assert.equal(byId(id).classification, "CORE", id);
    assert.equal(byId(id).readMaturity, "AUTHORITATIVE", id);
    assert.equal(byId(id).writeMaturity, "UNAVAILABLE", id);
    assert.equal(byId(id).navigationVisibility, "CONTEXTUAL", id);
    assert.equal(byId(id).requiredCapability, undefined, id);
    assert.equal(byId(id).directAccessBehavior, "PERMISSION_REQUIRED", id);
  }
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

test("policy assignment, references, and route-level capability drift fail closed", () => {
  const capabilityMap = new Map();
  manifest.assignUniquePolicy(capabilityMap, "route", "alpha", "capability policy");
  manifest.assignUniquePolicy(capabilityMap, "route", "alpha", "capability policy");
  assert.equal(capabilityMap.get("route"), "alpha");
  assert.throws(
    () => manifest.assignUniquePolicy(capabilityMap, "route", "beta", "capability policy"),
    /capability policy conflict for route: alpha vs beta/,
  );

  const permissionMap = new Map();
  manifest.assignUniquePolicy(permissionMap, "route", "read.alpha", "permission policy");
  assert.throws(
    () => manifest.assignUniquePolicy(permissionMap, "route", "read.beta", "permission policy"),
    /permission policy conflict for route: read.alpha vs read.beta/,
  );

  for (const policyName of [
    "classification policy",
    "capability policy",
    "permission policy",
    "primary navigation",
    "compatibility policy",
    "authoritative write policy",
  ]) {
    assert.throws(
      () =>
        manifest.validateRoutePolicyReferences(new Set(["known"]), {
          [policyName]: ["missing"],
        }),
      new RegExp(`${policyName} references nonexistent route: missing`),
    );
  }

  const reconciliation = routes.find((route) => route.id === "finance:reconciliation");
  assert.equal(reconciliation.requiredCapability, "cashbook");
  assert.throws(
    () =>
      manifest.authorityForRoute({
        ...reconciliation,
        capabilityId: "internal-settlement",
      }),
    /route capability drift for finance:reconciliation: internal-settlement vs cashbook/,
  );
});

test("order fulfillment lines join receiving and invoice evidence by exact PO line", () => {
  const rows = fulfillment.buildOrderFulfillmentLines({
    purchaseOrders: [{
      po: "PO-1",
      supplier: "Supplier A",
      status: "已发出",
      currency: "CNY",
      lines: [{
        poLineId: "PO-1-L1",
        sku: "SHARED-SKU",
        itemName: "Item A",
        quantityOrdered: 10,
        quantityReceived: 4,
        unit: "pcs",
        unitPrice: 25,
        currency: "CNY",
      }],
    }],
    receivingDocs: [{
      grn: "GRN-EXACT",
      lines: [{ poLineId: "PO-1-L1", sku: "SHARED-SKU", receivedQty: 4 }],
    }, {
      grn: "GRN-SAME-SKU-WRONG-LINE",
      lines: [{ poLineId: "PO-2-L1", sku: "SHARED-SKU", receivedQty: 9 }],
    }],
    supplierInvoices: [{
      id: "INV-EXACT",
      lines: [{ poLine: "PO-1-L1", sku: "SHARED-SKU", quantity: 3, varianceAmount: 5 }],
    }, {
      id: "INV-SAME-SKU-WRONG-LINE",
      lines: [{ poLine: "PO-2-L1", sku: "SHARED-SKU", quantity: 8, varianceAmount: 0 }],
    }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].lineAmount, 250);
  assert.equal(rows[0].receivedQuantity, 4);
  assert.equal(rows[0].invoicedQuantity, 3);
  assert.equal(rows[0].remainingToReceive, 6);
  assert.equal(rows[0].receivedNotInvoiced, 1);
  assert.equal(rows[0].receivingEvidence.length, 1);
  assert.equal(rows[0].receivingEvidence[0].document.grn, "GRN-EXACT");
  assert.equal(rows[0].invoiceEvidence.length, 1);
  assert.equal(rows[0].invoiceEvidence[0].invoice.id, "INV-EXACT");
  assert.equal(rows[0].varianceAmount, 5);
  assert.equal(rows[0].status, "部分收货");
});

test("procurement details use canonical single-document reads and preserve status-aware failures", () => {
  const apiSource = readFileSync(
    new URL("../../src/modules/procurement/procurementApi.ts", import.meta.url),
    "utf8",
  );
  const detailSource = readFileSync(
    new URL("../../src/modules/procurement/ProcurementDocumentDetailPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(apiSource, /getDocument:\s*\(type: ProcurementDocumentType, id: string\)/);
  assert.match(apiSource, /encodeURIComponent\(type\).*encodeURIComponent\(id\)/s);
  assert.match(detailSource, /procurementApi\.getDocument\(kind, documentId\)/);
  assert.match(detailSource, /procurementApi\.getDocument\("threeWayMatch", matchReference\.id\)/);
  assert.doesNotMatch(detailSource, /listDocuments\(/);
  for (const status of [401, 403, 404]) {
    assert.match(detailSource, new RegExp(`error\\.status === ${status}`));
  }
  assert.doesNotMatch(detailSource, /执行匹配|批准发票|发票过账|付款/);
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
  assert.match(matrix, /162\/162 frontend route stability audit/);
});
