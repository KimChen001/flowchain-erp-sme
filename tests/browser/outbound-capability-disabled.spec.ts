import { expect, test } from "@playwright/test";

test("disabled outbound capability makes list and direct entry read-only", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Ignored", company: "Ignored" },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);

  await page.goto("/app/sales/orders");
  await expect(page.getByTestId("outbound-order-list")).toBeVisible();
  const orderRow = page
    .getByRole("row")
    .filter({ hasText: "SO-PERMISSION" });
  await expect(orderRow).toContainText("Permission Customer");
  await expect(orderRow).toContainText("SO-PERMISSION");
  await expect(page.getByRole("link", { name: "新建销售订单" })).toHaveCount(0);
  await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "销售订单工作台为只读状态",
  );

  await orderRow.getByRole("link", { name: "打开" }).click();
  await expect(page).toHaveURL(
    /\/app\/sales\/orders\/outbound-browser-permission-order$/,
  );
  await expect(page.getByTestId("outbound-order-workbench")).toBeVisible();
  await expect(page.getByRole("heading", { name: "SO-PERMISSION" })).toBeVisible();
  await expect(page.getByText("Permission Customer", { exact: false })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("页面为只读状态");
  await expect(page.getByTestId("confirm-sales-order")).toHaveCount(0);
  await expect(page.getByTestId("open-reserve")).toHaveCount(0);
  await expect(page.getByTestId("open-shipment-draft")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/app\/sales\/orders$/);
  await expect(page.getByTestId("outbound-order-list")).toBeVisible();
  await expect(page.getByText("SO-PERMISSION", { exact: true })).toBeVisible();

  await page.goto("/app/sales/orders/new");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await expect(page.getByTestId("capability-route-blocked")).toContainText("能力暂不可用");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("权限已具备，但该业务能力当前未启用。");
  await expect(page.getByTestId("create-sales-order")).toHaveCount(0);
  await expect(page.getByTestId("sales-order-entry")).toHaveCount(0);

  const create = await request.post("/api/sales/orders", {
    headers: { Authorization: `Bearer ${session.token}` },
    data: {
      orderNumber: "SO-DISABLED-BROWSER",
      customerName: "Disabled",
      currency: "CNY",
      idempotencyKey: "disabled-browser-create",
      lines: [{ itemId: "outbound-browser-item", quantity: "1" }],
    },
  });
  expect(create.status()).toBe(409);
  expect((await create.json()).code).toBe("OUTBOUND_CAPABILITY_NOT_AVAILABLE");
});
