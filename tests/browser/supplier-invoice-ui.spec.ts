import { expect, test, type Page } from "@playwright/test";

// A finance user takes a posted receipt through the supplier invoice screens:
// enter the invoice, submit, match, approve, hold the payable; an
// overcharge whose variance is rejected is cancelled instead of approved; and a
// bill that repeats another bill's number is approved only after its duplicate
// flag is dismissed with a reason.
test.setTimeout(150_000);

async function signIn(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", { data: { email, name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

async function enterInvoice(page: Page, number: string, quantity: string, unitPrice?: string) {
  await page.goto("/app/procurement/bills");
  await page.getByTestId("supplier-invoice-new").click();
  await expect(page.getByTestId("new-supplier-invoice")).toBeVisible();
  await page.getByTestId("supplier-invoice-supplier").selectOption({ index: 1 });
  await page.getByTestId("supplier-invoice-receipt").selectOption({ index: 1 });
  await page.getByTestId("supplier-invoice-number").fill(number);
  await page.getByTestId("supplier-invoice-due").fill("2026-11-01");
  const line = page.getByTestId("supplier-invoice-line").first();
  await line.locator("input").nth(0).fill(quantity);
  if (unitPrice) await line.locator("input").nth(1).fill(unitPrice);
  await page.getByTestId("supplier-invoice-preview").click();
  await expect(page.getByTestId("supplier-invoice-create")).toBeEnabled();
  await page.getByTestId("supplier-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("supplier-invoice-detail")).toContainText(number);
}

async function run(page: Page, id: string, reason?: string) {
  await page.getByTestId(id).click();
  if (reason) await page.getByTestId(`${id}-reason`).fill(reason);
  await page.getByTestId(`${id}-preview`).click();
  await expect(page.getByTestId(`${id}-confirm`)).toBeEnabled();
  await page.getByTestId(`${id}-confirm`).click();
  await expect(page.getByTestId(`${id}-panel`)).toHaveCount(0);
}

test("a supplier invoice goes from receipt to an approved, held payable on screen", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await enterInvoice(page, "UI-INV-001", "2");
  await run(page, "invoice-submit");
  await run(page, "invoice-match");
  await expect(page.getByTestId("supplier-invoice-match")).toBeVisible();
  await run(page, "invoice-approve");
  const payable = page.getByTestId("supplier-invoice-payable");
  await expect(payable).toContainText("AP-UI-INV-001");
  await run(page, "payable-hold", "Waiting for a credit note");
  await expect(page.getByTestId("payable-release")).toBeVisible();
  // No step offers anything once the invoice is approved.
  await expect(page.getByTestId("invoice-cancel")).toHaveCount(0);
});

test("a rejected overcharge is not offered for approval and can be cancelled", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await enterInvoice(page, "UI-INV-002", "3", "12");
  await run(page, "invoice-submit");
  await run(page, "invoice-match");
  const exception = page.getByTestId("match-exception").first();
  await expect(exception).toBeVisible();
  const reject = exception.locator('[data-testid^="exception-reject-"]').first();
  const rejectId = await reject.getAttribute("data-testid");
  await run(page, String(rejectId), "Price above the PO");
  await expect(page.getByTestId("invoice-approve")).toHaveCount(0);
  await run(page, "invoice-cancel", "Supplier billed above the PO price");
  await expect(page.getByTestId("supplier-invoice-actions")).not.toContainText(/Cancel invoice|取消发票/);
  await expect(page.getByTestId("supplier-invoice-detail")).toContainText(/Cancelled|已取消/);
});

test("a second bill numbered as a format variant is flagged, dismissed with a reason, then approved", async ({ page }) => {
  await signIn(page, "manager@example.com");
  // The supplier sends invoice 7 twice, written differently.
  await enterInvoice(page, "UI-DUP-007", "1");
  const original = page.url().split("/").at(-1);
  await enterInvoice(page, "ui dup 7", "1");
  const checks = page.getByTestId("supplier-invoice-duplicates");
  await expect(checks).toContainText(/Likely duplicate: same invoice number|疑似重复：.*发票号相同/);
  await expect(checks).toContainText("ui dup 7");
  await expect(checks).toContainText("UI-DUP-007");
  await expect(checks.getByRole("link", { name: "UI-DUP-007" })).toHaveAttribute("href", `/app/procurement/bills/${original}`);
  await expect(page.getByTestId("duplicate-window")).toContainText("7");
  await expect(page.getByTestId("duplicate-window")).toContainText(/cancelled bills not compared|已取消的账单不比较/);
  await run(page, "invoice-submit");
  await run(page, "invoice-match");

  // Approval asks for the review first.
  await page.getByTestId("invoice-approve").click();
  await page.getByTestId("invoice-approve-preview").click();
  await expect(page.getByTestId("invoice-approve-panel")).toContainText(/Dismiss each open duplicate flag with a reason|批准前请逐条填写原因排除重复标记/);
  await expect(page.getByTestId("invoice-approve-confirm")).toBeDisabled();
  // The flag is listed at the approval step with the other bill.
  await expect(page.getByTestId("invoice-approve-duplicate")).toHaveAttribute("data-kind", "likely");
  await expect(page.getByTestId("invoice-approve-duplicates").getByRole("link", { name: "UI-DUP-007" })).toHaveAttribute("href", `/app/procurement/bills/${original}`);
  await page.getByTestId("invoice-approve-panel").getByRole("button", { name: /^(Close|关闭)$/ }).click();

  // A reason is required; the dismissal shows who and why.
  await page.getByTestId("duplicate-dismiss-likely").click();
  await page.getByTestId("duplicate-dismiss-likely-preview").click();
  await expect(page.getByTestId("duplicate-dismiss-likely-panel")).toContainText(/Enter why this bill is not a duplicate|请填写不是重复的原因/);
  await page.getByTestId("duplicate-dismiss-likely-reason").fill("The draft UI-DUP-007 was entered by mistake");
  await page.getByTestId("duplicate-dismiss-likely-preview").click();
  await expect(page.getByTestId("duplicate-dismiss-likely-confirm")).toBeEnabled();
  await page.getByTestId("duplicate-dismiss-likely-confirm").click();
  await expect(page.getByTestId("duplicate-dismissal")).toContainText("The draft UI-DUP-007 was entered by mistake");
  await expect(page.getByTestId("duplicate-flag")).toHaveAttribute("data-status", "dismissed");

  await run(page, "invoice-approve");
  await expect(page.getByTestId("supplier-invoice-payable")).toBeVisible();
});
