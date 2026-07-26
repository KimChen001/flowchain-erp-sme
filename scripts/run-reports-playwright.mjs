import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules", "playwright", "cli.js");
const child = spawn(
  process.execPath,
  [cli, "test", "tests/browser/reports-currency-contract.spec.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_REPORTS_DB: "true",
      PLAYWRIGHT_WORKERS: "1",
    },
  },
);

child.once("exit", code => process.exit(code ?? 1));
