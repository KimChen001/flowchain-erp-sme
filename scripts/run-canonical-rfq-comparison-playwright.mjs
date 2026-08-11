import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const cli = join(resolve(import.meta.dirname, ".."), "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [cli, "test", "tests/browser/canonical-rfq-comparison.spec.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_PRODUCT_RECOVERY_DB: "true",
    PLAYWRIGHT_CANONICAL_RFQ_COMPARISON: "true",
    PLAYWRIGHT_WORKERS: "1",
  },
});

child.once("exit", (code) => process.exit(code ?? 1));
