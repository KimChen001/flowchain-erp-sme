import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules", "playwright", "cli.js");
const env = {
  ...process.env,
  PLAYWRIGHT_MOBILE_OPERATIONS_DB: "true",
  PLAYWRIGHT_MOBILE_AUTHORITY: "true",
  PLAYWRIGHT_MOBILE_SYNC_CONTROLS: "true",
  PLAYWRIGHT_WORKERS: "1",
};

const code = await new Promise((resolveExit) => {
  const child = spawn(process.execPath, [cli, "test", "tests/browser/mobile-operations.spec.ts", "tests/browser/mobile-sync-controls.spec.ts"], { cwd: root, stdio: "inherit", env });
  child.once("exit", (value) => resolveExit(value ?? 1));
});
if (code !== 0) process.exitCode = code;
else {
  const restart = spawn(process.execPath, [join(root, "scripts", "run-attachment-restart-playwright.mjs")], { cwd: root, stdio: "inherit", env: process.env });
  process.exitCode = await new Promise((resolveExit) => restart.once("exit", (value) => resolveExit(value ?? 1)));
}
