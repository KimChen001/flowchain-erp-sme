import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appPort = Number(process.env.PLAYWRIGHT_APP_PORT || 15173);
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787);
const workers = Number(process.env.PLAYWRIGHT_WORKERS || 1);

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: join(tmpdir(), "flowchain-playwright-results", String(process.pid)),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${appPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command:
        process.env.PLAYWRIGHT_INTERNAL_SETTLEMENT_DB === "true"
          ? "node scripts/browser-operational-finance-api.mjs"
          : process.env.PLAYWRIGHT_PRODUCT_RECOVERY_DB === "true"
          ? "node scripts/browser-product-recovery-api.mjs"
          : process.env.PLAYWRIGHT_REPORTS_DB === "true"
          ? "node scripts/browser-settings-api.mjs"
          : process.env.PLAYWRIGHT_SETTLEMENT_WORKFLOW_DB === "true"
          ? "node scripts/browser-operational-finance-api.mjs"
          : process.env.PLAYWRIGHT_MOBILE_OPERATIONS_DB === "true"
          ? "node scripts/browser-operational-finance-api.mjs"
          : process.env.PLAYWRIGHT_OPERATIONAL_FINANCE_DB === "true"
          ? "node scripts/browser-operational-finance-api.mjs"
          : process.env.PLAYWRIGHT_SETTINGS_DB === "true"
          ? "node scripts/browser-settings-api.mjs"
          : process.env.PLAYWRIGHT_RETURNS_QUARANTINE_DB === "true"
          ? "node scripts/browser-returns-quarantine-api.mjs"
          : process.env.PLAYWRIGHT_INVENTORY_OPERATIONS_DB === "true"
          ? "node scripts/browser-inventory-operations-api.mjs"
          : process.env.PLAYWRIGHT_OUTBOUND_DB === "true"
            ? "node scripts/browser-outbound-api.mjs"
            : process.env.PLAYWRIGHT_RECEIVING_DB === "true"
              ? "node scripts/browser-receiving-api.mjs"
              : "node scripts/browser-uat-api.mjs",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node scripts/browser-uat-vite.mjs",
      url: `http://127.0.0.1:${appPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
