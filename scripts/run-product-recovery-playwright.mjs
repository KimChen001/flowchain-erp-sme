import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = join(resolve(import.meta.dirname, ".."), "node_modules", "playwright", "cli.js");
function run(specs, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, "test", ...[specs].flat()], {
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

// CI runs the phases in two groups on separate runners, chosen with
// PRODUCT_RECOVERY_GROUP: "shell" is the phases named here, "walkthrough" is
// every other phase, so a new phase lands in walkthrough unless it is added
// here. Without the variable every phase runs, as locally.
const SHELL_PHASES = new Set(["shell and routing", "email link sign-in", "outbound read states"]);
const group = process.env.PRODUCT_RECOVERY_GROUP || "";
if (group && !["walkthrough", "shell"].includes(group)) {
  console.error(`PRODUCT_RECOVERY_GROUP must be "walkthrough" or "shell", not "${group}".`);
  process.exit(2);
}
const selected = (name) => !group || (group === "shell") === SHELL_PHASES.has(name);

// Every phase runs even when an earlier one fails, so one failure cannot hide
// another; the runner exits with the first failing phase's code.
const failures = [];
const ran = [];
async function phase(name, specs, extraEnv) {
  if (!selected(name)) return;
  ran.push(name);
  const code = await run(specs, extraEnv);
  if (code !== 0) failures.push({ name, code });
}

await phase("acceptance", "tests/browser/product-recovery-acceptance.spec.ts");
// The US walkthrough must stay free of Chinese in the English interface.
await phase("english walkthrough", "tests/browser/english-walkthrough.spec.ts");
// Supplier performance against the original promise, in English.
await phase("supplier performance", ["tests/browser/supplier-performance-english.spec.ts", "tests/browser/supplier-activity.spec.ts"]);
// The PO document: printed alone, labels in the document language, figures unchanged.
await phase("po document", "tests/browser/purchase-order-document.spec.ts");
// The assistant answers the walkthrough prompt chips in English from workspace data.
await phase("english assistant", "tests/browser/ai-assistant-english.spec.ts");
// Shell, routing, capability and authorization checks on the walkthrough data.
await phase("shell and routing", [
  "tests/browser/frontend-route-governance.spec.ts",
  "tests/browser/frontend-route-surface-audit.spec.ts",
  "tests/browser/navigation-routing.spec.ts",
  "tests/browser/capability-route-guard.spec.ts",
  "tests/browser/app-layout-width.spec.ts",
  "tests/browser/typography-system.spec.ts",
  "tests/browser/authoritative-mutation-auth.spec.ts",
  "tests/browser/user-data-import-preview.spec.ts",
  "tests/browser/motion-transitions.spec.ts",
]);
// Email sign-in end to end, through the local mail outbox.
const outboxPath = join(tmpdir(), `flowchain-mail-outbox-${process.pid}.json`);
await phase("email link sign-in", ["tests/browser/email-link-sign-in.spec.ts", "tests/browser/workspace-invitation.spec.ts"], { FLOWCHAIN_MAIL_OUTBOX_PATH: outboxPath });
await rm(outboxPath, { force: true });
await phase("outbound read states", "tests/browser/outbound-read-states.spec.ts", {
  PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY: "true",
});

if (group) console.log(`Product recovery group ${group}: ${ran.join(", ") || "no phases"}`);
for (const failure of failures) console.error(`Product recovery phase failed: ${failure.name} (exit ${failure.code})`);
process.exit(failures[0]?.code ?? 0);
