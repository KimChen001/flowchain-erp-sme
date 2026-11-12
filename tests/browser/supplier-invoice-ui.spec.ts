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
  await expect(page.getByTestId("supplier-invoice-create")).toBeEnabled();
  await page.getByTestId("supplier-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("supplier-invoice-detail")).toContainText(number);
}

async function run(page: Page, id: string, reason?: string) {
  // A status-only step runs on one click (D4); the step is done when its button goes.
  if ((await page.getByTestId(id).getAttribute("data-one-step")) === "true") {
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveCount(0);
    return;
  }
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

test("one note approves a price difference and the amount difference it causes", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/procurement/bills");
  await page.getByTestId("supplier-invoice-new").click();
  await page.getByTestId("supplier-invoice-supplier").selectOption({ index: 1 });
  await page.getByTestId("supplier-invoice-receipt").selectOption({ index: 1 });
  await page.getByTestId("supplier-invoice-number").fill("UI-INV-PRICE");
  await page.getByTestId("supplier-invoice-due").fill("2026-11-01");
  const line = page.getByTestId("supplier-invoice-line").first();
  await line.locator("input").nth(0).fill("2");
  await line.locator("input").nth(1).fill("12");
  // A hint, not a refusal: the price is above the order's.
  await expect(line.getByTestId("supplier-invoice-price-above")).toContainText(/above the PO price|比采购单价高/);
  await page.getByTestId("supplier-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
  // The header says when the invoice was issued and is due, and in which currency.
  await expect(page.getByTestId("supplier-invoice-due-date")).not.toHaveText("—");
  await expect(page.getByTestId("supplier-invoice-currency-fact")).not.toHaveText("—");
  await run(page, "invoice-submit");
  await run(page, "invoice-match");
  const match = page.getByTestId("supplier-invoice-match");
  const price = match.locator('[data-testid="match-exception"][data-type="price"]');
  const amount = match.locator('[data-testid="match-exception"][data-type="amount"]');
  await expect(price).toContainText(/Price difference|价格差异/);
  await expect(amount).toContainText(/Amount difference|金额差异/);
  await expect(match.getByTestId("supplier-invoice-match-summary")).toContainText(/2 line differences to review|2 处行差异待复核/);
  // The amount difference follows from the price: it has no buttons of its own.
  await expect(amount.getByTestId("match-exception-follows-price")).toBeVisible();
  await expect(amount.locator('[data-testid^="exception-approve-"]')).toHaveCount(0);
  const approve = price.locator('[data-testid^="exception-approve-"]').first();
  const approveId = String(await approve.getAttribute("data-testid"));
  await approve.click();
  await expect(page.getByTestId(`${approveId}-note`)).toContainText(/also accepts the amount difference it causes|一并接受由它造成的金额差异/);
  // Confirm works before Preview; an empty note is named under its field.
  await expect(page.getByTestId(`${approveId}-confirm`)).toBeEnabled();
  await page.getByTestId(`${approveId}-confirm`).click();
  await expect(page.getByTestId(`${approveId}-reason`)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId(`${approveId}-reason-error`)).toContainText(/Enter why you accept this difference\.|请填写处理说明。/);
  await page.getByTestId(`${approveId}-reason`).fill("Supplier raised the price; buyer agreed");
  await page.getByTestId(`${approveId}-confirm`).click();
  await expect(page.getByTestId(`${approveId}-panel`)).toHaveCount(0);
  // Both are approved with the same note, and the match is no longer an exception.
  await expect(match.locator('[data-testid^="exception-approve-"]')).toHaveCount(0);
  await expect(amount).toContainText("Supplier raised the price; buyer agreed");
  await expect(match).toContainText(/Variance approved|差异已批准/);
  await expect(page.getByTestId("supplier-invoice-variance-reason")).toHaveCount(0);
  // The header no longer reads "Exception", and a toast leads back up to Approve.
  await expect(page.getByTestId("supplier-invoice-ready-to-approve")).toHaveText(/Variance approved, ready to approve|差异已批准，待批准/);
  await expect(page.getByTestId("supplier-invoice-status")).not.toContainText(/^(Exception|异常)$/);
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: /Differences approved\. Next: approve the invoice|差异已批准，下一步：批准发票/ });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: /Go to Approve|前往批准/ }).click();
  await expect(page.getByTestId("invoice-approve")).toBeFocused();
  await run(page, "invoice-approve");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: /Approved UI-INV-PRICE|已批准 UI-INV-PRICE/ })).toBeVisible();
  await expect(page.getByTestId("supplier-invoice-payable")).toBeVisible();
  // Approved, nothing paid yet: the invoice reads "To pay".
  await expect(page.getByTestId("supplier-invoice-status")).toContainText(/To pay|待付款/);
  await expect(page.getByTestId("supplier-invoice-next")).toContainText(/Next|下一步/);
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
  await expect(page.getByTestId("duplicate-window")).toContainText(/cancelled invoices not compared|已取消的采购发票不比较/);
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
  await expect(page.getByTestId("duplicate-dismiss-likely-panel")).toContainText(/Enter why this supplier invoice is not a duplicate|请填写不是重复的原因/);
  await page.getByTestId("duplicate-dismiss-likely-reason").fill("The draft UI-DUP-007 was entered by mistake");
  await page.getByTestId("duplicate-dismiss-likely-preview").click();
  await expect(page.getByTestId("duplicate-dismiss-likely-confirm")).toBeEnabled();
  await page.getByTestId("duplicate-dismiss-likely-confirm").click();
  await expect(page.getByTestId("duplicate-dismissal")).toContainText("The draft UI-DUP-007 was entered by mistake");
  await expect(page.getByTestId("duplicate-flag")).toHaveAttribute("data-status", "dismissed");

  await run(page, "invoice-approve");
  await expect(page.getByTestId("supplier-invoice-payable")).toBeVisible();
});
