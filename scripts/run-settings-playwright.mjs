import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const cli = join(resolve(import.meta.dirname, ".."), "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [cli, "test", "tests/browser/settings-localization.spec.ts", "tests/browser/supplier-form.spec.ts", "tests/browser/home-overview-language.spec.ts"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_SETTINGS_DB: "true", PLAYWRIGHT_WORKERS: "1" },
});
child.once("exit", code => process.exit(code ?? 1));
