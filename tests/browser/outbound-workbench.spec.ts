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
  await expect(page.getByTestId("create-sales-order")).toBeDisabled();
  await page.getByLabel("客户").selectOption({ label: "Playwright Customer · CUST-PW" });
  await expect(page.getByTestId("sales-order-customer-terms")).toHaveText("付款条款：Net 30");
  await page.getByLabel("物料（第 1 行）").selectOption({ index: 1 });
  await page.getByLabel("数量（第 1 行）").fill("4.0000");
  // Without a price the draft cannot be saved, because it could never be invoiced.
  await expect(page.getByTestId("create-sales-order")).toBeDisabled();
  await page.getByLabel("单价（第 1 行）").fill("12.5000");
  await page.getByTestId("create-sales-order").click();
  await expect(page.getByTestId("outbound-order-workbench")).toBeVisible();
  await expect(page.getByTestId("sales-order-line-price").first()).toContainText("12.5");
  await expect(page.getByText("Playwright Customer").first()).toBeVisible();
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
  // The preview says what will happen in plain words, not as raw JSON.
  await expect(page.getByTestId("outbound-preview-result")).toContainText(
    "将发生的变更",
  );
  await expect(page.getByTestId("outbound-preview-sentence").first()).toContainText(
    "预留 OUT-BROWSER-SKU 4 EA。该库位可用量减少 4。",
  );
  await expect(page.getByTestId("outbound-preview-result")).not.toContainText("inventoryMovements");
  await expect(page.getByTestId("confirm-outbound-action")).toHaveText("确认预留");
  await page.getByTestId("confirm-outbound-action").click();
  await expect(page.getByTestId("availability-balance")).toContainText(
    "现有 10",
  );
  await expect(page.getByTestId("availability-balance")).toContainText(
    "预留 4",
  );
  await expect(page.getByTestId("availability-balance")).toContainText(
    "可用 6",
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
    "预留 3",
  );
  await expect(page.getByTestId("availability-balance")).toContainText(
    "可用 7",
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
  await page.getByRole("button", { name: "暂停订单" }).click();
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
  await expect(page.getByTestId("shipment-movement").first()).toContainText("销售出库");
  const postedShipmentUrl = page.url();

  await page.goto(orderUrl);
  await page.getByTestId("smart-link-inventory_movement").click();
  await expect(page).toHaveURL(
    /\/app\/inventory\/movements\?.*relatedSalesOrderId=/,
  );
  await expect(page.getByTestId("inventory-active-filters")).toContainText(
    "销售订单",
  );
  // Movements are listed by type, not id: the seeded opening balance
  // ("期初余额") is outside the order filter and reappears once it is cleared.
  await expect(page.getByText("期初余额", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page).not.toHaveURL(/relatedSalesOrderId=/);
  await expect(
    page.getByText("期初余额", { exact: true }).first(),
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
  ).toContainText("7 EA");
  await page.goto(postedShipmentUrl);

  await page.getByTestId("open-reverse").click();
  await page.getByLabel("操作原因").fill("Playwright reversal");
  await page.getByTestId("shipment-preview").click();
  await page.getByTestId("confirm-shipment-action").click();
  await expect(page.getByText("已冲销", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("shipment-movement").last()).toContainText("出库冲销");
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

// A US user sees the reserve, delivery draft and post shipment dialogs in
// English: each says what it will do in plain words, names the warehouse
// instead of its id, starts from the only line, balance or reservation with
// the quantity still needed, and confirms with a button that names the action.
test("reserve, delivery draft and post shipment read in English with warehouse names", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { company: "Browser Company", email: "kim@example.com", name: "Kim" },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  const headers = { Authorization: `Bearer ${session.token}` };
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  await page.route("**/api/me/localization", (route) =>
    route.fulfill({
      json: { languagePreference: "en-US", defaultLanguage: "en-US", effectiveLanguage: "en-US", locale: "en-US", timezone: "America/New_York" },
    }),
  );
  const created = await request.post("/api/sales/orders", {
    headers,
    data: {
      orderNumber: "SO-PW-ENGLISH",
      customerName: "US Customer",
      currency: "USD",
      idempotencyKey: "pw-english-order",
      lines: [{ itemId: "outbound-browser-item", quantity: "2", unitPrice: "5" }],
    },
  });
  expect(created.ok()).toBeTruthy();
  const { order } = await created.json();
  const confirmed = await request.post(`/api/sales/orders/${encodeURIComponent(order.id)}/confirm`, {
    headers,
    data: { expectedOrderVersion: order.version, idempotencyKey: "pw-english-confirm" },
  });
  expect(confirmed.ok()).toBeTruthy();

  await page.goto(`/app/sales/orders/${encodeURIComponent(order.id)}`);
  await page.getByTestId("open-reserve").click();
  const reserve = page.getByRole("dialog", { name: "Reserve inventory" });
  await expect(reserve.getByRole("heading", { name: "Reserve inventory" })).toBeVisible();
  await expect(reserve.getByLabel(/Sales order line/).locator("option:checked")).toHaveText(
    "OUT-BROWSER-SKU · 浏览器出库物料 · Ordered 2 / Reserved 0 / Shipped 0 / To reserve 2",
  );
  await expect(reserve.getByLabel(/Inventory balance/).locator("option:checked")).toContainText("华东成品仓 / A-01 · On hand 10");
  await expect(reserve.getByLabel("Quantity", { exact: true })).toHaveValue("2.0000");
  await expect(reserve).toContainText("Preview first to see what will change.");
  await page.getByTestId("outbound-preview").click();
  await expect(page.getByTestId("outbound-preview-result")).toContainText("What will happen");
  await expect(page.getByTestId("outbound-preview-sentence")).toHaveText(
    "Reserves 2 EA of OUT-BROWSER-SKU at 华东成品仓 / A-01. Available stock there goes down by 2.",
  );
  await expect(reserve.locator("details summary")).toHaveText("Technical details");
  await expect(reserve).not.toContainText("inventoryMovements");
  await expect(reserve).not.toContainText("确认执行");
  await expect(reserve).not.toContainText("预览");
  await expect(page.getByTestId("confirm-outbound-action")).toHaveText("Reserve");
  await page.getByTestId("confirm-outbound-action").click();
  await expect(reserve).toHaveCount(0);

  const workbench = await (await request.get(`/api/sales/orders/${encodeURIComponent(order.id)}/workbench`, { headers })).json();
  const reservationId = workbench.reservations[0].id as string;
  await expect(page.locator("#reservations")).toContainText("华东成品仓");
  await expect(page.locator("#reservations")).not.toContainText(reservationId);
  await expect(page.locator("#reservations")).not.toContainText("outbound-browser-warehouse");
  await expect(page.getByTestId("outbound-timeline")).toContainText("Stock reserved");
  await expect(page.getByTestId("outbound-timeline")).toContainText("2 · 华东成品仓 / A-01");
  await expect(page.getByTestId("outbound-timeline")).not.toContainText("库存预留");

  await page.getByTestId("open-shipment-draft").click();
  const draft = page.getByRole("dialog", { name: "Create delivery draft" });
  const reservation = draft.getByLabel("Reservations").locator("option:checked");
  await expect(reservation).toHaveText("华东成品仓 / A-01 · Reserved 2 / Allocated 0 / Used 0 / Released 0 / Available 2");
  await expect(reservation).not.toContainText(reservationId);
  await expect(draft.getByLabel("Quantity", { exact: true })).toHaveValue("2.0000");
  await draft.getByLabel("Delivery number").fill("SHIP-PW-ENGLISH");
  await expect(draft).not.toContainText("API");
  await page.getByTestId("outbound-preview").click();
  await expect(page.getByTestId("outbound-preview-sentence")).toHaveText(
    "Creates delivery SHIP-PW-ENGLISH for 2 EA of OUT-BROWSER-SKU from 华东成品仓 / A-01. Stock does not change until the shipment is posted.",
  );
  await expect(page.getByTestId("confirm-outbound-action")).toHaveText("Create delivery draft");
  await page.getByTestId("confirm-outbound-action").click();
  await expect(draft).toHaveCount(0);

  await page.getByText("SHIP-PW-ENGLISH", { exact: true }).click();
  const shipment = page.getByTestId("shipment-workbench");
  await expect(page.getByTestId("shipment-sales-order")).toHaveText("Sales order SO-PW-ENGLISH");
  await expect(page.getByTestId("shipment-status")).toHaveText("Ready to post");
  await expect(page.getByTestId("shipment-posting-dates")).toHaveText("Posted — · Reversed —");
  await expect(shipment).not.toContainText("Posted record");
  await expect(shipment).not.toContainText(reservationId);
  await page.getByTestId("open-post").click();
  const post = page.getByRole("dialog", { name: "Post shipment" });
  await page.getByTestId("shipment-preview").click();
  await expect(page.getByTestId("outbound-preview-sentence")).toHaveText(
    "Ships 2 EA of OUT-BROWSER-SKU from 华东成品仓 / A-01. On hand and reserved both go down by 2.",
  );
  await expect(post).not.toContainText("确认执行");
  await expect(post).not.toContainText("inventoryMovements");
  await expect(page.getByTestId("confirm-shipment-action")).toHaveText("Post shipment");
  await page.getByTestId("confirm-shipment-action").click();
  await expect(post).toHaveCount(0);
  await expect(page.getByTestId("shipment-status")).toHaveText("Posted");
  await expect(page.getByTestId("shipment-posting-dates")).toContainText("Reversed —");
  await expect(page.getByTestId("shipment-posting-dates")).not.toContainText("Posted —");
  await expect(page.getByTestId("shipment-movement")).toContainText("Shipment");
  await expect(page.getByTestId("shipment-movement")).toContainText("华东成品仓 / A-01 · In 0 / Out 2");
  await expect(page.getByTestId("outbound-timeline")).toContainText("Stock shipped out");
  await expect(page.getByTestId("outbound-timeline")).not.toContainText("发货出库流水已创建");
});
