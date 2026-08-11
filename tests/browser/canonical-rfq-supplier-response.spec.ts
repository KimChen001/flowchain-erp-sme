import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const RFQ_ID = "LOCAL-DEMO-RFQ-001";
const SUPPLIER_A = "LOCAL-DEMO-SUP-001";
const SUPPLIER_B = "LOCAL-DEMO-SUP-002";
const LINE_1 = "LOCAL-DEMO-RFQL-001";
const LINE_2 = "LOCAL-DEMO-RFQL-002";
const UNSAFE_SCALED_DECIMAL = "90071992547409.1234";
const UNSAFE_SCALED_DECIMAL_WITH_SECOND_LINE = "90071992548434.1234";
const detailPath = (id = RFQ_ID) => `/api/procurement/documents/rfq/${encodeURIComponent(id)}`;
const initialPath = `/api/procurement/rfqs/${encodeURIComponent(RFQ_ID)}/supplier-responses`;
const appendPath = (supplierId: string) => `/api/procurement/rfqs/${encodeURIComponent(RFQ_ID)}/supplier-responses/${encodeURIComponent(supplierId)}/revisions`;

async function login(page: Page, request: APIRequestContext) {
  const response = await request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "RFQ Response UI", company: "Product Recovery" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  return session;
}

function runtimeIssues(page: Page) {
  const issues: string[] = [];
  page.on("console", (message) => { if (["warning", "error"].includes(message.type())) issues.push(message.text()); });
  page.on("pageerror", (error) => issues.push(error.message));
  return issues;
}

async function selectLine(page: Page, lineId: string, quantity: string, unitPrice: string) {
  const row = page.getByTestId(`rfq-response-editor-line-${lineId}`);
  const checkbox = row.getByRole("checkbox", { name: `选择 ${lineId}` });
  if (!(await checkbox.isChecked())) await checkbox.check();
  await row.getByLabel(`报价数量 ${lineId}`).fill(quantity);
  await row.getByLabel(`单价 ${lineId}`).fill(unitPrice);
}

async function quotationFor(page: Page, supplierName: string) {
  return page.getByTestId(/^rfq-quotation-/).filter({ hasText: supplierName });
}

test("planned Supplier progresses draft to submitted revisions with one idempotent retry", async ({ page, request }) => {
  await login(page, request);
  const issues = runtimeIssues(page);
  const documentReads: string[] = [];
  const commands: Array<{ method: string; path: string; key: string }> = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    const path = `${url.pathname}${url.search}`;
    if (url.pathname.startsWith("/api/procurement/documents")) documentReads.push(path);
    if (url.pathname.includes("/supplier-responses")) commands.push({ method: outgoing.method(), path, key: outgoing.headers()["idempotency-key"] || "" });
  });

  await page.goto(`/app/procurement/rfq/${RFQ_ID}`);
  await expect(page.getByTestId(`rfq-response-action-${SUPPLIER_B}`)).toHaveText(/录入报价/);
  await expect(page.getByTestId("rfq-response-action-LOCAL-DEMO-SUP-003")).toHaveCount(0);
  await expect(page.getByTestId("rfq-response-action-LOCAL-DEMO-SUP-004")).toHaveCount(0);
  await page.getByTestId(`rfq-response-action-${SUPPLIER_B}`).click();
  await expect(page.getByLabel("提交模式", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("rfq-supplier-response-editor")).toContainText("保存草稿不会记录为供应商已响应");
  await expect(page.getByTestId("rfq-supplier-response-editor")).toContainText("正式提交需要覆盖全部 RFQ 行项目");
  await selectLine(page, LINE_1, "10.0000", "12.3456");

  let firstAttempt = true;
  await page.route(`**${initialPath}`, async (route) => {
    if (firstAttempt) {
      firstAttempt = false;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.getByTestId("rfq-response-save-draft").click();
  await expect(page.getByTestId("rfq-response-error")).toContainText("无法连接到报价服务");
  issues.splice(0);
  await page.getByTestId("rfq-response-save-draft").click();
  await expect(page.getByTestId("rfq-response-notice")).toContainText("服务器权威结果");
  await page.unroute(`**${initialPath}`);

  const supplierBRevision1 = await quotationFor(page, "本地演示供应商 B");
  await expect(supplierBRevision1).toContainText("Revision 1 · 当前版本");
  await expect(page.getByTestId(`rfq-participant-${SUPPLIER_B}`)).toContainText("计划参与");
  const initialCommands = commands.filter((command) => command.path === initialPath);
  expect(initialCommands).toHaveLength(2);
  expect(initialCommands.every((command) => command.method === "POST")).toBeTruthy();
  expect(initialCommands[0].key).toBeTruthy();
  expect(initialCommands[1].key).toBe(initialCommands[0].key);

  await page.getByTestId(`rfq-response-action-${SUPPLIER_B}`).click();
  await expect(page.getByTestId("rfq-supplier-response-editor")).toContainText("Revision 1");
  await selectLine(page, LINE_2, "25.0000", "39.5000");
  await page.getByTestId("rfq-response-submit").click();
  await expect(page.getByTestId("rfq-response-notice")).toBeVisible();
  const supplierBRevision2 = await quotationFor(page, "本地演示供应商 B");
  await expect(supplierBRevision2).toContainText("Revision 2 · 当前版本");
  await expect(supplierBRevision2).toContainText("Revision 1 · 历史版本");
  await expect(page.getByTestId(`rfq-participant-${SUPPLIER_B}`)).toContainText("已记录响应");

  expect(commands.some((command) => command.path === appendPath(SUPPLIER_B) && command.method === "POST")).toBeTruthy();
  expect(documentReads.filter((path) => path === detailPath()).length).toBeGreaterThanOrEqual(3);
  expect(documentReads.some((path) => path === "/api/procurement/documents?type=rfq")).toBeFalsy();
  expect(issues).toEqual([]);
});

test("submitted quotation preserves date-only values and surfaces a real stale-version conflict", async ({ page, request }) => {
  const session = await login(page, request);
  await page.goto(`/app/procurement/rfq/${RFQ_ID}`);
  await page.getByTestId(`rfq-response-action-${SUPPLIER_A}`).click();
  await expect(page.getByLabel(`报价数量 ${LINE_1}`)).toHaveValue(UNSAFE_SCALED_DECIMAL);
  await expect(page.getByLabel(`单价 ${LINE_1}`)).toHaveValue("1.0000");
  await page.getByLabel("报价有效期").fill("2030-03-31");
  await page.getByLabel("整体交付日期").fill("2030-02-20");
  await selectLine(page, LINE_2, "25.0000", "41.0000");
  await page.getByLabel(`行交期 ${LINE_2}`).fill("2030-02-18");
  await page.getByTestId("rfq-response-submit").click();
  const supplierARevision3 = await quotationFor(page, "本地演示供应商 A");
  await expect(supplierARevision3).toContainText("Revision 3 · 当前版本");
  await expect(supplierARevision3).toContainText("Revision 2 · 历史版本");
  const detailAfterAppend = await request.get(detailPath(), { headers: { Authorization: `Bearer ${session.token}` } });
  expect(detailAfterAppend.ok()).toBeTruthy();
  const quotationAfterAppend = (await detailAfterAppend.json()).document.quotations.find((item: { supplierId: string }) => item.supplierId === SUPPLIER_A);
  expect(quotationAfterAppend.latestRevision.quotedAmount).toBe(UNSAFE_SCALED_DECIMAL_WITH_SECOND_LINE);
  expect(quotationAfterAppend.latestRevision.lines.find((line: { rfqLineId: string }) => line.rfqLineId === LINE_1).quantity).toBe(UNSAFE_SCALED_DECIMAL);
  expect(quotationAfterAppend.latestRevision.lines.find((line: { rfqLineId: string }) => line.rfqLineId === LINE_1).unitPrice).toBe("1.0000");
  expect(quotationAfterAppend.latestRevision.validity).toBe("2030-03-31");
  expect(quotationAfterAppend.latestRevision.deliveryDate).toBe("2030-02-20");
  expect(quotationAfterAppend.latestRevision.lines.find((line: { rfqLineId: string }) => line.rfqLineId === LINE_2).deliveryDate).toBe("2030-02-18");
  const previousRevision = quotationAfterAppend.revisions.find((revision: { revisionNumber: number }) => revision.revisionNumber === 2);
  expect(previousRevision.lines[0].quantity).toBe(UNSAFE_SCALED_DECIMAL);
  expect(previousRevision.validity).toBe("2030-01-20");
  expect(previousRevision.deliveryDate).toBe("2030-01-14");
  expect(previousRevision.lines[0].deliveryDate).toBe("");

  await page.reload();
  await page.getByTestId(`rfq-response-action-${SUPPLIER_A}`).click();
  await expect(page.getByLabel("报价有效期")).toHaveValue("2030-03-31");
  await expect(page.getByLabel("整体交付日期")).toHaveValue("2030-02-20");
  await expect(page.getByLabel(`行交期 ${LINE_2}`)).toHaveValue("2030-02-18");
  const concurrent = await request.post(appendPath(SUPPLIER_A), {
    headers: { Authorization: `Bearer ${session.token}`, "Idempotency-Key": globalThis.crypto.randomUUID() },
    data: {
      supplierId: SUPPLIER_A,
      expectedVersion: 3,
      submissionMode: "submitted",
      currency: "CNY",
      lines: [
        { rfqLineId: LINE_1, quantity: "50.0000", unitPrice: "97.0000" },
        { rfqLineId: LINE_2, quantity: "25.0000", unitPrice: "40.0000" },
      ],
    },
  });
  expect(concurrent.status()).toBe(201);
  await page.getByLabel(`单价 ${LINE_1}`).fill("96.0000");
  await page.getByTestId("rfq-response-submit").click();
  await expect(page.getByTestId("rfq-response-error")).toContainText("报价已被其他操作更新，请重新加载最新版本后再继续。");
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(await quotationFor(page, "本地演示供应商 A")).toContainText("Revision 4 · 当前版本");

  await page.goto("/app/procurement/rfq/LOCAL-DEMO-RFQ-CLOSED");
  await expect(page.getByTestId("canonical-rfq-detail")).toContainText("当前 RFQ 状态不允许录入新的供应商响应");
  await expect(page.getByTestId(`rfq-response-action-${SUPPLIER_B}`)).toHaveCount(0);
});

test("response editor renders explicit command failures safely", async ({ page, request }) => {
  await login(page, request);
  const cases = [
    { status: 401, code: "AUTHENTICATION_REQUIRED", expected: "登录状态已失效" },
    { status: 403, code: "AUTHORIZATION_DENIED", expected: "没有执行此项报价操作的权限" },
    { status: 404, code: "SUPPLIER_NOT_FOUND", expected: "RFQ 或供应商在当前租户下不可用" },
    { status: 409, code: "RFQ_RESPONSE_CONCURRENCY_CONFLICT", expected: "报价数据已发生变化" },
    { status: 422, code: "RFQ_RESPONSE_DECIMAL_INVALID", expected: "数量或单价格式无效" },
    { status: 500, code: "RFQ_SUPPLIER_RESPONSE_COMMAND_FAILED", expected: "报价服务暂时不可用" },
  ];
  for (const item of cases) {
    await page.goto(`/app/procurement/rfq/${RFQ_ID}`);
    await page.getByTestId(`rfq-response-action-${SUPPLIER_A}`).click();
    await selectLine(page, LINE_2, "25.0000", "40.0000");
    const pattern = `**${appendPath(SUPPLIER_A)}`;
    await page.route(pattern, (route) => route.fulfill({ status: item.status, contentType: "application/json", body: JSON.stringify({ code: item.code }) }));
    await page.getByTestId("rfq-response-save-draft").click();
    await expect(page.getByTestId("rfq-response-error")).toContainText(item.expected);
    await page.unroute(pattern);
  }
  await page.goto(`/app/procurement/rfq/${RFQ_ID}`);
  await page.getByTestId(`rfq-response-action-${SUPPLIER_A}`).click();
  await selectLine(page, LINE_2, "25.0000", "40.0000");
  const networkPattern = `**${appendPath(SUPPLIER_A)}`;
  await page.route(networkPattern, (route) => route.abort("failed"));
  await page.getByTestId("rfq-response-save-draft").click();
  await expect(page.getByTestId("rfq-response-error")).toContainText("无法连接到报价服务");
  await page.unroute(networkPattern);
});
