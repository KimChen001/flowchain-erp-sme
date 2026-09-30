import { test, expect } from "@playwright/test";

test("login defaults to English and preserves an explicit Chinese selection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Login does not require a live database. Unauthenticated API requests fail
  // explicitly so this test exercises the real frontend fallback.
  await page.route("**/api/**", route => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Sign in required"}' }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("button", { name: "Email me a sign-in link", exact: true })).toBeVisible();
  await expect(page.getByText("Work email", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../english-login.png", fullPage: true });

  const selector = page.getByRole("combobox", { name: "Interface language / 界面语言" });
  await selector.selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("button", { name: "发送登录链接", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByText("工作邮箱", { exact: true })).toBeVisible();
  await selector.selectOption("en-US");
  await expect(page.getByRole("button", { name: "Email me a sign-in link", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
