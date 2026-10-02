import { expect, test, type Page } from "@playwright/test";

// The manager seeded by scripts/browser-product-recovery-api.mjs.
async function openLoggedInApp(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const response = await page.request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Kim", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

async function expectWorkbenchWidth(page: Page) {
  const scope = page.getByTestId("module-export-scope");
  await expect(scope).toBeVisible();
  const box = await scope.boundingBox();
  expect(box?.width || 0).toBeGreaterThan(1180);
  expect(box?.width || 0).toBeLessThanOrEqual(1602);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
}

test("wide workbench layout is available across operational pages without page overflow", async ({ page }) => {
  await openLoggedInApp(page);
  for (const path of [
    "/app/overview/risks", "/app/overview/ai", "/app/master-data/items", "/app/master-data/suppliers",
    "/app/procurement/workbench", "/app/procurement/orders", "/app/procurement/receiving",
    "/app/sales/orders", "/app/inventory/stock", "/app/reports/overview", "/app/settings/company",
  ]) {
    await page.goto(path);
    await expectWorkbenchWidth(page);
  }
});
