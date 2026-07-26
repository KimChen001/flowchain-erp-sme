import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

test("Universal Intake preview reads empty PostgreSQL state and states every disabled boundary", async ({ page, request }) => {
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

  await page.goto("/app/universal-intake");
  await expect(page.getByRole("heading", { name: "Universal Intake Foundation" })).toBeVisible();
  await expect(page.getByText("0 个来源对象")).toBeVisible();
  await expect(page.getByText("0 个 PostgreSQL batch")).toBeVisible();
  for (const limitation of [
    "CSV/XLSX parsing: not yet enabled",
    "Business commit adapters: not yet enabled",
    "Email intake: not yet enabled",
    "PDF/OCR: not yet enabled",
  ]) await expect(page.getByText(limitation, { exact: true })).toBeVisible();
  await expect(page.getByText(/成功导入 500 条供应商/)).toHaveCount(0);
});
