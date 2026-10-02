import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test.setTimeout(180_000);
const login = async (request: any, email: string) => {
  const response = await request.post("/api/auth/login", {
    data: { email, name: "Ignored", company: "Ignored" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
};
const install = async (page: any, session: any) => page.addInitScript(({ token, user }) => { localStorage.setItem("flowchain:auth-token", token); localStorage.setItem("flowchain:current-user", JSON.stringify(user)); }, session);

// Owner decision: internal settlement, cashbook and the settlement workflow are
// frozen. Even with the capability enabled their pages show "Capability
// unavailable"; the UI flow below is kept, skipped, for when the freeze lifts.
test("frozen settlement and cashbook pages show Capability unavailable even when enabled", async ({ page, request }) => {
  const session = await login(request, "settlement@example.com");
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  for (const path of ["/app/finance/settlement", "/app/finance/reconciliation", "/app/mobile/settlements/any-settlement"]) {
    await page.goto(path);
    await expect(page.getByTestId("capability-route-blocked"), path).toBeVisible();
  }
});

test.skip("governed settlement runs create, submit, independent approval, post, evidence, reconciliation, and reversal", async ({ page, request, browser }) => {
  const finance = await login(request, "settlement@example.com");
  const manager = await login(request, "manager@example.com");
  await install(page, finance);
  await page.goto("/app/finance/reconciliation");
  await page.getByLabel("账户代码").fill("WF-CNY");
  await page.getByLabel("账户名称").fill("Workflow Cashbook");
  await page.getByLabel("期初余额").fill("500.0000");
  await page.getByTestId("create-cashbook-account").click();
  await expect(page.getByTestId("cashbook-account").filter({ hasText: "WF-CNY" })).toBeVisible();

  await page.goto("/app/finance/settlement");
  await page.getByLabel("结算单号").fill("SET-WORKFLOW-001");
  await page.getByLabel("Cashbook 账户").selectOption({ index: 1 });
  await page.getByLabel("待核销义务").selectOption({ index: 1 });
  await page.getByLabel("核销金额", { exact: true }).fill("80.0000");
  await page.getByLabel("现金核销金额").fill("60.0000");
  await page.getByTestId("preview-settlement").click();
  await expect(page.getByTestId("settlement-preview")).toContainText("校验通过");
  await page.getByTestId("create-settlement").click();
  const row = page.getByTestId("settlement-row").filter({ hasText: "SET-WORKFLOW-001" });
  await row.getByRole("link", { name: "SET-WORKFLOW-001" }).click();
  await page.getByTestId("submit-settlement").click();
  await expect(page.getByTestId("settlement-detail")).toContainText("submitted");
  await page.getByTestId("approve-settlement").click();
  await expect(page.getByTestId("settlement-detail")).toContainText("creator may not approve");
  const settlementId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);

  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  await install(managerPage, manager);
  await managerPage.goto(`/app/finance/settlement/${encodeURIComponent(settlementId)}`);
  await managerPage.getByTestId("approve-settlement").click();
  await expect(managerPage.getByTestId("settlement-detail")).toContainText("approved");
  await managerContext.close();

  await page.reload();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("post-settlement").click();
  await expect(page.getByTestId("settlement-detail")).toContainText("posted");
  await expect(page.getByTestId("settlement-detail")).toContainText("20.0000");
  const upload = page.locator('input[type="file"]');
  await upload.setInputFiles(resolve("tests/fixtures/payment-proof.txt"));
  await expect(page.getByTestId("settlement-detail")).toContainText("1 个附件");
  await expect(page.getByTestId("settlement-reconciliation")).toContainText("matched");
  await page.getByText("纠错操作").click();
  page.once("dialog", (dialog) => dialog.accept("Browser exact reversal"));
  await page.getByTestId("reverse-settlement").click();
  await expect(page.getByTestId("settlement-detail")).toContainText("reversed");

  const English = await login(request, "settlement-en@example.com");
  const englishContext = await browser.newContext();
  const englishPage = await englishContext.newPage();
  await install(englishPage, English);
  await englishPage.goto("/app/finance/settlement");
  await expect(englishPage.getByText("New internal settlement")).toBeVisible();
  await englishContext.close();
});

test("settlement discount, rejection, cancellation, advance application, and internal transfer commands remain governed", async ({ request }) => {
  const finance = await login(request, "settlement@example.com"), manager = await login(request, "manager@example.com");
  const financeHeaders = { Authorization: `Bearer ${finance.token}` }, managerHeaders = { Authorization: `Bearer ${manager.token}` };
  let accounts = await (await request.get("/api/finance/cashbook/accounts", { headers: financeHeaders })).json();
  if (!accounts.items.some((row: any) => row.accountCode === "WF-CNY")) await request.post("/api/finance/cashbook/accounts", { headers: financeHeaders, data: { accountCode: "WF-CNY", name: "Workflow Cashbook", accountType: "bank", currency: "CNY", openingBalance: "500", idempotencyKey: "browser-workflow-source-account" } });
  if (!accounts.items.some((row: any) => row.accountCode === "WF-TO")) await request.post("/api/finance/cashbook/accounts", { headers: financeHeaders, data: { accountCode: "WF-TO", name: "Workflow Transfer Target", accountType: "bank", currency: "CNY", openingBalance: "0", idempotencyKey: "browser-workflow-target-account" } });
  accounts = await (await request.get("/api/finance/cashbook/accounts", { headers: financeHeaders })).json();
  const accountId = accounts.items.find((row: any) => row.accountCode === "WF-CNY").id;
  const create = async (number: string, key: string) => {
    const response = await request.post("/api/finance/settlements", {
      headers: financeHeaders,
      data: {
        settlementNumber: number,
        direction: "disbursement",
        counterpartyType: "supplier",
        counterpartyId: "finance-browser-supplier",
        cashbookAccountId: accountId,
        currency: "CNY",
        amount: "55",
        settlementDate: "2026-07-20",
        allocations: [{
          obligationType: "payable",
          obligationId: "finance-browser-settlement-payable",
          cashAppliedAmount: "50",
          discountAmount: "5",
          totalSettlementAmount: "55",
          discountReason: "commercial settlement",
        }],
        idempotencyKey: key,
      },
    });
    return response.json();
  };
  const rejected = await create("SET-REJECT-001", "create-reject");
  const submitted = await (await request.post(`/api/finance/settlements/${rejected.entityId}/submit`, { headers: financeHeaders, data: { expectedVersion: 0, idempotencyKey: "submit-reject" } })).json();
  const rejectResponse = await request.post(`/api/finance/settlements/${rejected.entityId}/reject`, { headers: managerHeaders, data: { expectedVersion: submitted.settlement.version, reason: "Needs correction", idempotencyKey: "reject-reject" } });
  expect((await rejectResponse.json()).settlement.workflowStatus).toBe("rejected");
  const cancelled = await create("SET-CANCEL-001", "create-cancel");
  const cancelResponse = await request.post(`/api/finance/settlements/${cancelled.entityId}/cancel`, { headers: financeHeaders, data: { expectedVersion: 0, reason: "Duplicate draft", idempotencyKey: "cancel-cancel" } });
  expect((await cancelResponse.json()).settlement.workflowStatus).toBe("cancelled");

  const discount = await create("SET-DISCOUNT-001", "create-discount");
  const discountSubmitted = await (await request.post(`/api/finance/settlements/${discount.entityId}/submit`, { headers: financeHeaders, data: { expectedVersion: 0, idempotencyKey: "submit-discount" } })).json();
  const discountApproved = await (await request.post(`/api/finance/settlements/${discount.entityId}/approve`, { headers: managerHeaders, data: { expectedVersion: discountSubmitted.settlement.version, idempotencyKey: "approve-discount" } })).json();
  const discountPosted = await (await request.post(`/api/finance/settlements/${discount.entityId}/post`, { headers: financeHeaders, data: { expectedVersion: discountApproved.settlement.version, idempotencyKey: "post-discount" } })).json();
  expect(discountPosted.settlement.postingStatus).toBe("posted");

  const customerAdvance = await (await request.post("/api/finance/settlements", { headers: financeHeaders, data: { settlementNumber: "SET-CUSTOMER-ADVANCE", direction: "receipt", counterpartyType: "customer", counterpartyId: "finance-browser-customer-cny", cashbookAccountId: accountId, currency: "CNY", amount: "90", settlementDate: "2026-07-20", allocations: [{ obligationType: "receivable", obligationId: "finance-browser-settlement-receivable", cashAppliedAmount: "70", discountAmount: "0", totalSettlementAmount: "70" }], idempotencyKey: "customer-advance-create" } })).json();
  const customerSubmitted = await (await request.post(`/api/finance/settlements/${customerAdvance.entityId}/submit`, { headers: financeHeaders, data: { expectedVersion: 0, idempotencyKey: "customer-advance-submit" } })).json();
  const customerApproved = await (await request.post(`/api/finance/settlements/${customerAdvance.entityId}/approve`, { headers: managerHeaders, data: { expectedVersion: customerSubmitted.settlement.version, idempotencyKey: "customer-advance-approve" } })).json();
  const customerPosted = await (await request.post(`/api/finance/settlements/${customerAdvance.entityId}/post`, { headers: financeHeaders, data: { expectedVersion: customerApproved.settlement.version, idempotencyKey: "customer-advance-post" } })).json();
  expect(customerPosted.partnerAdvance.advanceType).toBe("customer_advance");
  const application = await (await request.post("/api/finance/advance-applications", { headers: financeHeaders, data: { applicationNumber: "AAP-BROWSER-001", advanceId: customerPosted.partnerAdvance.id, receivableObligationId: "finance-browser-settlement-receivable", appliedAmount: "10", currency: "CNY", idempotencyKey: "advance-application-create-browser" } })).json();
  const applicationSubmitted = await (await request.post(`/api/finance/advance-applications/${application.entityId}/submit`, { headers: financeHeaders, data: { expectedVersion: 0, idempotencyKey: "advance-application-submit-browser" } })).json();
  const applicationApproved = await (await request.post(`/api/finance/advance-applications/${application.entityId}/approve`, { headers: managerHeaders, data: { expectedVersion: applicationSubmitted.application.version, idempotencyKey: "advance-application-approve-browser" } })).json();
  const applicationPosted = await (await request.post(`/api/finance/advance-applications/${application.entityId}/post`, { headers: financeHeaders, data: { expectedVersion: applicationApproved.application.version, idempotencyKey: "advance-application-post-browser" } })).json();
  expect(applicationPosted.cashbookEntryCount).toBe(0);

  const transfer = await (await request.post("/api/finance/internal-transfers", { headers: financeHeaders, data: { transferNumber: "TR-BROWSER-001", fromCashbookAccountId: accountId, toCashbookAccountId: accounts.items.find((row: any) => row.accountCode === "WF-TO").id, currency: "CNY", amount: "10", transferDate: "2026-07-20", idempotencyKey: "transfer-create-browser" } })).json();
  const transferSubmitted = await (await request.post(`/api/finance/internal-transfers/${transfer.entityId}/submit`, { headers: financeHeaders, data: { expectedVersion: 0, idempotencyKey: "transfer-submit-browser" } })).json();
  const transferApproved = await (await request.post(`/api/finance/internal-transfers/${transfer.entityId}/approve`, { headers: managerHeaders, data: { expectedVersion: transferSubmitted.transfer.version, idempotencyKey: "transfer-approve-browser" } })).json();
  const transferPosted = await (await request.post(`/api/finance/internal-transfers/${transfer.entityId}/post`, { headers: financeHeaders, data: { expectedVersion: transferApproved.transfer.version, idempotencyKey: "transfer-post-browser" } })).json();
  expect(transferPosted.cashbookEntryIds).toHaveLength(2);
});
