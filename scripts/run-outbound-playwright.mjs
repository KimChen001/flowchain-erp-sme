import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
const cli = join(
  resolve(import.meta.dirname, ".."),
  "node_modules",
  "playwright",
  "cli.js",
);

function run(spec, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, "test", ...[spec].flat()], {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_OUTBOUND_DB: "true",
        PLAYWRIGHT_WORKERS: "1",
        ...extraEnv,
      },
    });
    child.once("exit", (code) => resolveRun(code ?? 1));
  });
}

const workbench = await run(["tests/browser/outbound-workbench.spec.ts", "tests/browser/sales-order-cancel.spec.ts"]);
if (workbench !== 0) process.exit(workbench);
process.exit(
  await run("tests/browser/outbound-capability-disabled.spec.ts", {
    PLAYWRIGHT_OUTBOUND_CAPABILITY_DISABLED: "true",
  }),
);
