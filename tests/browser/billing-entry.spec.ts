import { expect, test, type Page } from "@playwright/test";

// Bills start from a purchase order, before or after its goods arrive, and
// invoices from shipped goods (docs/bills-invoices-and-accounting-handoff.md):
// the entry forms open with the source document chosen. A bill recorded
// before the goods waits for its receipt, which is linked once posted; only
// then is it matched and approved. An invoice is submitted, approved and
// issued on screen until its receivable opens. The "Record bill" and "Create
// invoice" buttons on receipts, orders and shipments need the receiving and
// outbound read models, which this finance-only database does not serve.
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

async function run(page: Page, id: string) {
  await page.getByTestId(id).click();
  await page.getByTestId(`${id}-preview`).click();
  await expect(page.getByTestId(`${id}-confirm`)).toBeEnabled();
  await page.getByTestId(`${id}-confirm`).click();
  await expect(page.getByTestId(`${id}-panel`)).toHaveCount(0);
}

test("a bill opened from its purchase order starts with the received goods", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/procurement/bills/new?po=finance-browser-po");
  await expect(page.getByTestId("supplier-invoice-supplier")).toHaveValue("finance-browser-supplier");
  await expect(page.getByTestId("supplier-invoice-receipt")).toHaveValue("finance-browser-grn");
  await expect(page.getByTestId("supplier-invoice-po")).toHaveValue("finance-browser-po");
  // The received quantity is offered; the server still checks what is left.
  await expect(page.getByTestId("supplier-invoice-line").first().locator("input").first()).toHaveValue("10");
  await page.getByTestId("supplier-invoice-number").fill("UI-BILL-FROM-PO");
  await page.getByTestId("supplier-invoice-due").fill("2026-11-01");
  await page.getByTestId("supplier-invoice-preview").click();
  await expect(page.getByTestId("supplier-invoice-create")).toBeEnabled();
  await page.getByTestId("supplier-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("supplier-invoice-sources")).toContainText("finance-browser-po");
});

test("an unknown purchase order is explained, not billed", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/procurement/bills/new?po=NO-SUCH-PO");
  await expect(page.getByRole("alert").filter({ hasText: "NO-SUCH-PO" })).toBeVisible();
  await expect(page.getByTestId("supplier-invoice-preview")).toBeDisabled();
});

test("a bill that arrives before the goods is recorded and waits for its receipt", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/procurement/bills/new?po=finance-browser-po-awaiting");
  await expect(page.getByTestId("supplier-invoice-po")).toHaveValue("finance-browser-po-awaiting");
  await expect(page.getByTestId("supplier-invoice-receipt")).toHaveValue("");
  await expect(page.getByTestId("supplier-invoice-before-receipt")).toBeVisible();
  // What was ordered and not yet billed is offered.
  await expect(page.getByTestId("supplier-invoice-line").first().locator("input").first()).toHaveValue("6");
  await page.getByTestId("supplier-invoice-number").fill("UI-BILL-EARLY");
  await page.getByTestId("supplier-invoice-due").fill("2026-11-01");
  await page.getByTestId("supplier-invoice-preview").click();
  await expect(page.getByTestId("supplier-invoice-create")).toBeEnabled();
  await page.getByTestId("supplier-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("supplier-invoice-awaiting-receipt")).toBeVisible();
  await expect(page.getByTestId("link-receipt-none")).toContainText("finance-browser-po-awaiting");
  await run(page, "invoice-submit");
  // Nothing to match against yet, so nothing to approve or pay.
  await expect(page.getByTestId("supplier-invoice-awaiting-receipt")).toBeVisible();
  await expect(page.getByTestId("invoice-match")).toHaveCount(0);
  await page.goto("/app/procurement/bills");
  await expect(page.getByRole("row").filter({ hasText: "UI-BILL-EARLY" }).getByTestId("bill-awaiting-receipt")).toBeVisible();
});

test("a waiting bill is linked to its receipt, then matched and approved", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/procurement/bills/new?po=finance-browser-po");
  await expect(page.getByTestId("supplier-invoice-receipt")).toHaveValue("finance-browser-grn");
  // The supplier's bill came first: record it without the receipt.
  await page.getByTestId("supplier-invoice-receipt").selectOption("");
  await expect(page.getByTestId("supplier-invoice-before-receipt")).toBeVisible();
  await page.getByTestId("supplier-invoice-line").first().locator("input").first().fill("4");
  await page.getByTestId("supplier-invoice-number").fill("UI-BILL-LINK");
  await page.getByTestId("supplier-invoice-due").fill("2026-11-01");
  await page.getByTestId("supplier-invoice-preview").click();
  await expect(page.getByTestId("supplier-invoice-create")).toBeEnabled();
  await page.getByTestId("supplier-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/procurement\/bills\/[0-9a-f-]{36}$/);
  await run(page, "invoice-submit");
  await expect(page.getByTestId("invoice-match")).toHaveCount(0);
  // The warehouse posted the receipt: link it.
  await page.getByTestId("link-receipt").click();
  await expect(page.getByTestId("link-receipt-select")).toHaveValue("finance-browser-grn");
  await page.getByTestId("link-receipt-preview").click();
  await expect(page.getByTestId("link-receipt-confirm")).toBeEnabled();
  await page.getByTestId("link-receipt-confirm").click();
  await expect(page.getByTestId("supplier-invoice-awaiting-receipt")).toHaveCount(0);
  // The receipt shows by its GRN number, not its stored id.
  await expect(page.getByTestId("supplier-invoice-sources")).toContainText("GRN-FIN-BROWSER");
  await expect(page.getByTestId("supplier-invoice-sources")).not.toContainText("finance-browser-grn");
  await run(page, "invoice-match");
  await expect(page.getByTestId("supplier-invoice-match")).toBeVisible();
  await run(page, "invoice-approve");
  await expect(page.getByTestId("supplier-invoice-payable")).toContainText("AP-UI-BILL-LINK");
});

test("an invoice opened from its shipment is submitted, approved and issued on screen", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/sales/invoices/new?shipment=finance-browser-shipment-USD");
  await expect(page.getByTestId("customer-invoice-shipment")).toHaveValue("finance-browser-shipment-USD");
  await expect(page.getByTestId("customer-invoice-line").first().locator("input").first()).toHaveValue("10");
  await page.getByTestId("customer-invoice-number").fill("UI-INV-FROM-SHIP");
  await page.getByTestId("customer-invoice-due").fill("2026-11-15");
  await page.getByTestId("customer-invoice-preview").click();
  await expect(page.getByTestId("customer-invoice-create")).toBeEnabled();
  await page.getByTestId("customer-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/sales\/invoices\/[0-9a-f-]{36}$/);
  const detail = page.getByTestId("customer-invoice-detail");
  await expect(detail).toContainText("UI-INV-FROM-SHIP");
  await expect(page.getByTestId("customer-invoice-sources")).toContainText("SHIP-FIN-BROWSER-USD");
  await run(page, "customer-invoice-submit");
  await run(page, "customer-invoice-approve");
  await run(page, "customer-invoice-issue");
  // Issuing opens the receivable; nothing here collects money.
  await expect(page.getByTestId("customer-invoice-receivable")).toContainText("AR-UI-INV-FROM-SHIP");
  await expect(page.getByTestId("customer-invoice-actions").getByRole("button")).toHaveCount(0);
});

test("an invoice opened from a sales order lists only that order's shipments", async ({ page }) => {
  await signIn(page, "manager@example.com");
  await page.goto("/app/sales/invoices/new?salesOrder=finance-browser-sales-order-CNY");
  await expect(page.getByTestId("customer-invoice-order-filter")).toContainText("finance-browser-sales-order-CNY");
  await expect(page.getByTestId("customer-invoice-shipment")).toHaveValue("finance-browser-shipment-CNY");
  await expect(page.getByTestId("customer-invoice-shipment").locator("option")).toHaveCount(2);
});
