import { expect, test, type Page } from "@playwright/test";

// The supplier Performance tab and the Suppliers performance table in English,
// on the walkthrough scenario (seeded for today by the product recovery API).
// Northstar has 7 deliveries (one PO line each) in the last 90 days: 4 on time
// against the date first on the PO and 6 against the current date (OTIF 3
// against 5), because two orders were re-promised and arrived on the new date,
// and PO-023, approved and due yesterday, has nothing received.
const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN" = "en-US") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Supplier performance", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

test("the supplier Performance tab shows on time against the date on the PO and the current date, with the deliveries behind it", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/master-data/suppliers/LOCAL-DEMO-SUP-005");
  await page.getByTestId("supplier-tab-performance").click();
  const panel = page.getByTestId("supplier-performance-panel");
  await expect(panel.getByRole("heading", { name: "Supplier performance" })).toBeVisible();
  // Until suppliers confirm dates, the measure names the date on the PO.
  await expect(panel.getByTestId("supplier-performance-basis")).toContainText("Measured against the date on the PO, which may be the buyer's need date.");
  const onTime = panel.getByTestId("supplier-performance-on-time");
  await expect(onTime).toContainText("On time vs the date on the PO · vs current date");
  await expect(onTime).toContainText("57.1% · 85.7%");
  await expect(onTime).toContainText("4/7 · 6/7");
  const otif = panel.getByTestId("supplier-performance-otif");
  await expect(otif).toContainText("OTIF vs the date on the PO · vs current date");
  await expect(otif).toContainText("42.9% · 71.4%");
  await expect(panel).toContainText("2 lines had their promised date revised after the PO was issued.");
  await expect(panel.getByTestId("supplier-performance-on-time-interval")).toContainText("95% range");

  // The figure drills down to its deliveries and their lines: the re-promised
  // orders are marked.
  await onTime.click();
  const drilldown = panel.getByTestId("supplier-performance-drilldown");
  await expect(drilldown).toContainText("Deliveries behind On time vs the date on the PO");
  await panel.getByTestId("supplier-performance-lines").click();
  const revised = drilldown.getByTestId("supplier-performance-line-LOCAL-DEMO-PO-033-LINE-001");
  await expect(revised).toContainText("Revised");
  await expect(revised).toContainText("Late");

  // The definition explains the rule in plain English.
  await panel.getByTestId("supplier-performance-definition-toggle").click();
  await expect(panel.getByTestId("supplier-performance-definition")).toContainText("original promised date");
  await expect(panel.getByTestId("supplier-performance-definition")).toContainText("may be the buyer's need date");

  // A shorter period has too few deliveries for percentages.
  await panel.getByRole("button", { name: "Last 30 days" }).click();
  await expect(panel.getByTestId("supplier-performance-insufficient")).toContainText("Fewer than 5 deliveries · 4 deliveries");
  await expect(panel.getByTestId("supplier-performance-on-time")).toContainText("Fewer than 5 deliveries");

  const text = await panel.innerText();
  expect(text.split(/\n+/).filter((line) => CJK.test(line))).toEqual([]);
});

test("Reports › Supplier analytics lists every supplier's performance for the period", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/reports/suppliers");
  const table = page.getByTestId("supplier-performance-table");
  await expect(table.getByTestId("supplier-performance-basis")).toContainText("may be the buyer's need date");
  const northstar = table.getByTestId("supplier-performance-row-LOCAL-DEMO-SUP-005");
  await expect(northstar).toContainText("57.1%");
  await expect(northstar).toContainText("85.7%");
  await expect(northstar).toContainText("71.4%");
  await expect(table.getByTestId("supplier-performance-row-LOCAL-DEMO-SUP-001")).toContainText("Fewer than 5 deliveries");
  await northstar.getByRole("button", { name: "View lines" }).click();
  await expect(table.getByTestId("supplier-performance-figures")).toBeVisible();
  const text = await table.innerText();
  expect(text.split(/\n+/).filter((line) => CJK.test(line))).toEqual([]);
});

test("the Performance tab reads in Chinese with the same figures and number format", async ({ page }) => {
  await signIn(page, "zh-CN");
  await page.goto("/app/master-data/suppliers/LOCAL-DEMO-SUP-005");
  await page.getByTestId("supplier-tab-performance").click();
  const panel = page.getByTestId("supplier-performance-panel");
  await expect(panel.getByRole("heading", { name: "供应商绩效" })).toBeVisible();
  await expect(panel.getByTestId("supplier-performance-basis")).toContainText("采购方的需求日期");
  const onTime = panel.getByTestId("supplier-performance-on-time");
  await expect(onTime).toContainText("按采购订单日期准时率 · 按当前日期");
  // Language changes the copy, not the workspace's number format.
  await expect(onTime).toContainText("57.1% · 85.7%");
  await expect(panel.getByTestId("supplier-performance-otif")).toContainText("按采购订单日期 OTIF");
  await panel.getByTestId("supplier-performance-definition-toggle").click();
  await expect(panel.getByTestId("supplier-performance-definition")).toContainText("原始承诺交期");
  await expect(panel.getByTestId("supplier-performance-definition")).toContainText("采购方的需求日期");
  await expect(panel).not.toContainText("On time vs the date on the PO");
});

test("changing a promised date on an issued PO needs a reason and records a revision", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-002");
  const section = page.getByTestId("po-promise-dates");
  const row = section.getByTestId("po-promise-line-LOCAL-DEMO-PO-002-LINE-001");
  await expect(row).toBeVisible();
  const originalText = await row.locator("td").nth(1).innerText();
  await expect(section.getByText("No revisions")).toBeVisible();
  await section.getByTestId("po-promise-change-LOCAL-DEMO-PO-002-LINE-001").click();
  const form = section.getByTestId("po-promise-form");
  const dateInput = form.getByLabel("New promised date");
  const current = await dateInput.inputValue();
  const later = new Date(Date.parse(`${current}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  await dateInput.fill(later);
  // Without a reason nothing is saved.
  await form.getByRole("button", { name: "Save revision" }).click();
  await expect(page.getByText("Give a reason for the change.")).toBeVisible();
  await expect(section.getByText("No revisions")).toBeVisible();
  await form.getByLabel("Reason").fill("Supplier moved the ship date");
  await form.getByRole("button", { name: "Save revision" }).click();
  const history = section.getByTestId("po-promise-history");
  await expect(history).toContainText("Supplier moved the ship date");
  await expect(history.locator("li")).toHaveCount(1);
  // The original promise stays; the current date moves.
  await expect(row.locator("td").nth(1)).toHaveText(originalText);
  await expect(row.locator("td").nth(2)).not.toHaveText(originalText);
});
