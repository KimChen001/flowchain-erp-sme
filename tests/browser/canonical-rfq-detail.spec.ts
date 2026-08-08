import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const RFQ_ID = "LOCAL-DEMO-RFQ-001";
const EMPTY_RFQ_ID = "LOCAL-DEMO-RFQ EMPTY";
const exactRfqPath = (id: string) => `/api/procurement/documents/rfq/${encodeURIComponent(id)}`;

async function login(page: Page, request: APIRequestContext) {
  const response = await request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Canonical RFQ", company: "Product Recovery" },
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
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) issues.push(message.text());
  });
  page.on("pageerror", (error) => issues.push(error.message));
  return issues;
}

async function expectNoWriteActions(page: Page) {
  const detail = page.getByTestId("canonical-rfq-detail");
  await expect(detail).not.toContainText(
    /Create Response|Edit RFQ|Close RFQ|Add Revision|Compare|Award|Approve|Convert to PO|Send Invitation|AI Execute|创建响应|编辑 RFQ|关闭 RFQ|添加修订|比较报价|授标|批准供应商|转为 PO|发送邀请/,
  );
  await expect(
    detail.getByRole("button", { name: /response|revision|compare|award|approve|convert|invitation|portal|execute/i }),
  ).toHaveCount(0);
  await expect(
    detail.getByRole("link", { name: /response|revision|compare|award|approve|convert|invitation|portal|execute/i }),
  ).toHaveCount(0);
}

test("PostgreSQL RFQ list opens the exact canonical detail and preserves browser history", async ({ page, request }) => {
  await login(page, request);
  const runtimeIssues = collectRuntimeIssues(page);
  const documentRequests: string[] = [];
  const allRequests: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    allRequests.push(`${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/api/procurement/documents")) {
      documentRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto("/app/procurement/rfq");
  await expect(page.getByTestId(`rfq-id-link-${RFQ_ID}`)).toBeVisible();
  expect(documentRequests).toEqual(["/api/procurement/documents?type=rfq"]);

  await page.getByTestId(`rfq-id-link-${RFQ_ID}`).click();
  await expect(page).toHaveURL(new RegExp(`/app/procurement/rfq/${RFQ_ID}$`));
  const detail = page.getByTestId("canonical-rfq-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("本地演示控制器询价");
  await expect(detail.getByText("收集报价", { exact: true })).toBeVisible();
  await expect(detail).toContainText("2030-01-10");
  await expect(detail).toContainText("CNY");
  await expect(detail).toContainText("LOCAL-DEMO-PR-001");

  const line = page.getByTestId("rfq-line-LOCAL-DEMO-RFQL-001");
  await expect(line).toContainText("LDM-001");
  await expect(line).toContainText("50");
  await expect(line).toContainText("pcs");
  await expect(line).toContainText("2030-01-15");
  await expect(line).toContainText("LOCAL-DEMO-WH-001");

  const quotation = page.getByTestId("rfq-quotation-LOCAL-DEMO-QUOTE-001");
  await expect(quotation).toContainText("本地演示供应商 A");
  await expect(quotation).toContainText("已提交");
  await expect(quotation).toContainText("4,900");
  await expect(quotation).toContainText("2030-01-05 08:30:00.000 UTC");
  await expect(page.getByTestId("rfq-quotation-line-LOCAL-DEMO-REVLINE-002")).toContainText("LDM-001 · 50 pcs");
  await expect(page.getByTestId("rfq-revision-LOCAL-DEMO-REV-002")).toContainText("Revision 2 · 当前版本");
  await expect(page.getByTestId("rfq-revision-LOCAL-DEMO-REV-001")).toContainText("Revision 1 · 历史版本");
  await expect(page.getByTestId("rfq-revision-line-LOCAL-DEMO-REVLINE-001")).toContainText("100");

  await expect(page.getByTestId("rfq-participant-LOCAL-DEMO-SUP-001")).toContainText("已记录响应");
  await expect(page.getByTestId("rfq-participant-LOCAL-DEMO-SUP-002")).toContainText("暂无响应");
  await expect(page.getByTestId("rfq-participant-LOCAL-DEMO-SUP-003")).toContainText("已拒绝");
  await expect(page.getByTestId("rfq-participant-LOCAL-DEMO-SUP-004")).toContainText("已撤回");

  const evidence = page.getByTestId("rfq-related-evidence");
  await expect(evidence).toContainText("LOCAL-DEMO-PR-001");
  await expect(evidence).toContainText("LOCAL-DEMO-PO-001");
  await expect(evidence).toContainText("LOCAL-DEMO-QUOTE-001");
  await expect(evidence.getByRole("link", { name: "打开记录" })).toHaveCount(2);

  const limitations = page.getByTestId("rfq-data-limitations");
  await expect(limitations).toContainText("RFQ Supplier Participation");
  await expect(limitations).toContainText("不证明邮件送达");
  await expect(limitations).toContainText("最大 revisionNumber");
  await expect(limitations).toContainText("没有 Supplier Response 或 Append Revision HTTP 写命令");
  await expectNoWriteActions(page);

  expect(documentRequests.filter((path) => path === "/api/procurement/documents?type=rfq")).toHaveLength(1);
  expect(documentRequests.filter((path) => path === exactRfqPath(RFQ_ID))).toHaveLength(1);
  expect(allRequests.some((path) => /snapshot|fixture/i.test(path))).toBeFalsy();

  await page.goBack();
  await expect(page).toHaveURL(/\/app\/procurement\/rfq$/);
  await expect(page.getByTestId(`rfq-id-link-${RFQ_ID}`)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/app/procurement/rfq/${RFQ_ID}$`));
  await expect(page.getByTestId("canonical-rfq-detail")).toContainText("本地演示控制器询价");
  expect(runtimeIssues).toEqual([]);
});

test("direct RFQ refresh uses only the encoded exact endpoint", async ({ page, request }) => {
  await login(page, request);
  const runtimeIssues = collectRuntimeIssues(page);
  const documentRequests: string[] = [];
  const allRequests: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    allRequests.push(`${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/api/procurement/documents")) {
      documentRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto(`/app/procurement/rfq/${encodeURIComponent(RFQ_ID)}`);
  await expect(page.getByTestId("canonical-rfq-detail")).toContainText("LOCAL-DEMO-RFQL-001");
  await expect(page.getByTestId("canonical-rfq-detail")).toContainText("LOCAL-DEMO-QUOTE-001");
  await page.reload();
  await expect(page.getByTestId("rfq-quotation-line-LOCAL-DEMO-REVLINE-002")).toBeVisible();

  expect(documentRequests).toEqual([exactRfqPath(RFQ_ID), exactRfqPath(RFQ_ID)]);
  expect(allRequests.some((path) => /snapshot|fixture/i.test(path))).toBeFalsy();
  expect(runtimeIssues).toEqual([]);
});

test("encoded empty RFQ remains a valid authoritative record with subsection empty states", async ({ page, request }) => {
  await login(page, request);
  const runtimeIssues = collectRuntimeIssues(page);
  const documentRequests: string[] = [];
  const allRequests: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    allRequests.push(`${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/api/procurement/documents")) {
      documentRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto(`/app/procurement/rfq/${encodeURIComponent(EMPTY_RFQ_ID)}`);
  const detail = page.getByTestId("canonical-rfq-detail");
  await expect(detail).toContainText("无行项目与报价的合法询价");
  await expect(page.getByTestId("rfq-lines")).toContainText("当前 RFQ 没有权威行项目");
  await expect(page.getByTestId("rfq-quotations")).toContainText("当前 RFQ 没有权威报价记录");
  await expect(page.getByTestId("rfq-suppliers")).toContainText("当前 RFQ 没有权威供应商参与记录");
  await expect(detail).not.toContainText("LOCAL-DEMO-QUOTE-001");
  await expect(detail).not.toContainText("本地演示供应商 A");
  await expectNoWriteActions(page);

  expect(documentRequests).toEqual([exactRfqPath(EMPTY_RFQ_ID)]);
  expect(allRequests.some((path) => /snapshot|fixture/i.test(path))).toBeFalsy();
  expect(runtimeIssues).toEqual([]);
});

test("RFQ detail distinguishes 404 401 403 500 and network failures without fallback data", async ({ page, request }) => {
  await login(page, request);
  const documentRequests: string[] = [];
  const allRequests: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    allRequests.push(`${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/api/procurement/documents")) {
      documentRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto("/app/procurement/rfq/RFQ-MISSING-404");
  await expect(page.getByTestId("canonical-rfq-detail-state")).toContainText("找不到该 RFQ，或该记录不可见");
  await expect(page.getByText("本地演示控制器询价", { exact: true })).toHaveCount(0);

  for (const [id, status, expected] of [
    ["RFQ-ERROR-401", 401, "登录状态已失效"],
    ["RFQ-ERROR-403", 403, "没有查看该 RFQ 的权限"],
    ["RFQ-ERROR-500", 500, "RFQ 暂时无法读取，请稍后重试"],
  ] as const) {
    const routePattern = `**${exactRfqPath(id)}`;
    await page.route(routePattern, (route) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ code: `RFQ_TEST_${status}` }),
    }));
    await page.goto(`/app/procurement/rfq/${id}`);
    const state = page.getByTestId("canonical-rfq-detail-state");
    await expect(state).toContainText(expected);
    await expect(state.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(page.getByText("本地演示控制器询价", { exact: true })).toHaveCount(0);
    await page.unroute(routePattern);
  }

  const networkPattern = `**${exactRfqPath("RFQ-ERROR-NETWORK")}`;
  await page.route(networkPattern, (route) => route.abort("failed"));
  await page.goto("/app/procurement/rfq/RFQ-ERROR-NETWORK");
  const networkState = page.getByTestId("canonical-rfq-detail-state");
  await expect(networkState).toContainText("无法连接到 RFQ 服务");
  await expect(networkState.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(page.getByText("本地演示控制器询价", { exact: true })).toHaveCount(0);

  expect(documentRequests.some((path) => path === "/api/procurement/documents?type=rfq")).toBeFalsy();
  expect(allRequests.some((path) => /snapshot|fixture/i.test(path))).toBeFalsy();
});
