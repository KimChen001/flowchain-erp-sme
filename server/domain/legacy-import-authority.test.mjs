import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { capabilityForEnvironment } from "./capability-registry.mjs";
import { classifyRoute, ROUTE_CLASSES } from "./route-classification.mjs";

const root = resolve(import.meta.dirname, "../..");
const source = path => readFile(join(root, path), "utf8");

test("production route graph cannot reach archived direct-import implementations", async () => {
  const composition = await source("server/bootstrap/scm-server.mjs");
  const retiredRoute = await source("server/routes/pilot-import.routes.mjs");
  const purchaseRequests = await source("server/routes/purchase-requests.routes.mjs");
  for (const forbidden of [
    "import-persistence.routes.mjs",
    "legacy-pilot-import-service.mjs",
    "legacy-import-persistence-repository.mjs",
    "createPilotImportService",
    "handleImportPersistenceRoute",
  ]) assert.equal(composition.includes(forbidden), false, forbidden);
  for (const forbidden of ["getPrismaClient", "createPilotImportService", "importBatch.create", ".commit("]) {
    assert.equal(retiredRoute.includes(forbidden), false, forbidden);
  }
  assert.equal(purchaseRequests.includes("listImportedRecords"), false);
  await assert.rejects(access(join(root, "server/routes/import-persistence.routes.mjs")));
  await assert.rejects(access(join(root, "server/domain/pilot-import-service.mjs")));
  await assert.rejects(access(join(root, "server/repositories/import-persistence-repository.mjs")));
  await access(join(root, "server/domain/test-fixtures/legacy-pilot-import-service.mjs"));
  await access(join(root, "server/domain/test-fixtures/legacy-import-persistence-repository.mjs"));
});

test("legacy imports are unavailable while Universal Intake remains explicit preview without business commit", () => {
  const imports = capabilityForEnvironment("imports", {});
  assert.deepEqual(
    { maturity: imports.maturity, enabled: imports.enabled, readReady: imports.readReady, writeReady: imports.writeReady, businessCommitReady: imports.businessCommitReady },
    { maturity: "unavailable", enabled: false, readReady: false, writeReady: false, businessCommitReady: false },
  );
  const intakeDefault = capabilityForEnvironment("universal-intake", {});
  const intakeEnabled = capabilityForEnvironment("universal-intake", { FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: "true" });
  assert.equal(intakeDefault.enabled, false);
  assert.equal(intakeEnabled.enabled, true);
  assert.equal(intakeEnabled.writeReady, true);
  assert.equal(intakeEnabled.businessCommitReady, false);
});

test("every legacy import API is classified capability-disabled", () => {
  for (const [method, path] of [
    ["POST", "/api/imports/preview"],
    ["GET", "/api/imports/pilot-existing"],
    ["GET", "/api/imports/pilot-existing/issues"],
    ["POST", "/api/imports/pilot-existing/commit"],
    ["POST", "/api/imports/pilot-existing/cancel"],
    ["GET", "/api/import-batches"],
    ["GET", "/api/import-batches/legacy-existing"],
    ["POST", "/api/import-batches/legacy-existing/rollback"],
  ]) assert.equal(classifyRoute(method, path).classification, ROUTE_CLASSES.capabilityDisabled, `${method} ${path}`);
});

test("production frontend exposes retirement guidance and no legacy commit client", async () => {
  const importsPage = await source("src/modules/imports/Page.tsx");
  const contextualActions = await source("src/components/import/ContextualImportActions.tsx");
  const intakePage = await source("src/modules/intake/Page.tsx");
  assert.match(importsPage, /旧 Import 直接写入已停用/);
  assert.match(importsPage, /Universal Intake/);
  assert.equal(importsPage.includes("/api/imports"), false);
  assert.equal(contextualActions.includes('type="file"'), false);
  assert.equal(contextualActions.includes("ImportPreviewDialog"), false);
  for (const sourceLabel of ["Upload CSV", "Upload XLSX", "Paste Table", "Paste JSON"]) assert.match(intakePage, new RegExp(sourceLabel));
  assert.match(intakePage, /Business commit adapters are not available in Phase 5\.4B/);
  assert.match(intakePage, /No Supplier, Item, or Customer will be created/);
  assert.equal(intakePage.includes('method: "POST", body: JSON.stringify({ records:'), false);
  await assert.rejects(access(join(root, "src/lib/excel/importPersistenceApi.ts")));
  await assert.rejects(access(join(root, "src/components/import/ImportPreviewDialog.tsx")));
});
