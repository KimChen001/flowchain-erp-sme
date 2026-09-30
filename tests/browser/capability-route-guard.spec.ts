import { expect, test, type Page } from "@playwright/test";

const user = { id: "capability-user", company: "新辰智能制造", name: "能力测试员", email: "capability@example.com", role: "供应链经理" };

async function authenticate(page: Page, experimentalModules: string[] = []) {
  await page.addInitScript(({ profile, experiments }) => {
    localStorage.setItem("flowchain:auth-token", "capability-route-token");
    localStorage.setItem("flowchain:current-user", JSON.stringify(profile));
    localStorage.setItem("flowchain:experimental-modules", JSON.stringify(experiments));
  }, { profile: user, experiments: experimentalModules });
}

test("finance direct URL is blocked until its beta database capability is enabled", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/finance/invoices");
  const blocked = page.getByTestId("capability-route-blocked");
  await expect(blocked).toContainText("结算管理 当前不可进入");
  await expect(blocked).toContainText("beta");
  await expect(blocked).toContainText("without payment, collection, refund");
  await expect(blocked.getByRole("button", { name: "返回工作台" })).toBeVisible();
  await expect(blocked.getByRole("button", { name: "返回可用模块" })).toBeVisible();
});

test("forecast direct URL is fail-closed until its local experiment is enabled", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/forecast/cockpit");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("preview");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("本地实验设置中明确启用");
  await expect(page.locator("[data-planning-view]")).toHaveCount(0);
});

test("forecast direct URL renders after explicit local experiment opt-in", async ({ page }) => {
  await authenticate(page, ["forecast"]);
  await page.goto("/app/forecast/cockpit");
  await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
  await expect(page.locator("[data-planning-view='cockpit']")).toBeVisible();
  await expect(page.getByText("计划使用边界", { exact: true })).toBeVisible();
});

test("stable procurement direct URL renders normally", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/procurement/requests");
  await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
  await expect(page.getByTestId("module-title")).toHaveText("采购管理");
  await expect(page.getByTestId("app-main")).toBeVisible();
});

test("capability API failure keeps preview closed while stable fallback remains available", async ({ page }) => {
  await authenticate(page, ["forecast"]);
  await page.route("**/api/capabilities", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
  await page.goto("/app/forecast/cockpit");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("能力注册表暂不可用");
  await page.goto("/app/procurement/requests");
  await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
  await expect(page.getByTestId("module-title")).toHaveText("采购管理");
});

test("refreshing a disabled route never renders its internal panel", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/finance/invoices");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await expect(page.getByText("暂无供应商发票", { exact: true })).toHaveCount(0);
});

test("unauthenticated direct URL shows login before capability state", async ({ page }) => {
  await page.goto("/app/finance/invoices");
  await expect(page.getByRole("button", { name: /Email me a sign-in link|发送登录链接/ })).toBeVisible();
  await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
});
