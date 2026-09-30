import { spawn } from "node:child_process";
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
// The assistant answers the walkthrough prompt chips in English from workspace data.
const englishAssistant = await run("tests/browser/ai-assistant-english.spec.ts");
if (englishAssistant !== 0) process.exit(englishAssistant);
process.exit(await run("tests/browser/outbound-read-states.spec.ts", {
  PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY: "true",
}));
