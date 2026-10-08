import { expect, test, type Page } from "@playwright/test";

// The US trial screens in English. Run by scripts/run-product-recovery-playwright.mjs
// with PLAYWRIGHT_US_TRIAL=true (the US trial capability set, so finance, sales
// and inventory operations are on) in two phases: on the walkthrough data and,
// with PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY=true, on an empty workspace. Each
// screen must render (its records or its empty state, not "Capability
// unavailable") and show no Chinese in its text or in the labels, placeholders
// and titles of its controls.
const CJK = /[㐀-鿿]/;
// Language names are shown in their own language on purpose.
const ALLOWED = [/^中文$/, /^简体中文/];

const ROUTES = [
  "/app/overview",
  "/app/overview/risks",
  "/app/procurement/workbench",
  "/app/procurement/requests",
  "/app/procurement/orders",
  "/app/procurement/receiving",
  "/app/procurement/bills",
  "/app/procurement/three-way-match",
  // Unfiltered: the inventory filter chips are translated in #182.
  "/app/inventory/stock",
  "/app/inventory/transfers",
  "/app/inventory/transfers/new",
  "/app/inventory/counts",
  "/app/inventory/counts/new",
  "/app/inventory/adjustments",
  "/app/inventory/adjustments/new",
  "/app/sales/risks",
  // Without an order selected: the evidence graph of an order carries the
  // server's Chinese risk summaries (docs/interface-language-policy.md).
  "/app/sales/evidence",
  "/app/sales/invoices",
  "/app/finance/overview",
  "/app/finance/payables",
  "/app/finance/receivables",
  "/app/finance/aging",
  "/app/reports/overview",
  // Deferred: /app/sales/orders (OutboundWorkbench) keeps Chinese copy until
  // #173 and #178 land.
];

async function signIn(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "English trial", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: "en-US", defaultLanguage: "en-US", effectiveLanguage: "en-US", locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/^(Checking access|Loading\b.*)$/)).toHaveCount(0);
}

// The read-only notices a screen shows when its capability is off.
const CAPABILITY_OFF = /Capability unavailable|An administrator has not enabled|This capability is not enabled|This feature is not enabled/;

// The page rendered its records or its empty state, with its capability on.
async function expectRendered(page: Page, path: string) {
  await expect(page.getByTestId("capability-route-blocked"), path).toHaveCount(0);
  await expect(page.getByTestId("not-found-recovery"), path).toHaveCount(0);
  const main = page.locator("main").first();
  await expect(main, path).toBeVisible();
  const text = (await main.innerText()).trim();
  expect(text.length, path).toBeGreaterThan(0);
  expect(text, path).not.toMatch(CAPABILITY_OFF);
}

// No Chinese in the page text or in the visible controls' aria-label,
// placeholder and title (the pattern of operations-language.spec.ts).
async function expectEnglish(page: Page) {
  const text = await page.locator("body").innerText();
  const lines = [...new Set(text.split(/\n+/).map((line) => line.trim())
    .filter((line) => CJK.test(line) && !ALLOWED.some((allowed) => allowed.test(line))))];
  expect(lines).toEqual([]);
  const attributes = await page.locator("input,select,textarea,button,a,[role]").evaluateAll((nodes) => nodes
    .filter((node) => node.getClientRects().length)
    .flatMap((node) => ["aria-label", "placeholder", "title"].map((key) => node.getAttribute(key) || "")));
  expect(attributes.filter((value) => CJK.test(value))).toEqual([]);
}

for (const path of ROUTES) {
  test(`English trial: ${path} renders in English`, async ({ page }) => {
    await signIn(page);
    await page.goto(path);
    await settle(page);
    await expectRendered(page, path);
    await expectEnglish(page);
  });
}

test("English trial: the assistant opens in English", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/overview/risks");
  await settle(page);
  await page.getByTestId("ai-assistant-toggle").click();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("ai-empty-prompt-chip").first()).toBeVisible();
  await expectEnglish(page);
});
