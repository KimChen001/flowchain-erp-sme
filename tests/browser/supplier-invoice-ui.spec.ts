import { expect, test, type Page } from "@playwright/test";

// A finance user takes a posted receipt through the supplier invoice screens:
// enter the invoice, submit, match, approve, hold the payable; and an
// overcharge whose variance is rejected is cancelled instead of approved.
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
