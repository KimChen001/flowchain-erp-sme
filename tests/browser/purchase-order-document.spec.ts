import { expect, test, type Page } from "@playwright/test";

// The PO document on the walkthrough scenario: LOCAL-DEMO-PO-021 is an
// approved Acme order of 25 × LDM-002 at 100.00 USD for the seeded walkthrough warehouse,
// with no supplier SKU and no approval step recorded; LOCAL-DEMO-PO-024 is
// still pending approval. The document is printed or saved as PDF by a
// person, who sends it; FlowChain sends nothing. Printing shows the document
// alone, and switching the document to Chinese changes its labels but not
// one number or date.

async function signIn(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "PO document", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: "en-US", defaultLanguage: "en-US", effectiveLanguage: "en-US", locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

// The walkthrough warehouse as seeded: LOCAL-DEMO-WH-001 = { code: "US-DEMO", name: "US Demo Warehouse" }.
const SHIP_TO = { code: "US-DEMO", name: "US Demo Warehouse" }; // LOCAL-DEMO-WH-001

const figures = async (page: Page) => ({
  quantity: await page.getByTestId("po-document-line-quantity").first().innerText(),
  unitPrice: await page.getByTestId("po-document-line-unit-price").first().innerText(),
  amount: await page.getByTestId("po-document-line-amount").first().innerText(),
  total: await page.getByTestId("po-document-total").first().innerText(),
  expected: await page.getByTestId("po-document-expected-date").innerText(),
  sku: await page.getByTestId("po-document-line-sku").first().innerText(),
  supplierSku: await page.getByTestId("po-document-line-supplier-sku").first().innerText(),
  number: await page.getByTestId("po-document-number").innerText(),
  currency: await page.getByTestId("po-document-currency").innerText(),
});

test("an approved PO opens as a document to print or save, which prints alone and keeps its figures in Chinese", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-021");
  await page.getByTestId("po-open-document").click();
  await expect(page).toHaveURL(/\/app\/procurement\/orders\/LOCAL-DEMO-PO-021\/document$/);

  const sheet = page.getByTestId("business-document-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("po-document-title")).toHaveText("Purchase Order");
  await expect(page.getByTestId("po-document-supplier")).toContainText("Supplier");
  await expect(page.getByTestId("business-document-send-note")).toContainText("FlowChain does not send this document.");
  await expect(page.getByTestId("business-document-print")).toBeEnabled();
  await expect(page.getByTestId("business-document-blocked")).toHaveCount(0);

  const english = await figures(page);
  expect(english).toMatchObject({ quantity: "25", unitPrice: "100.00", amount: "2,500.00", total: "2,500.00", currency: "USD", number: "LOCAL-DEMO-PO-021", sku: "LDM-002" });
  // Ship to is the warehouse's code and name; it has no address.
  await expect(page.getByTestId("po-document-ship-to")).toContainText(SHIP_TO.name);
  await expect(page.getByTestId("po-document-ship-to")).toContainText(SHIP_TO.code);
  // A value the PO does not record prints "—", never a guess.
  expect(english.supplierSku).toBe("—");
  // Not issued yet, and no approval step recorded: neither date is printed.
  await expect(page.getByTestId("po-document-issue-date")).toHaveCount(0);
  await expect(page.getByTestId("po-document-approved-on")).toHaveCount(0);
  await expect(page.getByTestId("business-document-language-hint")).toContainText("For this print only");
  await expect(page.getByTestId("po-document-totals")).toContainText("Total (USD)");

  // Printing shows the document alone: no navigation, header, toolbar or assistant.
  await page.emulateMedia({ media: "print" });
  await expect(sheet).toBeVisible();
  await expect(page.locator("aside").first()).toBeHidden();
  await expect(page.locator("header").first()).toBeHidden();
  await expect(page.getByTestId("business-document-toolbar")).toBeHidden();
  await expect(page.getByTestId("ai-assistant-root")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await expect(page.getByTestId("business-document-toolbar")).toBeVisible();

  // The document language changes the labels, never the PO number, a SKU, a
  // number, a date or the currency.
  await page.getByTestId("business-document-language").selectOption("zh-CN");
  await expect(page.getByTestId("po-document-title")).toHaveText("采购订单");
  await expect(page.getByTestId("po-document-totals")).toContainText("合计（USD）");
  expect(await figures(page)).toEqual(english);
  await expect(page.getByTestId("po-document-ship-to")).toContainText(SHIP_TO.name);
  // The interface stays in English.
  await expect(page.getByTestId("business-document-print")).toHaveText("Print or save as PDF");
});

test("a PO pending approval cannot be printed and says why", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-024/document");
  await expect(page.getByTestId("business-document-blocked")).toHaveText("Only approved purchase orders can be printed for sending.");
  await expect(page.getByTestId("business-document-print")).toBeDisabled();
  // Printed anyway from the browser, only the notice prints.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("business-document-sheet")).toBeHidden();
  await expect(page.getByTestId("business-document-blocked")).toBeVisible();
});

test("a PO that does not exist shows the page's own notice inside the app", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/orders/NO-SUCH-PO/document");
  await expect(page.getByTestId("app-main")).toBeVisible();
  await expect(page.getByTestId("po-document-unavailable")).toHaveText("This purchase order was not found in this workspace.");
  await expect(page.getByTestId("not-found-recovery")).toHaveCount(0);
});
