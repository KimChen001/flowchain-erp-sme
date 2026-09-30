import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Runs against the local-development walkthrough server
// (scripts/run-product-recovery-playwright.mjs), whose mail provider is the
// local outbox. The runner passes the outbox file in FLOWCHAIN_MAIL_OUTBOX_PATH.
const outboxPath = process.env.FLOWCHAIN_MAIL_OUTBOX_PATH || "";
const email = "kim@example.com";

type OutboxMessage = { to: string; subject: string; text: string; tag: string };

async function outbox(): Promise<OutboxMessage[]> {
  try {
    return JSON.parse(await readFile(outboxPath, "utf8")).messages || [];
  } catch {
    return [];
  }
}

async function linksTo(address: string) {
  return (await outbox())
    .filter((message) => message.to === address && message.tag === "sign-in-link")
    .map((message) => message.text.match(/https?:\/\/\S+\/sign-in\/confirm\?token=[A-Za-z0-9_-]+/)?.[0] || "");
}

async function waitForLinkCount(address: string, count: number) {
  await expect.poll(async () => (await linksTo(address)).length, { timeout: 10_000 }).toBe(count);
  return (await linksTo(address)).at(-1)!;
}

async function requestFromLoginPage(page: Page, address: string) {
  await page.getByLabel("Work email").fill(address);
  await page.getByRole("button", { name: "Email me a sign-in link", exact: true }).click();
  await expect(page.getByTestId("sign-in-check-email")).toBeVisible();
}

test("a person signs in through the emailed link, and the link works only once", async ({ page, browser, request }) => {
  expect(outboxPath, "the runner must set FLOWCHAIN_MAIL_OUTBOX_PATH").not.toBe("");
  const localStatus = await (await request.get("/api/dev/local-status")).json();
  const before = (await linksTo(email)).length;

  await page.clock.install();
  await page.goto("/");
  await expect(page.getByTestId("sign-in-email-form")).toBeVisible();
  await expect(page.getByText("Company name")).toHaveCount(0);

  // The answer is the same for an address that cannot sign in.
  await requestFromLoginPage(page, "nobody@example.com");
  const unknownMessage = await page.getByTestId("sign-in-check-email").locator("p").first().innerText();
  await page.getByRole("button", { name: "Use a different email" }).click();
  await requestFromLoginPage(page, email);
  const knownMessage = await page.getByTestId("sign-in-check-email").locator("p").first().innerText();
  expect(knownMessage.replace(email, "<email>")).toBe(unknownMessage.replace("nobody@example.com", "<email>"));
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const link = await waitForLinkCount(email, before + 1);
  expect(await linksTo("nobody@example.com")).toEqual([]);

  // Resend unlocks after 60 seconds.
  const resend = page.getByTestId("sign-in-resend");
  await expect(resend).toBeDisabled();
  await expect(resend).toContainText("Resend available in");
  await page.clock.fastForward(61_000);
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveText("Resend the link");

  // Local development shows the link from the outbox.
  await page.getByRole("button", { name: "View the sign-in link" }).click();
  await expect(page.getByRole("link", { name: "Open the sign-in link" })).toHaveAttribute("href", link);

  // A mail scanner fetching the link in advance does not use it.
  const prefetch = await request.get(link);
  expect(prefetch.ok()).toBeTruthy();

  const confirmPage = await browser.newPage();
  const response = await confirmPage.goto(link);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  const button = confirmPage.getByRole("button", { name: `Sign in to ${localStatus.workspaceName}` });
  await expect(button).toBeVisible();
  // The token leaves the address bar, and nothing is signed in until the click.
  expect(new URL(confirmPage.url()).search).toBe("");
  expect(new URL(confirmPage.url()).pathname).toBe("/sign-in/confirm");
  expect(await confirmPage.evaluate(() => localStorage.getItem("flowchain:auth-token"))).toBeNull();

  await button.click();
  // The app opens its home route (the overview, or its default view).
  await expect(confirmPage).toHaveURL(/\/app\/overview(\/[a-z-]+)?$/);
  const stored = await confirmPage.evaluate(() => ({ token: localStorage.getItem("flowchain:auth-token"), user: JSON.parse(localStorage.getItem("flowchain:current-user") || "null") }));
  expect(stored.user.email).toBe(email);
  const me = await request.get("/api/auth/me", { headers: { Authorization: `Bearer ${stored.token}` } });
  expect(me.ok()).toBeTruthy();
  expect((await me.json()).email).toBe(email);
  await expect(confirmPage.getByTestId("sign-in-email-form")).toHaveCount(0);

  // A second use of the same link fails with the generic message.
  const again = await browser.newPage();
  await again.goto(link);
  await expect(again.getByTestId("sign-in-confirm-invalid")).toBeVisible();
  await expect(again.getByText("This sign-in link is invalid or has expired")).toBeVisible();
  expect(await again.evaluate(() => localStorage.getItem("flowchain:auth-token"))).toBeNull();
  const token = new URL(link).searchParams.get("token");
  const replay = await request.post("/api/auth/email-link/confirm", { data: { token } });
  expect(replay.status()).toBe(400);
  expect((await replay.json()).code).toBe("SIGN_IN_LINK_INVALID");

  // Signing out ends the server session.
  const logout = await request.post("/api/auth/logout", { headers: { Authorization: `Bearer ${stored.token}` } });
  expect(logout.ok()).toBeTruthy();
  expect((await request.get("/api/auth/me", { headers: { Authorization: `Bearer ${stored.token}` } })).status()).toBe(401);

  await confirmPage.close();
  await again.close();
});

test("the sign-in pages have Chinese copy", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("flowchain:guest-language", "zh-CN"));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "发送登录链接", exact: true })).toBeVisible();
  await page.getByLabel("工作邮箱").fill("nobody@example.com");
  await page.getByRole("button", { name: "发送登录链接", exact: true }).click();
  await expect(page.getByRole("heading", { name: "请查看你的邮箱" })).toBeVisible();
  await page.goto("/sign-in/confirm?token=not-a-real-token");
  await expect(page.getByText("登录链接无效或已过期")).toBeVisible();
  await expect(page.getByRole("link", { name: "返回登录" })).toBeVisible();
});
