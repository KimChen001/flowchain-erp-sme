import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultRoleTemplates, permissionByCode } from "../auth/permission-catalog.mjs";
import { rfqComparisonEligibility } from "./rfq-comparison-eligibility.mjs";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("formal Award permission is high risk and granted only to approved default roles", () => {
  assert.equal(permissionByCode.get("procurement.rfq_award.create")?.riskLevel, "high");
  const grants = defaultRoleTemplates
    .filter((role) => role.permissions.includes("procurement.rfq_award.create"))
    .map((role) => role.roleKey)
    .sort();
  assert.deepEqual(grants, ["operations-manager", "workspace-administrator"]);
  for (const roleKey of ["procurement-specialist", "operations-specialist", "finance-specialist", "read-only-viewer"]) {
    assert.equal(defaultRoleTemplates.find((role) => role.roleKey === roleKey).permissions.includes("procurement.rfq_award.create"), false);
  }
  assert.equal(defaultRoleTemplates.find((role) => role.roleKey === "procurement-specialist").permissions.includes("procurement.prices.read"), true);
});

test("AI and review-draft handlers do not import or invoke formal Award authority", () => {
  for (const path of [
    "./ai-response-contract-v2.mjs",
    "./review-first-action-workflow-v2.mjs",
    "../routes/ai.routes.mjs",
    "../routes/action-drafts.routes.mjs",
  ]) {
    const content = source(path);
    assert.equal(content.includes("createRfqAwardDecisionService"), false, path);
    assert.equal(content.includes("procurement.rfq_award.create"), false, path);
    assert.equal(content.includes("rfq-award-decision-service"), false, path);
  }
});

test("Comparison and formal Award reuse one eligibility implementation", () => {
  const comparison = source("./rfq-supplier-comparison-service.mjs");
  const award = source("./rfq-award-decision-service.mjs");
  assert.match(comparison, /from "\.\/rfq-comparison-eligibility\.mjs"/);
  assert.match(award, /from "\.\/rfq-comparison-eligibility\.mjs"/);
  assert.doesNotMatch(comparison, /function comparisonEligibility/);
  assert.doesNotMatch(award, /function comparisonEligibility/);
});

test("shared eligibility fails closed for missing and unknown authority", () => {
  assert.equal(rfqComparisonEligibility({ revision: null, coverageState: "none" }).state, "authority_missing");
  assert.equal(rfqComparisonEligibility({ revision: { status: "legacy_unknown" }, coverageState: "complete" }).state, "unknown_status");
});
