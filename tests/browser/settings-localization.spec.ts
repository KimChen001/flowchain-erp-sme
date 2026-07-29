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
