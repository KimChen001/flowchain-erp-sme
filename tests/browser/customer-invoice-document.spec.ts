import { expect, test, type Page } from "@playwright/test";

// The customer invoice document on the operational finance scenario: an
// invoice drafted from the posted USD shipment (10 x FIN-BROWSER at 12.50 USD,
// no tax) for "Finance Browser Customer USD", who has no customer master
// record. Approved, the document can be checked on screen but not printed;
// issued, it prints alone. A person sends it; FlowChain sends nothing.
// Switching the document to Chinese changes its labels, not one number or date.
test.setTimeout(180_000);

async function signIn(page: Page) {
  const response = await page.request.post("/api/auth/login", { data: { email: "manager@example.com", name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  // The scenario workspace is a Chinese one; this check reads the English interface.
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: "en-US", defaultLanguage: "en-US", effectiveLanguage: "en-US", locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

// A status-only action takes one click once it is marked one-step (#189);
// otherwise it opens the panel: preview, then confirm.
async function run(page: Page, id: string) {
  if ((await page.getByTestId(id).getAttribute("data-one-step")) === "true") {
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveCount(0);
    return;
  }
  await page.getByTestId(id).click();
  await page.getByTestId(`${id}-preview`).click();
  await expect(page.getByTestId(`${id}-confirm`)).toBeEnabled();
  await page.getByTestId(`${id}-confirm`).click();
  await expect(page.getByTestId(`${id}-panel`)).toHaveCount(0);
}

const figures = async (page: Page) => ({
  number: await page.getByTestId("invoice-document-number").innerText(),
  date: await page.getByTestId("invoice-document-date").innerText(),
  due: await page.getByTestId("invoice-document-due-date").innerText(),
  currency: await page.getByTestId("invoice-document-currency").innerText(),
  sku: await page.getByTestId("invoice-document-line-sku").first().innerText(),
  quantity: await page.getByTestId("invoice-document-line-quantity").first().innerText(),
  unitPrice: await page.getByTestId("invoice-document-line-unit-price").first().innerText(),
  amount: await page.getByTestId("invoice-document-line-amount").first().innerText(),
  subtotal: await page.getByTestId("invoice-document-subtotal").innerText(),
  tax: await page.getByTestId("invoice-document-tax").innerText(),
  total: await page.getByTestId("invoice-document-total").innerText(),
  balance: await page.getByTestId("invoice-document-balance-due").innerText(),
});

test("an invoice is checked as a document when approved and printed alone once issued", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/sales/invoices/new?shipment=finance-browser-shipment-USD");
  await expect(page.getByTestId("customer-invoice-shipment")).toHaveValue("finance-browser-shipment-USD");
  await page.getByTestId("customer-invoice-number").fill("UI-DOC-INV");
  await page.getByTestId("customer-invoice-due").fill("2026-11-15");
  await page.getByTestId("customer-invoice-preview").click();
  await expect(page.getByTestId("customer-invoice-create")).toBeEnabled();
  await page.getByTestId("customer-invoice-create").click();
  await expect(page).toHaveURL(/\/app\/sales\/invoices\/[0-9a-f-]{36}$/);
  const invoiceUrl = page.url();
  // A draft has no document to open yet.
  await expect(page.getByTestId("customer-invoice-open-document")).toHaveCount(0);
  await run(page, "customer-invoice-submit");
  await run(page, "customer-invoice-approve");

  // Approved: the document opens to be checked, says not to send it, and cannot be printed.
  await page.getByTestId("customer-invoice-open-document").click();
  await expect(page).toHaveURL(/\/app\/sales\/invoices\/[0-9a-f-]{36}\/document$/);
  await expect(page.getByTestId("business-document-blocked")).toHaveText("Not issued — do not send.");
  await expect(page.getByTestId("business-document-print")).toBeDisabled();
  await expect(page.getByTestId("business-document-sheet")).toBeVisible();
  await expect(page.getByTestId("invoice-document-title")).toHaveText("Invoice");
  // Printed anyway from the browser, only the notice prints.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("business-document-sheet")).toBeHidden();
  await expect(page.getByTestId("business-document-blocked")).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  // Issued: the document is one to send.
  await page.goto(invoiceUrl);
  await run(page, "customer-invoice-issue");
  await page.getByTestId("customer-invoice-open-document").click();
  await expect(page).toHaveURL(/\/document$/);
  const sheet = page.getByTestId("business-document-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("business-document-blocked")).toHaveCount(0);
  await expect(page.getByTestId("business-document-print")).toBeEnabled();
  await expect(page.getByTestId("business-document-send-note")).toContainText("FlowChain does not send this document.");

  const english = await figures(page);
  expect(english).toMatchObject({ number: "UI-DOC-INV", currency: "USD", sku: "FIN-BROWSER", quantity: "10", unitPrice: "12.50", amount: "125.00", subtotal: "125.00", tax: "0.00", total: "125.00", balance: "125.00" });
  // The due date entered is the day printed, whatever the time zone.
  expect(english.due).toBe("Nov 15, 2026");
  await expect(page.getByTestId("invoice-document-totals")).toContainText("Total (USD)");
  await expect(page.getByTestId("invoice-document-payment-summary")).toContainText("Balance due");
  // The customer has no master record: only the name on the invoice, no
  // contact lines and no payment terms, nothing filled in.
  await expect(page.getByTestId("invoice-document-bill-to")).toContainText("Finance Browser Customer USD");
  await expect(page.getByTestId("invoice-document-bill-to").locator("p")).toHaveCount(1);
  await expect(page.getByTestId("invoice-document-payment-terms")).toHaveCount(0);
  // Tax per line is off by default.
  await expect(page.getByTestId("invoice-document-line-tax")).toHaveCount(0);

  // Printing shows the document alone.
  await page.emulateMedia({ media: "print" });
  await expect(sheet).toBeVisible();
  await expect(page.locator("aside").first()).toBeHidden();
  await expect(page.getByTestId("business-document-toolbar")).toBeHidden();
  await page.emulateMedia({ media: "screen" });

  // The document language changes the labels, never a number, a date, the
  // invoice number, a SKU or the currency.
  await page.getByTestId("business-document-language").selectOption("zh-CN");
  await expect(page.getByTestId("invoice-document-title")).toHaveText("销售发票");
  await expect(page.getByTestId("invoice-document-totals")).toContainText("合计（USD）");
  await expect(page.getByTestId("invoice-document-payment-summary")).toContainText("应收余额");
  expect(await figures(page)).toEqual(english);
  // The interface stays in English.
  await expect(page.getByTestId("business-document-print")).toHaveText("Print or save as PDF");
});

test("an invoice that does not exist shows the page's own notice inside the app", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/sales/invoices/NO-SUCH-INVOICE/document");
  await expect(page.getByTestId("app-main")).toBeVisible();
  await expect(page.getByTestId("invoice-document-unavailable")).toHaveText("This invoice was not found in this workspace.");
  await expect(page.getByTestId("not-found-recovery")).toHaveCount(0);
});
