import { expect, test, type Page } from "@playwright/test";

// Today on the US walkthrough (PLAYWRIGHT_PRODUCT_RECOVERY_DB): the work that
// needs doing, from the same rules as the open purchase orders report and the
// reorder list, earliest date first, each row linking to its record; status
// tiles that count real rows; and recent documents of every type with one
// date format. The empty-workspace checklist is in today-first-run.spec.ts.

const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN" = "en-US") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Today walkthrough", company: "FlowChain" },
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

type WorkItem = { kind: string; recordId: string; label: string; date: string | null; overdueDays: number; href: string };
type Overview = { today: string; workItems: WorkItem[]; workTotal: number; overdue: number; todayChanges: number; firstRun: unknown; recentDocuments: Array<{ type: string; number: string; updatedAt: string }> };

test("Today lists the walkthrough's work from the report and reorder rules, earliest date first", async ({ page }) => {
  const headers = await signIn(page);
  const overview: Overview = await (await page.request.get("/api/home/overview", { headers })).json();
  const report = await (await page.request.get("/api/reports/open-purchase-orders?export=true", { headers })).json();
  const reorder = await (await page.request.get("/api/inventory/reorder-list", { headers })).json();

  // The same day as the report, and the same overdue and due-soon orders.
  expect(overview.today).toBe(report.asOf);
  const ids = (kind: string) => overview.workItems.filter((item) => item.kind === kind).map((item) => item.recordId).sort();
  const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  const reportOverdue = report.exportRows.filter((row: any) => row.isOpen && row.overdueDays > 0).map((row: any) => row.id).sort();
  const reportDue = report.exportRows.filter((row: any) => row.isOpen && !(row.overdueDays > 0) && row.dueDate && days(report.asOf, row.dueDate) >= 0 && days(report.asOf, row.dueDate) <= 7).map((row: any) => row.id).sort();
  expect(reportOverdue.length).toBeGreaterThan(0);
  expect(ids("purchase_order_overdue")).toEqual(reportOverdue);
  expect(ids("purchase_order_due")).toEqual(reportDue);
  // The reorder list's "order now" items, no more and no fewer.
  expect(overview.workItems.filter((item) => item.kind === "reorder_now").map((item) => item.label).sort()).toEqual(reorder.rows.filter((row: any) => row.orderNow).map((row: any) => row.sku).sort());
  // Bills waiting for their match, and the confirmed sales order still to reserve.
  expect(ids("bill_to_match").length).toBeGreaterThan(0);
  expect(overview.workItems.some((item) => item.kind === "sales_order_to_reserve" && item.label === "LOCAL-DEMO-SO-001")).toBe(true);
  // Earliest date first; rows without a date last.
  const dates = overview.workItems.map((item) => item.date || "9999-12-31");
  expect(dates).toEqual([...dates].sort());
  // On the walkthrough every step of the first-day checklist is done.
  expect(overview.firstRun).toBeNull();

  await page.goto("/app/overview/risks");
  const root = page.getByTestId("runtime-homepage");
  const list = root.getByTestId("today-work-list");
  await expect(list).toBeVisible();
  await expect(root.getByTestId("first-run-checklist")).toHaveCount(0);
  // The tiles count the rows; no "Assigned to me" or unconnected risk tile.
  await expect(root.getByTestId("today-tile-all")).toContainText(`Needs action${overview.workTotal}`);
  await expect(root.getByTestId("today-tile-overdue")).toContainText(`Overdue${overview.overdue}`);
  await expect(root.getByTestId("today-tile-changes")).toContainText(`Documents updated today${overview.todayChanges}`);
  await expect(root).not.toContainText(/Assigned to me|Risk exceptions|Changes today|No work items/);

  // The first row is the most overdue purchase order, with its reason.
  const first = list.getByTestId("today-work-item").first();
  const firstItem = overview.workItems[0];
  await expect(first).toHaveAttribute("data-kind", firstItem.kind);
  await expect(first).toContainText(firstItem.label);
  if (firstItem.kind === "purchase_order_overdue") {
    await expect(first).toContainText(new RegExp(`${firstItem.overdueDays} days? overdue`));
    await expect(first).toContainText(/still to receive|lines? still to receive/);
  }
  // The sales order row says what is left to reserve.
  if (overview.workItems.length > 5) await root.getByRole("button", { name: /Show all/ }).click();
  const salesOrder = list.locator('[data-kind="sales_order_to_reserve"]');
  await expect(salesOrder).toContainText("Sales order to reserve");
  await expect(salesOrder).toContainText("35 pcs still to reserve");
  await expect(salesOrder).toContainText("Customer Redwood Retail");
  // A reorder row links to its item and to the reorder list.
  const reorderRow = list.locator('[data-kind="reorder_now"]').first();
  if (await reorderRow.count()) {
    await expect(reorderRow).toContainText(/Stock position .+, reorder point /);
    await expect(reorderRow.getByRole("link", { name: "Open reorder list" })).toHaveAttribute("href", "/app/inventory/reorder");
  }

  // The overdue tile filters the list to overdue rows.
  await root.getByTestId("today-tile-overdue").click();
  await expect(list.getByTestId("today-work-item")).toHaveCount(Math.min(overview.overdue, 5));
  await expect(list.locator('[data-kind="purchase_order_due"]')).toHaveCount(0);
  await root.getByTestId("today-tile-all").click();

  // Recent documents: every document type the reader can open, newest change
  // first, so on the seeded walkthrough the bills written last lead; one
  // date and time format.
  const table = root.getByTestId("recent-documents");
  const types = await table.locator("tbody tr td:first-child").allInnerTexts();
  const labels: Record<string, string> = { purchase_request: "Purchase request", rfq: "RFQ", purchase_order: "Purchase order", receipt: "Receipt", supplier_invoice: "Bill", sales_order: "Sales order", customer_invoice: "Invoice" };
  expect(types).toEqual(overview.recentDocuments.map((row) => labels[row.type]));
  expect(overview.recentDocuments.some((row) => ["receipt", "supplier_invoice", "sales_order", "customer_invoice"].includes(row.type))).toBe(true);
  const changes = overview.recentDocuments.map((row) => Date.parse(row.updatedAt));
  expect(changes).toEqual([...changes].sort((a, b) => b - a));
  for (const updated of await table.locator("tbody tr td:last-child").allInnerTexts()) {
    expect(updated).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M$/);
  }
  expect(overview.recentDocuments.every((row) => /T\d{2}:\d{2}/.test(row.updatedAt))).toBe(true);

  // A row opens its record.
  await first.getByRole("link", { name: firstItem.label, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`${firstItem.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("Today stays in Chinese for a Chinese reader, with the same rows", async ({ page }) => {
  const headers = await signIn(page, "zh-CN");
  const overview: Overview = await (await page.request.get("/api/home/overview", { headers })).json();
  await page.goto("/app/overview/risks");
  const root = page.getByTestId("runtime-homepage");
  await expect(root.getByText("今日需处理", { exact: true })).toBeVisible();
  await expect(root.getByTestId("today-tile-all")).toContainText(`待处理${overview.workTotal}`);
  await expect(root.getByTestId("today-tile-changes")).toContainText("今日更新的单据");
  await expect(root.getByTestId("today-work-item").first()).toContainText(CJK);
  if (overview.workItems.length > 10) await root.getByRole("button", { name: /显示全部/ }).click();
  await expect(root.getByText("销售订单待预留", { exact: true })).toBeVisible();
  await expect(root.locator('[data-kind="sales_order_to_reserve"]')).toContainText("仍待预留 35 pcs");
});
