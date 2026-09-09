import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test.setTimeout(180_000);
test.describe.configure({ mode: "serial" });

async function login(request: any, email: string) {
  const response = await request.post("/api/auth/login", {
    data: { email, name: "Ignored", company: "Ignored" },
  });
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function installSession(page: any, session: any) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

async function api(request: any, token: string, method: string, path: string, data?: any, extraHeaders: Record<string, string> = {}) {
  const response = await request[method](path, {
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json();
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${response.status()} ${JSON.stringify(body)}`).toBeTruthy();
  return body;
}

async function expectNoPageOverflow(page: any) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("mobile task inbox governs settlement and PO approval across offline and two-device states", async ({ browser, request }) => {
  const finance = await login(request, "settlement@example.com");
  const mobile = await login(request, "mobile@example.com");
  const account = await api(request, finance.token, "post", "/api/finance/cashbook/accounts", {
    accountCode: "MOBILE-SET-CNY",
    name: "Mobile Settlement Cashbook",
    accountType: "bank",
    currency: "CNY",
    openingBalance: "100",
    idempotencyKey: "mobile-browser-settlement-account",
  });
  const settlement = await api(request, finance.token, "post", "/api/finance/settlements", {
    settlementNumber: "SET-MOBILE-TASK",
    direction: "disbursement",
    counterpartyType: "supplier",
    counterpartyId: "finance-browser-supplier",
    cashbookAccountId: account.entityId,
    currency: "CNY",
    amount: "10",
    settlementDate: "2026-07-20",
    allocations: [{
      obligationType: "payable",
      obligationId: "finance-browser-settlement-payable",
      cashAppliedAmount: "10",
      discountAmount: "0",
      totalSettlementAmount: "10",
    }],
    idempotencyKey: "mobile-browser-settlement-create",
  });
  await api(request, finance.token, "post", `/api/finance/settlements/${settlement.entityId}/submit`, {
    expectedVersion: 0,
    idempotencyKey: "mobile-browser-settlement-submit",
  });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await installSession(page, mobile);
  await page.goto("/app/mobile/tasks");
  await expect(page.getByTestId("mobile-operations-workbench")).toBeVisible();
  await expect(page.getByTestId("mobile-network-status")).toContainText("在线");
  await expect(page.getByTestId("mobile-task").filter({ hasText: "SET-MOBILE-TASK" })).toBeVisible();
  await expect(page.getByTestId("mobile-task").filter({ hasText: "PO-MOBILE-APPROVE" })).toBeVisible();
  await expectNoPageOverflow(page);

  await page.getByTestId("mobile-task").filter({ hasText: "SET-MOBILE-TASK" }).click();
  await expect(page.getByText("submitted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "approve", exact: true }).click();
  await expect(page.getByText("approved", { exact: true })).toBeVisible();

  await page.goto("/app/mobile/purchase-orders/PO-MOBILE-APPROVE");
  await expect(page.getByTestId("mobile-po-detail")).toContainText("Finance Browser Supplier");
  await expect(page.getByTestId("mobile-po-detail")).toContainText("CNY 100");
  await page.getByTestId("mobile-po-approve").click();
  await expect(page.getByTestId("mobile-po-status")).toHaveText("approved");
  await expect(page.getByTestId("mobile-po-approve")).toHaveCount(0);

  await page.goto("/app/mobile/purchase-orders/PO-MOBILE-REJECT");
  await expect(page.getByTestId("mobile-po-reject")).toBeVisible();
  await context.setOffline(true);
  await page.getByTestId("mobile-po-reject").click();
  await expect(page.getByTestId("mobile-network-status")).toContainText("离线");
  await expect(page.getByTestId("mobile-network-status")).toContainText("等待同步");
  await context.setOffline(false);
  await expect(page.getByTestId("mobile-network-status")).toContainText("在线");
  page.once("dialog", (dialog) => dialog.accept("Mobile rejection evidence"));
  await page.getByTestId("mobile-po-reject").click();
  await expect(page.getByTestId("mobile-po-status")).toHaveText("rejected");

  const race = await api(request, mobile.token, "get", "/api/mobile/purchase-orders/PO-MOBILE-RACE");
  await api(request, mobile.token, "post", "/api/mobile/purchase-orders/PO-MOBILE-RACE/approve", {
    expectedVersion: race.entityVersion,
    idempotencyKey: "mobile-browser-po-race-device-a",
    clientMutationId: "mobile-browser-po-race-device-a",
    sourceDeviceId: "device-a",
  }, { "X-Device-Id": "device-a" });
  const stale = await request.post("/api/mobile/purchase-orders/PO-MOBILE-RACE/reject", {
    headers: { Authorization: `Bearer ${mobile.token}`, "X-Device-Id": "device-b" },
    data: {
      expectedVersion: race.entityVersion,
      reason: "Device B stale rejection",
      idempotencyKey: "mobile-browser-po-race-device-b",
      clientMutationId: "mobile-browser-po-race-device-b",
      sourceDeviceId: "device-b",
    },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).code).toBe("SYNC_VERSION_CONFLICT");

  const viewer = await login(request, "viewer@example.com");
  const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const viewerPage = await viewerContext.newPage();
  await installSession(viewerPage, viewer);
  await viewerPage.goto("/app/mobile/purchase-orders/PO-MOBILE-RACE");
  await expect(viewerPage.getByTestId("mobile-po-detail")).toContainText("Restricted");
  await expect(viewerPage.getByTestId("mobile-po-detail")).not.toContainText("Finance Browser Supplier");
  await expect(viewerPage.getByTestId("mobile-po-detail")).not.toContainText("CNY 100");
  const cached = await viewerPage.evaluate(() => JSON.stringify(localStorage));
  expect(cached).not.toContain("Finance Browser Supplier");
  expect(cached).not.toContain("CNY 100");
  await viewerContext.close();
  await context.close();
});

test("mobile receiving posts partial GRNs with evidence, replay protection, conflicts, and inventory impact", async ({ browser, request }) => {
  const mobile = await login(request, "mobile@example.com");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await installSession(page, mobile);
  await page.goto("/app/mobile/receiving");
  await expect(page.getByTestId("mobile-receiving-home")).toBeVisible();
  await page.getByLabel("采购订单号").fill("mobile-browser-receiving-po");
  await page.getByTestId("mobile-receiving-search").click();
  const row = page.getByTestId("mobile-receiving-po").filter({ hasText: "mobile-browser-receiving-po" });
  await expect(row).toContainText("剩余 10.0000");
  await page.getByLabel("接收数量 FIN-BROWSER").fill("4");
  await row.getByTestId("mobile-prepare-receiving").click();
  await expect(page).toHaveURL(/\/app\/mobile\/receiving\/.+/);
  const receivingId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
  await expect(page.getByTestId("mobile-receiving-detail")).toContainText("draft");

  const attachmentResponse = page.waitForResponse((response) => response.url().includes(`/api/receiving/drafts/${encodeURIComponent(receivingId)}/attachments`) && response.status() === 201);
  await page.getByTestId("mobile-receiving-attachment").setInputFiles(resolve("tests/fixtures/payment-proof.txt"));
  await attachmentResponse;
  await page.getByTestId("mobile-receiving-submit").click();
  await expect(page.getByTestId("mobile-receiving-detail")).toContainText("ready_for_receiving");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("mobile-receiving-post").click();
  await expect(page.getByTestId("mobile-receiving-detail")).toContainText("posted");
  await expect(page.getByTestId("mobile-inventory-impact")).toContainText("GRN");
  await expect(page.getByTestId("mobile-inventory-impact")).toContainText("库存影响: 1");
  await expectNoPageOverflow(page);

  const deviceB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const deviceBPage = await deviceB.newPage();
  await installSession(deviceBPage, mobile);
  await deviceBPage.goto(`/app/mobile/receiving/${encodeURIComponent(receivingId)}`);
  await expect(deviceBPage.getByTestId("mobile-inventory-impact")).toContainText("GRN");
  await expect(deviceBPage.getByTestId("mobile-inventory-impact")).toContainText("库存影响: 1");
  await deviceB.close();

  const search = await api(request, mobile.token, "get", "/api/mobile/receiving/purchase-orders?search=mobile-browser-receiving-po");
  expect(search.items[0].lines[0].remainingQuantity).toBe("6.0000");
  const second = await api(request, mobile.token, "post", "/api/mobile/receiving/drafts", {
    poId: "mobile-browser-receiving-po",
    warehouseId: "finance-browser-warehouse",
    lines: [{ purchaseOrderLineId: "mobile-browser-receiving-po-line", acceptedQuantity: "2", damagedQuantity: "0", rejectedQuantity: "0", location: "A-02" }],
    idempotencyKey: "mobile-browser-receiving-second-create",
    clientMutationId: "mobile-browser-receiving-second-create",
    sourceDeviceId: "device-a",
  }, { "X-Device-Id": "device-a" });
  const submitted = await api(request, mobile.token, "post", `/api/mobile/receiving/drafts/${second.entityId}/submit`, {
    expectedVersion: second.receivingDocument.version,
    idempotencyKey: "mobile-browser-receiving-second-submit",
    sourceDeviceId: "device-a",
  }, { "X-Device-Id": "device-a" });
  const postBody = { expectedVersion: submitted.receivingDocument.version, idempotencyKey: "mobile-browser-receiving-second-post" };
  await api(request, mobile.token, "post", `/api/mobile/receiving/${second.entityId}/post`, postBody, { "X-Device-Id": "device-a" });
  const replay = await api(request, mobile.token, "post", `/api/mobile/receiving/${second.entityId}/post`, postBody, { "X-Device-Id": "device-a" });
  expect(replay.idempotentReplay).toBe(true);
  const stalePost = await request.post(`/api/mobile/receiving/${second.entityId}/post`, {
    headers: { Authorization: `Bearer ${mobile.token}`, "X-Device-Id": "device-b" },
    data: { expectedVersion: submitted.receivingDocument.version, idempotencyKey: "mobile-browser-receiving-second-post-device-b" },
  });
  expect(stalePost.status()).toBe(409);
  expect((await stalePost.json()).code).toBe("SYNC_VERSION_CONFLICT");

  const overReceipt = await request.post("/api/mobile/receiving/drafts", {
    headers: { Authorization: `Bearer ${mobile.token}`, "X-Device-Id": "device-b" },
    data: {
      poId: "mobile-browser-receiving-po",
      warehouseId: "finance-browser-warehouse",
      lines: [{ purchaseOrderLineId: "mobile-browser-receiving-po-line", acceptedQuantity: "5", location: "A-03" }],
      idempotencyKey: "mobile-browser-receiving-over-receipt",
      clientMutationId: "mobile-browser-receiving-over-receipt",
      sourceDeviceId: "device-b",
    },
  });
  expect(overReceipt.status()).toBe(409);
  expect((await overReceipt.json()).code).toBe("RECEIVING_OVER_RECEIPT");

  const posted = await api(request, mobile.token, "get", `/api/mobile/receiving/${receivingId}`);
  const immutable = await request.patch(`/api/mobile/receiving/drafts/${receivingId}`, {
    headers: { Authorization: `Bearer ${mobile.token}`, "X-Device-Id": "device-a" },
    data: { expectedVersion: posted.receivingDocument.version, lines: posted.lines },
  });
  expect(immutable.status()).toBe(409);
  expect((await immutable.json()).code).toBe("RECEIVING_IMMUTABLE");
  const grn = await api(request, mobile.token, "get", `/api/mobile/receiving/${receivingId}/grn`);
  const impact = await api(request, mobile.token, "get", `/api/mobile/receiving/${receivingId}/inventory-impact`);
  expect(grn.grn.postingStatus).toBe("posted");
  expect(impact.inventoryImpact.length).toBeGreaterThan(0);
  await context.close();
});

test("mobile workbenches localize in English and remain overflow-free at tablet width", async ({ browser, request }) => {
  const english = await login(request, "mobile-en@example.com");
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  await installSession(page, english);
  await page.goto("/app/mobile/tasks");
  await expect(page.getByRole("heading", { name: "Mobile Tasks" })).toBeVisible();
  await expect(page.getByTestId("mobile-network-status")).toContainText("Online");
  await expectNoPageOverflow(page);
  await page.goto("/app/mobile/receiving");
  await expect(
    page.getByTestId("mobile-operations-workbench").getByRole("heading", { name: "Mobile Receiving" }),
  ).toBeVisible();
  await page.getByLabel("PO number").fill("mobile-browser-receiving-po");
  await page.getByTestId("mobile-receiving-search").click();
  await expect(page.getByTestId("mobile-receiving-po")).toContainText("Remaining");
  await expectNoPageOverflow(page);
  await context.close();
});
