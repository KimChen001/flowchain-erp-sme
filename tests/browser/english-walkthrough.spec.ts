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
  "/app/procurement/invoices",
  "/app/procurement/invoices/LOCAL-DEMO-INV-001",
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
  "/app/procurement/invoices/LOCAL-DEMO-INV-001",
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
