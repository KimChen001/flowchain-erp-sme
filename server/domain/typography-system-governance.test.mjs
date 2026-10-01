import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const fontSizeTenAllowlist = ["src/modules/forecast/Page.tsx", "src/modules/inventory/Page.tsx", "src/modules/print-layout/printLayoutPresets.ts"];

test("tracked application source has no explicit 10px utility text", () => {
  let matches = "";
  try {
    matches = execFileSync("git", ["grep", "-n", "-F", "text-[10px]", "--", "src/**/*.tsx", "src/**/*.ts", "src/**/*.css"], { encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert.equal(matches.trim(), "");
});

test("10px inline font sizes stay confined to print or chart-coordinate allowlist", () => {
  let matches = "";
  try {
    matches = execFileSync("git", ["grep", "-n", "-E", "fontSize\\s*[:=]\\s*10([^0-9]|$)", "--", "src/**/*.tsx", "src/**/*.ts", "src/**/*.css"], { encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const violations = matches.trim().split(/\r?\n/).filter(Boolean).filter((line) => !fontSizeTenAllowlist.some((path) => line.startsWith(`${path}:`)));
  assert.deepEqual(violations, []);
});

test("semantic typography tokens are centrally defined", () => {
  const theme = read("src/styles/theme.css");
  for (const token of ["fc-module-title", "fc-page-title", "fc-page-subtitle", "fc-modal-title", "fc-section-title", "fc-body", "fc-label", "fc-caption", "fc-table-header", "fc-kpi-value", "fc-nav-primary", "fc-nav-secondary"]) {
    assert.match(theme, new RegExp(`\\.${token}`));
  }
  assert.match(theme, /--font-size: 16px/);
  assert.match(theme, /font-size: 13px;\s*line-height: 20px/);
  assert.match(theme, /Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"/);
});
