import { expect, test, type Page } from "@playwright/test";

// A US viewer of the walkthrough must not see Chinese. Language names are shown
// in their own language on purpose (the language selector offers 中文).
const CJK = /[㐀-鿿]/;
const ALLOWED = [/^中文$/, /^简体中文/];

// Pages on the US walkthrough, including list, detail and settings views that
// were translated. Each entry must render real seeded data or its own empty
// state; a page that is still loading fails the test instead of passing it.
const ROUTES = [
  "/app/overview/risks",
  "/app/overview/ai",
  "/app/procurement/workbench",
  "/app/procurement/orders",
  "/app/procurement/orders/LOCAL-DEMO-PO-002",
  "/app/procurement/requests",
  "/app/procurement/requests/LOCAL-DEMO-PR-001",
  "/app/procurement/rfq",
  "/app/procurement/rfq/LOCAL-DEMO-RFQ-AWARD-001",
  "/app/procurement/rfq/LOCAL-DEMO-RFQ-AWARD-001/comparison",
  "/app/procurement/receiving",
  "/app/procurement/receiving/new",
  "/app/procurement/order-lines",
  "/app/procurement/bills",
  "/app/procurement/bills/LOCAL-DEMO-INV-001",
  "/app/procurement/three-way-match",
  "/app/inventory/stock",
  "/app/inventory/movements",
  "/app/inventory/warnings",
  "/app/sales/orders",
  "/app/master-data/items",
  "/app/master-data/suppliers",
  "/app/master-data/suppliers/LOCAL-DEMO-SUP-001",
  "/app/master-data/customers",
  "/app/master-data/warehouses",
  "/app/master-data/payment-terms",
  "/app/master-data/tax-codes",
  "/app/master-data/print-templates",
  "/app/reports/overview",
  "/app/reports/procurement",
  "/app/settings/numbering",
  "/app/settings/review",
  "/app/settings/modules",
  "/app/settings/ai",
  "/app/settings/audit",
];

async function signIn(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "English walkthrough", company: "FlowChain" },
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

// The bearer token signIn stored, for API reads made from the test itself.
async function authHeaders(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "English walkthrough", company: "FlowChain" },
  });
  return { authorization: `Bearer ${(await response.json()).token}` };
}

async function settledChineseLines(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/^(Checking access|Loading\b.*)$/)).toHaveCount(0);
  const text = await page.locator("body").innerText();
  return [...new Set(text.split(/\n+/).map((line) => line.trim())
    .filter((line) => CJK.test(line) && !ALLOWED.some((allowed) => allowed.test(line))))];
}

for (const path of ROUTES) {
  test(`English walkthrough shows no Chinese on ${path}`, async ({ page }) => {
    await signIn(page);
    await page.goto(path);
    expect(await settledChineseLines(page)).toEqual([]);
  });
}

test("the tax code table keeps every stored digit and shows the recorded tax type", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/master-data/tax-codes");
  const row = page.getByRole("row", { name: /SALES825/ });
  await expect(row).toContainText("8.25%");
  await expect(row).toContainText("Sales tax");
  await expect(row).toContainText("US");
  await expect(page.getByRole("row", { name: /TAXEXEMPT/ })).toContainText("Exempt");
});

test("variance types show as labels, not stored codes", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-001");
  await expect(page.getByText("LOCAL-DEMO-INV-001", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Price variance", { exact: true }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("price_variance");
});

// Stored status and type codes such as "issued" or "partially_received".
const RAW_CODE_LINE = /[a-z]+_[a-z]+|^(draft|submitted|pending|approved|rejected|cancelled|issued|received|partial|posted|mismatch|matched|active|available|open|closed)$/;

async function rawCodeLines(page: Page, root = page.locator("main").first()) {
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/^(Checking access|Loading\b.*)$/)).toHaveCount(0);
  const text = await root.innerText();
  return [...new Set(text.split(/\n+/).map((line) => line.trim()).filter((line) => RAW_CODE_LINE.test(line)))];
}

test("purchase order detail shows the translated status, not the stored code", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-022");
  await expect(page.getByText("LOCAL-DEMO-PO-022", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  expect(await rawCodeLines(page)).toEqual([]);
  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-002");
  await expect(page.getByText("Issued", { exact: true }).first()).toBeVisible();
  expect(await rawCodeLines(page)).toEqual([]);
});

for (const path of [
  "/app/procurement/requests/LOCAL-DEMO-PR-001",
  "/app/procurement/rfq/LOCAL-DEMO-RFQ-AWARD-001",
  "/app/procurement/receiving/LOCAL-DEMO-GRN-001",
  "/app/procurement/bills/LOCAL-DEMO-INV-001",
  "/app/procurement/three-way-match/MATCH-LOCAL-DEMO-INV-001",
]) {
  test(`detail page ${path} shows labels, not stored status or type codes`, async ({ page }) => {
    await signIn(page);
    await page.goto(path);
    await expect(page.getByText(path.split("/").pop()!, { exact: true }).first()).toBeVisible();
    expect(await rawCodeLines(page)).toEqual([]);
  });
}

for (const path of [
  "/app/procurement/orders/LOCAL-DEMO-PO-002",
  "/app/procurement/rfq/LOCAL-DEMO-RFQ-AWARD-001",
  "/app/procurement/receiving/LOCAL-DEMO-GRN-001",
  "/app/inventory/stock",
  "/app/inventory/movements",
]) {
  test(`${path} names the warehouse instead of showing its id`, async ({ page }) => {
    await signIn(page);
    const { options } = await (await page.request.get("/api/master-data/warehouses/select", { headers: await authHeaders(page) })).json();
    const warehouse = options.find((option: { id: string }) => option.id === "LOCAL-DEMO-WH-001").label;
    await page.goto(path);
    await expect(page.getByText(warehouse).first()).toBeVisible();
    await expect(page.locator("main").first()).not.toContainText("LOCAL-DEMO-WH-001");
  });
}

test("the new purchase request defaults to the workspace currency and lists it first", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/requests");
  const currency = page.getByRole("combobox", { name: "Default currency" });
  await expect(currency).toHaveValue("USD");
  const codes = await currency.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));
  expect(codes[0]).toBe("USD");
  expect(codes.indexOf("CNY")).toBeGreaterThan(codes.indexOf("EUR"));
});

test("purchase request amounts use the document currency", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/requests");
  await expect(page.getByRole("row", { name: /LOCAL-DEMO-PR-001/ })).toContainText("$5,000.00");
  await page.goto("/app/procurement/requests/LOCAL-DEMO-PR-001");
  await expect(page.getByText("$5,000.00").first()).toBeVisible();
  await page.goto("/app/overview/risks");
  await expect(page.getByText("Request amount $5,000.00")).toBeVisible();
  await expect(page.getByRole("row", { name: /LOCAL-DEMO-PO-013/ })).toContainText("$2,460.00");
  await expect(page.locator("main").first()).not.toContainText(/Request amount 5000|\b2460\.0000\b/);
});

test("the purchase orders header totals committed orders only, per currency", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/orders");
  // 26 committed orders; the 35 loaded include drafts, pending approvals and cancellations.
  const committed = page.getByRole("link", { name: /Committed PO value/ });
  await expect(committed).toContainText("$79,692.50");
  await expect(committed).toContainText("26 committed orders");
  await expect(page.locator("main").first()).not.toContainText("$116,795.00");
  // Open purchase orders match the open purchase orders report.
  await expect(page.getByRole("link", { name: /Open purchase orders/ })).toContainText("15");
});

test("frozen and unavailable modules have no entry point and show Capability unavailable", async ({ page }) => {
  await signIn(page);
  for (const path of ["/app/finance/settlement", "/app/finance/reconciliation", "/app/mobile/settlements/any", "/app/forecast/mrp", "/app/forecast/cockpit", "/app/imports/failed"]) {
    await page.goto(path);
    await expect(page.getByTestId("capability-route-blocked"), path).toBeVisible();
    await expect(page.getByText("Capability unavailable", { exact: true })).toBeVisible();
  }
  await page.goto("/app/overview/risks");
  const links = await page.locator("a[href], [href]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") || ""));
  expect(links.filter((href) => /\/app\/(finance\/settlement|finance\/reconciliation|mobile\/settlements|forecast|imports)\b/.test(href))).toEqual([]);
  await expect(page.locator("aside, nav").first()).not.toContainText(/Settlement|Cashbook|Forecast|MRP|Imports/);
});

test("an unknown address offers English recovery to the module and to home", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/inventory/not-a-real-page");
  const recovery = page.getByTestId("not-found-recovery");
  await expect(recovery).toContainText("Page not found");
  await expect(recovery).toContainText("Inventory has no page at this address.");
  expect(await settledChineseLines(page)).toEqual([]);
  await page.getByRole("button", { name: "Go to Inventory" }).click();
  await expect(page).toHaveURL(/\/app\/inventory\/stock$/);
  await page.goto("/app/not-a-real-module");
  await expect(page.getByTestId("not-found-recovery")).toContainText("This link does not exist or has been removed.");
  await page.getByRole("button", { name: "Go to home" }).click();
  await expect(page).toHaveURL(/\/app\/overview(\/|$)/);
  // Under the home module there is one way back, not a second "Go to Home".
  await page.goto("/app/overview/not-a-real-page");
  await expect(page.getByTestId("not-found-recovery").getByRole("button")).toHaveText(["Go to home"]);
});

// The short English check of the walkthrough pages: no Chinese, no stored
// status or type codes, no raw UUIDs and no unformatted money.
const RAW_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
// A database decimal such as 2460.0000, or an amount label with a bare number.
const UNFORMATTED_MONEY = /\b\d+\.\d{4}\b|\b(amount|total|price|value)\s+\d{3,}(\.\d+)?$/i;
const RAW_FLAG = /^(true|false|null|undefined|NaN)$|\bisOpen\b/;

for (const path of [
  "/app/overview/risks",
  "/app/procurement/requests",
  "/app/procurement/orders",
  "/app/procurement/orders/LOCAL-DEMO-PO-001",
  "/app/procurement/receiving",
  "/app/procurement/bills",
  "/app/procurement/three-way-match",
  "/app/inventory/stock",
  "/app/inventory/movements",
  "/app/reports/overview",
  "/app/finance/overview",
]) {
  test(`English check of ${path}: no raw codes, ids or unformatted money`, async ({ page }) => {
    await signIn(page);
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/^(Checking access|Loading\b.*)$/)).toHaveCount(0);
    const cells = await page.locator("main").first().evaluate((root) => {
      const texts: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = (node.textContent || "").trim();
        if (value && (node.parentElement?.offsetParent !== null)) texts.push(value);
      }
      return texts;
    });
    const lines = [...new Set([...(await page.locator("main").first().innerText()).split(/\n+/), ...cells].map((line) => line.trim()).filter(Boolean))];
    const problems = lines.filter((line) =>
      (CJK.test(line) && !ALLOWED.some((allowed) => allowed.test(line))) ||
      RAW_CODE_LINE.test(line) || RAW_UUID.test(line) || UNFORMATTED_MONEY.test(line) || RAW_FLAG.test(line));
    expect(problems).toEqual([]);
  });
}
