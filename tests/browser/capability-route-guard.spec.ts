import { expect, test, type Page } from "@playwright/test";

// The manager seeded by scripts/browser-product-recovery-api.mjs, where
// operational finance stays disabled. The workspace defaults to Chinese.
async function authenticate(page: Page, experimentalModules: string[] = []) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Kim", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user, experiments }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
    localStorage.setItem("flowchain:experimental-modules", JSON.stringify(experiments));
  }, { ...session, experiments: experimentalModules });
}

test("finance direct URL is blocked while its database capability is disabled", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/finance/invoices");
  const blocked = page.getByTestId("capability-route-blocked");
  await expect(blocked).toContainText("能力暂不可用");
  await expect(blocked).toContainText("权限已具备，但该业务能力当前未启用。");
});

// Forecast / MRP is unavailable: the old local experiment switch must not open it.
test("forecast direct URL stays unavailable even with the local experiment switched on", async ({ page }) => {
  await authenticate(page, ["forecast"]);
  await page.goto("/app/forecast/cockpit");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("该冻结业务能力未作为正式产品功能启用。");
  await expect(page.locator("[data-planning-view]")).toHaveCount(0);
});

test("stable procurement direct URL renders normally", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/procurement/requests");
  await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
  await expect(page.getByTestId("module-title")).toHaveText("采购");
  await expect(page.getByTestId("app-main")).toBeVisible();
});

test("capability API failure closes capability-gated routes while stable routes stay available", async ({ page }) => {
  await authenticate(page);
  await page.route("**/api/capabilities", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
  await page.goto("/app/finance/invoices");
  await expect(page.getByTestId("capability-registry-unavailable")).toContainText("能力注册表暂不可用");
  await page.goto("/app/procurement/requests");
  await expect(page.getByTestId("capability-registry-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("module-title")).toHaveText("采购");
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
