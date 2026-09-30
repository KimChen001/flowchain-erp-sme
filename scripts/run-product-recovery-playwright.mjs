import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = join(resolve(import.meta.dirname, ".."), "node_modules", "playwright", "cli.js");
function run(spec, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, "test", spec], {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_PRODUCT_RECOVERY_DB: "true",
        PLAYWRIGHT_WORKERS: "1",
        ...extraEnv,
      },
    });
    child.once("exit", (code) => resolveRun(code ?? 1));
  });
}

const acceptance = await run("tests/browser/product-recovery-acceptance.spec.ts");
if (acceptance !== 0) process.exit(acceptance);
// The US walkthrough must stay free of Chinese in the English interface.
const englishWalkthrough = await run("tests/browser/english-walkthrough.spec.ts");
if (englishWalkthrough !== 0) process.exit(englishWalkthrough);
// Email sign-in end to end, through the local mail outbox.
const outboxPath = join(tmpdir(), `flowchain-mail-outbox-${process.pid}.json`);
const emailLink = await run("tests/browser/email-link-sign-in.spec.ts", { FLOWCHAIN_MAIL_OUTBOX_PATH: outboxPath });
await rm(outboxPath, { force: true });
if (emailLink !== 0) process.exit(emailLink);
process.exit(await run("tests/browser/outbound-read-states.spec.ts", {
  PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY: "true",
}));
