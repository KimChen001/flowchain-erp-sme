import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const cli = join(resolve(import.meta.dirname, ".."), "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [
  cli,
  "test",
  "tests/browser/universal-intake-foundation.spec.ts",
  "tests/browser/import-idempotency.spec.ts",
  "tests/browser/import-rollback.spec.ts",
], {
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_SETTINGS_DB: "true",
    PLAYWRIGHT_WORKERS: "1",
    FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: "true",
    FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: "true",
  },
});
child.once("exit", code => process.exit(code ?? 1));
