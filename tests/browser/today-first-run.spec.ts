import { expect, test, type Page } from "@playwright/test";

// Today in a workspace with master data and nothing else
// (PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY): the first-day checklist with each
// step's state from real counts, and no work beyond what the reorder list
// itself says. The local demo master data holds items with reorder points,
// suppliers, customers and two active users, and no stock on hand.

async function signIn(page: Page, language: "en-US" | "zh-CN" = "en-US") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "First day", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  return { authorization: `Bearer ${session.token}` };
}

test("a new workspace shows where to start and only the reorder list's work", async ({ page }) => {
  const headers = await signIn(page);
  const overview = await (await page.request.get("/api/home/overview", { headers })).json();
  const reorder = await (await page.request.get("/api/inventory/reorder-list", { headers })).json();
  // No purchase, sales or finance documents exist. Items with a reorder
  // point and nothing on hand are "order now" on the reorder list, and Today
  // lists exactly those.
  expect(overview.recentDocuments).toEqual([]);
  expect(overview.workItems.every((item: { kind: string }) => item.kind === "reorder_now")).toBe(true);
  expect(overview.workItems.map((item: { label: string }) => item.label).sort()).toEqual(reorder.rows.filter((row: { orderNow: boolean }) => row.orderNow).map((row: { sku: string }) => row.sku).sort());
  expect(overview.firstRun.steps.map((step: { id: string; done: boolean }) => [step.id, step.done])).toEqual([
    ["items", true], ["suppliers", true], ["customers", true], ["opening_stock", false], ["teammates", true],
  ]);

  await page.goto("/app/overview/risks");
  const checklist = page.getByTestId("first-run-checklist");
  await expect(checklist).toBeVisible();
  await expect(checklist).toContainText("Set up your workspace");
  await expect(checklist).toContainText("4 of 5 steps done");
  for (const id of ["items", "suppliers", "customers", "teammates"]) {
    await expect(checklist.getByTestId(`first-run-step-${id}`)).toHaveAttribute("data-done", "true");
    await expect(checklist.getByTestId(`first-run-step-${id}`)).toContainText(/Done \(\d+\)/);
  }
  const stock = checklist.getByTestId("first-run-step-opening_stock");
  await expect(stock).toHaveAttribute("data-done", "false");
  await expect(stock).toContainText("Import opening stock");
  await expect(stock).toContainText("Not started");
  // This test workspace turns on neither import nor inventory adjustments,
  // so the step says so instead of linking to a page that refuses it.
  expect(overview.firstRun.steps[3]).toMatchObject({ href: null, blocked: "unavailable" });
  await expect(stock).toContainText("Not turned on in this workspace");
  await expect(stock.getByRole("link")).toHaveCount(0);

  const root = page.getByTestId("runtime-homepage");
  await expect(root.getByText("No recent documents", { exact: true })).toBeVisible();
  await expect(root.getByTestId("today-tile-all")).toContainText(`Needs action${overview.workTotal}`);
  await expect(root.getByTestId("today-tile-overdue")).toContainText("Overdue0");
  await expect(root.getByTestId("today-tile-changes")).toContainText("Documents updated today0");
  if (overview.workItems.length) await expect(root.getByTestId("today-work-item").first()).toContainText("Reorder now");
  await root.getByTestId("today-tile-overdue").click();
  await expect(root.getByText("Nothing is overdue", { exact: true })).toBeVisible();
});

test("the checklist is in Chinese for a Chinese reader", async ({ page }) => {
  await signIn(page, "zh-CN");
  await page.goto("/app/overview/risks");
  const checklist = page.getByTestId("first-run-checklist");
  await expect(checklist).toContainText("设置工作区");
  await expect(checklist).toContainText("已完成 4/5 步");
  await expect(checklist.getByTestId("first-run-step-opening_stock")).toContainText("导入期初库存");
  await expect(checklist.getByTestId("first-run-step-opening_stock")).toContainText("此工作区未启用");
  await expect(page.getByTestId("runtime-homepage").getByText("暂无近期单据", { exact: true })).toBeVisible();
});
