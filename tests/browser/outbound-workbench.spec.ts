import { test, expect, type Page } from "@playwright/test";

// The server numbers a delivery draft DN-YYYYMM-NNNN when it is saved; the
// order page says which number it got.
async function createdShipmentNumber(page: Page) {
  const notice = page.getByTestId("shipment-created-number");
  await expect(notice).toContainText(/DN-\d{6}-\d{4,}/);
  return /DN-\d{6}-\d{4,}/.exec((await notice.textContent()) || "")?.[0] || "";
}

// The customer is typed and chosen from the matches (CustomerPicker.tsx).
async function chooseCustomer(page: Page, label: string | RegExp, search: string, option: string) {
  const field = page.getByRole("combobox", { name: label });
  await field.click();
  await field.fill(search);
  await page.getByRole("option", { name: option }).click();
}

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
  await page.getByTestId("create-sales-order").click();
  await expect(page.getByLabel("客户", { exact: true })).toHaveAccessibleDescription("请选择客户。");
  await expect(page.getByTestId("sales-order-entry-errors")).toHaveText("请检查标出的字段。");
  await chooseCustomer(page, "客户", "Playwright", "Playwright Customer · CUST-PW");
  // "Net 30" reads as words.
  await expect(page.getByTestId("sales-order-customer-terms")).toHaveText("付款条款：30 天账期");
  await page.getByLabel("物料（第 1 行）").selectOption({ index: 1 });
  await page.getByLabel("数量（第 1 行）").fill("4.0000");
  // Without a price the draft cannot be saved, because it could never be invoiced.
  await page.getByTestId("create-sales-order").click();
  await expect(page.getByLabel("单价（第 1 行）")).toHaveAccessibleDescription("请输入单价，赠品填 0。");
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
  // The unit reads in Chinese: no English unit inside a Chinese sentence.
  await expect(page.getByTestId("outbound-preview-sentence").first()).toContainText(
    "预留 OUT-BROWSER-SKU 4 个。该库位可用量减少 4。",
  );
  await expect(page.getByTestId("outbound-preview-result")).not.toContainText("inventoryMovements");
  await expect(page.getByTestId("confirm-outbound-action")).toHaveText("确认预留");
  await page.getByTestId("confirm-outbound-action").click();
  await expect(page.getByTestId("availability-balance")).toContainText(
    "在手 10",
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
  // No reason is prefilled: the release asks for one before its preview.
  await expect(page.getByLabel("释放原因")).toHaveValue("");
  await page.getByTestId("outbound-preview").click();
  await expect(page.getByText("请输入释放原因。")).toBeVisible();
  await page.getByLabel("释放原因").fill("Playwright release");
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
  await expect(page.getByTestId("shipment-number-on-save")).toHaveText("发货单号：保存时自动生成");
  await page.getByTestId("outbound-preview").click();
  await page.getByTestId("confirm-outbound-action").click();
  const cancelledNumber = await createdShipmentNumber(page);
  await page.getByText(cancelledNumber, { exact: true }).click();
  await expect(page.getByTestId("shipment-workbench")).toBeVisible();
  await page.getByRole("button", { name: "取消草稿" }).click();
  await page.getByLabel("操作原因").fill("Playwright draft cancelled");
  await page.getByTestId("shipment-preview").click();
  await page.getByTestId("confirm-shipment-action").click();
  await expect(page.getByText("已取消", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: /SO-/ }).click();
  await page.getByTestId("open-shipment-draft").click();
  await page.getByLabel("销售订单行").selectOption({ index: 1 });
  await page.getByLabel("预留记录").selectOption({ index: 1 });
  await page.getByLabel("交易数量").fill("3.0000");
  await page.getByTestId("outbound-preview").click();
  await page.getByTestId("confirm-outbound-action").click();
  const postedNumber = await createdShipmentNumber(page);
  expect(postedNumber).not.toBe(cancelledNumber);
  // Putting the order on hold asks first, as cancelling does.
  await page.getByTestId("hold-sales-order").click();
  await expect(page.getByTestId("hold-order-dialog")).toContainText("暂停订单 SO-");
  await page.getByTestId("hold-order-dialog-confirm").click();
  await expect(page.getByText("暂停", { exact: true }).first()).toBeVisible();
  await page.getByText(postedNumber, { exact: true }).click();
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
  await page.getByText(postedNumber, { exact: true }).click();
  // Posting is one confirmation: the dialog reads its preview as it opens.
  await page.getByTestId("open-post").click();
  await expect(page.getByTestId("shipment-preview")).toHaveCount(0);
  await expect(page.getByTestId("confirm-shipment-action")).toBeEnabled();
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
  // Read in the table: the movement type filter lists the same names.
  await expect(page.getByRole("table").getByText("期初余额", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page).not.toHaveURL(/relatedSalesOrderId=/);
  await expect(
    page.getByRole("table").getByText("期初余额", { exact: true }).first(),
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
  ).toContainText("7 个");
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
  // Each option leads with the figure that decides it, so a phone's narrow
  // dropdown still shows it; the line under it has the rest.
  await expect(reserve.getByLabel(/Sales order line/).locator("option:checked")).toHaveText(
    "OUT-BROWSER-SKU · To reserve 2 ea · 浏览器出库物料",
  );
  await expect(reserve.getByTestId("dialog-line-facts")).toHaveText("Ordered 2 ea · Reserved 0 · Shipped 0 · To reserve 2");
  // Earlier tests reserve some of the seeded 10, so only the shape is fixed.
  await expect(reserve.getByLabel(/Inventory balance/).locator("option:checked")).toHaveText(/^Available \d+ ea · 华东成品仓 \/ A-01$/);
  await expect(reserve.getByTestId("dialog-balance-facts")).toHaveText(/^On hand 10 · Reserved \d+ · Available \d+ ea$/);
  // What can be reserved: the smaller of what the line needs and what is available, without trailing zeros.
  await expect(reserve.getByLabel("Quantity", { exact: true })).toHaveValue("2");
  // More than is available is named under the field, with the figure, before any request.
  await reserve.getByLabel("Quantity", { exact: true }).fill("12");
  await page.getByTestId("outbound-preview").click();
  await expect(reserve.getByTestId("outbound-quantity-error")).toHaveText(/^Only \d+ ea available at 华东成品仓 \/ A-01\. Reserve that much or less\.$/);
  await reserve.getByLabel("Quantity", { exact: true }).fill("2");
  await expect(reserve.getByTestId("outbound-dialog-cancel")).toHaveText("Cancel");
  await expect(reserve).toContainText("Preview first to see what will change.");
  await page.getByTestId("outbound-preview").click();
  await expect(page.getByTestId("outbound-preview-result")).toContainText("What will happen");
  await expect(page.getByTestId("outbound-preview-sentence")).toHaveText(
    "Reserves 2 ea of OUT-BROWSER-SKU at 华东成品仓 / A-01. Available stock there goes down by 2.",
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
  // The quantity with its unit, the reservation by where it is.
  await expect(page.getByTestId("outbound-timeline")).toContainText("2 ea · 华东成品仓 / A-01");
  // Each reservation reads once: the order's own "reserved" audit row is folded into it.
  await expect(page.getByTestId("outbound-timeline")).not.toContainText("Stock reserved for the order");
  await expect(page.getByTestId("outbound-timeline")).not.toContainText("库存预留");

  await page.getByTestId("open-shipment-draft").click();
  const draft = page.getByRole("dialog", { name: "Create shipment draft" });
  const reservation = draft.getByLabel("Reservations").locator("option:checked");
  await expect(reservation).toHaveText("Free 2 ea · 华东成品仓 / A-01");
  await expect(reservation).not.toContainText(reservationId);
  await expect(draft.getByLabel("Quantity", { exact: true })).toHaveValue("2");
  await expect(draft.getByTestId("shipment-number-on-save")).toHaveText("Shipment number: assigned when you save");
  await expect(draft).not.toContainText("API");
  await page.getByTestId("outbound-preview").click();
  await expect(page.getByTestId("outbound-preview-sentence")).toHaveText(
    "Creates a shipment for 2 ea of OUT-BROWSER-SKU from 华东成品仓 / A-01. Stock does not change until the shipment is posted.",
  );
  await expect(page.getByTestId("confirm-outbound-action")).toHaveText("Create shipment draft");
  await page.getByTestId("confirm-outbound-action").click();
  await expect(draft).toHaveCount(0);

  const deliveryNumber = await createdShipmentNumber(page);
  await expect(page.getByTestId("shipment-created-number")).toHaveText(`Shipment ${deliveryNumber} created.`);
  await page.getByText(deliveryNumber, { exact: true }).click();
  const shipment = page.getByTestId("shipment-workbench");
  // The header names the order, customer, warehouse and date; no "Posted —" placeholders.
  await expect(page.getByTestId("shipment-sales-order")).toContainText(order.orderNumber);
  await expect(page.getByTestId("shipment-customer")).toContainText("US Customer");
  await expect(page.getByTestId("shipment-warehouse")).toContainText("华东成品仓 / A-01");
  await expect(page.getByTestId("shipment-date")).toContainText("Created");
  await expect(page.getByTestId("shipment-status")).toHaveText("Ready to post");
  await expect(shipment).not.toContainText("Posted —");
  await expect(shipment).not.toContainText("Posted record");
  await expect(shipment).not.toContainText(reservationId);
  // One confirmation: the dialog reads what posting moves as it opens.
  await page.getByTestId("open-post").click();
  const post = page.getByRole("dialog", { name: "Post shipment" });
  await expect(post.getByTestId("shipment-preview")).toHaveCount(0);
  await expect(page.getByTestId("outbound-preview-sentence")).toHaveText(
    "Ships 2 ea of OUT-BROWSER-SKU from 华东成品仓 / A-01. On hand and reserved both go down by 2.",
  );
  await expect(post).not.toContainText("确认执行");
  await expect(post).not.toContainText("inventoryMovements");
  await expect(page.getByTestId("confirm-shipment-action")).toHaveText("Post shipment");
  await page.getByTestId("confirm-shipment-action").click();
  await expect(post).toHaveCount(0);
  await expect(page.getByTestId("shipment-status")).toContainText("Posted");
  await expect(page.getByTestId("shipment-date")).toContainText("Posted");
  await expect(page.getByTestId("shipment-workbench")).not.toContainText("Reversed —");
  // Reversing is an undo beside the invoice, never the solid red main action.
  await expect(page.getByTestId("open-reverse")).toHaveClass(/border-red-200/);
  await expect(page.getByTestId("open-reverse")).not.toHaveClass(/bg-red-600/);
  const reverseBox = await page.getByTestId("open-reverse").boundingBox();
  expect(reverseBox?.height || 0).toBeLessThanOrEqual(40);
  await expect(page.getByTestId("shipment-movement")).toContainText("Shipment");
  await expect(page.getByTestId("shipment-movement")).toContainText("华东成品仓 / A-01 · 2 ea shipped out");
  await expect(page.getByTestId("shipment-movement")).not.toContainText("In 0");
  await expect(page.getByTestId("outbound-timeline")).toContainText("Stock shipped out");
  await expect(page.getByTestId("outbound-timeline")).not.toContainText("发货出库流水已创建");

  // The order's timeline reads in the order things happened, on one clock.
  await page.goto(`/app/sales/orders/${encodeURIComponent(order.id)}`);
  const timeline = await page.getByTestId("outbound-timeline").innerText();
  const at = (title: string) => timeline.indexOf(title);
  expect(at("Stock reserved")).toBeGreaterThanOrEqual(0);
  expect(at("Stock reserved")).toBeLessThan(at("Shipment created"));
  expect(at("Shipment created")).toBeLessThan(at("Stock shipped out"));
  expect(at("Stock shipped out")).toBeLessThan(at("Shipment posted"));
  // Shipped in full: no "Not reserved" chip beside "Fulfilled".
  await expect(page.getByTestId("sales-order-statuses")).toContainText("Fulfilled");
  await expect(page.getByTestId("sales-order-statuses")).not.toContainText("Not reserved");

  // The list shows the order's one status, its amount and its promised date.
  await page.goto("/app/sales/orders");
  const status = page.getByTestId(`sales-order-status-${order.id}`);
  await expect(status).toHaveText("Fulfilled");
  const row = page.getByRole("row").filter({ has: status });
  await expect(row).toContainText("$10.00");
  await expect(row).not.toContainText("Not reserved");
  // On a phone each order is a card whose status is that one status, and the
  // order's lines, reservations and movements are cards too.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(status).toHaveAttribute("data-card-role", "status");
  await expect(status).toBeVisible();
  await page.goto(`/app/sales/orders/${encodeURIComponent(order.id)}`);
  const lines = page.getByTestId("sales-order-lines-table");
  await expect(lines.locator("table")).toHaveAttribute("data-list-cards", "");
  await expect(lines.locator('td[data-card-role="title"]')).toContainText("OUT-BROWSER-SKU");
  await expect(lines.locator('td[data-label="Ordered"]')).toHaveText("2");
  await expect(lines.locator('td[data-label="Fulfilled"]')).toBeVisible();
  await expect(page.locator('#reservations td[data-card-role="status"]')).toBeVisible();
  await expect(page.locator('#movements td[data-card-role="title"]').first()).toHaveText(deliveryNumber);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
