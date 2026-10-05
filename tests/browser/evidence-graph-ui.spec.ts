import { expect, test, type Locator, type Page } from "@playwright/test";

// The order evidence page on the US walkthrough: choosing a sales order shows
// its evidence graph (the order and its item, the order's delivery risk, and
// what the graph cannot see yet), and a linked record opens its own page.
const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Order evidence", company: "FlowChain" },
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

const chineseLines = async (locator: Locator) => (await locator.innerText()).split(/\n+/).map((line) => line.trim()).filter((line) => CJK.test(line));

for (const [language, copy] of [
  ["en-US", { view: "View evidence", path: "Primary evidence path", order: "Customer order", limitations: "Manual review" }],
  ["zh-CN", { view: "查看证据", path: "主证据链", order: "客户订单", limitations: "人工复核" }],
] as const) {
  test(`a sales order's evidence graph shows its records, risk and limits and opens a linked record (${language})`, async ({ page }) => {
    await signIn(page, language);
    await page.goto("/app/sales/evidence");
    const row = page.getByTestId("module-export-scope").locator("tbody tr").filter({ has: page.getByRole("button", { name: copy.view }) }).first();
    const orderId = (await row.locator("td").first().innerText()).trim();
    const risk = (await row.locator("td").nth(4).innerText()).trim();
    await row.getByRole("button", { name: copy.view }).click();
    await expect(page).toHaveURL(new RegExp(`/app/sales/evidence\\?orderId=${encodeURIComponent(orderId)}$`));

    const graph = page.getByTestId("evidence-graph-panel");
    const path = graph.getByTestId("evidence-primary-path");
    await expect(path).toContainText(copy.path);
    await expect(path).toContainText(copy.order);
    await expect(path).toContainText(orderId);
    // The graph carries the delivery risk the order list shows.
    await expect(graph.getByTestId("evidence-risk-signals")).toContainText(risk);
    await expect(graph.getByTestId("evidence-data-limitations")).toContainText(copy.limitations);
    if (language === "en-US") expect(await chineseLines(graph)).toEqual([]);

    const related = graph.getByTestId("evidence-related-records").getByRole("button").first();
    await expect(related).toBeVisible();
    await related.click();
    await expect(page).not.toHaveURL(/\/app\/sales\/evidence/);
    await expect(page.getByTestId("app-main")).toBeVisible();
  });
}
