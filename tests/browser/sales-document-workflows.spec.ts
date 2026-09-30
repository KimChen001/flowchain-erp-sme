import { expect, test, type Page } from "@playwright/test";

const user = { id: "sales-doc-user", company: "新辰智能制造", name: "张磊", email: "zhanglei@example.com", role: "供应链经理" };

async function openLoggedInApp(page: Page) {
  await page.addInitScript((profile) => { localStorage.setItem("flowchain:auth-token", "sales-doc-token"); localStorage.setItem("flowchain:current-user", JSON.stringify(profile)); }, user);
  await page.goto("/"); await expect(page.getByTestId("app-main")).toBeVisible();
}

test("sales returns have a separate list surface", async ({ page }) => {
  await openLoggedInApp(page);
  await page.goto("/app/sales/returns");
  const returns = page.getByTestId("sales-return-page");
  await expect(returns).toContainText("退货原因"); await expect(returns).toContainText("处理状态");
});

test("risk and evidence remain independent sales views", async ({ page }) => {
  await openLoggedInApp(page);
  await page.goto("/app/sales/risks"); await expect(page.getByRole("heading", { name: "交付风险", exact: true })).toBeVisible(); await expect(page.locator("body")).not.toContainText("SO-2026-0412-A");
  await page.goto("/app/sales/evidence"); await expect(page.getByRole("heading", { name: "订单证据链", exact: true })).toBeVisible(); await expect(page.locator("body")).not.toContainText("SO-2026-0412-A");
});
