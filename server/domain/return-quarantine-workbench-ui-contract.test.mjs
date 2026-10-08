import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("return and quarantine workbench exposes governed product acceptance markers", async () => {
  const [workbench, copyData, readService, routes, app, packageJson, workflow, browser] =
    await Promise.all([
      read("src/modules/inventory/ReturnQuarantineWorkbench.tsx"),
      read("src/modules/inventory/returnsCopyData.ts"),
      read("server/domain/supplier-return-read-service.mjs"),
      read("src/app/routeRegistry.tsx"),
      read("src/app/FlowChainApp.tsx"),
      read("package.json"),
      read(".github/workflows/receiving-postgres.yml"),
      read("tests/browser/returns-quarantine.spec.ts"),
    ]);
  for (const marker of [
    "return-request-workbench",
    "return-authorization-workbench",
    "return-posting-workbench",
    "quarantine-inventory-workbench",
    "return-preview",
    "return-reconciliation",
    "Select a posted source document",
    "Select a balance",
    "returns-readonly",
  ])
    assert.match(workbench, new RegExp(marker));
  // The Chinese copy for the explicit source and balance choices.
  for (const marker of ["请选择正式已过账来源单据", "请选择余额"])
    assert.match(copyData, new RegExp(marker));
  assert.match(readService, /crossLineNettingAllowed:\s*false/);
  assert.match(readService, /lineIsolation:\s*true/);
  for (const path of [
    "/app/inventory/returns",
    "/app/inventory/returns/requests",
    "/app/inventory/returns/authorizations",
    "/app/inventory/returns/postings",
    "/app/inventory/quarantine",
  ])
    assert.match(routes, new RegExp(path.replaceAll("/", "\\/")));
  assert.match(app, /returns-quarantine/);
  assert.match(packageJson, /test:browser:returns-quarantine/);
  assert.match(workflow, /npm run test:browser:returns-quarantine/);
  for (const marker of [
    "returns-browser-available-source",
    "returns-browser-quarantine",
    "release_quarantine_to_available",
    "viewer@example.com",
    "readonly@example.com",
  ])
    assert.match(browser, new RegExp(marker));
});
