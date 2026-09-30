import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function login(request: any) {
  const response = await request.post("/api/auth/login", { data: { email: "admin@example.com", name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function session(page: any, value: any) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, value);
}
const zhNavigation = ["我的资料", "公司与工作区", "用户与角色", "仓库与权限", "系统就绪状态", "编号规则", "复核策略", "菜单与模块", "AI 治理", "操作日志"];
const enNavigation = ["My Profile", "Company & Workspace", "Users & Roles", "Warehouse Access", "System Readiness", "Numbering Rules", "Review Policies", "Menu & Modules", "AI Governance", "Audit Log"];

async function expectNavigation(page: any, labels: string[], rejected: string[]) {
  const nav = page.getByTestId("module-subnav");
  await expect(nav).toBeVisible();
  for (const label of labels) await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
  for (const label of [...rejected, "高级设置", "Advanced Settings"]) {
    await expect(nav.getByText(label, { exact: true })).toHaveCount(0);
  }
}

test("workspace language, locale, timezone, persistence, and disabled capability remain independent", async ({ page, request }) => {
  await session(page, await login(request));
  await page.goto("/app/settings/profile");
  await expectNavigation(page, zhNavigation, ["My Profile", "Workspace", "Pilot Users", "Warehouse Access", "Pilot Setup Status"]);

  await page.getByLabel("界面语言", { exact: true }).selectOption("en-US");
  await page.getByTestId("settings-save").click();
  await expect(page.getByRole("heading", { name: "My Profile", exact: true })).toBeVisible();
  await expectNavigation(page, enNavigation, ["我的资料", "公司与工作区", "用户与角色", "仓库与权限", "系统就绪状态"]);
  await page.reload();
  await expectNavigation(page, enNavigation, ["我的资料", "公司与工作区"]);
  await expect(page.getByLabel("Interface language", { exact: true })).toHaveValue("en-US");

  await page.getByRole("link", { name: "Company & Workspace" }).click();
  const beforePreview = await page.getByTestId("locale-format-preview").innerText();
  await page.getByLabel("Regional format", { exact: true }).selectOption("en-US");
  await page.getByLabel("Timezone", { exact: true }).selectOption("America/Los_Angeles");
  await page.getByLabel("Default interface language", { exact: true }).selectOption("zh-CN");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("locale-format-preview")).not.toHaveText(beforePreview);
  await expect(page.getByRole("heading", { name: "Company & Workspace", exact: true })).toBeVisible();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("America/Los_Angeles");
  await expect(page.getByLabel("Regional format", { exact: true })).toHaveValue("en-US");
  await page.reload();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("America/Los_Angeles");
  await expect(page.getByLabel("Regional format", { exact: true })).toHaveValue("en-US");
  await expectNavigation(page, enNavigation, ["公司与工作区"]);

  await page.getByRole("link", { name: "My Profile" }).click();
  await page.getByLabel("Interface language", { exact: true }).selectOption("");
  await page.getByTestId("settings-save").click();
  await expect(page.getByRole("heading", { name: "我的资料", exact: true })).toBeVisible();
  await expectNavigation(page, zhNavigation, ["My Profile", "Company & Workspace"]);

  await page.getByRole("link", { name: "公司与工作区" }).click();
  await page.getByLabel("默认界面语言", { exact: true }).selectOption("en-US");
  await page.getByTestId("settings-save").click();
  await expect(page.getByRole("heading", { name: "Company & Workspace", exact: true })).toBeVisible();
  await page.goto("/app/finance");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("Capability unavailable");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("Permission is present, but this capability is disabled.");
  await expect(page.getByTestId("capability-route-blocked")).not.toContainText("当前不可进入");
});

async function forceLanguage(page: any, language: "en-US" | "zh-CN") {
  await page.route("**/api/me/localization", (route: any) => route.fulfill({ json: {
    effectiveLanguage: language, languagePreference: language, defaultLanguage: "en-US", locale: "en-US", timezone: "America/New_York",
  } }));
}

test("only the invoice matching tolerances save; settings nothing reads are marked not in effect", async ({ page, request }) => {
  const value = await login(request);
  await session(page, value);
  await forceLanguage(page, "en-US");
  const auth = { headers: { authorization: `Bearer ${value.token}` } };
  const before = await (await request.get("/api/settings-runtime", auth)).json();

  // Advanced settings (session timeout, negative stock) sit on an internal page
  // outside normal navigation; they carry the same notice there.
  for (const path of ["/app/settings/numbering", "/app/settings/modules", "/app/settings/ai"]) {
    await page.goto(path);
    const notice = page.getByTestId("settings-not-in-effect");
    await expect(notice).toContainText("Not in effect yet");
    await expect(notice).toContainText("FlowChain does not use these settings yet");
    await expect(page.getByTestId("settings-save")).toHaveCount(0);
    await expect(notice.locator("input, select, textarea, button").first()).toBeDisabled();
  }

  await page.goto("/app/settings/review");
  const tolerances = page.getByTestId("settings-review-tolerances");
  await expect(tolerances).toContainText("Invoice matching tolerances");
  await expect(tolerances).toContainText("In effect");
  await expect(page.getByTestId("settings-not-in-effect")).toContainText("Not in effect yet");
  await expect(page.getByLabel("Amount review threshold", { exact: true })).toBeDisabled();

  const percentage = page.getByLabel("Unit price tolerance (%)", { exact: true });
  await expect(percentage).toBeEnabled();
  await percentage.fill("150");
  await expect(tolerances).toContainText("Enter a percentage from 0 to 100 with up to 4 decimal places.");
  await expect(page.getByTestId("settings-save")).toBeDisabled();
  await percentage.fill("2.5");
  await page.getByLabel("Line amount tolerance", { exact: true }).fill("10");
  await page.getByTestId("settings-save").click();
  await expect(page.getByRole("status")).toContainText("Saved at");
  await page.reload();
  await expect(page.getByLabel("Unit price tolerance (%)", { exact: true })).toHaveValue("2.5");
  await expect(page.getByLabel("Line amount tolerance", { exact: true })).toHaveValue("10");

  // The stored values three-way match reads changed; everything else is kept.
  const after = await (await request.get("/api/settings-runtime", auth)).json();
  expect(after.review.pricePercentageTolerance).toBe("2.5");
  expect(after.review.amountTolerance).toBe("10");
  expect(after.review.quantityTolerance).toBe(before.review.quantityTolerance);
  expect(after.review.amountThreshold).toBe(before.review.amountThreshold);
  expect(after.review.policies).toEqual(before.review.policies);
  expect(after.numbering).toEqual(before.numbering);

  const rejected = await request.patch("/api/settings-runtime/review", { ...auth, data: { settings: { ...after.review, quantityTolerance: "-1" } } });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).code).toBe("REVIEW_TOLERANCE_INVALID");
});

test("not-in-effect settings and matching tolerances are translated into Chinese", async ({ page, request }) => {
  await session(page, await login(request));
  await forceLanguage(page, "zh-CN");
  await page.goto("/app/settings/numbering");
  await expect(page.getByTestId("settings-not-in-effect")).toContainText("尚未生效");
  await page.goto("/app/settings/review");
  const tolerances = page.getByTestId("settings-review-tolerances");
  await expect(tolerances).toContainText("发票匹配容差");
  await expect(tolerances).toContainText("已生效");
  await expect(page.getByLabel("单价容差（%）", { exact: true })).toBeEnabled();
  await expect(page.getByTestId("settings-not-in-effect")).toContainText("尚未生效");
  await expect(page.locator("body")).not.toContainText("Not in effect yet");
});
