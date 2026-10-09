import { expect, test, type Page } from "@playwright/test";

// The phone layout (mobile step 1, owner decisions of 2026-10-08): bottom
// tabs instead of the sidebar and the floating assistant button, tables as
// cards, filters in a bottom sheet and detail actions pinned at the bottom.
// Desktop keeps its layout.

async function signIn(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const response = await page.request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Kim", company: "FlowChain" },
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

const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("a phone gets bottom tabs, card lists and a filter sheet", async ({ page }) => {
  await signIn(page, { width: 390, height: 844 });
  for (const path of ["/app/overview/risks", "/app/procurement/orders", "/app/sales/orders", "/app/inventory/stock", "/app/master-data/items", "/app/master-data/suppliers"]) {
    await page.goto(path);
    await expect(page.getByTestId("app-main")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await pageOverflow(page), path).toBeLessThanOrEqual(1);
  }

  await page.goto("/app/procurement/orders");
  await expect(page.getByTestId("mobile-tab-bar")).toBeVisible();
  await expect(page.getByTestId("ai-assistant-toggle")).toBeHidden();
  // The order list is cards: no header row, each cell labelled by its column.
  const table = page.locator("main table").first();
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await expect(table).toHaveClass(/fc-cards/);
  await expect(table.locator("thead")).toBeHidden();
  await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveAttribute("data-label", "Suppliers");
  // The PO number stays in view; the other filters open as a sheet.
  await expect(page.getByPlaceholder("PO-2026-1287")).toBeVisible();
  await expect(page.getByPlaceholder("Supplier name")).toHaveCount(0);
  await page.getByTestId("filters-sheet-open").click();
  const sheet = page.getByTestId("filters-sheet");
  await expect(sheet.getByRole("dialog", { name: "Filters" })).toBeVisible();
  await sheet.getByPlaceholder("Supplier name").fill("Acme");
  await sheet.getByTestId("filters-sheet-done").click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("filters-sheet-open")).toContainText("1");

  // Approvals opens the approval inbox; More lists the other pages.
  await page.getByTestId("mobile-tab-approvals").click();
  await expect(page).toHaveURL(/\/app\/overview\/approvals$/);
  await expect(page.getByTestId("mobile-tab-approvals")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("mobile-tab-more").click();
  await page.getByTestId("mobile-more-sheet").getByRole("button", { name: "Items" }).click();
  await expect(page).toHaveURL(/\/app\/master-data\/items$/);

  // The assistant opens full screen from its tab.
  await page.getByTestId("mobile-tab-assistant").click();
  const panel = await page.getByTestId("ai-assistant-panel").boundingBox();
  expect(panel?.width).toBe(390);
  expect(panel?.height).toBe(844);
});

test("a phone pins a record's actions at the bottom", async ({ page }) => {
  await signIn(page, { width: 390, height: 844 });
  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-002");
  const actions = page.locator(".fc-detail-actions").first();
  await expect(actions).toBeVisible();
  expect(await actions.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  const box = await actions.boundingBox();
  const tabs = await page.getByTestId("mobile-tab-bar").boundingBox();
  expect(Math.round((box?.y || 0) + (box?.height || 0))).toBeLessThanOrEqual(Math.round(tabs?.y || 0) + 1);
});

test("desktop keeps the sidebar, tables and inline filters", async ({ page }) => {
  await signIn(page, { width: 1280, height: 900 });
  await page.goto("/app/procurement/orders");
  await expect(page.getByTestId("ai-assistant-toggle")).toBeVisible();
  await expect(page.getByTestId("mobile-tab-bar")).toBeHidden();
  await expect(page.getByTestId("filters-sheet-open")).toHaveCount(0);
  await expect(page.getByPlaceholder("Supplier name")).toBeVisible();
  await expect(page.locator("main table").first().locator("thead")).toBeVisible();
});
