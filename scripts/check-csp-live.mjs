// Loads the built app from the real server, under the headers production
// sends, and lists every Content-Security-Policy violation the browser
// reports. The Playwright suites go through the Vite dev server, which sends
// no CSP, so only this check shows whether the policy breaks the built app.
//
//   npm run build
//   node scripts/check-csp-live.mjs
//
// It starts scripts/browser-product-recovery-api.mjs (embedded PostgreSQL with
// the walkthrough data) on a free port. createScmServer serves dist/ there, so
// the browser talks to that one server. It signs in as the specs do, visits
// the main pages, exports a report chart, opens the assistant and a print
// preview, and exits 1 on any violation, if the CSP header is missing, or if
// its self-test (an injected inline script) is not reported. A step whose page
// or button cannot be found is listed but does not fail the check.
//
// Run it after changing the policy or adding anything that loads from another
// origin. On Windows the harness is ended with taskkill, so its temporary
// database folder (%TEMP%\flowchain-product-recovery-*) stays behind.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { CONTENT_SECURITY_POLICY } from "../server/bootstrap/security-headers.mjs";

const root = resolve(import.meta.dirname, "..");
if (!existsSync(resolve(root, "dist", "index.html"))) {
  console.error("[csp-live] dist/index.html is missing. Run npm run build first.");
  process.exit(2);
}

const freePort = () => new Promise((resolvePort, reject) => {
  const socket = createServer().on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => resolvePort(port));
  });
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const api = spawn(process.execPath, ["scripts/browser-product-recovery-api.mjs"], {
  cwd: root,
  // Contracts on, as in the local walkthrough, so their pages and signed
  // files are checked too.
  env: { ...process.env, PLAYWRIGHT_API_PORT: String(port), PLAYWRIGHT_CONTRACTS: "true" },
  stdio: ["ignore", "inherit", "inherit"],
});

function stopApi() {
  if (api.exitCode !== null) return;
  // On Windows a signal cannot reach the harness's cleanup, so end the whole
  // tree, embedded PostgreSQL included.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(api.pid), "/T", "/F"], { stdio: "ignore" });
  else api.kill("SIGTERM");
}

async function waitForApi(timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (api.exitCode !== null) throw new Error(`The browser API exited early (code ${api.exitCode}).`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("The browser API did not become ready in time.");
}

const violations = [];
const cspConsole = [];
const otherErrors = [];
const stepFailures = [];
let currentStep = "";
const SELF_TEST = "detector self-test";

let browser;
let exitCode = 0;
try {
  await waitForApi();
  browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: base, acceptDownloads: true, locale: "en-US" });
  await context.exposeBinding("__flowchainCspViolation", (_source, violation) => {
    violations.push({ step: currentStep, ...violation });
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__flowchainCspViolation({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        disposition: event.disposition,
        sourceFile: event.sourceFile,
        line: event.lineNumber,
        sample: event.sample,
        documentURI: event.documentURI,
      });
    }, true);
  });
  // As the specs do: English copy, so the labels below are stable.
  await context.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: "en-US", defaultLanguage: "en-US", effectiveLanguage: "en-US", locale: "en-US", timezone: "America/New_York" },
  }));

  const page = await context.newPage();
  page.on("console", (message) => {
    const text = message.text();
    if (/content.security.policy/i.test(text)) cspConsole.push({ step: currentStep, type: message.type(), text });
    else if (message.type() === "error") otherErrors.push({ step: currentStep, text: text.slice(0, 300) });
  });
  page.on("pageerror", (error) => otherErrors.push({ step: currentStep, text: `pageerror: ${String(error.message).slice(0, 300)}` }));

  const settle = async () => {
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  async function step(name, run) {
    currentStep = name;
    try {
      await run();
      await settle();
      console.log(`[csp-live] ok   ${name}`);
    } catch (error) {
      stepFailures.push({ step: name, error: String(error?.message || error).split("\n")[0] });
      console.log(`[csp-live] FAIL ${name}: ${String(error?.message || error).split("\n")[0]}`);
    }
  }
  const visit = (path) => async () => {
    const response = await page.goto(path);
    if (!response?.ok()) throw new Error(`${path} answered ${response?.status()}`);
  };

  await step("sign-in page", async () => {
    const response = await page.goto("/");
    const policy = response?.headers()["content-security-policy"];
    if (policy !== CONTENT_SECURITY_POLICY) throw new Error(`the shell has no enforced CSP (got ${JSON.stringify(policy)}); the check would prove nothing`);
    await page.getByRole("button", { name: /sign-in link/i }).first().waitFor();
  });
  await step("sign-in confirm page", visit("/sign-in/confirm?token=not-a-real-token"));
  // Proves the listener works: an inline script must be reported, then is
  // set aside so it does not count as a finding.
  await step(SELF_TEST, async () => {
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__inlineRan = true";
      document.head.append(script);
    });
    await page.waitForTimeout(500);
    const reported = violations.some((entry) => entry.step === SELF_TEST && entry.directive === "script-src-elem");
    if (!reported || (await page.evaluate(() => window.__inlineRan === true))) throw new Error("the injected inline script was not blocked and reported");
  });

  const login = await context.request.post("/api/auth/login", { data: { email: "admin@flowchain.local" } });
  if (!login.ok()) throw new Error(`sign-in failed: ${login.status()}`);
  const session = await login.json();
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);

  await step("home", visit("/app/overview"));
  await step("purchase orders", visit("/app/procurement/orders"));
  await step("purchase order detail", visit("/app/procurement/orders/LOCAL-DEMO-PO-002"));
  await step("receiving", visit("/app/procurement/receiving"));
  await step("print preview", async () => {
    // The receive sheet prints from a receipt's detail page: open the first
    // receipt on the receiving list, then its print button.
    await page.goto("/app/procurement/receiving");
    await settle();
    const receipt = page.locator('a[href^="/app/procurement/receiving/"]:not([href$="/new"]):visible').first();
    if (!(await receipt.count())) throw new Error("the receiving list has no receipt to open");
    await receipt.click();
    await settle();
    const button = page.getByTestId("receiving-print-sheet");
    await button.waitFor();
    await button.click();
    const opened = page.url().replace(/^https?:\/\/[^/]+/, "");
    currentStep = `print preview (${opened})`;
    const print = page.getByTestId("print-document-button");
    await print.waitFor();
    // Headless Chromium has no print dialog; record the call instead.
    await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
    await print.click();
    if (!(await page.evaluate(() => window.__printed === true))) throw new Error("print was not called");
  });
  await step("inventory", visit("/app/inventory/stock"));
  await step("reports overview", visit("/app/reports/overview"));
  await step("report chart PNG and CSV export", async () => {
    const image = page.locator('button[aria-label^="Download image"]:not([disabled])').first();
    await image.waitFor({ timeout: 15_000 });
    const png = page.waitForEvent("download");
    await image.click();
    const pngName = (await png).suggestedFilename();
    if (!pngName.endsWith(".png")) throw new Error(`image download was ${pngName}`);
    const csv = page.waitForEvent("download");
    await page.locator('button[aria-label^="Download CSV"]:not([disabled])').first().click();
    await csv;
    await page.locator('button[aria-label^="Focus mode"]:not([disabled])').first().click();
    await page.getByRole("button", { name: "Close focus mode" }).click();
  });
  await step("reports procurement", visit("/app/reports/procurement"));
  await step("reports inventory", visit("/app/reports/inventory"));
  await step("settings: AI", visit("/app/settings/ai"));
  await step("settings: numbering", visit("/app/settings/numbering"));
  await step("settings: company and documents", visit("/app/settings/company"));
  await step("settings: warehouse access", visit("/app/settings/warehouse-access"));
  await step("purchase order document", visit("/app/procurement/orders/LOCAL-DEMO-PO-002/document"));
  await step("print templates", visit("/app/master-data/print-templates"));
  await step("contracts", visit("/app/contracts/list"));
  await step("contract signed file upload and download", async () => {
    await page.goto("/app/contracts/LOCAL-DEMO-CT-001");
    await page.getByTestId("contract-file-input").setInputFiles({ name: "csp-check.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 csp check") });
    await page.getByTestId("contract-file-name").first().waitFor();
    const download = page.waitForEvent("download");
    await page.getByTestId("contract-file-download").first().click();
    if (!(await download).suggestedFilename().endsWith(".pdf")) throw new Error("the signed file did not download");
  });
  await step("assistant panel", async () => {
    await page.goto("/app/overview/risks");
    await page.getByTestId("ai-assistant-toggle").click();
    const panel = page.getByTestId("ai-assistant-panel");
    await panel.waitFor();
    const answers = panel.locator("[data-answer-source]");
    const before = await answers.count();
    await panel.getByTestId("ai-empty-prompt-chip").first().click();
    await answers.nth(before).waitFor({ timeout: 20_000 });
  });
} catch (error) {
  console.error(`[csp-live] ${error?.message || error}`);
  exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  stopApi();
}

// The self-test's own violation is expected and not a finding.
for (const list of [violations, cspConsole]) {
  for (let at = list.length - 1; at >= 0; at -= 1) if (list[at].step === SELF_TEST) list.splice(at, 1);
}
console.log(JSON.stringify({ violations, cspConsole, stepFailures, otherErrors }, null, 2));
// Without the header or a working listener the check proves nothing. Other
// step failures (a page or button that moved) are listed but do not fail it.
const blocking = stepFailures.some((failure) => ["sign-in page", SELF_TEST].includes(failure.step));
if (exitCode === 0 && (violations.length || cspConsole.length || blocking)) exitCode = 1;
console.log(`[csp-live] ${violations.length} violation(s), ${cspConsole.length} CSP console message(s), ${stepFailures.length} step failure(s)`);
process.exit(exitCode);
