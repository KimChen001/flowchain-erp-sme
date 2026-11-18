import { expect, test, type Page, type Route } from "@playwright/test";

// Design audit L11-05: Today's card that turns an approved request into
// purchase orders says, before the second click, what it will create:
// approved orders (approving the request approved them, owner decision D3)
// or drafts when the workspace turns that off, with each line's item,
// quantity and supplier, and what would refuse them. It reads that from the
// purchase-order preview when the card opens. The assistant shows the same
// card (TodayDecisionCards). The overview's decisions and the order routes
// are stubbed here, so nothing in the workspace changes.

const REQUEST_ID = "PR-L1105";

async function signIn(page: Page, language: "en-US" | "zh-CN") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Conversion card", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: "en-US", timezone: "America/New_York", workspaceToday: "2026-11-17" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

// One approved request waiting on Today, two suppliers' worth of orders.
async function stubDecision(page: Page) {
  await page.route("**/api/home/overview", async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    const row = {
      id: `purchase_request_to_convert:${REQUEST_ID}`, kind: "purchase_request_to_convert", entityType: "purchase_request", recordId: REQUEST_ID,
      label: "PR-202611-0042", name: null, href: `/app/procurement/requests/${REQUEST_ID}`, actionHref: null,
      date: "2026-11-24", dateKind: "required", overdueDays: 0, detail: {},
    };
    const draft = {
      type: "purchase_orders_from_request", purchaseRequestId: REQUEST_ID, number: "PR-202611-0042", version: 3,
      orders: [
        { supplierId: "SUP-A", supplierName: "Harbour Packaging", currency: "GBP", warehouseId: "WH-1", lines: 2 },
        { supplierId: "SUP-B", supplierName: "Northern Labels", currency: "GBP", warehouseId: "WH-1", lines: 1 },
      ],
      missing: [],
    };
    await route.fulfill({ response, json: {
      ...body,
      decisions: { available: true, canDecide: true, supplierEmail: { enabled: false, canSend: false, outbox: true }, waiting: [{ key: "L1105-KEY", row, raisedAt: "2026-11-16T09:00:00.000Z", returned: false, draft }], setAside: [] },
    } });
  });
}

test("the conversion card says it will create approved orders and lists each line before Confirm", async ({ page }) => {
  await signIn(page, "en-US");
  await stubDecision(page);
  let previews = 0;
  await page.route(`**/api/procurement/requests/${REQUEST_ID}/purchase-order-preview`, (route) => {
    previews += 1;
    return route.fulfill({ json: {
      purchaseRequestId: REQUEST_ID, number: "PR-202611-0042", status: "approved", version: 3, purchaseOrderStatus: "approved",
      orders: [
        { supplierId: "SUP-A", supplierName: "Harbour Packaging", currency: "GBP", warehouseId: "WH-1", lineCount: 2, amount: "180.0000", lines: [
          { sku: "TAPE-48", itemName: "Packing tape 48 mm", quantity: "40.0000", unit: "roll" },
          { sku: "BOX-M", itemName: "Shipping box, medium", quantity: "1.0000", unit: "box" },
        ] },
        { supplierId: "SUP-B", supplierName: "Northern Labels", currency: "GBP", warehouseId: "WH-1", lineCount: 1, amount: "60.0000", lines: [
          { sku: "LBL-4X6", itemName: null, quantity: "500.0000", unit: "pcs" },
        ] },
      ],
      issues: [],
    } });
  });
  const created: unknown[] = [];
  await page.route(`**/api/procurement/requests/${REQUEST_ID}/generate-purchase-orders`, (route) => {
    created.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { createdPurchaseOrders: [{ id: "PO-A", number: "PO-202611-0101" }, { id: "PO-B", number: "PO-202611-0102" }] } });
  });
  await page.route("**/api/decision-items/decide", (route) => route.fulfill({ json: { ok: true } }));

  await page.goto("/app/overview/risks");
  const card = page.getByTestId("today-decisions").locator('[data-testid="today-decision"][data-key="L1105-KEY"]');
  await expect(card).toContainText("2 purchase orders from this request");
  // Closed, the card reads nothing more.
  expect(previews).toBe(0);

  await card.getByTestId("decision-create-orders").click();
  await expect(card).toContainText("Will create 2 approved purchase orders");
  await expect(card.getByTestId("decision-order-status")).toHaveText("Approving the request approved them: they need no second approval and can be issued to the supplier.");
  await expect(card.getByTestId("decision-order-preview")).toContainText("Harbour Packaging · GBP");
  await expect(card.getByTestId("decision-order-line")).toHaveText(["Packing tape 48 mm × 40 rolls", "Shipping box, medium × 1 box", "LBL-4X6 × 500 pcs"]);
  const confirm = card.getByTestId("decision-confirm-orders");
  await expect(confirm).toContainText("Create 2 approved purchase orders from this request?");
  expect(created).toHaveLength(0);

  await confirm.getByTestId("decision-primary").click();
  await expect(card).toContainText("Created PO-202611-0101, PO-202611-0102.");
  expect(created).toEqual([{ expectedVersion: 3, idempotencyKey: "today-decision:L1105-KEY:v3" }]);
});

test("in a workspace that approves orders separately, in Chinese, a refused line keeps Confirm off", async ({ page }) => {
  await signIn(page, "zh-CN");
  await stubDecision(page);
  await page.route(`**/api/procurement/requests/${REQUEST_ID}/purchase-order-preview`, (route) => route.fulfill({ json: {
    purchaseRequestId: REQUEST_ID, number: "PR-202611-0042", status: "approved", version: 3, purchaseOrderStatus: "draft",
    orders: [{ supplierId: "SUP-A", supplierName: "Harbour Packaging", currency: "GBP", warehouseId: "WH-1", lineCount: 1, amount: "0.0000", lines: [{ sku: "TAPE-48", itemName: "Packing tape 48 mm", quantity: "40.0000", unit: "roll" }] }],
    issues: [{ code: "PURCHASE_REQUEST_LINE_UNPRICED", message: "Every line needs a price above 0 before a PO can be created." }],
  } }));
  let created = 0;
  await page.route(`**/api/procurement/requests/${REQUEST_ID}/generate-purchase-orders`, (route) => { created += 1; return route.abort(); });

  await page.goto("/app/overview/risks");
  const card = page.getByTestId("today-decisions").locator('[data-testid="today-decision"][data-key="L1105-KEY"]');
  await card.getByTestId("decision-create-orders").click();
  await expect(card).toContainText("将生成 1 张采购订单草稿");
  await expect(card.getByTestId("decision-order-status")).toHaveText("本工作区单独审批订单：订单以草稿开始，需再走采购订单审批。");
  await expect(card.getByTestId("decision-order-line")).toHaveText(["Packing tape 48 mm × 40 卷"]);
  await expect(card.getByTestId("decision-order-issue")).toHaveText("有一行的价格不大于 0，请先在申请里填写价格。");
  await expect(card.getByTestId("decision-confirm-orders")).toContainText("确认由此申请生成 1 张采购订单草稿？");
  await expect(card.getByTestId("decision-primary")).toBeDisabled();
  expect(created).toBe(0);
});
