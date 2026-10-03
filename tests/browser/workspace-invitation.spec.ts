import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

// An administrator invites a teammate from Settings > Roles, the teammate
// accepts the link and signs in through the emailed sign-in link with the
// invited role, and the administrator then disables them. Runs against the
// local-development walkthrough server, whose mail goes to the local outbox
// (FLOWCHAIN_MAIL_OUTBOX_PATH, set by scripts/run-product-recovery-playwright.mjs).
const outboxPath = process.env.FLOWCHAIN_MAIL_OUTBOX_PATH || "";

async function signInLinkFor(address: string) {
  try {
    const messages: Array<{ to: string; text: string; tag: string }> = JSON.parse(await readFile(outboxPath, "utf8")).messages || [];
    return messages.filter((message) => message.to === address && message.tag === "sign-in-link").map((message) => message.text.match(/https?:\/\/\S+\/sign-in\/confirm\?token=[A-Za-z0-9_-]+/)?.[0] || "").at(-1) || "";
  } catch {
    return "";
  }
}

test("an invited teammate joins with the invited role and can be disabled", async ({ page, browser, request }) => {
  expect(outboxPath, "the runner must set FLOWCHAIN_MAIL_OUTBOX_PATH").not.toBe("");
  const login = await request.post("/api/auth/login", { data: { email: "admin@flowchain.local", name: "Admin", company: "Ignored" } });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  const invitee = `invitee-${Date.now()}@example.com`;

  await page.goto("/app/settings/roles");
  const members = page.getByTestId("workspace-members");
  await expect(members).toBeVisible();
  await page.getByTestId("invite-email").fill(invitee);
  await page.getByTestId("invite-role").selectOption("buyer");
  await page.getByTestId("invite-submit").click();
  const link = (await page.getByTestId("invite-link").locator("code").innerText()).trim();
  expect(link).toMatch(/\/accept-invitation\?token=/);
  await expect(page.getByTestId(`invitation-${invitee}`)).toContainText(/Pending|待接受/);

  // The teammate opens the link in their own browser.
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(link);
  const form = guest.getByTestId("accept-invitation-form");
  await expect(form).toBeVisible();
  await expect(form).toContainText(invitee);
  await expect(form).toContainText(/Procurement Specialist|采购专员/);
  expect(new URL(guest.url()).search).toBe("");
  await guest.getByTestId("accept-invitation-name").fill("Ivy Invitee");
  await guest.getByTestId("accept-invitation-submit").click();
  await expect(guest.getByTestId("invitation-accepted")).toContainText(invitee);

  // The emailed sign-in link signs them in with the invited role.
  await expect.poll(() => signInLinkFor(invitee), { timeout: 10_000 }).not.toBe("");
  await guest.goto(await signInLinkFor(invitee));
  await guest.getByRole("button", { name: /Sign in to|登录/ }).click();
  await expect(guest).toHaveURL(/\/app\//);
  const token = await guest.evaluate(() => localStorage.getItem("flowchain:auth-token"));
  const authorization = await (await request.get("/api/authorization/context", { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(authorization.roles.map((role: { roleKey: string }) => role.roleKey)).toEqual(["procurement-specialist"]);
  // The used invitation link no longer works.
  const reused = await context.newPage();
  await reused.goto(link);
  await expect(reused.getByTestId("invitation-invalid")).toBeVisible();

  // The administrator sees the member and disables them; their session ends.
  await page.reload();
  const row = page.getByTestId(`member-${invitee}`);
  await expect(row).toContainText(/Active|已启用/);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId(`disable-${invitee}`).click();
  await expect(row).toContainText(/Disabled|已停用/);
  const after = await request.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  expect(after.status()).toBe(401);
  // The administrator is offered no Disable for their own account.
  await expect(page.getByTestId("disable-admin@flowchain.local")).toHaveCount(0);
  await context.close();
});
