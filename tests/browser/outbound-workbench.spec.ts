import { test, expect } from "@playwright/test";

test.describe.configure({ retries: 0 });

test("sales fulfillment workbench closes reserve, shipment, post, and reverse through PostgreSQL", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: {
      company: "Forged Browser Company",
      email: "kim@example.com",
      name: "Forged",
      role: "admin",
      tenantId: "forged",
    },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);

  await page.goto("/app/sales/orders");
  await expect(page.getByTestId("outbound-order-list")).toBeVisible();
  await page.getByRole("link", { name: "新建销售订单" }).click();
  await page.getByLabel("客户").fill("Playwright Customer");
  await page.getByLabel("数量").fill("4.0000");
  await page.getByTestId("create-sales-order").click();
  await expect(page.getByTestId("outbound-order-workbench")).toBeVisible();
  const orderUrl = page.url();
  await page.getByTestId("confirm-sales-order").click();
  await expect(page.getByText("已确认", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("已确认", { exact: true }).first()).toBeVisible();

  await page.getByTestId("open-reserve").click();
  await page.getByLabel("销售订单行").selectOption({ index: 1 });
  await page.getByLabel("库存余额").selectOption({ index: 1 });
  await page.getByLabel("交易数量").fill("4.0000");
  await page.getByTestId("outbound-preview").click();
  await expect(page.getByTestId("outbound-preview-result")).toContainText(
    "预览允许执行",
  );
  await page.getByTestId("confirm-outbound-action").click();
  await expect(page.getByTestId("availability-balance")).toContainText(
    "现有 10.0000",
  );
  await expect(page.getByTestId("availability-balance")).toContainText(
    "预留 4.0000",
  );
  await expect(page.getByTestId("availability-balance")).toContainText(
    "可用 6.0000",
  );
  await page.getByTestId("smart-link-reservation").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#reservations$/);
  await expect(page.locator("#reservations")).toBeVisible();

  await page.getByRole("button", { name: "释放预留" }).click();
  await page.getByLabel("预留记录").selectOption({ index: 1 });
  await page.getByLabel("交易数量").fill("1.0000");
  await page.getByTestId("outbound-preview").click();
  await page.getByTestId("confirm-outbound-action").click();
  await expect(page.getByTestId("availability-balance")).toContainText(
    "预留 3.0000",
  );
  await expect(page.getByTestId("availability-balance")).toContainText(
    "可用 7.0000",
  );

  await page.getByTestId("open-shipment-draft").click();
  await page.getByLabel("销售订单行").selectOption({ index: 1 });
  await page.getByLabel("预留记录").selectOption({ index: 1 });
  await page.getByLabel("交易数量").fill("3.0000");
  await page.getByLabel("发货单号").fill("SHIP-PW-CANCEL");
  await page.getByTestId("outbound-preview").click();
  await page.getByTestId("confirm-outbound-action").click();
  await page.getByText("SHIP-PW-CANCEL", { exact: true }).click();
  await expect(page.getByTestId("shipment-workbench")).toBeVisible();
  await page.getByRole("button", { name: "取消草稿" }).click();
  await page.getByTestId("shipment-preview").click();
  await page.getByTestId("confirm-shipment-action").click();
  await expect(page.getByText("已取消", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: /SO-/ }).click();
  await page.getByTestId("open-shipment-draft").click();
  await page.getByLabel("销售订单行").selectOption({ index: 1 });
  await page.getByLabel("预留记录").selectOption({ index: 1 });
  await page.getByLabel("交易数量").fill("3.0000");
  await page.getByLabel("发货单号").fill("SHIP-PW-POST");
  await page.getByTestId("outbound-preview").click();
  await page.getByTestId("confirm-outbound-action").click();
  await page.getByRole("button", { name: "暂停" }).click();
  await expect(page.getByText("暂停", { exact: true }).first()).toBeVisible();
  await page.getByText("SHIP-PW-POST", { exact: true }).click();
  await expect(page.getByTestId("open-post")).toHaveCount(0);
  const shipmentId = decodeURIComponent(page.url().split("/").pop() || "");
  const postingStateResponse = await request.get(
    `/api/sales/shipments/${shipmentId}/posting-state`,
    { headers: { Authorization: `Bearer ${session.token}` } },
  );
  expect(postingStateResponse.ok()).toBeTruthy();
  const postingState = await postingStateResponse.json();
  const blockedPost = await request.post(
    `/api/sales/shipments/${shipmentId}/post`,
    {
      headers: { Authorization: `Bearer ${session.token}` },
      data: {
        expectedShipmentVersion: postingState.shipment.version,
        idempotencyKey: "browser-held-post",
      },
    },
  );
  expect(blockedPost.status()).toBe(409);
  expect((await blockedPost.json()).code).toBe("SALES_ORDER_ON_HOLD");
  await page.getByRole("link", { name: /SO-/ }).click();
  await page.getByRole("button", { name: "恢复" }).click();
  await expect(page.getByText("已确认", { exact: true }).first()).toBeVisible();
  await page.getByText("SHIP-PW-POST", { exact: true }).click();
  await page.getByTestId("open-post").click();
  await page.getByTestId("shipment-preview").click();
  await page.getByTestId("confirm-shipment-action").dblclick();
  await expect(page.getByText("已过账", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/shipment_posting/).first()).toBeVisible();
  const postedShipmentUrl = page.url();

  await page.goto(orderUrl);
  await page.getByTestId("smart-link-inventory_movement").click();
  await expect(page).toHaveURL(
    /\/app\/inventory\/movements\?.*relatedSalesOrderId=/,
  );
  await expect(page.getByTestId("inventory-active-filters")).toContainText(
    "销售订单",
  );
  await expect(page.getByText("outbound-browser-opening")).toHaveCount(0);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page).not.toHaveURL(/relatedSalesOrderId=/);
  await expect(
    page.getByText("outbound-browser-opening").first(),
  ).toBeVisible();

  await page.goto(orderUrl);
  await page.getByTestId("smart-link-inventory_balance").click();
  await expect(page).toHaveURL(
    /\/app\/inventory\/stock\?.*sku=OUT-BROWSER-SKU/,
  );
  await expect(page.getByTestId("inventory-active-filters")).toContainText(
    "OUT-BROWSER-SKU",
  );
  await expect(
    page.getByTestId("inventory-item-OUT-BROWSER-SKU"),
  ).toContainText("7.0000");
  await page.goto(postedShipmentUrl);

  await page.getByTestId("open-reverse").click();
  await page.getByLabel("操作原因").fill("Playwright reversal");
  await page.getByTestId("shipment-preview").click();
  await page.getByTestId("confirm-shipment-action").click();
  await expect(page.getByText("已冲销", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/shipment_reversal/).first()).toBeVisible();
  await expect(page.getByTestId("open-reverse")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("已冲销", { exact: true }).first()).toBeVisible();
});

test("warehouse permissions and stale versions fail closed in the browser runtime", async ({
  page,
  request,
  browser,
}) => {
  const login = async (email: string) => {
    const response = await request.post("/api/auth/login", {
      data: { company: "Ignored", email, name: "Ignored" },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const viewer = await login("viewer@example.com");
  const viewerPreview = await request.post(
    "/api/sales/orders/outbound-browser-permission-order/reservations/preview",
    {
      headers: { Authorization: `Bearer ${viewer.token}` },
      data: {
        allocations: [
          {
            salesOrderLineId: "outbound-browser-permission-line",
            warehouseId: "outbound-browser-warehouse",
            location: "A-01",
            quantity: "1",
          },
        ],
      },
    },
  );
  expect(viewerPreview.ok()).toBeTruthy();
  const viewerMutation = await request.post(
    "/api/sales/orders/outbound-browser-permission-order/reservations/reserve",
    {
      headers: { Authorization: `Bearer ${viewer.token}` },
      data: {
        expectedOrderVersion: 0,
        idempotencyKey: "viewer-denied",
        allocations: [
          {
            salesOrderLineId: "outbound-browser-permission-line",
            warehouseId: "outbound-browser-warehouse",
            location: "A-01",
            quantity: "1",
          },
        ],
      },
    },
  );
  expect(viewerMutation.status()).toBe(403);
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, viewer);
  await page.goto("/app/sales/orders/outbound-browser-permission-order");
  await expect(page.getByTestId("availability-balance")).toContainText("只读");
  await expect(page.getByTestId("open-reserve")).toHaveCount(0);

  const readManager = await login("readonly@example.com");
  const deniedPreview = await request.post(
    "/api/sales/orders/outbound-browser-permission-order/reservations/preview",
    {
      headers: { Authorization: `Bearer ${readManager.token}` },
      data: {
        allocations: [
          {
            salesOrderLineId: "outbound-browser-permission-line",
            warehouseId: "outbound-browser-warehouse",
            location: "A-01",
            quantity: "1",
          },
        ],
      },
    },
  );
  expect(deniedPreview.status()).toBe(404);

  const kim = await login("kim@example.com");
  const kimContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const kimPage = await kimContext.newPage();
  await kimPage.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, kim);
  await kimPage.goto("/app/sales/orders/outbound-browser-permission-order");
  await kimPage.getByTestId("open-reserve").click();
  const external = await request.post(
    "/api/sales/orders/outbound-browser-permission-order/reservations/reserve",
    {
      headers: { Authorization: `Bearer ${kim.token}` },
      data: {
        expectedOrderVersion: 0,
        idempotencyKey: "external-reserve",
        allocations: [
          {
            salesOrderLineId: "outbound-browser-permission-line",
            warehouseId: "outbound-browser-warehouse",
            location: "A-01",
            quantity: "1",
          },
        ],
      },
    },
  );
  expect(external.ok()).toBeTruthy();
  await kimPage.getByLabel("销售订单行").selectOption({ index: 1 });
  await kimPage.getByLabel("库存余额").selectOption({ index: 1 });
  await kimPage.getByLabel("交易数量").fill("1.0000");
  await kimPage.getByTestId("outbound-preview").click();
  await kimPage.getByTestId("confirm-outbound-action").click();
  await expect(kimPage.getByRole("alert")).toContainText("订单已发生变化");
  await kimContext.close();
});
