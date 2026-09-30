import { expect, test, type Page } from "@playwright/test";

const user = { id: "list-state-user", company: "新辰智能制造", name: "张磊", email: "list@example.com", role: "供应链经理" };
async function open(page: Page, path: string) {
  await page.addInitScript((profile) => {
    localStorage.setItem("flowchain:auth-token", "list-state-token");
    localStorage.setItem("flowchain:current-user", JSON.stringify(profile));
  }, user);
  await page.goto(path);
  await expect(page.getByTestId("app-main")).toBeVisible();
}

test("recent pages are bounded, closable and persistent", async ({ page }) => {
  await open(page, "/app/overview");
  for (const path of ["/app/master-data/items", "/app/procurement/orders", "/app/sales/orders", "/app/inventory/warnings", "/app/inventory/adjustments", "/app/finance/invoices", "/app/reports", "/app/settings"]) {
    await page.goto(path);
  }
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("flowchain:recent-pages:v1") || "[]"));
  expect(stored.length).toBeLessThanOrEqual(8);
  await page.reload();
  await expect(page.getByTestId("recent-pages")).toBeVisible();
  await expect(page.getByTestId("recent-pages").locator("[aria-current='page']")).toBeVisible();
  const beforeClose = await page.getByTestId("recent-pages").locator(".fc-recent-page").count();
  await page.getByTestId("recent-pages").getByLabel(/关闭 /).first().click();
  await expect(page.getByTestId("recent-pages").locator(".fc-recent-page")).toHaveCount(beforeClose - 1);
});
