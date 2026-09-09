import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "english-default.spec.ts",
  outputDir: "../english-browser-results",
  use: {
    baseURL: "http://127.0.0.1:15174",
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {},
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 15174 --strictPort",
    url: "http://127.0.0.1:15174",
    reuseExistingServer: false,
  },
});
