import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const cli = join(resolve(import.meta.dirname, ".."), "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [cli, "test", "tests/browser/universal-intake-foundation.spec.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_SETTINGS_DB: "true",
    PLAYWRIGHT_WORKERS: "1",
    FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: "true",
  },
});
child.once("exit", code => process.exit(code ?? 1));
