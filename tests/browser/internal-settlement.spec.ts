import { expect, test } from "@playwright/test";

test.setTimeout(150_000);

async function login(request: any, email: string) {
  const response = await request.post("/api/auth/login", { data: { email, name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function installSession(page: any, value: any) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, value);
}

// Owner decision: internal settlement, cashbook and the settlement workflow are
// frozen. Even with the capability enabled their pages show "Capability
// unavailable"; the UI flow below is kept, skipped, for when the freeze lifts.
test("frozen settlement and cashbook pages show Capability unavailable even when enabled", async ({ page, request }) => {
  const session = await login(request, "settlement@example.com");
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  for (const path of ["/app/finance/reconciliation", "/app/finance/settlement", "/app/finance/settlement/any-settlement"]) {
    await page.goto(path);
    await expect(page.getByTestId("capability-route-blocked"), path).toBeVisible();
  }
});

test.skip("internal settlement closes the cashbook, posting, reversal, redaction, and permission gates", async ({ page, request, browser }) => {
  const specialist = await login(request, "settlement@example.com");
  const viewer = await login(request, "viewer@example.com");
  await installSession(page, specialist);

  await page.goto("/app/finance/reconciliation");
  await expect(page.getByTestId("cashbook-workbench")).toBeVisible();
  await expect(page.getByText(/Phase 5\.3/)).toBeVisible();
  await page.getByLabel("账户代码").fill("BROWSER-CNY");
  await page.getByLabel("账户名称").fill("Browser Cashbook");
  await page.getByLabel("期初余额").fill("100.0000");
  await page.getByTestId("create-cashbook-account").click();
  await expect(page.getByTestId("cashbook-account").filter({ hasText: "BROWSER-CNY" })).toContainText("100.0000");

  await page.goto("/app/finance/settlement");
  await expect(page.getByTestId("internal-settlement-workbench")).toBeVisible();
  await page.getByLabel("结算单号").fill("SET-BROWSER-001");
  await page.getByLabel("Cashbook 账户").selectOption({ index: 1 });
  await page.getByLabel("待核销义务").selectOption({ index: 1 });
  await page.getByLabel("外部参考号").fill("UNVERIFIED-BROWSER-REF");
  await page.getByTestId("preview-settlement").click();
  await expect(page.getByTestId("settlement-preview")).toContainText("校验通过");
  await page.getByTestId("create-settlement").click();
  const row = page.getByTestId("settlement-row").filter({ hasText: "SET-BROWSER-001" });
  await expect(row).toContainText("60.0000");
  await row.getByRole("link", { name: "SET-BROWSER-001" }).click();
  await expect(page.getByTestId("settlement-detail")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("post-settlement").click();
  await expect(page.getByText("posted · posted", { exact: true })).toBeVisible();
  await expect(page.getByTestId("settlement-reconciliation")).toContainText("matched");
  const settlementId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);

  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await installSession(viewerPage, viewer);
  await viewerPage.goto(`/app/finance/settlement/${encodeURIComponent(settlementId)}`);
  await expect(viewerPage.getByTestId("settlement-detail")).toContainText("No permission");
  await expect(viewerPage.getByTestId("reverse-settlement")).toHaveCount(0);
  const denied = await viewerContext.request.post(`/api/finance/settlements/${settlementId}/reverse`, {
    headers: { Authorization: `Bearer ${viewer.token}` },
    data: { expectedVersion: 1, reason: "forbidden", idempotencyKey: "browser-viewer-reverse" },
  });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).code).toBe("AUTHORIZATION_PERMISSION_DENIED");
  await viewerContext.close();

  page.once("dialog", (dialog) => dialog.accept("Browser correction"));
  await page.getByText("纠错操作", { exact: true }).click();
  await page.getByTestId("reverse-settlement").click();
  await expect(page.getByText("reversed · reversed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("settlement-reconciliation")).toContainText("matched");
  await page.goto("/app/finance/reconciliation");
  await expect(page.getByTestId("cashbook-entry")).toHaveCount(2);
  await expect(page.getByTestId("cashbook-account").filter({ hasText: "BROWSER-CNY" })).toContainText("100.0000");
});
