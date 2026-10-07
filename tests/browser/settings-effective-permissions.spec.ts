import { expect, test } from "@playwright/test";

// What Settings lets a user change follows the roles assigned in Roles &
// permissions, not the legacy User.role. The two users are invited here, so
// the seeded users other specs sign in as keep their roles.
test.setTimeout(120_000);

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function login(request: any, email: string) {
  const response = await request.post("/api/auth/login", { data: { email, name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function session(page: any, value: any) {
  await page.addInitScript(({ token, user }: any) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, value);
}
async function forceLanguage(page: any, language: "en-US" | "zh-CN") {
  await page.unroute("**/api/me/localization");
  await page.route("**/api/me/localization", (route: any) => route.fulfill({ json: {
    effectiveLanguage: language, languagePreference: language, defaultLanguage: "en-US", locale: "en-US", timezone: "America/New_York",
  } }));
}
async function invite(request: any, admin: any, email: string, role: string) {
  const created = await request.post("/api/workspace/invitations", { ...auth(admin.token), data: { email, role } });
  expect(created.status()).toBe(201);
  const accepted = await request.post("/api/workspace/invitations/accept", { data: { token: (await created.json()).invitationToken, name: email.split("@")[0] } });
  expect(accepted.ok()).toBeTruthy();
}
async function saveCompany(page: any) {
  const saved = page.waitForResponse((response: any) => response.url().endsWith("/api/workspace") && response.request().method() === "PATCH");
  await page.getByTestId("settings-save").click();
  expect((await saved).status()).toBe(200);
}

// A legacy manager made Workspace Administrator, and a legacy admin reduced to
// Read-only Viewer, both through Roles & permissions, plus a legacy viewer who
// keeps Read-only Viewer and has no warehouse. Created once per worker.
let users: Promise<{ delegate: string; reduced: string; reader: string }> | null = null;
function setUpUsers(request: any) {
  users ||= (async () => {
    const stamp = Date.now();
    const delegate = `delegate-${stamp}@example.com`;
    const reduced = `reduced-admin-${stamp}@example.com`;
    const reader = `reader-${stamp}@example.com`;
    const admin = await login(request, "admin@example.com");
    await invite(request, admin, delegate, "manager");
    await invite(request, admin, reduced, "admin");
    await invite(request, admin, reader, "viewer");
    const model = await (await request.get("/api/authorization/roles", auth(admin.token))).json();
    const roleId = (roleKey: string) => model.roles.find((role: any) => role.roleKey === roleKey).id;
    const userId = (email: string) => model.users.find((user: any) => user.email === email).id;
    for (const [email, roleKey] of [[delegate, "workspace-administrator"], [reduced, "read-only-viewer"]]) {
      const assigned = await request.put(`/api/authorization/users/${userId(email)}/roles`, { ...auth(admin.token), data: { roleIds: [roleId(roleKey)] } });
      expect(assigned.ok()).toBeTruthy();
    }
    return { delegate, reduced, reader };
  })();
  return users;
}

test("a legacy manager made Workspace Administrator in Roles can edit company settings", async ({ page, request }) => {
  const { delegate } = await setUpUsers(request);
  const value = await login(request, delegate);
  expect(value.user.role).toBe("manager");
  await session(page, value);
  await forceLanguage(page, "en-US");

  await page.goto("/app/settings/profile");
  await expect(page.getByTestId("profile-roles")).toHaveValue("Workspace Administrator");

  await page.goto("/app/settings/company");
  const companyName = page.getByLabel("Company name", { exact: true });
  await expect(companyName).toBeEnabled();
  await expect(page.getByTestId("workspace-read-only")).toHaveCount(0);
  const original = await companyName.inputValue();
  await companyName.fill(`${original} Group`);
  await saveCompany(page);
  expect((await (await request.get("/api/workspace", auth(value.token))).json()).companyName).toBe(`${original} Group`);
  // Put the seeded company name back for the specs that run after this one.
  await companyName.fill(original);
  await saveCompany(page);
  expect((await (await request.get("/api/workspace", auth(value.token))).json()).companyName).toBe(original);

  // Granting warehouse access lists every warehouse, though this user has no
  // warehouse scope of their own.
  await page.goto("/app/settings/warehouse-access");
  await expect(page.getByTestId("warehouse-access-user")).toBeVisible();
  await expect(page.getByTestId("warehouse-access-save")).toBeVisible();
  await expect(page.getByLabel("MAIN Warehouse scope", { exact: true })).toBeEnabled();

  await page.goto("/app/settings/readiness");
  await expect(page.getByTestId("admin-diagnostics")).toBeVisible();
});

test("a legacy admin reduced to Read-only Viewer cannot edit company settings", async ({ page, request }) => {
  const { reduced } = await setUpUsers(request);
  const value = await login(request, reduced);
  expect(value.user.role).toBe("admin");
  await session(page, value);
  await forceLanguage(page, "en-US");

  await page.goto("/app/settings/profile");
  await expect(page.getByTestId("profile-roles")).toHaveValue("Read-only Viewer");

  await page.goto("/app/settings/company");
  await expect(page.getByLabel("Company name", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Timezone", { exact: true })).toBeDisabled();
  await expect(page.getByTestId("settings-save")).toHaveCount(0);
  await expect(page.getByTestId("workspace-read-only")).toHaveText("Your roles do not include Manage workspace settings, so these settings are view only.");
  // The server refuses it as well.
  const workspace = await (await request.get("/api/workspace", auth(value.token))).json();
  const refused = await request.patch("/api/workspace", { ...auth(value.token), data: { ...workspace, companyName: "Forged" } });
  expect(refused.status()).toBe(403);

  // Read-only Viewer may read members' warehouse access but not change it. A
  // legacy admin's access is shown as their actual scope.
  const admin = await login(request, "admin@example.com");
  const adminId = (await (await request.get("/api/authorization/roles", auth(admin.token))).json()).users.find((user: any) => user.email === "admin@example.com").id;
  await page.goto("/app/settings/warehouse-access");
  await page.getByTestId("warehouse-access-user").selectOption(adminId);
  await expect(page.getByTestId("warehouse-access")).toContainText("Operate");
  await expect(page.getByTestId("warehouse-access")).not.toContainText("All warehouses");
  await expect(page.getByTestId("warehouse-access-save")).toHaveCount(0);
  await expect(page.getByLabel("MAIN Warehouse scope", { exact: true })).toHaveCount(0);

  // Without settings.diagnostics.read the readiness page is not offered at all.
  await page.goto("/app/settings/readiness");
  await expect(page.getByTestId("authorization-route-denied")).toBeVisible();
  await expect(page.getByTestId("admin-diagnostics")).toHaveCount(0);

  // The same view in Chinese.
  await forceLanguage(page, "zh-CN");
  await page.goto("/app/settings/company");
  await expect(page.getByTestId("workspace-read-only")).toHaveText("你的角色不含“管理工作区设置”权限，这些设置只能查看。");
  await page.goto("/app/settings/profile");
  await expect(page.getByTestId("profile-roles")).toHaveValue("只读查看者");
});

test("a member who may only read warehouse access sees a teammate's access on every warehouse", async ({ page, request }) => {
  const { reader } = await setUpUsers(request);
  const value = await login(request, reader);
  expect(value.user.role).toBe("viewer");
  await session(page, value);
  await forceLanguage(page, "en-US");
  const members = (await (await request.get("/api/workspace/users", auth(value.token))).json()).users;
  const memberId = (email: string) => members.find((user: any) => user.email === email).id;

  // Read-only Viewer may read members' access but has no warehouse of its
  // own. The page opens on the reader's own access, which is none.
  await page.goto("/app/settings/warehouse-access");
  await expect(page.getByTestId("warehouse-access-user")).toHaveValue(memberId(reader));
  const mainRow = page.getByTestId("warehouse-access").getByRole("row", { name: /MAIN · Main Warehouse/ });
  await expect(mainRow).toContainText("No access");
  // A teammate's access is listed on warehouses outside the reader's scope.
  await page.getByTestId("warehouse-access-user").selectOption(memberId("admin@example.com"));
  await expect(mainRow).toContainText("Operate");
  await expect(page.getByTestId("warehouse-access-save")).toHaveCount(0);
  await expect(page.getByLabel("MAIN Warehouse scope", { exact: true })).toHaveCount(0);
});

// Warehouses and bins are kept in Settings > Warehouse access by whoever may
// manage the workspace. The warehouse added here is left inactive, so it is
// not offered to the specs that run after this one.
test("a workspace administrator adds a warehouse and a bin and sets both inactive", async ({ page, request }) => {
  const admin = await login(request, "admin@example.com");
  await session(page, admin);
  await forceLanguage(page, "en-US");
  const code = `PW-${Date.now().toString(36).toUpperCase()}`;

  await page.goto("/app/settings/warehouse-access");
  await page.getByTestId("warehouse-new").click();
  await page.getByTestId("warehouse-field-code").fill(code.toLowerCase());
  await page.getByTestId("warehouse-field-name").fill("Playwright Depot");
  await page.getByTestId("warehouse-save").click();
  await expect(page.getByTestId("warehouse-notice")).toContainText(`${code} added`);
  await expect(page.getByTestId(`warehouse-status-${code}`)).toHaveText("Active");
  // The creator has operate access to it, so it is listed with its access.
  await expect(page.getByTestId("warehouse-access")).toContainText(`${code} · Playwright Depot`);

  await page.getByTestId(`warehouse-bins-${code}`).click();
  await page.getByTestId(`bin-field-code-${code}`).fill("A-01");
  await page.getByTestId(`bin-new-${code}`).click();
  await expect(page.getByTestId(`bin-status-${code}-A-01`)).toHaveText("Active");
  await page.getByTestId(`bin-toggle-${code}-A-01`).click();
  await expect(page.getByTestId(`bin-status-${code}-A-01`)).toHaveText("Inactive");

  page.once("dialog", (dialog: any) => dialog.accept());
  await page.getByTestId(`warehouse-toggle-${code}`).click();
  await expect(page.getByTestId(`warehouse-status-${code}`)).toHaveText("Inactive");
  const listed = await (await request.get("/api/master-data/warehouses", auth(admin.token))).json();
  expect(listed.warehouses.find((row: any) => row.code === code).status).toBe("inactive");
  const options = (await (await request.get("/api/master-data/warehouses/select", auth(admin.token))).json()).options;
  expect(options.some((row: any) => row.code === code)).toBe(false);

  // The same section in Chinese.
  await forceLanguage(page, "zh-CN");
  await page.goto("/app/settings/warehouse-access");
  await expect(page.getByTestId(`warehouse-status-${code}`)).toHaveText("停用");
  await expect(page.getByTestId(`warehouse-toggle-${code}`)).toHaveText("设为启用");
});

test("a member without Manage workspace settings sees no warehouse controls", async ({ page, request }) => {
  const { reader } = await setUpUsers(request);
  const value = await login(request, reader);
  await session(page, value);
  await forceLanguage(page, "en-US");

  await page.goto("/app/settings/warehouse-access");
  await expect(page.getByTestId("warehouse-access-user")).toBeVisible();
  await expect(page.getByTestId("warehouse-master")).toHaveCount(0);
  await expect(page.getByTestId("warehouse-new")).toHaveCount(0);
  // The server refuses it as well.
  const refused = await request.post("/api/master-data/warehouses", { ...auth(value.token), data: { code: "FORGED", name: "Forged" } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).permission).toBe("settings.workspace.manage");
});
