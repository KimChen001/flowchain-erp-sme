import { expect, test, type Page } from "@playwright/test";

// The supplier Performance tab and the Suppliers performance table in English,
// on the walkthrough scenario (seeded for today by the product recovery API).
// Northstar has 6 received lines in the last 90 days: 4 on time against the
// date first promised and 6 against the current date (OTIF 3 against 5),
// because two orders were re-promised and arrived on the new date.
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

test("the supplier Performance tab shows on time against the original promise and the current date, with the lines behind it", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/master-data/suppliers/LOCAL-DEMO-SUP-005");
  await page.getByTestId("supplier-tab-performance").click();
  const panel = page.getByTestId("supplier-performance-panel");
  await expect(panel.getByRole("heading", { name: "Supplier performance" })).toBeVisible();
  const onTime = panel.getByTestId("supplier-performance-on-time");
  await expect(onTime).toContainText("On time vs original promise · vs current date");
  await expect(onTime).toContainText("66.7% · 100%");
  await expect(onTime).toContainText("4/6 · 6/6");
  const otif = panel.getByTestId("supplier-performance-otif");
  await expect(otif).toContainText("OTIF vs original promise · vs current date");
  await expect(otif).toContainText("50% · 83.3%");
  await expect(panel).toContainText("2 lines had their promised date revised after the PO was issued.");
  await expect(panel.getByTestId("supplier-performance-on-time-interval")).toContainText("95% range");

  // The figure drills down to its lines: the re-promised orders are marked.
  await onTime.click();
  const drilldown = panel.getByTestId("supplier-performance-drilldown");
  await expect(drilldown).toContainText("Lines behind On time vs original promise");
  await panel.getByTestId("supplier-performance-lines").click();
  const revised = drilldown.getByTestId("supplier-performance-line-LOCAL-DEMO-PO-033-LINE-001");
  await expect(revised).toContainText("Revised");
  await expect(revised).toContainText("Late");

  // The definition explains the rule in plain English.
  await panel.getByTestId("supplier-performance-definition-toggle").click();
  await expect(panel.getByTestId("supplier-performance-definition")).toContainText("original promised date");

  // A shorter period has too few lines for percentages.
  await panel.getByRole("button", { name: "Last 30 days" }).click();
  await expect(panel.getByTestId("supplier-performance-insufficient")).toContainText("Insufficient sample · 3 lines");
  await expect(panel.getByTestId("supplier-performance-on-time")).toContainText("Insufficient sample");

  const text = await panel.innerText();
  expect(text.split(/\n+/).filter((line) => CJK.test(line))).toEqual([]);
});

test("Reports › Supplier analytics lists every supplier's performance for the period", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/reports/suppliers");
  const table = page.getByTestId("supplier-performance-table");
  const northstar = table.getByTestId("supplier-performance-row-LOCAL-DEMO-SUP-005");
  await expect(northstar).toContainText("66.7%");
  await expect(northstar).toContainText("100%");
  await expect(northstar).toContainText("83.3%");
  await expect(table.getByTestId("supplier-performance-row-LOCAL-DEMO-SUP-001")).toContainText("Insufficient sample");
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
  const onTime = panel.getByTestId("supplier-performance-on-time");
  await expect(onTime).toContainText("按原始承诺准时率 · 按当前日期");
  // Language changes the copy, not the workspace's number format.
  await expect(onTime).toContainText("66.7% · 100%");
  await expect(panel.getByTestId("supplier-performance-otif")).toContainText("按原始承诺 OTIF");
  await panel.getByTestId("supplier-performance-definition-toggle").click();
  await expect(panel.getByTestId("supplier-performance-definition")).toContainText("原始承诺交期");
  await expect(panel).not.toContainText("On time vs original promise");
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
