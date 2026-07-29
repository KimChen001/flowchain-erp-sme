import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

test("Structured Intake wizard profiles, maps, validates, and reviews parser-owned rows", async ({ page, request }) => {
  const response = await request.post("/api/auth/login", {
    data: { email: "admin@example.com", name: "Ignored", company: "Ignored" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
    localStorage.setItem("flowchain:experimental-modules", JSON.stringify(["universal-intake"]));
  }, session);

  await page.goto("/app/imports");
  await expect(page).toHaveURL(/\/app\/universal-intake$/);
  await expect(page.getByRole("heading", { name: "Structured Smart Intake" })).toBeVisible();
  await expect(page.getByText("No Supplier, Item, or Customer will be created.")).toBeVisible();
  await page.getByRole("button", { name: "Paste Table" }).click();
  await page.getByTestId("intake-paste").fill("code\tname\nSUP-BROWSER-1\tSuzhou Components");
  await page.getByTestId("intake-profile-source").click();
  await expect(page.getByTestId("intake-profile")).toContainText("paste_table");
  await expect(page.getByTestId("intake-profile")).toContainText("SUP-BROWSER-1");
  await page.getByRole("button", { name: "Continue to mapping" }).click();
  await expect(page.getByTestId("intake-mapping")).toContainText("Supplier Code");
  await expect(page.getByTestId("intake-mapping")).toContainText("normalized_name · strong");
  await page.getByRole("button", { name: "Confirm, normalize and validate" }).click();
  await expect(page.getByTestId("intake-validation")).toContainText("Validation result");
  await page.getByRole("button", { name: "Review normalized records" }).click();
  await expect(page.getByTestId("intake-review")).toContainText("SUP-BROWSER-1");
  await expect(page.getByRole("button", { name: "Business commit unavailable in Phase 5.4B" })).toBeDisabled();
  await expect(page.getByText(/成功导入 500 条供应商/)).toHaveCount(0);
});

test("Custom Field Settings creates and publishes a stable boolean field", async ({ page, request }) => {
  const response = await request.post("/api/auth/login", { data: { email: "admin@example.com", name: "Ignored", company: "Ignored" } });
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
    localStorage.setItem("flowchain:experimental-modules", JSON.stringify(["universal-intake"]));
  }, session);
  await page.goto("/app/settings/custom-fields");
  await expect(page.getByTestId("custom-fields-settings")).toBeVisible();
  await page.getByPlaceholder("strategic_grade").fill("is_related_party");
  await page.getByPlaceholder("Strategic Grade").fill("Related Party");
  await page.getByLabel("Type").selectOption("boolean");
  await page.getByTestId("custom-field-create").click();
  await expect(page.getByText("supplier.custom.is_related_party")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/boolean · revision 1 · published/)).toBeVisible();
});
