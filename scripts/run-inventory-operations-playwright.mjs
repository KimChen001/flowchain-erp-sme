import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
const cli = join(
  resolve(import.meta.dirname, ".."),
  "node_modules",
  "playwright",
  "cli.js",
);
function run(spec, extra = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, "test", spec], {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_INVENTORY_OPERATIONS_DB: "true",
        PLAYWRIGHT_WORKERS: "1",
        ...extra,
      },
    });
    child.once("exit", (code) => resolveRun(code ?? 1));
  });
}
const main = await run("tests/browser/inventory-operations.spec.ts");
if (main !== 0) process.exit(main);
// Stock level on the balances and warnings pages, judged per item.
const levels = await run("tests/browser/inventory-stock-levels.spec.ts");
if (levels !== 0) process.exit(levels);
process.exit(
  await run("tests/browser/inventory-operations-disabled.spec.ts", {
    PLAYWRIGHT_INVENTORY_OPERATIONS_DISABLED: "true",
  }),
);
