import { test, expect } from "@playwright/test";

// A US user places an order for a customer from Customers, not a typed name:
// the customer's payment terms show, the order takes several lines and a
// promised date, and editing the draft keeps every line.
test("a sales order is placed for a customer from Customers, with two lines, and edited as a whole", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { company: "Browser Company", email: "kim@example.com", name: "Kim" },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  await page.route("**/api/me/localization", (route) =>
    route.fulfill({
      json: { languagePreference: "en-US", defaultLanguage: "en-US", effectiveLanguage: "en-US", locale: "en-US", timezone: "America/New_York" },
    }),
  );

  await page.goto("/app/sales/orders/new");
  const create = page.getByTestId("create-sales-order");
  await expect(page.getByTestId("sales-order-entry")).toBeVisible();
  // No order number to type: the server assigns SO-YYYYMM-NNNN on save.
  await expect(page.getByTestId("sales-order-number-on-save")).toHaveText("Order number: assigned when you save");
  // No free-text customer: the customer is chosen from Customers.
  await expect(page.getByLabel("Customer", { exact: true }).locator("option")).toHaveText([
    "Choose a customer",
    "Cancelling Customer · CUST-CANCEL",
    "Playwright Customer · CUST-PW",
  ]);
  // Save stays clickable: a missing field is named under it, and focus goes there.
  await expect(page.getByTestId("form-required-note")).toHaveText("* Required");
  await expect(page.getByLabel("Customer", { exact: true })).toHaveAttribute("aria-required", "true");
  await create.click();
  await expect(page.getByLabel("Customer", { exact: true })).toHaveAccessibleDescription("Choose a customer.");
  await expect(page.getByLabel("Customer", { exact: true })).toBeFocused();
  await expect(page.getByTestId("sales-order-entry-errors")).toHaveText("Check the highlighted fields.");
  await page.getByLabel("Customer", { exact: true }).selectOption({ label: "Playwright Customer · CUST-PW" });
  await expect(page.getByLabel("Customer", { exact: true })).toHaveAccessibleDescription("");
  await expect(page.getByTestId("sales-order-customer-terms")).toHaveText("Payment terms: Net 30");
  await expect(page.getByLabel("Currency")).toHaveValue("USD");
  await page.getByLabel("Promised date").fill("2026-10-20");

  await page.getByLabel("Item, line 1").selectOption({ index: 1 });
  await page.getByLabel("Quantity, line 1").fill("3");
  await page.getByLabel("Unit price, line 1").fill("12.50");
  await page.getByTestId("sales-order-add-line").click();
  await page.getByLabel("Item, line 2").selectOption({ index: 1 });
  await page.getByLabel("Quantity, line 2").fill("1");
  // A line without a price could never be invoiced, so the save stops there.
  await create.click();
  await expect(page.getByLabel("Unit price, line 2")).toHaveAccessibleDescription("Enter a unit price. Use 0 for free goods.");
  await expect(page.getByLabel("Unit price, line 2")).toBeFocused();
  await expect(page).toHaveURL(/\/app\/sales\/orders\/new$/);
  await page.getByLabel("Unit price, line 2").fill("0");
  await create.click();

  await expect(page.getByTestId("outbound-order-workbench")).toBeVisible();
  await expect(page.getByTestId("outbound-order-workbench").getByRole("heading", { level: 1 })).toHaveText(/^SO-\d{6}-\d{4,}$/);
  await expect(page.getByText("Playwright Customer").first()).toBeVisible();
  await expect(page.getByTestId("sales-order-line-price")).toHaveCount(2);

  // Editing the draft shows the chosen customer, the promised date and both
  // lines, and saving keeps both.
  await page.getByTestId("open-edit").click();
  const form = page.getByTestId("sales-order-edit-form");
  await expect(form.getByLabel("Edit customer").locator("option:checked")).toHaveText("Playwright Customer · CUST-PW");
  await expect(form.getByLabel("Edit promised date")).toHaveValue("2026-10-20");
  await expect(form.getByLabel("Quantity, line 1")).toHaveValue("3.0000");
  await expect(form.getByLabel("Quantity, line 2")).toHaveValue("1.0000");
  await form.getByLabel("Quantity, line 2").fill("2");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("sales-order-line-price")).toHaveCount(2);
  await page.getByTestId("open-edit").click();
  await expect(page.getByTestId("sales-order-edit-form").getByLabel("Quantity, line 2")).toHaveValue("2.0000");
  await expect(page.getByTestId("sales-order-edit-form").getByLabel("Quantity, line 1")).toHaveValue("3.0000");
});
