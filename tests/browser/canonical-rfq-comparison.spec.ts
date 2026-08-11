import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const RFQ_ID = "LOCAL-DEMO-RFQ-001";
const exactComparisonPath = (id: string) => `/api/procurement/rfqs/${encodeURIComponent(id)}/comparison`;

async function login(page: Page, request: APIRequestContext, email = "kim@example.com") {
  const response = await request.post("/api/auth/login", {
    data: { email, name: "Canonical RFQ Comparison", company: "Product Recovery" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

function collectRuntimeIssues(page: Page) {
  const issues: string[] = [];
  page.on("console", (message) => { if (["warning", "error"].includes(message.type())) issues.push(message.text()); });
  page.on("pageerror", (error) => issues.push(error.message));
  return issues;
}

test("RFQ detail opens authoritative comparison and preserves history without writes", async ({ page, request }) => {
  await login(page, request);
  const issues = collectRuntimeIssues(page);
  const comparisonRequests: string[] = [];
  const allRequests: string[] = [];
  const writes: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    const path = `${url.pathname}${url.search}`;
    allRequests.push(path);
    if (url.pathname.startsWith("/api/procurement/rfqs/") && url.pathname.endsWith("/comparison")) comparisonRequests.push(path);
    if (outgoing.method() !== "GET" && url.pathname.startsWith("/api/")) writes.push(`${outgoing.method()} ${path}`);
  });

  await page.goto(`/app/procurement/rfq/${encodeURIComponent(RFQ_ID)}`);
  await expect(page.getByTestId("rfq-comparison-link")).toBeVisible();
  await page.getByTestId("rfq-comparison-link").click();
  await expect(page).toHaveURL(new RegExp(`/app/procurement/rfq/${RFQ_ID}/comparison$`));
  await expect(page.getByTestId("canonical-rfq-comparison")).toBeVisible();
  await expect(page.getByTestId("rfq-comparison-availability")).toContainText("可进行并列比价");
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-001")).toContainText("本地演示供应商 A");
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-002")).toContainText("本地演示供应商 B");
  await expect(page.getByTestId("rfq-comparison-line-LOCAL-DEMO-RFQL-001")).toContainText("98.0000 CNY");
  await expect(page.getByTestId("rfq-comparison-line-LOCAL-DEMO-RFQL-001")).toContainText("97.5000 CNY");
  await expect(page.getByTestId("rfq-comparison-line-LOCAL-DEMO-RFQL-001")).toContainText("2030-02-18");
  await expect(page.getByTestId("rfq-comparison-commercial-terms")).toContainText("NET45");
  await expect(page.getByTestId("rfq-comparison-commercial-terms")).toContainText("2030-03-31");
  await expect(page.getByTestId("rfq-comparison-commercial-terms")).toContainText("2030-02-20");
  await expect(page.getByTestId("canonical-rfq-comparison")).not.toContainText("2030-03-30");
  await expect(page.getByTestId("canonical-rfq-comparison")).not.toContainText("2030-02-17");
  await expect(page.getByTestId("rfq-comparison-non-response-LOCAL-DEMO-SUP-003")).toContainText("已拒绝");
  await expect(page.getByTestId("rfq-comparison-non-response-LOCAL-DEMO-SUP-004")).toContainText("已撤回");
  await expect(page.getByTestId("rfq-comparison-non-response-LOCAL-DEMO-SUP-005")).toContainText("本地演示供应商 E");
  const responseRows = await page.getByTestId("rfq-comparison-responses").locator("tbody > tr").allTextContents();
  expect(responseRows[0]).toContain("本地演示供应商 A");
  expect(responseRows[1]).toContain("本地演示供应商 B");
  await expect(page.getByRole("button", { name: /Award|授标|PO|采购订单/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Award|授标|PO Conversion|转为 PO/i })).toHaveCount(0);
  expect(comparisonRequests).toEqual([exactComparisonPath(RFQ_ID)]);
  expect(allRequests.some((path) => path === "/api/procurement/documents?type=rfq")).toBeFalsy();
  expect(writes).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/app/procurement/rfq/${RFQ_ID}$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/app/procurement/rfq/${RFQ_ID}/comparison$`));
  await page.reload();
  await expect(page.getByTestId("rfq-comparison-line-LOCAL-DEMO-RFQL-001")).toBeVisible();
  expect(comparisonRequests).toEqual([exactComparisonPath(RFQ_ID), exactComparisonPath(RFQ_ID), exactComparisonPath(RFQ_ID)]);
  expect(issues).toEqual([]);
});

test("multi-currency comparison keeps every response visible without FX or ranking", async ({ page, request }) => {
  await login(page, request);
  const businessRequests: Array<{ method: string; path: string }> = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.pathname.startsWith("/api/")) businessRequests.push({ method: outgoing.method(), path: url.pathname });
  });

  await page.goto("/app/procurement/rfq/LOCAL-DEMO-RFQ-COMPARISON-MIXED/comparison");
  await expect(page.getByTestId("rfq-comparison-availability")).toContainText("多币种，未折算");
  await expect(page.getByTestId("canonical-rfq-comparison")).toContainText("报价币种不同，当前未进行汇率换算，因此总金额不能直接横向比较。");
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-001")).toContainText("可比较");
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-002")).toContainText("可比较");
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-003")).toContainText("尚未形成有效提交");
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-004")).toContainText("历史报价");
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-005")).toContainText("已撤回");
  await expect(page.getByTestId("rfq-comparison-non-response-LOCAL-DEMO-SUP-006")).toContainText("计划参与");
  await expect(page.getByTestId("rfq-comparison-cell-LOCAL-DEMO-RFQL-COMPARISON-MIXED-LOCAL-DEMO-SUP-005")).toContainText("未覆盖");
  await expect(page.getByTestId("rfq-comparison-line-matrix")).toContainText("未能与 RFQ 行建立权威对应");
  await expect(page.getByRole("button", { name: /Award|授标|推荐|创建采购订单|转为 PO/i })).toHaveCount(0);
  expect(businessRequests.filter((request) => request.path.endsWith("/comparison"))).toEqual([{ method: "GET", path: exactComparisonPath("LOCAL-DEMO-RFQ-COMPARISON-MIXED") }]);
  expect(businessRequests.some((request) => /fx|exchange|currency-conversion/i.test(request.path))).toBeFalsy();
  expect(businessRequests.some((request) => ["POST", "PUT", "PATCH", "DELETE"].includes(request.method))).toBeFalsy();
});

test("comparison renders empty, draft-only, single, and historical-only states", async ({ page, request }) => {
  await login(page, request);
  for (const [id, availability, context] of [
    ["LOCAL-DEMO-RFQ EMPTY", "暂无可比较的有效报价", "尚无供应商参与记录"],
    ["LOCAL-DEMO-RFQ-COMPARISON-NO-QUOTE", "暂无可比较的有效报价", "已有参与记录，但尚无报价"],
    ["LOCAL-DEMO-RFQ-COMPARISON-DRAFT", "暂无可比较的有效报价", "现有报价均为草稿"],
    ["LOCAL-DEMO-RFQ-COMPARISON-SINGLE", "当前只有 1 个有效报价", "本地演示供应商 A"],
    ["LOCAL-DEMO-RFQ-COMPARISON-HISTORICAL", "暂无可比较的有效报价", "历史报价"],
  ] as const) {
    await page.goto(`/app/procurement/rfq/${encodeURIComponent(id)}/comparison`);
    await expect(page.getByTestId("rfq-comparison-availability")).toContainText(availability);
    await expect(page.getByTestId("canonical-rfq-comparison")).toContainText(context);
  }
  await expect(page.getByTestId("rfq-comparison-response-LOCAL-DEMO-SUP-005")).toContainText("已撤回");
});

test("comparison page keeps explicit 401, 403, 404, 500 and network states", async ({ page, request }) => {
  await login(page, request);
  for (const [id, status, message] of [
    ["RFQ-ERROR-401", 401, "登录状态已失效"],
    ["RFQ-ERROR-403", 403, "没有查看供应商价格比较的权限"],
    ["RFQ-ERROR-422", 422, "RFQ 编号格式无效"],
    ["RFQ-ERROR-500", 500, "供应商报价比较暂时无法读取"],
  ] as const) {
    const pattern = `**${exactComparisonPath(id)}`;
    await page.route(pattern, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code: `RFQ_COMPARISON_TEST_${status}` }) }));
    await page.goto(`/app/procurement/rfq/${id}/comparison`);
    const state = page.getByTestId("canonical-rfq-comparison-state");
    await expect(state).toContainText(message);
    await expect(state.getByRole("button", { name: "重试" })).toBeVisible();
    await page.unroute(pattern);
  }
  await page.goto(`/app/procurement/rfq/${encodeURIComponent("RFQ-MISSING-404")}/comparison`);
  await expect(page.getByTestId("canonical-rfq-comparison-state")).toContainText("找不到该 RFQ");
  const networkPattern = `**${exactComparisonPath("RFQ-ERROR-NETWORK")}`;
  await page.route(networkPattern, (route) => route.abort("failed"));
  await page.goto(`/app/procurement/rfq/RFQ-ERROR-NETWORK/comparison`);
  await expect(page.getByTestId("canonical-rfq-comparison-state")).toContainText("无法连接到供应商报价比较服务");
  await page.unroute(networkPattern);
});

test("RFQ detail hides comparison navigation without price permission", async ({ page, request }) => {
  await login(page, request, "comparison-viewer@example.com");
  await page.goto(`/app/procurement/rfq/${RFQ_ID}`);
  await expect(page.getByTestId("canonical-rfq-detail")).toBeVisible();
  await expect(page.getByTestId("rfq-comparison-link")).toHaveCount(0);
});
