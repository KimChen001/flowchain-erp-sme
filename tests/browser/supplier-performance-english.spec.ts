import { expect, test, type Page } from "@playwright/test";

// The supplier Performance tab and the Suppliers performance table in English,
// on the walkthrough scenario (seeded for today by the product recovery API).
// Northstar Logistics has 6 received lines in the last 90 days: 3 on time
// against the date first promised, 5 against the current date, because two
// orders were re-promised and arrived on the new date.
const CJK = /[㐀-鿿]/;

async function signIn(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Supplier performance", company: "FlowChain" },
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

test("the supplier Performance tab shows on time against the original promise and the current date, with the lines behind it", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/master-data/suppliers/LOCAL-DEMO-SUP-005");
  await page.getByTestId("supplier-tab-performance").click();
  const panel = page.getByTestId("supplier-performance-panel");
  await expect(panel.getByRole("heading", { name: "Supplier performance" })).toBeVisible();
  const onTime = panel.getByTestId("supplier-performance-on-time");
  await expect(onTime).toContainText("On time vs original promise · vs current date");
  await expect(onTime).toContainText("50% · 83.3%");
  await expect(onTime).toContainText("3/6 · 5/6");
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
  await expect(northstar).toContainText("50%");
  await expect(northstar).toContainText("83.3%");
  await expect(table.getByTestId("supplier-performance-row-LOCAL-DEMO-SUP-001")).toContainText("Insufficient sample");
  await northstar.getByRole("button", { name: "View lines" }).click();
  await expect(table.getByTestId("supplier-performance-figures")).toBeVisible();
  const text = await table.innerText();
  expect(text.split(/\n+/).filter((line) => CJK.test(line))).toEqual([]);
});
