import { expect, test, type Page } from "@playwright/test";

// Design audit B3 (L6-02 = L7-01, V-B-02): every "N days late" counts from the
// workspace's calendar day, which the server sends with the localization, and
// from the day an order is due by Today's rule (its earliest open line). The
// browser here is in New York at 20:30 on 14 November while the workspace, in
// London, is already on the 15th.

// The manager seeded by scripts/browser-product-recovery-api.mjs.
async function signIn(page: Page) {
  const response = await page.request.post("/api/auth/login", { data: { email: "kim@example.com", name: "Kim", company: "FlowChain" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
    localStorage.setItem("flowchain:guest-language", "en-US");
  }, session);
}

test.use({ timezoneId: "America/New_York" });

test("the workbench counts days late from the workspace's day, and reads — until it is known", async ({ page }) => {
  await signIn(page);
  await page.clock.setFixedTime(new Date("2026-11-15T01:30:00Z"));
  // The localization answers only when the test lets it: until then the
  // workbench has no workspace day and must not use the browser's.
  let release = () => {};
  const answered = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/me/localization", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await answered;
    await route.fulfill({ response, json: { ...body, effectiveLanguage: "en-US", timezone: "Europe/London", workspaceToday: "2026-11-15" } });
  });
  // One issued order: its header still says 1 November (a line received long
  // ago), its open line is due on the 14th.
  await page.route("**/api/procurement/orders", (route) => route.fulfill({ json: [{
    id: "PO-B3", number: "PO-B3", status: "issued", transmissionStatus: "issued_outside_flowchain", totalAmount: 120, currency: "GBP",
    supplier: "Workspace Day Supplies", eta: "2026-11-01", dueDay: "2026-11-14", supplierId: "SUP-B3",
    lines: [{ itemNameSnapshot: "Tape", sku: "TAPE-1" }],
  }] }));
  await page.route("**/api/procurement/requests", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/procurement/documents?type=invoice", (route) => route.fulfill({ json: { documents: [] } }));

  await page.goto("/app/procurement/workbench");
  const openWork = page.getByRole("link", { name: /^Open work: —,/ });
  await expect(openWork).toBeVisible();
  await expect(page.getByTestId("workbench-late-PO-B3")).toHaveCount(0);

  release();
  // London's day (the 15th) less the open line's day (the 14th): one day.
  // The browser's day (the 14th) would say none, the header's date fourteen.
  await expect(page.getByTestId("workbench-late-PO-B3")).toHaveText("1 day late");
  await expect(page.getByRole("link", { name: /^Open work: 1,/ })).toBeVisible();
});
