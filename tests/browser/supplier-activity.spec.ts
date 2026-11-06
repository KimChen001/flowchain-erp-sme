import { expect, test, type Page } from "@playwright/test";

// The supplier detail page's Purchase records and Risks and exceptions
// (docs/supplier-tiers-design.md §5, T3) on the walkthrough scenario, seeded
// for today by the product recovery API. Acme Components has two overdue
// orders (PO-001 and PO-015) and an invoice with a price variance (INV-001).
const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN" = "en-US") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Supplier activity", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

test("a supplier's purchase records and risks list its own records, linked, in English", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/master-data/suppliers/LOCAL-DEMO-SUP-001");
  const records = page.getByTestId("supplier-purchase-records");
  await expect(records.getByRole("heading", { name: "Purchase records" })).toBeVisible();
  const overdue = records.getByTestId("supplier-purchase-record").filter({ hasText: "PO-001" });
  await expect(overdue).toContainText("days overdue");
  const invoice = records.getByTestId("supplier-invoice-record").filter({ hasText: "INV-001" });
  await expect(invoice).toContainText("Exception");
  await expect(invoice).toContainText("Variance");
  await expect(invoice).not.toContainText("—");

  const risks = page.getByTestId("supplier-risks");
  await expect(risks.getByRole("heading", { name: "Risks and exceptions" })).toBeVisible();
  const items = risks.getByTestId("supplier-risk");
  await expect(items.first()).toContainText("days overdue");
  await expect(risks).toContainText("Invoice variance");
  await expect(risks).toContainText("Most overdue first");
  // The longest overdue order comes first, as in the assistant.
  const first = await items.first().innerText();
  expect(first).toMatch(/PO-001/);

  for (const card of [records, risks]) {
    const text = await card.innerText();
    expect(text.split(/\n+/).filter((line) => CJK.test(line))).toEqual([]);
  }

  // A record opens its own page.
  await overdue.getByRole("link", { name: /PO-001/ }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/orders\/LOCAL-DEMO-PO-001/);
});

test("the same cards in Chinese", async ({ page }) => {
  await signIn(page, "zh-CN");
  await page.goto("/app/master-data/suppliers/LOCAL-DEMO-SUP-001");
  const records = page.getByTestId("supplier-purchase-records");
  await expect(records.getByRole("heading", { name: "采购记录" })).toBeVisible();
  await expect(records.getByTestId("supplier-purchase-record").filter({ hasText: "PO-001" })).toContainText("逾期");
  const risks = page.getByTestId("supplier-risks");
  await expect(risks.getByRole("heading", { name: "风险与异常" })).toBeVisible();
  await expect(risks).toContainText("采购订单逾期");
  await expect(risks).toContainText("发票差异");
  await expect(records.getByTestId("supplier-invoice-record").filter({ hasText: "INV-001" })).toContainText("异常");
});
