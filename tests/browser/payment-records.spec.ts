import { expect, test, type Page } from "@playwright/test";

// Payments made or received outside FlowChain are recorded on the bill or the
// invoice they settle (docs/bills-invoices-and-accounting-handoff.md, step 2):
// a partial payment leaves the rest outstanding, the last one settles it, and
// a wrong record is voided with a reason. Nothing here moves money.
test.setTimeout(180_000);

async function signIn(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", { data: { email, name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

async function run(page: Page, id: string, reason?: string) {
  await page.getByTestId(id).click();
  if (reason) await page.getByTestId(`${id}-reason`).fill(reason);
  await page.getByTestId(`${id}-preview`).click();
  await expect(page.getByTestId(`${id}-confirm`)).toBeEnabled();
  await page.getByTestId(`${id}-confirm`).click();
  await expect(page.getByTestId(`${id}-panel`)).toHaveCount(0);
}

// Opens the payment form, optionally changes the amount it offers (what is
// outstanding), previews and confirms.
async function recordPayment(page: Page, { amount, reference, status }: { amount?: (offered: number) => string; reference: string; status: RegExp }) {
  await page.getByTestId("payment-record").click();
  const field = page.getByTestId("payment-amount");
  if (amount) await field.fill(amount(Number(await field.inputValue())));
  await page.getByTestId("payment-method").selectOption("check");
  await page.getByTestId("payment-reference").fill(reference);
  await page.getByTestId("payment-preview").click();
  await expect(page.getByTestId("payment-preview-result")).toContainText(status);
  await page.getByTestId("payment-confirm").click();
  await expect(page.getByTestId("payment-record-panel")).toHaveCount(0);
}

test("a bill to pay is paid in two parts and a wrong payment is voided", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/procurement/bills/new?po=finance-browser-po");
  await expect(page.getByTestId("supplier-invoice-receipt")).toHaveValue("finance-browser-grn");
  await page.getByTestId("supplier-invoice-number").fill("UI-PAY-BILL");
  await page.getByTestId("supplier-invoice-due").fill("2026-11-01");
  await page.getByTestId("supplier-invoice-preview").click();
  await expect(page.getByTestId("supplier-invoice-create")).toBeEnabled();
  await page.getByTestId("supplier-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
  await run(page, "invoice-submit");
  await run(page, "invoice-match");
  await run(page, "invoice-approve");

  const payable = page.getByTestId("supplier-invoice-payable");
  await expect(payable.getByTestId("payment-records-empty")).toBeVisible();
  await recordPayment(page, { amount: (offered) => (offered / 2).toFixed(2), reference: "CHK-1001", status: /Partly paid|部分付款/ });
  await expect(payable.getByTestId("payment-row")).toHaveCount(1);
  await expect(payable).toContainText(/Partly paid|部分付款/);
  // The form offers what is still outstanding: paying it settles the bill.
  await recordPayment(page, { reference: "CHK-1002", status: /Paid|已结清/ });
  await expect(payable.getByTestId("payment-row")).toHaveCount(2);
  await expect(page.getByTestId("payment-record")).toHaveCount(0);

  // The second check bounced: void it, and the amount is owed again.
  const bounced = payable.getByTestId("payment-row").filter({ hasText: "CHK-1002" });
  const voidId = await bounced.locator('[data-testid^="payment-void-"]').first().getAttribute("data-testid");
  await run(page, String(voidId), "Check bounced");
  await expect(bounced).toContainText(/Voided|已作废/);
  await expect(bounced).toContainText("Check bounced");
  await expect(payable).toContainText(/Partly paid|部分付款/);
  await expect(page.getByTestId("payment-record")).toBeVisible();

  // Bills to pay link back to their bill.
  await page.goto("/app/finance/payables");
  await page.getByTestId("operational-finance-payable-list").getByRole("link", { name: "AP-UI-PAY-BILL" }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
});

test("a customer payment settles the receivable of an issued invoice", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/sales/invoices/new?shipment=finance-browser-shipment-USD");
  await expect(page.getByTestId("customer-invoice-shipment")).toHaveValue("finance-browser-shipment-USD");
  await page.getByTestId("customer-invoice-number").fill("UI-PAY-INV");
  await page.getByTestId("customer-invoice-due").fill("2026-11-15");
  await page.getByTestId("customer-invoice-preview").click();
  await expect(page.getByTestId("customer-invoice-create")).toBeEnabled();
  await page.getByTestId("customer-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/sales\/invoices\/[0-9a-f-]{36}$/);
  await run(page, "customer-invoice-submit");
  await run(page, "customer-invoice-approve");
  await run(page, "customer-invoice-issue");

  const receivable = page.getByTestId("customer-invoice-receivable");
  await expect(receivable).toContainText("AR-UI-PAY-INV");
  await recordPayment(page, { reference: "WIRE-77", status: /Paid|已结清/ });
  await expect(receivable.getByTestId("payment-row")).toHaveCount(1);
  await expect(receivable).toContainText(/Paid|已结清/);

  await page.goto("/app/finance/receivables");
  const row = page.getByTestId("receivables-workbench").getByRole("row").filter({ hasText: "UI-PAY-INV" });
  await expect(row).toContainText(/Paid|已结清/);
  await row.getByRole("link", { name: "UI-PAY-INV" }).click();
  await expect(page).toHaveURL(/\/app\/sales\/invoices\/[0-9a-f-]{36}$/);
});
