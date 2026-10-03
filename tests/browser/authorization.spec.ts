import { expect, test } from "@playwright/test";

test.setTimeout(120_000);
const login = async (request: any, email: string) => { const response = await request.post("/api/auth/login", { data: { email, name: "Authorization User", company: "FlowChain Operations" } }); expect(response.ok()).toBeTruthy(); return response.json(); };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const session = async (page: any, value: any) => page.addInitScript(({ token, user }) => { localStorage.setItem("flowchain:auth-token", token); localStorage.setItem("flowchain:current-user", JSON.stringify(user)); }, value);

test("admin creates a custom multi-role return operator and grants take effect immediately", async ({ page, request }) => {
  const admin = await login(request, "admin@example.com");
  await session(page, admin);
  await page.goto("/app/settings/roles");
  await expect(page.getByTestId("authorization-workbench")).toBeVisible();
  page.once("dialog", dialog => dialog.accept("Return Operator"));
  await page.getByTestId("create-role").click();
  await expect(page.getByText("Return Operator", { exact: true }).first()).toBeVisible();
  await page.getByText("Return Operator", { exact: true }).first().click();
  for (const code of ["returns.posting.read", "returns.posting.prepare", "returns.posting.post"]) {
    await page.getByText(code, { exact: true }).locator("xpath=ancestor::label").locator('input[type="checkbox"]').check();
  }
  await page.getByTestId("save-role").click();
  await expect(page.getByRole("status")).toContainText("立即生效");
  const rolesResponse = await request.get("/api/authorization/roles", { headers: auth(admin.token) });
  const model = await rolesResponse.json();
  const role = model.roles.find((item: any) => item.name === "Return Operator");
  const viewer = model.users.find((item: any) => item.email === "viewer@example.com");
  const assign = await request.put(`/api/authorization/users/${viewer.id}/roles`, { headers: auth(admin.token), data: { roleIds: [...viewer.roleIds, role.id] } });
  expect(assign.ok()).toBeTruthy();
  const viewerSession = await login(request, "viewer@example.com");
  let contextResponse = await request.get("/api/authorization/context", { headers: auth(viewerSession.token) });
  let context = await contextResponse.json();
  expect(context.effectivePermissions).toContain("returns.posting.post");
  expect(context.effectivePermissions).not.toContain("returns.posting.reverse");
  expect(context.fieldVisibility.finance_amounts.visible).toBeFalsy();
  const deniedWrite = await request.patch(`/api/authorization/roles/${role.id}`, { headers: auth(viewerSession.token), data: { name: "Forged" } });
  expect(deniedWrite.status()).toBe(403);
  const addReverse = await request.patch(`/api/authorization/roles/${role.id}`, { headers: auth(admin.token), data: { permissionCodes: [...role.permissionCodes, "returns.posting.reverse"] } });
  expect(addReverse.ok()).toBeTruthy();
  contextResponse = await request.get("/api/authorization/context", { headers: auth(viewerSession.token) }); context = await contextResponse.json();
  expect(context.effectivePermissions).toContain("returns.posting.reverse");
  const removeReverse = await request.patch(`/api/authorization/roles/${role.id}`, { headers: auth(admin.token), data: { permissionCodes: role.permissionCodes } });
  expect(removeReverse.ok()).toBeTruthy();
  contextResponse = await request.get("/api/authorization/context", { headers: auth(viewerSession.token) }); context = await contextResponse.json();
  expect(context.effectivePermissions).not.toContain("returns.posting.reverse");
  await page.reload();
  await expect(page.getByText("Return Operator", { exact: true }).first()).toBeVisible();
});

test("last role administrator is protected and capability denial is distinct", async ({ page, request }) => {
  const admin = await login(request, "admin@example.com");
  const roles = await (await request.get("/api/authorization/roles", { headers: auth(admin.token) })).json();
  const current = roles.users.find((item: any) => item.email === "admin@example.com");
  const blocked = await request.put(`/api/authorization/users/${current.id}/roles`, { headers: auth(admin.token), data: { roleIds: [] } });
  expect(blocked.status()).toBe(409);
  await session(page, admin); await page.goto("/app/inventory/returns");
  await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  await expect(page.getByTestId("authorization-route-denied")).toHaveCount(0);
});

test("admin grants a master data code from the permission matrix and it decides the write", async ({ page, request }) => {
  const admin = await login(request, "admin@example.com");
  await session(page, admin);
  await page.goto("/app/settings/roles");
  await expect(page.getByTestId("authorization-workbench")).toBeVisible();
  page.once("dialog", dialog => dialog.accept("Supplier Steward"));
  await page.getByTestId("create-role").click();
  await page.getByText("Supplier Steward", { exact: true }).first().click();
  // The master data codes have their own group in the matrix.
  const group = page.locator("section").filter({ has: page.getByRole("heading", { name: /^(Master data|基础资料)$/ }) });
  await expect(group.getByText("master_data.item.manage", { exact: true })).toBeVisible();
  await expect(group.getByText("master_data.customer.manage", { exact: true })).toBeVisible();
  await group.getByText("master_data.supplier.manage", { exact: true }).locator("xpath=ancestor::label").locator('input[type="checkbox"]').check();
  await page.getByTestId("save-role").click();
  await expect(page.getByRole("status")).toContainText(/立即生效|effective immediately/);
  const model = await (await request.get("/api/authorization/roles", { headers: auth(admin.token) })).json();
  const role = model.roles.find((item: any) => item.name === "Supplier Steward");
  expect(role.permissionCodes).toEqual(["master_data.supplier.manage"]);

  const supplier = (name: string) => ({ supplierCode: `STEWARD-${Date.now()}`, supplierName: name, defaultCurrency: "USD" });
  const before = await login(request, "viewer@example.com");
  expect((await request.post("/api/master-data/suppliers", { headers: auth(before.token), data: supplier("Denied") })).status()).toBe(403);
  const viewer = model.users.find((item: any) => item.email === "viewer@example.com");
  const assign = await request.put(`/api/authorization/users/${viewer.id}/roles`, { headers: auth(admin.token), data: { roleIds: [...viewer.roleIds, role.id] } });
  expect(assign.ok()).toBeTruthy();
  // The role change ended the viewer's sessions.
  const after = await login(request, "viewer@example.com");
  expect((await request.post("/api/master-data/suppliers", { headers: auth(after.token), data: supplier("Steward Supplier") })).status()).toBe(201);
  expect((await request.post("/api/master-data/customers", { headers: auth(after.token), data: { code: `STEWARD-${Date.now()}`, name: "Denied" } })).status()).toBe(403);
});
