import { expect, test, type Page } from "@playwright/test";

// The manager seeded by scripts/browser-product-recovery-api.mjs. The workspace
// defaults to Chinese, so the shell labels below are the Chinese ones.
async function authenticate(page: Page) {
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

test("deep links, refresh, browser history and registry-driven shell stay synchronized", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/inventory/warnings");
  await expect(page).toHaveURL(/\/app\/inventory\/warnings$/);
  await expect(page.getByTestId("module-title")).toHaveText("库存");
  await expect(page.getByTestId("page-title")).toHaveText("库存预警");
  await expect(page.getByTestId("module-subnav").getByRole("link", { name: "库存预警" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("app-breadcrumb").locator("[aria-current='page']")).toHaveText("库存预警");
  await page.reload();
  await expect(page).toHaveURL(/\/app\/inventory\/warnings$/);
  await expect(page.getByTestId("page-title")).toHaveText("库存预警");
  await page.getByTestId("module-subnav").getByRole("link", { name: "库存流水", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/inventory\/movements$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/inventory\/warnings$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/inventory\/movements$/);
});

test("breadcrumb parents are links while current page is not a link", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/procurement/orders");
  const breadcrumb = page.getByTestId("app-breadcrumb");
  await expect(breadcrumb.getByRole("link", { name: "首页" })).toBeVisible();
  await expect(breadcrumb.getByRole("link", { name: "采购管理" })).toBeVisible();
  await expect(breadcrumb.locator("[aria-current='page']")).toHaveText("采购订单");
  await expect(breadcrumb.getByRole("link", { name: "采购订单" })).toHaveCount(0);
  await breadcrumb.getByRole("link", { name: "采购管理" }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/workbench$/);
});

test("unknown child paths offer module-aware recovery to the default route", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/inventory/not-a-real-page");
  await expect(page.getByTestId("not-found-recovery")).toContainText("库存");
  await page.getByRole("button", { name: /返回库存.*默认页面/ }).click();
  await expect(page).toHaveURL(/\/app\/inventory\/stock$/);
  await expect(page.getByTestId("page-title")).toHaveText("库存查询");
});

test("all available primary modules render through the same ModuleShell", async ({ page }) => {
  await authenticate(page);
  const routes = [
    ["overview", "今日"], ["master-data", "物料"], ["procurement", "采购"], ["sales", "销售"],
    ["inventory", "库存"], ["reports", "报表"], ["settings", "系统管理"],
  ];
  for (const [path, label] of routes) {
    await page.goto(`/app/${path}`);
    await expect(page.getByTestId("module-shell")).toBeVisible();
    await expect(page.getByTestId("module-title")).toHaveText(label);
    await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
  }
});
