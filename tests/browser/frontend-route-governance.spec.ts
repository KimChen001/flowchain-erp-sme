import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function login(page: Page, request: APIRequestContext) {
  const login = await request.post("/api/auth/login", {
    data: {
      email: "kim@example.com",
      name: "Route Governance",
      company: "Route Governance",
    },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

test("SME navigation, direct access and browser history follow the route manifest", async ({
  page,
  request,
}) => {
  await login(page, request);

  await page.goto("/app/overview");
  const sidebar = page.locator("aside");
  for (const label of [
    "今日",
    "采购",
    "收货",
    "库存",
    "供应商",
    "物料",
    "数据接入",
    "复核队列",
    "AI 助手",
  ]) {
    await expect(sidebar.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  for (const hidden of [
    "销售管理",
    "结算管理",
    "预测与 MRP",
    "数据接入与质量",
    "试点准备度",
  ]) {
    await expect(sidebar.getByText(hidden, { exact: true })).toHaveCount(0);
  }

  await sidebar.getByRole("button", { name: "采购", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/workbench$/);
  await sidebar.getByRole("button", { name: "收货", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/receiving$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/procurement\/workbench$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/procurement\/receiving$/);

  await page.goto(
    "/app/procurement/orders/LOCAL-DEMO-PO-002?focus=receiving-invoice-variance",
  );
  await expect(page.getByTestId("po-fulfillment-focus")).toHaveAttribute(
    "data-focus-highlight",
    "true",
  );
  await page.reload();
  await expect(page.getByTestId("po-fulfillment-focus")).toHaveAttribute(
    "data-focus-highlight",
    "true",
  );

  await page.goto("/app/procurement/receiving/LOCAL-DEMO-GRN-001");
  await expect(
    page.getByRole("heading", { name: "LOCAL-DEMO-GRN-001", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Beta · PostgreSQL", { exact: true })).toBeVisible();

  await page.goto("/app/imports");
  await expect(page).toHaveURL(/\/app\/universal-intake$/);
});

test("AI PO guidance navigates to the canonical focused detail without creating a review record", async ({
  page,
  request,
}) => {
  await login(page, request);
  const actionDraftWrites: string[] = [];
  page.on("request", (outgoing) => {
    if (
      outgoing.url().includes("/api/action-drafts") &&
      outgoing.method() !== "GET"
    ) {
      actionDraftWrites.push(`${outgoing.method()} ${outgoing.url()}`);
    }
  });

  await page.goto("/app/procurement/orders");
  await page.getByTestId("ai-assistant-toggle").click();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible();
  await panel
    .getByTestId("ai-assistant-input")
    .fill("LOCAL-DEMO-PO-002 今天有什么需要处理？");
  await panel.getByTestId("ai-assistant-send").click();

  const response = panel.getByTestId("ai-message-assistant").last();
  await expect(response).toContainText("LOCAL-DEMO-PO-002", {
    timeout: 25000,
  });
  const navigation = response
    .locator(
      '[data-testid="ai-business-navigation-action"][data-business-id="LOCAL-DEMO-PO-002"], [data-testid="ai-action-link"][data-business-id="LOCAL-DEMO-PO-002"]',
    )
    .first();
  await expect(navigation).toBeVisible();
  await navigation.click();

  await expect(page).toHaveURL(
    /\/app\/procurement\/orders\/LOCAL-DEMO-PO-002\?focus=receiving-invoice-variance/,
  );
  await expect(page.getByTestId("po-fulfillment-focus")).toHaveAttribute(
    "data-focus-highlight",
    "true",
  );
  await expect(page.getByTestId("action-draft-review-shell")).toHaveCount(0);
  expect(actionDraftWrites).toEqual([]);
});
