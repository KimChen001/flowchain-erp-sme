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

async function governRouteAccess(
  page: Page,
  options: {
    permissions?: string[];
    capabilityUpdates?: Record<string, boolean>;
    authorizationFailure?: boolean;
    capabilityFailure?: boolean;
  },
) {
  await page.route("**/api/authorization/context", async (route) => {
    if (options.authorizationFailure) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "AUTHORIZATION_UNAVAILABLE" }),
      });
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        effectivePermissions:
          options.permissions ?? payload.effectivePermissions ?? [],
      },
    });
  });
  await page.route("**/api/capabilities", async (route) => {
    if (options.capabilityFailure) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "CAPABILITY_REGISTRY_UNAVAILABLE" }),
      });
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    const updates = options.capabilityUpdates || {};
    await route.fulfill({
      response,
      json: {
        capabilities: (payload.capabilities || []).map(
          (capability: { id: string; enabled: boolean }) =>
            capability.id in updates
              ? { ...capability, enabled: updates[capability.id] }
              : capability,
        ),
      },
    });
  });
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
    await expect(
      sidebar.getByRole("button", {
        name: destination.label,
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "page");
    if (destination.label === "收货") {
      await expect(
        sidebar.getByRole("button", { name: "采购", exact: true }),
      ).not.toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("module-title")).toHaveText("收货");
      const receivingSubnav = page.getByTestId("module-subnav");
      await expect(
        receivingSubnav.getByRole("link", { name: "采购收货", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        receivingSubnav.getByRole("link", { name: "供应商发票", exact: true }),
      ).toBeVisible();
      await expect(
        receivingSubnav.getByRole("link", { name: "三单匹配", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByTestId("app-breadcrumb").getByRole("link", {
          name: "采购管理",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(page.getByTestId("procurement-receiving-list")).toBeVisible();
      const receivingRecordList = page.getByTestId("receiving-record-list");
      await expect(receivingRecordList).toBeVisible();
      expect(
        await receivingRecordList.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await expect(page.getByText("采购收货列表尚未接入")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "收货单 LOCAL-DEMO-GRN-001" }),
      ).toBeVisible();
    }
  }
  expect(apiServerErrors).toEqual([]);

  await page.goto("/app/procurement/invoices");
  await expect(page.getByTestId("procurement-supplier-invoice-list")).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-INV-001", { exact: true })).toBeVisible();
  await expect(page.getByText("供应商发票列表尚未接入")).toHaveCount(0);
  await expect(
    page.getByTestId("module-subnav").getByRole("link", {
      name: "供应商发票",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    sidebar.getByRole("button", { name: "收货", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    sidebar.getByRole("button", { name: "采购", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");

  await page.goto("/app/procurement/three-way-match");
  await expect(page.getByTestId("procurement-three-way-match-list")).toBeVisible();
  await expect(
    page.getByText("MATCH-LOCAL-DEMO-INV-001", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("三单匹配列表尚未接入")).toHaveCount(0);
  await expect(
    page.getByTestId("module-subnav").getByRole("link", {
      name: "三单匹配",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    sidebar.getByRole("button", { name: "收货", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  await page.goto("/app/procurement/rfq");
  await expect(page.getByTestId("procurement-rfq-list")).toBeVisible();
  await expect(page.getByText("询价与报价列表尚未接入")).toHaveCount(0);

  await page.goto("/app/procurement/requests");
  await expect(
    page.getByRole("link", { name: "LOCAL-DEMO-PR-001", exact: true }),
  ).toHaveClass(/text-blue-600/);

  await page.goto("/app/procurement/contracts");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();

  await page.goto("/app/universal-intake");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await page.goto("/app/review-actions");
  await expect(page).toHaveURL(/\/app\/review-actions\/waiting$/);
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();

  await sidebar.getByRole("button", { name: "采购", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/workbench$/);
  await sidebar.getByRole("button", { name: "收货", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/receiving$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/procurement\/workbench$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/procurement\/receiving$/);
  await page.reload();
  await expect(
    sidebar.getByRole("button", { name: "收货", exact: true }),
  ).toHaveAttribute("aria-current", "page");

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

test("exact route capabilities hide secondary entries and block direct access", async ({
  page,
  request,
}) => {
  await login(page, request);
  await governRouteAccess(page, {
    capabilityUpdates: {
      "supplier-invoice": false,
      "three-way-match": false,
      "return-request": false,
      "stock-transfer": false,
    },
  });

  await page.goto("/app/procurement/orders");
  const procurementNav = page.getByTestId("module-subnav");
  await expect(
    procurementNav.getByRole("link", { name: "供应商发票", exact: true }),
  ).toHaveCount(0);
  await expect(
    procurementNav.getByRole("link", { name: "三单匹配", exact: true }),
  ).toHaveCount(0);
  await expect(
    procurementNav.getByRole("link", { name: "采购退货", exact: true }),
  ).toHaveCount(0);

  await page.goto("/app/procurement/invoices");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await page.goto("/app/procurement/three-way-match");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();

  await page.goto("/app/inventory/stock");
  await expect(
    page.getByTestId("module-subnav").getByRole("link", {
      name: "库存调拨",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.goto("/app/inventory/transfers");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
});

test("capability registry failure and frozen routes fail closed", async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.addInitScript(() => {
    localStorage.setItem(
      "flowchain:module-settings",
      JSON.stringify({
        items: [
          { id: "procurement", enabled: true },
          { id: "forecast", enabled: true },
        ],
      }),
    );
  });
  await governRouteAccess(page, { capabilityFailure: true });

  await page.goto("/app/inventory/transfers");
  await expect(page.getByTestId("capability-registry-unavailable")).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", {
      name: "数据接入",
      exact: true,
    }),
  ).toHaveCount(0);

  await page.goto("/app/procurement/contracts");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await page.goto("/app/forecast/mrp");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
});

test("exact route permissions govern primary navigation and direct access", async ({
  page,
  request,
}) => {
  await login(page, request);
  await governRouteAccess(page, {
    permissions: ["procurement.purchase_order.read"],
  });

  await page.goto("/app/procurement/orders");
  await expect(
    page.locator("aside").getByRole("button", { name: "采购", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: "收货", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("authorization-route-denied")).toHaveCount(0);

  await page.goto("/app/procurement/receiving");
  await expect(page.getByTestId("authorization-route-denied")).toBeVisible();
});

test("receiving permission does not grant purchase order access", async ({
  page,
  request,
}) => {
  await login(page, request);
  await governRouteAccess(page, { permissions: ["receiving.read"] });

  await page.goto("/app/procurement/receiving");
  await expect(
    page.locator("aside").getByRole("button", { name: "收货", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: "采购", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("authorization-route-denied")).toHaveCount(0);

  await page.goto("/app/procurement/orders");
  await expect(page.getByTestId("authorization-route-denied")).toBeVisible();
});

test("compatibility finance requires exact capability and permission but stays hidden", async ({
  page,
  request,
}) => {
  await login(page, request);
  await governRouteAccess(page, {
    capabilityUpdates: { "bank-statement-reconciliation": true },
    permissions: ["finance.overview.read"],
  });
  await page.goto("/app/finance/bank-statements");
  await expect(page.getByTestId("authorization-route-denied")).toBeVisible();

  await page.unroute("**/api/authorization/context");
  await page.unroute("**/api/capabilities");
  await governRouteAccess(page, {
    capabilityUpdates: { "bank-statement-reconciliation": true },
    permissions: ["finance.bank_statement.read"],
  });
  await page.reload();
  await expect(page.getByTestId("authorization-route-denied")).toHaveCount(0);
  await expect(page.getByTestId("capability-route-blocked")).toHaveCount(0);
  await expect(page.getByTestId("module-shell")).toBeVisible();
  await expect(
    page.locator("aside").getByText("银行流水", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("module-subnav").getByRole("link", {
      name: "银行流水",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("authorization context failure never exposes permission-gated routes", async ({
  page,
  request,
}) => {
  await login(page, request);
  await governRouteAccess(page, { authorizationFailure: true });
  await page.goto("/app/procurement/orders");
  await expect(page.getByTestId("authorization-route-unavailable")).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: "采购", exact: true }),
  ).toHaveCount(0);
});

test("RFQ list does not advertise an unimplemented detail and direct access is truthful", async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.route("**/api/procurement/documents?type=rfq", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        documents: [
          {
            id: "RFQ-TEST-001",
            title: "Route semantics test",
            status: "open",
          },
        ],
      }),
    });
  });

  await page.goto("/app/procurement/rfq");
  await expect(page.getByTestId("rfq-id-unlinked")).toHaveText("RFQ-TEST-001");
  await expect(
    page.getByRole("link", { name: /RFQ-TEST-001/ }),
  ).toHaveCount(0);

  await page.goto("/app/procurement/rfq/RFQ-TEST-001");
  await expect(page.getByTestId("route-not-implemented")).toBeVisible();
  await expect(page.getByText("页面尚未接通", { exact: true })).toBeVisible();
  await expect(page.getByText(/今日采购待办/)).toHaveCount(0);
});

test("legacy root preserves URL semantics while retired children stay truthful", async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.goto("/app/imports?source=old#batch");
  await expect(page).toHaveURL(/\/app\/universal-intake\?source=old#batch$/);

  await page.goto("/app/imports/failed");
  await expect(page).toHaveURL(/\/app\/imports\/failed$/);
  await expect(page.getByTestId("legacy-route-unavailable")).toBeVisible();
  await expect(page.getByText("旧页面已停用", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/universal-intake\?source=old#batch$/);
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
