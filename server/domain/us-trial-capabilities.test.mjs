import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { capabilityRegistry, capabilityRegistryForEnvironment } from "./capability-registry.mjs";

// The documented US trial set: receiving posting (desktop receiving), outbound
// posting, inventory operations, operational finance and mobile operations,
// which stays available but is not needed to receive, and the CSV import of
// master data and opening stock. Everything else stays off.
const US_TRIAL_FLAGS = [
  "FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING",
  "FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING",
  "FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS",
  "FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE",
  "FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS",
  "FLOWCHAIN_ENABLE_DATA_IMPORT",
];

const parseExample = (relativePath) => Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, "../..", relativePath), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

const enabledIds = (env) => capabilityRegistryForEnvironment(env).filter((entry) => entry.enabled).map((entry) => entry.id);

test("the US trial flags are exactly the environment names the capability registry reads", () => {
  const registryFlags = new Set(capabilityRegistry.map((entry) => entry.environmentFlag).filter(Boolean));
  for (const flag of US_TRIAL_FLAGS) assert.ok(registryFlags.has(flag), flag);
});

for (const example of ["deploy/env.production.example", ".env.example", ".env.local.example"]) {
  test(`${example} enables the documented US trial capability set and nothing more`, () => {
    const env = parseExample(example);
    for (const flag of US_TRIAL_FLAGS) assert.equal(env[flag], "true", `${example} ${flag}`);

    const enabled = enabledIds(env);
    for (const id of [
      "receiving-posting",
      "receiving-reversal",
      "sales-order-lifecycle",
      "sales-shipment-posting",
      "stock-transfer",
      "cycle-count",
      "inventory-adjustment-document",
      "finance",
      "supplier-invoice",
      "three-way-match",
      "payable-obligation",
      "customer-invoice",
      "receivable-obligation",
      "mobile-operations",
      "data-import",
    ]) assert.ok(enabled.includes(id), `${example} ${id}`);

    const trialFlags = new Set(US_TRIAL_FLAGS);
    const outsideTrial = capabilityRegistry
      .filter((entry) => entry.requiresExplicitEnable && !trialFlags.has(entry.environmentFlag))
      .map((entry) => entry.id);
    assert.ok(outsideTrial.includes("mobile-sync"));
    assert.ok(outsideTrial.includes("contracts"));
    for (const id of outsideTrial) assert.ok(!enabled.includes(id), `${example} must keep ${id} off`);
    // Contracts are named and off, so an operator sees the switch (D10).
    assert.equal(env.FLOWCHAIN_ENABLE_CONTRACTS, "false", `${example} FLOWCHAIN_ENABLE_CONTRACTS`);
  });
}

test("contracts need an explicit FLOWCHAIN_ENABLE_CONTRACTS=true, and the local walkthrough turns them on", () => {
  const contracts = capabilityRegistry.find((entry) => entry.id === "contracts");
  assert.deepEqual([contracts.environmentFlag, contracts.requiresExplicitEnable, contracts.databaseOnly, contracts.enabled], ["FLOWCHAIN_ENABLE_CONTRACTS", true, true, false]);
  assert.equal(enabledIds({}).includes("contracts"), false);
  assert.equal(enabledIds({ FLOWCHAIN_ENABLE_CONTRACTS: "false" }).includes("contracts"), false);
  assert.equal(enabledIds({ FLOWCHAIN_ENABLE_CONTRACTS: "true" }).includes("contracts"), true);
  const walkthrough = readFileSync(resolve(import.meta.dirname, "../..", "scripts/walkthrough-local.mjs"), "utf8");
  assert.match(walkthrough, /FLOWCHAIN_ENABLE_CONTRACTS: "true"/);
});
