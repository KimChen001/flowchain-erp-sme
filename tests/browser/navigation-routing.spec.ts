import { expect, test, type Page } from "@playwright/test";

const user = { id: "routing-user", company: "新辰智能制造", name: "张磊", email: "route@example.com", role: "供应链经理" };
async function authenticate(page: Page) {
  await page.addInitScript((profile) => {
    localStorage.setItem("flowchain:auth-token", "routing-token");
    localStorage.setItem("flowchain:current-user", JSON.stringify(profile));
  }, user);
}

test("deep links, refresh, browser history and registry-driven shell stay synchronized", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/inventory/warnings");
  await expect(page).toHaveURL(/\/app\/inventory\/warnings$/);
  await expect(page.getByTestId("module-title")).toHaveText("库存管理");
  await expect(page.getByTestId("page-title")).toHaveText("库存预警");
  await expect(page.getByTestId("module-subnav").getByRole("link", { name: "库存预警" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("app-breadcrumb").locator("[aria-current='page']")).toHaveText("库存预警");
  await page.reload();
  await expect(page).toHaveURL(/\/app\/inventory\/warnings$/);
  await page.getByTestId("module-subnav").getByRole("link", { name: "库存调整单", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/inventory\/adjustments$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/inventory\/warnings$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/inventory\/adjustments$/);
});

test("unknown child paths offer module-aware recovery to the default route", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/inventory/not-a-real-page");
  await expect(page.getByTestId("not-found-recovery")).toContainText("库存管理");
  await page.getByRole("button", { name: "返回库存管理默认页面" }).click();
  await expect(page).toHaveURL(/\/app\/inventory\/stock$/);
  await expect(page.getByTestId("page-title")).toHaveText("库存查询");
});

test("all primary modules render through the same ModuleShell", async ({ page }) => {
  await authenticate(page);
  const routes = [
    ["overview", "首页"], ["master-data", "基础资料"], ["procurement", "采购管理"], ["sales", "销售管理"],
    ["inventory", "库存管理"], ["finance", "结算管理"], ["reports", "报表中心"], ["settings", "系统管理"],
  ];
  for (const [path, label] of routes) {
    await page.goto(`/app/${path}`);
    await expect(page.getByTestId("module-shell")).toBeVisible();
    await expect(page.getByTestId("module-title")).toHaveText(label);
  }
});
