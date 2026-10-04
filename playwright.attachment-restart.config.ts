import { defineConfig, devices } from "@playwright/test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One output folder per checkout, emptied by Playwright at the start of each
// run, instead of a new one per process id.
const checkout = createHash("sha256").update(import.meta.dirname).digest("hex").slice(0, 12);

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: join(tmpdir(), "flowchain-attachment-restart-playwright", checkout),
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${process.env.ATTACHMENT_RESTART_API_PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
