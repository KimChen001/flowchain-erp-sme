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
  await expect(page).toHaveURL(/\/app\/overview\/risks$/);
  await expect(
    page.getByTestId("module-subnav").getByRole("link", {
      name: "首页概览",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByTitle(/Universal Intake disabled/)).toBeVisible();
  const sidebar = page.locator("aside");
  for (const label of [
    "今日",
    "采购",
    "收货",
    "库存",
    "供应商",
    "物料",
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
  await expect(
    sidebar.getByRole("button", { name: "数据接入", exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "复核队列", exact: true }),
  ).toHaveCount(0);

  const apiServerErrors: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500) {
      apiServerErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  for (const destination of [
    { label: "今日", path: /\/app\/overview\/risks$/ },
    { label: "采购", path: /\/app\/procurement\/workbench$/ },
    { label: "收货", path: /\/app\/procurement\/receiving$/ },
    { label: "库存", path: /\/app\/inventory\/stock$/ },
    { label: "供应商", path: /\/app\/master-data\/suppliers$/ },
    { label: "物料", path: /\/app\/master-data\/items$/ },
  ]) {
    await sidebar
      .getByRole("button", { name: destination.label, exact: true })
      .click();
    await expect(page).toHaveURL(destination.path);
    await expect(page.getByTestId("module-shell")).toBeVisible();
    await expect(page.getByTestId("not-found-recovery")).toHaveCount(0);
    await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
    await expect(page.getByText(/模块加载失败/)).toHaveCount(0);
    if (destination.label === "收货") {
      await expect(page.getByTestId("procurement-receiving-list")).toBeVisible();
      await expect(page.getByText("采购收货列表尚未接入")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "收货单 LOCAL-DEMO-GRN-001" }),
      ).toBeVisible();
    }
  }
  expect(apiServerErrors).toEqual([]);

  await page.goto("/app/procurement/rfq");
  await expect(page.getByTestId("procurement-rfq-list")).toBeVisible();
  await expect(page.getByText("询价与报价列表尚未接入")).toHaveCount(0);

  await page.goto("/app/procurement/contracts");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();

  await page.goto("/app/universal-intake");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await page.goto("/app/review-actions");
  await expect(page).toHaveURL(/\/app\/review-actions\/waiting$/);
  await expect(page.getByText(/当前不可进入/)).toBeVisible();

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
