import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, request: Parameters<Parameters<typeof test>[1]>[0]["request"]) {
  const response = await request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Read States", company: "Read States" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

test("fresh empty PostgreSQL keeps the sales list truthful", async ({ page, request }) => {
  await login(page, request);
  await page.goto("/app/sales/orders");
  await expect(page.getByTestId("outbound-order-list")).toBeVisible();
  await expect(page.getByText("暂无符合当前筛选条件的正式销售订单。")).toBeVisible();
  await expect(page.getByText(/LOCAL-DEMO-SO-|SO-PERMISSION|演示销售订单/)).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

for (const [label, result, expected] of [
  ["401", { status: 401, body: { code: "INVALID_SESSION" } }, "登录已失效，请重新登录后读取销售订单。"],
  ["403", { status: 403, body: { code: "PERMISSION_DENIED" } }, "当前账号没有读取销售订单的权限。"],
  ["500", { status: 500, body: { code: "INTERNAL_ERROR" } }, "销售订单服务暂时不可用，请稍后重试。"],
] as const) {
  test(`${label} read error has a distinct state without fallback rows`, async ({ page, request }) => {
    await login(page, request);
    await page.route("**/api/sales/orders?*", (route) => route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: JSON.stringify(result.body),
    }));
    await page.goto("/app/sales/orders");
    await expect(page.getByRole("alert")).toContainText(expected);
    await expect(page.locator("tbody tr")).toHaveCount(0);
  });
}

test("network failure has a distinct state without fallback rows", async ({ page, request }) => {
  await login(page, request);
  await page.route("**/api/sales/orders?*", (route) => route.abort("failed"));
  await page.goto("/app/sales/orders");
  await expect(page.getByRole("alert")).toContainText("网络连接失败，请检查连接后重试。");
  await expect(page.locator("tbody tr")).toHaveCount(0);
});
